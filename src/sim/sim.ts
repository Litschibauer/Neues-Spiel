/**
 * Der Sim-Kern (Architektur §2.2).
 *
 * DIESE DATEI IST DAS EINZIGE ARTEFAKT, das den Spielzustand fortschreibt —
 * und sie läuft unverändert auf Client UND Server. Zwei Implementierungen
 * wären der sichere Weg in R1.
 *
 *   neuerZustand = simulate(alterZustand, command)
 *
 * Reine Funktion: gleicher Input → bit-für-bit gleicher Output.
 *
 * Der Kern kennt **keinen Weizen und keine Eier**. Er kennt Katalogindizes,
 * Rezepte und Plätze — alles aus dem Regelwerk. Eine neue Feldfrucht ändert
 * hier keine einzige Zeile.
 */

import type { Ruleset } from './rules.ts';
import {
  derivedTables,
  isTradable,
  levelOf,
  levelRecipes,
  listingFee,
  nextLevel,
  priceBand,
} from './rules.ts';
import type { State } from './state.ts';
import {
  EMPTY_PLOT,
  addItem,
  addItems,
  cloneState,
  count,
  replaceAt,
  spaceLeft,
  storedIn,
} from './state.ts';
import { advancePassives } from './produce.ts';
import type { Command } from './commands.ts';
import { SimError } from './commands.ts';

/**
 * Schreibt die passive Produktion bis `toTick` fort — ein Segment.
 *
 * Wird vor jedem Command aufgerufen, damit zwischen zwei Aktionen exakt die
 * geschlossene Form aus §7 greift und nicht Tick für Tick geloopt werden muss.
 */
export function advanceTo(state: State, toTick: number, rules: Ruleset): State {
  const elapsed = toTick - state.tick;
  if (elapsed < 0) throw new SimError('TIME_WENT_BACKWARDS');
  if (elapsed === 0 && state.orders.length === 0) return state;

  const next = cloneState(state);

  if (elapsed > 0) {
    next.tick = toTick;

    if (rules.passives.length > 0) {
      const { passiveIntervals, passiveOutputs } = derivedTables(rules);
      const space = spaceLeft(state, rules);
      const result = advancePassives(elapsed, state.passives, space, passiveIntervals);

      const gains: [number, number][] = [];
      for (let i = 0; i < result.produced.length; i++) {
        if (result.produced[i]! > 0) gains.push([passiveOutputs[i]!, result.produced[i]!]);
      }
      if (gains.length > 0) next.items = addItems(state.items, gains);
      next.passives = result.progress;
    }
  }

  // Auch bei `elapsed === 0` prüfen. Sonst hinge das Ergebnis davon ab, WIE die
  // Zeitachse in Segmente zerteilt wurde — und genau solche Abhängigkeiten
  // sind es, die Client und Server auseinanderlaufen lassen (R1).
  expireOrders(next, rules);
  return next;
}

/**
 * Verfallene Aufträge ins Postfach zurückgeben (§8).
 *
 * Läuft am Segmentende statt tickgenau — das ist zulässig, weil zwischen zwei
 * Commands niemand Aufträge oder Postfach liest. Die Reihenfolge (nach `id`)
 * ist stabil, damit das Ergebnis bei vollem Postfach eindeutig bleibt.
 *
 * Passt nichts mehr ins Postfach, bleibt der Auftrag einfach stehen und
 * verfällt später. Nie etwas vernichten, wovon der Spieler nichts wusste (§7).
 */
function expireOrders(s: State, rules: Ruleset): void {
  // 0 = nie. Eingestellte Ware bleibt liegen, bis sie verkauft oder
  // zurückgeholt wird. Der Riegel gegen „Escrow als Lager" ist seither nicht
  // die Frist, sondern die Einstellgebühr — man zahlt fürs Parken, statt es
  // geschenkt zu bekommen.
  if (rules.orderTtlTicks <= 0) return;
  if (s.orders.length === 0) return;

  const survivors: typeof s.orders = [];
  let mail = s.mail;
  for (const order of s.orders) {
    const expired = s.tick - order.listedAt >= rules.orderTtlTicks;
    if (expired && mail.length < rules.mailCapacity) {
      // Neues Array statt push: `mail` wird mit älteren Zuständen geteilt.
      mail = mail.concat({ item: order.item, amount: order.amount, arrivedAt: s.tick });
    } else {
      survivors.push(order);
    }
  }
  if (survivors.length !== s.orders.length) {
    s.orders = survivors;
    s.mail = mail;
  }
}

/**
 * Wendet ein einzelnes Command an. Wirft `SimError`, wenn die Aktion nach den
 * Regeln nicht erlaubt ist.
 *
 * Wichtig: Der Client ruft exakt dieselbe Funktion. Eine illegale Aktion wird
 * damit schon offline abgelehnt und landet gar nicht erst im Log — statt beim
 * Sync einen Rollback auszulösen.
 */
export function simulate(state: State, cmd: Command, rules: Ruleset): State {
  const s = advanceTo(state, cmd.tick, rules);

  switch (cmd.type) {
    // Feld bestellen, Mühle beschicken, Hühner füttern — eine Regel.
    case 'START': {
      const def = rules.plots[cmd.plot];
      const plot = s.plots[cmd.plot];
      if (!def || !plot) throw new SimError('NO_SUCH_PLOT');
      if (plot.level <= 0) throw new SimError('PLOT_LOCKED');
      if (plot.recipe !== EMPTY_PLOT) throw new SimError('PLOT_BUSY');
      // Was hier laufen darf, hängt an der Ausbaustufe: Ein leeres Gehege
      // (Stufe 1) kennt noch kein Ei-Rezept, eines mit Hühnern (Stufe 2) schon.
      if (!levelRecipes(rules, cmd.plot, plot.level).includes(cmd.recipe)) {
        throw new SimError('RECIPE_NOT_ALLOWED');
      }

      const recipe = rules.recipes[cmd.recipe];
      if (!recipe) throw new SimError('RECIPE_NOT_ALLOWED');
      for (const input of recipe.inputs) {
        if (count(s, input.item) < input.amount) throw new SimError('NOT_ENOUGH_ITEMS');
      }

      const next = cloneState(s);
      if (recipe.inputs.length > 0) {
        const spend: [number, number][] = recipe.inputs.map((i) => [i.item, -i.amount]);
        next.items = addItems(s.items, spend);
      }
      next.plots = replaceAt(s.plots, cmd.plot, {
        level: plot.level,
        recipe: cmd.recipe,
        startedAt: s.tick,
      });
      return next;
    }

    /**
     * Gehege kaufen, Hühner kaufen, ein weiteres Feld freischalten — eine Regel.
     *
     * Bewusst nur bei leerem Platz: Ein Ausbau kann die erlaubten Rezepte
     * ändern, und eine laufende Produktion, die danach nicht mehr erlaubt wäre,
     * müsste irgendwie aufgelöst werden. „Erst abholen, dann ausbauen" spart
     * diesen Sonderfall komplett — und ist obendrein verständlicher.
     */
    case 'BUY': {
      const def = rules.plots[cmd.plot];
      const plot = s.plots[cmd.plot];
      if (!def || !plot) throw new SimError('NO_SUCH_PLOT');
      if (plot.recipe !== EMPTY_PLOT) throw new SimError('PLOT_BUSY');

      const level = nextLevel(rules, cmd.plot, plot.level);
      if (!level) throw new SimError('MAX_LEVEL');
      // Die einzige Wirkung von Spielerleveln (M8): eine Schwelle, hinter der
      // etwas auftaucht, das es vorher nicht gab. Keine neue Mechanik — eine
      // Zahl neben dem Preis.
      if (levelOf(rules, s.xp) < (level.minPlayerLevel ?? 1)) {
        throw new SimError('PLAYER_LEVEL_TOO_LOW');
      }
      for (const price of level.cost) {
        if (count(s, price.item) < price.amount) throw new SimError('CANT_AFFORD');
      }

      const next = cloneState(s);
      if (level.cost.length > 0) {
        next.items = addItems(
          s.items,
          level.cost.map((c): [number, number] => [c.item, -c.amount]),
        );
      }
      next.plots = replaceAt(s.plots, cmd.plot, {
        level: plot.level + 1,
        recipe: EMPTY_PLOT,
        startedAt: 0,
      });
      return next;
    }

    case 'COLLECT': {
      const plot = s.plots[cmd.plot];
      if (!plot) throw new SimError('NO_SUCH_PLOT');
      if (plot.recipe === EMPTY_PLOT) throw new SimError('PLOT_EMPTY');

      const recipe = rules.recipes[plot.recipe];
      if (!recipe) throw new SimError('RECIPE_NOT_ALLOWED');
      if (s.tick - plot.startedAt < recipe.durationTicks) throw new SimError('NOT_DONE');

      // Hard block statt stillem Verlust (§7): Die Ware bleibt fertig liegen.
      const output = rules.items[recipe.output.item];
      if (output?.storable && spaceLeft(s, rules) < recipe.output.amount) {
        throw new SimError('SILO_FULL');
      }

      const next = cloneState(s);
      next.plots = replaceAt(s.plots, cmd.plot, {
        level: plot.level,
        recipe: EMPTY_PLOT,
        startedAt: 0,
      });
      next.items = addItem(s.items, recipe.output.item, recipe.output.amount);
      // Erfahrung fürs Abholen (M8) — damit sich der Balken bei jeder Ernte
      // bewegt und nicht nur bei Lieferungen.
      next.xp = s.xp + recipe.xp;
      return next;
    }

    case 'SELL_NPC': {
      if (!Number.isInteger(cmd.amount) || cmd.amount <= 0) throw new SimError('BAD_AMOUNT');
      const def = rules.items[cmd.item];
      if (!def) throw new SimError('NO_SUCH_ITEM');
      if (def.npcPrice <= 0) throw new SimError('NOT_SELLABLE');
      if (count(s, cmd.item) < cmd.amount) throw new SimError('NOT_ENOUGH_ITEMS');

      const next = cloneState(s);
      next.items = addItems(s.items, [
        [cmd.item, -cmd.amount],
        [rules.currency, cmd.amount * def.npcPrice],
      ]);
      return next;
    }

    /**
     * Beim Händler kaufen — die Gegenrichtung zu `SELL_NPC`.
     *
     * Er verlangt mehr, als er zahlt; dass das so bleibt, prüft
     * `validateRuleset`. Ohne diesen Abstand wäre er eine Geldpresse, und ein
     * Skript hätte in Sekunden beliebig viel Gold.
     */
    case 'BUY_NPC': {
      if (!Number.isInteger(cmd.amount) || cmd.amount <= 0) throw new SimError('BAD_AMOUNT');
      const def = rules.items[cmd.item];
      if (!def) throw new SimError('NO_SUCH_ITEM');
      if (def.npcBuyPrice <= 0) throw new SimError('NOT_BUYABLE');

      const cost = cmd.amount * def.npcBuyPrice;
      if (count(s, rules.currency) < cost) throw new SimError('CANT_AFFORD');
      if (def.storable && spaceLeft(s, rules) < cmd.amount) throw new SimError('SILO_FULL');

      const next = cloneState(s);
      next.items = addItems(s.items, [
        [rules.currency, -cost],
        [cmd.item, cmd.amount],
      ]);
      return next;
    }

    case 'LIST_ORDER': {
      if (!Number.isInteger(cmd.amount) || cmd.amount <= 0) throw new SimError('BAD_AMOUNT');
      if (!Number.isInteger(cmd.price) || cmd.price <= 0) throw new SimError('BAD_AMOUNT');
      if (!rules.items[cmd.item]) throw new SimError('NO_SUCH_ITEM');
      if (!isTradable(rules, cmd.item)) throw new SimError('NOT_TRADABLE');

      // Der strukturelle Riegel gegen Escrow-als-Lager (§8).
      if (s.orders.length >= rules.orderSlots) throw new SimError('NO_ORDER_SLOTS');

      // Preisband: Was eingestellt wird, muss plausibel verkäuflich sein —
      // sonst wäre der Auftrag nur ein Parkplatz für Ware. Gerechnet in
      // `priceBand`, damit die Oberfläche exakt dieselben Grenzen anzeigt.
      const band = priceBand(rules, cmd.item);
      if (cmd.price < band.min || cmd.price > band.max) throw new SimError('PRICE_OUT_OF_BAND');

      if (count(s, cmd.item) < cmd.amount) throw new SimError('NOT_ENOUGH_ITEMS');

      /**
       * Einstellgebühr — der eigentliche Riegel gegen „Escrow als Lager".
       *
       * Seit Angebote nicht mehr verfallen, könnte man Ware sonst beliebig
       * lange kostenlos parken. Jetzt kostet schon das Hinlegen etwas, sofort
       * und unabhängig davon, ob je jemand kauft. Gerechnet wird sie in
       * `listingFee` — dieselbe Funktion, die auch die Oberfläche anzeigt.
       */
      const fee = listingFee(rules, cmd.item, cmd.amount);
      if (count(s, rules.currency) < fee) throw new SimError('CANT_AFFORD');

      const next = cloneState(s);
      next.items = addItems(s.items, [
        [cmd.item, -cmd.amount],
        [rules.currency, -fee],
      ]);
      next.orders = s.orders.concat({
        id: s.nextOrderId,
        item: cmd.item,
        amount: cmd.amount,
        price: cmd.price,
        listedAt: s.tick,
      });
      next.nextOrderId = s.nextOrderId + 1;
      return next;
    }

    case 'CANCEL_ORDER': {
      const order = s.orders.find((o) => o.id === cmd.orderId);
      if (!order) throw new SimError('NO_SUCH_ORDER');
      // Zurücknehmen darf das Lager nicht sprengen — sonst wäre der Auftrag
      // ein Weg, das Limit zu umgehen.
      if (rules.items[order.item]?.storable && spaceLeft(s, rules) < order.amount) {
        throw new SimError('SILO_FULL');
      }

      const next = cloneState(s);
      next.orders = s.orders.filter((o) => o.id !== cmd.orderId);
      next.items = addItem(s.items, order.item, order.amount);
      return next;
    }

    /**
     * Ein fremdes Angebot kaufen (M5).
     *
     * Der Kern rechnet das wie jede andere Aktion nach — die Bedingungen liegen
     * ja im Zustand. Was er NICHT prüfen kann, ist, ob das Angebot in der
     * geteilten Welt noch existiert; zwei Käufer sehen dasselbe Angebot, und wer
     * es bekommt, entscheidet der Server (§8). Der lehnt einen Kauf auf ein
     * vergriffenes Angebot beim Sync ab, und der Batch wird dort abgeschnitten.
     *
     * Der Preis steht **pro Stück**, wie beim Einstellen. Multipliziert wird
     * hier und nur hier.
     */
    case 'BUY_OFFER': {
      const offer = s.offers.find((o) => o.id === cmd.offerId);
      if (!offer) throw new SimError('NO_SUCH_OFFER');

      const total = offer.amount * offer.price;
      if (count(s, rules.currency) < total) throw new SimError('CANT_AFFORD');
      // Gekaufte Ware geht direkt ins Lager, nicht ins Postfach: Der Käufer
      // steht davor und hat es gerade selbst ausgelöst. Passt sie nicht, ist
      // das eine Ablehnung und kein stiller Verlust (§7).
      if (rules.items[offer.item]?.storable && spaceLeft(s, rules) < offer.amount) {
        throw new SimError('SILO_FULL');
      }

      const next = cloneState(s);
      next.items = addItems(s.items, [
        [rules.currency, -total],
        [offer.item, offer.amount],
      ]);
      // Aus der eigenen Auslage nehmen. Beim nächsten Sync schickt der Server
      // ohnehin eine frische — das hier hält nur den Zustand ehrlich, solange
      // der Client noch nicht gesynct hat.
      next.offers = s.offers.filter((o) => o.id !== cmd.offerId);
      return next;
    }

    case 'COLLECT_MAIL': {
      if (s.mail.length === 0) throw new SimError('NOTHING_TO_COLLECT');

      const next = cloneState(s);
      const remaining: typeof next.mail = [];
      let collected = 0;
      let items = s.items;

      // In Ankunftsreihenfolge, damit das Ergebnis bei knappem Platz eindeutig
      // ist. Was nicht passt, bleibt liegen — nichts verfällt hier.
      for (const entry of s.mail) {
        const def = rules.items[entry.item];
        // Nicht lagerpflichtig (Münzen) → passt immer.
        const fits =
          !def?.storable || rules.siloCapacity - storedIn(items, rules) >= entry.amount;
        if (fits) {
          items = addItem(items, entry.item, entry.amount);
          collected++;
        } else {
          remaining.push(entry);
        }
      }

      if (collected === 0) throw new SimError('SILO_FULL');
      next.items = items;
      next.mail = remaining;
      return next;
    }

    /**
     * Kundenauftrag beliefern (M6).
     *
     * Die Mechanik, aus der die meisten Inhalte als Daten herausfallen: LKW,
     * Kunden, Boote, Sonderaufträge, Eventaufgaben sind alle „liefere N×A und
     * M×B" mit anderen Zahlen.
     *
     * Und sie ist voll offline-fähig, obwohl Zufall dahintersteckt: Gewürfelt
     * hat der Server, die Aufträge liegen fertig im Zustand (§5). Ist einer
     * erledigt, rückt der nächste aus dem Vorrat nach — ohne Netz.
     */
    case 'FILL_REQUEST': {
      const index = s.requests.findIndex((r) => r.id === cmd.requestId);
      if (index < 0) throw new SimError('NO_SUCH_REQUEST');
      // Nur die vorderen Plätze sind annehmbar. Der Rest ist Vorrat und darf
      // nicht übersprungen werden — sonst wäre die Schlange ein Regal, aus dem
      // man sich den besten Auftrag heraussucht.
      if (index >= rules.requestSlots) throw new SimError('REQUEST_NOT_ACTIVE');

      const request = s.requests[index]!;
      for (const stack of request.wants) {
        if (count(s, stack.item) < stack.amount) throw new SimError('NOT_ENOUGH_ITEMS');
      }

      // Lagerpflichtige Belohnungen brauchen Platz — wie überall (§7). Was der
      // Auftrag abnimmt, zählt dabei schon nicht mehr mit.
      const changes: [number, number][] = request.wants.map((w) => [w.item, -w.amount]);
      for (const r of request.reward) changes.push([r.item, r.amount]);
      const items = addItems(s.items, changes);
      if (storedIn(items, rules) > rules.siloCapacity) throw new SimError('SILO_FULL');

      const next = cloneState(s);
      next.items = items;
      next.requests = s.requests.filter((r) => r.id !== cmd.requestId);
      next.xp = s.xp + request.xp;
      return next;
    }

    /**
     * Auftrag wegschicken (M6).
     *
     * Zwei Regeln, und beide halten die Warteschlange davon ab, ein Regal zu
     * werden, aus dem man sich das Beste heraussucht:
     *
     *  1. Nur die vorderen Plätze — dieselbe Grenze wie beim Beliefern.
     *  2. Danach eine Wartezeit, in der nichts weiter übersprungen wird.
     *
     * Der Nachrücker kommt aus dem Vorrat, der schon im Zustand liegt. Damit
     * ist das hier offline gültig, obwohl Aufträge aus dem Zufall stammen: Es
     * wird nichts gewürfelt, nur nach vorn gerückt (§5).
     */
    case 'SKIP_REQUEST': {
      if (rules.requestSkipCooldownTicks <= 0) throw new SimError('SKIP_DISABLED');

      const index = s.requests.findIndex((r) => r.id === cmd.requestId);
      if (index < 0) throw new SimError('NO_SUCH_REQUEST');
      if (index >= rules.requestSlots) throw new SimError('REQUEST_NOT_ACTIVE');
      if (s.tick < s.skipReadyAt) throw new SimError('SKIP_ON_COOLDOWN');

      const next = cloneState(s);
      next.requests = s.requests.filter((r) => r.id !== cmd.requestId);
      next.skipReadyAt = s.tick + rules.requestSkipCooldownTicks;
      return next;
    }

    default:
      throw new SimError('UNKNOWN_COMMAND');
  }
}

/** Wendet eine ganze Command-Folge an. Wirft beim ersten illegalen Command. */
export function simulateAll(state: State, cmds: readonly Command[], rules: Ruleset): State {
  let s = state;
  for (const cmd of cmds) s = simulate(s, cmd, rules);
  return s;
}

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
import { derivedTables, isTradable } from './rules.ts';
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
    // Feld bestellen, Mühle beschicken, Teig ansetzen — eine Regel.
    case 'START': {
      const def = rules.plots[cmd.plot];
      const plot = s.plots[cmd.plot];
      if (!def || !plot) throw new SimError('NO_SUCH_PLOT');
      if (plot.recipe !== EMPTY_PLOT) throw new SimError('PLOT_BUSY');
      if (!def.recipes.includes(cmd.recipe)) throw new SimError('RECIPE_NOT_ALLOWED');

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
      next.plots = replaceAt(s.plots, cmd.plot, { recipe: cmd.recipe, startedAt: s.tick });
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
      next.plots = replaceAt(s.plots, cmd.plot, { recipe: EMPTY_PLOT, startedAt: 0 });
      next.items = addItem(s.items, recipe.output.item, recipe.output.amount);
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

    case 'LIST_ORDER': {
      if (!Number.isInteger(cmd.amount) || cmd.amount <= 0) throw new SimError('BAD_AMOUNT');
      if (!Number.isInteger(cmd.price) || cmd.price <= 0) throw new SimError('BAD_AMOUNT');
      const def = rules.items[cmd.item];
      if (!def) throw new SimError('NO_SUCH_ITEM');
      if (!isTradable(rules, cmd.item)) throw new SimError('NOT_TRADABLE');

      // Der strukturelle Riegel gegen Escrow-als-Lager (§8).
      if (s.orders.length >= rules.orderSlots) throw new SimError('NO_ORDER_SLOTS');

      // Preisband: Was eingestellt wird, muss plausibel verkäuflich sein —
      // sonst wäre der Auftrag nur ein Parkplatz für Ware.
      const min = Math.floor((def.npcPrice * rules.priceBandMinPct) / 100);
      const max = Math.floor((def.npcPrice * rules.priceBandMaxPct) / 100);
      if (cmd.price < min || cmd.price > max) throw new SimError('PRICE_OUT_OF_BAND');

      if (count(s, cmd.item) < cmd.amount) throw new SimError('NOT_ENOUGH_ITEMS');

      const next = cloneState(s);
      next.items = addItem(s.items, cmd.item, -cmd.amount);
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

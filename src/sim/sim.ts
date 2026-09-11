import type { Ruleset } from './rules.ts';
import {
  derivedTables,
  isTradable,
  levelOf,
  levelRecipes,
  listingFee,
  blockiert,
  baumStufe,
  achievementDone,
  type AchievementCtx,
  obstacleLocked,
  landLocked,
  nextLevel,
  tagesAufgabenFuer,
  wochenAufgabenFuer,
  itemUnlockLevel,
  offerLimits,
  recipeOutputs,
  sizeOf,
  recipeUnlocked,
  slotsAt,
} from './rules.ts';
import type { Request, State } from './state.ts';
import {
  EMPTY_PLOT,
  capacityOf,
  emptySlots,
  addItem,
  addItems,
  cloneState,
  count,
  replaceAt,
  spaceLeft,
  storedIn,
  zaehle,
  ZAEHLER,
  zaehlerStand,
  tagesFortschritt,
  tagesAbgenommen,
  TAG_ABSCHLUSS,
  WOCHE_ABSCHLUSS,
  wocheVonTag,
  wochenAbgenommen,
  wochenFortschritt,
} from './state.ts';
import { advancePassives } from './produce.ts';

export const MAX_PENDING_BOXES = 20;

export function truckAway(rules: Ruleset): number {
  return rules.truckAwayTicks ?? 0;
}

function leereLadung(waybill: Request | undefined): number[] {
  const out: number[] = [];
  if (!waybill) return out;
  for (let i = 0; i < waybill.wants.length; i++) out.push(0);
  return out;
}

function geladenZurueck(s: State, waybill: Request): Array<[number, number]> {
  return waybill.wants.flatMap((w, i): Array<[number, number]> => {
    const menge = s.truck.loaded[i] ?? 0;
    return menge > 0 ? [[w.item, menge]] : [];
  });
}

function ladungVon(s: State, waybill: Request): number[] {
  const out: number[] = [];
  for (let i = 0; i < waybill.wants.length; i++) out.push(s.truck.loaded[i] ?? 0);
  return out;
}
import type { Command } from './commands.ts';
import { SimError } from './commands.ts';

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

  expireOrders(next, rules);
  return next;
}

function expireOrders(s: State, rules: Ruleset): void {
  if (rules.orderTtlTicks <= 0) return;
  if (s.orders.length === 0) return;

  const survivors: typeof s.orders = [];
  let mail = s.mail;
  for (const order of s.orders) {
    const expired = order.verkauft <= 0 && s.tick - order.listedAt >= rules.orderTtlTicks;
    if (expired && mail.length < rules.mailCapacity) {
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

// Stand eines Reusen-Platzes: Tick der Beköderung, sonst -1. Zu kurze Listen
// gelten als leer, damit alte Spielstände ohne Wanderung weiterlaufen.
function korbStand(s: State, spot: number): number {
  const wert = (s.angelSpots ?? [])[spot];
  return wert === undefined ? -1 : wert;
}

function sudStand(s: State, slot: number): number {
  const wert = (s.angelKoeder ?? [])[slot];
  return wert === undefined ? -1 : wert;
}

function setzeStand(
  liste: readonly number[],
  index: number,
  wert: number,
  laenge: number,
): number[] {
  const next: number[] = [];
  for (let i = 0; i < laenge; i++) {
    const alt = liste[i];
    next.push(alt === undefined ? -1 : alt);
  }
  next[index] = wert;
  return next;
}

// Gewichtete Auswahl aus der Fangtabelle. Der Hash ist reine Integer-Arithmetik
// (Lehmer-Generator), damit Server und Gerät garantiert dasselbe ziehen.
function zieheFang(
  table: readonly { item: number; weight: number }[],
  saat: number,
): number {
  let h = (1 + (saat % 1000003)) % 1000003;
  h = (h * 48271) % 2147483647;
  let gesamt = 0;
  for (const t of table) gesamt += t.weight;
  let r = h % gesamt;
  let treffer = table[table.length - 1]!.item;
  for (const t of table) {
    if (r < t.weight) {
      treffer = t.item;
      break;
    }
    r -= t.weight;
  }
  return treffer;
}

// Fundstueck einer Ernte. Beide Wuerfe — ob ueberhaupt etwas liegt und was —
// kommen aus dem Spielstand selbst: aus der Zahl der bisherigen Ernten, dem
// Tick und dem Platz. Damit steht der Fund fest, bevor jemand das Feld
// beruehrt; Server und Geraet rechnen ihn unabhaengig aus, und wer die Uhr
// verstellt, verschiebt ihn nur — erwuerfeln kann ihn niemand.
//
// Kein Platz im Lager heisst kein Fund. Das ist Absicht: Sonst haenge der
// Ausgang eines Wurfs davon ab, ob gerade Platz war, und zwei Geraete kaemen
// bei gleichem Stand trotzdem auf verschiedene Ergebnisse.
export function fundstueck(
  s: State,
  rules: Ruleset,
  plot: number,
): { item: number; amount: number } | null {
  const f = rules.fundstuecke;
  if (!f || f.jede <= 0 || f.tabelle.length === 0) return null;

  const ernten = zaehlerStand(s, ZAEHLER.ERNTEN);
  const saat = s.tick + ernten * 7919 + plot * 101;
  let h = (1 + (saat % 1000003)) % 1000003;
  h = (h * 48271) % 2147483647;
  if (h % f.jede !== 0) return null;

  let gesamt = 0;
  for (const t of f.tabelle) gesamt += t.weight;
  if (gesamt <= 0) return null;
  let r = ((h * 48271) % 2147483647) % gesamt;
  let treffer = f.tabelle[f.tabelle.length - 1]!;
  for (const t of f.tabelle) {
    if (r < t.weight) {
      treffer = t;
      break;
    }
    r -= t.weight;
  }

  if (rules.items[treffer.item]?.storable && spaceLeft(s, rules) < treffer.amount) return null;
  return { item: treffer.item, amount: treffer.amount };
}

// Alles, was Erfolge auswerten müssen — an einer Stelle, damit Sim und Ansicht
// garantiert dasselbe rechnen.
export function erfolgsStand(s: State, rules: Ruleset): AchievementCtx {
  const gebaut = rules.plots.filter((_, i) => (s.plots[i]?.level ?? 0) > 0);
  return {
    level: levelOf(rules, s.xp),
    gold: count(s, rules.currency),
    builtIds: gebaut.map((p) => p.id),
    expandiert: (s.expandiert ?? []).length,
    plotsGebaut: gebaut.filter((p) => !p.deco).length,
    dekoGebaut: gebaut.filter((p) => p.deco).length,
    geraeumt: (s.clearedObstacles ?? []).length,
    siloLevel: s.siloLevel ?? 0,
    fisch: s.angelFang ?? 0,
    boot: !!s.bootRepariert,
    items: s.items,
  };
}

// Lebenszeit-Zähler laufen an EINER Stelle mit, nicht in zehn Befehlszweigen.
// Was hier gezählt wird, ist die Grundlage für Erfolge, Hofstatistik und
// Tagesaufgaben; der Fortschritt entsteht also auch im Funkloch.
function zaehleBefehl(vorher: State, nachher: State, cmd: Command, rules: Ruleset): State {
  const stapel: [number, number][] = [];

  switch (cmd.type) {
    case 'COLLECT':
    case 'HARVEST_TREE':
      stapel.push([ZAEHLER.ERNTEN, 1]);
      break;
    case 'START':
      stapel.push([ZAEHLER.STARTEN, 1]);
      break;
    case 'SEND_SLIP':
      stapel.push([ZAEHLER.ZETTEL, 1]);
      break;
    case 'FILL_REQUEST':
      stapel.push([ZAEHLER.ANFRAGEN, 1]);
      break;
    case 'SELL_NPC':
      stapel.push([ZAEHLER.VERKAUFT, cmd.amount]);
      break;
    case 'COLLECT_SALE':
      stapel.push([ZAEHLER.VERKAUFT, 1]);
      break;
    case 'COLLECT_SPOT':
      stapel.push([ZAEHLER.FISCHE, (nachher.angelFang ?? 0) - (vorher.angelFang ?? 0)]);
      break;
    case 'CLEAR_OBSTACLE':
      stapel.push([ZAEHLER.GERAEUMT, 1]);
      break;
    case 'BUY':
      stapel.push([ZAEHLER.GEBAUT, 1]);
      break;
    default:
      break;
  }

  // Verdientes Gold zählt unabhängig davon, welcher Befehl es gebracht hat.
  const dazu = count(nachher, rules.currency) - count(vorher, rules.currency);
  if (dazu > 0) stapel.push([ZAEHLER.GOLD, dazu]);

  if (stapel.length === 0) return nachher;

  let zahlen = nachher.zaehler;
  for (const [art, n] of stapel) {
    if (n > 0) zahlen = zaehle(zahlen, art, n);
  }
  if (zahlen === nachher.zaehler) return nachher;

  const raus = cloneState(nachher);
  raus.zaehler = zahlen;
  return raus;
}

export function simulate(state: State, cmd: Command, rules: Ruleset): State {
  const s = advanceTo(state, cmd.tick, rules);
  return verdoppleXp(s, zaehleBefehl(s, simulateRoh(s, cmd, rules), cmd, rules), rules);
}

// Der XP-Verdoppler wirkt an genau einer Stelle: auf alles, was ein Befehl an
// XP gebracht hat. So muss keine der vielen Stellen, die XP gutschreiben,
// davon wissen — und keine kann ihn vergessen.
function verdoppleXp(vorher: State, nachher: State, rules: Ruleset): State {
  if (!rules.booster) return nachher;
  const bis = vorher.xpDoppeltBis ?? 0;
  if (bis <= vorher.tick) return nachher;
  const dazu = nachher.xp - vorher.xp;
  if (dazu <= 0) return nachher;
  const raus = cloneState(nachher);
  raus.xp = nachher.xp + dazu;
  return raus;
}

function simulateRoh(s: State, cmd: Command, rules: Ruleset): State {
  switch (cmd.type) {
    case 'START': {
      const def = rules.plots[cmd.plot];
      const plot = s.plots[cmd.plot];
      if (!def || !plot) throw new SimError('NO_SUCH_PLOT');
      if (plot.level <= 0) throw new SimError('PLOT_LOCKED');

      if (rules.grid && plot.gx < 0) throw new SimError('NOT_PLACED');
      if (!levelRecipes(rules, cmd.plot, plot.level).includes(cmd.recipe)) {
        throw new SimError('RECIPE_NOT_ALLOWED');
      }

      const slotIndex = cmd.slot ?? 0;
      const slot = plot.slots[slotIndex];
      if (!slot) throw new SimError('NO_SUCH_SLOT');
      if (slot.recipe !== EMPTY_PLOT) throw new SimError('PLOT_BUSY');

      if (rules.animalsMustBeBought && def.animal) {
        const geboren = plot.tiere[slotIndex];
        if (geboren === undefined) throw new SimError('NO_ANIMAL');
        if (s.tick - geboren < def.animal.growTicks) throw new SimError('ANIMAL_TOO_YOUNG');
      }

      if (!recipeUnlocked(rules, cmd.recipe, levelOf(rules, s.xp))) {
        throw new SimError('PLAYER_LEVEL_TOO_LOW');
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
        ...plot,
        slots: replaceAt(plot.slots, slotIndex, { recipe: cmd.recipe, startedAt: s.tick }),
      });
      return next;
    }

    case 'BUY_ANIMAL': {
      const def = rules.plots[cmd.plot];
      const plot = s.plots[cmd.plot];
      if (!def || !plot) throw new SimError('NO_SUCH_PLOT');
      if (!rules.animalsMustBeBought || !def.animal) throw new SimError('NOT_AN_ANIMAL_PLOT');
      if (plot.level <= 0) throw new SimError('PLOT_LOCKED');
      if (rules.grid && plot.gx < 0) throw new SimError('NOT_PLACED');
      if (plot.tiere.length >= slotsAt(rules, cmd.plot, plot.level)) {
        throw new SimError('NO_ANIMAL_SPACE');
      }
      if (count(s, rules.currency) < def.animal.cost) throw new SimError('CANT_AFFORD');

      const next = cloneState(s);
      next.items = addItem(s.items, rules.currency, -def.animal.cost);
      next.plots = replaceAt(s.plots, cmd.plot, {
        ...plot,
        tiere: plot.tiere.concat(s.tick),
      });
      return next;
    }

    case 'BUY': {
      const def = rules.plots[cmd.plot];
      const plot = s.plots[cmd.plot];
      if (!def || !plot) throw new SimError('NO_SUCH_PLOT');

      // Festes Bauwerk mitten im Sperrland (z. B. die Mine): erst das Land
      // freimachen. Verschiebbare Plätze stehen bei level 0 auf gx -1 und sind
      // damit nicht betroffen — die prüft ohnehin passtHin beim Hinstellen.
      const groesse = def.size ?? { w: 1, h: 1 };
      if (landLocked(rules, plot.gx, plot.gy, groesse.w, groesse.h, s.expandiert)) {
        throw new SimError('LAND_LOCKED');
      }

      const level = nextLevel(rules, cmd.plot, plot.level);
      const capacity = level ? slotsAt(rules, cmd.plot, plot.level + 1) : 0;
      const running = plot.slots.filter((x) => x.recipe !== EMPTY_PLOT);
      const keepsRunning =
        level !== null &&
        capacity >= plot.slots.length &&
        running.every((x) => level.recipes.includes(x.recipe));
      if (running.length > 0 && !keepsRunning) throw new SimError('PLOT_BUSY');
      if (!level) throw new SimError('MAX_LEVEL');

      if (levelOf(rules, s.xp) < (level.minPlayerLevel ?? 1)) {
        throw new SimError('PLAYER_LEVEL_TOO_LOW');
      }
      // Eingepackte Dekoration stellt man kostenlos wieder auf.
      const eingepackt = (s.eingepackt ?? []).includes(cmd.plot);
      if (!eingepackt) {
        for (const price of level.cost) {
          if (count(s, price.item) < price.amount) throw new SimError('CANT_AFFORD');
        }
      }

      const next = cloneState(s);
      if (!eingepackt && level.cost.length > 0) {
        next.items = addItems(
          s.items,
          level.cost.map((c): [number, number] => [c.item, -c.amount]),
        );
      }
      if (eingepackt) next.eingepackt = (s.eingepackt ?? []).filter((i) => i !== cmd.plot);
      const gebaut = {
        ...plot,
        level: plot.level + 1,
        slots:
          running.length > 0
            ? [...plot.slots, ...emptySlots(capacity - plot.slots.length)]
            : emptySlots(capacity),
      };
      // Einen Apfelbaum kauft man als Setzling. Die Setzlingsuhr startet erst
      // beim Hinstellen (PLACE), darum reifSeit = 0 als „noch nicht gepflanzt".
      if (def.baum) gebaut.baum = { reifSeit: 0, geerntet: 0 };
      next.plots = replaceAt(s.plots, cmd.plot, gebaut);
      return next;
    }

    case 'COLLECT': {
      const plot = s.plots[cmd.plot];
      if (!plot) throw new SimError('NO_SUCH_PLOT');

      const slotIndex = cmd.slot ?? 0;
      const slot = plot.slots[slotIndex];
      if (!slot) throw new SimError('NO_SUCH_SLOT');
      if (slot.recipe === EMPTY_PLOT) throw new SimError('PLOT_EMPTY');

      const recipe = rules.recipes[slot.recipe];
      if (!recipe) throw new SimError('RECIPE_NOT_ALLOWED');
      if (s.tick - slot.startedAt < recipe.durationTicks) throw new SimError('NOT_DONE');

      const alle = recipeOutputs(recipe);
      let brauchtPlatz = 0;
      for (const stack of alle) {
        if (rules.items[stack.item]?.storable) brauchtPlatz += stack.amount;
      }
      if (brauchtPlatz > 0 && spaceLeft(s, rules) < brauchtPlatz) {
        throw new SimError('SILO_FULL');
      }

      const next = cloneState(s);
      next.plots = replaceAt(s.plots, cmd.plot, {
        ...plot,
        slots: replaceAt(plot.slots, slotIndex, { recipe: EMPTY_PLOT, startedAt: 0 }),
      });
      next.items = addItems(
        s.items,
        alle.map((stack) => [stack.item, stack.amount] as [number, number]),
      );

      next.xp = s.xp + recipe.xp;

      // Der Fund kommt nach dem Ertrag: Erst muss die Ernte ins Lager passen.
      const fund = fundstueck(next, rules, cmd.plot);
      if (fund) next.items = addItem(next.items, fund.item, fund.amount);
      return next;
    }

    case 'DISCARD': {
      if (!Number.isInteger(cmd.amount) || cmd.amount <= 0) throw new SimError('BAD_AMOUNT');
      const def = rules.items[cmd.item];
      if (!def) throw new SimError('NO_SUCH_ITEM');
      if (count(s, cmd.item) < cmd.amount) throw new SimError('NOT_ENOUGH_ITEMS');

      // Ware wird ersatzlos vernichtet — kein Gold, kein Tausch.
      const next = cloneState(s);
      next.items = addItem(s.items, cmd.item, -cmd.amount);
      return next;
    }

    case 'CLAIM_ACHIEVEMENT': {
      const ach = rules.achievements?.find((a) => a.id === cmd.id);
      if (!ach) throw new SimError('NO_SUCH_ACHIEVEMENT');
      if ((s.claimed ?? []).includes(cmd.id)) throw new SimError('ALREADY_CLAIMED');

      const erfuellt = achievementDone(rules, ach, erfolgsStand(s, rules));
      if (!erfuellt) throw new SimError('NOT_YET_EARNED');

      const next = cloneState(s);
      if (ach.gold > 0) next.items = addItem(s.items, rules.currency, ach.gold);
      next.xp = s.xp + ach.xp;
      next.claimed = (s.claimed ?? []).concat(cmd.id);
      return next;
    }

    case 'CLAIM_TASK': {
      const tag = s.serverTag ?? 0;
      // Vor dem allerersten Serverkontakt gibt es noch keinen Tag und damit
      // auch keine Aufgaben — dann ist nichts abzuholen.
      if (tag <= 0) throw new SimError('NO_TASKS_YET');

      const heute = tagesAufgabenFuer(rules, tag, levelOf(rules, s.xp));
      const auf = heute.find((a) => a.id === cmd.id);
      if (!auf) throw new SimError('NO_SUCH_TASK');
      if ((s.tagGeholt ?? []).includes(cmd.id)) throw new SimError('ALREADY_CLAIMED');
      if (tagesFortschritt(s, auf.art) < auf.menge) throw new SimError('NOT_YET_EARNED');

      const next = cloneState(s);
      if (auf.gold > 0) next.items = addItem(s.items, rules.currency, auf.gold);
      next.xp = s.xp + auf.xp;
      next.tagGeholt = (s.tagGeholt ?? []).concat(cmd.id);
      return next;
    }

    case 'CLAIM_DAY': {
      const lohn = rules.tagesAbschluss;
      if (!lohn) throw new SimError('NO_DAY_BONUS');
      const tag = s.serverTag ?? 0;
      if (tag <= 0) throw new SimError('NO_TASKS_YET');
      if ((s.tagGeholt ?? []).includes(TAG_ABSCHLUSS)) throw new SimError('ALREADY_CLAIMED');

      // Verlangt wird der ganze heutige Satz — und der ist auf den ersten
      // Stufen kuerzer als `aufgabenProTag`, weil der Topf dort noch wenig
      // hergibt. Waere die Zahl fest, koennten Anfaenger den Abschluss nie
      // holen. Gezaehlt statt Namen verglichen: Steigt jemand mitten am Tag
      // auf, wechselt sein Satz — die Arbeit von vorhin bleibt trotzdem getan.
      const heute = tagesAufgabenFuer(rules, tag, levelOf(rules, s.xp));
      if (heute.length === 0) throw new SimError('NO_TASKS_YET');
      const noetig = Math.min(rules.aufgabenProTag ?? 3, heute.length);
      if (tagesAbgenommen(s) < noetig) throw new SimError('NOT_YET_EARNED');

      const next = cloneState(s);
      if (lohn.gold > 0) next.items = addItem(s.items, rules.currency, lohn.gold);
      next.xp = s.xp + lohn.xp;
      next.tagGeholt = (s.tagGeholt ?? []).concat(TAG_ABSCHLUSS);
      return next;
    }

    case 'CLAIM_WEEK_TASK': {
      const tag = s.serverTag ?? 0;
      if (tag <= 0) throw new SimError('NO_TASKS_YET');
      const diese = wochenAufgabenFuer(rules, wocheVonTag(tag), levelOf(rules, s.xp));
      const auf = diese.find((a) => a.id === cmd.id);
      if (!auf) throw new SimError('NO_SUCH_TASK');
      if ((s.wochenGeholt ?? []).includes(cmd.id)) throw new SimError('ALREADY_CLAIMED');
      if (wochenFortschritt(s, auf.art) < auf.menge) throw new SimError('NOT_YET_EARNED');

      const next = cloneState(s);
      if (auf.gold > 0) next.items = addItem(s.items, rules.currency, auf.gold);
      next.xp = s.xp + auf.xp;
      next.wochenGeholt = (s.wochenGeholt ?? []).concat(cmd.id);
      return next;
    }

    case 'CLAIM_WEEK': {
      const lohn = rules.wochenAbschluss;
      if (!lohn) throw new SimError('NO_WEEK_BONUS');
      const tag = s.serverTag ?? 0;
      if (tag <= 0) throw new SimError('NO_TASKS_YET');
      if ((s.wochenGeholt ?? []).includes(WOCHE_ABSCHLUSS)) throw new SimError('ALREADY_CLAIMED');
      const diese = wochenAufgabenFuer(rules, wocheVonTag(tag), levelOf(rules, s.xp));
      if (diese.length === 0) throw new SimError('NO_TASKS_YET');
      const noetig = Math.min(rules.aufgabenProWoche ?? 3, diese.length);
      if (wochenAbgenommen(s) < noetig) throw new SimError('NOT_YET_EARNED');
      // Die Wochentruhe geht denselben Weg wie jede Kiste: Der Server wuerfelt
      // sie beim naechsten Abgleich, die Beute kommt mit der Post — und wird
      // dann enthuellt.
      if (lohn.kiste !== undefined && s.pendingBoxes.length >= MAX_PENDING_BOXES) {
        throw new SimError('TOO_MANY_BOXES');
      }

      const next = cloneState(s);
      if (lohn.gold > 0) next.items = addItem(s.items, rules.currency, lohn.gold);
      next.xp = s.xp + lohn.xp;
      next.wochenGeholt = (s.wochenGeholt ?? []).concat(WOCHE_ABSCHLUSS);
      if (lohn.kiste !== undefined) next.pendingBoxes = s.pendingBoxes.concat(lohn.kiste);
      return next;
    }

    case 'USE_BOOSTER': {
      const b = rules.booster;
      if (!b) throw new SimError('NO_BOOSTER');
      if (cmd.item !== b.xpItem && cmd.item !== b.wuchsItem) throw new SimError('NOT_A_BOOSTER');
      if (count(s, cmd.item) < 1) throw new SimError('NOT_ENOUGH_ITEMS');

      const next = cloneState(s);
      if (cmd.item === b.xpItem) {
        // Laeuft schon einer, haengt der neue hinten dran — nichts verfaellt.
        const ab = Math.max(s.tick, s.xpDoppeltBis ?? 0);
        next.xpDoppeltBis = ab + b.xpTicks;
      } else {
        // Alles, was in einem Fach laeuft, rueckt um einen Teil seiner Restzeit
        // vor — derselbe Griff wie bei der Nachbarschaftshilfe. Baeume und
        // Reusen haben eigene Uhren und bleiben aussen vor. Laeuft nichts,
        // bleibt der Booster in der Hand statt zu verpuffen.
        let geschoben = 0;
        next.plots = s.plots.map((plot) => {
          if (plot.slots.length === 0) return plot;
          const slots = plot.slots.map((slot) => {
            if (slot.recipe === EMPTY_PLOT) return slot;
            const dauer = rules.recipes[slot.recipe]?.durationTicks ?? 0;
            const rest = dauer - (s.tick - slot.startedAt);
            if (rest <= 0) return slot;
            const schub = Math.floor((rest * b.wuchsProzent) / 100);
            if (schub <= 0) return slot;
            geschoben++;
            return { ...slot, startedAt: slot.startedAt - schub };
          });
          return { ...plot, slots };
        });
        if (geschoben === 0) throw new SimError('NOTHING_GROWING');
      }
      next.items = addItem(next.items, cmd.item, -1);
      return next;
    }

    case 'REMOVE_PLOT': {
      const def = rules.plots[cmd.plot];
      const plot = s.plots[cmd.plot];
      if (!def || !plot) throw new SimError('NO_SUCH_PLOT');
      if (plot.level <= 0) throw new SimError('PLOT_LOCKED');
      if (def.fixed) throw new SimError('CANT_REMOVE');

      // Die Hälfte des eingesetzten Goldes zurück (nur Gold, keine Werkzeuge).
      let goldZurueck = 0;
      for (let l = 0; l < plot.level; l++) {
        for (const c of def.levels[l]?.cost ?? []) {
          if (c.item === rules.currency) goldZurueck += c.amount;
        }
      }
      goldZurueck = Math.floor(goldZurueck / 2);

      const next = cloneState(s);
      if (goldZurueck > 0) next.items = addItem(s.items, rules.currency, goldZurueck);
      next.plots = replaceAt(s.plots, cmd.plot, { level: 0, slots: [], gx: -1, gy: -1, tiere: [] });
      return next;
    }

    case 'PACK_PLOT': {
      const def = rules.plots[cmd.plot];
      const plot = s.plots[cmd.plot];
      if (!def || !plot) throw new SimError('NO_SUCH_PLOT');
      if (plot.level <= 0) throw new SimError('PLOT_LOCKED');
      // Nur Dekoration lässt sich einpacken (behalten & kostenlos neu aufstellen).
      if (!def.deco) throw new SimError('NOT_PACKABLE');

      const next = cloneState(s);
      next.plots = replaceAt(s.plots, cmd.plot, { level: 0, slots: [], gx: -1, gy: -1, tiere: [] });
      next.eingepackt = (s.eingepackt ?? []).includes(cmd.plot)
        ? (s.eingepackt ?? [])
        : (s.eingepackt ?? []).concat(cmd.plot);
      return next;
    }

    case 'REPAIR_BOAT': {
      const f = rules.fishing;
      if (!f || !f.repair) throw new SimError('NO_REPAIR');
      if (s.bootRepariert) throw new SimError('BOAT_DONE');
      if (levelOf(rules, s.xp) < f.minLevel) throw new SimError('PLAYER_LEVEL_TOO_LOW');
      for (const price of f.repair) {
        if (count(s, price.item) < price.amount) throw new SimError('CANT_AFFORD');
      }
      const next = cloneState(s);
      next.items = addItems(
        s.items,
        f.repair.map((c): [number, number] => [c.item, -c.amount]),
      );
      next.bootRepariert = true;
      return next;
    }

    case 'CRAFT_BAIT': {
      const f = rules.fishing;
      if (!f || !f.craft) throw new SimError('NO_CRAFT');
      // Köder stellt man am See her — also erst, wenn das Boot fährt.
      if (f.repair && !s.bootRepariert) throw new SimError('NO_FISHING');
      for (const price of f.craft.input) {
        if (count(s, price.item) < price.amount) throw new SimError('CANT_AFFORD');
      }

      const plaetze = f.craft.slots ?? 0;
      // Alte Regelwerke ohne Werkbank-Plätze: Köder entstehen sofort.
      if (plaetze <= 0) {
        if (rules.items[f.bait]?.storable && spaceLeft(s, rules) < f.craft.output) {
          throw new SimError('SILO_FULL');
        }
        const sofort = cloneState(s);
        sofort.items = addItems(s.items, [
          ...f.craft.input.map((c): [number, number] => [c.item, -c.amount]),
          [f.bait, f.craft.output],
        ]);
        return sofort;
      }

      // Sud starten: der gewünschte Platz, sonst der erste freie.
      let platz = -1;
      if (cmd.slot === undefined) {
        for (let i = 0; i < plaetze; i++) {
          if (sudStand(s, i) < 0) {
            platz = i;
            break;
          }
        }
      } else if (cmd.slot >= 0 && cmd.slot < plaetze && sudStand(s, cmd.slot) < 0) {
        platz = cmd.slot;
      }
      if (platz < 0) throw new SimError('NO_BAIT_SLOT');

      const next = cloneState(s);
      next.items = addItems(
        s.items,
        f.craft.input.map((c): [number, number] => [c.item, -c.amount]),
      );
      next.angelKoeder = setzeStand(s.angelKoeder ?? [], platz, s.tick, plaetze);
      return next;
    }

    case 'COLLECT_BAIT': {
      const f = rules.fishing;
      if (!f || !f.craft || !f.craft.slots) throw new SimError('NO_CRAFT');
      if (cmd.slot < 0 || cmd.slot >= f.craft.slots) throw new SimError('NO_BAIT_SLOT');
      const seit = sudStand(s, cmd.slot);
      if (seit < 0) throw new SimError('NOTHING_TO_COLLECT');
      if (s.tick - seit < (f.craft.durationTicks ?? 0)) throw new SimError('BAIT_NOT_READY');
      if (rules.items[f.bait]?.storable && spaceLeft(s, rules) < f.craft.output) {
        throw new SimError('SILO_FULL');
      }
      const next = cloneState(s);
      next.items = addItems(s.items, [[f.bait, f.craft.output]]);
      next.angelKoeder = setzeStand(s.angelKoeder ?? [], cmd.slot, -1, f.craft.slots);
      return next;
    }

    case 'BAIT_SPOT': {
      const f = rules.fishing;
      if (!f || !f.spots) throw new SimError('NO_FISHING');
      if (f.repair ? !s.bootRepariert : levelOf(rules, s.xp) < f.minLevel) {
        throw new SimError('NO_FISHING');
      }
      if (cmd.spot < 0 || cmd.spot >= f.spots) throw new SimError('NO_SUCH_SPOT');
      if (korbStand(s, cmd.spot) >= 0) throw new SimError('SPOT_BUSY');
      if (count(s, f.bait) < 1) throw new SimError('NO_BAIT');

      const next = cloneState(s);
      next.items = addItems(s.items, [[f.bait, -1]]);
      next.angelSpots = setzeStand(s.angelSpots ?? [], cmd.spot, s.tick, f.spots);
      return next;
    }

    case 'COLLECT_SPOT': {
      const f = rules.fishing;
      if (!f || !f.spots) throw new SimError('NO_FISHING');
      if (cmd.spot < 0 || cmd.spot >= f.spots) throw new SimError('NO_SUCH_SPOT');
      const gelegt = korbStand(s, cmd.spot);
      if (gelegt < 0) throw new SimError('SPOT_EMPTY');
      if (s.tick - gelegt < (f.soakTicks ?? 0)) throw new SimError('SPOT_NOT_READY');

      const zuege = f.catchPerSpot ?? 1;
      if (spaceLeft(s, rules) < zuege) throw new SimError('SILO_FULL');

      // Deterministisch: die Saat steckt in Legezeit, Stelle, Zugnummer und
      // Fangzähler. Reine Integer-Arithmetik, also überall exakt dasselbe.
      const fang: Array<[number, number]> = [];
      const zaehler = s.angelFang ?? 0;
      for (let z = 0; z < zuege; z++) {
        const saat = gelegt + cmd.spot * 7919 + z * 104729 + zaehler * 101;
        fang.push([zieheFang(f.table, saat), 1]);
      }

      const next = cloneState(s);
      next.items = addItems(s.items, fang);
      next.angelSpots = setzeStand(s.angelSpots ?? [], cmd.spot, -1, f.spots);
      next.xp = s.xp + f.xp * zuege;
      next.angelFang = zaehler + zuege;
      return next;
    }

    case 'CAST_LINE': {
      const f = rules.fishing;
      if (!f) throw new SimError('NO_FISHING');
      // Seit V34 wird mit Reusen gefischt. Der Sofort-Wurf ist dann zu, sonst
      // wäre die Wartezeit mit einem veränderten Client zu umgehen.
      if (f.spots) throw new SimError('NO_FISHING');
      // Neue Regel: Der See ist offen, sobald das Boot repariert ist. Ohne
      // repair-Konfiguration gilt die alte Stufen-Schranke (Abwärtskompatibilität).
      if (f.repair ? !s.bootRepariert : levelOf(rules, s.xp) < f.minLevel) {
        throw new SimError('NO_FISHING');
      }
      if (count(s, f.bait) < 1) throw new SimError('NO_BAIT');

      // Deterministischer Fang aus Tick und Fang-Zähler. Seit V34 ist der
      // Reusen-Weg der übliche; CAST_LINE bleibt für ältere Regelwerke.
      const fisch = zieheFang(f.table, s.tick + (s.angelFang ?? 0) * 101);

      // Köder verbraucht, Fisch dazu — beide lagerfähig, also kein Nettozuwachs.
      const next = cloneState(s);
      next.items = addItems(s.items, [
        [f.bait, -1],
        [fisch, 1],
      ]);
      next.xp = s.xp + f.xp;
      next.angelFang = (s.angelFang ?? 0) + 1;
      return next;
    }

    case 'SELL_NPC': {
      if (rules.sellNpcDisabled) throw new SimError('NPC_DISABLED');
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

    case 'BUY_NPC': {
      if (rules.emergencyBuyOnly) {
        if (cmd.amount !== 1) throw new SimError('BAD_AMOUNT');
        if (count(s, cmd.item) > 0) throw new SimError('ONLY_WHEN_EMPTY');
      }
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

      if (rules.offerNeedsLevel && levelOf(rules, s.xp) < itemUnlockLevel(rules, cmd.item)) {
        throw new SimError('ITEM_LOCKED');
      }

      if (s.orders.length >= rules.orderSlots) throw new SimError('NO_ORDER_SLOTS');

      const limits = offerLimits(rules, cmd.item);
      if (limits.maxAmount > 0 && cmd.amount > limits.maxAmount) {
        throw new SimError('TOO_MANY_PER_SLOT');
      }
      if (cmd.price < limits.minPrice || cmd.price > limits.maxPrice) {
        throw new SimError('PRICE_OUT_OF_BAND');
      }

      if (count(s, cmd.item) < cmd.amount) throw new SimError('NOT_ENOUGH_ITEMS');

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
        verkauft: 0,
      });
      next.nextOrderId = s.nextOrderId + 1;
      return next;
    }

    case 'COLLECT_SALE': {
      const order = s.orders.find((o) => o.id === cmd.orderId);
      if (!order) throw new SimError('NO_SUCH_ORDER');
      if (order.verkauft <= 0) throw new SimError('NOT_SOLD');

      const next = cloneState(s);
      next.orders = s.orders.filter((o) => o.id !== cmd.orderId);
      next.items = addItem(s.items, rules.currency, order.verkauft);
      return next;
    }

    case 'CANCEL_ORDER': {
      const order = s.orders.find((o) => o.id === cmd.orderId);
      if (!order) throw new SimError('NO_SUCH_ORDER');
      if (order.verkauft > 0) throw new SimError('ALREADY_SOLD');

      if (rules.items[order.item]?.storable && spaceLeft(s, rules) < order.amount) {
        throw new SimError('SILO_FULL');
      }

      const next = cloneState(s);
      next.orders = s.orders.filter((o) => o.id !== cmd.orderId);
      next.items = addItem(s.items, order.item, order.amount);
      return next;
    }

    case 'BUY_OFFER': {
      const offer = s.offers.find((o) => o.id === cmd.offerId);
      if (!offer) throw new SimError('NO_SUCH_OFFER');

      if (rules.buyNeedsLevel && levelOf(rules, s.xp) < itemUnlockLevel(rules, offer.item)) {
        throw new SimError('ITEM_LOCKED');
      }

      const total = offer.amount * offer.price;
      if (count(s, rules.currency) < total) throw new SimError('CANT_AFFORD');

      if (rules.items[offer.item]?.storable && spaceLeft(s, rules) < offer.amount) {
        throw new SimError('SILO_FULL');
      }

      const next = cloneState(s);
      next.items = addItems(s.items, [
        [rules.currency, -total],
        [offer.item, offer.amount],
      ]);

      next.offers = s.offers.filter((o) => o.id !== cmd.offerId);
      return next;
    }

    case 'COLLECT_MAIL': {
      if (s.mail.length === 0) throw new SimError('NOTHING_TO_COLLECT');

      const next = cloneState(s);
      const remaining: typeof next.mail = [];
      let collected = 0;
      let items = s.items;

      for (const entry of s.mail) {
        const def = rules.items[entry.item];

        // Bei siloUeberlauf darf das Postfach das Lager übervoll machen —
        // sonst nur so viel abholen, wie hineinpasst.
        const fits =
          rules.siloUeberlauf ||
          !def?.storable ||
          capacityOf(s, rules) - storedIn(items, rules) >= entry.amount;
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

    case 'FILL_REQUEST': {
      if (rules.boardDeliveryOnly) throw new SimError('USE_THE_BOARD');

      const index = s.requests.findIndex((r) => r.id === cmd.requestId);
      if (index < 0) throw new SimError('NO_SUCH_REQUEST');

      if (index >= rules.requestSlots) throw new SimError('REQUEST_NOT_ACTIVE');

      const request = s.requests[index]!;
      for (const stack of request.wants) {
        if (count(s, stack.item) < stack.amount) throw new SimError('NOT_ENOUGH_ITEMS');
      }

      const changes: [number, number][] = request.wants.map((w) => [w.item, -w.amount]);
      for (const r of request.reward) changes.push([r.item, r.amount]);
      if (index === 0) {
        for (const [item, menge] of geladenZurueck(s, request)) changes.push([item, menge]);
      }
      const items = addItems(s.items, changes);
      if (storedIn(items, rules) > capacityOf(s, rules)) throw new SimError('SILO_FULL');

      const next = cloneState(s);
      next.items = items;
      next.requests = s.requests.filter((r) => r.id !== cmd.requestId);
      next.xp = s.xp + request.xp;
      if (index === 0) {
        next.truck = { loaded: leereLadung(next.requests[0]), awayUntil: s.truck.awayUntil };
      }
      return next;
    }

    case 'SKIP_REQUEST': {
      if (rules.requestSkipCooldownTicks <= 0) throw new SimError('SKIP_DISABLED');

      const index = s.requests.findIndex((r) => r.id === cmd.requestId);
      if (index < 0) throw new SimError('NO_SUCH_REQUEST');
      if (index >= rules.requestSlots) throw new SimError('REQUEST_NOT_ACTIVE');
      if (s.tick < s.skipReadyAt) throw new SimError('SKIP_ON_COOLDOWN');

      const next = cloneState(s);
      next.requests = s.requests.filter((r) => r.id !== cmd.requestId);
      next.skipReadyAt = s.tick + rules.requestSkipCooldownTicks;

      if (index === 0) {
        const items = addItems(s.items, geladenZurueck(s, s.requests[0]!));
        if (storedIn(items, rules) > capacityOf(s, rules)) throw new SimError('SILO_FULL');
        next.items = items;
        next.truck = { loaded: leereLadung(next.requests[0]), awayUntil: s.truck.awayUntil };
      }
      return next;
    }

    case 'SEND_SLIP': {
      const away = truckAway(rules);
      if (away <= 0) throw new SimError('TRUCK_DISABLED');
      if (s.tick < s.truck.awayUntil) throw new SimError('TRUCK_AWAY');

      if (!Number.isInteger(cmd.slot) || cmd.slot < 0 || cmd.slot >= rules.requestSlots) {
        throw new SimError('NO_SUCH_SLIP');
      }
      const zettel = s.requests[cmd.slot];
      if (!zettel) throw new SimError('NO_SUCH_SLIP');

      for (const stack of zettel.wants) {
        if (count(s, stack.item) < stack.amount) throw new SimError('NOT_ENOUGH_ITEMS');
      }

      const changes: [number, number][] = zettel.wants.map((w) => [w.item, -w.amount]);
      for (const r of zettel.reward) changes.push([r.item, r.amount]);
      const items = addItems(s.items, changes);
      if (storedIn(items, rules) > capacityOf(s, rules)) throw new SimError('SILO_FULL');

      const next = cloneState(s);
      next.items = items;
      next.requests = s.requests.filter((_, i) => i !== cmd.slot);
      next.xp = s.xp + zettel.xp;
      next.truck = { loaded: [], awayUntil: s.tick + away };
      return next;
    }

    case 'LOAD_TRUCK': {
      const away = truckAway(rules);
      if (away <= 0) throw new SimError('TRUCK_DISABLED');
      if (s.tick < s.truck.awayUntil) throw new SimError('TRUCK_AWAY');

      const waybill = s.requests[0];
      if (!waybill) throw new SimError('NO_WAYBILL');

      const stack = waybill.wants[cmd.stack];
      if (!stack) throw new SimError('NO_SUCH_STACK');
      if (!Number.isInteger(cmd.amount) || cmd.amount <= 0) throw new SimError('BAD_AMOUNT');

      const schon = s.truck.loaded[cmd.stack] ?? 0;
      if (schon + cmd.amount > stack.amount) throw new SimError('TOO_MUCH');
      if (count(s, stack.item) < cmd.amount) throw new SimError('NOT_ENOUGH_ITEMS');

      const loaded = ladungVon(s, waybill);
      loaded[cmd.stack] = schon + cmd.amount;

      const next = cloneState(s);
      next.items = addItem(s.items, stack.item, -cmd.amount);
      next.truck = { loaded, awayUntil: s.truck.awayUntil };
      return next;
    }

    case 'SEND_TRUCK': {
      const away = truckAway(rules);
      if (away <= 0) throw new SimError('TRUCK_DISABLED');
      if (s.tick < s.truck.awayUntil) throw new SimError('TRUCK_AWAY');

      const waybill = s.requests[0];
      if (!waybill) throw new SimError('NO_WAYBILL');

      const voll = waybill.wants.every((w, i) => (s.truck.loaded[i] ?? 0) >= w.amount);
      if (!voll) throw new SimError('TRUCK_NOT_FULL');

      const items = addItems(
        s.items,
        waybill.reward.map((r): [number, number] => [r.item, r.amount]),
      );
      if (storedIn(items, rules) > capacityOf(s, rules)) throw new SimError('SILO_FULL');

      const next = cloneState(s);
      next.items = items;
      next.requests = s.requests.slice(1);
      next.xp = s.xp + waybill.xp;
      next.truck = { loaded: leereLadung(next.requests[0]), awayUntil: s.tick + away };
      return next;
    }

    case 'PLACE': {
      const raster = rules.grid;
      if (!raster) throw new SimError('NO_GRID');

      const def = rules.plots[cmd.plot];
      const plot = s.plots[cmd.plot];
      if (!def || !plot) throw new SimError('NO_SUCH_PLOT');
      if (plot.level <= 0) throw new SimError('PLOT_LOCKED');
      if (def.fixed) throw new SimError('OFF_GRID');

      const groesse = sizeOf(rules, cmd.plot);
      if (!Number.isInteger(cmd.gx) || !Number.isInteger(cmd.gy)) throw new SimError('OFF_GRID');
      if (cmd.gx < 0 || cmd.gy < 0) throw new SimError('OFF_GRID');
      if (cmd.gx + groesse.w > raster.w || cmd.gy + groesse.h > raster.h) {
        throw new SimError('OFF_GRID');
      }

      if (blockiert(rules, cmd.gx, cmd.gy, groesse.w, groesse.h, s.clearedObstacles, s.expandiert)) {
        throw new SimError('CELL_TAKEN');
      }

      for (const [i, other] of s.plots.entries()) {
        if (i === cmd.plot || other.gx < 0) continue;
        const andere = sizeOf(rules, i);
        const frei =
          cmd.gx + groesse.w <= other.gx ||
          other.gx + andere.w <= cmd.gx ||
          cmd.gy + groesse.h <= other.gy ||
          other.gy + andere.h <= cmd.gy;
        if (!frei) throw new SimError('CELL_TAKEN');
      }

      const next = cloneState(s);
      const gesetzt = { ...plot, gx: cmd.gx, gy: cmd.gy };
      // Beim ersten Hinstellen den Setzling einpflanzen: die Setzlingsuhr läuft
      // ab jetzt. Späteres Verschieben (reifSeit > 0) setzt sie nicht zurück.
      if (def.baum && plot.baum && plot.baum.reifSeit === 0) {
        gesetzt.baum = { reifSeit: s.tick + def.baum.setzlingTicks, geerntet: 0 };
      }
      next.plots = replaceAt(s.plots, cmd.plot, gesetzt);
      return next;
    }

    case 'EXPAND': {
      const feld = rules.expansions?.find((e) => e.id === cmd.id);
      if (!feld) throw new SimError('NO_SUCH_EXPANSION');
      if (s.expandiert.includes(feld.id)) throw new SimError('ALREADY_EXPANDED');
      if (levelOf(rules, s.xp) < feld.minLevel) throw new SimError('PLAYER_LEVEL_TOO_LOW');
      for (const c of feld.cost) {
        if (count(s, c.item) < c.amount) throw new SimError('NOT_ENOUGH_ITEMS');
      }

      const next = cloneState(s);
      next.items = addItems(
        s.items,
        feld.cost.map((c) => [c.item, -c.amount] as [number, number]),
      );
      next.expandiert = s.expandiert.concat(feld.id);
      return next;
    }

    case 'HARVEST_TREE': {
      const def = rules.plots[cmd.plot];
      const plot = s.plots[cmd.plot];
      if (!def || !plot) throw new SimError('NO_SUCH_PLOT');
      if (!def.baum || !plot.baum) throw new SimError('NOT_A_TREE');
      if (plot.level <= 0) throw new SimError('PLOT_LOCKED');
      if (rules.grid && plot.gx < 0) throw new SimError('NOT_PLACED');

      const stufe = baumStufe(def.baum, plot.baum.reifSeit, plot.baum.geerntet, s.tick);
      if (stufe !== 'reif') throw new SimError('TREE_NOT_RIPE');

      const ertrag = def.baum.ertrag;
      if (rules.items[ertrag.item]?.storable && spaceLeft(s, rules) < ertrag.amount) {
        throw new SimError('SILO_FULL');
      }

      const next = cloneState(s);
      next.items = addItem(s.items, ertrag.item, ertrag.amount);
      next.xp = s.xp + def.baum.xp;
      next.plots = replaceAt(s.plots, cmd.plot, {
        ...plot,
        baum: { reifSeit: s.tick, geerntet: plot.baum.geerntet + 1 },
      });

      const baumFund = fundstueck(next, rules, cmd.plot);
      if (baumFund) next.items = addItem(next.items, baumFund.item, baumFund.amount);
      return next;
    }

    case 'FELL_TREE': {
      const def = rules.plots[cmd.plot];
      const plot = s.plots[cmd.plot];
      if (!def || !plot) throw new SimError('NO_SUCH_PLOT');
      if (!def.baum || !plot.baum) throw new SimError('NOT_A_TREE');

      const stufe = baumStufe(def.baum, plot.baum.reifSeit, plot.baum.geerntet, s.tick);
      if (stufe !== 'verwelkt') throw new SimError('TREE_NOT_WITHERED');
      if (count(s, def.baum.faellenWerkzeug) < 1) throw new SimError('NEEDS_TOOL');

      const next = cloneState(s);
      next.items = addItem(s.items, def.baum.faellenWerkzeug, -1);
      next.xp = s.xp + def.baum.faellenXp;
      // Der Baum ist weg: Platz zurück auf Stufe 0 und vom Raster nehmen, damit
      // man an derselben Stelle einen neuen Baum (oder etwas anderes) setzen kann.
      next.plots = replaceAt(s.plots, cmd.plot, {
        level: 0,
        slots: [],
        gx: -1,
        gy: -1,
        tiere: [],
      });
      return next;
    }

    case 'CLEAR_OBSTACLE': {
      const hindernis = rules.obstacles?.[cmd.index];
      if (!hindernis) throw new SimError('NO_SUCH_OBSTACLE');
      if (s.clearedObstacles.includes(cmd.index)) throw new SimError('ALREADY_CLEARED');
      if (obstacleLocked(rules, cmd.index, s.expandiert)) throw new SimError('CELL_TAKEN');

      const art = rules.obstacleKinds?.[hindernis.kind];
      if (!art) throw new SimError('NEEDS_TOOL');
      if (count(s, art.tool) < 1) throw new SimError('NEEDS_TOOL');

      // Seit V36 fällt beim Räumen etwas ab — Bäume geben Holz. Das macht aus
      // dem reinen Kostenakt den Einstieg in die Werkzeugkette. Ältere
      // Regelwerke haben kein `ertrag` und verhalten sich unverändert.
      const ertrag = art.ertrag;
      if (ertrag && rules.items[ertrag.item]?.storable && spaceLeft(s, rules) < ertrag.amount) {
        throw new SimError('SILO_FULL');
      }

      const next = cloneState(s);
      next.items = addItems(
        s.items,
        ertrag
          ? [
              [art.tool, -1],
              [ertrag.item, ertrag.amount],
            ]
          : [[art.tool, -1]],
      );
      next.clearedObstacles = s.clearedObstacles.concat(cmd.index);
      next.xp = s.xp + art.xp;
      return next;
    }

    case 'OPEN_CHEST': {
      const kisten = rules.chestKinds;
      if (!kisten || kisten.length === 0) throw new SimError('NO_SUCH_CHEST');

      const kiste = s.chests[0];
      if (!kiste || kiste.id !== cmd.chestId) throw new SimError('NO_SUCH_CHEST');
      if (s.tick < s.chestReadyAt) throw new SimError('CHEST_NOT_READY');
      if (s.pendingBoxes.length >= MAX_PENDING_BOXES) throw new SimError('TOO_MANY_BOXES');

      const next = cloneState(s);
      next.chests = s.chests.slice(1);
      next.pendingBoxes = s.pendingBoxes.concat(kiste.kind);
      next.chestReadyAt = s.tick + (rules.chestEveryTicks ?? 0);
      return next;
    }

    case 'UPGRADE_SILO': {
      const stufen = rules.siloLevels;
      if (!stufen || stufen.length === 0) throw new SimError('SILO_LOCKED');

      const naechste = stufen[s.siloLevel + 1];
      if (!naechste) throw new SimError('SILO_MAX');
      for (const preis of naechste.cost) {
        if (count(s, preis.item) < preis.amount) throw new SimError('CANT_AFFORD');
      }

      const next = cloneState(s);
      next.items = addItems(
        s.items,
        naechste.cost.map((c): [number, number] => [c.item, -c.amount]),
      );
      next.siloLevel = s.siloLevel + 1;
      return next;
    }

    default:
      throw new SimError('UNKNOWN_COMMAND');
  }
}

export function simulateAll(state: State, cmds: readonly Command[], rules: Ruleset): State {
  let s = state;
  for (const cmd of cmds) s = simulate(s, cmd, rules);
  return s;
}

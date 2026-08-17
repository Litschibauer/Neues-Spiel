/**
 * Das Anzeigemodell — die Brücke zwischen Sim-Kern und Oberfläche.
 *
 * Es beantwortet die Fragen, die JEDE Oberfläche stellt, egal wie sie aussieht:
 * Ist dieses Feld reif? Wie weit ist es? Kann ich mir das leisten? Passt es
 * noch ins Lager? Diese Fragen haben genau eine richtige Antwort, und die soll
 * nicht in jeder Oberfläche neu — und leicht anders — hergeleitet werden.
 *
 * ── Warum das eine eigene Datei ist ─────────────────────────────────────────
 *
 * Weil hier drei Dinge zusammenkommen, die man sonst dauerhaft vermischt:
 *
 *  1. **Die Sim** darf nichts von Anzeige wissen. Sie kennt Katalogindizes und
 *     Ticks, sonst nichts (§2.2).
 *  2. **Die Oberfläche** darf keine Spielregel enthalten. Sobald sie selbst
 *     ausrechnet, ob etwas bezahlbar ist, gibt es zwei Wahrheiten — und eine
 *     davon ist irgendwann falsch.
 *  3. **Beides zusammen** muss prüfbar sein, ohne einen Browser zu starten.
 *
 * ── Bewusst ohne Text ───────────────────────────────────────────────────────
 *
 * Hier steht **kein einziges deutsches Wort für die Anzeige**: keine Namen,
 * keine Statussätze, keine Zeitangaben wie „9 s". Nur Zahlen, Flags und
 * Katalog-Kennungen.
 *
 * Das ist die Bedingung dafür, dass eine zweite Oberfläche billig wird — ein
 * eigenes Design, eine andere Sprache, später eine native App. Sie alle
 * konsumieren dasselbe Modell und entscheiden selbst, wie „reif" aussieht und
 * wie es heißt. Ein Statussatz an dieser Stelle wäre bequem und würde genau
 * das verhindern.
 */

import type { Ruleset } from '../sim/rules.ts';
import { levelOf, levelStartedAt, listingFee, nextLevelAt } from '../sim/rules.ts';
import type { State } from '../sim/state.ts';
import { EMPTY_PLOT, count, stored } from '../sim/state.ts';

export type Stack = { item: number; amount: number };

/** Warum eine Aktion gerade nicht geht. `null` heißt: sie geht. */
export type Blocker = 'level' | 'cost' | 'inputs' | 'space' | 'slots' | 'offline' | null;

export type PlotView = {
  index: number;
  /** Katalog-Kennung des Platzes — daran hängt die Zeichnung. */
  id: string;
  level: number;
  /** Gehört dem Spieler noch nicht, oder kann auf dieser Stufe nichts. */
  idle: boolean;
  busy: boolean;
  done: boolean;
  /** 0…1. Bei `done` immer 1, bei leerem Platz 0. */
  progress: number;
  /** Ticks bis fertig. 0, wenn nichts läuft oder es fertig ist. */
  remaining: number;
  /** Was gerade produziert wird — Katalog-Kennung, oder `null`. */
  producing: string | null;
  /** Was beim Abholen herauskommt. */
  output: Stack | null;
  /**
   * Das Rezept, das ein Tipp STARTEN würde — mit dem, was es kostet.
   *
   * `null`, wenn gerade nichts zu starten ist. Steht hier, seit Zutaten
   * verbraucht werden: „Antippen zum Starten" verschweigt, dass ein Korn aus
   * dem Lager verschwindet, und ein Spieler, der das erst hinterher merkt,
   * zählt Verluste statt Erträge. Die Oberfläche soll den Preis nennen können,
   * bevor getippt wird — und ihn nicht selbst ausrechnen müssen.
   */
  next: {
    recipe: number;
    id: string;
    inputs: readonly Stack[];
    output: Stack;
    durationTicks: number;
  } | null;
  /**
   * Was ein Tipp auf diesen Platz auslöst. Genau eine Antwort, damit nicht
   * jede Oberfläche ihre eigene Reihenfolge erfindet.
   */
  tap: 'collect' | 'start' | 'buy' | 'none';
  blocked: Blocker;
  upgrade: {
    label: string;
    cost: readonly Stack[];
    minPlayerLevel: number;
    /** Spielerstufe reicht. */
    unlocked: boolean;
    /** Stufe reicht UND bezahlbar. */
    affordable: boolean;
  } | null;
};

export type RequestView = {
  id: number;
  wants: readonly Stack[];
  reward: readonly Stack[];
  xp: number;
  /** Steht noch im Vorrat und ist nicht annehmbar. */
  waiting: boolean;
  deliverable: boolean;
};

export type OfferView = {
  id: number;
  item: number;
  amount: number;
  /** Pro Stück. */
  price: number;
  total: number;
  affordable: boolean;
  fits: boolean;
};

export type OrderView = {
  id: number;
  item: number;
  amount: number;
  price: number;
  /**
   * Ticks bis zum Verfall — `null` heißt: verfällt nicht.
   *
   * Der Normalfall ist inzwischen `null`. Ware bleibt stehen, bis jemand sie
   * kauft oder der Verkäufer sie zurückzieht; bezahlt wird stattdessen beim
   * Einstellen (`fee`). Das Feld bleibt trotzdem, weil ein Regelwerk eine Frist
   * wieder einschalten darf — und dann muss die Oberfläche sie zeigen können.
   */
  expiresIn: number | null;
  /** Wie lange der Auftrag schon steht. Ohne Frist die interessantere Zahl. */
  listedFor: number;
};

export type StockView = {
  item: number;
  id: string;
  amount: number;
  /** An den NPC verkaufbar. */
  sellable: boolean;
  npcPrice: number;
  /**
   * Was der Händler dafür VERLANGT. `0` heißt: führt er nicht.
   *
   * Immer höher als `npcPrice` — sonst wäre der Händler eine Geldpresse, und
   * `validateRuleset` ließe das Regelwerk gar nicht erst durch.
   */
  npcBuyPrice: number;
  /** Höchstpreis im Band — was ein Angebot am Markt bringen darf. */
  bandMax: number;
  /** Mindestpreis im Band. Zusammen mit `bandMax` der erlaubte Bereich (§8). */
  bandMin: number;
  /**
   * Was das Einstellen EINES Stücks kostet.
   *
   * Aufgerundet, also nicht linear: Zwei Stück kosten nicht zwangsläufig das
   * Doppelte. Für die genaue Summe rechnet die Oberfläche mit `listingFee` —
   * derselben Funktion wie die Sim.
   */
  feePerUnit: number;
};

export type FarmView = {
  level: number;
  xp: { total: number; into: number; span: number; atMax: boolean };
  currency: { item: number; amount: number };
  silo: { used: number; capacity: number; full: boolean; free: number };
  plots: readonly PlotView[];
  requests: readonly RequestView[];
  offers: readonly OfferView[];
  orders: readonly OrderView[];
  orderSlotsFree: number;
  mail: { entries: readonly Stack[]; capacity: number };
  stock: readonly StockView[];
  /** Wie viele Angebote gerade wirklich kaufbar wären — für eine Zahl am Reiter. */
  buyable: number;
};

/** Rezepte, die auf diesem Platz und dieser Stufe laufen dürfen. */
function recipesAt(rules: Ruleset, plot: number, level: number): readonly number[] {
  if (level <= 0) return [];
  return rules.plots[plot]?.levels[level - 1]?.recipes ?? [];
}

/** Erstes erlaubtes Rezept, dessen Zutaten vorhanden sind. `-1` = keins. */
function startable(state: State, rules: Ruleset, plot: number): number {
  for (const index of recipesAt(rules, plot, state.plots[plot]?.level ?? 0)) {
    const recipe = rules.recipes[index];
    if (!recipe) continue;
    if (recipe.inputs.every((input) => count(state, input.item) >= input.amount)) return index;
  }
  return -1;
}

function plotView(state: State, rules: Ruleset, i: number): PlotView {
  const def = rules.plots[i]!;
  const plot = state.plots[i]!;
  const playerLevel = levelOf(rules, state.xp);
  const next = def.levels[plot.level] ?? null;

  const upgrade = next
    ? {
        label: next.label,
        cost: next.cost,
        minPlayerLevel: next.minPlayerLevel ?? 1,
        unlocked: playerLevel >= (next.minPlayerLevel ?? 1),
        affordable:
          playerLevel >= (next.minPlayerLevel ?? 1) &&
          next.cost.every((c) => count(state, c.item) >= c.amount),
      }
    : null;

  const busy = plot.recipe !== EMPTY_PLOT;
  const recipe = busy ? rules.recipes[plot.recipe] : undefined;
  const duration = recipe?.durationTicks ?? 0;
  const elapsed = busy ? state.tick - plot.startedAt : 0;
  const done = busy && elapsed >= duration;
  const canRun = recipesAt(rules, i, plot.level).length > 0;

  const nextRecipe = busy ? -1 : startable(state, rules, i);

  let tap: PlotView['tap'] = 'none';
  let blocked: Blocker = null;

  if (done || busy) {
    tap = done ? 'collect' : 'none';
  } else if (!canRun) {
    // Noch nicht gekauft, oder gekauft und leer (ein Gehege ohne Hühner).
    tap = upgrade ? 'buy' : 'none';
    if (upgrade && !upgrade.unlocked) blocked = 'level';
    else if (upgrade && !upgrade.affordable) blocked = 'cost';
  } else if (nextRecipe < 0) {
    blocked = 'inputs';
  } else {
    tap = 'start';
  }

  const startDef = nextRecipe >= 0 ? rules.recipes[nextRecipe] : undefined;

  return {
    index: i,
    id: def.id,
    level: plot.level,
    idle: !busy && !canRun,
    busy: busy && !done,
    done,
    progress: busy ? (done ? 1 : duration > 0 ? Math.min(1, elapsed / duration) : 0) : 0,
    remaining: busy && !done ? Math.max(0, duration - elapsed) : 0,
    producing: recipe ? recipe.id : null,
    output: recipe ? { item: recipe.output.item, amount: recipe.output.amount } : null,
    next: startDef
      ? {
          recipe: nextRecipe,
          id: startDef.id,
          inputs: startDef.inputs.map((x) => ({ item: x.item, amount: x.amount })),
          output: { item: startDef.output.item, amount: startDef.output.amount },
          durationTicks: startDef.durationTicks,
        }
      : null,
    tap,
    blocked,
    upgrade,
  };
}

/**
 * Alles, was eine Oberfläche über diesen Hof wissen muss — in einem Rutsch.
 *
 * `state` ist der VORHERGESAGTE Zustand (`client.preview()`), nicht der
 * bestätigte: Der Spieler soll seine Ernte sofort sehen und nicht erst nach
 * dem Sync (§3).
 */
export function farmView(state: State, rules: Ruleset, online = true): FarmView {
  const used = stored(state, rules);
  const free = rules.siloCapacity - used;
  const at = nextLevelAt(rules, state.xp);
  const from = levelStartedAt(rules, state.xp);

  const offers: OfferView[] = state.offers.map((o) => {
    const total = o.amount * o.price;
    return {
      id: o.id,
      item: o.item,
      amount: o.amount,
      price: o.price,
      total,
      affordable: count(state, rules.currency) >= total,
      fits: !rules.items[o.item]?.storable || free >= o.amount,
    };
  });

  const stock: StockView[] = rules.items.map((item, i) => ({
    item: i,
    id: item.id,
    amount: count(state, i),
    sellable: item.storable && item.npcPrice > 0,
    npcPrice: item.npcPrice,
    npcBuyPrice: item.npcBuyPrice,
    bandMax: Math.floor((item.npcPrice * rules.priceBandMaxPct) / 100),
    bandMin: Math.floor((item.npcPrice * rules.priceBandMinPct) / 100),
    feePerUnit: listingFee(rules, i, 1),
  }));

  return {
    level: levelOf(rules, state.xp),
    xp: {
      total: state.xp,
      into: state.xp - from,
      span: at === null ? 0 : at - from,
      atMax: at === null,
    },
    currency: { item: rules.currency, amount: count(state, rules.currency) },
    silo: { used, capacity: rules.siloCapacity, full: free <= 0, free },
    plots: state.plots.map((_, i) => plotView(state, rules, i)),
    requests: state.requests.slice(0, rules.requestSlots + 2).map((r, i) => ({
      id: r.id,
      wants: r.wants,
      reward: r.reward,
      xp: r.xp,
      waiting: i >= rules.requestSlots,
      deliverable:
        i < rules.requestSlots && r.wants.every((w) => count(state, w.item) >= w.amount),
    })),
    offers,
    orders: state.orders.map((o) => ({
      id: o.id,
      item: o.item,
      amount: o.amount,
      price: o.price,
      expiresIn:
        rules.orderTtlTicks > 0 ? Math.max(0, rules.orderTtlTicks - (state.tick - o.listedAt)) : null,
      listedFor: Math.max(0, state.tick - o.listedAt),
    })),
    orderSlotsFree: rules.orderSlots - state.orders.length,
    mail: {
      entries: state.mail.map((m) => ({ item: m.item, amount: m.amount })),
      capacity: rules.mailCapacity,
    },
    stock,
    // Ohne Netz ist nichts kaufbar (§6) — das gehört ins Modell, nicht in jede
    // Oberfläche einzeln.
    buyable: online ? offers.filter((o) => o.affordable && o.fits).length : 0,
  };
}

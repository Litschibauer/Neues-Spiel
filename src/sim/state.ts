import type { Ruleset } from './rules.ts';
import { derivedTables, slotsAt } from './rules.ts';

export type Slot = {
  recipe: number;
  startedAt: number;
};

// Apfelbaum-Zustand: reifSeit = Tick, ab dem die aktuelle Apfelrunde zählt
// (beim Pflanzen auf Pflanztick + Setzlingszeit gesetzt); geerntet = Anzahl
// bisheriger Ernten. Nur Baum-Plätze tragen dieses Feld.
export type Baum = {
  reifSeit: number;
  geerntet: number;
};

export type Plot = {
  level: number;
  slots: readonly Slot[];
  gx: number;
  gy: number;
  tiere: readonly number[];
  baum?: Baum;
};

export const EMPTY_SLOT: Slot = { recipe: -1, startedAt: 0 };

export function emptySlots(n: number): Slot[] {
  const out: Slot[] = [];
  for (let i = 0; i < n; i++) out.push({ recipe: EMPTY_PLOT, startedAt: 0 });
  return out;
}

export const EMPTY_PLOT = -1;

export type Order = {
  id: number;
  item: number;
  amount: number;
  price: number;
  listedAt: number;
  verkauft: number;
};

export type Offer = {
  id: number;
  item: number;
  amount: number;
  price: number;
  seller: string;
  hof: string;
  headline: boolean;
};

export type MailItem = {
  item: number;
  amount: number;
  arrivedAt: number;
};

export type Request = {
  id: number;
  wants: readonly { item: number; amount: number }[];
  reward: readonly { item: number; amount: number }[];
  xp: number;
  dest: number;
};

export type Chest = {
  id: number;
  kind: number;
  readyAt: number;
  gx: number;
  gy: number;
};

export type Truck = {
  loaded: readonly number[];
  awayUntil: number;
};

export type State = {
  tick: number;
  xp: number;
  items: readonly number[];
  plots: readonly Plot[];
  passives: readonly number[];
  orders: readonly Order[];
  offers: readonly Offer[];
  mail: readonly MailItem[];
  nextOrderId: number;
  requests: readonly Request[];
  skipReadyAt: number;
  truck: Truck;
  siloLevel: number;
  chests: readonly Chest[];
  nextChestId: number;
  pendingBoxes: readonly number[];
  clearedObstacles: readonly number[];
  expandiert: readonly string[];
  chestReadyAt: number;
};

export function count(s: State, item: number): number {
  return s.items[item] ?? 0;
}

export function capacityOf(s: State, rules: Ruleset): number {
  const stufen = rules.siloLevels;
  if (!stufen || stufen.length === 0) return rules.siloCapacity;
  const stufe = stufen[Math.min(s.siloLevel, stufen.length - 1)];
  return stufe ? stufe.capacity : rules.siloCapacity;
}

export function stored(s: State, rules: Ruleset): number {
  return storedIn(s.items, rules);
}

export function storedIn(items: readonly number[], rules: Ruleset): number {
  const { storable } = derivedTables(rules);
  let total = 0;
  for (const i of storable) total += items[i] ?? 0;
  return total;
}

export function spaceLeft(s: State, rules: Ruleset): number {
  return capacityOf(s, rules) - stored(s, rules);
}

export function totalGoods(s: State, rules: Ruleset): number {
  let total = stored(s, rules);
  for (const o of s.orders) total += o.amount;
  for (const m of s.mail) {
    if (rules.items[m.item]?.storable) total += m.amount;
  }
  return total;
}

export function initialState(rules: Ruleset): State {
  const items: number[] = [];
  for (let i = 0; i < rules.items.length; i++) items.push(0);

  for (const stack of rules.startingItems) {
    items[stack.item] = (items[stack.item] ?? 0) + stack.amount;
  }

  const plots: Plot[] = [];
  for (const def of rules.plots) {
    const i = plots.length;
    const start = startPlatz(rules, i);
    plots.push({
      level: def.startLevel,
      slots: emptySlots(slotsAt(rules, i, def.startLevel)),
      gx: def.startLevel > 0 || def.fixed ? start.gx : -1,
      gy: def.startLevel > 0 || def.fixed ? start.gy : -1,
      tiere: [],
    });
  }

  const passives: number[] = [];
  for (let i = 0; i < rules.passives.length; i++) passives.push(0);

  return {
    tick: 0,
    xp: 0,
    items,
    plots,
    passives,
    orders: [],
    offers: [],
    mail: [],
    nextOrderId: 1,
    requests: [],
    truck: { loaded: [], awayUntil: 0 },
    siloLevel: 0,
    chests: [],
    nextChestId: 1,
    pendingBoxes: [],
    clearedObstacles: [],
    expandiert: [],
    chestReadyAt: 0,
    skipReadyAt: 0,
  };
}

export function startPlatz(rules: Ruleset, plot: number): { gx: number; gy: number } {
  const raster = rules.grid;
  const ort = rules.plots[plot]?.place;
  if (!raster || !ort) return { gx: -1, gy: -1 };

  const groesse = rules.plots[plot]?.size ?? { w: 1, h: 1 };
  const gx = Math.min(raster.w - groesse.w, Math.floor((ort.x * raster.w) / 100));
  const gy = Math.min(raster.h - groesse.h, Math.floor((ort.y * raster.h) / 100));
  return { gx: Math.max(0, gx), gy: Math.max(0, gy) };
}

export function normalizeState(s: State): State {
  const plots = s.plots.map((p) => {
    const mitRaster = (x: Plot): Plot => ({
      ...x,
      gx: x.gx === undefined ? -1 : x.gx,
      gy: x.gy === undefined ? -1 : x.gy,
      tiere: x.tiere ?? [],
    });
    if (Array.isArray((p as { slots?: unknown }).slots)) return mitRaster(p);
    const alt = p as unknown as { level: number; recipe?: number; startedAt?: number };
    if (alt.level <= 0) return { level: alt.level, slots: [], gx: -1, gy: -1, tiere: [] };
    return mitRaster({
      level: alt.level,
      slots: [{ recipe: alt.recipe ?? EMPTY_PLOT, startedAt: alt.startedAt ?? 0 }],
      gx: -1,
      gy: -1,
      tiere: [],
    });
  });

  return {
    ...s,
    plots,
    xp: s.xp ?? 0,
    orders: (s.orders ?? []).map((o) => ({ ...o, verkauft: o.verkauft ?? 0 })),
    offers: (s.offers ?? []).map((o) => ({
      ...o,
      seller: o.seller ?? '',
      hof: o.hof ?? '',
      headline: o.headline ?? false,
    })),
    mail: s.mail ?? [],
    requests: (s.requests ?? []).map((r) => (r.dest === undefined ? { ...r, dest: 0 } : r)),
    skipReadyAt: s.skipReadyAt ?? 0,
    truck: s.truck ?? { loaded: [], awayUntil: 0 },
    siloLevel: s.siloLevel ?? 0,
    chests: (s.chests ?? []).map((k) => ({ ...k, gx: k.gx ?? -1, gy: k.gy ?? -1 })),
    nextChestId: s.nextChestId ?? 1,
    pendingBoxes: s.pendingBoxes ?? [],
    clearedObstacles: s.clearedObstacles ?? [],
    expandiert: s.expandiert ?? [],
    chestReadyAt: s.chestReadyAt ?? 0,
  };
}

export function cloneState(s: State): State {
  return {
    tick: s.tick,
    xp: s.xp,
    items: s.items,
    plots: s.plots,
    passives: s.passives,
    orders: s.orders,
    offers: s.offers,
    mail: s.mail,
    nextOrderId: s.nextOrderId,
    requests: s.requests,
    truck: s.truck,
    siloLevel: s.siloLevel,
    chests: s.chests,
    nextChestId: s.nextChestId,
    pendingBoxes: s.pendingBoxes,
    clearedObstacles: s.clearedObstacles,
    expandiert: s.expandiert ?? [],
    chestReadyAt: s.chestReadyAt,
    skipReadyAt: s.skipReadyAt,
  };
}

export function replaceAt<T>(list: readonly T[], index: number, value: T): T[] {
  const next = list.slice();
  next[index] = value;
  return next;
}

export function addItem(items: readonly number[], item: number, delta: number): number[] {
  const next = items.slice();
  next[item] = (next[item] ?? 0) + delta;
  return next;
}

export function addItems(items: readonly number[], changes: readonly [number, number][]): number[] {
  const next = items.slice();
  for (const [item, delta] of changes) next[item] = (next[item] ?? 0) + delta;
  return next;
}

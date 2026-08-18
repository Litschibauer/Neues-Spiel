import type { Ruleset } from './rules.ts';
import { derivedTables, slotsAt } from './rules.ts';

export type Slot = {
  recipe: number;
  startedAt: number;
};

export type Plot = {
  level: number;
  slots: readonly Slot[];
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
};

export type Offer = {
  id: number;
  item: number;
  amount: number;
  price: number;
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
};

export function count(s: State, item: number): number {
  return s.items[item] ?? 0;
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
  return rules.siloCapacity - stored(s, rules);
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
    plots.push({ level: def.startLevel, slots: emptySlots(slotsAt(rules, plots.length, def.startLevel)) });
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
    skipReadyAt: 0,
  };
}

export function normalizeState(s: State): State {
  const plots = s.plots.map((p) => {
    if (Array.isArray((p as { slots?: unknown }).slots)) return p;
    const alt = p as unknown as { level: number; recipe?: number; startedAt?: number };
    if (alt.level <= 0) return { level: alt.level, slots: [] };
    return {
      level: alt.level,
      slots: [{ recipe: alt.recipe ?? EMPTY_PLOT, startedAt: alt.startedAt ?? 0 }],
    };
  });

  return {
    ...s,
    plots,
    xp: s.xp ?? 0,
    offers: s.offers ?? [],
    mail: s.mail ?? [],
    requests: s.requests ?? [],
    skipReadyAt: s.skipReadyAt ?? 0,
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

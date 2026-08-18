import type { Ruleset } from '../sim/rules.ts';
import { levelOf, levelStartedAt, listingFee, nextLevelAt, priceBand } from '../sim/rules.ts';
import type { State } from '../sim/state.ts';
import { EMPTY_PLOT, count, stored } from '../sim/state.ts';

export type Stack = { item: number; amount: number };

export type Blocker = 'level' | 'cost' | 'inputs' | 'space' | 'slots' | 'offline' | null;

export type PlotView = {
  index: number;
  id: string;
  level: number;
  idle: boolean;
  busy: boolean;
  done: boolean;
  progress: number;
  remaining: number;
  producing: string | null;
  output: Stack | null;
  next: RecipeOption | null;
  options: readonly RecipeOption[];
  tap: 'collect' | 'start' | 'buy' | 'none';
  blocked: Blocker;
  upgrade: {
    label: string;
    cost: readonly Stack[];
    minPlayerLevel: number;
    unlocked: boolean;
    affordable: boolean;
  } | null;
};

export type RecipeOption = {
  recipe: number;
  id: string;
  inputs: readonly Stack[];
  output: Stack;
  durationTicks: number;
  affordable: boolean;
};

export type RequestView = {
  id: number;
  wants: readonly Stack[];
  reward: readonly Stack[];
  xp: number;
  waiting: boolean;
  deliverable: boolean;
  skippable: boolean;
};

export type OfferView = {
  id: number;
  item: number;
  amount: number;
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
  expiresIn: number | null;
  listedFor: number;
};

export type StockView = {
  item: number;
  id: string;
  amount: number;
  sellable: boolean;
  npcPrice: number;
  npcBuyPrice: number;
  bandMax: number;
  bandMin: number;
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
  buyable: number;
  skip: {
    enabled: boolean;
    ready: boolean;
    readyIn: number;
    cooldownTicks: number;
  };
};

function recipesAt(rules: Ruleset, plot: number, level: number): readonly number[] {
  if (level <= 0) return [];
  return rules.plots[plot]?.levels[level - 1]?.recipes ?? [];
}

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

  const options: RecipeOption[] = busy
    ? []
    : recipesAt(rules, i, plot.level).flatMap((index) => {
        const def = rules.recipes[index];
        if (!def) return [];
        return [
          {
            recipe: index,
            id: def.id,
            inputs: def.inputs.map((x) => ({ item: x.item, amount: x.amount })),
            output: { item: def.output.item, amount: def.output.amount },
            durationTicks: def.durationTicks,
            affordable: def.inputs.every((x) => count(state, x.item) >= x.amount),
          },
        ];
      });

  let tap: PlotView['tap'] = 'none';
  let blocked: Blocker = null;

  if (done || busy) {
    tap = done ? 'collect' : 'none';
  } else if (!canRun) {
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
    next: startDef ? options.find((o) => o.recipe === nextRecipe) ?? null : null,
    options,
    tap,
    blocked,
    upgrade,
  };
}

export function farmView(state: State, rules: Ruleset, online = true): FarmView {
  const used = stored(state, rules);
  const free = rules.siloCapacity - used;
  const at = nextLevelAt(rules, state.xp);
  const from = levelStartedAt(rules, state.xp);

  const skipEnabled = rules.requestSkipCooldownTicks > 0;
  const skipReady = state.tick >= state.skipReadyAt;

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
    bandMax: priceBand(rules, i).max,
    bandMin: priceBand(rules, i).min,
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
      skippable: skipEnabled && skipReady && i < rules.requestSlots,
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

    buyable: online ? offers.filter((o) => o.affordable && o.fits).length : 0,
    skip: {
      enabled: skipEnabled,
      ready: skipEnabled && skipReady,
      readyIn: skipEnabled ? Math.max(0, state.skipReadyAt - state.tick) : 0,
      cooldownTicks: rules.requestSkipCooldownTicks,
    },
  };
}

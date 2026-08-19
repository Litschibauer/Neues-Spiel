import type { Ruleset } from '../sim/rules.ts';
import {
  levelOf,
  levelStartedAt,
  listingFee,
  nextLevelAt,
  offerLimits,
  recipeMinLevel,
  recipeUnlocked,
  sizeOf,
} from '../sim/rules.ts';
import type { State } from '../sim/state.ts';
import { EMPTY_PLOT, capacityOf, count, stored } from '../sim/state.ts';

export type Stack = { item: number; amount: number };

export type Blocker =
  | 'level'
  | 'cost'
  | 'inputs'
  | 'space'
  | 'slots'
  | 'young'
  | 'offline'
  | null;

export type SlotView = {
  index: number;
  busy: boolean;
  done: boolean;
  progress: number;
  remaining: number;
  producing: string | null;
  output: Stack | null;
  next: RecipeOption | null;
  tap: 'collect' | 'start' | 'none' | 'buy-animal';
  animal: 'none' | 'young' | 'grown' | null;
  grownIn: number;
};

export type PlotView = {
  index: number;
  id: string;
  level: number;
  gx: number;
  gy: number;
  size: { w: number; h: number };
  idle: boolean;
  busy: boolean;
  done: boolean;
  progress: number;
  remaining: number;
  producing: string | null;
  output: Stack | null;
  next: RecipeOption | null;
  options: readonly RecipeOption[];
  slots: readonly SlotView[];
  capacity: number;
  free: number;
  tap: 'collect' | 'start' | 'buy' | 'none';
  blocked: Blocker;
  stall: StallView | null;
  upgrade: {
    label: string;
    cost: readonly Stack[];
    minPlayerLevel: number;
    unlocked: boolean;
    affordable: boolean;
  } | null;
};

export type StallView = {
  cost: number;
  growTicks: number;
  places: number;
  animals: number;
  free: number;
  affordable: boolean;
};

export type RecipeOption = {
  recipe: number;
  id: string;
  inputs: readonly Stack[];
  output: Stack;
  durationTicks: number;
  affordable: boolean;
  unlocked: boolean;
  minPlayerLevel: number;
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
  seller: string;
  hof: string;
  headline: boolean;
};

export type ZeitungView = {
  seller: string;
  hof: string;
  aushang: OfferView;
  offers: readonly OfferView[];
};

export type OrderView = {
  id: number;
  item: number;
  amount: number;
  price: number;
  expiresIn: number | null;
  listedFor: number;
  sold: number;
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
  maxAmount: number;
  feePerUnit: number;
};

export type ObstacleView = {
  index: number;
  kind: string;
  gx: number;
  gy: number;
  w: number;
  h: number;
  tool: number;
  xp: number;
  removable: boolean;
};

export type ChestView = {
  id: number;
  kind: string;
  ready: boolean;
  readyIn: number;
  gx: number;
  gy: number;
};

export type SiloUpgradeView = {
  label: string;
  cost: readonly Stack[];
  capacity: number;
  affordable: boolean;
} | null;

export type SlipView = {
  slot: number;
  id: number;
  dest: string;
  wants: readonly Stack[];
  reward: readonly Stack[];
  xp: number;
  deliverable: boolean;
  missing: readonly Stack[];
};

export type TruckStackView = {
  index: number;
  item: number;
  wanted: number;
  loaded: number;
  missing: number;
  have: number;
  loadable: number;
};

export type TruckView = {
  enabled: boolean;
  here: boolean;
  backIn: number;
  awayTicks: number;
  waybill: {
    id: number;
    stacks: readonly TruckStackView[];
    reward: readonly Stack[];
    xp: number;
    full: boolean;
    progress: number;
  } | null;
  next: { wants: readonly Stack[]; reward: readonly Stack[]; xp: number } | null;
  skippable: boolean;
  board: readonly SlipView[];
  boardOnly: boolean;
};

export type FarmView = {
  level: number;
  xp: { total: number; into: number; span: number; atMax: boolean };
  currency: { item: number; amount: number };
  silo: {
    used: number;
    capacity: number;
    full: boolean;
    free: number;
    level: number;
    upgrade: SiloUpgradeView;
  };
  plots: readonly PlotView[];
  requests: readonly RequestView[];
  offers: readonly OfferView[];
  zeitung: readonly ZeitungView[];
  orders: readonly OrderView[];
  orderSlots: number;
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
  truck: TruckView;
  notkauf: boolean;
  chests: readonly ChestView[];
  openBoxes: number;
  grid: { w: number; h: number } | null;
  buildable: readonly BuildView[];
  obstacles: readonly ObstacleView[];
};

export type BuildView = {
  plot: number;
  id: string;
  label: string;
  cost: readonly Stack[];
  minPlayerLevel: number;
  unlocked: boolean;
  affordable: boolean;
  size: { w: number; h: number };
};

function recipesAt(rules: Ruleset, plot: number, level: number): readonly number[] {
  if (level <= 0) return [];
  return rules.plots[plot]?.levels[level - 1]?.recipes ?? [];
}

function startable(state: State, rules: Ruleset, plot: number): number {
  const playerLevel = levelOf(rules, state.xp);
  for (const index of recipesAt(rules, plot, state.plots[plot]?.level ?? 0)) {
    const recipe = rules.recipes[index];
    if (!recipe) continue;
    if (!recipeUnlocked(rules, index, playerLevel)) continue;
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

  const canRun = recipesAt(rules, i, plot.level).length > 0;
  const nextRecipe = startable(state, rules, i);

  const options: RecipeOption[] = recipesAt(rules, i, plot.level).flatMap((index) => {
    const rdef = rules.recipes[index];
    if (!rdef) return [];
    return [
      {
        recipe: index,
        id: rdef.id,
        inputs: rdef.inputs.map((x) => ({ item: x.item, amount: x.amount })),
        output: { item: rdef.output.item, amount: rdef.output.amount },
        durationTicks: rdef.durationTicks,
        affordable:
          recipeUnlocked(rules, index, playerLevel) &&
          rdef.inputs.every((x) => count(state, x.item) >= x.amount),
        unlocked: recipeUnlocked(rules, index, playerLevel),
        minPlayerLevel: recipeMinLevel(rules, index),
      },
    ];
  });

  const startOption = nextRecipe >= 0 ? options.find((o) => o.recipe === nextRecipe) ?? null : null;

  const tiere = plot.tiere ?? [];
  const tierDef = rules.animalsMustBeBought ? def.animal ?? null : null;
  const stall: StallView | null = tierDef
    ? {
        cost: tierDef.cost,
        growTicks: tierDef.growTicks,
        places: plot.slots.length,
        animals: tiere.length,
        free: plot.slots.length - tiere.length,
        affordable: count(state, rules.currency) >= tierDef.cost,
      }
    : null;

  const slots: SlotView[] = plot.slots.map((slot, j) => {
    const geboren = tiere[j];
    const tier: SlotView['animal'] = !tierDef
      ? null
      : geboren === undefined
        ? 'none'
        : state.tick - geboren >= tierDef.growTicks
          ? 'grown'
          : 'young';
    const grownIn =
      tier === 'young' ? Math.max(0, tierDef!.growTicks - (state.tick - geboren!)) : 0;
    const running = slot.recipe !== EMPTY_PLOT;
    const recipe = running ? rules.recipes[slot.recipe] : undefined;
    const duration = recipe?.durationTicks ?? 0;
    const elapsed = running ? state.tick - slot.startedAt : 0;
    const ready = running && elapsed >= duration;
    return {
      index: j,
      busy: running && !ready,
      done: ready,
      progress: running ? (ready ? 1 : duration > 0 ? Math.min(1, elapsed / duration) : 0) : 0,
      remaining: running && !ready ? Math.max(0, duration - elapsed) : 0,
      producing: recipe ? recipe.id : null,
      output: recipe ? { item: recipe.output.item, amount: recipe.output.amount } : null,
      next: running || tier !== 'grown' ? null : startOption,
      tap: ready
        ? 'collect'
        : running
          ? 'none'
          : tier === 'none'
            ? 'buy-animal'
            : tier === 'young'
              ? 'none'
              : startOption
                ? 'start'
                : 'none',
      animal: tier,
      grownIn,
    };
  });

  const free = slots.filter((s) => !s.busy && !s.done && s.animal !== 'none' && s.animal !== 'young')
    .length;
  const lead =
    slots.find((s) => s.done) ??
    slots
      .filter((s) => s.busy)
      .sort((a, b) => a.remaining - b.remaining)[0] ??
    slots[0] ??
    null;

  const anyDone = slots.some((s) => s.done);
  const running = lead !== null && (lead.busy || lead.done);

  let tap: PlotView['tap'] = 'none';
  let blocked: Blocker = null;

  if (anyDone) {
    tap = 'collect';
  } else if (!canRun) {
    tap = upgrade ? 'buy' : 'none';
    if (upgrade && !upgrade.unlocked) blocked = 'level';
    else if (upgrade && !upgrade.affordable) blocked = 'cost';
  } else if (stall && stall.animals === 0) {
    tap = 'buy-animal';
    if (!stall.affordable) blocked = 'cost';
  } else if (free === 0) {
    blocked = slots.some((s) => s.animal === 'young') ? 'young' : 'slots';
  } else if (nextRecipe < 0) {
    blocked = options.some((o) => o.unlocked) ? 'inputs' : 'level';
  } else {
    tap = 'start';
  }

  return {
    index: i,
    id: def.id,
    level: plot.level,
    gx: plot.gx,
    gy: plot.gy,
    size: sizeOf(rules, i),
    idle: !running && !canRun,
    busy: lead !== null && lead.busy,
    done: anyDone,
    progress: lead?.progress ?? 0,
    remaining: lead?.remaining ?? 0,
    producing: lead?.producing ?? null,
    output: lead?.output ?? null,
    next: free > 0 ? startOption : null,
    options: free > 0 ? options : [],
    slots,
    capacity: slots.length,
    free,
    tap,
    blocked,
    stall,
    upgrade,
  };
}

export function farmView(state: State, rules: Ruleset, online = true): FarmView {
  const used = stored(state, rules);
  const capacity = capacityOf(state, rules);
  const free = capacity - used;
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
      seller: o.seller,
      hof: o.hof,
      headline: o.headline,
    };
  });

  const zeitung: ZeitungView[] = [];
  for (const o of offers) {
    let hof = zeitung.find((z) => z.seller === o.seller);
    if (!hof) {
      hof = { seller: o.seller, hof: o.hof, aushang: o, offers: [] };
      zeitung.push(hof);
    }
    (hof.offers as OfferView[]).push(o);
    if (o.headline) hof.aushang = o;
  }

  const stock: StockView[] = rules.items.map((item, i) => {
    const limits = offerLimits(rules, i);
    return {
      item: i,
      id: item.id,
      amount: count(state, i),
      sellable: item.storable && item.npcPrice > 0,
      npcPrice: item.npcPrice,
      npcBuyPrice: item.npcBuyPrice,
      bandMax: limits.maxPrice,
      bandMin: limits.minPrice,
      maxAmount: limits.maxAmount,
      feePerUnit: listingFee(rules, i, 1),
    };
  });

  return {
    level: levelOf(rules, state.xp),
    xp: {
      total: state.xp,
      into: state.xp - from,
      span: at === null ? 0 : at - from,
      atMax: at === null,
    },
    currency: { item: rules.currency, amount: count(state, rules.currency) },
    silo: {
      used,
      capacity,
      full: free <= 0,
      free,
      level: state.siloLevel,
      upgrade: siloUpgrade(state, rules),
    },
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
    zeitung,
    orders: state.orders.map((o) => ({
      id: o.id,
      item: o.item,
      amount: o.amount,
      price: o.price,
      expiresIn:
        rules.orderTtlTicks > 0 && o.verkauft <= 0
          ? Math.max(0, rules.orderTtlTicks - (state.tick - o.listedAt))
          : null,
      listedFor: Math.max(0, state.tick - o.listedAt),
      sold: o.verkauft,
    })),
    orderSlots: rules.orderSlots,
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
    truck: truckView(state, rules, skipEnabled && skipReady),
    notkauf: rules.emergencyBuyOnly === true,
    grid: rules.grid ? { w: rules.grid.w, h: rules.grid.h } : null,
    buildable: rules.plots.flatMap((def, i): BuildView[] => {
      const plot = state.plots[i]!;
      if (plot.level > 0) return [];
      const stufe = def.levels[0];
      if (!stufe) return [];
      const level = levelOf(rules, state.xp);
      const nötig = stufe.minPlayerLevel ?? 1;
      return [
        {
          plot: i,
          id: def.id,
          label: stufe.label,
          cost: stufe.cost.map((c) => ({ item: c.item, amount: c.amount })),
          minPlayerLevel: nötig,
          unlocked: level >= nötig,
          affordable: level >= nötig && stufe.cost.every((c) => count(state, c.item) >= c.amount),
          size: sizeOf(rules, i),
        },
      ];
    }),
    obstacles: (rules.obstacles ?? []).flatMap((h, i): ObstacleView[] => {
      if (state.clearedObstacles.includes(i)) return [];
      const art = rules.obstacleKinds?.[h.kind];
      return [
        {
          index: i,
          kind: h.kind,
          gx: h.gx,
          gy: h.gy,
          w: h.w,
          h: h.h,
          tool: art?.tool ?? -1,
          xp: art?.xp ?? 0,
          removable: art !== undefined && count(state, art.tool) >= 1,
        },
      ];
    }),
    chests: state.chests.slice(0, 1).map((c) => ({
      id: c.id,
      kind: rules.chestKinds?.[c.kind]?.label ?? '',
      ready: state.tick >= state.chestReadyAt,
      readyIn: Math.max(0, state.chestReadyAt - state.tick),
      gx: c.gx,
      gy: c.gy,
    })),
    openBoxes: state.pendingBoxes.length,
  };
}

function siloUpgrade(state: State, rules: Ruleset): SiloUpgradeView {
  const naechste = rules.siloLevels?.[state.siloLevel + 1];
  if (!naechste) return null;
  return {
    label: naechste.label,
    cost: naechste.cost.map((c) => ({ item: c.item, amount: c.amount })),
    capacity: naechste.capacity,
    affordable: naechste.cost.every((c) => count(state, c.item) >= c.amount),
  };
}

function truckView(state: State, rules: Ruleset, skippable: boolean): TruckView {
  const awayTicks = rules.truckAwayTicks ?? 0;
  const here = state.tick >= state.truck.awayUntil;
  const waybill = state.requests[0];
  const folgt = state.requests[1];

  if (awayTicks <= 0) {
    return {
      enabled: false,
      here: false,
      backIn: 0,
      awayTicks: 0,
      waybill: null,
      next: null,
      skippable: false,
      board: [],
      boardOnly: false,
    };
  }

  const orte = rules.destinations ?? [];
  const board: SlipView[] = state.requests.slice(0, rules.requestSlots).map((r, slot) => ({
    slot,
    id: r.id,
    dest: orte[r.dest] ?? '',
    wants: r.wants.map((w) => ({ item: w.item, amount: w.amount })),
    reward: r.reward.map((x) => ({ item: x.item, amount: x.amount })),
    xp: r.xp,
    deliverable: here && r.wants.every((w) => count(state, w.item) >= w.amount),
    missing: r.wants.flatMap((w) => {
      const fehlt = w.amount - count(state, w.item);
      return fehlt > 0 ? [{ item: w.item, amount: fehlt }] : [];
    }),
  }));

  const stacks: TruckStackView[] = (waybill?.wants ?? []).map((w, i) => {
    const loaded = state.truck.loaded[i] ?? 0;
    const missing = Math.max(0, w.amount - loaded);
    const have = count(state, w.item);
    return {
      index: i,
      item: w.item,
      wanted: w.amount,
      loaded,
      missing,
      have,
      loadable: Math.min(missing, have),
    };
  });

  const verlangt = stacks.reduce((sum, x) => sum + x.wanted, 0);
  const drin = stacks.reduce((sum, x) => sum + Math.min(x.loaded, x.wanted), 0);

  return {
    enabled: true,
    here,
    backIn: here ? 0 : Math.max(0, state.truck.awayUntil - state.tick),
    awayTicks,
    waybill: waybill
      ? {
          id: waybill.id,
          stacks,
          reward: waybill.reward.map((r) => ({ item: r.item, amount: r.amount })),
          xp: waybill.xp,
          full: stacks.every((x) => x.missing === 0),
          progress: verlangt > 0 ? drin / verlangt : 0,
        }
      : null,
    next: folgt
      ? {
          wants: folgt.wants.map((w) => ({ item: w.item, amount: w.amount })),
          reward: folgt.reward.map((r) => ({ item: r.item, amount: r.amount })),
          xp: folgt.xp,
        }
      : null,
    skippable: here && skippable && waybill !== undefined,
    board,
    boardOnly: rules.boardDeliveryOnly === true,
  };
}

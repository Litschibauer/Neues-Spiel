export type ItemStack = {
  item: number;
  amount: number;
};

export type ItemDef = {
  id: string;
  storable: boolean;
  npcPrice: number;
  npcBuyPrice: number;
};

export type RecipeDef = {
  id: string;
  inputs: readonly ItemStack[];
  output: ItemStack;
  durationTicks: number;
  xp: number;
  minPlayerLevel?: number;
};

export type LevelDef = {
  label: string;
  cost: readonly ItemStack[];
  recipes: readonly number[];
  minPlayerLevel?: number;
  slots?: number;
};

export type PlotPlace = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type PlotDef = {
  id: string;
  startLevel: number;
  levels: readonly LevelDef[];
  place?: PlotPlace;
};

export type RequestTemplate = {
  id: string;
  wants: readonly ItemStack[];
  reward: readonly ItemStack[];
  xp: number;
};

export type PassiveDef = {
  id: string;
  recipe: number;
};

export type Ruleset = {
  version: number;
  items: readonly ItemDef[];
  currency: number;
  recipes: readonly RecipeDef[];
  plots: readonly PlotDef[];
  passives: readonly PassiveDef[];
  siloCapacity: number;
  orderSlots: number;
  orderTtlTicks: number;
  listingFeePct: number;
  startingItems: readonly ItemStack[];
  priceBandMinPct: number;
  priceBandMaxPct: number;
  mailCapacity: number;
  offerSlots: number;
  levelThresholds: readonly number[];
  requestTemplates: readonly RequestTemplate[];
  requestSlots: number;
  requestQueueMax: number;
  requestSkipCooldownTicks: number;
};

const GOLD = 0;
const WHEAT = 1;
const FEED = 2;
const EGGS = 3;

const R_WHEAT = 0;
const R_FEED = 1;
const R_EGGS = 2;

const gold = (amount: number): ItemStack[] => [{ item: GOLD, amount }];
const want = (item: number, amount: number): ItemStack => ({ item, amount });
const at = (x: number, y: number, w: number, h: number): PlotPlace => ({ x, y, w, h });

const REQUESTS: readonly RequestTemplate[] = [
  { id: 'wheat-small', wants: [want(WHEAT, 5)], reward: gold(25), xp: 6 },
  { id: 'wheat-big', wants: [want(WHEAT, 15)], reward: gold(80), xp: 18 },
  { id: 'feed-small', wants: [want(FEED, 2)], reward: gold(25), xp: 10 },
  { id: 'feed-big', wants: [want(FEED, 6)], reward: gold(85), xp: 30 },
  { id: 'eggs-small', wants: [want(EGGS, 3)], reward: gold(110), xp: 35 },
  { id: 'eggs-big', wants: [want(EGGS, 9)], reward: gold(350), xp: 100 },
  { id: 'mixed-farm', wants: [want(WHEAT, 8), want(FEED, 2)], reward: gold(60), xp: 22 },
  { id: 'mixed-market', wants: [want(EGGS, 3), want(WHEAT, 10)], reward: gold(160), xp: 50 },
];

const LEVELS: readonly number[] = [40, 120, 280, 560, 1000, 1700, 2800, 4400];

const V1: Ruleset = {
  version: 1,
  items: [
    { id: 'gold', storable: false, npcPrice: 0, npcBuyPrice: 0 },
    { id: 'wheat', storable: true, npcPrice: 3, npcBuyPrice: 5 },
    { id: 'feed', storable: true, npcPrice: 8, npcBuyPrice: 0 },
    { id: 'eggs', storable: true, npcPrice: 25, npcBuyPrice: 0 },
  ],
  currency: GOLD,
  recipes: [
    {
      id: 'wheat',
      inputs: [{ item: WHEAT, amount: 1 }],
      output: { item: WHEAT, amount: 2 },
      durationTicks: 120,
      xp: 2,
    },
    {
      id: 'feed',
      inputs: [{ item: WHEAT, amount: 3 }],
      output: { item: FEED, amount: 2 },
      durationTicks: 300,
      xp: 5,
    },
    {
      id: 'eggs',
      inputs: [{ item: FEED, amount: 1 }],
      output: { item: EGGS, amount: 3 },
      durationTicks: 900,
      xp: 14,
    },
  ],
  plots: [
    {
      id: 'field-1',
      startLevel: 1,
      place: at(3, 53, 30, 20),
      levels: [{ label: 'Feld', cost: [], recipes: [R_WHEAT] }],
    },
    {
      id: 'field-2',
      startLevel: 1,
      place: at(35, 53, 30, 20),
      levels: [{ label: 'Feld', cost: [], recipes: [R_WHEAT] }],
    },
    {
      id: 'field-3',
      startLevel: 1,
      place: at(67, 53, 30, 20),
      levels: [{ label: 'Feld', cost: [], recipes: [R_WHEAT] }],
    },
    {
      id: 'field-4',
      startLevel: 0,
      place: at(3, 76, 30, 20),
      levels: [{ label: 'Feld', cost: gold(100), recipes: [R_WHEAT], minPlayerLevel: 2 }],
    },
    {
      id: 'field-5',
      startLevel: 0,
      place: at(35, 76, 30, 20),
      levels: [{ label: 'Feld', cost: gold(250), recipes: [R_WHEAT], minPlayerLevel: 4 }],
    },
    {
      id: 'field-6',
      startLevel: 0,
      place: at(67, 76, 30, 20),
      levels: [{ label: 'Feld', cost: gold(500), recipes: [R_WHEAT], minPlayerLevel: 6 }],
    },
    {
      id: 'mill',
      startLevel: 0,
      place: at(4, 9, 26, 17),
      levels: [{ label: 'Mühle', cost: gold(150), recipes: [R_FEED], minPlayerLevel: 2 }],
    },
    {
      id: 'coop-1',
      startLevel: 0,
      place: at(47, 30, 26, 18),
      levels: [
        { label: 'Gehege', cost: gold(300), recipes: [], minPlayerLevel: 3 },
        { label: 'Hühner', cost: gold(200), recipes: [R_EGGS] },
      ],
    },
    {
      id: 'coop-2',
      startLevel: 0,
      place: at(70, 10, 26, 16),
      levels: [
        { label: 'Gehege', cost: gold(800), recipes: [], minPlayerLevel: 5 },
        { label: 'Hühner', cost: gold(400), recipes: [R_EGGS] },
      ],
    },
  ],
  passives: [],
  siloCapacity: 100,
  orderSlots: 4,
  orderTtlTicks: 0,
  listingFeePct: 5,
  startingItems: [{ item: WHEAT, amount: 6 }],
  priceBandMinPct: 25,
  priceBandMaxPct: 150,
  mailCapacity: 20,
  offerSlots: 12,
  levelThresholds: LEVELS,
  requestTemplates: REQUESTS,
  requestSlots: 3,
  requestQueueMax: 20,
  requestSkipCooldownTicks: 1800,
};

const V2: Ruleset = {
  ...V1,
  version: 2,
  items: [
    { id: 'gold', storable: false, npcPrice: 0, npcBuyPrice: 0 },
    { id: 'wheat', storable: true, npcPrice: 4, npcBuyPrice: 6 },
    { id: 'feed', storable: true, npcPrice: 9, npcBuyPrice: 0 },
    { id: 'eggs', storable: true, npcPrice: 28, npcBuyPrice: 0 },
  ],
  recipes: [
    {
      id: 'wheat',
      inputs: [{ item: WHEAT, amount: 1 }],
      output: { item: WHEAT, amount: 2 },
      durationTicks: 100,
      xp: 2,
    },
    {
      id: 'feed',
      inputs: [{ item: WHEAT, amount: 3 }],
      output: { item: FEED, amount: 2 },
      durationTicks: 240,
      xp: 5,
    },
    {
      id: 'eggs',
      inputs: [{ item: FEED, amount: 1 }],
      output: { item: EGGS, amount: 3 },
      durationTicks: 720,
      xp: 14,
    },
  ],
  siloCapacity: 120,
  orderSlots: 6,
};

const CORN = 4;
const MILK = 5;
const CREAM = 6;
const BUTTER = 7;

const R_CORN = 3;
const R_MILK = 4;
const R_CREAM = 5;
const R_BUTTER = 6;

const V3: Ruleset = {
  ...V2,
  version: 3,
  items: [
    { id: 'gold', storable: false, npcPrice: 0, npcBuyPrice: 0 },
    { id: 'wheat', storable: true, npcPrice: 4, npcBuyPrice: 6 },
    { id: 'feed', storable: true, npcPrice: 9, npcBuyPrice: 0 },
    { id: 'eggs', storable: true, npcPrice: 28, npcBuyPrice: 0 },
    { id: 'corn', storable: true, npcPrice: 7, npcBuyPrice: 10 },
    { id: 'milk', storable: true, npcPrice: 30, npcBuyPrice: 0 },
    { id: 'cream', storable: true, npcPrice: 85, npcBuyPrice: 0 },
    { id: 'butter', storable: true, npcPrice: 260, npcBuyPrice: 0 },
  ],
  recipes: [
    {
      id: 'wheat',
      inputs: [{ item: WHEAT, amount: 1 }],
      output: { item: WHEAT, amount: 2 },
      durationTicks: 100,
      xp: 2,
    },
    {
      id: 'feed',
      inputs: [
        { item: CORN, amount: 1 },
        { item: WHEAT, amount: 1 },
      ],
      output: { item: FEED, amount: 2 },
      durationTicks: 240,
      xp: 5,
    },
    {
      id: 'eggs',
      inputs: [{ item: FEED, amount: 1 }],
      output: { item: EGGS, amount: 3 },
      durationTicks: 720,
      xp: 14,
    },
    {
      id: 'corn',
      inputs: [{ item: CORN, amount: 1 }],
      output: { item: CORN, amount: 2 },
      durationTicks: 260,
      xp: 5,
    },
    {
      id: 'milk',
      inputs: [{ item: FEED, amount: 1 }],
      output: { item: MILK, amount: 2 },
      durationTicks: 900,
      xp: 16,
    },
    {
      id: 'cream',
      inputs: [{ item: MILK, amount: 1 }],
      output: { item: CREAM, amount: 1 },
      durationTicks: 600,
      xp: 20,
    },
    {
      id: 'butter',
      inputs: [{ item: MILK, amount: 2 }],
      output: { item: BUTTER, amount: 1 },
      durationTicks: 1500,
      xp: 45,
    },
  ],
  plots: [
    {
      id: 'field-1',
      startLevel: 1,
      place: at(3, 53, 30, 20),
      levels: [{ label: 'Feld', cost: [], recipes: [R_WHEAT, R_CORN] }],
    },
    {
      id: 'field-2',
      startLevel: 1,
      place: at(35, 53, 30, 20),
      levels: [{ label: 'Feld', cost: [], recipes: [R_WHEAT, R_CORN] }],
    },
    {
      id: 'field-3',
      startLevel: 1,
      place: at(67, 53, 30, 20),
      levels: [{ label: 'Feld', cost: [], recipes: [R_WHEAT, R_CORN] }],
    },
    {
      id: 'field-4',
      startLevel: 0,
      place: at(3, 76, 30, 20),
      levels: [{ label: 'Feld', cost: gold(100), recipes: [R_WHEAT, R_CORN], minPlayerLevel: 2 }],
    },
    {
      id: 'field-5',
      startLevel: 0,
      place: at(35, 76, 30, 20),
      levels: [{ label: 'Feld', cost: gold(250), recipes: [R_WHEAT, R_CORN], minPlayerLevel: 4 }],
    },
    {
      id: 'field-6',
      startLevel: 0,
      place: at(67, 76, 30, 20),
      levels: [{ label: 'Feld', cost: gold(500), recipes: [R_WHEAT, R_CORN], minPlayerLevel: 6 }],
    },
    {
      id: 'mill',
      startLevel: 0,
      place: at(4, 9, 26, 17),
      levels: [{ label: 'Mühle', cost: gold(150), recipes: [R_FEED], minPlayerLevel: 2 }],
    },
    {
      id: 'coop-1',
      startLevel: 0,
      place: at(47, 30, 26, 18),
      levels: [
        { label: 'Gehege', cost: gold(300), recipes: [], minPlayerLevel: 3 },
        { label: 'Hühner', cost: gold(200), recipes: [R_EGGS] },
      ],
    },
    {
      id: 'coop-2',
      startLevel: 0,
      place: at(70, 10, 26, 16),
      levels: [
        { label: 'Gehege', cost: gold(800), recipes: [], minPlayerLevel: 5 },
        { label: 'Hühner', cost: gold(400), recipes: [R_EGGS] },
      ],
    },
    {
      id: 'pasture-1',
      startLevel: 0,
      place: at(3, 29, 38, 20),
      levels: [
        { label: 'Kuhgehege', cost: gold(1200), recipes: [], minPlayerLevel: 6 },
        { label: 'Kühe', cost: gold(900), recipes: [R_MILK] },
      ],
    },
    {
      id: 'dairy',
      startLevel: 0,
      place: at(36, 8, 30, 18),
      levels: [{ label: 'Molkerei', cost: gold(2000), recipes: [R_CREAM, R_BUTTER], minPlayerLevel: 7 }],
    },
  ],
  requestTemplates: [
    { id: 'wheat-small', wants: [want(WHEAT, 5)], reward: gold(25), xp: 6 },
    { id: 'wheat-big', wants: [want(WHEAT, 15)], reward: gold(80), xp: 18 },
    { id: 'corn-small', wants: [want(CORN, 4)], reward: gold(42), xp: 12 },
    { id: 'corn-big', wants: [want(CORN, 12)], reward: gold(135), xp: 36 },
    { id: 'feed-small', wants: [want(FEED, 2)], reward: gold(28), xp: 10 },
    { id: 'feed-big', wants: [want(FEED, 6)], reward: gold(90), xp: 30 },
    { id: 'eggs-small', wants: [want(EGGS, 3)], reward: gold(125), xp: 35 },
    { id: 'eggs-big', wants: [want(EGGS, 9)], reward: gold(390), xp: 100 },
    { id: 'milk-small', wants: [want(MILK, 2)], reward: gold(90), xp: 26 },
    { id: 'milk-big', wants: [want(MILK, 6)], reward: gold(270), xp: 78 },
    { id: 'cream-order', wants: [want(CREAM, 2)], reward: gold(255), xp: 60 },
    { id: 'butter-order', wants: [want(BUTTER, 1)], reward: gold(390), xp: 85 },
    { id: 'mixed-farm', wants: [want(WHEAT, 8), want(CORN, 4)], reward: gold(95), xp: 28 },
    { id: 'mixed-market', wants: [want(EGGS, 3), want(MILK, 2)], reward: gold(216), xp: 65 },
    { id: 'mixed-dairy', wants: [want(CREAM, 1), want(BUTTER, 1)], reward: gold(520), xp: 130 },
  ],
  startingItems: [
    { item: WHEAT, amount: 6 },
    { item: CORN, amount: 3 },
  ],
  siloCapacity: 150,
};

const CHEESE = 8;
const R_CHEESE = 7;

const LEVELS_V4: readonly number[] = [40, 120, 280, 560, 1000, 1700, 2800, 4400, 6800, 10000, 14500];

const V4: Ruleset = {
  ...V3,
  version: 4,
  levelThresholds: LEVELS_V4,

  items: [
    ...V3.items,
    { id: 'cheese', storable: true, npcPrice: 420, npcBuyPrice: 0 },
  ],

  recipes: [
    ...V3.recipes.slice(0, 5),
    { ...V3.recipes[5]!, minPlayerLevel: 6 },
    { ...V3.recipes[6]!, minPlayerLevel: 8 },
    {
      id: 'cheese',
      inputs: [{ item: MILK, amount: 3 }],
      output: { item: CHEESE, amount: 1 },
      durationTicks: 1800,
      xp: 70,
      minPlayerLevel: 10,
    },
  ],

  plots: V3.plots.map((p) => {
    if (p.id === 'dairy') {
      return {
        ...p,
        levels: [
          {
            label: 'Molkerei',
            cost: gold(2000),
            recipes: [R_CREAM, R_BUTTER, R_CHEESE],
            minPlayerLevel: 6,
          },
        ],
      };
    }
    return p;
  }),

  requestTemplates: [
    ...V3.requestTemplates,
    { id: 'cheese-order', wants: [want(CHEESE, 1)], reward: gold(630), xp: 110 },
    { id: 'cheese-big', wants: [want(CHEESE, 3)], reward: gold(1890), xp: 330 },
    { id: 'mixed-cheese', wants: [want(CHEESE, 1), want(BUTTER, 1)], reward: gold(1020), xp: 190 },
  ],

  siloCapacity: 180,
};

const COW_FEED = 9;
const R_COW_FEED = 8;

const CHICKEN = gold(250);
const COW = gold(900);

const V5: Ruleset = {
  ...V4,
  version: 5,

  items: [
    ...V4.items.slice(0, 2),
    { id: 'feed', storable: true, npcPrice: 9, npcBuyPrice: 0 },
    ...V4.items.slice(3),
    { id: 'cow-feed', storable: true, npcPrice: 12, npcBuyPrice: 0 },
  ],

  recipes: [
    V4.recipes[0]!,
    {
      id: 'feed',
      inputs: [{ item: WHEAT, amount: 3 }],
      output: { item: FEED, amount: 2 },
      durationTicks: 200,
      xp: 5,
    },
    ...V4.recipes.slice(2, 4),
    {
      ...V4.recipes[4]!,
      inputs: [{ item: COW_FEED, amount: 1 }],
    },
    ...V4.recipes.slice(5),
    {
      id: 'cow-feed',
      inputs: [
        { item: CORN, amount: 1 },
        { item: WHEAT, amount: 2 },
      ],
      output: { item: COW_FEED, amount: 2 },
      durationTicks: 300,
      xp: 7,
      minPlayerLevel: 6,
    },
  ],

  plots: V4.plots.map((p) => {
    if (p.id === 'mill') {
      return {
        ...p,
        levels: [
          {
            label: 'Mühle',
            cost: gold(150),
            recipes: [R_FEED, R_COW_FEED],
            minPlayerLevel: 2,
          },
        ],
      };
    }
    if (p.id === 'coop-1') {
      return {
        ...p,
        levels: [
          { label: 'Hühnerstall', cost: gold(550), recipes: [R_EGGS], minPlayerLevel: 3, slots: 1 },
          { label: 'Zweites Huhn', cost: CHICKEN, recipes: [R_EGGS], slots: 2 },
          { label: 'Drittes Huhn', cost: CHICKEN, recipes: [R_EGGS], slots: 3 },
        ],
      };
    }
    if (p.id === 'coop-2') {
      return {
        ...p,
        levels: [
          { label: 'Hühnerstall', cost: gold(1050), recipes: [R_EGGS], minPlayerLevel: 5, slots: 1 },
          { label: 'Zweites Huhn', cost: CHICKEN, recipes: [R_EGGS], slots: 2 },
          { label: 'Drittes Huhn', cost: CHICKEN, recipes: [R_EGGS], slots: 3 },
        ],
      };
    }
    if (p.id === 'pasture-1') {
      return {
        ...p,
        levels: [
          { label: 'Kuhweide', cost: gold(2100), recipes: [R_MILK], minPlayerLevel: 6, slots: 1 },
          { label: 'Zweite Kuh', cost: COW, recipes: [R_MILK], slots: 2 },
          { label: 'Dritte Kuh', cost: COW, recipes: [R_MILK], slots: 3 },
        ],
      };
    }
    return p;
  }),

  requestTemplates: [
    ...V4.requestTemplates,
    { id: 'cow-feed-small', wants: [want(COW_FEED, 2)], reward: gold(38), xp: 12 },
    { id: 'cow-feed-big', wants: [want(COW_FEED, 6)], reward: gold(120), xp: 38 },
  ],

  siloCapacity: 200,
};

const V6: Ruleset = {
  ...V5,
  version: 6,

  recipes: V5.recipes.map((r) => {
    const faster: Record<string, number> = {
      wheat: 30,
      corn: 90,
      feed: 60,
      'cow-feed': 90,
      eggs: 240,
      milk: 300,
      cream: 180,
      butter: 480,
      cheese: 600,
    };
    const t = faster[r.id];
    return t === undefined ? r : { ...r, durationTicks: t };
  }),

  requestSkipCooldownTicks: 600,
};

const DEV: Ruleset = {
  ...V6,
  version: 1001,
  requestSkipCooldownTicks: 180,
  recipes: V6.recipes.map((r) => {
    const tenth = Math.floor(r.durationTicks / 10);
    return { ...r, durationTicks: tenth < 1 ? 1 : tenth };
  }),
};

export const RULESETS: ReadonlyMap<number, Ruleset> = new Map([
  [1, V1],
  [2, V2],
  [3, V3],
  [4, V4],
  [5, V5],
  [6, V6],
  [1001, DEV],
]);

export const PRODUCTION_VERSIONS: readonly number[] = [1, 2, 3, 4, 5, 6];

export const CURRENT_RULESET_VERSION = 1;

export const LATEST_RULESET_VERSION = 6;

export const DEV_RULESET_VERSION = 1001;

export function getRuleset(version: number): Ruleset {
  const r = RULESETS.get(version);
  if (!r) throw new Error(`unsupported ruleset version: ${version}`);
  return r;
}

export function levelRecipes(rules: Ruleset, plot: number, level: number): readonly number[] {
  if (level <= 0) return [];
  return rules.plots[plot]?.levels[level - 1]?.recipes ?? [];
}

export function slotsAt(rules: Ruleset, plot: number, level: number): number {
  if (level <= 0) return 0;
  const def = rules.plots[plot]?.levels[level - 1];
  if (!def) return 0;
  return def.slots ?? (def.recipes.length > 0 ? 1 : 0);
}

export function recipeMinLevel(rules: Ruleset, recipe: number): number {
  return rules.recipes[recipe]?.minPlayerLevel ?? 1;
}

export function recipeUnlocked(rules: Ruleset, recipe: number, playerLevel: number): boolean {
  return playerLevel >= recipeMinLevel(rules, recipe);
}

export function levelOf(rules: Ruleset, xp: number): number {
  let level = 1;
  for (const threshold of rules.levelThresholds) {
    if (xp < threshold) break;
    level++;
  }
  return level;
}

export function nextLevelAt(rules: Ruleset, xp: number): number | null {
  for (const threshold of rules.levelThresholds) {
    if (xp < threshold) return threshold;
  }
  return null;
}

export function levelStartedAt(rules: Ruleset, xp: number): number {
  let start = 0;
  for (const threshold of rules.levelThresholds) {
    if (xp < threshold) break;
    start = threshold;
  }
  return start;
}

export function nextLevel(rules: Ruleset, plot: number, level: number): LevelDef | null {
  return rules.plots[plot]?.levels[level] ?? null;
}

export type DerivedTables = {
  storable: number[];
  passiveIntervals: number[];
  passiveOutputs: number[];
};

const derived = new Map<Ruleset, DerivedTables>();

export function derivedTables(rules: Ruleset): DerivedTables {
  const cached = derived.get(rules);
  if (cached) return cached;

  const storable: number[] = [];
  for (let i = 0; i < rules.items.length; i++) {
    if (rules.items[i]!.storable) storable.push(i);
  }

  const passiveIntervals: number[] = [];
  const passiveOutputs: number[] = [];
  for (const passive of rules.passives) {
    const recipe = rules.recipes[passive.recipe]!;
    passiveIntervals.push(recipe.durationTicks);
    passiveOutputs.push(recipe.output.item);
  }

  const tables = { storable, passiveIntervals, passiveOutputs };
  derived.set(rules, tables);
  return tables;
}

export function passiveInterval(rules: Ruleset, passive: number): number {
  return rules.recipes[rules.passives[passive]!.recipe]!.durationTicks;
}

export function isTradable(rules: Ruleset, item: number): boolean {
  const def = rules.items[item];
  return def !== undefined && def.storable && def.npcPrice > 0;
}

export function priceBand(rules: Ruleset, item: number): { min: number; max: number } {
  const def = rules.items[item];
  if (!def) return { min: 1, max: 1 };
  const min = Math.max(1, Math.floor((def.npcPrice * rules.priceBandMinPct) / 100));
  const max = Math.max(min, Math.floor((def.npcPrice * rules.priceBandMaxPct) / 100));
  return { min, max };
}

export function listingFee(rules: Ruleset, item: number, amount: number): number {
  const def = rules.items[item];
  if (!def) return 0;
  return Math.floor((def.npcPrice * amount * rules.listingFeePct + 99) / 100);
}

export function validateRuleset(rules: Ruleset): string[] {
  const problems: string[] = [];
  const itemOk = (i: number) => Number.isInteger(i) && i >= 0 && i < rules.items.length;

  if (!itemOk(rules.currency)) problems.push(`Währung ${rules.currency} steht nicht im Katalog`);
  else if (rules.items[rules.currency]!.storable) {
    problems.push('Währung darf nicht lagerpflichtig sein');
  }

  for (const [i, item] of rules.items.entries()) {
    if (item.npcPrice < 0 || !Number.isInteger(item.npcPrice)) {
      problems.push(`Gegenstand ${i} (${item.id}): ungültiger Preis ${item.npcPrice}`);
    }
  }

  for (const [i, r] of rules.recipes.entries()) {
    if (!Number.isInteger(r.durationTicks) || r.durationTicks < 1) {
      problems.push(`Rezept ${i} (${r.id}): Dauer ${r.durationTicks} < 1`);
    }
    if (!Number.isInteger(r.xp) || r.xp < 0) problems.push(`Rezept ${i} (${r.id}): XP ungültig`);
    if (!itemOk(r.output.item)) problems.push(`Rezept ${i} (${r.id}): Ausgabe unbekannt`);
    if (!Number.isInteger(r.output.amount) || r.output.amount < 1) {
      problems.push(`Rezept ${i} (${r.id}): Ausgabemenge ${r.output.amount} < 1`);
    }
    const seen = new Set<number>();
    for (const input of r.inputs) {
      if (!itemOk(input.item)) problems.push(`Rezept ${i} (${r.id}): Eingabe unbekannt`);
      if (!Number.isInteger(input.amount) || input.amount < 1) {
        problems.push(`Rezept ${i} (${r.id}): Eingabemenge ${input.amount} < 1`);
      }

      if (seen.has(input.item)) problems.push(`Rezept ${i} (${r.id}): Zutat doppelt`);
      seen.add(input.item);
    }
  }

  for (const [i, p] of rules.plots.entries()) {
    if (p.levels.length === 0) problems.push(`Platz ${i} (${p.id}): keine Stufen`);
    if (!Number.isInteger(p.startLevel) || p.startLevel < 0 || p.startLevel > p.levels.length) {
      problems.push(`Platz ${i} (${p.id}): Startstufe ${p.startLevel} außerhalb der Stufen`);
    }
    for (const [l, level] of p.levels.entries()) {
      for (const r of level.recipes) {
        if (!Number.isInteger(r) || r < 0 || r >= rules.recipes.length) {
          problems.push(`Platz ${i} (${p.id}) Stufe ${l + 1}: Rezept ${r} gibt es nicht`);
        }
      }
      for (const c of level.cost) {
        if (!itemOk(c.item)) problems.push(`Platz ${i} (${p.id}) Stufe ${l + 1}: Preis unbekannt`);
        if (!Number.isInteger(c.amount) || c.amount < 1) {
          problems.push(`Platz ${i} (${p.id}) Stufe ${l + 1}: Preis ${c.amount} < 1`);
        }
      }

      if (l < p.startLevel && level.cost.length > 0) {
        problems.push(`Platz ${i} (${p.id}) Stufe ${l + 1}: Startstufe mit Preis`);
      }
      if (l < p.startLevel && level.minPlayerLevel !== undefined) {
        problems.push(`Platz ${i} (${p.id}) Stufe ${l + 1}: Startstufe mit Levelsperre`);
      }
      if (
        level.minPlayerLevel !== undefined &&
        (!Number.isInteger(level.minPlayerLevel) || level.minPlayerLevel < 1)
      ) {
        problems.push(`Platz ${i} (${p.id}) Stufe ${l + 1}: Levelsperre < 1`);
      }
      if ((level.minPlayerLevel ?? 1) > rules.levelThresholds.length + 1) {
        problems.push(
          `Platz ${i} (${p.id}) Stufe ${l + 1}: Levelsperre über dem Maximum — nie erreichbar`,
        );
      }
    }
  }

  const placed = rules.plots.filter((p) => p.place);
  if (placed.length > 0 && placed.length < rules.plots.length) {
    const ohne = rules.plots.filter((p) => !p.place).map((p) => p.id);
    problems.push(`Plätze ohne Ort, während andere einen haben: ${ohne.join(', ')}`);
  }
  for (const [i, p] of rules.plots.entries()) {
    const place = p.place;
    if (!place) continue;
    const numbers = [place.x, place.y, place.w, place.h];
    if (numbers.some((n) => !Number.isInteger(n))) {
      problems.push(`Platz ${i} (${p.id}): Ort ist nicht in ganzen Prozent angegeben`);
      continue;
    }
    if (place.w < 1 || place.h < 1) {
      problems.push(`Platz ${i} (${p.id}): Ort ohne Fläche`);
    }
    if (place.x < 0 || place.y < 0 || place.x + place.w > 100 || place.y + place.h > 100) {
      problems.push(`Platz ${i} (${p.id}): Ort liegt außerhalb des Hofs`);
    }
  }
  for (let i = 0; i < rules.plots.length; i++) {
    for (let j = i + 1; j < rules.plots.length; j++) {
      const a = rules.plots[i]!.place;
      const b = rules.plots[j]!.place;
      if (!a || !b) continue;
      const apart =
        a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      if (!apart) {
        problems.push(
          `Platz ${rules.plots[i]!.id} und ${rules.plots[j]!.id} stehen übereinander`,
        );
      }
    }
  }

  for (const [i, p] of rules.passives.entries()) {
    if (!Number.isInteger(p.recipe) || p.recipe < 0 || p.recipe >= rules.recipes.length) {
      problems.push(`Passive ${i} (${p.id}): Rezept ${p.recipe} gibt es nicht`);
      continue;
    }
    const recipe = rules.recipes[p.recipe]!;

    if (recipe.inputs.length > 0) problems.push(`Passive ${i} (${p.id}): Rezept braucht Eingaben`);
    if (recipe.output.amount !== 1) problems.push(`Passive ${i} (${p.id}): Ausgabemenge != 1`);
    if (!rules.items[recipe.output.item]?.storable) {
      problems.push(`Passive ${i} (${p.id}): Ausgabe ist nicht lagerpflichtig`);
    }
  }

  let previous = 0;
  for (const [i, threshold] of rules.levelThresholds.entries()) {
    if (!Number.isInteger(threshold) || threshold <= previous) {
      problems.push(`Levelschwelle ${i}: ${threshold} nicht größer als ${previous}`);
    }
    previous = threshold;
  }

  for (const [i, t] of rules.requestTemplates.entries()) {
    if (!Number.isInteger(t.xp) || t.xp < 0) problems.push(`Auftrag ${i} (${t.id}): XP ungültig`);
    if (t.wants.length === 0) problems.push(`Auftrag ${i} (${t.id}): verlangt nichts`);
    if (t.reward.length === 0) problems.push(`Auftrag ${i} (${t.id}): gibt nichts`);
    for (const stack of [...t.wants, ...t.reward]) {
      if (!itemOk(stack.item)) problems.push(`Auftrag ${i} (${t.id}): Gegenstand unbekannt`);
      if (!Number.isInteger(stack.amount) || stack.amount < 1) {
        problems.push(`Auftrag ${i} (${t.id}): Menge ${stack.amount} < 1`);
      }
    }

    const seen = new Set<number>();
    for (const stack of t.wants) {
      if (seen.has(stack.item)) problems.push(`Auftrag ${i} (${t.id}): Posten doppelt`);
      seen.add(stack.item);
    }
  }
  rules.plots.forEach((plot, i) => {
    plot.levels.forEach((level, li) => {
      if (level.recipes.length === 0) return;
      const openAt = level.minPlayerLevel ?? 1;
      const usable = level.recipes.some((r) => recipeMinLevel(rules, r) <= openAt);
      if (!usable) {
        problems.push(
          `Platz ${plot.id} Stufe ${li + 1} ist ab Stufe ${openAt} kaufbar, ` +
            `aber kein Rezept darauf ist vor Stufe ` +
            `${Math.min(...level.recipes.map((r) => recipeMinLevel(rules, r)))} erlaubt`,
        );
      }
    });
  });
  rules.recipes.forEach((r, i) => {
    const max = rules.levelThresholds.length + 1;
    if ((r.minPlayerLevel ?? 1) > max) {
      problems.push(`Rezept ${r.id} verlangt Stufe ${r.minPlayerLevel}, es gibt nur ${max}`);
    }
  });
  if (rules.requestSlots < 1) problems.push('Auftrags-Slots < 1');
  if (rules.requestSkipCooldownTicks < 0) {
    problems.push(`Überspring-Wartezeit negativ: ${rules.requestSkipCooldownTicks}`);
  }
  if (rules.requestQueueMax < rules.requestSlots) {
    problems.push('Auftragsvorrat kleiner als die Zahl der Slots');
  }

  if (rules.siloCapacity < 1) problems.push('Lagerkapazität < 1');
  if (rules.mailCapacity < 1) problems.push('Postfachkapazität < 1');
  if (rules.priceBandMinPct > rules.priceBandMaxPct) problems.push('Preisband verkehrt herum');
  if (rules.offerSlots < 0) problems.push('Angebots-Slots negativ');
  if (rules.listingFeePct < 0 || rules.listingFeePct > 100) {
    problems.push(`Einstellgebühr außerhalb 0…100: ${rules.listingFeePct}`);
  }
  rules.items.forEach((item, i) => {
    if (item.npcBuyPrice > 0 && item.npcBuyPrice <= item.npcPrice) {
      problems.push(
        `Gegenstand ${i} (${item.id}): Ankauf ${item.npcBuyPrice} <= Verkauf ${item.npcPrice} — Geldpresse`,
      );
    }
  });

  return problems;
}

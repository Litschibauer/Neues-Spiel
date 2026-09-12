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
  extra?: readonly ItemStack[];
  durationTicks: number;
  xp: number;
  minPlayerLevel?: number;
};

export function recipeOutputs(recipe: RecipeDef): readonly ItemStack[] {
  return recipe.extra && recipe.extra.length > 0 ? [recipe.output, ...recipe.extra] : [recipe.output];
}

export type LevelDef = {
  label: string;
  cost: readonly ItemStack[];
  recipes: readonly number[];
  minPlayerLevel?: number;
  slots?: number;
};

export type SiloLevel = {
  label: string;
  cost: readonly ItemStack[];
  capacity: number;
};

export type ChestDrop = {
  item: number;
  min: number;
  max: number;
  weight: number;
};

export type ChestKind = {
  id: string;
  label: string;
  picks: number;
  drops: readonly ChestDrop[];
};

export type PlotPlace = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type PlotSize = {
  w: number;
  h: number;
};

export type AnimalDef = {
  cost: number;
  growTicks: number;
};

// Apfelbaum: nach dem Pflanzen wächst der Setzling `setzlingTicks` lang, dann
// tragen die Äpfel je `reifeTicks` nach. Nach `ernten` Ernten verwelkt der
// Baum und muss mit dem Werkzeug `faellenWerkzeug` gefällt werden.
export type BaumDef = {
  setzlingTicks: number;
  reifeTicks: number;
  ernten: number;
  ertrag: ItemStack;
  xp: number;
  faellenWerkzeug: number;
  faellenXp: number;
};

export type PlotDef = {
  id: string;
  startLevel: number;
  levels: readonly LevelDef[];
  place?: PlotPlace;
  // Direkter Startplatz in Gitterzellen. Hat Vorrang vor `place` (Prozent), das
  // bei Rasterbreiten über 100 Spalten nicht mehr jede Zelle treffen kann.
  startCell?: { gx: number; gy: number };
  size?: PlotSize;
  fixed?: boolean;
  flat?: boolean;
  animal?: AnimalDef;
  baum?: BaumDef;
  // Reine Deko: kaufbar, platzierbar, abreißbar — ohne Funktion.
  deco?: boolean;
  // Nur über ein Fest zu bekommen: nicht kaufbar, im Baumenü erst sichtbar,
  // wenn sie eingepackt im Besitz ist.
  nurFest?: boolean;
};

export type BaumStufe = 'setzling' | 'wachsen' | 'reif' | 'verwelkt';

// Reiner Zustandsübergang eines Apfelbaums — nur ganzzahlige Tick-Arithmetik,
// damit der Sim-Kern deterministisch bleibt. `reifSeit`/`geerntet` stehen im
// Platz-Zustand, `def` liefert die Zeiten.
export function baumStufe(def: BaumDef, reifSeit: number, geerntet: number, tick: number): BaumStufe {
  if (geerntet >= def.ernten) return 'verwelkt';
  if (geerntet === 0 && tick < reifSeit) return 'setzling';
  if (tick - reifSeit >= def.reifeTicks) return 'reif';
  return 'wachsen';
}

export type GridDef = {
  w: number;
  h: number;
};

export type Obstacle = {
  kind: 'tree' | 'rock' | 'pond';
  gx: number;
  gy: number;
  w: number;
  h: number;
};

export type Expansion = {
  id: string;
  gx: number;
  gy: number;
  w: number;
  h: number;
  minLevel: number;
  cost: readonly ItemStack[];
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

// Erfolg: erreichbar über eine einfache, datengetriebene Bedingung; gibt beim
// Einlösen einmalig Gold + XP.
export type AchievementKind =
  | 'level'
  | 'gold'
  | 'plot'
  | 'plotPrefix'
  | 'expand'
  | 'plots' // so viele Bauwerke stehen
  | 'deko' // so viele Dekorationen stehen
  | 'obstacles' // so viele Hindernisse geräumt
  | 'silo' // Lager so oft ausgebaut
  | 'fish' // so viele Fänge aus dem See
  | 'boat' // Boot repariert
  | 'item' // so viel von einer Ware im Lager
  | 'sterne' // so viele Meistersterne über alle Gebäude
  | 'meister' // so viele Gebäude mit allen Sternen
  | 'feste' // so viele Feste abgeschlossen
  | 'zaehler' // Lebenszeit-Zähler (arg = Index in ZAEHLER) hat `menge` erreicht
  | 'tiere' // so viele Tiere in Ställen und auf Weiden
  | 'plotPrefixCount' // so viele Bauwerke mit diesem Namensanfang stehen
  | 'tage' // so viele Tagesabschlüsse
  | 'wochen'; // so viele Wochenabschlüsse

// Erfolge sind in Gruppen einsortiert; die Oberfläche zeigt sie darunter.
export type AchievementGroup = 'hof' | 'wohlstand' | 'land' | 'see' | 'vorrat' | 'meister' | 'fleiss' | 'handel' | 'treue';

export type AchievementDef = {
  id: string;
  label: string;
  kind: AchievementKind;
  arg: number | string;
  gold: number;
  xp: number;
  group?: AchievementGroup;
  // Reihe: Erfolge derselben Reihe (Stufe 3, 5, 8 …) zeigt die Oberfläche
  // nacheinander — immer nur den nächsten, den man noch nicht hat.
  reihe?: string;
  // Bei kind 'item': wie viel von der Ware (arg = Waren-Kennung).
  menge?: number;
};

// Eine Tagesaufgabe misst einen der Lebenszeit-Zähler gegen den Stand vom
// Tagesbeginn. `art` ist ein Index aus ZAEHLER (state.ts).
export type AufgabeDef = {
  id: string;
  label: string;
  art: number;
  menge: number;
  gold: number;
  xp: number;
  // Ziehungsgewicht: schwerere Aufgaben kommen seltener.
  gewicht: number;
  // Erst ab dieser Spielerstufe ziehbar — sonst bekäme ein Anfänger Aufgaben,
  // für die ihm die Gebäude fehlen.
  minLevel?: number;
};

// Ein Fest: ein Thema mit eigenem Zetteltopf und einer Deko, die es nur hier
// gibt (Index in plots; beim ersten Abschluss eingepackt, danach nicht mehr).
export type FestDef = {
  id: string;
  label: string;
  deko?: number;
  aufgaben: readonly AufgabeDef[];
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
  truckAwayTicks?: number;
  destinations?: readonly string[];
  boardDeliveryOnly?: boolean;
  sellNpcDisabled?: boolean;
  emergencyBuyOnly?: boolean;
  siloLevels?: readonly SiloLevel[];
  chestKinds?: readonly ChestKind[];
  chestEveryTicks?: number;
  chestSpreadTicks?: number;
  chestQueueMax?: number;
  grid?: GridDef;
  obstacles?: readonly Obstacle[];
  // Hindernis räumen: welches Werkzeug es kostet, wie viel XP es gibt und was
  // dabei abfällt. `ertrag` fehlt in alten Regelwerken, dann bleibt es beim XP.
  obstacleKinds?: Record<string, { tool: number; xp: number; ertrag?: ItemStack }>;
  expansions?: readonly Expansion[];
  maxOfferAmount?: number;
  maxOfferPrice?: number;
  offerNeedsLevel?: boolean;
  buyNeedsLevel?: boolean;
  animalsMustBeBought?: boolean;
  saleGoldInSlot?: boolean;
  helpPerFarmPerDay?: number;
  helpSpeedupPct?: number;
  helpXp?: number;
  // Erlaubt, dass das Lager über seine Kapazität hinaus gefüllt wird (z. B. per
  // Admin-Postfach). Ist es voll, produziert nichts mehr von selbst nach — man
  // muss erst verkaufen/verbrauchen.
  siloUeberlauf?: boolean;
  achievements?: readonly AchievementDef[];
  // Topf, aus dem die Aufgaben des Tages gezogen werden.
  tagesaufgaben?: readonly AufgabeDef[];
  // Wie viele Aufgaben ein Tag hat.
  aufgabenProTag?: number;
  // Was es gibt, wenn alle Aufgaben eines Tages abgenommen sind. Ohne dieses
  // Feld gibt es keinen Tagesabschluss — alte Fassungen bleiben unberührt.
  tagesAbschluss?: { gold: number; xp: number };
  // Die Woche: eigener Topf mit groesseren Zielen, eigene Zahl je Woche, und
  // der Wochenabschluss darf zusaetzlich eine Kiste bringen (Index in
  // chestKinds) — die geht denselben Weg wie jede Kiste.
  wochenaufgaben?: readonly AufgabeDef[];
  aufgabenProWoche?: number;
  wochenAbschluss?: { gold: number; xp: number; kiste?: number };
  // Booster: zwei Waren, die man einsetzt statt verkauft. Der XP-Verdoppler
  // verdoppelt `xpTicks` lang alles, was ein Befehl an XP bringt; der
  // Schnellwuchs schiebt alles Laufende um `wuchsProzent` der Restzeit vor —
  // einmalig, wie die Nachbarschaftshilfe. Beides nicht handelbar.
  booster?: { xpItem: number; xpTicks: number; wuchsItem: number; wuchsProzent: number };
  // Wetter mit Wirkung: In Fenstern von `fensterTicks` steht das Wetter fest,
  // gezogen aus der Fensternummer — also aus dem Tick, den Server und Geraet
  // teilen. Bei Regen bekommt, was auf einem der `plaetze` angesetzt wird,
  // `regenSchubProzent` seiner Dauer geschenkt. Ohne dieses Feld ist das
  // Wetter Stimmung und sonst nichts.
  wetter?: { fensterTicks: number; regenSchubProzent: number; plaetze: readonly number[] };
  // Meisterschaft: Jede Werkstatt und jeder Stall zählt seine Abholungen. Ab
  // `stufen[k]` Abholungen leuchtet der (k+1)-te Stern. Erster Stern: Alles,
  // was dort angesetzt wird, läuft `schnellerProzent` schneller. Zweiter:
  // `xpProzent` mehr XP je Abholung. Dritter: Jede `extraJede`-te Abholung
  // bringt ein Stück obendrauf. Felder, Bäume und Deko machen nicht mit —
  // davon gibt es viele und gleiche; Sterne gehören an Gebäude. Ohne dieses
  // Feld gibt es keine Sterne, alte Fassungen bleiben unberührt.
  // Ab 49: Platz 3 der Zaehler zaehlt geoeffnete Kisten (statt der toten Anfragen).
  kistenZaehlen?: boolean;
  meisterschaft?: {
    stufen: readonly number[];
    schnellerProzent: number;
    xpProzent: number;
    extraJede: number;
  };
  // Feste: An den Wochentagen in `tage` (0 = Montag … 6 = Sonntag) läuft ein
  // Fest; welches, wechselt mit der Serverwoche durch `arten`. Es hängt am
  // Servertag wie der Tag und die Woche — für alle Höfe dasselbe Fest zur
  // selben Zeit. Zettel und Abschluss wie beim Wochenziel, dazu eine Deko, die
  // es nur dort gibt. Ohne dieses Feld gibt es keine Feste.
  feste?: {
    tage: readonly number[];
    arten: readonly FestDef[];
    aufgabenProFest: number;
    abschluss: { gold: number; xp: number; kiste?: number };
  };
  // Fundstücke beim Abernten: Jede `jede`-te Ernte legt etwas aus `tabelle`
  // obendrauf, gewichtet gezogen. Gezogen wird deterministisch aus dem
  // Spielstand (siehe sim.ts) — Server und Gerät kommen ohne Absprache auf
  // dasselbe Stück, und niemand kann es sich erwürfeln. Ohne dieses Feld gibt
  // es keine Funde.
  fundstuecke?: {
    jede: number;
    tabelle: readonly { item: number; amount: number; weight: number }[];
  };
  // Eigene Dimension „Angelsee": Das Boot auf dem Hof steht kaputt da; ab
  // minLevel lässt es sich mit `repair` (Gold + Material) wieder flottmachen.
  // Erst danach ist der See offen. Köder werden nicht gekauft, sondern im
  // Strandhaus aus `craft.input` hergestellt. Auswerfen verbraucht einen Köder
  // (bait) und bringt einen Fisch aus der gewichteten Tabelle. Der Fang ist
  // deterministisch aus dem Zustand abgeleitet (siehe sim.ts), also cheat-sicher
  // und exakt reproduzierbar.
  fishing?: {
    minLevel: number;
    bait: number;
    xp: number;
    table: readonly { item: number; weight: number }[];
    // Boot reparieren: Kosten (Gold + Material). Fehlt das Feld, gilt die alte
    // Regel (nur ab minLevel, ohne Reparatur).
    repair?: readonly ItemStack[];
    // Köder herstellen: Eingabe → so viele Köder. Fehlt das Feld, bleibt der
    // alte Kauf-Weg (npcBuyPrice). Mit `slots` und `durationTicks` dauert das
    // Herstellen und läuft nur auf so vielen Werkbank-Plätzen gleichzeitig.
    craft?: {
      input: readonly ItemStack[];
      output: number;
      slots?: number;
      durationTicks?: number;
    };
    // Reusen statt Angel: So viele Angelstellen gibt es, so lange muss ein
    // Köder ziehen, so viele Fänge bringt eine volle Reuse. Fehlen die Felder,
    // gilt der alte Sofort-Fang (CAST_LINE).
    spots?: number;
    soakTicks?: number;
    catchPerSpot?: number;
  };
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
      place: at(3, 60, 30, 18),
      levels: [{ label: 'Feld', cost: [], recipes: [R_WHEAT] }],
    },
    {
      id: 'field-2',
      startLevel: 1,
      place: at(35, 60, 30, 18),
      levels: [{ label: 'Feld', cost: [], recipes: [R_WHEAT] }],
    },
    {
      id: 'field-3',
      startLevel: 1,
      place: at(67, 60, 30, 18),
      levels: [{ label: 'Feld', cost: [], recipes: [R_WHEAT] }],
    },
    {
      id: 'field-4',
      startLevel: 0,
      place: at(3, 81, 30, 18),
      levels: [{ label: 'Feld', cost: gold(100), recipes: [R_WHEAT], minPlayerLevel: 2 }],
    },
    {
      id: 'field-5',
      startLevel: 0,
      place: at(35, 81, 30, 18),
      levels: [{ label: 'Feld', cost: gold(250), recipes: [R_WHEAT], minPlayerLevel: 4 }],
    },
    {
      id: 'field-6',
      startLevel: 0,
      place: at(67, 81, 30, 18),
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
      place: at(47, 29, 26, 17),
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
      place: at(3, 60, 30, 18),
      levels: [{ label: 'Feld', cost: [], recipes: [R_WHEAT, R_CORN] }],
    },
    {
      id: 'field-2',
      startLevel: 1,
      place: at(35, 60, 30, 18),
      levels: [{ label: 'Feld', cost: [], recipes: [R_WHEAT, R_CORN] }],
    },
    {
      id: 'field-3',
      startLevel: 1,
      place: at(67, 60, 30, 18),
      levels: [{ label: 'Feld', cost: [], recipes: [R_WHEAT, R_CORN] }],
    },
    {
      id: 'field-4',
      startLevel: 0,
      place: at(3, 81, 30, 18),
      levels: [{ label: 'Feld', cost: gold(100), recipes: [R_WHEAT, R_CORN], minPlayerLevel: 2 }],
    },
    {
      id: 'field-5',
      startLevel: 0,
      place: at(35, 81, 30, 18),
      levels: [{ label: 'Feld', cost: gold(250), recipes: [R_WHEAT, R_CORN], minPlayerLevel: 4 }],
    },
    {
      id: 'field-6',
      startLevel: 0,
      place: at(67, 81, 30, 18),
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
      place: at(47, 29, 26, 17),
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
      place: at(3, 28, 38, 18),
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

const V7: Ruleset = {
  ...V6,
  version: 7,

  truckAwayTicks: 420,
  requestSkipCooldownTicks: 900,

  requestTemplates: [
    { id: 'fuhre-weizen', wants: [want(WHEAT, 12)], reward: gold(95), xp: 21 },
    { id: 'fuhre-mais', wants: [want(CORN, 10)], reward: gold(135), xp: 30 },
    {
      id: 'fuhre-hof',
      wants: [want(WHEAT, 10), want(CORN, 6)],
      reward: gold(160),
      xp: 36,
    },
    {
      id: 'fuhre-muehle',
      wants: [want(FEED, 4), want(WHEAT, 8)],
      reward: gold(130),
      xp: 29,
    },
    { id: 'fuhre-eier', wants: [want(EGGS, 6)], reward: gold(320), xp: 71 },
    {
      id: 'fuhre-markt',
      wants: [want(EGGS, 4), want(WHEAT, 10)],
      reward: gold(290),
      xp: 64,
    },
    {
      id: 'fuhre-milch',
      wants: [want(MILK, 6), want(FEED, 4)],
      reward: gold(410),
      xp: 91,
    },
    { id: 'fuhre-sahne', wants: [want(CREAM, 4)], reward: gold(645), xp: 143 },
    {
      id: 'fuhre-molkerei',
      wants: [want(MILK, 4), want(CREAM, 2), want(EGGS, 3)],
      reward: gold(710),
      xp: 158,
    },
    {
      id: 'fuhre-butter',
      wants: [want(BUTTER, 2), want(MILK, 4)],
      reward: gold(1215),
      xp: 270,
    },
    {
      id: 'fuhre-kaese',
      wants: [want(CHEESE, 2), want(MILK, 3)],
      reward: gold(1765),
      xp: 392,
    },
    {
      id: 'fuhre-gross',
      wants: [want(BUTTER, 2), want(CHEESE, 1), want(MILK, 4)],
      reward: gold(2010),
      xp: 447,
    },
  ],
};

const V8: Ruleset = {
  ...V7,
  version: 8,

  truckAwayTicks: 9,
  requestSkipCooldownTicks: 120,
  requestSlots: 4,

  boardDeliveryOnly: true,
  sellNpcDisabled: true,
  emergencyBuyOnly: true,

  destinations: [
    'Mühlbach',
    'Seeblick',
    'Bahnhof',
    'Altdorf',
    'Steinfurt',
    'Grünau',
    'Hafen',
    'Marktplatz',
  ],

  startingItems: [
    { item: GOLD, amount: 60 },
    { item: WHEAT, amount: 6 },
    { item: CORN, amount: 3 },
  ],
};

const PLANK = 10;
const NAIL = 11;

const V9: Ruleset = {
  ...V8,
  version: 9,

  items: [
    ...V8.items,
    { id: 'plank', storable: false, npcPrice: 0, npcBuyPrice: 0 },
    { id: 'nail', storable: false, npcPrice: 0, npcBuyPrice: 0 },
  ],

  siloLevels: [
    { label: 'Lager', cost: [], capacity: 200 },
    { label: 'Erste Erweiterung', cost: [want(PLANK, 8), want(NAIL, 4), want(GOLD, 300)], capacity: 280 },
    { label: 'Zweite Erweiterung', cost: [want(PLANK, 16), want(NAIL, 10), want(GOLD, 900)], capacity: 380 },
    { label: 'Dritte Erweiterung', cost: [want(PLANK, 28), want(NAIL, 20), want(GOLD, 2200)], capacity: 500 },
    { label: 'Vierte Erweiterung', cost: [want(PLANK, 44), want(NAIL, 34), want(GOLD, 5000)], capacity: 650 },
  ],

  chestEveryTicks: 1800,
  chestSpreadTicks: 1200,
  chestQueueMax: 6,

  chestKinds: [
    {
      id: 'holzkiste',
      label: 'Holzkiste',
      picks: 2,
      drops: [
        { item: PLANK, min: 1, max: 3, weight: 30 },
        { item: NAIL, min: 1, max: 2, weight: 24 },
        { item: GOLD, min: 20, max: 80, weight: 20 },
        { item: WHEAT, min: 2, max: 6, weight: 14 },
        { item: CORN, min: 2, max: 5, weight: 12 },
      ],
    },
    {
      id: 'eisenkiste',
      label: 'Eisenkiste',
      picks: 3,
      drops: [
        { item: PLANK, min: 2, max: 5, weight: 28 },
        { item: NAIL, min: 2, max: 4, weight: 26 },
        { item: GOLD, min: 60, max: 220, weight: 20 },
        { item: FEED, min: 1, max: 3, weight: 13 },
        { item: COW_FEED, min: 1, max: 3, weight: 13 },
      ],
    },
  ],
};

const feld = { w: 2, h: 2 };

const V10: Ruleset = {
  ...V9,
  version: 10,

  grid: { w: 8, h: 10 },

  plots: V9.plots.map((p) => {
    if (p.id.startsWith('field-')) return { ...p, size: feld, flat: true };
    if (p.id === 'mill') return { ...p, size: { w: 2, h: 2 } };
    if (p.id.startsWith('coop-')) return { ...p, size: { w: 2, h: 2 } };
    if (p.id === 'pasture-1') return { ...p, size: { w: 3, h: 2 } };
    if (p.id === 'dairy') return { ...p, size: { w: 2, h: 2 } };
    return { ...p, size: { w: 1, h: 1 } };
  }),
};

const V11: Ruleset = {
  ...V10,
  version: 11,

  grid: { w: 9, h: 11 },

  chestEveryTicks: 900,
  chestSpreadTicks: 600,
  chestQueueMax: 8,

  obstacles: [
    { kind: 'tree', gx: 0, gy: 0, w: 1, h: 1 },
    { kind: 'tree', gx: 8, gy: 1, w: 1, h: 1 },
    { kind: 'tree', gx: 3, gy: 2, w: 1, h: 1 },
    { kind: 'rock', gx: 6, gy: 3, w: 1, h: 1 },
    { kind: 'rock', gx: 1, gy: 5, w: 1, h: 1 },
    { kind: 'pond', gx: 7, gy: 8, w: 2, h: 2 },
    { kind: 'tree', gx: 0, gy: 10, w: 1, h: 1 },
  ],
};

const SAW = 12;
const SHOVEL = 13;
const PICKAXE = 14;
const MAP = 15;
const MALLET = 16;
const STAKE = 17;

const V12: Ruleset = {
  ...V11,
  version: 12,

  items: [
    ...V11.items,
    { id: 'saw', storable: false, npcPrice: 0, npcBuyPrice: 0 },
    { id: 'shovel', storable: false, npcPrice: 0, npcBuyPrice: 0 },
    { id: 'pickaxe', storable: false, npcPrice: 0, npcBuyPrice: 0 },
  ],

  chestEveryTicks: 420,
  chestSpreadTicks: 480,
  chestQueueMax: 12,

  obstacleKinds: {
    tree: { tool: SAW, xp: 15 },
    rock: { tool: PICKAXE, xp: 25 },
    pond: { tool: SHOVEL, xp: 40 },
  },

  chestKinds: [
    {
      id: 'holzkiste',
      label: 'Holzkiste',
      picks: 1,
      drops: [
        { item: PLANK, min: 1, max: 1, weight: 26 },
        { item: NAIL, min: 1, max: 1, weight: 26 },
        { item: SAW, min: 1, max: 1, weight: 18 },
        { item: SHOVEL, min: 1, max: 1, weight: 15 },
        { item: PICKAXE, min: 1, max: 1, weight: 15 },
      ],
    },
    {
      id: 'eisenkiste',
      label: 'Eisenkiste',
      picks: 1,
      drops: [
        { item: PLANK, min: 1, max: 1, weight: 20 },
        { item: NAIL, min: 1, max: 1, weight: 20 },
        { item: SAW, min: 1, max: 1, weight: 20 },
        { item: SHOVEL, min: 1, max: 1, weight: 20 },
        { item: PICKAXE, min: 1, max: 1, weight: 20 },
      ],
    },
  ],
};

const V13: Ruleset = {
  ...V12,
  version: 13,

  chestQueueMax: 2,
  chestEveryTicks: 420,
  chestSpreadTicks: 0,
};

const V14: Ruleset = {
  ...V13,
  version: 14,

  maxOfferAmount: 10,
  maxOfferPrice: 500,
};

const V15: Ruleset = {
  ...V14,
  version: 15,

  offerSlots: 60,
};

const V16: Ruleset = {
  ...V15,
  version: 16,

  animalsMustBeBought: true,

  plots: V15.plots.map((p) => {
    if (p.id === 'coop-1' || p.id === 'coop-2') {
      const bau = p.id === 'coop-1' ? gold(550) : gold(1050);
      return {
        ...p,
        animal: { cost: 250, growTicks: 600 },
        levels: [
          {
            label: p.id === 'coop-1' ? 'Hühnerstall' : 'Zweiter Hühnerstall',
            cost: bau,
            recipes: [R_EGGS],
            minPlayerLevel: p.id === 'coop-1' ? 3 : 5,
            slots: 3,
          },
          { label: 'Vierter Platz', cost: gold(400), recipes: [R_EGGS], slots: 4 },
          { label: 'Fünfter Platz', cost: gold(700), recipes: [R_EGGS], slots: 5 },
        ],
      };
    }
    if (p.id === 'pasture-1') {
      return {
        ...p,
        animal: { cost: 900, growTicks: 1800 },
        levels: [
          { label: 'Kuhweide', cost: gold(2100), recipes: [R_MILK], minPlayerLevel: 6, slots: 2 },
          { label: 'Dritter Platz', cost: gold(1400), recipes: [R_MILK], slots: 3 },
          { label: 'Vierter Platz', cost: gold(2200), recipes: [R_MILK], slots: 4 },
        ],
      };
    }
    return p;
  }),
};

const V17: Ruleset = {
  ...V16,
  version: 17,

  saleGoldInSlot: true,
};

const V18: Ruleset = {
  ...V17,
  version: 18,

  helpPerFarmPerDay: 3,
  helpSpeedupPct: 20,
  helpXp: 12,
};

const V19: Ruleset = {
  ...V18,
  version: 19,

  grid: { w: 13, h: 13 },

  plots: V18.plots.map((p) => {
    if (p.id === 'field-1') return { ...p, place: at(10, 64, 30, 15) };
    if (p.id === 'field-2') return { ...p, place: at(40, 64, 30, 15) };
    if (p.id === 'field-3') return { ...p, place: at(70, 64, 28, 15) };
    return p;
  }),

  obstacles: [
    ...(V18.obstacles ?? []),
    { kind: 'tree', gx: 11, gy: 0, w: 1, h: 1 },
    { kind: 'tree', gx: 12, gy: 4, w: 1, h: 1 },
    { kind: 'rock', gx: 10, gy: 6, w: 1, h: 1 },
    { kind: 'pond', gx: 2, gy: 10, w: 2, h: 2 },
    { kind: 'tree', gx: 5, gy: 11, w: 1, h: 1 },
    { kind: 'tree', gx: 9, gy: 11, w: 1, h: 1 },
    { kind: 'rock', gx: 12, gy: 9, w: 1, h: 1 },
    { kind: 'tree', gx: 11, gy: 10, w: 1, h: 1 },
    { kind: 'rock', gx: 4, gy: 4, w: 1, h: 1 },
    { kind: 'pond', gx: 10, gy: 11, w: 2, h: 2 },
  ],
};

const V20: Ruleset = {
  ...V19,
  version: 20,

  offerNeedsLevel: true,

  items: V19.items.map((it) => {
    if (it.id === 'plank') return { ...it, npcPrice: 14 };
    if (it.id === 'nail') return { ...it, npcPrice: 10 };
    if (it.id === 'saw') return { ...it, npcPrice: 45 };
    if (it.id === 'shovel') return { ...it, npcPrice: 55 };
    if (it.id === 'pickaxe') return { ...it, npcPrice: 65 };
    return it;
  }),
};

const V21: Ruleset = {
  ...V20,
  version: 21,

  buyNeedsLevel: true,
};

const V22: Ruleset = {
  ...V21,
  version: 22,

  items: [
    ...V21.items,
    { id: 'map', storable: false, npcPrice: 40, npcBuyPrice: 0 },
    { id: 'mallet', storable: false, npcPrice: 30, npcBuyPrice: 0 },
    { id: 'stake', storable: false, npcPrice: 20, npcBuyPrice: 0 },
  ],

  grid: { w: 39, h: 13 },

  plots: V21.plots.map((p) => {
    if (p.id === 'field-1') return { ...p, place: at(3, 64, 7, 15) };
    if (p.id === 'field-2') return { ...p, place: at(11, 64, 7, 15) };
    if (p.id === 'field-3') return { ...p, place: at(26, 64, 7, 15) };
    return p;
  }),

  chestKinds: [
    {
      id: 'holzkiste',
      label: 'Holzkiste',
      picks: 1,
      drops: [
        { item: PLANK, min: 1, max: 1, weight: 24 },
        { item: NAIL, min: 1, max: 1, weight: 24 },
        { item: SAW, min: 1, max: 1, weight: 16 },
        { item: SHOVEL, min: 1, max: 1, weight: 13 },
        { item: PICKAXE, min: 1, max: 1, weight: 13 },
        { item: STAKE, min: 1, max: 2, weight: 12 },
        { item: MALLET, min: 1, max: 1, weight: 8 },
        { item: MAP, min: 1, max: 1, weight: 5 },
      ],
    },
    {
      id: 'eisenkiste',
      label: 'Eisenkiste',
      picks: 1,
      drops: [
        { item: PLANK, min: 1, max: 1, weight: 16 },
        { item: NAIL, min: 1, max: 1, weight: 16 },
        { item: SAW, min: 1, max: 1, weight: 16 },
        { item: SHOVEL, min: 1, max: 1, weight: 16 },
        { item: PICKAXE, min: 1, max: 1, weight: 16 },
        { item: STAKE, min: 1, max: 2, weight: 14 },
        { item: MALLET, min: 1, max: 2, weight: 12 },
        { item: MAP, min: 1, max: 1, weight: 8 },
      ],
    },
  ],

  expansions: [
    { id: 'w1', gx: 13, gy: 0, w: 9, h: 7, minLevel: 5, cost: [want(MAP, 1), want(MALLET, 1), want(STAKE, 2)] },
    { id: 'w2', gx: 22, gy: 0, w: 9, h: 7, minLevel: 6, cost: [want(MAP, 1), want(MALLET, 2), want(STAKE, 3)] },
    { id: 'w3', gx: 31, gy: 0, w: 8, h: 7, minLevel: 8, cost: [want(MAP, 2), want(MALLET, 2), want(STAKE, 4)] },
    { id: 'w4', gx: 13, gy: 7, w: 9, h: 6, minLevel: 9, cost: [want(MAP, 2), want(MALLET, 3), want(STAKE, 5)] },
    { id: 'w5', gx: 22, gy: 7, w: 9, h: 6, minLevel: 11, cost: [want(MAP, 3), want(MALLET, 4), want(STAKE, 6)] },
    { id: 'w6', gx: 31, gy: 7, w: 8, h: 6, minLevel: 12, cost: [want(MAP, 4), want(MALLET, 5), want(STAKE, 8)] },
  ],
};

const EXPLOSIVE = 18;
const COAL = 19;
const IRON_ORE = 20;
const GOLD_ORE = 21;
const IRON_BAR = 22;
const GOLD_BAR = 23;

const R_DIG_SHOVEL = 9;
const R_DIG_PICKAXE = 10;
const R_DIG_BLAST = 11;
const R_IRON_BAR = 12;
const R_GOLD_BAR = 13;

const V23: Ruleset = {
  ...V22,
  version: 23,

  items: [
    ...V22.items,
    { id: 'explosive', storable: false, npcPrice: 60, npcBuyPrice: 0 },
    { id: 'coal', storable: true, npcPrice: 10, npcBuyPrice: 0 },
    { id: 'iron-ore', storable: true, npcPrice: 22, npcBuyPrice: 0 },
    { id: 'gold-ore', storable: true, npcPrice: 45, npcBuyPrice: 0 },
    { id: 'iron-bar', storable: true, npcPrice: 90, npcBuyPrice: 0 },
    { id: 'gold-bar', storable: true, npcPrice: 200, npcBuyPrice: 0 },
  ],

  recipes: [
    ...V22.recipes,
    {
      id: 'dig-shovel',
      inputs: [want(SHOVEL, 1)],
      output: want(COAL, 2),
      extra: [want(IRON_ORE, 1)],
      durationTicks: 180,
      xp: 6,
      minPlayerLevel: 10,
    },
    {
      id: 'dig-pickaxe',
      inputs: [want(PICKAXE, 1)],
      output: want(COAL, 3),
      extra: [want(IRON_ORE, 2), want(GOLD_ORE, 1)],
      durationTicks: 300,
      xp: 12,
      minPlayerLevel: 10,
    },
    {
      id: 'dig-blast',
      inputs: [want(EXPLOSIVE, 1)],
      output: want(COAL, 5),
      extra: [want(IRON_ORE, 3), want(GOLD_ORE, 2)],
      durationTicks: 420,
      xp: 22,
      minPlayerLevel: 10,
    },
    {
      id: 'iron-bar',
      inputs: [want(IRON_ORE, 2), want(COAL, 1)],
      output: want(IRON_BAR, 1),
      durationTicks: 400,
      xp: 20,
      minPlayerLevel: 11,
    },
    {
      id: 'gold-bar',
      inputs: [want(GOLD_ORE, 2), want(COAL, 1)],
      output: want(GOLD_BAR, 1),
      durationTicks: 600,
      xp: 35,
      minPlayerLevel: 11,
    },
  ],

  grid: { w: 52, h: 13 },

  plots: [
    ...V22.plots.map((p) => {
      if (p.id === 'field-1') return { ...p, place: at(3, 64, 5, 15) };
      if (p.id === 'field-2') return { ...p, place: at(8, 64, 5, 15) };
      if (p.id === 'field-3') return { ...p, place: at(20, 64, 5, 15) };
      return p;
    }),
    {
      id: 'mine',
      startLevel: 0,
      place: at(2, 47, 12, 15),
      size: { w: 2, h: 2 },
      levels: [
        {
          label: 'Mine',
          cost: [want(PLANK, 20), want(NAIL, 12), want(GOLD, 3000)],
          recipes: [R_DIG_SHOVEL, R_DIG_PICKAXE, R_DIG_BLAST],
          minPlayerLevel: 10,
          slots: 1,
        },
        {
          label: 'Zweiter Stollen',
          cost: gold(4000),
          recipes: [R_DIG_SHOVEL, R_DIG_PICKAXE, R_DIG_BLAST],
          minPlayerLevel: 10,
          slots: 2,
        },
      ],
    },
    {
      id: 'forge',
      startLevel: 0,
      place: at(16, 47, 12, 15),
      size: { w: 2, h: 2 },
      levels: [
        {
          label: 'Schmiede',
          cost: [want(PLANK, 24), want(NAIL, 16), want(GOLD, 5000)],
          recipes: [R_IRON_BAR, R_GOLD_BAR],
          minPlayerLevel: 11,
          slots: 1,
        },
        {
          label: 'Zweiter Ofen',
          cost: gold(6000),
          recipes: [R_IRON_BAR, R_GOLD_BAR],
          minPlayerLevel: 11,
          slots: 2,
        },
      ],
    },
  ],

  obstacles: [
    ...(V22.obstacles ?? []),
    { kind: 'rock', gx: 42, gy: 3, w: 1, h: 1 },
    { kind: 'rock', gx: 46, gy: 6, w: 1, h: 1 },
    { kind: 'rock', gx: 49, gy: 9, w: 1, h: 1 },
    { kind: 'rock', gx: 44, gy: 10, w: 1, h: 1 },
  ],

  chestKinds: (V22.chestKinds ?? []).map((k) => ({
    ...k,
    drops: [...k.drops, { item: EXPLOSIVE, min: 1, max: 1, weight: 4 }],
  })),

  expansions: [
    ...(V22.expansions ?? []),
    { id: 'm1', gx: 39, gy: 0, w: 13, h: 7, minLevel: 10, cost: [want(MAP, 4), want(MALLET, 5), want(STAKE, 8)] },
    { id: 'm2', gx: 39, gy: 7, w: 13, h: 6, minLevel: 13, cost: [want(MAP, 6), want(MALLET, 7), want(STAKE, 11)] },
  ],
};

function zelleSchluessel(gx: number, gy: number): number {
  return gx * 1000 + gy;
}

function belegteZellen(hindernisse: readonly Obstacle[]): Set<number> {
  const belegt = new Set<number>();
  for (const h of hindernisse) {
    for (let dx = 0; dx < h.w; dx++) {
      for (let dy = 0; dy < h.h; dy++) belegt.add(zelleSchluessel(h.gx + dx, h.gy + dy));
    }
  }
  return belegt;
}

// Streut deterministisch Hindernisse in ein Feld — nur ganzzahlige Rechnung,
// prozent ist ein Ganzzahl-Anteil (30 = 30 %). Belegte Zellen bleiben frei.
function wuchern(
  e: Expansion,
  kind: Obstacle['kind'],
  prozent: number,
  belegt: Set<number>,
  saat = 1,
): Obstacle[] {
  const out: Obstacle[] = [];
  let seed = (e.gx * 73856 + e.gy * 19349 + saat) & 0x7fffffff;
  const n = Math.floor((e.w * e.h * prozent) / 100);
  for (let k = 0; k < n * 5 && out.length < n; k++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const gx = e.gx + (seed % e.w);
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const gy = e.gy + (seed % e.h);
    const key = zelleSchluessel(gx, gy);
    if (belegt.has(key)) continue;
    belegt.add(key);
    out.push({ kind, gx, gy, w: 1, h: 1 });
  }
  return out;
}

const V24_BELEGT = belegteZellen(V23.obstacles ?? []);
const V24_HINDERNISSE: Obstacle[] = [...(V23.obstacles ?? [])];
for (const e of V23.expansions ?? []) {
  if (e.id.startsWith('w')) V24_HINDERNISSE.push(...wuchern(e, 'tree', 22, V24_BELEGT));
  else if (e.id.startsWith('m')) V24_HINDERNISSE.push(...wuchern({ ...e, w: 11 }, 'rock', 25, V24_BELEGT));
}

const V24: Ruleset = {
  ...V23,
  version: 24,

  // Mine und Schmiede sind fest — man baut sie am Berg auf, verschiebt sie nie.
  plots: V23.plots.map((p) => {
    if (p.id === 'mine') return { ...p, fixed: true, place: at(97, 14, 3, 14) };
    if (p.id === 'forge') return { ...p, fixed: true, place: at(97, 60, 3, 14) };
    return p;
  }),

  // Berg-Erweiterungen etwas schmaler, damit rechts (Spalte 50/51) Platz für
  // die festen Gebäude bleibt.
  expansions: (V23.expansions ?? []).map((e) =>
    e.id === 'm1' || e.id === 'm2' ? { ...e, w: 11 } : e,
  ),

  obstacles: V24_HINDERNISSE,
};

// v25: Die Schmiede ist ab jetzt ein normales Bauwerk, das man wie Ställe baut
// und frei platziert. Nur die Mine bleibt fest am Berg und wird freigeschaltet.
const V25: Ruleset = {
  ...V24,
  version: 25,
  plots: V24.plots.map((p) =>
    p.id === 'forge' ? { ...p, fixed: false, place: at(16, 47, 12, 15) } : p,
  ),
};

// v26: Der Apfelbaum. Ab Stufe 8 für Gold kaufbar, frei platzierbar. Er wächst
// als Setzling heran, trägt dann Äpfel, die man mehrfach erntet — und verwelkt
// zum Schluss, sodass man ihn mit der Säge fällen muss.
const APPLE = 24;

const V26: Ruleset = {
  ...V25,
  version: 26,

  items: [...V25.items, { id: 'apple', storable: true, npcPrice: 16, npcBuyPrice: 0 }],

  plots: [
    ...V25.plots,
    {
      id: 'apple-tree',
      startLevel: 0,
      place: at(85, 29, 13, 15),
      size: { w: 2, h: 2 },
      levels: [
        {
          label: 'Apfelbaum',
          cost: gold(500),
          recipes: [],
          minPlayerLevel: 8,
          slots: 0,
        },
      ],
      baum: {
        setzlingTicks: 1800,
        reifeTicks: 900,
        ernten: 6,
        ertrag: want(APPLE, 4),
        xp: 12,
        faellenWerkzeug: SAW,
        faellenXp: 20,
      },
    },
  ],
};

// v27: Freigeschaltetes Land ist gemischt bewachsen — Bäume, Steine UND Teiche
// statt nur Bäumen, wie beim Startplot. Positionen und Anzahl bleiben exakt wie
// in v26 (die Kataloge dürfen nur hinten wachsen; clearedObstacles zeigt per
// Index), nur die ART der erzeugten Baum-Hindernisse wird fair verteilt.
const V27_BASIS = (V23.obstacles ?? []).length;
const V27_HINDERNISSE: Obstacle[] = V24_HINDERNISSE.map((h, i) => {
  if (i < V27_BASIS) return h; // Startplot + Berg-Basis unverändert
  if (h.kind !== 'tree') return h; // erzeugte Berg-Steine bleiben Steine
  const r = ((h.gx * 73856 + h.gy * 19349 + 3) & 0x7fffffff) % 10;
  const kind: Obstacle['kind'] = r < 5 ? 'tree' : r < 8 ? 'rock' : 'pond';
  return { ...h, kind };
});

const V27: Ruleset = {
  ...V26,
  version: 27,
  // Das Postfach-Limit von 20 ist weg (praktisch unbegrenzt) …
  mailCapacity: 9999,
  // … und das Lager darf übervoll werden (Admin-Postfach). Voll = nichts wächst
  // mehr von selbst nach, erst leeren.
  siloUeberlauf: true,
  obstacles: V27_HINDERNISSE,
};

// v28: Bis zu 5 Apfelbäume gleichzeitig. Vier weitere Apfelbaum-Plätze, sonst
// identisch zum ersten — jeder wird einzeln gebaut, platziert und gefällt.
const APFEL_VORLAGE = V26.plots.find((p) => p.id === 'apple-tree')!;
const weitererApfelbaum = (id: string, place: PlotPlace): PlotDef => ({
  ...APFEL_VORLAGE,
  id,
  place,
});

const V28: Ruleset = {
  ...V27,
  version: 28,
  plots: [
    ...V27.plots,
    weitererApfelbaum('apple-tree-2', at(76, 30, 8, 12)),
    weitererApfelbaum('apple-tree-3', at(30, 50, 8, 12)),
    weitererApfelbaum('apple-tree-4', at(50, 50, 8, 12)),
    weitererApfelbaum('apple-tree-5', at(70, 60, 8, 12)),
  ],
};

// v29: Mehr Verarbeitung. Die Mühle mahlt jetzt auch Mehl aus Weizen, ein
// Backofen bäckt Brot (aus Mehl) und Apfelkuchen (Mehl + Milch + Apfel), ein
// Grill macht Spiegeleier aus Eiern.
const MEHL = 25;
const BROT = 26;
const APFELKUCHEN = 27;
const SPIEGELEI = 28;

const R_FLOUR = 14;
const R_BREAD = 15;
const R_APPLEPIE = 16;
const R_FRIEDEGG = 17;

const V29: Ruleset = {
  ...V28,
  version: 29,
  items: [
    ...V28.items,
    { id: 'flour', storable: true, npcPrice: 14, npcBuyPrice: 0 },
    { id: 'bread', storable: true, npcPrice: 42, npcBuyPrice: 0 },
    { id: 'apple-pie', storable: true, npcPrice: 130, npcBuyPrice: 0 },
    { id: 'fried-egg', storable: true, npcPrice: 72, npcBuyPrice: 0 },
  ],
  recipes: [
    ...V28.recipes,
    { id: 'flour', inputs: [want(WHEAT, 2)], output: want(MEHL, 1), durationTicks: 150, xp: 8 },
    { id: 'bread', inputs: [want(MEHL, 2)], output: want(BROT, 1), durationTicks: 300, xp: 20 },
    {
      id: 'apple-pie',
      inputs: [want(MEHL, 2), want(MILK, 1), want(APPLE, 3)],
      output: want(APFELKUCHEN, 1),
      durationTicks: 600,
      xp: 45,
    },
    { id: 'fried-egg', inputs: [want(EGGS, 2)], output: want(SPIEGELEI, 2), durationTicks: 120, xp: 12 },
  ],
  plots: [
    // Die Mühle mahlt zusätzlich Mehl.
    ...V28.plots.map((p) =>
      p.id === 'mill'
        ? { ...p, levels: p.levels.map((l) => ({ ...l, recipes: [...l.recipes, R_FLOUR] })) }
        : p,
    ),
    {
      id: 'oven',
      startLevel: 0,
      place: at(38, 47, 10, 13),
      size: { w: 2, h: 2 },
      levels: [
        {
          label: 'Backofen',
          cost: [want(PLANK, 20), want(NAIL, 14), want(GOLD, 2500)],
          recipes: [R_BREAD, R_APPLEPIE],
          minPlayerLevel: 7,
        },
      ],
    },
    {
      id: 'grill',
      startLevel: 0,
      place: at(74, 44, 10, 13),
      size: { w: 2, h: 2 },
      levels: [
        {
          label: 'Grill',
          cost: [want(PLANK, 12), want(NAIL, 8), want(GOLD, 1500)],
          recipes: [R_FRIEDEGG],
          minPlayerLevel: 5,
        },
      ],
    },
  ],
};

// v30: Aufträge für ALLE Waren. Die Auftragsauswahl filtert ohnehin nach dem,
// was ein Hof herstellen kann (reachableItems), darum erscheinen diese erst,
// wenn Mine/Schmiede/Backofen/Grill/Apfelbaum gebaut sind. So hängen die neuen
// Ketten endlich am Kern-Loop „Aufträge erfüllen".
const V30: Ruleset = {
  ...V29,
  version: 30,
  requestTemplates: [
    ...V29.requestTemplates,
    { id: 'cowfeed-order', wants: [want(COW_FEED, 4)], reward: gold(70), xp: 16 },
    { id: 'coal-order', wants: [want(COAL, 6)], reward: gold(95), xp: 20 },
    { id: 'iron-ore-order', wants: [want(IRON_ORE, 4)], reward: gold(135), xp: 28 },
    { id: 'gold-ore-order', wants: [want(GOLD_ORE, 3)], reward: gold(200), xp: 40 },
    { id: 'iron-bar-order', wants: [want(IRON_BAR, 2)], reward: gold(270), xp: 60 },
    { id: 'gold-bar-order', wants: [want(GOLD_BAR, 1)], reward: gold(300), xp: 65 },
    { id: 'apple-order', wants: [want(APPLE, 5)], reward: gold(120), xp: 24 },
    { id: 'apple-big', wants: [want(APPLE, 12)], reward: gold(300), xp: 60 },
    { id: 'flour-order', wants: [want(MEHL, 4)], reward: gold(85), xp: 18 },
    { id: 'bread-order', wants: [want(BROT, 3)], reward: gold(195), xp: 42 },
    { id: 'friedegg-order', wants: [want(SPIEGELEI, 3)], reward: gold(320), xp: 68 },
    { id: 'pie-order', wants: [want(APFELKUCHEN, 1)], reward: gold(210), xp: 45 },
    { id: 'pie-big', wants: [want(APFELKUCHEN, 2)], reward: gold(430), xp: 95 },
    // Gemischte, wertvolle Aufträge für Fortgeschrittene.
    { id: 'bakery-mix', wants: [want(BROT, 2), want(APFELKUCHEN, 1)], reward: gold(370), xp: 82 },
    { id: 'forge-mix', wants: [want(IRON_BAR, 1), want(GOLD_BAR, 1)], reward: gold(450), xp: 100 },
    { id: 'brunch-mix', wants: [want(SPIEGELEI, 2), want(BROT, 1)], reward: gold(300), xp: 66 },
  ],
};

// v31: Erfolge mit Belohnung. Erreichte Meilensteine geben einmalig Gold + XP,
// eingelöst über einen cheat-sicheren Sim-Befehl.
const V31: Ruleset = {
  ...V30,
  version: 31,
  achievements: [
    { id: 'lvl3', label: 'Stufe 3 erreichen', kind: 'level', arg: 3, gold: 250, xp: 30 },
    { id: 'lvl8', label: 'Stufe 8 erreichen', kind: 'level', arg: 8, gold: 900, xp: 120 },
    { id: 'lvl15', label: 'Stufe 15 erreichen', kind: 'level', arg: 15, gold: 3000, xp: 350 },
    { id: 'gold1k', label: '1.000 Gold besitzen', kind: 'gold', arg: 1000, gold: 0, xp: 40 },
    { id: 'gold10k', label: '10.000 Gold besitzen', kind: 'gold', arg: 10000, gold: 0, xp: 200 },
    { id: 'mill', label: 'Erste Mühle bauen', kind: 'plot', arg: 'mill', gold: 150, xp: 20 },
    { id: 'coop', label: 'Ersten Hühnerstall bauen', kind: 'plotPrefix', arg: 'coop-', gold: 200, xp: 25 },
    { id: 'pasture', label: 'Kuhweide bauen', kind: 'plotPrefix', arg: 'pasture-', gold: 300, xp: 35 },
    { id: 'dairy', label: 'Molkerei bauen', kind: 'plot', arg: 'dairy', gold: 400, xp: 45 },
    { id: 'grill', label: 'Grill bauen', kind: 'plot', arg: 'grill', gold: 350, xp: 40 },
    { id: 'oven', label: 'Backofen bauen', kind: 'plot', arg: 'oven', gold: 500, xp: 55 },
    { id: 'apple', label: 'Apfelbaum pflanzen', kind: 'plotPrefix', arg: 'apple-tree', gold: 300, xp: 40 },
    { id: 'mine', label: 'Mine im Berg bauen', kind: 'plot', arg: 'mine', gold: 800, xp: 90 },
    { id: 'forge', label: 'Schmiede bauen', kind: 'plot', arg: 'forge', gold: 1000, xp: 110 },
    { id: 'expand1', label: 'Erstes Land freimachen', kind: 'expand', arg: 1, gold: 250, xp: 30 },
    { id: 'expand3', label: 'Drei Länder freimachen', kind: 'expand', arg: 3, gold: 900, xp: 100 },
  ],
};

// v32: Dekorationen. Rein kosmetische Bauwerke, die man kauft, frei platziert
// und wieder abreißen kann (halber Gold-Wert zurück).
const deko = (id: string, label: string, kosten: number, ab: number, place: PlotPlace): PlotDef => ({
  id,
  startLevel: 0,
  place,
  size: { w: 1, h: 1 },
  deco: true,
  levels: [{ label, cost: gold(kosten), recipes: [], minPlayerLevel: ab }],
});

const V32: Ruleset = {
  ...V31,
  version: 32,
  plots: [
    ...V31.plots,
    deko('deco-fence', 'Zaun', 50, 2, at(2, 47, 8, 10)),
    deko('deco-flowers', 'Blumenbeet', 90, 3, at(59, 47, 8, 10)),
    deko('deco-bench', 'Gartenbank', 140, 4, at(26, 62, 8, 10)),
  ],
};

// v33: Der Angelsee — eine eigene Dimension. Erreichbar über das Boot, eigene
// Ansicht. Köder kaufen, auswerfen, Fisch fangen (deterministisch), verkaufen
// oder in Aufträge geben.
const BAIT = 29;
const FISH_PERCH = 30; // Barsch
const FISH_TROUT = 31; // Forelle
const FISH_CARP = 32; // Karpfen
const FISH_PIKE = 33; // Hecht
const JUNK_CAN = 34; // Alte Dose — Beifang, bringt ein paar Münzen
const SEAWEED = 35; // Seegras — Beifang, gefragt bei Aufträgen

// Neuland nach unten: Der Hof wird auch in die Höhe verdoppelt (13 → 26). Die
// neuen unteren Reihen (gy 13–25) sind komplett gesperrt, über die volle Breite
// in zwei Bändern zu je acht Feldern gekachelt, mit weiter steigender Stufe und
// steigenden Kosten. Erzeugt in einer Schleife (nur ganzzahlige Arithmetik).
const UNTEN_LAND: Expansion[] = (() => {
  const out: Expansion[] = [];
  const spalten = [0, 13, 26, 39, 52, 65, 78, 91];
  const baender = [
    { gy: 13, h: 6 },
    { gy: 19, h: 7 },
  ];
  let n = 0;
  for (const b of baender) {
    for (const gx of spalten) {
      n += 1;
      out.push({
        id: 'u' + n,
        gx,
        gy: b.gy,
        w: 13,
        h: b.h,
        minLevel: 22 + n,
        cost: [want(MAP, 8 + n), want(MALLET, 9 + n), want(STAKE, 13 + n)],
      });
    }
  }
  return out;
})();

// Alle freizuschaltenden Felder von v33. Die Berg-Felder werden wieder 13 breit:
// v24 hatte sie auf 11 geschnitten, damit rechts (Spalte 50/51) Platz für die
// feste Mine bleibt — die steht jetzt aber mitten im Sperrland, also schloss die
// alte Lücke sonst ein Streifen offenes Land mitten im Gesperrten.
const V33_ERWEITERUNGEN: Expansion[] = [
  ...(V32.expansions ?? []).map((e) => (e.id === 'm1' || e.id === 'm2' ? { ...e, w: 13 } : e)),
  // Neues Land rechts (gx 52–103), in zwei Bändern, ansteigende Stufe/Kosten.
  { id: 'n1', gx: 52, gy: 0, w: 13, h: 7, minLevel: 14, cost: [want(MAP, 7), want(MALLET, 8), want(STAKE, 13)] },
  { id: 'n2', gx: 65, gy: 0, w: 13, h: 7, minLevel: 16, cost: [want(MAP, 8), want(MALLET, 10), want(STAKE, 15)] },
  { id: 'n3', gx: 78, gy: 0, w: 13, h: 7, minLevel: 18, cost: [want(MAP, 10), want(MALLET, 12), want(STAKE, 18)] },
  { id: 'n4', gx: 91, gy: 0, w: 13, h: 7, minLevel: 20, cost: [want(MAP, 12), want(MALLET, 14), want(STAKE, 22)] },
  { id: 'n5', gx: 52, gy: 7, w: 13, h: 6, minLevel: 15, cost: [want(MAP, 8), want(MALLET, 9), want(STAKE, 14)] },
  { id: 'n6', gx: 65, gy: 7, w: 13, h: 6, minLevel: 17, cost: [want(MAP, 9), want(MALLET, 11), want(STAKE, 16)] },
  { id: 'n7', gx: 78, gy: 7, w: 13, h: 6, minLevel: 19, cost: [want(MAP, 11), want(MALLET, 13), want(STAKE, 20)] },
  { id: 'n8', gx: 91, gy: 7, w: 13, h: 6, minLevel: 22, cost: [want(MAP, 13), want(MALLET, 16), want(STAKE, 24)] },
  // Neues Land unten (gy 13–25, volle Breite).
  ...UNTEN_LAND,
];

// Jede freizuschaltende Region soll gemischtes Unkraut tragen: Bäume, Teiche UND
// Steine. Bisher hatten die Berg-Felder nur Steine und das ganze neue Land gar
// nichts. Fehlende Arten werden deterministisch nachgestreut, bis die Region
// etwa so bewachsen ist wie die ersten Felder (~21 %).
const V33_ZIEL_UNKRAUT = 21;
const V33_ARTEN: readonly Obstacle['kind'][] = ['tree', 'pond', 'rock'];

const V33_BELEGT = belegteZellen(V32.obstacles ?? []);
// Die Startplätze der Bauwerke bleiben frei — vor allem die feste Mine, die
// mitten im Berg-Feld steht und sonst zugewuchert würde.
for (const p of V32.plots) {
  const ort = p.id === 'mine' ? at(91, 26, 3, 3) : p.place;
  if (!ort) continue;
  const gx = Math.floor((ort.x * 52) / 100);
  const gy = Math.floor((ort.y * 13) / 100);
  const g = p.size ?? { w: 1, h: 1 };
  for (let dx = 0; dx < g.w; dx++) {
    for (let dy = 0; dy < g.h; dy++) V33_BELEGT.add(zelleSchluessel(gx + dx, gy + dy));
  }
}

const V33_HINDERNISSE: Obstacle[] = [...(V32.obstacles ?? [])];
for (const e of V33_ERWEITERUNGEN) {
  const da = new Set<string>();
  let drin = 0;
  for (const h of V33_HINDERNISSE) {
    if (h.gx >= e.gx && h.gx < e.gx + e.w && h.gy >= e.gy && h.gy < e.gy + e.h) {
      da.add(h.kind);
      drin += 1;
    }
  }
  const fehlt = V33_ARTEN.filter((k) => !da.has(k));
  if (fehlt.length === 0) continue;
  // Was schon da ist, wird angerechnet: dichte Berg-Felder bekommen nur einen
  // Schuss Grün dazu, leeres Neuland die volle Mischung.
  const jetzt = Math.floor((drin * 100) / (e.w * e.h));
  const budget = Math.max(fehlt.length * 3, V33_ZIEL_UNKRAUT - jetzt);
  const proArt = Math.max(3, Math.floor(budget / fehlt.length));
  let saat = 1;
  for (const kind of fehlt) {
    saat += 1;
    V33_HINDERNISSE.push(...wuchern(e, kind, proArt, V33_BELEGT, saat));
  }
}

const V33: Ruleset = {
  ...V32,
  version: 33,
  // Der Hof wird doppelt so breit (52 → 104) UND doppelt so hoch (13 → 26). Das
  // neue Land rechts (gx 52–103) und unten (gy 13–25) ist komplett gesperrt und
  // lässt sich erst nach und nach freimachen (n- und u-Erweiterungen unten).
  grid: { w: 104, h: 26 },
  // Die Prozent-Angabe `place` kann bei 104 Spalten nicht mehr jede Zelle
  // treffen. Darum bekommt jeder Platz ein festes `startCell` — genau die Zelle,
  // auf der er beim alten 52er-Raster stand. So bleibt links alles unverändert,
  // die verdoppelte Breite ist reines Neuland rechts. Die Mine sitzt weiter im
  // Sperrland (Erw. m1, Zelle 47,3).
  plots: V32.plots.map((p) => {
    const q = p.id === 'mine' ? { ...p, place: at(91, 26, 3, 3) } : p;
    if (!q.place) return q;
    const gx = Math.floor((q.place.x * 52) / 100);
    const gy = Math.floor((q.place.y * 13) / 100);
    return { ...q, startCell: { gx, gy } };
  }),
  expansions: V33_ERWEITERUNGEN,
  obstacles: V33_HINDERNISSE,
  items: [
    ...V32.items,
    // Köder wird nicht mehr gekauft (npcBuyPrice 0), sondern im Strandhaus aus
    // Weizen hergestellt (fishing.craft).
    { id: 'bait', storable: true, npcPrice: 0, npcBuyPrice: 0 },
    { id: 'fish-perch', storable: true, npcPrice: 45, npcBuyPrice: 0 },
    { id: 'fish-trout', storable: true, npcPrice: 80, npcBuyPrice: 0 },
    { id: 'fish-carp', storable: true, npcPrice: 130, npcBuyPrice: 0 },
    { id: 'fish-pike', storable: true, npcPrice: 240, npcBuyPrice: 0 },
  ],
  fishing: {
    minLevel: 4,
    bait: BAIT,
    xp: 12,
    table: [
      { item: FISH_PERCH, weight: 50 },
      { item: FISH_TROUT, weight: 28 },
      { item: FISH_CARP, weight: 16 },
      { item: FISH_PIKE, weight: 6 },
    ],
    // Das Boot am Hof steht kaputt da; so macht man es wieder flott.
    repair: [want(GOLD, 250), want(PLANK, 5), want(NAIL, 5)],
    // Köder im Strandhaus herstellen: 2 Weizen → 5 Köder.
    craft: { input: [want(WHEAT, 2)], output: 5 },
  },
  requestTemplates: [
    ...V32.requestTemplates,
    { id: 'perch-order', wants: [want(FISH_PERCH, 3)], reward: gold(170), xp: 34 },
    { id: 'trout-order', wants: [want(FISH_TROUT, 2)], reward: gold(190), xp: 40 },
    { id: 'fish-mix', wants: [want(FISH_PERCH, 2), want(FISH_TROUT, 1)], reward: gold(260), xp: 55 },
    { id: 'pike-order', wants: [want(FISH_PIKE, 1)], reward: gold(300), xp: 62 },
  ],
};

// Für DEV alle Zeiten zehnteln — auch die Apfelbaum-Zeiten, damit man den
// V34: Der Angelsee wird zum Reusen-Spiel. Man legt Köder an eine Angelstelle,
// wartet, und holt den Fang später ab — kein Sofort-Klick mehr. Köder herstellen
// dauert ebenfalls und hat begrenzte Werkbank-Plätze. Dazu Beifang (Dose,
// Seegras), damit nicht jeder Zug ein Fisch ist.
const V34: Ruleset = {
  ...V33,
  version: 34,
  items: [
    ...V33.items,
    { id: 'junk-can', storable: true, npcPrice: 14, npcBuyPrice: 0 },
    { id: 'seaweed', storable: true, npcPrice: 26, npcBuyPrice: 0 },
  ],
  fishing: {
    minLevel: 4,
    bait: BAIT,
    xp: 12,
    // Beifang macht rund ein Drittel aus. Ein voller Korb bringt zwei Züge,
    // es ist also selten alles Müll.
    table: [
      { item: FISH_PERCH, weight: 32 },
      { item: FISH_TROUT, weight: 19 },
      { item: FISH_CARP, weight: 11 },
      { item: FISH_PIKE, weight: 4 },
      { item: SEAWEED, weight: 20 },
      { item: JUNK_CAN, weight: 14 },
    ],
    repair: [want(GOLD, 250), want(PLANK, 5), want(NAIL, 5)],
    // 2 Weizen → 5 Köder, aber erst nach 4 Minuten und nur zwei Sude parallel.
    craft: { input: [want(WHEAT, 2)], output: 5, slots: 2, durationTicks: 240 },
    spots: 5,
    soakTicks: 900,
    catchPerSpot: 2,
  },
  requestTemplates: [
    ...V33.requestTemplates,
    { id: 'seaweed-order', wants: [want(SEAWEED, 4)], reward: gold(180), xp: 36 },
    { id: 'strand-mix', wants: [want(SEAWEED, 2), want(JUNK_CAN, 2)], reward: gold(150), xp: 30 },
  ],
  // Erfolge: dieselben IDs wie bisher, dazu Gruppen und viele neue Ziele. Die
  // alten Kennungen bleiben, damit schon eingelöste Erfolge eingelöst bleiben.
  achievements: [
    // — Hof: Bauwerke —
    { id: 'mill', label: 'Erste Mühle bauen', kind: 'plot', arg: 'mill', gold: 150, xp: 20, group: 'hof' },
    { id: 'coop', label: 'Ersten Hühnerstall bauen', kind: 'plotPrefix', arg: 'coop-', gold: 200, xp: 25, group: 'hof' },
    { id: 'coop2', label: 'Zweiten Hühnerstall bauen', kind: 'plot', arg: 'coop-2', gold: 400, xp: 45, group: 'hof' },
    { id: 'pasture', label: 'Kuhweide bauen', kind: 'plotPrefix', arg: 'pasture-', gold: 300, xp: 35, group: 'hof' },
    { id: 'dairy', label: 'Molkerei bauen', kind: 'plot', arg: 'dairy', gold: 400, xp: 45, group: 'hof' },
    { id: 'grill', label: 'Grill bauen', kind: 'plot', arg: 'grill', gold: 350, xp: 40, group: 'hof' },
    { id: 'oven', label: 'Backofen bauen', kind: 'plot', arg: 'oven', gold: 500, xp: 55, group: 'hof' },
    { id: 'apple', label: 'Apfelbaum pflanzen', kind: 'plotPrefix', arg: 'apple-tree', gold: 300, xp: 40, group: 'hof' },
    { id: 'mine', label: 'Mine im Berg bauen', kind: 'plot', arg: 'mine', gold: 800, xp: 90, group: 'hof' },
    { id: 'forge', label: 'Schmiede bauen', kind: 'plot', arg: 'forge', gold: 1000, xp: 110, group: 'hof' },
    { id: 'plots5', label: 'Fünf Bauwerke stehen', kind: 'plots', arg: 5, gold: 200, xp: 30, group: 'hof' },
    { id: 'plots12', label: 'Zwölf Bauwerke stehen', kind: 'plots', arg: 12, gold: 800, xp: 90, group: 'hof' },
    { id: 'deko3', label: 'Drei Dekorationen aufstellen', kind: 'deko', arg: 3, gold: 150, xp: 20, group: 'hof' },
    { id: 'deko8', label: 'Acht Dekorationen aufstellen', kind: 'deko', arg: 8, gold: 600, xp: 70, group: 'hof' },

    // — Wohlstand: Stufe, Gold, Lager —
    { id: 'lvl3', label: 'Stufe 3 erreichen', kind: 'level', arg: 3, gold: 250, xp: 30, group: 'wohlstand' },
    { id: 'lvl5', label: 'Stufe 5 erreichen', kind: 'level', arg: 5, gold: 400, xp: 50, group: 'wohlstand' },
    { id: 'lvl8', label: 'Stufe 8 erreichen', kind: 'level', arg: 8, gold: 900, xp: 120, group: 'wohlstand' },
    { id: 'lvl15', label: 'Stufe 15 erreichen', kind: 'level', arg: 15, gold: 3000, xp: 350, group: 'wohlstand' },
    { id: 'lvl20', label: 'Stufe 20 erreichen', kind: 'level', arg: 20, gold: 6000, xp: 600, group: 'wohlstand' },
    { id: 'lvl30', label: 'Stufe 30 erreichen', kind: 'level', arg: 30, gold: 15000, xp: 1200, group: 'wohlstand' },
    { id: 'gold1k', label: '1.000 Gold besitzen', kind: 'gold', arg: 1000, gold: 0, xp: 40, group: 'wohlstand' },
    { id: 'gold10k', label: '10.000 Gold besitzen', kind: 'gold', arg: 10000, gold: 0, xp: 200, group: 'wohlstand' },
    { id: 'gold50k', label: '50.000 Gold besitzen', kind: 'gold', arg: 50000, gold: 0, xp: 500, group: 'wohlstand' },
    { id: 'silo2', label: 'Lager zweimal ausbauen', kind: 'silo', arg: 2, gold: 300, xp: 40, group: 'wohlstand' },
    { id: 'silo4', label: 'Lager viermal ausbauen', kind: 'silo', arg: 4, gold: 1200, xp: 130, group: 'wohlstand' },

    // — Land: freimachen und räumen —
    { id: 'expand1', label: 'Erstes Land freimachen', kind: 'expand', arg: 1, gold: 250, xp: 30, group: 'land' },
    { id: 'expand3', label: 'Drei Länder freimachen', kind: 'expand', arg: 3, gold: 900, xp: 100, group: 'land' },
    { id: 'expand6', label: 'Sechs Länder freimachen', kind: 'expand', arg: 6, gold: 2000, xp: 220, group: 'land' },
    { id: 'expand12', label: 'Zwölf Länder freimachen', kind: 'expand', arg: 12, gold: 5000, xp: 500, group: 'land' },
    { id: 'clear10', label: 'Zehn Hindernisse räumen', kind: 'obstacles', arg: 10, gold: 200, xp: 30, group: 'land' },
    { id: 'clear50', label: 'Fünfzig Hindernisse räumen', kind: 'obstacles', arg: 50, gold: 1000, xp: 120, group: 'land' },

    // — Angelsee —
    { id: 'boat', label: 'Das alte Boot reparieren', kind: 'boat', arg: 1, gold: 200, xp: 40, group: 'see' },
    { id: 'fish10', label: 'Zehn Fänge einholen', kind: 'fish', arg: 10, gold: 300, xp: 40, group: 'see' },
    { id: 'fish50', label: 'Fünfzig Fänge einholen', kind: 'fish', arg: 50, gold: 1200, xp: 150, group: 'see' },
    { id: 'fish200', label: 'Zweihundert Fänge einholen', kind: 'fish', arg: 200, gold: 4000, xp: 420, group: 'see' },

    // — Vorrat: was im Lager liegt —
    { id: 'bread20', label: '20 Brote im Lager', kind: 'item', arg: 'bread', menge: 20, gold: 400, xp: 50, group: 'vorrat' },
    { id: 'cheese10', label: '10 Käse im Lager', kind: 'item', arg: 'cheese', menge: 10, gold: 500, xp: 60, group: 'vorrat' },
    { id: 'pie5', label: '5 Apfelkuchen im Lager', kind: 'item', arg: 'apple-pie', menge: 5, gold: 700, xp: 80, group: 'vorrat' },
    { id: 'ironbar10', label: '10 Eisenbarren im Lager', kind: 'item', arg: 'iron-bar', menge: 10, gold: 700, xp: 80, group: 'vorrat' },
    { id: 'goldbar5', label: '5 Goldbarren im Lager', kind: 'item', arg: 'gold-bar', menge: 5, gold: 1500, xp: 160, group: 'vorrat' },
    { id: 'seaweed15', label: '15 Seegras im Lager', kind: 'item', arg: 'seaweed', menge: 15, gold: 350, xp: 45, group: 'vorrat' },
  ],
};

// V35: Angel-Balance. V34 war zu freigiebig — 607 Gold je Viertelstunde
// nebenher, und Köder waren mit 30 Stück Nachschub je Runde bei 5 Stück Bedarf
// faktisch gratis. Jetzt taktet die Ziehzeit den Kreislauf (20 statt 15 min),
// und der Köder ist ein echter Weizen-Verbrauch: 3 Weizen ergeben 2 Köder in
// 10 Minuten, macht 8 Köder je Runde bei 5 Stück Bedarf. Wer plant, hat immer
// genug; wer nicht plant, lässt Stellen leer stehen.
const V35: Ruleset = {
  ...V34,
  version: 35,
  fishing: {
    ...V34.fishing!,
    xp: 10,
    soakTicks: 1200,
    craft: { input: [want(WHEAT, 3)], output: 2, slots: 2, durationTicks: 600 },
  },
};

// V36: Produktionsketten. Drei Befunde aus V35 werden hier behoben.
//
// 1. Werkzeug war eine Sackgasse. Säge, Schaufel, Spitzhacke, Karte, Schlegel,
//    Pflock, Bretter und Nägel kamen AUSSCHLIESSLICH aus Truhen — herstellen
//    ließ sich nichts davon. Wer alles Land freimachen und alle 521 Hindernisse
//    räumen wollte, brauchte 1947 Stück davon, bei einer Truhe alle 7 Minuten
//    mit einem Zug aus neun Sorten. Allein die 365 Karten hätten rund tausend
//    Stunden gedauert. Die 32 Erweiterungen bis Stufe 38 waren damit
//    unerreichbar.
// 2. Barren führten ins Nichts. Mine und Schmiede sind die letzten Gebäude,
//    und ihr Ertrag wurde von keinem Rezept gebraucht.
// 3. Ab Stufe 12 kam nichts Neues mehr, obwohl das Land bis Stufe 38 reicht.
//
// Die Antwort ist eine geschlossene Kette: Bäume geben Holz, das Waldstück
// macht Holz erneuerbar, die Werkstatt verarbeitet Holz und Eisenbarren zu
// genau dem Werkzeug, das Räumen und Erweitern kostet. Truhen bleiben ein
// Bonus statt der einzigen Quelle. Die Räucherei gibt den Fischen aus V34
// endlich einen Zweck, und die Schmiede nimmt die Dosen aus dem See an.
const WOOD = 36;
const SMOKED_FISH = 37;

const R_PLANK = 18;
const R_NAIL = 19;
const R_SAW = 20;
const R_SHOVEL = 21;
const R_PICKAXE = 22;
const R_STAKE = 23;
const R_MALLET = 24;
const R_MAP = 25;
const R_WOOD = 26;
const R_SMOKE_PERCH = 27;
const R_SMOKE_TROUT = 28;
const R_SMOKE_CARP = 29;
const R_SCRAP = 30;

const V36: Ruleset = {
  ...V35,
  version: 36,
  // Die Verdienstkurve lief rückwärts: Der Grill auf Stufe 5 warf mit 44 Gold
  // je Minute mehr ab als alles Spätere. Brot und Apfelkuchen dagegen lohnten
  // sich kaum — der Kuchen brachte über zehn Minuten ganze 24 Gold mehr, als
  // seine Zutaten wert waren. Beides wird hier geradegezogen.
  items: V35.items
    .map((it) =>
      it.id === 'bread'
        ? { ...it, npcPrice: 70 }
        : it.id === 'apple-pie'
          ? { ...it, npcPrice: 210 }
          : it,
    )
    .concat([
      // Holz zählt wie Bretter und Nägel als Material: es belegt keinen
      // Lagerplatz, sonst würde das Räumen der Karte das Lager sprengen.
      { id: 'wood', storable: false, npcPrice: 8, npcBuyPrice: 0 },
      { id: 'smoked-fish', storable: true, npcPrice: 300, npcBuyPrice: 0 },
    ]),

  // Einen Baum zu fällen bringt jetzt Holz. Das macht aus dem reinen Kostenakt
  // den Einstieg in die Werkzeugkette — 176 Bäume geben 528 Holz zum Anfangen.
  obstacleKinds: {
    ...(V35.obstacleKinds ?? {}),
    tree: { ...(V35.obstacleKinds?.tree ?? { tool: SAW, xp: 15 }), ertrag: want(WOOD, 3) },
  },

  recipes: [
    // Das Spiegelei war mit zwei Minuten die stärkste Einnahme im ganzen Spiel,
    // erreichbar auf Stufe 5. Vier Minuten bringen es auf ein Maß, das zu
    // seiner Stelle in der Reihenfolge passt.
    ...V35.recipes.map((r) => (r.id === 'fried-egg' ? { ...r, durationTicks: 240 } : r)),
    { id: 'plank', inputs: [want(WOOD, 2)], output: want(PLANK, 2), durationTicks: 180, xp: 8 },
    { id: 'nail', inputs: [want(IRON_BAR, 1)], output: want(NAIL, 4), durationTicks: 240, xp: 12 },
    { id: 'saw', inputs: [want(PLANK, 1), want(IRON_BAR, 1)], output: want(SAW, 1), durationTicks: 300, xp: 18 },
    { id: 'shovel', inputs: [want(PLANK, 1), want(IRON_BAR, 1)], output: want(SHOVEL, 1), durationTicks: 300, xp: 18 },
    { id: 'pickaxe', inputs: [want(PLANK, 2), want(IRON_BAR, 1)], output: want(PICKAXE, 1), durationTicks: 360, xp: 22 },
    { id: 'stake', inputs: [want(WOOD, 1)], output: want(STAKE, 2), durationTicks: 120, xp: 6 },
    { id: 'mallet', inputs: [want(WOOD, 1), want(IRON_BAR, 1)], output: want(MALLET, 1), durationTicks: 240, xp: 14 },
    { id: 'map', inputs: [want(PLANK, 2), want(IRON_BAR, 1)], output: want(MAP, 1), durationTicks: 480, xp: 26 },
    // Wie beim Weizen bleibt ein Stück als Saat zurück: 1 Holz rein, 3 raus.
    { id: 'wood', inputs: [want(WOOD, 1)], output: want(WOOD, 3), durationTicks: 300, xp: 10 },
    { id: 'smoke-perch', inputs: [want(FISH_PERCH, 2), want(WOOD, 1)], output: want(SMOKED_FISH, 1), durationTicks: 480, xp: 30 },
    { id: 'smoke-trout', inputs: [want(FISH_TROUT, 1), want(WOOD, 1)], output: want(SMOKED_FISH, 1), durationTicks: 480, xp: 30 },
    // Der Karpfen lohnt sich geräuchert doppelt und verbraucht das Seegras,
    // das bisher nur im Lager lag.
    { id: 'smoke-carp', inputs: [want(FISH_CARP, 1), want(SEAWEED, 2)], output: want(SMOKED_FISH, 2), durationTicks: 720, xp: 55 },
    { id: 'scrap', inputs: [want(JUNK_CAN, 4)], output: want(IRON_BAR, 1), durationTicks: 360, xp: 20 },
  ],

  plots: [
    // Die Schmiede lernt, Dosen aus dem See einzuschmelzen.
    ...V35.plots.map((p) =>
      p.id === 'forge'
        ? { ...p, levels: p.levels.map((l) => ({ ...l, recipes: [...l.recipes, R_SCRAP] })) }
        : p,
    ),
    {
      id: 'woodlot',
      startLevel: 0,
      place: at(84, 44, 12, 15),
      startCell: { gx: 4, gy: 1 },
      size: { w: 2, h: 2 },
      levels: [
        {
          label: 'Waldstück',
          cost: [want(PLANK, 8), want(NAIL, 6), want(GOLD, 1200)],
          recipes: [R_WOOD],
          minPlayerLevel: 12,
          slots: 1,
        },
        {
          label: 'Zweite Schneise',
          cost: gold(2400),
          recipes: [R_WOOD],
          minPlayerLevel: 13,
          slots: 2,
        },
      ],
    },
    {
      id: 'workshop',
      startLevel: 0,
      place: at(58, 57, 12, 15),
      startCell: { gx: 9, gy: 1 },
      size: { w: 2, h: 2 },
      levels: [
        {
          label: 'Werkstatt',
          cost: [want(PLANK, 14), want(NAIL, 10), want(GOLD, 3000)],
          recipes: [R_PLANK, R_NAIL, R_STAKE, R_MALLET],
          minPlayerLevel: 13,
          slots: 1,
        },
        {
          label: 'Werkzeugbank',
          cost: [want(PLANK, 10), want(IRON_BAR, 4), want(GOLD, 5500)],
          recipes: [R_PLANK, R_NAIL, R_STAKE, R_MALLET, R_SAW, R_SHOVEL, R_PICKAXE, R_MAP],
          minPlayerLevel: 14,
          slots: 2,
        },
      ],
    },
    {
      id: 'smokehouse',
      startLevel: 0,
      place: at(78, 59, 12, 15),
      startCell: { gx: 10, gy: 4 },
      size: { w: 2, h: 2 },
      levels: [
        {
          label: 'Räucherei',
          cost: [want(PLANK, 18), want(NAIL, 12), want(GOLD, 4500)],
          recipes: [R_SMOKE_PERCH, R_SMOKE_TROUT, R_SMOKE_CARP],
          minPlayerLevel: 15,
          slots: 1,
        },
        {
          label: 'Zweite Kammer',
          cost: gold(7000),
          recipes: [R_SMOKE_PERCH, R_SMOKE_TROUT, R_SMOKE_CARP],
          minPlayerLevel: 16,
          slots: 2,
        },
      ],
    },
  ],

  requestTemplates: [
    ...V35.requestTemplates,
    { id: 'smoked-order', wants: [want(SMOKED_FISH, 2)], reward: gold(620), xp: 110 },
    { id: 'smoked-mix', wants: [want(SMOKED_FISH, 1), want(BROT, 2)], reward: gold(480), xp: 90 },
    { id: 'holz-order', wants: [want(PLANK, 6)], reward: gold(260), xp: 55 },
  ],

  achievements: [
    ...V35.achievements!,
    { id: 'woodlot', label: 'Waldstück anlegen', kind: 'plot', arg: 'woodlot', gold: 600, xp: 70, group: 'hof' },
    { id: 'workshop', label: 'Werkstatt bauen', kind: 'plot', arg: 'workshop', gold: 1200, xp: 130, group: 'hof' },
    { id: 'smokehouse', label: 'Räucherei bauen', kind: 'plot', arg: 'smokehouse', gold: 1600, xp: 170, group: 'hof' },
    { id: 'smoked20', label: '20 Räucherfisch im Lager', kind: 'item', arg: 'smoked-fish', menge: 20, gold: 1400, xp: 150, group: 'vorrat' },
    { id: 'karten5', label: '5 Karten im Vorrat', kind: 'item', arg: 'map', menge: 5, gold: 900, xp: 100, group: 'vorrat' },
  ],
};

// V37: Die zweite Verarbeitungsstufe. Nach V36 endeten immer noch alle
// Lebensmittel im Verkauf — Sahne, Butter, Käse, Brot, Apfelkuchen und
// Spiegelei wurden von keinem Rezept gebraucht. Und ausgerechnet der Hecht,
// der wertvollste Fang, ließ sich als einziger Fisch nicht räuchern.
//
// Die Hofküche nimmt beide Enden auf: Sie macht aus fertigen Waren Gerichte,
// die deutlich mehr wert sind. Damit hat jede Kette im Spiel ein Ziel jenseits
// des Verkaufsstands.
const FARM_PLATTER = 38;
const CREAM_CAKE = 39;

const R_SMOKE_PIKE = 31;
const R_PLATTER_EGG = 32;
const R_PLATTER_CHEESE = 33;
const R_CREAM_CAKE = 34;

const V37: Ruleset = {
  ...V36,
  version: 37,
  items: [
    ...V36.items,
    { id: 'farm-platter', storable: true, npcPrice: 780, npcBuyPrice: 0 },
    { id: 'cream-cake', storable: true, npcPrice: 620, npcBuyPrice: 0 },
  ],

  recipes: [
    ...V36.recipes,
    // Der Hecht fehlte in der Räucherei — der beste Fang war der einzige, für
    // den es dort nichts zu tun gab.
    { id: 'smoke-pike', inputs: [want(FISH_PIKE, 1), want(WOOD, 1)], output: want(SMOKED_FISH, 2), durationTicks: 600, xp: 60 },
    { id: 'platter-egg', inputs: [want(BROT, 1), want(SPIEGELEI, 2), want(BUTTER, 1)], output: want(FARM_PLATTER, 1), durationTicks: 600, xp: 70 },
    { id: 'platter-cheese', inputs: [want(BROT, 2), want(CHEESE, 1)], output: want(FARM_PLATTER, 1), durationTicks: 600, xp: 70 },
    { id: 'cream-cake', inputs: [want(APFELKUCHEN, 1), want(CREAM, 2)], output: want(CREAM_CAKE, 1), durationTicks: 540, xp: 62 },
  ],

  plots: [
    // Die Räucherei lernt den Hecht.
    ...V36.plots.map((p) =>
      p.id === 'smokehouse'
        ? { ...p, levels: p.levels.map((l) => ({ ...l, recipes: [...l.recipes, R_SMOKE_PIKE] })) }
        : p,
    ),
    {
      id: 'kitchen',
      startLevel: 0,
      place: at(38, 60, 12, 15),
      startCell: { gx: 4, gy: 5 },
      size: { w: 2, h: 2 },
      levels: [
        {
          label: 'Hofküche',
          cost: [want(PLANK, 22), want(NAIL, 16), want(GOLD, 6000)],
          recipes: [R_PLATTER_CHEESE, R_CREAM_CAKE],
          minPlayerLevel: 17,
          slots: 1,
        },
        {
          label: 'Zweiter Herd',
          cost: [want(PLANK, 14), want(IRON_BAR, 6), want(GOLD, 9000)],
          recipes: [R_PLATTER_CHEESE, R_CREAM_CAKE, R_PLATTER_EGG],
          minPlayerLevel: 18,
          slots: 2,
        },
      ],
    },
  ],

  requestTemplates: [
    ...V36.requestTemplates,
    { id: 'platter-order', wants: [want(FARM_PLATTER, 1)], reward: gold(1100), xp: 170 },
    { id: 'cake-order', wants: [want(CREAM_CAKE, 2)], reward: gold(1500), xp: 220 },
  ],

  achievements: [
    ...V36.achievements!,
    { id: 'kitchen', label: 'Hofküche bauen', kind: 'plot', arg: 'kitchen', gold: 2200, xp: 230, group: 'hof' },
    { id: 'platter10', label: '10 Bauernbrettl im Lager', kind: 'item', arg: 'farm-platter', menge: 10, gold: 2600, xp: 260, group: 'vorrat' },
  ],
};

// ganzen Lebenszyklus im Feldtest in Sekunden durchspielen kann.
const zehntel = (n: number): number => (Math.floor(n / 10) < 1 ? 1 : Math.floor(n / 10));

// V38: Tagesaufgaben. Das Regelwerk selbst aendert sich inhaltlich nicht — die
// Fassung existiert, damit der Spielstand um die Lebenszeit-Zaehler und den
// Server-Kalendertag wachsen kann (siehe migrate.ts, 37->38).
const V38: Ruleset = { ...V37, version: 38 };

// V39: Der Aufgabentopf. Gezogen wird gewichtet aus dem Kalendertag des
// Servers, deshalb sehen Client und Server ohne Absprache dieselben drei
// Aufgaben. Die Belohnungen liegen bewusst unter dem, was dieselbe Arbeit am
// Verkaufsstand bringt — Aufgaben sollen einen Grund geben, heute
// vorbeizuschauen, nicht die Wirtschaft ersetzen.
const V39: Ruleset = {
  ...V38,
  version: 39,
  aufgabenProTag: 3,
  tagesaufgaben: [
    { id: 'ernte10', label: '10 Plätze abernten', art: 0, menge: 10, gold: 120, xp: 25, gewicht: 10 },
    { id: 'ernte25', label: '25 Plätze abernten', art: 0, menge: 25, gold: 320, xp: 60, gewicht: 6, minLevel: 6 },
    { id: 'saeen12', label: '12 Mal etwas ansetzen', art: 1, menge: 12, gold: 130, xp: 28, gewicht: 10 },
    { id: 'saeen30', label: '30 Mal etwas ansetzen', art: 1, menge: 30, gold: 360, xp: 70, gewicht: 5, minLevel: 8 },
    { id: 'zettel1', label: 'Einen Wagen losschicken', art: 2, menge: 1, gold: 150, xp: 30, gewicht: 9, minLevel: 3 },
    { id: 'zettel3', label: 'Drei Wagen losschicken', art: 2, menge: 3, gold: 480, xp: 95, gewicht: 4, minLevel: 9 },
    { id: 'anfrage2', label: 'Zwei Anfragen erfüllen', art: 3, menge: 2, gold: 200, xp: 40, gewicht: 8, minLevel: 5 },
    { id: 'verkauf15', label: '15 Waren verkaufen', art: 4, menge: 15, gold: 140, xp: 26, gewicht: 9, minLevel: 4 },
    { id: 'gold800', label: '800 Gold einnehmen', art: 5, menge: 800, gold: 180, xp: 35, gewicht: 7, minLevel: 5 },
    { id: 'fisch6', label: 'Sechs Fische einholen', art: 6, menge: 6, gold: 260, xp: 52, gewicht: 6, minLevel: 12 },
    { id: 'raeumen3', label: 'Drei Hindernisse räumen', art: 7, menge: 3, gold: 240, xp: 48, gewicht: 5, minLevel: 7 },
    { id: 'bauen1', label: 'Etwas bauen oder ausbauen', art: 8, menge: 1, gold: 160, xp: 32, gewicht: 6, minLevel: 4 },
  ],
};

// Gewichtete Ziehung ohne Zuruecklegen — dieselbe Lehmer-Folge wie beim Fang.
// Gezogen wird allein aus der Tagesnummer: Alle Hoefe haben an einem Tag
// dieselben Aufgaben, damit man sich darueber austauschen kann. Client und
// Server rechnen es unabhaengig aus, es muss also nichts uebertragen werden.
export function tagesAufgabenFuer(
  rules: Ruleset,
  tag: number,
  spielerLevel: number,
): readonly AufgabeDef[] {
  if (tag <= 0) return [];
  return ziehAufgaben(rules.tagesaufgaben, rules.aufgabenProTag ?? 3, tag, spielerLevel);
}

// Die Woche zieht aus ihrem eigenen Topf mit eigener Saat — sonst haengen
// Wochen- und Tageszettel derselben Zahl an.
export function wochenAufgabenFuer(
  rules: Ruleset,
  woche: number,
  spielerLevel: number,
): readonly AufgabeDef[] {
  if (woche <= 0) return [];
  return ziehAufgaben(rules.wochenaufgaben, rules.aufgabenProWoche ?? 3, woche * 104729 + 31, spielerLevel);
}

// Das Wetter eines Ticks: klar, wolkig oder Regen — festgelegt je Fenster,
// ganzzahlig gehasht, damit Server und Geraet dasselbe sehen. Dieselbe
// Verteilung, die der Himmel vorher nur zur Stimmung zog: 62 % klar, 23 %
// wolkig, 15 % Regen.
export type WetterArt = 'klar' | 'wolkig' | 'regen';
// Feste. Der Wochentag kommt aus dem Servertag: Tag 0 der Epoche war ein
// Donnerstag, darum die Verschiebung um drei — dieselbe wie bei der Woche.
export function wochentagVon(tag: number): number {
  return (((tag + 3) % 7) + 7) % 7;
}

export function festAktiv(rules: Ruleset, tag: number): boolean {
  const f = rules.feste;
  return !!f && tag > 0 && f.arten.length > 0 && f.tage.includes(wochentagVon(tag));
}

// Welche Festart in dieser Serverwoche dran ist — reihum.
export function festArtIndex(rules: Ruleset, woche: number): number {
  const f = rules.feste;
  if (!f || f.arten.length === 0) return -1;
  return ((woche % f.arten.length) + f.arten.length) % f.arten.length;
}

export function festAufgabenFuer(rules: Ruleset, woche: number, spielerLevel: number): readonly AufgabeDef[] {
  const f = rules.feste;
  const art = festArtIndex(rules, woche);
  if (!f || art < 0 || woche <= 0) return [];
  return ziehAufgaben(f.arten[art]!.aufgaben, f.aufgabenProFest, woche * 7907 + 17, spielerLevel);
}

export function wetterBei(rules: Ruleset, tick: number): WetterArt {
  const w = rules.wetter;
  if (!w || w.fensterTicks <= 0) return 'klar';
  const fenster = Math.floor(tick / w.fensterTicks);
  const h = (((fenster * 2654435761) % 100) + 100) % 100;
  if (h < 62) return 'klar';
  if (h < 85) return 'wolkig';
  return 'regen';
}
export function wetterWechselIn(rules: Ruleset, tick: number): number {
  const w = rules.wetter;
  if (!w || w.fensterTicks <= 0) return 0;
  return w.fensterTicks - (tick % w.fensterTicks);
}

function ziehAufgaben(
  topf: readonly AufgabeDef[] | undefined,
  wieViele: number,
  saat: number,
  spielerLevel: number,
): readonly AufgabeDef[] {
  if (!topf || topf.length === 0) return [];

  const offen = topf.filter((a) => (a.minLevel ?? 0) <= spielerLevel);
  if (offen.length === 0) return [];

  const uebrig = offen.slice();
  const raus: AufgabeDef[] = [];
  let h = (1 + ((saat * 7919) % 1000003)) % 1000003;

  while (raus.length < wieViele && uebrig.length > 0) {
    h = (h * 48271) % 2147483647;
    let gesamt = 0;
    for (const a of uebrig) gesamt += a.gewicht;
    let r = h % gesamt;
    let treffer = uebrig.length - 1;
    for (let i = 0; i < uebrig.length; i++) {
      const a = uebrig[i]!;
      if (r < a.gewicht) {
        treffer = i;
        break;
      }
      r -= a.gewicht;
    }
    raus.push(uebrig[treffer]!);
    uebrig.splice(treffer, 1);
  }

  return raus;
}

// V40: Der Tagesabschluss. Drei Zettel sind schnell erzaehlt, aber ohne
// Schlussstrich bleibt der Tag ein Sack voll Einzelaufgaben. Wer alle drei
// abnimmt, schliesst ihn ab und bekommt mehr, als der einzelne Zettel bringt —
// das ist der Grund, den dritten auch noch zu holen, statt nach dem zweiten
// aufzuhoeren. Weiterhin ohne Kaufmoeglichkeit: erarbeiten kann man ihn nur.
const V40: Ruleset = {
  ...V39,
  version: 40,
  tagesAbschluss: { gold: 500, xp: 90 },
};

// V41: Fundstuecke. Ernten ist die haeufigste Handlung im Spiel und war bisher
// immer gleich vorhersagbar. Jetzt liegt hin und wieder etwas im Acker: meist
// ein paar Muenzen, manchmal ein Nagel oder ein Brett. Klein genug, dass es die
// Wirtschaft nicht verschiebt, oft genug, dass sich das naechste Feld lohnt.
// Nichts davon ist kaeuflich, und nichts davon laesst sich erwuerfeln: Der Fund
// steht mit dem Spielstand fest, lange bevor der Finger das Feld beruehrt.
const V41: Ruleset = {
  ...V40,
  version: 41,
  fundstuecke: {
    jede: 8,
    tabelle: [
      { item: GOLD, amount: 25, weight: 34 },
      { item: GOLD, amount: 70, weight: 16 },
      { item: NAIL, amount: 1, weight: 16 },
      { item: PLANK, amount: 1, weight: 14 },
      { item: WOOD, amount: 1, weight: 12 },
      { item: APPLE, amount: 1, weight: 8 },
    ],
  },
};

// V42: Die Woche. Drei Tageszettel sind schnell erzaehlt; der Bogen darueber
// fehlte. Jede Woche (Montag bis Sonntag, Serverzeit) haengen drei grosse
// Zettel am Brett, und wer alle abnimmt, schliesst die Woche ab: Gold, XP und
// die Wochentruhe — eine eigene Kistenart, reicher als alles, was der Hof
// sonst ausspuckt. Die Truhe geht den Weg jeder Kiste: Server wuerfelt, Post,
// Enthuellung. Die Ziele sind auf sieben Tage bemessen, nicht auf einen.
const WOCHENTRUHE = (V41.chestKinds ?? []).length;
const V42: Ruleset = {
  ...V41,
  version: 42,
  chestKinds: [
    ...(V41.chestKinds ?? []),
    {
      id: 'wochentruhe',
      label: 'Wochentruhe',
      picks: 4,
      drops: [
        { item: GOLD, min: 200, max: 600, weight: 20 },
        { item: PLANK, min: 3, max: 6, weight: 18 },
        { item: NAIL, min: 3, max: 5, weight: 18 },
        { item: SAW, min: 1, max: 1, weight: 8 },
        { item: MAP, min: 1, max: 1, weight: 8 },
        { item: MALLET, min: 1, max: 1, weight: 8 },
        { item: STAKE, min: 1, max: 1, weight: 8 },
        { item: EXPLOSIVE, min: 1, max: 1, weight: 6 },
        { item: APPLE, min: 3, max: 6, weight: 6 },
      ],
    },
  ],
  aufgabenProWoche: 3,
  wochenaufgaben: [
    { id: 'w-ernte100', label: '100 Plätze abernten', art: 0, menge: 100, gold: 900, xp: 180, gewicht: 10 },
    { id: 'w-ernte250', label: '250 Plätze abernten', art: 0, menge: 250, gold: 2200, xp: 420, gewicht: 5, minLevel: 8 },
    { id: 'w-saeen120', label: '120 Mal etwas ansetzen', art: 1, menge: 120, gold: 950, xp: 190, gewicht: 10 },
    { id: 'w-zettel8', label: 'Acht Wagen losschicken', art: 2, menge: 8, gold: 1300, xp: 260, gewicht: 8, minLevel: 3 },
    { id: 'w-anfrage10', label: 'Zehn Anfragen erfüllen', art: 3, menge: 10, gold: 1200, xp: 240, gewicht: 7, minLevel: 5 },
    { id: 'w-verkauf80', label: '80 Waren verkaufen', art: 4, menge: 80, gold: 1000, xp: 200, gewicht: 8, minLevel: 4 },
    { id: 'w-gold5000', label: '5.000 Gold einnehmen', art: 5, menge: 5000, gold: 1400, xp: 280, gewicht: 7, minLevel: 6 },
    { id: 'w-fisch25', label: '25 Fische einholen', art: 6, menge: 25, gold: 1300, xp: 260, gewicht: 6, minLevel: 12 },
    { id: 'w-raeumen10', label: 'Zehn Hindernisse räumen', art: 7, menge: 10, gold: 1100, xp: 220, gewicht: 5, minLevel: 7 },
    { id: 'w-bauen3', label: 'Dreimal bauen oder ausbauen', art: 8, menge: 3, gold: 1000, xp: 200, gewicht: 6, minLevel: 4 },
  ],
  wochenAbschluss: { gold: 2500, xp: 400, kiste: WOCHENTRUHE },
};

// V43: Booster. Gold und Waren kann man sich erarbeiten — was fehlte, war eine
// Belohnung, die das Spielen selbst veraendert. Der XP-Verdoppler macht die
// naechste halbe Stunde doppelt wertvoll, der Schnellwuchs schiebt alles, was
// gerade laeuft, um die Haelfte der Restzeit vor. Beide kommen als Fund oder
// aus Kisten, selten, und lassen sich weder kaufen noch verkaufen.
const BOOSTER_XP = 40;
const BOOSTER_WUCHS = 41;
const V43: Ruleset = {
  ...V42,
  version: 43,
  items: [
    ...V42.items,
    { id: 'booster-xp', storable: false, npcPrice: 0, npcBuyPrice: 0 },
    { id: 'booster-wuchs', storable: false, npcPrice: 0, npcBuyPrice: 0 },
  ],
  booster: { xpItem: BOOSTER_XP, xpTicks: 1800, wuchsItem: BOOSTER_WUCHS, wuchsProzent: 50 },
  fundstuecke: {
    jede: V42.fundstuecke!.jede,
    tabelle: [
      ...V42.fundstuecke!.tabelle,
      { item: BOOSTER_XP, amount: 1, weight: 3 },
      { item: BOOSTER_WUCHS, amount: 1, weight: 3 },
    ],
  },
  chestKinds: (V42.chestKinds ?? []).map((k) => ({
    ...k,
    drops: [
      ...k.drops,
      { item: BOOSTER_XP, min: 1, max: 1, weight: 3 },
      { item: BOOSTER_WUCHS, min: 1, max: 1, weight: 3 },
    ],
  })),
};

// V44: Wetter mit Wirkung. Der Himmel ueber dem Hof war Stimmung — jetzt tut
// er etwas: Wer bei Regen saet, dessen Saat bekommt ein Fuenftel der Zeit
// geschenkt. Nur auf Feldern; Staelle und Werkstaetten kuemmert der Regen
// nicht. Das Wetter kommt aus dem Tick, nicht aus der Geraeteuhr — Server und
// Geraet sehen dasselbe, und niemand kann sich Regen bestellen.
const V44: Ruleset = {
  ...V43,
  version: 44,
  wetter: {
    fensterTicks: 1200,
    regenSchubProzent: 20,
    plaetze: V43.plots.map((p, i) => (p.id.indexOf('field-') === 0 ? i : -1)).filter((i) => i >= 0),
  },
};

// V45: Schafe. Ein drittes Tier mit eigener Kette: Die Schafweide gibt Wolle
// (gefuettert mit Mais), die Weberei spinnt Garn und strickt Pullover — das
// Ende der Kette, wertvoll wie ein Kaese. Dazu Zettel, die Wolle und Garn
// verlangen, und Erfolge fuer Weide, Weberei und den ersten Stapel Pullover.
const WOOL = 42;
const YARN = 43;
const SWEATER = 44;
const R_WOOL = 35;
const R_YARN = 36;
const R_SWEATER = 37;
const V45: Ruleset = {
  ...V44,
  version: 45,
  items: [
    ...V44.items,
    { id: 'wool', storable: true, npcPrice: 34, npcBuyPrice: 0 },
    { id: 'yarn', storable: true, npcPrice: 120, npcBuyPrice: 0 },
    { id: 'sweater', storable: true, npcPrice: 520, npcBuyPrice: 0 },
  ],
  recipes: [
    ...V44.recipes,
    { id: 'wool', inputs: [want(CORN, 2)], output: want(WOOL, 2), durationTicks: 600, xp: 20 },
    { id: 'yarn', inputs: [want(WOOL, 2)], output: want(YARN, 1), durationTicks: 480, xp: 24, minPlayerLevel: 11 },
    { id: 'sweater', inputs: [want(YARN, 3), want(WOOL, 1)], output: want(SWEATER, 1), durationTicks: 1500, xp: 70, minPlayerLevel: 12 },
  ],
  plots: [
    ...V44.plots,
    {
      id: 'sheep-1',
      startLevel: 0,
      place: at(91, 62, 9, 13),
      size: { w: 2, h: 2 },
      animal: { cost: 600, growTicks: 1200 },
      levels: [
        { label: 'Schafweide', cost: gold(2600), recipes: [R_WOOL], minPlayerLevel: 9, slots: 2 },
        { label: 'Dritter Platz', cost: gold(1600), recipes: [R_WOOL], slots: 3 },
      ],
    },
    {
      id: 'weberei',
      startLevel: 0,
      place: at(50, 63, 8, 15),
      size: { w: 2, h: 2 },
      levels: [
        {
          label: 'Weberei',
          cost: [want(PLANK, 12), want(NAIL, 8), want(GOLD, 3200)],
          recipes: [R_YARN, R_SWEATER],
          minPlayerLevel: 11,
          slots: 1,
        },
        { label: 'Zweiter Webstuhl', cost: [want(PLANK, 10), want(GOLD, 4800)], recipes: [R_YARN, R_SWEATER], minPlayerLevel: 13, slots: 2 },
      ],
    },
  ],
  requestTemplates: [
    ...V44.requestTemplates,
    { id: 'wolle-klein', wants: [want(WOOL, 4)], reward: gold(220), xp: 40 },
    { id: 'garn', wants: [want(YARN, 2)], reward: gold(420), xp: 72 },
    { id: 'pullover', wants: [want(SWEATER, 1)], reward: gold(900), xp: 140 },
  ],
  achievements: [
    ...(V44.achievements ?? []),
    { id: 'sheep', label: 'Schafweide bauen', kind: 'plotPrefix', arg: 'sheep-', gold: 700, xp: 80, group: 'hof' },
    { id: 'weberei', label: 'Weberei bauen', kind: 'plot', arg: 'weberei', gold: 1400, xp: 150, group: 'hof' },
    { id: 'sweater5', label: 'Fünf Pullover im Lager', kind: 'item', arg: 'sweater', menge: 5, gold: 1800, xp: 200, group: 'vorrat' },
  ],
  wetter: {
    ...V44.wetter!,
    plaetze: V44.wetter!.plaetze,
  },
};

// Schafe fressen wie Hühner und Kühe: Futter aus der Mühle, nicht rohes Korn.
// Schaffutter braucht Weizen UND Mais — der teuerste Futtersack, für die
// teuerste Wolle.
const SHEEP_FEED = 45;
const R_SHEEP_FEED = 38;

const V46: Ruleset = {
  ...V45,
  version: 46,
  items: [...V45.items, { id: 'sheep-feed', storable: true, npcPrice: 14, npcBuyPrice: 0 }],
  recipes: [
    ...V45.recipes.map((r, i) => (i === R_WOOL ? { ...r, inputs: [want(SHEEP_FEED, 1)] } : r)),
    {
      id: 'sheep-feed',
      inputs: [want(WHEAT, 2), want(CORN, 2)],
      output: want(SHEEP_FEED, 2),
      durationTicks: 360,
      xp: 9,
      minPlayerLevel: 9,
    },
  ],
  plots: V45.plots.map((p) =>
    p.id === 'mill'
      ? { ...p, levels: p.levels.map((l) => ({ ...l, recipes: [...l.recipes, R_SHEEP_FEED] })) }
      : p,
  ),
  requestTemplates: [
    ...V45.requestTemplates,
    { id: 'schaffutter', wants: [want(SHEEP_FEED, 4)], reward: gold(100), xp: 26 },
  ],
  wetter: {
    ...V45.wetter!,
    plaetze: V45.wetter!.plaetze,
  },
};

// Meisterschaft: Sterne für Werkstätten und Ställe. Die Grenzen sind in
// Abholungen, nicht in Stücken — so braucht jedes Gebäude gleich viele
// Durchläufe, ob es zwei Säcke oder einen Pullover je Lauf hergibt.
const V47: Ruleset = {
  ...V46,
  version: 47,
  meisterschaft: { stufen: [25, 100, 300], schnellerProzent: 10, xpProzent: 50, extraJede: 5 },
  achievements: [
    ...(V46.achievements ?? []),
    { id: 'stern1', label: 'Ersten Meisterstern verdienen', kind: 'sterne', arg: 1, gold: 300, xp: 40, group: 'meister' },
    { id: 'sterne5', label: 'Fünf Meistersterne verdienen', kind: 'sterne', arg: 5, gold: 1200, xp: 150, group: 'meister' },
    { id: 'meister1', label: 'Ein Gebäude ganz gemeistert', kind: 'meister', arg: 1, gold: 2500, xp: 300, group: 'meister' },
    { id: 'sterne15', label: 'Fünfzehn Meistersterne verdienen', kind: 'sterne', arg: 15, gold: 4000, xp: 500, group: 'meister' },
    { id: 'meister5', label: 'Fünf Gebäude ganz gemeistert', kind: 'meister', arg: 5, gold: 9000, xp: 1200, group: 'meister' },
  ],
  wetter: {
    ...V46.wetter!,
    plaetze: V46.wetter!.plaetze,
  },
};

// V48: Feste. Jedes Wochenende ein Fest mit eigenem Thema — Ernte, Fischen,
// Markt, Bauen —, drei Festzetteln, einer Festtruhe und einer Deko, die es
// sonst nirgends gibt. Das Fest hängt am Servertag: Alle Höfe feiern dasselbe.
// Fest-Deko: ohne Preis, weil es sie nicht zu kaufen gibt — sie kommt
// eingepackt vom Fest und wird dann wie jede eingepackte Deko aufgestellt.
const festDeko = (id: string, label: string, place: PlotPlace): PlotDef => ({
  id,
  startLevel: 0,
  place,
  size: { w: 1, h: 1 },
  deco: true,
  nurFest: true,
  levels: [{ label, cost: [], recipes: [], minPlayerLevel: 1 }],
});
const FESTTRUHE = (V47.chestKinds ?? []).length;
const FEST_DEKO = V47.plots.length;
const V48: Ruleset = {
  ...V47,
  version: 48,
  plots: [
    ...V47.plots,
    festDeko('deco-erntekranz', 'Erntekranz', at(66, 0, 8, 10)),
    festDeko('deco-boje', 'Boje', at(74, 0, 8, 10)),
    festDeko('deco-marktfahne', 'Marktfahne', at(82, 0, 8, 10)),
    festDeko('deco-laterne', 'Laterne', at(90, 0, 8, 10)),
  ],
  chestKinds: [
    ...(V47.chestKinds ?? []),
    {
      id: 'festtruhe',
      label: 'Festtruhe',
      picks: 4,
      drops: [
        { item: GOLD, min: 400, max: 900, weight: 20 },
        { item: PLANK, min: 4, max: 8, weight: 14 },
        { item: NAIL, min: 4, max: 8, weight: 14 },
        { item: BOOSTER_XP, min: 1, max: 1, weight: 12 },
        { item: BOOSTER_WUCHS, min: 1, max: 1, weight: 12 },
        { item: SAW, min: 1, max: 1, weight: 6 },
        { item: MAP, min: 1, max: 1, weight: 6 },
        { item: MALLET, min: 1, max: 1, weight: 6 },
        { item: STAKE, min: 1, max: 1, weight: 6 },
        { item: APPLE, min: 4, max: 8, weight: 6 },
      ],
    },
  ],
  feste: {
    tage: [4, 5, 6],
    aufgabenProFest: 3,
    abschluss: { gold: 1500, xp: 300, kiste: FESTTRUHE },
    arten: [
      {
        id: 'erntefest',
        label: 'Erntefest',
        deko: FEST_DEKO,
        aufgaben: [
          { id: 'f-ernte60', label: '60 Plätze abernten', art: 0, menge: 60, gold: 700, xp: 140, gewicht: 10 },
          { id: 'f-ernte150', label: '150 Plätze abernten', art: 0, menge: 150, gold: 1800, xp: 360, gewicht: 5, minLevel: 8 },
          { id: 'f-saeen80', label: '80 Mal etwas ansetzen', art: 1, menge: 80, gold: 750, xp: 150, gewicht: 10 },
          { id: 'f-verkauf40', label: '40 Waren verkaufen', art: 4, menge: 40, gold: 600, xp: 120, gewicht: 6, minLevel: 4 },
          { id: 'f-zettel4', label: 'Vier Wagen losschicken', art: 2, menge: 4, gold: 800, xp: 160, gewicht: 6, minLevel: 3 },
        ],
      },
      {
        id: 'fischerfest',
        label: 'Fischerfest',
        deko: FEST_DEKO + 1,
        aufgaben: [
          { id: 'f-fisch12', label: 'Zwölf Fische einholen', art: 6, menge: 12, gold: 900, xp: 180, gewicht: 10, minLevel: 12 },
          { id: 'f-fisch30', label: '30 Fische einholen', art: 6, menge: 30, gold: 2000, xp: 400, gewicht: 5, minLevel: 14 },
          { id: 'f-verkauf50', label: '50 Waren verkaufen', art: 4, menge: 50, gold: 700, xp: 140, gewicht: 8 },
          { id: 'f-gold2500', label: '2.500 Gold einnehmen', art: 5, menge: 2500, gold: 900, xp: 180, gewicht: 7, minLevel: 6 },
          { id: 'f-ernte80', label: '80 Plätze abernten', art: 0, menge: 80, gold: 800, xp: 160, gewicht: 8 },
        ],
      },
      {
        id: 'markttag',
        label: 'Markttag',
        deko: FEST_DEKO + 2,
        aufgaben: [
          { id: 'f-verkauf60', label: '60 Waren verkaufen', art: 4, menge: 60, gold: 800, xp: 160, gewicht: 10, minLevel: 4 },
          { id: 'f-gold3000', label: '3.000 Gold einnehmen', art: 5, menge: 3000, gold: 1000, xp: 200, gewicht: 8, minLevel: 6 },
          { id: 'f-zettel5', label: 'Fünf Wagen losschicken', art: 2, menge: 5, gold: 900, xp: 180, gewicht: 8, minLevel: 3 },
          { id: 'f-anfrage6', label: 'Sechs Anfragen erfüllen', art: 3, menge: 6, gold: 900, xp: 180, gewicht: 7, minLevel: 5 },
          { id: 'f-ernte70', label: '70 Plätze abernten', art: 0, menge: 70, gold: 700, xp: 140, gewicht: 8 },
        ],
      },
      {
        id: 'baufest',
        label: 'Baufest',
        deko: FEST_DEKO + 3,
        aufgaben: [
          { id: 'f-bauen2', label: 'Zweimal bauen oder ausbauen', art: 8, menge: 2, gold: 900, xp: 180, gewicht: 8, minLevel: 4 },
          { id: 'f-raeumen6', label: 'Sechs Hindernisse räumen', art: 7, menge: 6, gold: 900, xp: 180, gewicht: 8, minLevel: 7 },
          { id: 'f-saeen100', label: '100 Mal etwas ansetzen', art: 1, menge: 100, gold: 900, xp: 180, gewicht: 8 },
          { id: 'f-ernte90', label: '90 Plätze abernten', art: 0, menge: 90, gold: 800, xp: 160, gewicht: 8 },
          { id: 'f-gold2000', label: '2.000 Gold einnehmen', art: 5, menge: 2000, gold: 800, xp: 160, gewicht: 6, minLevel: 6 },
        ],
      },
    ],
  },
  achievements: [
    ...(V47.achievements ?? []),
    { id: 'fest1', label: 'Erstes Fest abschließen', kind: 'feste', arg: 1, gold: 600, xp: 80, group: 'hof' },
    { id: 'fest4', label: 'Vier Feste abschließen', kind: 'feste', arg: 4, gold: 2500, xp: 300, group: 'hof' },
    { id: 'fest12', label: 'Zwölf Feste abschließen', kind: 'feste', arg: 12, gold: 8000, xp: 900, group: 'hof' },
  ],
  wetter: {
    ...V47.wetter!,
    plaetze: V47.wetter!.plaetze,
  },
};

// V49: Mehr Erfolge — und Reihen. Fleiß (Ernten, Ansetzen), Handel (Verkäufe,
// Wagen, Anfragen, Einnahmen), Tiere, Treue (Tages- und Wochenabschlüsse),
// obere Stufen. Erfolge derselben Reihe zeigt die Oberfläche nacheinander.
const REIHEN: Record<string, string> = {
  lvl3: 'stufe', lvl5: 'stufe', lvl8: 'stufe', lvl15: 'stufe', lvl20: 'stufe', lvl30: 'stufe',
  gold1k: 'gold', gold10k: 'gold', gold50k: 'gold',
  silo2: 'lager', silo4: 'lager',
  expand1: 'land', expand3: 'land', expand6: 'land', expand12: 'land',
  clear10: 'raeumen', clear50: 'raeumen',
  fish10: 'fische', fish50: 'fische', fish200: 'fische',
  plots5: 'bauwerke', plots12: 'bauwerke',
  deko3: 'deko', deko8: 'deko',
  coop: 'staelle', coop2: 'staelle',
  stern1: 'sterne', sterne5: 'sterne', sterne15: 'sterne',
  meister1: 'meister', meister5: 'meister',
  fest1: 'feste', fest4: 'feste', fest12: 'feste',
};
const ZAEHLER_ERNTEN = 0;
const ZAEHLER_STARTEN = 1;
const ZAEHLER_ZETTEL = 2;
const ZAEHLER_KISTEN = 3;
const ZAEHLER_VERKAUFT = 4;
const ZAEHLER_GOLD = 5;
const ZAEHLER_GEBAUT = 8;
// „Anfragen erfuellen" zaehlte einen Befehl, den es seit Brett und Wagen nicht
// mehr gibt — solche Zettel waren unerfuellbar. Jetzt zaehlt der Platz Kisten.
// „Waren verkaufen" zaehlt verkaufte Kaestchen am Stand; das steht jetzt so da,
// und die Zahlen passen zu Kaestchen statt zu Stueck.
const KAESTCHEN_ZIEL: Record<string, number> = {
  verkauf15: 5, 'w-verkauf80': 25, 'f-verkauf40': 12, 'f-verkauf50': 15, 'f-verkauf60': 18,
};
const ZAHLWORT: Record<number, string> = { 5: 'Fünf', 12: 'Zwölf', 15: 'Fünfzehn', 18: 'Achtzehn', 25: 'Fünfundzwanzig' };
const zettelKlar = (t: AufgabeDef): AufgabeDef => {
  if (t.art === ZAEHLER_KISTEN) return { ...t, label: t.label.replace('Anfragen erfüllen', 'Kisten öffnen') };
  if (t.art === ZAEHLER_VERKAUFT && KAESTCHEN_ZIEL[t.id] !== undefined) {
    const menge = KAESTCHEN_ZIEL[t.id]!;
    return { ...t, menge, label: `${ZAHLWORT[menge] ?? menge} Kästchen am Stand verkaufen` };
  }
  return t;
};
const V49: Ruleset = {
  ...V48,
  version: 49,
  kistenZaehlen: true,
  tagesaufgaben: (V48.tagesaufgaben ?? []).map(zettelKlar),
  wochenaufgaben: (V48.wochenaufgaben ?? []).map(zettelKlar),
  feste: {
    ...V48.feste!,
    arten: V48.feste!.arten.map((a) => ({ ...a, aufgaben: a.aufgaben.map(zettelKlar) })),
  },
  achievements: [
    ...(V48.achievements ?? []).map((a) => ({
      ...a,
      reihe: REIHEN[a.id],
      // Die Feste ziehen zur Treue um — dort stehen die anderen Wiederkehr-Erfolge.
      group: a.kind === 'feste' ? ('treue' as AchievementGroup) : a.group,
    })),
    // Hof
    { id: 'baeume3', label: 'Drei Apfelbäume pflanzen', kind: 'plotPrefixCount', arg: 'apple-tree', menge: 3, gold: 700, xp: 80, group: 'hof', reihe: 'apfel' },
    { id: 'plots20', label: 'Zwanzig Bauwerke stehen', kind: 'plots', arg: 20, gold: 2500, xp: 280, group: 'hof', reihe: 'bauwerke' },
    { id: 'deko15', label: 'Fünfzehn Dekorationen aufstellen', kind: 'deko', arg: 15, gold: 1500, xp: 170, group: 'hof', reihe: 'deko' },
    { id: 'tiere5', label: 'Fünf Tiere halten', kind: 'tiere', arg: 5, gold: 300, xp: 40, group: 'hof', reihe: 'tiere' },
    { id: 'tiere15', label: 'Fünfzehn Tiere halten', kind: 'tiere', arg: 15, gold: 1200, xp: 150, group: 'hof', reihe: 'tiere' },
    { id: 'tiere30', label: 'Dreißig Tiere halten', kind: 'tiere', arg: 30, gold: 3000, xp: 350, group: 'hof', reihe: 'tiere' },
    // Fleiß
    { id: 'ernte100', label: 'Hundert Plätze abernten', kind: 'zaehler', arg: ZAEHLER_ERNTEN, menge: 100, gold: 200, xp: 30, group: 'fleiss', reihe: 'ernte' },
    { id: 'ernte1000', label: 'Tausend Plätze abernten', kind: 'zaehler', arg: ZAEHLER_ERNTEN, menge: 1000, gold: 1500, xp: 180, group: 'fleiss', reihe: 'ernte' },
    { id: 'ernte10000', label: 'Zehntausend Plätze abernten', kind: 'zaehler', arg: ZAEHLER_ERNTEN, menge: 10000, gold: 8000, xp: 900, group: 'fleiss', reihe: 'ernte' },
    { id: 'saeen500', label: 'Fünfhundert Mal etwas ansetzen', kind: 'zaehler', arg: ZAEHLER_STARTEN, menge: 500, gold: 900, xp: 110, group: 'fleiss', reihe: 'saeen' },
    { id: 'saeen5000', label: 'Fünftausend Mal etwas ansetzen', kind: 'zaehler', arg: ZAEHLER_STARTEN, menge: 5000, gold: 6000, xp: 700, group: 'fleiss', reihe: 'saeen' },
    { id: 'bauen25', label: 'Fünfundzwanzig Mal bauen oder ausbauen', kind: 'zaehler', arg: ZAEHLER_GEBAUT, menge: 25, gold: 1500, xp: 180, group: 'fleiss', reihe: 'bauen' },
    { id: 'bauen60', label: 'Sechzig Mal bauen oder ausbauen', kind: 'zaehler', arg: ZAEHLER_GEBAUT, menge: 60, gold: 5000, xp: 550, group: 'fleiss', reihe: 'bauen' },
    // Handel
    { id: 'verkauf50', label: 'Fünfzig Kästchen am Stand verkaufen', kind: 'zaehler', arg: ZAEHLER_VERKAUFT, menge: 50, gold: 400, xp: 50, group: 'handel', reihe: 'verkauf' },
    { id: 'verkauf300', label: 'Dreihundert Kästchen am Stand verkaufen', kind: 'zaehler', arg: ZAEHLER_VERKAUFT, menge: 300, gold: 2500, xp: 300, group: 'handel', reihe: 'verkauf' },
    { id: 'verkauf1500', label: 'Fünfzehnhundert Kästchen am Stand verkaufen', kind: 'zaehler', arg: ZAEHLER_VERKAUFT, menge: 1500, gold: 12000, xp: 1300, group: 'handel', reihe: 'verkauf' },
    { id: 'zettel25', label: 'Fünfundzwanzig Wagen losschicken', kind: 'zaehler', arg: ZAEHLER_ZETTEL, menge: 25, gold: 600, xp: 70, group: 'handel', reihe: 'wagen' },
    { id: 'zettel200', label: 'Zweihundert Wagen losschicken', kind: 'zaehler', arg: ZAEHLER_ZETTEL, menge: 200, gold: 4000, xp: 450, group: 'handel', reihe: 'wagen' },
    { id: 'kisten50', label: 'Fünfzig Kisten öffnen', kind: 'zaehler', arg: ZAEHLER_KISTEN, menge: 50, gold: 800, xp: 90, group: 'handel', reihe: 'kisten' },
    { id: 'kisten300', label: 'Dreihundert Kisten öffnen', kind: 'zaehler', arg: ZAEHLER_KISTEN, menge: 300, gold: 4000, xp: 450, group: 'handel', reihe: 'kisten' },
    { id: 'einnahme10k', label: 'Zehntausend Gold einnehmen', kind: 'zaehler', arg: ZAEHLER_GOLD, menge: 10000, gold: 500, xp: 70, group: 'handel', reihe: 'einnahmen' },
    { id: 'einnahme100k', label: 'Hunderttausend Gold einnehmen', kind: 'zaehler', arg: ZAEHLER_GOLD, menge: 100000, gold: 3000, xp: 400, group: 'handel', reihe: 'einnahmen' },
    { id: 'einnahme1m', label: 'Eine Million Gold einnehmen', kind: 'zaehler', arg: ZAEHLER_GOLD, menge: 1000000, gold: 20000, xp: 2000, group: 'handel', reihe: 'einnahmen' },
    // Wohlstand
    { id: 'lvl40', label: 'Stufe 40 erreichen', kind: 'level', arg: 40, gold: 30000, xp: 2000, group: 'wohlstand', reihe: 'stufe' },
    { id: 'lvl50', label: 'Stufe 50 erreichen', kind: 'level', arg: 50, gold: 60000, xp: 3500, group: 'wohlstand', reihe: 'stufe' },
    { id: 'gold200k', label: '200.000 Gold besitzen', kind: 'gold', arg: 200000, gold: 0, xp: 1200, group: 'wohlstand', reihe: 'gold' },
    { id: 'silo6', label: 'Lager sechsmal ausbauen', kind: 'silo', arg: 6, gold: 3000, xp: 320, group: 'wohlstand', reihe: 'lager' },
    // Land
    { id: 'expand20', label: 'Zwanzig Länder freimachen', kind: 'expand', arg: 20, gold: 10000, xp: 900, group: 'land', reihe: 'land' },
    { id: 'clear150', label: 'Hundertfünfzig Hindernisse räumen', kind: 'obstacles', arg: 150, gold: 3000, xp: 320, group: 'land', reihe: 'raeumen' },
    // See
    { id: 'fish500', label: 'Fünfhundert Fänge einholen', kind: 'fish', arg: 500, gold: 9000, xp: 900, group: 'see', reihe: 'fische' },
    { id: 'pike3', label: '3 Hechte im Lager', kind: 'item', arg: 'fish-pike', menge: 3, gold: 900, xp: 100, group: 'see' },
    // Vorrat
    { id: 'eggs50', label: '50 Eier im Lager', kind: 'item', arg: 'eggs', menge: 50, gold: 300, xp: 40, group: 'vorrat' },
    { id: 'milk30', label: '30 Milch im Lager', kind: 'item', arg: 'milk', menge: 30, gold: 300, xp: 40, group: 'vorrat' },
    { id: 'flour30', label: '30 Mehl im Lager', kind: 'item', arg: 'flour', menge: 30, gold: 300, xp: 40, group: 'vorrat' },
    { id: 'butter10', label: '10 Butter im Lager', kind: 'item', arg: 'butter', menge: 10, gold: 500, xp: 60, group: 'vorrat' },
    { id: 'wool30', label: '30 Wolle im Lager', kind: 'item', arg: 'wool', menge: 30, gold: 600, xp: 70, group: 'vorrat' },
    { id: 'yarn10', label: '10 Garn im Lager', kind: 'item', arg: 'yarn', menge: 10, gold: 900, xp: 100, group: 'vorrat' },
    { id: 'torte5', label: '5 Sahnetorten im Lager', kind: 'item', arg: 'cream-cake', menge: 5, gold: 1800, xp: 200, group: 'vorrat' },
    // Meisterschaft
    { id: 'sterne30', label: 'Dreißig Meistersterne verdienen', kind: 'sterne', arg: 30, gold: 8000, xp: 900, group: 'meister', reihe: 'sterne' },
    { id: 'meister10', label: 'Zehn Gebäude ganz gemeistert', kind: 'meister', arg: 10, gold: 18000, xp: 2000, group: 'meister', reihe: 'meister' },
    // Treue
    { id: 'tage7', label: 'Sieben Tagesabschlüsse', kind: 'tage', arg: 7, gold: 800, xp: 100, group: 'treue', reihe: 'tage' },
    { id: 'tage30', label: 'Dreißig Tagesabschlüsse', kind: 'tage', arg: 30, gold: 3000, xp: 350, group: 'treue', reihe: 'tage' },
    { id: 'tage100', label: 'Hundert Tagesabschlüsse', kind: 'tage', arg: 100, gold: 10000, xp: 1000, group: 'treue', reihe: 'tage' },
    { id: 'wochen4', label: 'Vier Wochenabschlüsse', kind: 'wochen', arg: 4, gold: 3000, xp: 350, group: 'treue', reihe: 'wochen' },
    { id: 'wochen12', label: 'Zwölf Wochenabschlüsse', kind: 'wochen', arg: 12, gold: 9000, xp: 900, group: 'treue', reihe: 'wochen' },
  ],
  wetter: {
    ...V48.wetter!,
    plaetze: V48.wetter!.plaetze,
  },
};

const DEV: Ruleset = {
  ...V49,
  // Im Feldtest ist jeden Tag Fest, und die Festzettel sind ein Zehntel so lang.
  feste: {
    ...V49.feste!,
    tage: [0, 1, 2, 3, 4, 5, 6],
    arten: V49.feste!.arten.map((a) => ({
      ...a,
      aufgaben: a.aufgaben.map((t) => ({ ...t, menge: zehntel(t.menge) })),
    })),
  },
  // Im Feldtest sollen Sterne in Minuten kommen, nicht in Tagen.
  meisterschaft: { ...V49.meisterschaft!, stufen: [3, 8, 20] },
  version: 1001,
  requestSkipCooldownTicks: 60,
  truckAwayTicks: 9,
  chestEveryTicks: 60,
  recipes: V49.recipes.map((r) => ({ ...r, durationTicks: zehntel(r.durationTicks) })),
  // Im Feldtest soll der ganze Angel-Kreislauf in Sekunden durchlaufen, nicht
  // in Minuten — sonst dauert eine Prüfung länger als der Rest zusammen.
  fishing: {
    ...V49.fishing!,
    soakTicks: 20,
    craft: { ...V35.fishing!.craft!, durationTicks: 10 },
  },
  // Auf den Plaetzen der neuesten Fassung aufsetzen, damit DEV alles erbt.
  plots: V49.plots.map((p) => {
    let q = p;
    if (p.animal) q = { ...q, animal: { ...p.animal, growTicks: zehntel(p.animal.growTicks) } };
    if (p.baum) {
      q = {
        ...q,
        baum: {
          ...p.baum,
          setzlingTicks: zehntel(p.baum.setzlingTicks),
          reifeTicks: zehntel(p.baum.reifeTicks),
        },
      };
    }
    return q;
  }),
};

export const RULESETS: ReadonlyMap<number, Ruleset> = new Map([
  [1, V1],
  [2, V2],
  [3, V3],
  [4, V4],
  [5, V5],
  [6, V6],
  [7, V7],
  [8, V8],
  [9, V9],
  [10, V10],
  [11, V11],
  [12, V12],
  [13, V13],
  [14, V14],
  [15, V15],
  [16, V16],
  [17, V17],
  [18, V18],
  [19, V19],
  [20, V20],
  [21, V21],
  [22, V22],
  [23, V23],
  [24, V24],
  [25, V25],
  [26, V26],
  [27, V27],
  [28, V28],
  [29, V29],
  [30, V30],
  [31, V31],
  [32, V32],
  [33, V33],
  [34, V34],
  [35, V35],
  [36, V36],
  [37, V37],
  [38, V38],
  [39, V39],
  [40, V40],
  [41, V41],
  [42, V42],
  [43, V43],
  [44, V44],
  [45, V45],
  [46, V46],
  [47, V47],
  [48, V48],
  [49, V49],
  [1001, DEV],
]);

export const PRODUCTION_VERSIONS: readonly number[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
  28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49,
];

export const CURRENT_RULESET_VERSION = 1;

export const LATEST_RULESET_VERSION = 49;

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

export function sizeOf(rules: Ruleset, plot: number): PlotSize {
  return rules.plots[plot]?.size ?? { w: 1, h: 1 };
}

export function gridOf(rules: Ruleset): GridDef | null {
  return rules.grid ?? null;
}

function ueberlappt(
  gx: number,
  gy: number,
  w: number,
  h: number,
  ox: number,
  oy: number,
  ow: number,
  oh: number,
): boolean {
  const frei = gx + w <= ox || ox + ow <= gx || gy + h <= oy || oy + oh <= gy;
  return !frei;
}

export function blockiert(
  rules: Ruleset,
  gx: number,
  gy: number,
  w: number,
  h: number,
  geraeumt: readonly number[] = [],
  expandiert: readonly string[] = [],
): boolean {
  for (const [i, hindernis] of (rules.obstacles ?? []).entries()) {
    if (geraeumt.includes(i)) continue;
    if (ueberlappt(gx, gy, w, h, hindernis.gx, hindernis.gy, hindernis.w, hindernis.h)) return true;
  }
  for (const feld of rules.expansions ?? []) {
    if (expandiert.includes(feld.id)) continue;
    if (ueberlappt(gx, gy, w, h, feld.gx, feld.gy, feld.w, feld.h)) return true;
  }
  return false;
}

export function expansionAffordable(
  rules: Ruleset,
  feld: Expansion,
  level: number,
  hat: (item: number) => number,
): boolean {
  return level >= feld.minLevel && feld.cost.every((c) => hat(c.item) >= c.amount);
}

// Ein Hindernis in einer noch gesperrten Erweiterung ist verborgen: es zeigt
// sich (und lässt sich wegräumen) erst, wenn das Land freigeschaltet ist.
export function obstacleLocked(
  rules: Ruleset,
  index: number,
  expandiert: readonly string[],
): boolean {
  const h = rules.obstacles?.[index];
  if (!h) return false;
  for (const e of rules.expansions ?? []) {
    if (expandiert.includes(e.id)) continue;
    if (ueberlappt(h.gx, h.gy, h.w, h.h, e.gx, e.gy, e.w, e.h)) return true;
  }
  return false;
}

// Liegt ein Feld (gx,gy,w,h) in noch gesperrtem Land? Genutzt für feste Bauwerke
// wie die Mine, die mitten in einer Erweiterung stehen: bauen geht erst, wenn
// das Land drumherum frei ist.
export function landLocked(
  rules: Ruleset,
  gx: number,
  gy: number,
  w: number,
  h: number,
  expandiert: readonly string[],
): boolean {
  if (gx < 0 || gy < 0) return false;
  for (const e of rules.expansions ?? []) {
    if (expandiert.includes(e.id)) continue;
    if (ueberlappt(gx, gy, w, h, e.gx, e.gy, e.w, e.h)) return true;
  }
  return false;
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

// Jenseits der letzten Schwelle geht es im Abstand der letzten Lücke weiter,
// damit es keine harte Höchststufe gibt.
function levelSchritt(t: readonly number[]): number {
  if (t.length >= 2) return Math.max(1, t[t.length - 1]! - t[t.length - 2]!);
  if (t.length === 1) return Math.max(1, t[0]!);
  return 0;
}

export function levelOf(rules: Ruleset, xp: number): number {
  const t = rules.levelThresholds;
  let level = 1;
  for (const threshold of t) {
    if (xp < threshold) return level;
    level++;
  }
  const schritt = levelSchritt(t);
  if (schritt <= 0) return level;
  return level + Math.floor((xp - t[t.length - 1]!) / schritt);
}

export function nextLevelAt(rules: Ruleset, xp: number): number | null {
  const t = rules.levelThresholds;
  for (const threshold of t) {
    if (xp < threshold) return threshold;
  }
  const schritt = levelSchritt(t);
  if (schritt <= 0) return null;
  const last = t[t.length - 1]!;
  const drueber = Math.floor((xp - last) / schritt);
  return last + (drueber + 1) * schritt;
}

export function levelStartedAt(rules: Ruleset, xp: number): number {
  const t = rules.levelThresholds;
  let start = 0;
  for (const threshold of t) {
    if (xp < threshold) return start;
    start = threshold;
  }
  const schritt = levelSchritt(t);
  if (schritt <= 0) return start;
  return start + Math.floor((xp - start) / schritt) * schritt;
}

export function nextLevel(rules: Ruleset, plot: number, level: number): LevelDef | null {
  return rules.plots[plot]?.levels[level] ?? null;
}

// Meisterschaft: Welche Plätze machen mit, wie viele Sterne ergeben so viele
// Abholungen, und wo liegt die nächste Grenze. Reine Regelwerksfragen — Sim
// und Sicht rechnen mit denselben Antworten.
export function meisterFaehig(rules: Ruleset, plot: number): boolean {
  const def = rules.plots[plot];
  if (!rules.meisterschaft || !def || def.deco || def.baum) return false;
  if (def.id.indexOf('field') === 0) return false;
  return def.levels.some((l) => l.recipes.length > 0);
}

export function sterneVon(rules: Ruleset, punkte: number): number {
  const m = rules.meisterschaft;
  if (!m) return 0;
  let n = 0;
  for (const grenze of m.stufen) if (punkte >= grenze) n++;
  return n;
}

// Die Grenze, die der Platz zuletzt überschritten hat, und die nächste —
// daraus wird der Balken im Tipp-Menü. `ziel` ist null, wenn alle Sterne da sind.
export function meisterGrenzen(rules: Ruleset, punkte: number): { von: number; ziel: number | null } {
  const m = rules.meisterschaft;
  if (!m) return { von: 0, ziel: null };
  let von = 0;
  for (const grenze of m.stufen) {
    if (punkte < grenze) return { von, ziel: grenze };
    von = grenze;
  }
  return { von, ziel: null };
}

// Alles, was ein Erfolg wissen muss. Lose Werte statt State, um keinen
// Ringimport rules<->state zu erzeugen.
export type AchievementCtx = {
  level: number;
  gold: number;
  builtIds: readonly string[];
  expandiert: number;
  plotsGebaut: number;
  dekoGebaut: number;
  geraeumt: number;
  siloLevel: number;
  fisch: number;
  boot: boolean;
  items: readonly number[];
  sterne: number;
  meister: number;
  feste: number;
  zaehler: readonly number[];
  tiere: number;
  tage: number;
  wochen: number;
};

// Stand und Ziel eines Erfolgs — daraus ergeben sich Fortschrittsbalken UND
// die Ja/Nein-Frage, ob er erfüllt ist. Eine Quelle, kein doppelter Code.
export function achievementFortschritt(
  rules: Ruleset,
  ach: AchievementDef,
  ctx: AchievementCtx,
): { ist: number; ziel: number } {
  switch (ach.kind) {
    case 'level':
      return { ist: ctx.level, ziel: ach.arg as number };
    case 'gold':
      return { ist: ctx.gold, ziel: ach.arg as number };
    case 'plot':
      return { ist: ctx.builtIds.includes(ach.arg as string) ? 1 : 0, ziel: 1 };
    case 'plotPrefix':
      return {
        ist: ctx.builtIds.some((id) => id.indexOf(ach.arg as string) === 0) ? 1 : 0,
        ziel: 1,
      };
    case 'expand':
      return { ist: ctx.expandiert, ziel: ach.arg as number };
    case 'plots':
      return { ist: ctx.plotsGebaut, ziel: ach.arg as number };
    case 'deko':
      return { ist: ctx.dekoGebaut, ziel: ach.arg as number };
    case 'obstacles':
      return { ist: ctx.geraeumt, ziel: ach.arg as number };
    case 'silo':
      return { ist: ctx.siloLevel, ziel: ach.arg as number };
    case 'fish':
      return { ist: ctx.fisch, ziel: ach.arg as number };
    case 'boat':
      return { ist: ctx.boot ? 1 : 0, ziel: 1 };
    case 'item': {
      const index = rules.items.findIndex((i) => i.id === (ach.arg as string));
      const habe = index < 0 ? 0 : (ctx.items[index] ?? 0);
      return { ist: habe, ziel: ach.menge ?? 1 };
    }
    case 'sterne':
      return { ist: ctx.sterne, ziel: ach.arg as number };
    case 'meister':
      return { ist: ctx.meister, ziel: ach.arg as number };
    case 'feste':
      return { ist: ctx.feste, ziel: ach.arg as number };
    case 'zaehler':
      return { ist: ctx.zaehler[ach.arg as number] ?? 0, ziel: ach.menge ?? 1 };
    case 'tiere':
      return { ist: ctx.tiere, ziel: ach.arg as number };
    case 'plotPrefixCount':
      return {
        ist: ctx.builtIds.filter((id) => id.indexOf(ach.arg as string) === 0).length,
        ziel: ach.menge ?? 1,
      };
    case 'tage':
      return { ist: ctx.tage, ziel: ach.arg as number };
    case 'wochen':
      return { ist: ctx.wochen, ziel: ach.arg as number };
    default:
      return { ist: 0, ziel: 1 };
  }
}

export function achievementDone(
  rules: Ruleset,
  ach: AchievementDef,
  ctx: AchievementCtx,
): boolean {
  const f = achievementFortschritt(rules, ach, ctx);
  return f.ist >= f.ziel;
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
  return def !== undefined && item !== rules.currency && def.npcPrice > 0;
}

export function itemUnlockLevel(rules: Ruleset, item: number): number {
  let lvl: number | null = null;
  for (let i = 0; i < rules.recipes.length; i++) {
    if (!recipeOutputs(rules.recipes[i]!).some((o) => o.item === item)) continue;
    const m = recipeMinLevel(rules, i);
    lvl = lvl === null ? m : Math.min(lvl, m);
  }
  return lvl ?? 0;
}

export function priceBand(rules: Ruleset, item: number): { min: number; max: number } {
  const def = rules.items[item];
  if (!def) return { min: 1, max: 1 };
  const min = Math.max(1, Math.floor((def.npcPrice * rules.priceBandMinPct) / 100));
  const max = Math.max(min, Math.floor((def.npcPrice * rules.priceBandMaxPct) / 100));
  return { min, max };
}

export type Freischaltung = { plots: readonly string[]; recipes: readonly number[] };

export function freischaltungenAb(rules: Ruleset, level: number): Freischaltung {
  if (level <= 1) return { plots: [], recipes: [] };

  const plots: string[] = [];
  for (const def of rules.plots) {
    if (def.startLevel > 0) continue;
    const erste = def.levels[0];
    if (erste && (erste.minPlayerLevel ?? 1) === level) plots.push(def.id);
  }

  const erreichbar = new Set<number>();
  for (const def of rules.plots) {
    for (const stufe of def.levels) for (const r of stufe.recipes) erreichbar.add(r);
  }

  const recipes: number[] = [];
  for (let i = 0; i < rules.recipes.length; i++) {
    if (!erreichbar.has(i)) continue;
    if (recipeMinLevel(rules, i) === level) recipes.push(i);
  }

  return { plots, recipes };
}

export function helpSpeedup(rules: Ruleset, recipe: number): number {
  const pct = rules.helpSpeedupPct ?? 0;
  const def = rules.recipes[recipe];
  if (pct <= 0 || !def) return 0;
  return Math.max(1, Math.floor((def.durationTicks * pct) / 100));
}

export function offerLimits(
  rules: Ruleset,
  item: number,
): { maxAmount: number; minPrice: number; maxPrice: number } {
  const band = priceBand(rules, item);
  const cap = rules.maxOfferPrice ?? 0;
  return {
    maxAmount: rules.maxOfferAmount ?? 0,
    minPrice: band.min,
    maxPrice: cap > 0 && cap < band.max ? cap : band.max,
  };
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
    for (const stack of recipeOutputs(r)) {
      if (!itemOk(stack.item)) problems.push(`Rezept ${i} (${r.id}): Ausgabe unbekannt`);
      if (!Number.isInteger(stack.amount) || stack.amount < 1) {
        problems.push(`Rezept ${i} (${r.id}): Ausgabemenge ${stack.amount} < 1`);
      }
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
      if ((level.minPlayerLevel ?? 1) > 100) {
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
    const max = 100;
    if ((r.minPlayerLevel ?? 1) > max) {
      problems.push(`Rezept ${r.id} verlangt Stufe ${r.minPlayerLevel}, es gibt nur ${max}`);
    }
  });
  if (rules.requestSlots < 1) problems.push('Auftrags-Slots < 1');
  if (rules.grid) {
    if (!Number.isInteger(rules.grid.w) || rules.grid.w < 1) problems.push('Rasterbreite ungültig');
    if (!Number.isInteger(rules.grid.h) || rules.grid.h < 1) problems.push('Rasterhöhe ungültig');
    let flaeche = 0;
    for (const [i, p] of rules.plots.entries()) {
      const groesse = p.size ?? { w: 1, h: 1 };
      if (!Number.isInteger(groesse.w) || !Number.isInteger(groesse.h)) {
        problems.push(`Platz ${i} (${p.id}): Größe nicht in ganzen Feldern`);
        continue;
      }
      if (groesse.w < 1 || groesse.h < 1) problems.push(`Platz ${i} (${p.id}): Größe < 1`);
      if (groesse.w > rules.grid.w || groesse.h > rules.grid.h) {
        problems.push(`Platz ${i} (${p.id}) passt nicht aufs Raster`);
      }
      flaeche += groesse.w * groesse.h;
    }
    let versperrt = 0;
    for (const h of rules.obstacles ?? []) {
      if (h.gx < 0 || h.gy < 0 || h.gx + h.w > rules.grid.w || h.gy + h.h > rules.grid.h) {
        problems.push(`Hindernis ${h.kind} liegt außerhalb des Rasters`);
      }
      versperrt += h.w * h.h;
    }
    for (let a = 0; a < (rules.obstacles ?? []).length; a++) {
      for (let b = a + 1; b < (rules.obstacles ?? []).length; b++) {
        const x = rules.obstacles![a]!;
        const y = rules.obstacles![b]!;
        const frei =
          x.gx + x.w <= y.gx || y.gx + y.w <= x.gx || x.gy + x.h <= y.gy || y.gy + y.h <= x.gy;
        if (!frei) problems.push(`Hindernisse ${x.kind} und ${y.kind} liegen übereinander`);
      }
    }

    if (flaeche + versperrt > rules.grid.w * rules.grid.h) {
      problems.push(
        `Gebäude und Hindernisse brauchen ${flaeche + versperrt} Felder, das Raster hat ` +
          `${rules.grid.w * rules.grid.h}`,
      );
    }

    for (const h of rules.obstacles ?? []) {
      const art = rules.obstacleKinds?.[h.kind];
      if (rules.obstacleKinds && !art) {
        problems.push(`Hindernis ${h.kind}: keine Regel zum Wegräumen`);
      }
      if (art) {
        if (!itemOk(art.tool)) problems.push(`Hindernis ${h.kind}: Werkzeug unbekannt`);
        if (!Number.isInteger(art.xp) || art.xp < 0) {
          problems.push(`Hindernis ${h.kind}: XP ungültig`);
        }
      }
    }

    for (const p of rules.plots) {
      if (p.startLevel <= 0) continue;
      const groesse = p.size ?? { w: 1, h: 1 };
      let gx: number;
      let gy: number;
      if (p.startCell) {
        gx = Math.max(0, Math.min(rules.grid.w - groesse.w, p.startCell.gx));
        gy = Math.max(0, Math.min(rules.grid.h - groesse.h, p.startCell.gy));
      } else if (p.place) {
        gx = Math.max(0, Math.min(rules.grid.w - groesse.w,
          Math.floor((p.place.x * rules.grid.w) / 100)));
        gy = Math.max(0, Math.min(rules.grid.h - groesse.h,
          Math.floor((p.place.y * rules.grid.h) / 100)));
      } else {
        continue;
      }
      if (blockiert(rules, gx, gy, groesse.w, groesse.h)) {
        problems.push(`Startplatz ${p.id} landet auf einem Hindernis`);
      }
    }
  }

  if (rules.emergencyBuyOnly) {
    for (const plot of rules.plots.filter((p) => p.startLevel > 0)) {
      for (const recipe of plot.levels[plot.startLevel - 1]!.recipes) {
        for (const input of rules.recipes[recipe]!.inputs) {
          const preis = rules.items[input.item]!.npcBuyPrice;
          if (preis <= 0) continue;
          const startGold =
            rules.startingItems.find((x) => x.item === rules.currency)?.amount ?? 0;
          if (startGold < preis) {
            problems.push(
              `Notkauf von ${rules.items[input.item]!.id} kostet ${preis}, ` +
                `am Anfang gibt es nur ${startGold} — Sackgasse`,
            );
          }
        }
      }
    }
  }
  if (rules.truckAwayTicks !== undefined) {
    if (!Number.isInteger(rules.truckAwayTicks) || rules.truckAwayTicks < 0) {
      problems.push(`Wagen-Fahrzeit ungültig: ${rules.truckAwayTicks}`);
    }
  }
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
  if (rules.maxOfferAmount !== undefined && rules.maxOfferAmount < 1) {
    problems.push(`Kästchen-Limit unter 1: ${rules.maxOfferAmount}`);
  }
  if (rules.maxOfferPrice !== undefined && rules.maxOfferPrice < 1) {
    problems.push(`Preisdeckel unter 1: ${rules.maxOfferPrice}`);
  }
  for (const [i, item] of rules.items.entries()) {
    if (!isTradable(rules, i)) continue;
    const limits = offerLimits(rules, i);
    if (limits.minPrice > limits.maxPrice) {
      problems.push(`${item.id}: Preisdeckel unter dem Mindestpreis des Bandes`);
    }
  }
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

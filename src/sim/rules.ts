/**
 * Regelwerk als *versionierte Daten* (Architektur §2, Risiko R2).
 *
 * Balance-Änderungen sind Datenänderungen, kein Code. Jeder Command-Log deklariert
 * seine `rulesetVersion`, und der Server validiert ihn unter genau dieser Version —
 * sonst rechnet er nach einem Patch anders als der Client offline gerechnet hat und
 * bestraft ehrliche Spieler mit einem Rollback (R1).
 *
 * ── Inhalt ist eine Tabelle, keine Codezeile ────────────────────────────────
 *
 * Hier steht der gesamte Spielinhalt: Gegenstände, Rezepte, Produktionsplätze.
 * Eine neue Feldfrucht ist eine Zeile in `items` plus eine in `recipes` — der
 * Sim-Kern kennt keinen Weizen und keine Hühner, nur Katalogindizes.
 *
 * ── Die eine Regel, die man nicht brechen darf ──────────────────────────────
 *
 * **Kataloge sind APPEND-ONLY.** Zustände speichern Indizes, keine Namen: Ein
 * Inventar ist ein Zahlenarray in Katalogreihenfolge, ein Platz merkt sich eine
 * Rezeptnummer. Wer einen Eintrag einschiebt oder entfernt, verschiebt die
 * Bedeutung *aller* gespeicherten Spielstände — aus Weizen wird stillschweigend
 * Futter. Anhängen ist gratis (die Migration füllt mit Nullen auf); Umsortieren
 * braucht eine echte Umschlüsselungs-Migration.
 *
 * `test/rules.test.ts` prüft das über alle Versionen hinweg.
 */

/** Menge eines Katalog-Gegenstands. `item` ist ein Index in `Ruleset.items`. */
export type ItemStack = {
  item: number;
  amount: number;
};

export type ItemDef = {
  /** Nur für Menschen und Oberflächen. Der Zustand kennt nur den Index. */
  id: string;
  /** Zählt gegen das Lagerlimit? Münzen nicht (§7). */
  storable: boolean;
  /** NPC-Ankaufpreis. 0 = wird nicht angekauft (und ist damit auch nicht handelbar). */
  npcPrice: number;
};

/**
 * Eingaben verbrauchen → Zeit vergeht → Ausgabe liegt bereit.
 *
 * Dieselbe Struktur trägt Feldfrucht, Tierprodukt und Werkstatt-Rezept — das ist
 * die Verdichtung aus der Konzept-Map (M1). Produktionsketten muss niemand extra
 * bauen: Sie entstehen, sobald die Ausgabe des einen die Eingabe des anderen ist.
 *
 * Der Kernkreislauf des Spiels ist genau das, dreimal hintereinander:
 * Feld → Weizen, Mühle → Futter, Gehege → Eier.
 */
export type RecipeDef = {
  id: string;
  /** Leer = wächst aus dem Nichts (Saatgut ist gratis). */
  inputs: readonly ItemStack[];
  output: ItemStack;
  durationTicks: number;
};

/**
 * Eine Ausbaustufe eines Platzes.
 *
 * Damit sind „Gehege kaufen" und „Hühner kaufen" **dieselbe** Mechanik: einmal
 * Kosten zahlen, dauerhaft eine Stufe höher. Ein leeres Gehege ist Stufe 1
 * (kann noch nichts), mit Hühnern Stufe 2 (kann Eier).
 *
 * Dieselbe Mechanik trägt später Felder freischalten, Ställe vergrößern und
 * Maschinen beschleunigen (Konzept-Map, M7) — alles Tabellenzeilen.
 */
export type LevelDef = {
  /** Anzeigename dieser Stufe. */
  label: string;
  /** Was der Aufstieg auf diese Stufe kostet. */
  cost: readonly ItemStack[];
  /** Welche Rezepte auf dieser Stufe laufen dürfen. Darf leer sein. */
  recipes: readonly number[];
};

/**
 * Ein Produktionsplatz: Feld, Mühle, Gehege.
 *
 * Die Liste im Regelwerk ist die WELT, nicht der Typ — jeder Eintrag ist ein
 * Platz, den es geben kann. Ob er dem Spieler schon gehört, sagt seine Stufe im
 * Zustand.
 */
export type PlotDef = {
  id: string;
  /** Stufe, mit der ein frischer Hof startet. 0 = muss erst gekauft werden. */
  startLevel: number;
  /** Stufen 1..n — `levels[i]` beschreibt Stufe i+1. Append-only. */
  levels: readonly LevelDef[];
};

/**
 * Ein Platz, der von allein produziert: Bienenstock, Brunnen, Kompost.
 *
 * Taktung ist die Dauer des Rezepts. Einschränkung (bewusst): Passive Rezepte
 * haben keine Eingaben und geben genau eine Einheit aus. Der Grund steht in
 * `produce.ts` — nur so bleibt die geschlossene Form bei geteiltem Lagerplatz
 * beweisbar. Tiere, die Futter brauchen, sind ein Platz mit Eingaben.
 *
 * **Der Basis-Kreislauf nutzt das nicht.** Die Mechanik bleibt trotzdem im Kern:
 * Sie ist der Beweis, dass gedeckelte Akkumulation über beliebig lange
 * Offline-Phasen in geschlossener Form geht (§7) — und der einzige Kandidat für
 * „es passiert etwas, während man weg ist, ohne dass man es angestoßen hat".
 */
export type PassiveDef = {
  id: string;
  recipe: number;
};

export type Ruleset = {
  version: number;

  /** Der Gegenstandskatalog. Indizes sind der Schlüssel im Zustand — append-only. */
  items: readonly ItemDef[];
  /** Katalogindex der Währung. Nicht lagerpflichtig, nicht handelbar. */
  currency: number;
  recipes: readonly RecipeDef[];
  /** Alle Produktionsplätze der Welt, in fester Reihenfolge. */
  plots: readonly PlotDef[];
  /** Alle passiven Produzenten, in fester Reihenfolge. */
  passives: readonly PassiveDef[];

  /** Lagerkapazität gesamt, über alle lagerpflichtigen Waren (§7). */
  siloCapacity: number;

  /**
   * Wie viele Verkaufsaufträge gleichzeitig offen sein dürfen.
   *
   * DAS ist der strukturelle Riegel gegen „Escrow als unendliches Lager" (§8).
   */
  orderSlots: number;
  /** Nach dieser Zeit verfällt ein Auftrag und die Ware geht ins Postfach. */
  orderTtlTicks: number;
  /** Preisband um den Referenzwert, in Prozent — verhindert Parkpreise (§8). */
  priceBandMinPct: number;
  priceBandMaxPct: number;
  /** Auch das Postfach ist ein Behälter und braucht daher ein Limit (§7). */
  mailCapacity: number;
};

// ── Katalog-Indizes ────────────────────────────────────────────────────────
//
// Nur zur Lesbarkeit dieser Datei. Der Sim-Kern benutzt sie NICHT.

const GOLD = 0;
const WHEAT = 1;
const FEED = 2;
const EGGS = 3;

const R_WHEAT = 0;
const R_FEED = 1;
const R_EGGS = 2;

const gold = (amount: number): ItemStack[] => [{ item: GOLD, amount }];

/**
 * Der Basis-Kreislauf, Stand jetzt:
 *
 *   Feld → Weizen → Mühle → Hühnerfutter → Gehege → Eier → Gold → mehr Plätze
 *
 * Bewusst nicht mehr. Jede weitere Mechanik ist neue Fläche, auf der Client und
 * Server auseinanderlaufen können (Roadmap). Inhalt darf später beliebig wachsen
 * — er ist ja nur noch Tabelle.
 */
const V1: Ruleset = {
  version: 1,

  items: [
    { id: 'gold', storable: false, npcPrice: 0 },
    { id: 'wheat', storable: true, npcPrice: 3 },
    { id: 'feed', storable: true, npcPrice: 8 },
    { id: 'eggs', storable: true, npcPrice: 25 },
  ],
  currency: GOLD,

  recipes: [
    { id: 'wheat', inputs: [], output: { item: WHEAT, amount: 10 }, durationTicks: 120 },
    {
      id: 'feed',
      inputs: [{ item: WHEAT, amount: 3 }],
      output: { item: FEED, amount: 2 },
      durationTicks: 300,
    },
    {
      id: 'eggs',
      inputs: [{ item: FEED, amount: 1 }],
      output: { item: EGGS, amount: 3 },
      durationTicks: 900,
    },
  ],

  plots: [
    // Drei Felder gehören dem Spieler von Anfang an — ohne sie gäbe es keinen
    // Einstieg in den Kreislauf.
    { id: 'field-1', startLevel: 1, levels: [{ label: 'Feld', cost: [], recipes: [R_WHEAT] }] },
    { id: 'field-2', startLevel: 1, levels: [{ label: 'Feld', cost: [], recipes: [R_WHEAT] }] },
    { id: 'field-3', startLevel: 1, levels: [{ label: 'Feld', cost: [], recipes: [R_WHEAT] }] },

    // Drei weitere sind das erste, was man sich leisten kann.
    { id: 'field-4', startLevel: 0, levels: [{ label: 'Feld', cost: gold(100), recipes: [R_WHEAT] }] },
    { id: 'field-5', startLevel: 0, levels: [{ label: 'Feld', cost: gold(250), recipes: [R_WHEAT] }] },
    { id: 'field-6', startLevel: 0, levels: [{ label: 'Feld', cost: gold(500), recipes: [R_WHEAT] }] },

    { id: 'mill', startLevel: 0, levels: [{ label: 'Mühle', cost: gold(150), recipes: [R_FEED] }] },

    // Zwei Stufen, und genau das sind deine zwei Kaufschritte: erst steht das
    // Gehege leer, dann sind Hühner drin. Ohne Hühner läuft kein Rezept.
    {
      id: 'coop-1',
      startLevel: 0,
      levels: [
        { label: 'Gehege', cost: gold(300), recipes: [] },
        { label: 'Hühner', cost: gold(200), recipes: [R_EGGS] },
      ],
    },
    {
      id: 'coop-2',
      startLevel: 0,
      levels: [
        { label: 'Gehege', cost: gold(800), recipes: [] },
        { label: 'Hühner', cost: gold(400), recipes: [R_EGGS] },
      ],
    },
  ],

  passives: [],

  siloCapacity: 100,
  orderSlots: 4,
  orderTtlTicks: 86_400,
  priceBandMinPct: 25,
  priceBandMaxPct: 150,
  mailCapacity: 20,
};

/**
 * Ein Balance-Patch, wie er im Live-Betrieb wöchentlich vorkommt: andere Zeiten,
 * andere Preise, größeres Lager. Die Form des Zustands bleibt gleich.
 *
 * Er steht hier nicht als Inhalt, sondern als **arbeitendes Beispiel**: Ohne
 * mindestens zwei Versionen wäre die ganze Migrationsmaschinerie aus R2 nur
 * Theorie — und sie ist genau das, was ein Live-Service-Spiel am Laufen hält.
 * Der erste echte Patch ersetzt diese Zahlen.
 */
const V2: Ruleset = {
  ...V1,
  version: 2,
  items: [
    { id: 'gold', storable: false, npcPrice: 0 },
    { id: 'wheat', storable: true, npcPrice: 4 },
    { id: 'feed', storable: true, npcPrice: 9 },
    { id: 'eggs', storable: true, npcPrice: 28 },
  ],
  recipes: [
    { id: 'wheat', inputs: [], output: { item: WHEAT, amount: 10 }, durationTicks: 100 },
    {
      id: 'feed',
      inputs: [{ item: WHEAT, amount: 3 }],
      output: { item: FEED, amount: 2 },
      durationTicks: 240,
    },
    {
      id: 'eggs',
      inputs: [{ item: FEED, amount: 1 }],
      output: { item: EGGS, amount: 3 },
      durationTicks: 720,
    },
  ],
  siloCapacity: 120,
  // Mehr Slots als Progressions-Buff. Achtung: WENIGER Slots wären ein
  // Migrationsproblem — bestehende Aufträge würden die Invariante verletzen.
  orderSlots: 6,
};

/**
 * Entwicklungs-Tempo: derselbe Inhalt wie V1, Uhren zehnmal schneller.
 *
 * Die Versionsnummer liegt bewusst WEIT außerhalb der Produktionsreihe. Ein
 * Dev-Regelwerk darf nie versehentlich Ziel einer Migration werden — sonst
 * bekäme irgendwann ein echter Spielstand Sekundenzeiten. Es gibt keinen Pfad
 * hinein und keinen hinaus; ein Dev-Spielstand ist Wegwerfware.
 */
const DEV: Ruleset = {
  ...V1,
  version: 1001,
  recipes: [
    { id: 'wheat', inputs: [], output: { item: WHEAT, amount: 10 }, durationTicks: 12 },
    {
      id: 'feed',
      inputs: [{ item: WHEAT, amount: 3 }],
      output: { item: FEED, amount: 2 },
      durationTicks: 30,
    },
    {
      id: 'eggs',
      inputs: [{ item: FEED, amount: 1 }],
      output: { item: EGGS, amount: 3 },
      durationTicks: 90,
    },
  ],
  orderTtlTicks: 600,
};

/**
 * Der Server hält bewusst mehrere Versionen vor (R2). Ein Client, dessen Version
 * hier nicht mehr steht, muss vor dem Sync updaten — sauberer, angekündigter
 * Bruch statt stiller Divergenz.
 */
export const RULESETS: ReadonlyMap<number, Ruleset> = new Map([
  [1, V1],
  [2, V2],
  [1001, DEV],
]);

/**
 * Die Produktionsreihe, in Migrationsreihenfolge.
 *
 * Nur entlang dieser Kette wird migriert. Das Dev-Regelwerk steht bewusst nicht
 * drin — siehe `DEV`.
 */
export const PRODUCTION_VERSIONS: readonly number[] = [1, 2];

/** Womit ein frischer Hof in Produktion startet. */
export const CURRENT_RULESET_VERSION = 1;

/** Die Version, auf die der Server neue Snapshots hebt. */
export const LATEST_RULESET_VERSION = 2;

/** Schnelle Uhren fürs Entwickeln und für Feldtests von Hand. */
export const DEV_RULESET_VERSION = 1001;

export function getRuleset(version: number): Ruleset {
  const r = RULESETS.get(version);
  if (!r) throw new Error(`unsupported ruleset version: ${version}`);
  return r;
}

// ── Abfragen auf dem Katalog ───────────────────────────────────────────────

/** Welche Rezepte auf diesem Platz laufen, wenn er auf `level` ausgebaut ist. */
export function levelRecipes(rules: Ruleset, plot: number, level: number): readonly number[] {
  if (level <= 0) return [];
  return rules.plots[plot]?.levels[level - 1]?.recipes ?? [];
}

/** Kosten für die nächste Stufe — `null`, wenn schon voll ausgebaut. */
export function nextLevel(rules: Ruleset, plot: number, level: number): LevelDef | null {
  return rules.plots[plot]?.levels[level] ?? null;
}

/**
 * Tabellen, die sich aus dem Katalog ergeben — einmal je Regelwerk berechnet.
 *
 * Reiner Zwischenspeicher: dieselbe Eingabe liefert immer dasselbe Ergebnis, er
 * ist für den Determinismus also unsichtbar. Er ist trotzdem nötig. Seit der
 * Zustand ein Inventar-Array ist, muss „wie voll ist das Lager" über den
 * Katalog laufen — und diese Frage stellt der Sim-Kern mehrfach *pro Command*.
 */
export type DerivedTables = {
  /** Indizes der lagerpflichtigen Gegenstände. */
  storable: number[];
  /** Taktung je passivem Produzenten. */
  passiveIntervals: number[];
  /** Ausgabe-Gegenstand je passivem Produzenten. */
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

/** Taktung eines passiven Produzenten = Dauer seines Rezepts. Eine Zahl, eine Wahrheit. */
export function passiveInterval(rules: Ruleset, passive: number): number {
  return rules.recipes[rules.passives[passive]!.recipe]!.durationTicks;
}

/**
 * Darf dieser Gegenstand auf dem Spielermarkt eingestellt werden?
 *
 * Abgeleitet statt eigenes Flag: Handelbar ist, was lagerfähig ist und einen
 * Referenzpreis hat — ohne Referenz gäbe es kein Preisband (§8), und ohne
 * Preisband wäre der Auftrag ein Parkplatz für Ware.
 */
export function isTradable(rules: Ruleset, item: number): boolean {
  const def = rules.items[item];
  return def !== undefined && def.storable && def.npcPrice > 0;
}

/**
 * Prüft ein Regelwerk auf Widersprüche.
 *
 * Kataloge sind Daten, und Daten haben keinen Compiler. Ein Rezept, das auf
 * einen Gegenstand zeigt, den es nicht gibt, wäre sonst erst im Spiel
 * aufgefallen — bei einem Spieler, offline, ohne Netz für einen Hotfix.
 */
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
      // Doppelte Zutat: Die Bestandsprüfung im Sim-Kern geht Zutat für Zutat
      // vor und würde denselben Vorrat zweimal zählen.
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
      // Eine Startstufe, die etwas kostet, wäre ein Widerspruch: Sie ist ja
      // schon da, bezahlt hat sie nie jemand.
      if (l < p.startLevel && level.cost.length > 0) {
        problems.push(`Platz ${i} (${p.id}) Stufe ${l + 1}: Startstufe mit Preis`);
      }
    }
  }

  for (const [i, p] of rules.passives.entries()) {
    if (!Number.isInteger(p.recipe) || p.recipe < 0 || p.recipe >= rules.recipes.length) {
      problems.push(`Passive ${i} (${p.id}): Rezept ${p.recipe} gibt es nicht`);
      continue;
    }
    const recipe = rules.recipes[p.recipe]!;
    // Siehe PassiveDef: Diese drei Einschränkungen tragen die geschlossene Form.
    if (recipe.inputs.length > 0) problems.push(`Passive ${i} (${p.id}): Rezept braucht Eingaben`);
    if (recipe.output.amount !== 1) problems.push(`Passive ${i} (${p.id}): Ausgabemenge != 1`);
    if (!rules.items[recipe.output.item]?.storable) {
      problems.push(`Passive ${i} (${p.id}): Ausgabe ist nicht lagerpflichtig`);
    }
  }

  if (rules.siloCapacity < 1) problems.push('Lagerkapazität < 1');
  if (rules.mailCapacity < 1) problems.push('Postfachkapazität < 1');
  if (rules.priceBandMinPct > rules.priceBandMaxPct) problems.push('Preisband verkehrt herum');

  return problems;
}

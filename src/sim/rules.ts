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
 * Sim-Kern kennt keinen Weizen und keine Eier, nur Katalogindizes.
 *
 * Der Hebel dahinter (Roadmap): **Inhalt skaliert als Daten, Risiko skaliert mit
 * Mechaniken.** Eine Tabellenzeile bringt kein neues Determinismus-Risiko mit,
 * eine neue Mechanik schon.
 *
 * ── Die eine Regel, die man nicht brechen darf ──────────────────────────────
 *
 * **Kataloge sind APPEND-ONLY.** Zustände speichern Indizes, keine Namen: Ein
 * Inventar ist ein Zahlenarray in Katalogreihenfolge, ein Feld merkt sich eine
 * Rezeptnummer. Wer einen Eintrag einschiebt oder entfernt, verschiebt die
 * Bedeutung *aller* gespeicherten Spielstände — aus Weizen wird stillschweigend
 * Mehl. Anhängen ist gratis (die Migration füllt mit Nullen auf); Umsortieren
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
 */
export type RecipeDef = {
  id: string;
  /** Leer = wächst aus dem Nichts (Saatgut ist gratis). */
  inputs: readonly ItemStack[];
  output: ItemStack;
  durationTicks: number;
};

/**
 * Ein Produktionsplatz, den der Spieler selbst bestückt: Feld, Mühle, Bäckerei.
 *
 * Die Liste hier ist die WELT, nicht der Typ — jeder Eintrag ist ein Platz, den
 * es gibt. Ein Feld dazuzubauen ist damit ebenfalls eine Tabellenzeile (und eine
 * strukturelle Migration, siehe migrate.ts).
 */
export type PlotDef = {
  id: string;
  /** Welche Rezepte hier laufen dürfen. Nie leer. */
  recipes: readonly number[];
};

/**
 * Ein Platz, der von allein produziert: Hühnerstall, Weide, Bienenstock.
 *
 * Taktung ist die Dauer des Rezepts. Ein Balance-Patch, der die Dauer ändert,
 * ändert damit automatisch auch die Taktung — eine Zahl, eine Wahrheit.
 *
 * Einschränkung (bewusst): Passive Rezepte haben keine Eingaben und geben genau
 * eine Einheit aus. Der Grund steht in `produce.ts` — nur so bleibt die
 * geschlossene Form bei geteiltem Lagerplatz beweisbar. Tiere, die Futter
 * brauchen, sind ein Plot mit Eingaben, keine Passive.
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
   * Ohne ihn könnte man Ware zu einem unverkäuflichen Preis einstellen, das
   * Lager leeren und beliebig weiterproduzieren.
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
// Nur zur Lesbarkeit dieser Datei. Der Sim-Kern benutzt sie NICHT — er kennt
// ausschließlich `rules.items[i]` und `rules.currency`.

const GOLD = 0;
const WHEAT = 1;
const EGGS = 2;
const MILK = 3;
const FLOUR = 4;
const BREAD = 5;

const R_WHEAT = 0;
const R_EGGS = 1;
const R_MILK = 2;
const R_FLOUR = 3;
const R_BREAD = 4;

const BASE_ITEMS: readonly ItemDef[] = [
  { id: 'gold', storable: false, npcPrice: 0 },
  { id: 'wheat', storable: true, npcPrice: 3 },
  { id: 'eggs', storable: true, npcPrice: 5 },
];

function fields(count: number, recipes: readonly number[]): PlotDef[] {
  const out: PlotDef[] = [];
  for (let i = 0; i < count; i++) out.push({ id: `field-${i + 1}`, recipes });
  return out;
}

const V1: Ruleset = {
  version: 1,
  items: BASE_ITEMS,
  currency: GOLD,
  recipes: [
    { id: 'wheat', inputs: [], output: { item: WHEAT, amount: 10 }, durationTicks: 7200 },
    { id: 'eggs', inputs: [], output: { item: EGGS, amount: 1 }, durationTicks: 600 },
  ],
  plots: fields(6, [R_WHEAT]),
  passives: [{ id: 'coop', recipe: R_EGGS }],
  siloCapacity: 100,
  orderSlots: 4,
  orderTtlTicks: 86_400,
  priceBandMinPct: 25,
  priceBandMaxPct: 150,
  mailCapacity: 20,
};

/**
 * Ein typischer Balance-Patch: Weizen wächst schneller, der Stall legt öfter,
 * das Lager wird größer, Preise ziehen an.
 *
 * Genau so ein Patch ist der Grund für R2 — er ändert das deterministische
 * Ergebnis. Ein Spieler, der offline unter V1 gehandelt hat, muss weiterhin
 * unter V1 nachgerechnet werden, sonst weicht der Server garantiert von seinem
 * Client ab (R1). Die Form des Zustands bleibt unverändert.
 */
const V2: Ruleset = {
  ...V1,
  version: 2,
  items: [
    { id: 'gold', storable: false, npcPrice: 0 },
    { id: 'wheat', storable: true, npcPrice: 4 },
    { id: 'eggs', storable: true, npcPrice: 6 },
  ],
  recipes: [
    { id: 'wheat', inputs: [], output: { item: WHEAT, amount: 10 }, durationTicks: 5400 },
    { id: 'eggs', inputs: [], output: { item: EGGS, amount: 1 }, durationTicks: 480 },
  ],
  siloCapacity: 120,
  // Mehr Slots als Progressions-Buff. Achtung: WENIGER Slots wären ein
  // Migrationsproblem — bestehende Aufträge würden die Invariante verletzen
  // und müssten in einem Migrationsschritt ins Postfach aufgelöst werden.
  orderSlots: 6,
};

/**
 * Ein INHALTS-Patch — und damit der ehrlichere Test für R2.
 *
 * V1→V2 änderte nur Zahlen. Hier wächst der Zustand: zwei neue Rohstoffe, zwei
 * Verarbeitungsprodukte, zwei Werkstätten und eine zweite Weide. Das Inventar
 * bekommt Einträge, die Plätze werden mehr — eine *strukturelle* Migration.
 *
 * Bemerkenswert ist, was hier NICHT passiert: Für Mühle und Bäckerei gibt es
 * keine neue Mechanik. Eine Werkstatt ist ein Platz mit Eingaben; die Kette
 * Weizen → Mehl → Brot entsteht daraus von allein.
 */
const V3: Ruleset = {
  ...V2,
  version: 3,
  items: [
    ...V2.items,
    { id: 'milk', storable: true, npcPrice: 7 },
    { id: 'flour', storable: true, npcPrice: 9 },
    { id: 'bread', storable: true, npcPrice: 20 },
  ],
  recipes: [
    ...V2.recipes,
    { id: 'milk', inputs: [], output: { item: MILK, amount: 1 }, durationTicks: 900 },
    {
      id: 'flour',
      inputs: [{ item: WHEAT, amount: 3 }],
      output: { item: FLOUR, amount: 1 },
      durationTicks: 1800,
    },
    {
      id: 'bread',
      inputs: [
        { item: FLOUR, amount: 2 },
        { item: EGGS, amount: 1 },
      ],
      output: { item: BREAD, amount: 1 },
      durationTicks: 3600,
    },
  ],
  plots: [
    ...fields(6, [R_WHEAT]),
    { id: 'mill', recipes: [R_FLOUR] },
    { id: 'bakery', recipes: [R_BREAD] },
  ],
  passives: [
    { id: 'coop', recipe: R_EGGS },
    { id: 'pasture', recipe: R_MILK },
  ],
};

/**
 * Feldtest-Tempo: dieselben Regeln und derselbe Inhalt, nur schnelle Uhren.
 *
 * Mit zwei Stunden Wachstumszeit lässt sich ein Verbindungstest von Hand kaum
 * durchführen — ohne erntereifes Feld und ohne Ware im Lager wird jede Aktion
 * lokal abgelehnt, und die Warteschlange bleibt leer. Dann testet man nichts.
 *
 * Es ist bewusst eine eigene Ruleset-VERSION und kein Schalter: Regeln sind
 * versionierte Daten (R2). Damit lässt sich der Wechsel obendrein als echter
 * Balance-Patch beobachten — inklusive fairer Umrechnung laufender Plätze.
 */
const V4: Ruleset = {
  ...V3,
  version: 4,
  recipes: [
    { id: 'wheat', inputs: [], output: { item: WHEAT, amount: 10 }, durationTicks: 60 },
    { id: 'eggs', inputs: [], output: { item: EGGS, amount: 1 }, durationTicks: 20 },
    { id: 'milk', inputs: [], output: { item: MILK, amount: 1 }, durationTicks: 35 },
    {
      id: 'flour',
      inputs: [{ item: WHEAT, amount: 3 }],
      output: { item: FLOUR, amount: 1 },
      durationTicks: 30,
    },
    {
      id: 'bread',
      inputs: [
        { item: FLOUR, amount: 2 },
        { item: EGGS, amount: 1 },
      ],
      output: { item: BREAD, amount: 1 },
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
  [3, V3],
  [4, V4],
]);

export const CURRENT_RULESET_VERSION = 1;

/** Die Version, auf die der Server neue Snapshots hebt. */
export const LATEST_RULESET_VERSION = 3;

/** Schnelle Uhren für den Feldtest — siehe V4. */
export const FIELD_TEST_RULESET_VERSION = 4;

export function getRuleset(version: number): Ruleset {
  const r = RULESETS.get(version);
  if (!r) throw new Error(`unsupported ruleset version: ${version}`);
  return r;
}

// ── Abfragen auf dem Katalog ───────────────────────────────────────────────

/**
 * Tabellen, die sich aus dem Katalog ergeben — einmal je Regelwerk berechnet.
 *
 * Reiner Zwischenspeicher: dieselbe Eingabe liefert immer dasselbe Ergebnis, er
 * ist für den Determinismus also unsichtbar. Er ist trotzdem nötig. Seit der
 * Zustand ein Inventar-Array ist, muss „wie voll ist das Lager" über den
 * Katalog laufen — und diese Frage stellt der Sim-Kern mehrfach *pro Command*.
 * Ohne die Tabelle kostet der Sync spürbar mehr, und R4 sagt, dass genau diese
 * Konstanten zählen.
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
  else if (rules.items[rules.currency]!.storable) problems.push('Währung darf nicht lagerpflichtig sein');

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
    for (const input of r.inputs) {
      if (!itemOk(input.item)) problems.push(`Rezept ${i} (${r.id}): Eingabe unbekannt`);
      if (!Number.isInteger(input.amount) || input.amount < 1) {
        problems.push(`Rezept ${i} (${r.id}): Eingabemenge ${input.amount} < 1`);
      }
    }
  }

  for (const [i, p] of rules.plots.entries()) {
    if (p.recipes.length === 0) problems.push(`Platz ${i} (${p.id}): keine Rezepte`);
    for (const r of p.recipes) {
      if (!Number.isInteger(r) || r < 0 || r >= rules.recipes.length) {
        problems.push(`Platz ${i} (${p.id}): Rezept ${r} gibt es nicht`);
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

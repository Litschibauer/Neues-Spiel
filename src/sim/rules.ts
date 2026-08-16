/**
 * Regelwerk als *versionierte Daten* (Architektur §2, Risiko R2).
 *
 * Balance-Änderungen sind Datenänderungen, kein Code. Jeder Command-Log deklariert
 * seine `rulesetVersion`, und der Server validiert ihn unter genau dieser Version —
 * sonst rechnet er nach einem Patch anders als der Client offline gerechnet hat und
 * bestraft ehrliche Spieler mit einem Rollback (R1).
 */

export type Ruleset = {
  version: number;
  /** Lagerkapazität gesamt, über alle Warenarten (§7). */
  siloCapacity: number;
  /** Wachstumsdauer Weizen in Ticks. 1 Tick = 1 Sekunde → 7200 = 2h. */
  wheatGrowTicks: number;
  /** Ertrag pro geerntetem Feld. */
  wheatYield: number;
  /** Passive Produktion: alle N Ticks ein Ei. 600 = alle 10 Minuten. */
  coopTicksPerEgg: number;
  /** NPC-Ankaufpreise — kein geteilter knapper Zustand, daher offline gültig (§8). */
  npcPrices: { wheat: number; eggs: number };

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

const V1: Ruleset = {
  version: 1,
  siloCapacity: 100,
  wheatGrowTicks: 7200,
  wheatYield: 10,
  coopTicksPerEgg: 600,
  npcPrices: { wheat: 3, eggs: 5 },
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
 * Client ab (R1).
 */
const V2: Ruleset = {
  version: 2,
  siloCapacity: 120,
  wheatGrowTicks: 5400,
  wheatYield: 10,
  coopTicksPerEgg: 480,
  npcPrices: { wheat: 4, eggs: 6 },
  // Mehr Slots als Progressions-Buff. Achtung: WENIGER Slots wären ein
  // Migrationsproblem — bestehende Aufträge würden die Invariante verletzen
  // und müssten in einem Migrationsschritt ins Postfach aufgelöst werden.
  orderSlots: 6,
  orderTtlTicks: 86_400,
  priceBandMinPct: 25,
  priceBandMaxPct: 150,
  mailCapacity: 20,
};

/**
 * Feldtest-Tempo: dieselben Regeln, nur schnelle Uhren.
 *
 * Mit zwei Stunden Wachstumszeit lässt sich ein Verbindungstest von Hand kaum
 * durchführen — ohne erntereifes Feld und ohne Ware im Lager wird jede Aktion
 * lokal abgelehnt, und die Warteschlange bleibt leer. Dann testet man nichts.
 *
 * Es ist bewusst eine eigene Ruleset-VERSION und kein Schalter: Regeln sind
 * versionierte Daten (R2). Damit lässt sich der Wechsel obendrein als echter
 * Balance-Patch beobachten — inklusive fairer Umrechnung laufender Felder.
 */
const V3: Ruleset = {
  version: 3,
  siloCapacity: 120,
  wheatGrowTicks: 60,
  wheatYield: 10,
  coopTicksPerEgg: 20,
  npcPrices: { wheat: 4, eggs: 6 },
  orderSlots: 6,
  orderTtlTicks: 600,
  priceBandMinPct: 25,
  priceBandMaxPct: 150,
  mailCapacity: 20,
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
]);

export const CURRENT_RULESET_VERSION = 1;

/** Die Version, auf die der Server neue Snapshots hebt. */
export const LATEST_RULESET_VERSION = 2;

/** Schnelle Uhren für den Feldtest — siehe V3. */
export const FIELD_TEST_RULESET_VERSION = 3;

export function getRuleset(version: number): Ruleset {
  const r = RULESETS.get(version);
  if (!r) throw new Error(`unsupported ruleset version: ${version}`);
  return r;
}

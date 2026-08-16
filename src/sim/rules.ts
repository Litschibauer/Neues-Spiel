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
};

const V1: Ruleset = {
  version: 1,
  siloCapacity: 100,
  wheatGrowTicks: 7200,
  wheatYield: 10,
  coopTicksPerEgg: 600,
  npcPrices: { wheat: 3, eggs: 5 },
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
};

/**
 * Der Server hält bewusst mehrere Versionen vor (R2). Ein Client, dessen Version
 * hier nicht mehr steht, muss vor dem Sync updaten — sauberer, angekündigter
 * Bruch statt stiller Divergenz.
 */
export const RULESETS: ReadonlyMap<number, Ruleset> = new Map([
  [1, V1],
  [2, V2],
]);

export const CURRENT_RULESET_VERSION = 1;

/** Die Version, auf die der Server neue Snapshots hebt. */
export const LATEST_RULESET_VERSION = 2;

export function getRuleset(version: number): Ruleset {
  const r = RULESETS.get(version);
  if (!r) throw new Error(`unsupported ruleset version: ${version}`);
  return r;
}

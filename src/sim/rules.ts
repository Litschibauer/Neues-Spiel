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
 * Der Server hält bewusst mehrere Versionen vor (R2). Ein Client, dessen Version
 * hier nicht mehr steht, muss vor dem Sync updaten — sauberer, angekündigter
 * Bruch statt stiller Divergenz.
 */
export const RULESETS: ReadonlyMap<number, Ruleset> = new Map([[1, V1]]);

export const CURRENT_RULESET_VERSION = 1;

export function getRuleset(version: number): Ruleset {
  const r = RULESETS.get(version);
  if (!r) throw new Error(`unsupported ruleset version: ${version}`);
  return r;
}

/**
 * Zustands-Hash — der „Kanarienvogel" aus Risiko R1.
 *
 * Der Client schickt beim Sync den Hash seines lokal berechneten Zustands mit.
 * Weicht er vom Server-Hash ab, ist das ein *Determinismus-Bug*, kein Cheat:
 * Der Server hat den Log ja soeben selbst nach denselben Regeln validiert.
 *
 * Genau diese Trennung entscheidet, ob ehrliche Spieler bestraft werden —
 * ein Hash-Mismatch gehört ins Monitoring, nicht in eine Sanktion.
 *
 * Die kanonische Form steht in `canonical.ts`, SHA-256 in `sha256.ts` — beide
 * ohne jede Plattform-API. Damit läuft auch der Kanarienvogel überall gleich:
 * Node, Browser, Mobile.
 */

import type { State } from './state.ts';
import type { Command } from './commands.ts';
import { canonicalize, canonicalizeCommand } from './canonical.ts';
import { sha256Hex } from './sha256.ts';

export { canonicalize, canonicalizeCommand };

export function hashState(state: State): string {
  return sha256Hex(canonicalize(state)).slice(0, 16);
}

/**
 * Identität eines Command-Batches.
 *
 * Wird für die Idempotenz-Prüfung gebraucht: Die `seq` allein reicht NICHT, um
 * einen wiederholten Sync von einem Multi-Device-Fork (R3) zu unterscheiden —
 * zwei Geräte, die vom selben Snapshot aus offline gehen, vergeben zwangsläufig
 * dieselben Sequenznummern für völlig verschiedene Aktionen.
 */
export function hashCommands(cmds: readonly Command[]): string {
  const canonical = cmds.map(canonicalizeCommand).join(';');
  return sha256Hex(canonical).slice(0, 16);
}

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
 * Die eigentliche kanonische Form steht in `canonical.ts` und kommt ohne
 * Krypto aus; hier kommt nur noch SHA-256 obendrauf.
 */

import { createHash } from 'node:crypto';
import type { State } from './state.ts';
import type { Command } from './commands.ts';
import { canonicalize, canonicalizeCommand } from './canonical.ts';

export { canonicalize, canonicalizeCommand };

export function hashState(state: State): string {
  return createHash('sha256').update(canonicalize(state)).digest('hex').slice(0, 16);
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
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

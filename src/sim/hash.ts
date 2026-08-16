/**
 * Zustands-Hash — der „Kanarienvogel" aus Risiko R1.
 *
 * Der Client schickt beim Sync den Hash seines lokal berechneten Zustands mit.
 * Weicht er vom Server-Hash ab, ist das ein *Determinismus-Bug*, kein Cheat:
 * Der Server hat den Log ja soeben selbst nach denselben Regeln validiert.
 *
 * Genau diese Trennung entscheidet, ob ehrliche Spieler bestraft werden —
 * ein Hash-Mismatch gehört ins Monitoring, nicht in eine Sanktion.
 */

import { createHash } from 'node:crypto';
import type { State } from './state.ts';
import type { Command } from './commands.ts';

/**
 * Kanonische Serialisierung: feste Schlüsselreihenfolge, Arrays in Indexreihenfolge.
 * Kein `JSON.stringify(obj)` über Objekte — dessen Reihenfolge ist zwar in der
 * Praxis stabil, aber nichts, worauf man einen Konsistenzbeweis stützen will.
 */
export function canonicalize(state: State): string {
  const fields = state.fields.map((f) => `${f.crop ?? '-'}:${f.plantedAt}`).join(',');
  return [
    `tick=${state.tick}`,
    `fields=[${fields}]`,
    `wheat=${state.wheat}`,
    `eggs=${state.eggs}`,
    `gold=${state.gold}`,
    `coopProgress=${state.coopProgress}`,
  ].join('|');
}

export function hashState(state: State): string {
  return createHash('sha256').update(canonicalize(state)).digest('hex').slice(0, 16);
}

function canonicalizeCommand(c: Command): string {
  switch (c.type) {
    case 'PLANT':
      return `${c.seq}|${c.tick}|PLANT|${c.field}`;
    case 'HARVEST':
      return `${c.seq}|${c.tick}|HARVEST|${c.field}`;
    case 'SELL_NPC':
      return `${c.seq}|${c.tick}|SELL_NPC|${c.item}|${c.amount}`;
    default:
      throw new Error('unknown command type');
  }
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

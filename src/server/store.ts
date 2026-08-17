/**
 * Persistenz für den Feldtest-Server.
 *
 * Bewusst schlicht: eine JSON-Datei, atomar geschrieben. Für einen Mini-Server
 * mit 1 GB RAM und einem Spielstand ist eine Datenbank Overkill — und der Punkt
 * dieses Servers ist das Netzwerkverhalten, nicht die Speicherschicht.
 *
 * Atomar heißt hier: erst in eine Nebendatei schreiben, dann umbenennen. Ein
 * Stromausfall mitten im Schreiben hinterlässt damit den alten Stand statt
 * einer halben Datei — bei einem Spielstand, der Fortschritt trägt, ist das
 * der Unterschied zwischen „nichts passiert" und „alles weg".
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Command } from '../sim/commands.ts';
import type { MailItem } from '../sim/state.ts';
import type { Snapshot } from './server.ts';

export type Persisted = {
  version: 1;
  snapshot: Snapshot;
  appliedLog: Command[];
  pendingDeliveries: MailItem[];
  targetRulesetVersion: number;
  /**
   * Nächste Kundenauftrags-Nummer.
   *
   * Muss mitgespeichert werden: Fiele der Zähler beim Neustart auf 1 zurück,
   * bekäme ein neuer Auftrag dieselbe Nummer wie einer, der noch in der
   * Schlange steht — und `FILL_REQUEST` wüsste nicht mehr, welcher gemeint ist.
   */
  nextRequestId?: number;
};

export function load(path: string): Persisted | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as Persisted;
  if (parsed.version !== 1) throw new Error(`unbekannte Speicherversion: ${parsed.version}`);
  return parsed;
}

export function save(path: string, data: Persisted): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, path);
}

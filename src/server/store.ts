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

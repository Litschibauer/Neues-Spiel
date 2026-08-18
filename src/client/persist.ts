import { Client } from './client.ts';
import type { Command } from '../sim/commands.ts';
import { getRuleset } from '../sim/rules.ts';
import { simulateAll } from '../sim/sim.ts';
import { normalizeState } from '../sim/state.ts';
import type { Snapshot } from '../server/server.ts';

export type PersistedClient = {
  version: 1;
  snapshot: Snapshot;
  queue: Command[];
  deviceId?: string;
  clockOffsetMs: number;
};

export function serializeClient(client: Client, clockOffsetMs: number): PersistedClient {
  return {
    version: 1,
    snapshot: client.baseSnapshot,
    queue: [...client.queue],
    deviceId: client.deviceId,
    clockOffsetMs,
  };
}

export type RestoreResult = {
  client: Client;
  clockOffsetMs: number;
  queueDropped: boolean;
};

export function restoreClient(data: PersistedClient): RestoreResult {
  if (data.version !== 1) throw new Error(`unbekannter Client-Speicherstand: ${data.version}`);

  const snapshot = { ...data.snapshot, state: normalizeState(data.snapshot.state) };
  const client = new Client(snapshot, data.deviceId);
  const rules = getRuleset(snapshot.rulesetVersion);

  let queueDropped = false;
  if (data.queue.length > 0) {
    try {
      client.state = simulateAll(snapshot.state, data.queue, rules);
      client.queue = [...data.queue];
      client.localTick = data.queue[data.queue.length - 1]!.tick;
    } catch {
      queueDropped = true;
    }
  }

  return { client, clockOffsetMs: data.clockOffsetMs, queueDropped };
}

export function storageKeyFor(origin: string): string {
  return `ns-save:${origin}`;
}

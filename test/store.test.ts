import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load, save } from '../src/server/store.ts';
import type { Persisted } from '../src/server/store.ts';
import { Server } from '../src/server/server.ts';
import { initialState } from '../src/sim/state.ts';
import { CURRENT_RULESET_VERSION, getRuleset } from '../src/sim/rules.ts';
import { Client } from '../src/client/client.ts';

const T0 = 1_700_000_000_000;
const rules = getRuleset(CURRENT_RULESET_VERSION);
const WHEAT = 1;
const EGGS = 2;
const R_WHEAT = 0;

function tempFile(): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'neues-spiel-'));
  return { path: join(dir, 'save.json'), dir };
}

function snapshotOf(server: Server): Persisted {
  return {
    version: 1,
    snapshot: server.snapshot,
    appliedLog: server.appliedLog,
    pendingDeliveries: server.pendingDeliveries,
    targetRulesetVersion: server.targetRulesetVersion,
  };
}

test('ein gespielter Stand überlebt Speichern und Laden unverändert', () => {
  const { path, dir } = tempFile();
  try {
    const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
    const client = new Client(server.snapshot);

    client.start(0, R_WHEAT);
    client.advanceClock(7200);
    client.collect(0);
    client.sellNpc(WHEAT, 5);
    server.deliver({ item: EGGS, amount: 3, arrivedAt: T0 });
    server.sync(client.buildSyncRequest(), T0 + 7200 * 1000);

    save(path, snapshotOf(server));
    const loaded = load(path);

    assert.ok(loaded);
    assert.deepEqual(loaded.snapshot, server.snapshot);
    assert.deepEqual(loaded.appliedLog, server.appliedLog);
    assert.deepEqual(loaded.snapshot.state.items, server.snapshot.state.items);

    const restarted = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
    restarted.snapshot = loaded.snapshot;
    restarted.appliedLog = loaded.appliedLog;

    const client2 = new Client(restarted.snapshot);
    client2.advanceClock(60);
    assert.equal(client2.start(1, R_WHEAT).ok, true);
    const res = restarted.sync(client2.buildSyncRequest(), T0 + 7300 * 1000);
    assert.equal(res.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nicht vorhandene Datei ist kein Fehler, sondern ein neuer Hof', () => {
  const { path, dir } = tempFile();
  try {
    assert.equal(load(path), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Schreiben hinterlässt keine Nebendatei', () => {
  const { path, dir } = tempFile();
  try {
    const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
    save(path, snapshotOf(server));
    save(path, snapshotOf(server));

    assert.deepEqual(readdirSync(dir), ['save.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unbekannte Speicherversion wird abgelehnt statt falsch gedeutet', () => {
  const { path, dir } = tempFile();
  try {
    writeFileSync(path, JSON.stringify({ version: 99 }));
    assert.throws(() => load(path), /Speicherversion/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

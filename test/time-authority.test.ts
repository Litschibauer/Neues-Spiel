/**
 * Zeitautorität (Architektur §4).
 *
 * Der gefährlichste Angriff auf ein Farmgame: Geräteuhr vorstellen und sofort
 * ernten. Der Server darf dem Client-Tick niemals glauben — er misst selbst.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '../src/client/client.ts';
import { Server } from '../src/server/server.ts';
import { CURRENT_RULESET_VERSION } from '../src/sim/rules.ts';
import { initialState } from '../src/sim/state.ts';

const T0 = 1_700_000_000_000;

test('vorgestellte Geräteuhr wird abgelehnt — Ernte findet nicht statt', () => {
  const server = new Server(initialState(3), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  client.plant(0);
  // Der Cheater springt lokal 2h nach vorn …
  client.advanceClock(7200);
  assert.equal(client.harvest(0).ok, true, 'lokal sieht das für den Cheater erst mal gut aus');
  assert.equal(client.state.wheat, 10);

  // … aber real sind nur 10 Sekunden vergangen.
  const res = server.sync(client.buildSyncRequest(), T0 + 10_000);

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'CLOCK_AHEAD_OF_SERVER');

  // Rollback: Der Server-Zustand ist unberührt. „Als wäre nie was passiert."
  assert.equal(res.snapshot.seq, 0);
  assert.equal(res.snapshot.state.wheat, 0);
  assert.equal(res.snapshot.state.fields[0]!.crop, null);

  client.adopt(res.snapshot);
  assert.equal(client.state.wheat, 0);
  assert.equal(client.queue.length, 0);
});

test('echtes Warten wird anerkannt — dieselben Commands, ehrliche Zeit', () => {
  const server = new Server(initialState(3), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  client.plant(0);
  client.advanceClock(7200);
  client.harvest(0);

  const res = server.sync(client.buildSyncRequest(), T0 + 7200 * 1000);

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.snapshot.state.wheat, 10);
});

test('Idle-Progression ist gratis offline-fähig: 2h weg == 2h offline gespielt', () => {
  // Zwei Spieler, identische Aktionen, identische Echtzeit — einer war offline
  // aktiv, einer einfach weg. Der Server kann und muss sie gleich behandeln.
  const a = new Server(initialState(3), T0, CURRENT_RULESET_VERSION);
  const b = new Server(initialState(3), T0, CURRENT_RULESET_VERSION);

  const active = new Client(a.snapshot);
  active.plant(0);
  active.advanceClock(7200);
  active.harvest(0);
  const ra = a.sync(active.buildSyncRequest(), T0 + 7200 * 1000);

  const idle = new Client(b.snapshot);
  idle.plant(0);
  idle.advanceClock(7200);
  idle.harvest(0);
  const rb = b.sync(idle.buildSyncRequest(), T0 + 7200 * 1000);

  assert.equal(ra.ok && rb.ok, true);
  assert.deepEqual(a.snapshot.state, b.snapshot.state);
});

test('Zeit darf nicht rückwärts laufen', () => {
  const server = new Server(initialState(3), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  client.advanceClock(1000);
  client.plant(0);
  client.advanceClock(500);
  client.plant(1);

  // Log manipulieren: zweites Command in die Vergangenheit zurückdatieren.
  const req = client.buildSyncRequest();
  req.commands[1]!.tick = 10;

  const res = server.sync(req, T0 + 2000 * 1000);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'TIME_WENT_BACKWARDS');
});

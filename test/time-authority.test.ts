/**
 * Zeitautorität (Architektur §4).
 *
 * Der gefährlichste Angriff auf ein Farmgame: Geräteuhr vorstellen und sofort
 * ernten. Der Server darf dem Client-Tick niemals glauben — er misst selbst.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, DISCARD_QUEUE } from '../src/client/client.ts';
import { Server } from '../src/server/server.ts';
import { CURRENT_RULESET_VERSION, getRuleset } from '../src/sim/rules.ts';
import { EMPTY_PLOT, initialState, count } from '../src/sim/state.ts';
import { mulberry32 } from './helpers/session.ts';

const T0 = 1_700_000_000_000;
const rules = getRuleset(CURRENT_RULESET_VERSION);
const WHEAT = 1;
const R_WHEAT = 0;
const SEED_COST = rules.recipes[R_WHEAT]!.inputs.find((i) => i.item === WHEAT)?.amount ?? 0;
const START_WHEAT = rules.startingItems.find((x) => x.item === WHEAT)?.amount ?? 0;
/** Weizen nach genau einer Ernte auf einem frischen Hof: Vorrat − Saat + Ertrag. */
const AFTER_ONE = START_WHEAT - SEED_COST + rules.recipes[R_WHEAT]!.output.amount;


test('vorgestellte Geräteuhr wird abgelehnt — Ernte findet nicht statt', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  client.start(0, R_WHEAT);
  // Der Cheater springt lokal 2h nach vorn …
  client.advanceClock(7200);
  assert.equal(client.collect(0).ok, true, 'lokal sieht das für den Cheater erst mal gut aus');
  assert.equal(count(client.state, WHEAT), AFTER_ONE);

  // … aber real sind nur 10 Sekunden vergangen.
  const res = server.sync(client.buildSyncRequest(), T0 + 10_000);

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'CLOCK_AHEAD_OF_SERVER');

  // Rollback: Der Server-Zustand ist unberührt. „Als wäre nie was passiert."
  assert.equal(res.snapshot.seq, 0);
  assert.equal(count(res.snapshot.state, WHEAT), START_WHEAT);
  assert.equal(res.snapshot.state.plots[0]!.recipe, EMPTY_PLOT);

  client.adopt(res.snapshot, DISCARD_QUEUE);
  assert.equal(count(client.state, WHEAT), START_WHEAT);
  assert.equal(client.queue.length, 0);
});

test('echtes Warten wird anerkannt — dieselben Commands, ehrliche Zeit', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  client.start(0, R_WHEAT);
  client.advanceClock(7200);
  client.collect(0);

  const res = server.sync(client.buildSyncRequest(), T0 + 7200 * 1000);

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(count(res.snapshot.state, WHEAT), AFTER_ONE);
});

test('Idle-Progression ist gratis offline-fähig: 2h weg == 2h offline gespielt', () => {
  // Zwei Spieler, identische Aktionen, identische Echtzeit — einer war offline
  // aktiv, einer einfach weg. Der Server kann und muss sie gleich behandeln.
  const a = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  const b = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  // Kundenaufträge würfelt der Server (§5). Für einen Vergleich zweier Server
  // muss der Würfel derselbe sein — sonst vergleicht man den Zufall.
  a.rollRequest = mulberry32(1);
  b.rollRequest = mulberry32(1);

  const active = new Client(a.snapshot);
  active.start(0, R_WHEAT);
  active.advanceClock(7200);
  active.collect(0);
  const ra = a.sync(active.buildSyncRequest(), T0 + 7200 * 1000);

  const idle = new Client(b.snapshot);
  idle.start(0, R_WHEAT);
  idle.advanceClock(7200);
  idle.collect(0);
  const rb = b.sync(idle.buildSyncRequest(), T0 + 7200 * 1000);

  assert.equal(ra.ok && rb.ok, true);
  assert.deepEqual(a.snapshot.state, b.snapshot.state);
});

test('Zeit darf nicht rückwärts laufen', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  client.advanceClock(1000);
  client.start(0, R_WHEAT);
  client.advanceClock(500);
  client.start(1, R_WHEAT);

  // Log manipulieren: zweites Command in die Vergangenheit zurückdatieren.
  const req = client.buildSyncRequest();
  req.commands[1]!.tick = 10;

  const res = server.sync(req, T0 + 2000 * 1000);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'TIME_WENT_BACKWARDS');
});

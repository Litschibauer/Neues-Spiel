import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, DISCARD_QUEUE } from '../src/client/client.ts';
import { Server } from '../src/server/server.ts';
import { serializeClient, restoreClient, storageKeyFor } from '../src/client/persist.ts';
import { getRuleset, CURRENT_RULESET_VERSION } from '../src/sim/rules.ts';
import { initialState, count } from '../src/sim/state.ts';
import { hashState } from '../src/sim/hash.ts';
import { mulberry32, playRandomSession } from './helpers/session.ts';

const T0 = 1_700_000_000_000;
const rules = getRuleset(CURRENT_RULESET_VERSION);
const R_WHEAT = 0;
const WHEAT = 1;
const GROW = rules.recipes[R_WHEAT]!.durationTicks;
const SEED_COST = rules.recipes[R_WHEAT]!.inputs.find((i) => i.item === WHEAT)?.amount ?? 0;
const START_WHEAT = rules.startingItems.find((x) => x.item === WHEAT)?.amount ?? 0;

const AFTER_ONE = START_WHEAT - SEED_COST + rules.recipes[R_WHEAT]!.output.amount;

function roundTrip(client: Client, offset = -1234) {
  const stored = JSON.stringify(serializeClient(client, offset));
  return restoreClient(JSON.parse(stored));
}

function freshServer() {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  server.rollRequest = mulberry32(3);
  server.stockRequests();
  return server;
}

test('ein Neustart mitten in der Sitzung kostet nichts', () => {
  const server = freshServer();
  const client = new Client(server.snapshot, 'geraet-a');

  client.start(0, R_WHEAT);
  client.start(1, R_WHEAT);
  client.advanceClock(GROW);
  client.collect(0);

  const back = roundTrip(client);

  assert.equal(back.queueDropped, false);
  assert.equal(back.clockOffsetMs, -1234, 'Uhr-Abstand vergessen — der Server lehnt sonst ab (§4)');
  assert.equal(back.client.deviceId, 'geraet-a', 'Gerätekennung vergessen (R3)');
  assert.equal(back.client.queue.length, client.queue.length);
  assert.equal(back.client.baseSeq, client.baseSeq);

  assert.deepEqual(back.client.state, client.state);
  assert.equal(hashState(back.client.state), hashState(client.state));
});

test('nach dem Neustart nimmt der Server die Sitzung an — ohne Divergenz', () => {
  const server = freshServer();
  const client = new Client(server.snapshot, 'geraet-a');

  client.start(0, R_WHEAT);
  client.advanceClock(GROW);
  client.collect(0);
  client.sellNpc(WHEAT, 5);

  const back = roundTrip(client).client;
  const res = server.sync(back.buildSyncRequest(), T0 + back.localTick * 1000);

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.kind, 'applied');
  assert.equal(res.divergence, false, 'Kanarienvogel schlägt nach dem Neustart an');
  assert.equal(res.snapshot.seq, client.queue.length);
});

test('gesichert wird der BESTÄTIGTE Snapshot, nicht der vorhergesagte', () => {
  const server = freshServer();
  const client = new Client(server.snapshot);

  client.start(0, R_WHEAT);
  client.advanceClock(GROW);
  client.collect(0);
  assert.equal(count(client.state, WHEAT), AFTER_ONE, 'Testkulisse hat nichts geerntet');

  const blob = serializeClient(client, 0);
  assert.equal(count(blob.snapshot.state, WHEAT), START_WHEAT, 'der Speicherstand ist vorgelaufen');
  assert.equal(
    count(roundTrip(client).client.state, WHEAT),
    AFTER_ONE,
    'nach dem Neustart fehlt die Ernte',
  );
});

test('nach einem Sync ist die Warteschlange auch im Speicher leer', () => {
  const server = freshServer();
  const client = new Client(server.snapshot);

  client.start(0, R_WHEAT);
  const res = server.sync(client.buildSyncRequest(), T0 + 1000);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  client.adopt(res.snapshot, DISCARD_QUEUE);

  const blob = serializeClient(client, 0);
  assert.equal(blob.queue.length, 0);
  assert.equal(blob.snapshot.seq, res.snapshot.seq, 'der neue Snapshot wurde nicht übernommen');
});

test('eine unlesbare Warteschlange kostet die Sitzung, nicht die App', () => {
  const server = freshServer();
  const client = new Client(server.snapshot);
  client.start(0, R_WHEAT);

  const blob = serializeClient(client, 0);

  blob.queue = [{ seq: 1, tick: 0, type: 'START', plot: 99, recipe: 0 }];

  const back = restoreClient(blob);
  assert.equal(back.queueDropped, true, 'kaputte Warteschlange wurde stillschweigend übernommen');
  assert.equal(back.client.queue.length, 0);
  assert.deepEqual(back.client.state, blob.snapshot.state, 'Snapshot ist nicht mehr da');
});

test('ein Speicherstand aus einer anderen Zukunft wird abgelehnt', () => {
  const blob = serializeClient(new Client(freshServer().snapshot), 0);
  assert.throws(() => restoreClient({ ...blob, version: 2 as 1 }), /Speicherstand/);
});

test('Dev- und Produktionsstände liegen nie im selben Fach', () => {
  assert.notEqual(storageKeyFor('http://host:8788'), storageKeyFor('http://host:8787'));
  assert.equal(storageKeyFor('https://hof.example'), storageKeyFor('https://hof.example'));
});

test('zufällige Sitzungen überstehen den Neustart an jeder Stelle', () => {
  for (let seed = 1; seed <= 80; seed++) {
    const server = freshServer();
    const client = playRandomSession(server.snapshot, mulberry32(seed), {
      steps: 30,
      maxAdvance: 600,
      advanceChance: 0.4,
      chaosChance: 0.15,
    });
    if (client.queue.length === 0) continue;

    const back = roundTrip(client).client;
    assert.deepEqual(back.state, client.state, `seed=${seed}: Zustand weicht ab`);
    assert.deepEqual(back.queue, client.queue, `seed=${seed}: Warteschlange weicht ab`);

    const res = server.sync(back.buildSyncRequest(), T0 + back.localTick * 1000);
    assert.equal(res.ok, true, `seed=${seed}: Server lehnt den wiederhergestellten Log ab`);
    if (res.ok) assert.equal(res.divergence, false, `seed=${seed}: Kanarienvogel`);
  }
});

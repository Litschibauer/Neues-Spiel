import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '../src/client/client.ts';
import { SyncEngine } from '../src/client/sync-engine.ts';
import type { Transport } from '../src/client/sync-engine.ts';
import { Server } from '../src/server/server.ts';
import { CURRENT_RULESET_VERSION, getRuleset } from '../src/sim/rules.ts';
import { initialState, count } from '../src/sim/state.ts';
import { mulberry32 } from './helpers/session.ts';

const T0 = 1_700_000_000_000;
const rules = getRuleset(CURRENT_RULESET_VERSION);
const WHEAT = 1;
const R_WHEAT = 0;
const SEED_COST = rules.recipes[R_WHEAT]!.inputs.find((i) => i.item === WHEAT)?.amount ?? 0;
const START_WHEAT = rules.startingItems.find((x) => x.item === WHEAT)?.amount ?? 0;

const AFTER_ONE = START_WHEAT - SEED_COST + rules.recipes[R_WHEAT]!.output.amount;

function setup() {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);
  return { server, client };
}

function makeTransport(server: Server, clock: { now: number }) {
  const state = { online: true, dropResponses: false, calls: 0 };
  const transport: Transport = async (req) => {
    state.calls++;
    if (!state.online) throw new Error('ENETUNREACH');
    const res = server.sync(req, clock.now);
    if (state.dropResponses) throw new Error('ETIMEDOUT');
    return res;
  };
  return { transport, state };
}

test('Tunnel: Spielen läuft weiter, nichts geht verloren, kein Moduswechsel', async () => {
  const { server, client } = setup();
  const clock = { now: T0 };
  const { transport, state } = makeTransport(server, clock);
  const engine = new SyncEngine(client, transport, { rnd: mulberry32(1) });

  client.start(0, R_WHEAT);
  clock.now = T0 + 10_000;
  client.advanceClock(10);
  assert.equal((await engine.attempt(clock.now)).kind, 'synced');
  assert.equal(engine.view, 'live');
  assert.equal(client.queue.length, 0);

  state.online = false;

  client.start(1, R_WHEAT);
  client.advanceClock(7200);
  client.collect(0);
  client.collect(1);
  clock.now = T0 + 7300_000;

  const failed = await engine.attempt(clock.now);
  assert.equal(failed.kind, 'failed');
  assert.equal(engine.view, 'offline');

  assert.equal(client.queue.length, 3);
  assert.equal(client.start(2, R_WHEAT).ok, true);
  assert.equal(client.queue.length, 4);

  const backing = await engine.attempt(clock.now);
  assert.equal(backing.kind, 'backing-off');

  state.online = true;
  clock.now += 120_000;

  const synced = await engine.attempt(clock.now);
  assert.equal(synced.kind, 'synced');
  assert.equal(engine.view, 'live');
  assert.equal(client.queue.length, 0);

  assert.equal(server.snapshot.seq, 5);

  assert.equal(
    count(server.snapshot.state, WHEAT),
    START_WHEAT - 3 * SEED_COST + 2 * rules.recipes[R_WHEAT]!.output.amount,
  );
  assert.equal(server.snapshot.state.plots[2]!.slots[0]!.recipe, R_WHEAT);
});

test('verlorene Antwort: Server hat den Batch, der Client weiß es nicht', async () => {
  const { server, client } = setup();
  const clock = { now: T0 };
  const { transport, state } = makeTransport(server, clock);
  const engine = new SyncEngine(client, transport, { rnd: mulberry32(2) });

  client.start(0, R_WHEAT);
  client.advanceClock(7200);
  client.collect(0);
  clock.now = T0 + 7200_000;

  state.dropResponses = true;
  const lost = await engine.attempt(clock.now);
  assert.equal(lost.kind, 'failed');

  assert.equal(server.snapshot.seq, 2);
  assert.equal(client.queue.length, 2);

  client.advanceClock(600);
  assert.equal(client.start(1, R_WHEAT).ok, true);
  clock.now += 600_000;

  state.dropResponses = false;
  clock.now += 120_000;
  const res = await engine.attempt(clock.now);

  assert.equal(res.kind, 'synced');

  assert.equal(server.snapshot.seq, 3);
  assert.equal(server.snapshot.state.plots[1]!.slots[0]!.recipe, R_WHEAT);

  assert.equal(count(server.snapshot.state, WHEAT), AFTER_ONE - SEED_COST);
  assert.equal(client.queue.length, 0);
});

test('Regression: Wiederaufsetzen ohne Zeitsprung dazwischen', async () => {
  const { server, client } = setup();
  const clock = { now: T0 };
  const { transport, state } = makeTransport(server, clock);
  const engine = new SyncEngine(client, transport, { rnd: mulberry32(11) });

  client.start(0, R_WHEAT);
  clock.now = T0 + 2_000;

  state.dropResponses = true;
  await engine.attempt(clock.now);
  assert.equal(server.snapshot.seq, 1, 'Server hat den Batch angewandt');

  assert.equal(client.start(1, R_WHEAT).ok, true);

  state.dropResponses = false;
  clock.now += 5_000;
  const res = await engine.attempt(clock.now);

  assert.equal(res.kind, 'synced');
  if (res.kind !== 'synced') return;
  assert.equal(res.result.ok, true, 'Wiederaufsetzen darf nicht abgelehnt werden');
  assert.equal(server.snapshot.seq, 2);
  assert.equal(server.snapshot.state.plots[1]!.slots[0]!.recipe, R_WHEAT);
  assert.equal(client.queue.length, 0);
});

test('Snapshot-Zeit bleibt an den verbrauchten Ticks ausgerichtet', async () => {
  const { server, client } = setup();
  const clock = { now: T0 };
  const { transport } = makeTransport(server, clock);
  const engine = new SyncEngine(client, transport, { rnd: mulberry32(12) });

  client.advanceClock(100);
  client.start(0, R_WHEAT);

  clock.now = T0 + 1000 * 1000;
  await engine.attempt(clock.now);

  assert.equal(server.snapshot.state.tick, 100);
  assert.equal(server.snapshot.serverTs, T0 + 100 * 1000, 'serverTs folgt dem Tick, nicht der Uhr');

  client.advanceClock(900);
  assert.equal(client.start(1, R_WHEAT).ok, true);
  const res = await engine.attempt(clock.now);
  assert.equal(res.kind, 'synced');
  assert.equal(server.snapshot.state.tick, 1000);
});

test('verlorene Antwort ohne Weiterspielen bleibt ein sauberes No-op', async () => {
  const { server, client } = setup();
  const clock = { now: T0 };
  const { transport, state } = makeTransport(server, clock);
  const engine = new SyncEngine(client, transport, { rnd: mulberry32(3) });

  client.start(0, R_WHEAT);
  clock.now = T0 + 5_000;

  state.dropResponses = true;
  await engine.attempt(clock.now);
  const afterFirst = structuredClone(server.snapshot.state);

  state.dropResponses = false;
  clock.now += 60_000;
  const res = await engine.attempt(clock.now);

  assert.equal(res.kind, 'synced');
  if (res.kind !== 'synced') return;
  assert.equal(res.result.ok && res.result.kind, 'duplicate');
  assert.equal(engine.resumes, 1);
  assert.deepEqual(server.snapshot.state.plots, afterFirst.plots);
});

test('Fork wird auch über die Engine sauber aufgelöst — Server gewinnt', async () => {
  const { server, client } = setup();
  const clock = { now: T0 };
  const { transport } = makeTransport(server, clock);

  const other = new Client(server.snapshot);
  other.start(2, R_WHEAT);
  other.advanceClock(50);
  server.sync(other.buildSyncRequest(), T0 + 50_000);

  const engine = new SyncEngine(client, transport, { rnd: mulberry32(4) });
  client.start(0, R_WHEAT);
  clock.now = T0 + 60_000;

  const res = await engine.attempt(clock.now);
  assert.equal(res.kind, 'synced');
  if (res.kind !== 'synced') return;
  assert.equal(res.result.ok, false);

  assert.equal(client.queue.length, 0);
  assert.equal(client.state.plots[2]!.slots[0]!.recipe, R_WHEAT);
  assert.equal(engine.view, 'live');
});

test('Präfix-Commit über die Engine: legale Arbeit bleibt, Rest wird gemeldet', async () => {
  const { server, client } = setup();
  const clock = { now: T0 };
  const { transport } = makeTransport(server, clock);
  const engine = new SyncEngine(client, transport, { rnd: mulberry32(5) });

  client.start(0, R_WHEAT);
  client.advanceClock(100);
  client.queue.push({ seq: 2, tick: 100, type: 'START', plot: 0, recipe: R_WHEAT });
  clock.now = T0 + 200_000;

  const res = await engine.attempt(clock.now);

  assert.equal(res.kind, 'dropped');
  if (res.kind !== 'dropped') return;
  assert.equal(res.rejectedFrom, 2);
  assert.equal(server.snapshot.seq, 1);
  assert.equal(client.state.plots[0]!.slots[0]!.recipe, R_WHEAT);
  assert.equal(client.queue.length, 0);
});

test('Thundering Herd: 500 Clients verlassen gleichzeitig den Tunnel', async () => {
  const attempts: number[] = [];

  for (let i = 0; i < 500; i++) {
    const { server, client } = setup();
    const clock = { now: T0 };
    const { transport, state } = makeTransport(server, clock);
    state.online = false;

    const engine = new SyncEngine(client, transport, { rnd: mulberry32(i + 1) });
    client.start(0, R_WHEAT);
    await engine.attempt(clock.now);
    attempts.push(engine.nextAttemptAt - clock.now);
  }

  const min = Math.min(...attempts);
  const max = Math.max(...attempts);

  assert.ok(min >= 1000 && max <= 2000, `Backoff außerhalb der Erwartung: ${min}–${max}ms`);

  const buckets = new Array(10).fill(0);
  for (const a of attempts) {
    const idx = Math.min(9, Math.floor(((a - 1000) / 1000) * 10));
    buckets[idx]++;
  }

  assert.ok(
    buckets.every((n) => n > 0),
    `Lücken in der Streuung: ${buckets.join(', ')}`,
  );

  assert.ok(
    Math.max(...buckets) < (attempts.length / 10) * 3,
    `Ballung in einem Fenster: ${buckets.join(', ')}`,
  );
});

test('wiederholtes Scheitern verlängert den Abstand, statt zu hämmern', async () => {
  const { server, client } = setup();
  const clock = { now: T0 };
  const { transport, state } = makeTransport(server, clock);
  state.online = false;

  const engine = new SyncEngine(client, transport, { rnd: mulberry32(9) });
  client.start(0, R_WHEAT);

  const delays: number[] = [];
  for (let i = 0; i < 6; i++) {
    const res = await engine.attempt(clock.now);
    assert.equal(res.kind, 'failed');
    if (res.kind !== 'failed') return;
    delays.push(res.retryInMs);
    clock.now += res.retryInMs;
  }

  assert.ok(
    Math.max(...delays.slice(3)) > delays[0]!,
    `kein spürbares Backoff: ${delays.join(', ')}`,
  );

  assert.ok(
    Math.max(...delays) <= 5_000,
    `offene Arbeit wartet zu lange: ${delays.join(', ')}`,
  );

  assert.equal(client.queue.length, 1);
});

test('eine ausdrückliche Handlung überspringt das Backoff', async () => {
  const { server, client } = setup();
  const clock = { now: T0 };
  const { transport, state } = makeTransport(server, clock);
  const engine = new SyncEngine(client, transport, { rnd: mulberry32(21) });

  state.online = false;
  client.start(0, R_WHEAT);
  for (let i = 0; i < 4; i++) {
    const res = await engine.attempt(clock.now);
    if (res.kind === 'failed') clock.now += 10;
  }
  assert.equal((await engine.attempt(clock.now)).kind, 'backing-off');

  state.online = true;
  const forced = await engine.attempt(clock.now, true);
  assert.equal(forced.kind, 'synced', 'erzwungener Versuch muss durchgehen');
  assert.equal(client.queue.length, 0);
});

test('eine hängende Leitung blockiert den Client nicht dauerhaft', async () => {
  const { server, client } = setup();

  let hangs = true;
  let aborted = false;
  const transport: Transport = (req, signal) =>
    new Promise((resolve, reject) => {
      if (!hangs) {
        resolve(server.sync(req, T0 + 60_000));
        return;
      }

      signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      });
    });

  const engine = new SyncEngine(client, transport, {
    baseDelayMs: 5,
    maxDelayMs: 10,
    timeoutMs: 40,
    rnd: () => 0.5,
  });

  client.start(0, R_WHEAT);
  const first = await engine.attempt(Date.now(), true);

  assert.equal(first.kind, 'failed');
  if (first.kind === 'failed') assert.equal(first.timedOut, true, 'nicht als Frist erkannt');
  assert.equal(aborted, true, 'die Anfrage läuft im Hintergrund weiter');
  assert.equal(engine.inFlight, false, 'der Client bleibt für immer „beschäftigt"');
  assert.equal(engine.timeouts, 1);

  assert.equal(client.queue.length, 1);

  hangs = false;
  const second = await engine.attempt(Date.now(), true);
  assert.equal(second.kind, 'synced');
  assert.equal(client.queue.length, 0);
  assert.equal(server.snapshot.seq, 1);
});

test('langsam ist nicht kaputt — eine träge Antwort wird abgewartet', async () => {
  const { server, client } = setup();

  const transport: Transport = (req) =>
    new Promise((resolve) => setTimeout(() => resolve(server.sync(req, T0 + 60_000)), 30));

  const engine = new SyncEngine(client, transport, {
    baseDelayMs: 5,
    maxDelayMs: 10,
    timeoutMs: 400,
    rnd: () => 0.5,
  });

  client.start(0, R_WHEAT);
  const outcome = await engine.attempt(Date.now(), true);

  assert.equal(outcome.kind, 'synced');
  assert.equal(engine.timeouts, 0);
  assert.equal(server.snapshot.seq, 1);
});

test('nach einer Frist ist der erneute Versuch sicher', async () => {
  const { server, client } = setup();

  let swallowResponse = true;
  const transport: Transport = (req, signal) =>
    new Promise((resolve, reject) => {
      const result = server.sync(req, T0 + 600_000);
      if (!swallowResponse) {
        resolve(result);
        return;
      }

      signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });

  const engine = new SyncEngine(client, transport, {
    baseDelayMs: 5,
    maxDelayMs: 10,
    timeoutMs: 30,
    rnd: () => 0.5,
  });

  client.start(0, R_WHEAT);
  client.advanceClock(rules.recipes[R_WHEAT]!.durationTicks);
  client.collect(0);
  await engine.attempt(Date.now(), true);
  assert.equal(server.snapshot.seq, 2, 'der Server hat den Batch nicht angewandt');

  swallowResponse = false;
  const again = await engine.attempt(Date.now(), true);
  assert.equal(again.kind, 'synced');
  if (again.kind === 'synced') assert.equal(again.result.kind, 'duplicate');

  assert.equal(count(server.snapshot.state, WHEAT), AFTER_ONE);
  assert.equal(server.snapshot.seq, 2);
});

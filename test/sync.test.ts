import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, DISCARD_QUEUE } from '../src/client/client.ts';
import { Server } from '../src/server/server.ts';
import { SyncEngine } from '../src/client/sync-engine.ts';
import { CURRENT_RULESET_VERSION, getRuleset } from '../src/sim/rules.ts';
import { EMPTY_PLOT, initialState } from '../src/sim/state.ts';

const T0 = 1_700_000_000_000;
const rules = getRuleset(CURRENT_RULESET_VERSION);
const R_WHEAT = 0;

test('Präfix-Commit: ein illegales Command kippt nicht die legale Arbeit davor', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);

  const res = server.sync(
    {
      baseSeq: 0,
      rulesetVersion: CURRENT_RULESET_VERSION,
      commands: [
        { seq: 1, tick: 0, type: 'START', plot: 0, recipe: R_WHEAT },
        { seq: 2, tick: 100, type: 'START', plot: 0, recipe: R_WHEAT },
        { seq: 3, tick: 200, type: 'START', plot: 1, recipe: R_WHEAT },
      ],
    },
    T0 + 200 * 1000,
  );

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.kind, 'partial');
  assert.equal(res.rejectedFrom, 2);
  assert.equal(res.reason, 'ILLEGAL_COMMAND:PLOT_BUSY');

  assert.equal(server.snapshot.seq, 1);
  assert.equal(server.snapshot.state.plots[0]!.slots[0]!.recipe, R_WHEAT);

  assert.equal(server.snapshot.state.plots[1]!.slots[0]!.recipe, EMPTY_PLOT);
});

test('ist schon das erste neue Command illegal, wird gar nichts übernommen', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  server.sync(
    {
      baseSeq: 0,
      rulesetVersion: CURRENT_RULESET_VERSION,
      commands: [{ seq: 1, tick: 0, type: 'START', plot: 0, recipe: R_WHEAT }],
    },
    T0 + 1000,
  );

  const res = server.sync(
    {
      baseSeq: 1,
      rulesetVersion: CURRENT_RULESET_VERSION,
      commands: [{ seq: 2, tick: 100, type: 'START', plot: 0, recipe: R_WHEAT }],
    },
    T0 + 100 * 1000,
  );

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'ILLEGAL_COMMAND:PLOT_BUSY');
  assert.equal(server.snapshot.seq, 1);
});

test('R8 — ein wiederholter Sync ist ein No-op, kein Fehler', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  client.start(0, R_WHEAT);
  client.advanceClock(7200);
  client.collect(0);

  const req = client.buildSyncRequest();
  const first = server.sync(req, T0 + 7200 * 1000);
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const stateAfterFirst = structuredClone(server.snapshot.state);

  const second = server.sync(req, T0 + 7300 * 1000);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.kind, 'duplicate');
  assert.deepEqual(server.snapshot.state, stateAfterFirst, 'darf nicht doppelt angewandt werden');
});

test('R3 — Multi-Device-Fork wird erkannt statt still übernommen', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);

  const phone = new Client(server.snapshot);
  const tablet = new Client(server.snapshot);

  phone.start(0, R_WHEAT);
  phone.advanceClock(100);

  tablet.start(1, R_WHEAT);
  tablet.advanceClock(100);

  const r1 = server.sync(phone.buildSyncRequest(), T0 + 100 * 1000);
  assert.equal(r1.ok, true);

  const r2 = server.sync(tablet.buildSyncRequest(), T0 + 100 * 1000);
  assert.equal(r2.ok, false);
  if (r2.ok) return;
  assert.equal(r2.reason, 'FORK_DETECTED');

  tablet.adopt(r2.snapshot, DISCARD_QUEUE);
  assert.equal(tablet.state.plots[0]!.slots[0]!.recipe, R_WHEAT);
  assert.equal(tablet.state.plots[1]!.slots[0]!.recipe, EMPTY_PLOT);
});

test('Regression: Fork und Replay teilen sich Sequenznummern — Inhalt entscheidet', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);

  const original = {
    baseSeq: 0,
    rulesetVersion: CURRENT_RULESET_VERSION,
    commands: [{ seq: 1, tick: 0, type: 'START' as const, plot: 0, recipe: R_WHEAT }],
  };
  assert.equal(server.sync(original, T0 + 1000).ok, true);

  const forked = {
    baseSeq: 0,
    rulesetVersion: CURRENT_RULESET_VERSION,
    commands: [{ seq: 1, tick: 0, type: 'START' as const, plot: 2, recipe: R_WHEAT }],
  };
  const res = server.sync(forked, T0 + 2000);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'FORK_DETECTED');

  const replay = server.sync(original, T0 + 3000);
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  assert.equal(replay.kind, 'duplicate');
});

test('R2 — nicht mehr unterstützte Ruleset-Version erzwingt ein Update', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);

  const res = server.sync(
    { baseSeq: 0, rulesetVersion: 99, commands: [{ seq: 1, tick: 0, type: 'START', plot: 0, recipe: R_WHEAT }] },
    T0 + 1000,
  );

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'UNSUPPORTED_RULESET');
});

test('Lücken in der Sequenz werden abgelehnt', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);

  const res = server.sync(
    {
      baseSeq: 0,
      rulesetVersion: CURRENT_RULESET_VERSION,
      commands: [
        { seq: 1, tick: 0, type: 'START', plot: 0, recipe: R_WHEAT },
        { seq: 3, tick: 10, type: 'START', plot: 1, recipe: R_WHEAT },
      ],
    },
    T0 + 100 * 1000,
  );

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'SEQ_GAP');
});

test('R1 — der Kanarienvogel schlägt bei einem Determinismus-Bug an', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  client.start(0, R_WHEAT);
  client.advanceClock(7200);
  client.collect(0);

  const req = client.buildSyncRequest();
  req.clientHash = 'deadbeefdeadbeef';

  const res = server.sync(req, T0 + 7200 * 1000);

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.divergence, true);
  assert.equal(server.divergenceAlerts.length, 1);
  assert.equal(server.divergenceAlerts[0]!.clientHash, 'deadbeefdeadbeef');
});

test('R3 — das zweite Gerät wird abgewiesen, BEVOR es Arbeit verliert', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);

  const phone = new Client(server.snapshot, 'handy');
  phone.start(0, R_WHEAT);
  phone.advanceClock(10);
  assert.equal(server.sync(phone.buildSyncRequest(), T0 + 10_000).ok, true);
  assert.equal(server.activeDevice?.id, 'handy');

  assert.equal(server.isActiveDevice('tablet'), false);
  assert.equal(server.isActiveDevice('handy'), true);

  const tablet = new Client(server.snapshot, 'tablet');
  tablet.start(1, R_WHEAT);
  tablet.advanceClock(10);
  const res = server.sync(tablet.buildSyncRequest(), T0 + 20_000);

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'NOT_ACTIVE_DEVICE');

  assert.equal(server.snapshot.seq, 1);
  assert.equal(server.snapshot.state.plots[1]!.slots[0]!.recipe, EMPTY_PLOT);
});

test('R3 — ausdrückliche Übernahme geht durch', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  const phone = new Client(server.snapshot, 'handy');
  phone.start(0, R_WHEAT);
  phone.advanceClock(10);
  server.sync(phone.buildSyncRequest(), T0 + 10_000);

  const tablet = new Client(server.snapshot, 'tablet');
  tablet.start(1, R_WHEAT);
  tablet.advanceClock(10);
  tablet.takeover = true;

  const res = server.sync(tablet.buildSyncRequest(), T0 + 20_000);
  assert.equal(res.ok, true);
  assert.equal(server.activeDevice?.id, 'tablet');
  assert.equal(server.snapshot.state.plots[1]!.slots[0]!.recipe, R_WHEAT);

  const back = server.sync(
    { baseSeq: 2, rulesetVersion: CURRENT_RULESET_VERSION, commands: [], deviceId: 'handy' },
    T0 + 30_000,
  );
  assert.equal(back.ok, false);
  if (back.ok) return;
  assert.equal(back.reason, 'NOT_ACTIVE_DEVICE');
});

test('ohne Geräte-Kennung bleibt alles wie vorher', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  const withId = new Client(server.snapshot, 'handy');
  withId.start(0, R_WHEAT);
  withId.advanceClock(10);
  server.sync(withId.buildSyncRequest(), T0 + 10_000);

  const script = server.sync(
    {
      baseSeq: 1,
      rulesetVersion: CURRENT_RULESET_VERSION,
      commands: [{ seq: 2, tick: 20, type: 'START', plot: 1, recipe: R_WHEAT }],
    },
    T0 + 20_000,
  );
  assert.equal(script.ok, true, 'Anfragen ohne deviceId dürfen nicht gesperrt werden');
  assert.equal(server.activeDevice?.id, 'handy', 'und sie beanspruchen die Rechte nicht');
});

test('Aktionen während eines laufenden Syncs überleben die Antwort', async () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot, 'handy');

  client.start(0, R_WHEAT);

  let queuedDuringFlight = false;
  const engine = new SyncEngine(
    client,
    async (req) => {
      const result = server.sync(req, T0 + 30_000);
      if (!queuedDuringFlight) {
        queuedDuringFlight = true;
        client.advanceClock(5);
        client.start(1, R_WHEAT);
      }
      return result;
    },
    { baseDelayMs: 1, maxDelayMs: 2 },
  );

  const outcome = await engine.attempt(Date.now(), true);
  assert.equal(outcome.kind, 'synced');

  assert.equal(client.baseSeq, 1, 'der gesendete Zug ist nicht bestätigt');
  assert.equal(client.queue.length, 1, 'der Zug während des Fluges ist verschwunden');
  assert.equal(client.queue[0]!.type, 'START');

  assert.equal(client.queue[0]!.seq, 2);

  const second = server.sync(client.buildSyncRequest(), T0 + 60_000);
  assert.equal(second.ok, true);
  assert.notEqual(second.snapshot.state.plots[0]!.slots[0]!.recipe, EMPTY_PLOT);
  assert.notEqual(second.snapshot.state.plots[1]!.slots[0]!.recipe, EMPTY_PLOT);
});

test('vom Server abgelehnte Commands wandern nicht zurück in die Warteschlange', async () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot, 'handy');

  client.start(0, R_WHEAT);
  client.advanceClock(1);
  client.start(1, R_WHEAT);

  const engine = new SyncEngine(
    client,
    async (req) => ({
      ok: true as const,
      kind: 'partial' as const,
      snapshot: server.sync({ ...req, commands: req.commands.slice(0, 1) }, T0 + 30_000).snapshot,
      divergence: null,
      rejectedFrom: 2,
      reason: 'ILLEGAL_COMMAND:OFFER_GONE',
    }),
    { baseDelayMs: 1, maxDelayMs: 2 },
  );

  const outcome = await engine.attempt(Date.now(), true);
  assert.equal(outcome.kind, 'dropped');
  assert.equal(client.baseSeq, 1);
  assert.equal(client.queue.length, 0, 'der abgelehnte Zug steht wieder in der Schlange');
});

test('mit Arbeit in der Warteschlange wartet die Maschine nie eine halbe Minute', async () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot, 'handy');
  client.start(0, R_WHEAT);

  const engine = new SyncEngine(
    client,
    async () => {
      throw new Error('Server ist weg');
    },
    { baseDelayMs: 2_000, maxDelayMs: 30_000, pendingMaxDelayMs: 5_000, rnd: () => 1 },
  );

  let jetzt = T0;
  let laengste = 0;
  for (let i = 0; i < 12; i++) {
    const outcome = await engine.attempt(jetzt, true);
    assert.equal(outcome.kind, 'failed');
    if (outcome.kind === 'failed') laengste = Math.max(laengste, outcome.retryInMs);
    jetzt += outcome.kind === 'failed' ? outcome.retryInMs : 0;
  }

  assert.ok(laengste <= 5_000, `Wartezeit bei offener Arbeit: ${laengste} ms`);
  assert.ok(engine.consecutiveFailures >= 12);
});

test('ohne Arbeit darf sie sich Zeit lassen — sonst hämmert jeder Hof den Server', async () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot, 'handy');

  const engine = new SyncEngine(
    client,
    async () => {
      throw new Error('Server ist weg');
    },
    { baseDelayMs: 2_000, maxDelayMs: 30_000, pendingMaxDelayMs: 5_000, rnd: () => 1 },
  );

  let jetzt = T0;
  let letzte = 0;
  for (let i = 0; i < 12; i++) {
    const outcome = await engine.attempt(jetzt, true);
    if (outcome.kind === 'failed') {
      letzte = outcome.retryInMs;
      jetzt += outcome.retryInMs;
    }
  }
  assert.ok(letzte > 5_000, `leere Schlange bremst nicht aus: ${letzte} ms`);
});

test('meldet sich der Server zurück, wird nicht erst die Strafzeit abgesessen', async () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot, 'handy');
  client.start(0, R_WHEAT);

  let erreichbar = false;
  const engine = new SyncEngine(
    client,
    async (req) => {
      if (!erreichbar) throw new Error('Server ist weg');
      return server.sync(req, T0 + 30_000);
    },
    { baseDelayMs: 2_000, maxDelayMs: 30_000, pendingMaxDelayMs: 5_000, rnd: () => 1 },
  );

  let jetzt = T0;
  for (let i = 0; i < 5; i++) {
    await engine.attempt(jetzt, true);
  }
  assert.equal((await engine.attempt(jetzt)).kind, 'backing-off', 'die Maschine wartet gar nicht');

  erreichbar = true;
  engine.revive();

  const sofort = await engine.attempt(jetzt);
  assert.equal(sofort.kind, 'synced', 'nach dem Lebenszeichen wird weiter gewartet');
  assert.equal(client.queue.length, 0);
});

test('eine neue Aktion kürzt die Wartezeit, verlängert sie aber nie', async () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot, 'handy');

  const engine = new SyncEngine(
    client,
    async () => {
      throw new Error('Server ist weg');
    },
    { baseDelayMs: 2_000, maxDelayMs: 30_000, pendingMaxDelayMs: 5_000, rnd: () => 1 },
  );

  engine.nextAttemptAt = T0 + 30_000;
  engine.hurry(T0);
  assert.equal(engine.nextAttemptAt, T0 + 2_000);

  engine.nextAttemptAt = T0 + 500;
  engine.hurry(T0);
  assert.equal(engine.nextAttemptAt, T0 + 500, 'die Wartezeit wurde verlängert');
});

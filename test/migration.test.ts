import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, DISCARD_QUEUE } from '../src/client/client.ts';
import { Server } from '../src/server/server.ts';
import { getRuleset } from '../src/sim/rules.ts';
import type { Ruleset } from '../src/sim/rules.ts';
import { EMPTY_PLOT, initialState, count } from '../src/sim/state.ts';
import {
  GROW,
  GROW_AND_RETIME,
  migrateState,
  assertInvariants,
  MigrationError,
} from '../src/sim/migrate.ts';
import { fuzzStart, mulberry32, playRandomSession } from './helpers/session.ts';

const T0 = 1_700_000_000_000;
const V1 = getRuleset(1);
const V2 = getRuleset(2);

const WHEAT = 1;
const EGGS = 3;
const R_WHEAT = 0;
const MILL = 6;

const wheatTicks = (r: Ruleset) => r.recipes[R_WHEAT]!.durationTicks;

test('das Testszenario ist überhaupt aussagekräftig — V2 ändert das Ergebnis', () => {
  assert.notEqual(wheatTicks(V1), wheatTicks(V2));
  assert.notEqual(V1.items[WHEAT]!.npcPrice, V2.items[WHEAT]!.npcPrice);
  assert.notEqual(V1.siloCapacity, V2.siloCapacity);
});

test('offline unter V1 gespielt, Patch kommt, Sync rechnet trotzdem unter V1', () => {
  const server = new Server(initialState(V1), T0, 1);
  const client = new Client(server.snapshot);

  client.start(0, R_WHEAT);
  client.advanceClock(wheatTicks(V1));
  assert.equal(client.collect(0).ok, true);

  server.targetRulesetVersion = 2;

  const res = server.sync(client.buildSyncRequest(), T0 + wheatTicks(V1) * 1000);

  assert.equal(res.ok, true);
  if (!res.ok) return;

  assert.equal(res.kind, 'applied');
  assert.equal(res.divergence, false);
  const seed = V1.recipes[R_WHEAT]!.inputs.find((i) => i.item === WHEAT)?.amount ?? 0;
  const startWheat = V1.startingItems.find((x) => x.item === WHEAT)?.amount ?? 0;
  assert.equal(
    count(res.snapshot.state, WHEAT),
    startWheat - seed + V1.recipes[R_WHEAT]!.output.amount,
  );

  assert.equal(res.snapshot.rulesetVersion, 2);
});

test('nach der Migration gelten die neuen Regeln — kürzere Wachstumszeit', () => {
  const server = new Server(initialState(V1), T0, 1, 2);
  const client = new Client(server.snapshot);

  client.start(0, R_WHEAT);
  client.advanceClock(10);
  const first = server.sync(client.buildSyncRequest(), T0 + 10_000);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.snapshot.rulesetVersion, 2);

  client.adopt(first.snapshot, DISCARD_QUEUE);
  assert.equal(client.rulesetVersion, 2);

  client.advanceClock(wheatTicks(V2));
  assert.equal(client.collect(0).ok, true);
  assert.ok(wheatTicks(V2) < wheatTicks(V1));
});

test('laufende Produktion überlebt den Patch fair — kein Verlust, kein Geschenk', () => {
  const base = initialState(V1);
  const tick = 60;
  const halfGrown = {
    ...base,
    tick,
    plots: base.plots.map((p, i) => {
      if (i === 0) return { ...p, recipe: R_WHEAT, startedAt: 0 };
      if (i === 1) return { ...p, recipe: R_WHEAT, startedAt: tick };
      if (i === 2) return { ...p, recipe: R_WHEAT, startedAt: -500 };
      return p;
    }),
  };

  const migrated = migrateState(halfGrown, 1, 2);
  const remaining = (i: number) =>
    Math.max(0, migrated.plots[i]!.startedAt + wheatTicks(V2) - migrated.tick);

  assert.equal(remaining(0), 60);

  assert.equal(remaining(1), wheatTicks(V2));
  assert.ok(remaining(1) < wheatTicks(V1));

  assert.equal(remaining(2), 0);

  assertInvariants(migrated, V2);
});

test('kein Platz wird durch die Migration schlechter gestellt als ein Neuanfang', () => {
  for (let elapsed = 0; elapsed <= wheatTicks(V1); elapsed++) {
    const tick = 100_000;
    const base = initialState(V1);
    const state = {
      ...base,
      tick,
      plots: base.plots.map((p, i) =>
        i === 0 ? { ...p, recipe: R_WHEAT, startedAt: tick - elapsed } : p,
      ),
    };

    const before = Math.max(0, wheatTicks(V1) - elapsed);
    const m = migrateState(state, 1, 2);
    const after = Math.max(0, m.plots[0]!.startedAt + wheatTicks(V2) - m.tick);

    assert.ok(after <= wheatTicks(V2), `nie schlechter als frisch: ${after}`);
    assert.ok(after <= before, `nie länger als vorher: ${after} > ${before}`);
    assert.ok(after >= 0);
  }
});

test('Ausbaustufen überstehen den Patch unverändert', () => {
  const base = fuzzStart(V1, 500);
  const built = {
    ...base,
    plots: base.plots.map((p, i) => (i === MILL ? { ...p, level: 1 } : p)),
  };

  const migrated = migrateState(built, 1, 2);
  assert.equal(migrated.plots[MILL]!.level, 1);
  assert.equal(count(migrated, 0), 500, 'Münzen bleiben, wie sie waren');
  assertInvariants(migrated, V2);
});

test('Inhalts-Patch: der Zustand wächst, nichts geht verloren', () => {
  const grown: Ruleset = {
    ...V1,
    version: 99,
    items: [...V1.items, { id: 'honey', storable: true, npcPrice: 30 }],
    recipes: [
      ...V1.recipes,
      { id: 'honey', inputs: [], output: { item: 4, amount: 1 }, durationTicks: 1200 },
    ],
    plots: [
      ...V1.plots,
      { id: 'field-7', startLevel: 0, levels: [{ label: 'Feld', cost: [], recipes: [R_WHEAT] }] },
    ],
    passives: [{ id: 'hive', recipe: 3 }],
  };

  const before = {
    ...fuzzStart(V1, 500),
    tick: 900,
    plots: initialState(V1).plots.map((p, i) =>
      i === 0 ? { ...p, recipe: R_WHEAT, startedAt: 800 } : p,
    ),
    orders: [{ id: 1, item: WHEAT, amount: 5, price: 3, listedAt: 850 }],
    mail: [{ item: EGGS, amount: 3, arrivedAt: 870 }],
    nextOrderId: 2,
  };
  before.items = before.items.slice();
  before.items[WHEAT] = 40;

  const after = GROW_AND_RETIME(before, V1, grown);
  assertInvariants(after, grown);

  assert.equal(count(after, 0), 500);
  assert.equal(count(after, WHEAT), 40);

  assert.equal(after.items.length, grown.items.length);
  assert.equal(after.items[4], 0, 'Honig beginnt bei null');
  assert.equal(after.plots.length, grown.plots.length);
  assert.equal(after.plots[9]!.level, 0, 'das neue Feld muss erst gekauft werden');
  assert.equal(after.passives.length, 1);
  assert.equal(after.passives[0], 0);

  assert.equal(after.plots[0]!.recipe, R_WHEAT);
  assert.equal(after.orders.length, 1);
  assert.equal(after.mail.length, 1);
});

test('ein Patch, der einen Platz geschenkt dazugibt, gibt ihn auch bestehenden Höfen', () => {
  const gifted: Ruleset = {
    ...V1,
    version: 98,
    plots: [
      ...V1.plots,
      { id: 'field-7', startLevel: 1, levels: [{ label: 'Feld', cost: [], recipes: [R_WHEAT] }] },
    ],
  };

  const after = GROW(initialState(V1), V1, gifted);
  assert.equal(after.plots[9]!.level, 1, 'geschenkter Platz kommt ausgebaut an');
  assertInvariants(after, gifted);
});

test('Migration erhält Invarianten für zufällige echte Spielstände', () => {
  for (let seed = 1; seed <= 120; seed++) {
    const rnd = mulberry32(seed);
    const server = new Server(fuzzStart(V1, seed % 2 === 0 ? 4000 : 0), T0, 1);
    const client = playRandomSession(server.snapshot, rnd, {
      steps: 25,
      maxAdvance: 800,
      advanceChance: 0.45,
      chaosChance: 0.15,
    });

    const migrated = migrateState(client.state, 1, 2);
    assertInvariants(migrated, V2);

    assert.deepEqual(migrateState(client.state, 1, 2), migrated, `seed=${seed} nicht reproduzierbar`);

    assert.deepEqual(migrated.items, client.state.items, `seed=${seed}: Bestände`);
    assert.deepEqual(
      migrated.plots.map((p) => p.level),
      client.state.plots.map((p) => p.level),
      `seed=${seed}: Ausbaustufen`,
    );
  }
});

test('der Client darf sich seine Regelversion nicht aussuchen', () => {
  const server = new Server(initialState(V1), T0, 1, 2);
  const client = new Client(server.snapshot);
  client.start(0, R_WHEAT);
  client.advanceClock(10);

  server.sync(client.buildSyncRequest(), T0 + 10_000);
  assert.equal(server.snapshot.rulesetVersion, 2);

  const sneaky = client.buildSyncRequest();
  sneaky.rulesetVersion = 1;
  sneaky.baseSeq = server.snapshot.seq;
  sneaky.commands = [
    { seq: server.snapshot.seq + 1, tick: 20, type: 'START', plot: 1, recipe: R_WHEAT },
  ];

  const res = server.sync(sneaky, T0 + 20_000);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'RULESET_MISMATCH');
});

test('unbekannte Zielversion beschädigt keinen Spielstand', () => {
  const server = new Server(initialState(V1), T0, 1);
  server.targetRulesetVersion = 99;

  const client = new Client(server.snapshot);
  client.start(0, R_WHEAT);
  client.advanceClock(10);

  const res = server.sync(client.buildSyncRequest(), T0 + 10_000);

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.snapshot.rulesetVersion, 1);
  assert.equal(res.snapshot.state.plots[0]!.recipe, R_WHEAT);
  assert.equal(server.migrationFailures.length, 1);
});

test('Downgrades werden abgelehnt statt geraten', () => {
  assert.throws(() => migrateState(initialState(V2), 2, 1), MigrationError);
});

test('das Dev-Regelwerk ist kein Migrationsziel', () => {
  assert.throws(() => migrateState(initialState(V1), 1, 1001), MigrationError);
});

test('die Invariantenprüfung hat Zähne', () => {
  const base = initialState(V2);

  const overCap = { ...base, items: [0, V2.siloCapacity + 5, 0, 0] };
  assert.throws(() => assertInvariants(overCap, V2), MigrationError);

  const future = {
    ...base,
    tick: 10,
    plots: base.plots.map((p, i) => (i === 0 ? { ...p, recipe: R_WHEAT, startedAt: 500 } : p)),
  };
  assert.throws(() => assertInvariants(future, V2), MigrationError);

  const overLevel = {
    ...base,
    plots: base.plots.map((p, i) => (i === 0 ? { ...p, level: 9 } : p)),
  };
  assert.throws(() => assertInvariants(overLevel, V2), MigrationError, 'Stufe 9');

  const wrongLevel = {
    ...base,
    plots: base.plots.map((p, i) =>
      i === MILL ? { level: 0, recipe: 1, startedAt: 0 } : p,
    ),
  };
  assert.throws(() => assertInvariants(wrongLevel, V2), MigrationError, 'Rezept auf Stufe 0');

  const shortInventory = { ...base, items: [0, 0, 0] };
  assert.throws(() => assertInvariants(shortInventory, V2), MigrationError);
});

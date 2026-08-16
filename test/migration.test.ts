/**
 * Ruleset-Migration (Risiko R2).
 *
 * Das Szenario, das über die Live-Service-Tauglichkeit entscheidet:
 *
 *   Spieler geht offline → wir shippen einen Balance-Patch → Spieler synct.
 *
 * Rechnet der Server den Log unter den NEUEN Regeln nach, weicht er garantiert
 * vom Client ab und ein ehrlicher Spieler bekommt einen Rollback (R1). Rechnet
 * er unter den alten, muss er alte Versionen vorhalten und den Zustand danach
 * sauber hochheben.
 *
 * Genau das wird hier geprüft.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '../src/client/client.ts';
import { Server } from '../src/server/server.ts';
import { getRuleset } from '../src/sim/rules.ts';
import { initialState } from '../src/sim/state.ts';
import { migrateState, assertInvariants, MigrationError } from '../src/sim/migrate.ts';
import { mulberry32, playRandomSession } from './helpers/session.ts';

const T0 = 1_700_000_000_000;
const V1 = getRuleset(1);
const V2 = getRuleset(2);

test('das Testszenario ist überhaupt aussagekräftig — V2 ändert das Ergebnis', () => {
  // Wären die Versionen gleichwertig, würde der Rest hier nichts beweisen.
  assert.notEqual(V1.wheatGrowTicks, V2.wheatGrowTicks);
  assert.notEqual(V1.coopTicksPerEgg, V2.coopTicksPerEgg);
  assert.notEqual(V1.npcPrices.wheat, V2.npcPrices.wheat);
});

test('offline unter V1 gespielt, Patch kommt, Sync rechnet trotzdem unter V1', () => {
  const server = new Server(initialState(3), T0, 1);
  const client = new Client(server.snapshot);

  // Spieler pflanzt und wartet die V1-Dauer ab (2h).
  client.plant(0);
  client.advanceClock(V1.wheatGrowTicks);
  assert.equal(client.harvest(0).ok, true);

  // ── Während er offline war, shippen wir den Patch ──
  server.targetRulesetVersion = 2;

  const res = server.sync(client.buildSyncRequest(), T0 + V1.wheatGrowTicks * 1000);

  assert.equal(res.ok, true);
  if (!res.ok) return;
  // Kein Rollback, kein Divergenz-Alarm: unter V1 nachgerechnet war alles korrekt.
  assert.equal(res.kind, 'applied');
  assert.equal(res.divergence, false);
  assert.equal(res.snapshot.state.wheat, V1.wheatYield);

  // Und erst JETZT ist der Spieler auf V2.
  assert.equal(res.snapshot.rulesetVersion, 2);
});

test('nach der Migration gelten die neuen Regeln — kürzere Wachstumszeit', () => {
  const server = new Server(initialState(3), T0, 1, 2);
  const client = new Client(server.snapshot);

  client.plant(0);
  client.advanceClock(10);
  const first = server.sync(client.buildSyncRequest(), T0 + 10_000);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.snapshot.rulesetVersion, 2);

  client.adopt(first.snapshot);
  assert.equal(client.rulesetVersion, 2);

  // Unter V1 wäre nach 5400 Ticks nichts reif. Unter V2 schon.
  client.advanceClock(V2.wheatGrowTicks);
  assert.equal(client.harvest(0).ok, true);
  assert.ok(V2.wheatGrowTicks < V1.wheatGrowTicks);
});

test('laufendes Wachstum überlebt den Patch fair — kein Verlust, kein Geschenk', () => {
  const halfGrown = {
    ...initialState(3),
    tick: 3600,
    fields: [
      { crop: 'wheat' as const, plantedAt: 0 }, // 3600 von 7200 → 3600 übrig
      { crop: 'wheat' as const, plantedAt: 3600 }, // frisch → 7200 übrig
      { crop: 'wheat' as const, plantedAt: -7200 }, // längst reif
    ],
  };

  const migrated = migrateState(halfGrown, 1, 2);
  const remaining = (i: number) =>
    Math.max(0, migrated.fields[i]!.plantedAt + V2.wheatGrowTicks - migrated.tick);

  // Halb gewachsen: Restzeit bleibt exakt erhalten.
  assert.equal(remaining(0), 3600);

  // Frisch gepflanzt: startet neu mit der KÜRZEREN neuen Dauer. Der Spieler
  // profitiert vom Buff, statt auf der alten langen Zeit sitzen zu bleiben.
  assert.equal(remaining(1), V2.wheatGrowTicks);
  assert.ok(remaining(1) < 7200);

  // Reif bleibt reif.
  assert.equal(remaining(2), 0);

  assertInvariants(migrated, V2);
});

test('kein Feld wird durch die Migration schlechter gestellt als ein Neuanfang', () => {
  // Die Leitregel als Eigenschaft über den ganzen Wertebereich geprüft.
  for (let elapsed = 0; elapsed <= V1.wheatGrowTicks; elapsed += 60) {
    const tick = 100_000;
    const state = {
      ...initialState(1),
      tick,
      fields: [{ crop: 'wheat' as const, plantedAt: tick - elapsed }],
    };

    const before = Math.max(0, V1.wheatGrowTicks - elapsed);
    const m = migrateState(state, 1, 2);
    const after = Math.max(0, m.fields[0]!.plantedAt + V2.wheatGrowTicks - m.tick);

    assert.ok(after <= V2.wheatGrowTicks, `nie schlechter als frisch: ${after}`);
    assert.ok(after <= before, `nie länger als vorher: ${after} > ${before}`);
    assert.ok(after >= 0);
  }
});

test('Stall-Fortschritt bleibt nach der Migration im gültigen Bereich', () => {
  // V2 legt öfter (480 statt 600), ein Fortschritt von 550 wäre danach ungültig.
  const state = { ...initialState(1), tick: 5000, coopProgress: 550 };
  const migrated = migrateState(state, 1, 2);

  assert.ok(migrated.coopProgress < V2.coopTicksPerEgg);
  assertInvariants(migrated, V2);
});

test('Migration erhält Invarianten für zufällige echte Spielstände', () => {
  // Handgebaute Fälle treffen nie alles. Also: echte Sitzungen spielen und
  // jeden erreichten Zustand durch die Migration schicken.
  for (let seed = 1; seed <= 120; seed++) {
    const rnd = mulberry32(seed);
    const fieldCount = 1 + Math.floor(rnd() * 8);
    const server = new Server(initialState(fieldCount), T0, 1);
    const client = playRandomSession(server.snapshot, rnd, {
      steps: 25,
      maxAdvance: 8000,
      fieldCount,
      advanceChance: 0.45,
      chaosChance: 0.15,
    });

    const migrated = migrateState(client.state, 1, 2);
    assertInvariants(migrated, V2);

    // Migration ist eine reine Funktion: zweimal dasselbe Ergebnis.
    assert.deepEqual(migrateState(client.state, 1, 2), migrated, `seed=${seed} nicht reproduzierbar`);
    // Und sie fasst Bestände nicht an.
    assert.equal(migrated.wheat, client.state.wheat);
    assert.equal(migrated.eggs, client.state.eggs);
    assert.equal(migrated.gold, client.state.gold);
  }
});

test('der Client darf sich seine Regelversion nicht aussuchen', () => {
  // Sonst bliebe man dauerhaft auf günstigen alten Preisen sitzen.
  const server = new Server(initialState(3), T0, 1, 2);
  const client = new Client(server.snapshot);
  client.plant(0);
  client.advanceClock(10);

  server.sync(client.buildSyncRequest(), T0 + 10_000);
  assert.equal(server.snapshot.rulesetVersion, 2);

  // Der Client behauptet jetzt, weiter unter V1 zu spielen.
  const sneaky = client.buildSyncRequest();
  sneaky.rulesetVersion = 1;
  sneaky.baseSeq = server.snapshot.seq;
  sneaky.commands = [{ seq: server.snapshot.seq + 1, tick: 20, type: 'PLANT', field: 1 }];

  const res = server.sync(sneaky, T0 + 20_000);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'RULESET_MISMATCH');
});

test('unbekannte Zielversion beschädigt keinen Spielstand', () => {
  const server = new Server(initialState(3), T0, 1);
  server.targetRulesetVersion = 99; // Patch mit fehlender Migration

  const client = new Client(server.snapshot);
  client.plant(0);
  client.advanceClock(10);

  const res = server.sync(client.buildSyncRequest(), T0 + 10_000);

  // Der Log wird übernommen, die Migration nicht — der Spieler verliert nichts
  // und bleibt einfach auf seiner Version, bis der Fix da ist.
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.snapshot.rulesetVersion, 1);
  assert.equal(res.snapshot.state.fields[0]!.crop, 'wheat');
  assert.equal(server.migrationFailures.length, 1);
});

test('Downgrades werden abgelehnt statt geraten', () => {
  assert.throws(() => migrateState(initialState(3), 2, 1), MigrationError);
});

test('die Invariantenprüfung hat Zähne', () => {
  const overCap = { ...initialState(1), eggs: V2.siloCapacity + 5 };
  assert.throws(() => assertInvariants(overCap, V2), MigrationError);

  const badProgress = { ...initialState(1), coopProgress: V2.coopTicksPerEgg };
  assert.throws(() => assertInvariants(badProgress, V2), MigrationError);

  const future = {
    ...initialState(1),
    tick: 10,
    fields: [{ crop: 'wheat' as const, plantedAt: 500 }],
  };
  assert.throws(() => assertInvariants(future, V2), MigrationError);
});

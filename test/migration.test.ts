/**
 * Ruleset-Migration (Risiko R2).
 *
 * Das Szenario, das über die Live-Service-Tauglichkeit entscheidet:
 *
 *   Spieler geht offline → wir shippen einen Patch → Spieler synct.
 *
 * Rechnet der Server den Log unter den NEUEN Regeln nach, weicht er garantiert
 * vom Client ab und ein ehrlicher Spieler bekommt einen Rollback (R1). Rechnet
 * er unter den alten, muss er alte Versionen vorhalten und den Zustand danach
 * sauber hochheben.
 *
 * Zwei Sorten Patch werden geprüft, und die zweite ist die härtere:
 *   v1 → v2  Zahlen ändern sich (Zeiten, Preise, Kapazität)
 *   v2 → v3  der Zustand WÄCHST (neue Gegenstände, neue Plätze, neue Weide)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '../src/client/client.ts';
import { Server } from '../src/server/server.ts';
import { getRuleset } from '../src/sim/rules.ts';
import { EMPTY_PLOT, initialState, count, stored } from '../src/sim/state.ts';
import { migrateState, assertInvariants, MigrationError } from '../src/sim/migrate.ts';
import { mulberry32, playRandomSession } from './helpers/session.ts';

const T0 = 1_700_000_000_000;
const V1 = getRuleset(1);
const V2 = getRuleset(2);
const V3 = getRuleset(3);
const V4 = getRuleset(4);

const WHEAT = 1;
const EGGS = 2;
const R_WHEAT = 0;

/** Wachstumsdauer von Weizen unter einer Version — die Zahl, die sich ändert. */
const wheatTicks = (r: typeof V1) => r.recipes[R_WHEAT]!.durationTicks;
const eggTicks = (r: typeof V1) => r.recipes[1]!.durationTicks;

test('das Testszenario ist überhaupt aussagekräftig — V2 ändert das Ergebnis', () => {
  // Wären die Versionen gleichwertig, würde der Rest hier nichts beweisen.
  assert.notEqual(wheatTicks(V1), wheatTicks(V2));
  assert.notEqual(eggTicks(V1), eggTicks(V2));
  assert.notEqual(V1.items[WHEAT]!.npcPrice, V2.items[WHEAT]!.npcPrice);
  // Und V3 ändert die FORM, nicht nur Zahlen — das ist der eigentliche R2-Test.
  assert.ok(V3.items.length > V2.items.length);
  assert.ok(V3.plots.length > V2.plots.length);
  assert.ok(V3.passives.length > V2.passives.length);
});

test('offline unter V1 gespielt, Patch kommt, Sync rechnet trotzdem unter V1', () => {
  const server = new Server(initialState(V1), T0, 1);
  const client = new Client(server.snapshot);

  // Spieler pflanzt und wartet die V1-Dauer ab (2h).
  client.start(0, R_WHEAT);
  client.advanceClock(wheatTicks(V1));
  assert.equal(client.collect(0).ok, true);

  // ── Während er offline war, shippen wir den Patch ──
  server.targetRulesetVersion = 2;

  const res = server.sync(client.buildSyncRequest(), T0 + wheatTicks(V1) * 1000);

  assert.equal(res.ok, true);
  if (!res.ok) return;
  // Kein Rollback, kein Divergenz-Alarm: unter V1 nachgerechnet war alles korrekt.
  assert.equal(res.kind, 'applied');
  assert.equal(res.divergence, false);
  assert.equal(count(res.snapshot.state, WHEAT), V1.recipes[R_WHEAT]!.output.amount);

  // Und erst JETZT ist der Spieler auf V2.
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

  client.adopt(first.snapshot);
  assert.equal(client.rulesetVersion, 2);

  // Unter V1 wäre nach 5400 Ticks nichts reif. Unter V2 schon.
  client.advanceClock(wheatTicks(V2));
  assert.equal(client.collect(0).ok, true);
  assert.ok(wheatTicks(V2) < wheatTicks(V1));
});

test('laufende Produktion überlebt den Patch fair — kein Verlust, kein Geschenk', () => {
  const halfGrown = {
    ...initialState(V1),
    tick: 3600,
    plots: [
      { recipe: R_WHEAT, startedAt: 0 }, // 3600 von 7200 → 3600 übrig
      { recipe: R_WHEAT, startedAt: 3600 }, // frisch → 7200 übrig
      { recipe: R_WHEAT, startedAt: -7200 }, // längst fertig
      { recipe: EMPTY_PLOT, startedAt: 0 },
      { recipe: EMPTY_PLOT, startedAt: 0 },
      { recipe: EMPTY_PLOT, startedAt: 0 },
    ],
  };

  const migrated = migrateState(halfGrown, 1, 2);
  const remaining = (i: number) =>
    Math.max(0, migrated.plots[i]!.startedAt + wheatTicks(V2) - migrated.tick);

  // Halb gewachsen: Restzeit bleibt exakt erhalten.
  assert.equal(remaining(0), 3600);

  // Frisch gepflanzt: startet neu mit der KÜRZEREN neuen Dauer. Der Spieler
  // profitiert vom Buff, statt auf der alten langen Zeit sitzen zu bleiben.
  assert.equal(remaining(1), wheatTicks(V2));
  assert.ok(remaining(1) < 7200);

  // Fertig bleibt fertig.
  assert.equal(remaining(2), 0);

  assertInvariants(migrated, V2);
});

test('kein Platz wird durch die Migration schlechter gestellt als ein Neuanfang', () => {
  // Die Leitregel als Eigenschaft über den ganzen Wertebereich geprüft.
  for (let elapsed = 0; elapsed <= wheatTicks(V1); elapsed += 60) {
    const tick = 100_000;
    const base = initialState(V1);
    const state = {
      ...base,
      tick,
      plots: base.plots.map((p, i) => (i === 0 ? { recipe: R_WHEAT, startedAt: tick - elapsed } : p)),
    };

    const before = Math.max(0, wheatTicks(V1) - elapsed);
    const m = migrateState(state, 1, 2);
    const after = Math.max(0, m.plots[0]!.startedAt + wheatTicks(V2) - m.tick);

    assert.ok(after <= wheatTicks(V2), `nie schlechter als frisch: ${after}`);
    assert.ok(after <= before, `nie länger als vorher: ${after} > ${before}`);
    assert.ok(after >= 0);
  }
});

test('Fortschritt passiver Plätze bleibt nach der Migration im gültigen Bereich', () => {
  // V2 legt öfter (480 statt 600), ein Fortschritt von 550 wäre danach ungültig.
  const state = { ...initialState(V1), tick: 5000, passives: [550] };
  const migrated = migrateState(state, 1, 2);

  assert.ok(migrated.passives[0]! < eggTicks(V2));
  assertInvariants(migrated, V2);
});

test('Inhalts-Patch v2 → v3: der Zustand wächst, nichts geht verloren', () => {
  // DER ehrlichere R2-Test: Hier ändert sich die Form des Zustands.
  const before = {
    ...initialState(V2),
    tick: 9000,
    items: [500, 40, 12], // Gold, Weizen, Eier
    plots: [
      { recipe: R_WHEAT, startedAt: 8000 },
      { recipe: EMPTY_PLOT, startedAt: 0 },
      { recipe: EMPTY_PLOT, startedAt: 0 },
      { recipe: EMPTY_PLOT, startedAt: 0 },
      { recipe: EMPTY_PLOT, startedAt: 0 },
      { recipe: EMPTY_PLOT, startedAt: 0 },
    ],
    passives: [123],
    orders: [{ id: 1, item: WHEAT, amount: 5, price: 4, listedAt: 8500 }],
    mail: [{ item: EGGS, amount: 3, arrivedAt: 8700 }],
    nextOrderId: 2,
  };

  const after = migrateState(before, 2, 3);
  assertInvariants(after, V3);

  // Bestehende Indizes behalten ihre Bedeutung — das ist die Append-only-Regel.
  assert.equal(count(after, 0), 500);
  assert.equal(count(after, WHEAT), 40);
  assert.equal(count(after, EGGS), 12);

  // Und was neu ist, startet leer.
  assert.equal(after.items.length, V3.items.length);
  assert.deepEqual(after.items.slice(3), [0, 0, 0], 'Milch, Mehl, Brot beginnen bei null');
  assert.equal(after.plots.length, V3.plots.length);
  assert.equal(after.plots[6]!.recipe, EMPTY_PLOT, 'die Mühle steht leer bereit');
  assert.equal(after.plots[7]!.recipe, EMPTY_PLOT, 'die Bäckerei steht leer bereit');
  assert.equal(after.passives.length, 2);
  assert.equal(after.passives[1], 0, 'die neue Weide fängt bei null an');

  // Laufende Produktion, Aufträge und Postfach überstehen den Umbau.
  assert.equal(after.plots[0]!.recipe, R_WHEAT);
  assert.equal(after.orders.length, 1);
  assert.equal(after.mail.length, 1);
  assert.equal(stored(after, V3), stored(before, V2), 'kein Stück Ware verschwunden');
});

test('Migration erhält Invarianten für zufällige echte Spielstände', () => {
  // Handgebaute Fälle treffen nie alles. Also: echte Sitzungen spielen und
  // jeden erreichten Zustand durch die Migration schicken — über beide
  // Patch-Sorten, den Zahlen-Patch und den Inhalts-Patch.
  for (const [from, to, rules] of [
    [1, 2, V2],
    [2, 3, V3],
    [3, 4, V4],
  ] as const) {
    for (let seed = 1; seed <= 60; seed++) {
      const rnd = mulberry32(seed);
      const server = new Server(initialState(getRuleset(from)), T0, from);
      const client = playRandomSession(server.snapshot, rnd, {
        steps: 25,
        maxAdvance: 8000,
        advanceChance: 0.45,
        chaosChance: 0.15,
      });

      const migrated = migrateState(client.state, from, to);
      assertInvariants(migrated, rules);

      // Migration ist eine reine Funktion: zweimal dasselbe Ergebnis.
      assert.deepEqual(
        migrateState(client.state, from, to),
        migrated,
        `v${from}→v${to} seed=${seed} nicht reproduzierbar`,
      );
      // Und sie fasst Bestände nicht an.
      for (let i = 0; i < client.state.items.length; i++) {
        assert.equal(migrated.items[i], client.state.items[i], `v${from}→v${to}: Bestand ${i}`);
      }
    }
  }
});

test('der Client darf sich seine Regelversion nicht aussuchen', () => {
  // Sonst bliebe man dauerhaft auf günstigen alten Preisen sitzen.
  const server = new Server(initialState(V1), T0, 1, 2);
  const client = new Client(server.snapshot);
  client.start(0, R_WHEAT);
  client.advanceClock(10);

  server.sync(client.buildSyncRequest(), T0 + 10_000);
  assert.equal(server.snapshot.rulesetVersion, 2);

  // Der Client behauptet jetzt, weiter unter V1 zu spielen.
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
  server.targetRulesetVersion = 99; // Patch mit fehlender Migration

  const client = new Client(server.snapshot);
  client.start(0, R_WHEAT);
  client.advanceClock(10);

  const res = server.sync(client.buildSyncRequest(), T0 + 10_000);

  // Der Log wird übernommen, die Migration nicht — der Spieler verliert nichts
  // und bleibt einfach auf seiner Version, bis der Fix da ist.
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.snapshot.rulesetVersion, 1);
  assert.equal(res.snapshot.state.plots[0]!.recipe, R_WHEAT);
  assert.equal(server.migrationFailures.length, 1);
});

test('Downgrades werden abgelehnt statt geraten', () => {
  assert.throws(() => migrateState(initialState(V2), 2, 1), MigrationError);
});

test('die Invariantenprüfung hat Zähne', () => {
  const overCap = { ...initialState(V2), items: [0, 0, V2.siloCapacity + 5] };
  assert.throws(() => assertInvariants(overCap, V2), MigrationError);

  const badProgress = { ...initialState(V2), passives: [eggTicks(V2)] };
  assert.throws(() => assertInvariants(badProgress, V2), MigrationError);

  const base = initialState(V2);
  const future = {
    ...base,
    tick: 10,
    plots: base.plots.map((p, i) => (i === 0 ? { recipe: R_WHEAT, startedAt: 500 } : p)),
  };
  assert.throws(() => assertInvariants(future, V2), MigrationError);

  // Die neue Bruchstelle: Zustand und Katalog passen nicht mehr zusammen.
  // Ein zu kurzes Inventar unter einem gewachsenen Katalog verschiebt still
  // die Bedeutung aller folgenden Indizes.
  assert.throws(() => assertInvariants(initialState(V2), V3), MigrationError);
  const wrongRecipe = {
    ...initialState(V3),
    plots: initialState(V3).plots.map((p, i) => (i === 0 ? { recipe: 4, startedAt: 0 } : p)),
  };
  assert.throws(() => assertInvariants(wrongRecipe, V3), MigrationError, 'Brot auf dem Acker');
});

test('Kettenmigration 1 → 4 läuft Schritt für Schritt und bleibt fair', () => {
  const tick = 100_000;

  // Ein Feld auf halbem Weg unter V1 (7200 Ticks Wachstum, 3600 übrig).
  const base = initialState(V1);
  const state = {
    ...base,
    tick,
    plots: base.plots.map((p, i) => (i === 0 ? { recipe: R_WHEAT, startedAt: tick - 3600 } : p)),
    passives: [550],
  };

  const migrated = migrateState(state, 1, 4);
  assertInvariants(migrated, V4);

  // V4 wächst in 60 Ticks. Die alte Restzeit von 3600 ist weit mehr — der
  // Spieler wird auf einen frischen Start gedeckelt, nicht darunter.
  const remaining = migrated.plots[0]!.startedAt + wheatTicks(V4) - migrated.tick;
  assert.equal(remaining, wheatTicks(V4));
  assert.ok(migrated.passives[0]! < eggTicks(V4));

  // Dasselbe Ergebnis wie drei einzelne Sprünge — die Kette darf nicht abkürzen.
  const stepwise = migrateState(migrateState(migrateState(state, 1, 2), 2, 3), 3, 4);
  assert.deepEqual(migrated, stepwise);
});

test('der Feldtest-Ruleset ist wirklich schnell genug zum Testen', () => {
  assert.ok(wheatTicks(V4) <= 120, 'Weizen muss in unter zwei Minuten reif sein');
  assert.ok(eggTicks(V4) <= 30, 'Eier müssen in Sekunden entstehen');
  // Und er muss den vollen Inhalt tragen, sonst testet man am Spiel vorbei.
  assert.equal(V4.plots.length, V3.plots.length);
  assert.equal(V4.items.length, V3.items.length);
});

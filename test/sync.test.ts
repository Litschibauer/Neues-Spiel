/**
 * Sync-Eigenschaften: Atomarität, Idempotenz, Fork-Erkennung
 * (Architektur §9, Risiken R3 und R8).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '../src/client/client.ts';
import { Server } from '../src/server/server.ts';
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
        { seq: 2, tick: 100, type: 'START', plot: 0, recipe: R_WHEAT }, // Feld schon belegt
        { seq: 3, tick: 200, type: 'START', plot: 1, recipe: R_WHEAT },
      ],
    },
    T0 + 200 * 1000,
  );

  // Das legale Präfix bleibt — sonst würde ein einziger Fehler ganz hinten im
  // Log einem ehrlichen Spieler eine ganze Offline-Sitzung kosten.
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.kind, 'partial');
  assert.equal(res.rejectedFrom, 2);
  assert.equal(res.reason, 'ILLEGAL_COMMAND:PLOT_BUSY');

  assert.equal(server.snapshot.seq, 1);
  assert.equal(server.snapshot.state.plots[0]!.recipe, R_WHEAT);
  // Alles ab dem Verstoß ist verworfen — auch das legale seq 3 dahinter,
  // denn es wurde auf einem Zustand gerechnet, den es nie gab.
  assert.equal(server.snapshot.state.plots[1]!.recipe, EMPTY_PLOT);
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
      commands: [{ seq: 2, tick: 100, type: 'START', plot: 0, recipe: R_WHEAT }], // belegt
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

  // Verbindung brach ab, Client schickt denselben Log noch einmal.
  const second = server.sync(req, T0 + 7300 * 1000);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.kind, 'duplicate');
  assert.deepEqual(server.snapshot.state, stateAfterFirst, 'darf nicht doppelt angewandt werden');
});

test('R3 — Multi-Device-Fork wird erkannt statt still übernommen', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);

  // Handy und Tablet starten beide vom selben Snapshot.
  const phone = new Client(server.snapshot);
  const tablet = new Client(server.snapshot);

  phone.start(0, R_WHEAT);
  phone.advanceClock(100);

  tablet.start(1, R_WHEAT);
  tablet.advanceClock(100);

  const r1 = server.sync(phone.buildSyncRequest(), T0 + 100 * 1000);
  assert.equal(r1.ok, true);

  // Das Tablet baut auf einem inzwischen veralteten Snapshot auf.
  const r2 = server.sync(tablet.buildSyncRequest(), T0 + 100 * 1000);
  assert.equal(r2.ok, false);
  if (r2.ok) return;
  assert.equal(r2.reason, 'FORK_DETECTED');

  // Das Tablet übernimmt den Server-Stand und verliert seine Offline-Arbeit —
  // genau der UX-Bruch, den ein Aktiv-Gerät-Token verhindern soll (R3).
  tablet.adopt(r2.snapshot);
  assert.equal(tablet.state.plots[0]!.recipe, R_WHEAT);
  assert.equal(tablet.state.plots[1]!.recipe, EMPTY_PLOT);
});

test('Regression: Fork und Replay teilen sich Sequenznummern — Inhalt entscheidet', () => {
  // Ursprünglicher Bug: Die Idempotenz-Prüfung hing allein an der `seq`. Ein
  // zweites Gerät, das vom selben Snapshot aus offline ging, benutzt zwangsläufig
  // dieselben Nummern — und wurde deshalb als „schon erledigt" durchgewinkt.
  // Seine Offline-Arbeit verschwand kommentarlos.
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);

  const original = {
    baseSeq: 0,
    rulesetVersion: CURRENT_RULESET_VERSION,
    commands: [{ seq: 1, tick: 0, type: 'START' as const, plot: 0, recipe: R_WHEAT }],
  };
  assert.equal(server.sync(original, T0 + 1000).ok, true);

  // Gleiche seq, gleicher baseSeq, ANDERE Aktion → das ist ein Fork, kein Replay.
  const forked = {
    baseSeq: 0,
    rulesetVersion: CURRENT_RULESET_VERSION,
    commands: [{ seq: 1, tick: 0, type: 'START' as const, plot: 2, recipe: R_WHEAT }],
  };
  const res = server.sync(forked, T0 + 2000);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'FORK_DETECTED');

  // Und der echte Replay bleibt weiterhin ein sauberes No-op.
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
        { seq: 3, tick: 10, type: 'START', plot: 1, recipe: R_WHEAT }, // seq 2 fehlt
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

  // Wir simulieren einen Client, der (etwa durch eine kaputte Optimierung)
  // einen anderen Zustand berechnet hat als der Server.
  const req = client.buildSyncRequest();
  req.clientHash = 'deadbeefdeadbeef';

  const res = server.sync(req, T0 + 7200 * 1000);

  // Wichtig: Der Log ist legal, also wird er angewandt. Der Hash-Mismatch ist
  // ein Bug-Alarm fürs Monitoring — keine Sanktion gegen den Spieler.
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.divergence, true);
  assert.equal(server.divergenceAlerts.length, 1);
  assert.equal(server.divergenceAlerts[0]!.clientHash, 'deadbeefdeadbeef');
});

test('R3 — das zweite Gerät wird abgewiesen, BEVOR es Arbeit verliert', () => {
  // Der Unterschied zu FORK_DETECTED: Diese Ablehnung kommt aus dem
  // Aktiv-Gerät-Verfahren, nicht aus der Kollision. Der Client kann daraus
  // eine Frage machen statt einer Fehlermeldung nach dem Verlust.
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);

  const phone = new Client(server.snapshot, 'handy');
  phone.start(0, R_WHEAT);
  phone.advanceClock(10);
  assert.equal(server.sync(phone.buildSyncRequest(), T0 + 10_000).ok, true);
  assert.equal(server.activeDevice?.id, 'handy');

  // Das Tablet fragt nach — und erfährt es, ohne etwas riskiert zu haben.
  assert.equal(server.isActiveDevice('tablet'), false);
  assert.equal(server.isActiveDevice('handy'), true);

  const tablet = new Client(server.snapshot, 'tablet');
  tablet.start(1, R_WHEAT);
  tablet.advanceClock(10);
  const res = server.sync(tablet.buildSyncRequest(), T0 + 20_000);

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'NOT_ACTIVE_DEVICE');
  // Der Stand des Handys ist unberührt.
  assert.equal(server.snapshot.seq, 1);
  assert.equal(server.snapshot.state.plots[1]!.recipe, EMPTY_PLOT);
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
  assert.equal(server.snapshot.state.plots[1]!.recipe, R_WHEAT);

  // Und jetzt ist das Handy dran mit Abgewiesenwerden — es erfährt es beim
  // nächsten Sync, statt es nie zu erfahren.
  const back = server.sync(
    { baseSeq: 2, rulesetVersion: CURRENT_RULESET_VERSION, commands: [], deviceId: 'handy' },
    T0 + 30_000,
  );
  assert.equal(back.ok, false);
  if (back.ok) return;
  assert.equal(back.reason, 'NOT_ACTIVE_DEVICE');
});

test('ohne Geräte-Kennung bleibt alles wie vorher', () => {
  // Skripte und Tests nehmen nicht teil — sonst wäre jede curl-Zeile ein
  // Geräte-Wechsel.
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

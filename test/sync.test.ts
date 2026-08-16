/**
 * Sync-Eigenschaften: Atomarität, Idempotenz, Fork-Erkennung
 * (Architektur §9, Risiken R3 und R8).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '../src/client/client.ts';
import { Server } from '../src/server/server.ts';
import { CURRENT_RULESET_VERSION } from '../src/sim/rules.ts';
import { initialState } from '../src/sim/state.ts';

const T0 = 1_700_000_000_000;

test('R8 — Sync ist atomar: ein illegales Command kippt den ganzen Batch', () => {
  const server = new Server(initialState(3), T0, CURRENT_RULESET_VERSION);

  const res = server.sync(
    {
      baseSeq: 0,
      rulesetVersion: CURRENT_RULESET_VERSION,
      commands: [
        { seq: 1, tick: 0, type: 'PLANT', field: 0 },
        { seq: 2, tick: 100, type: 'PLANT', field: 0 }, // Feld schon belegt
        { seq: 3, tick: 200, type: 'PLANT', field: 1 },
      ],
    },
    T0 + 200 * 1000,
  );

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'ILLEGAL_COMMAND:FIELD_OCCUPIED');
  // Auch das legale erste Command wurde NICHT angewandt.
  assert.equal(server.snapshot.seq, 0);
  assert.equal(server.snapshot.state.fields[0]!.crop, null);
});

test('R8 — ein wiederholter Sync ist ein No-op, kein Fehler', () => {
  const server = new Server(initialState(3), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  client.plant(0);
  client.advanceClock(7200);
  client.harvest(0);

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
  const server = new Server(initialState(3), T0, CURRENT_RULESET_VERSION);

  // Handy und Tablet starten beide vom selben Snapshot.
  const phone = new Client(server.snapshot);
  const tablet = new Client(server.snapshot);

  phone.plant(0);
  phone.advanceClock(100);

  tablet.plant(1);
  tablet.advanceClock(100);

  const r1 = server.sync(phone.buildSyncRequest(), T0 + 100 * 1000);
  assert.equal(r1.ok, true);

  // Das Tablet baut auf einem inzwischen veralteten Snapshot auf.
  const r2 = server.sync(tablet.buildSyncRequest(), T0 + 100 * 1000);
  assert.equal(r2.ok, false);
  if (r2.ok) return;
  assert.equal(r2.reason, 'BASE_SEQ_MISMATCH');

  // Das Tablet übernimmt den Server-Stand und verliert seine Offline-Arbeit —
  // genau der UX-Bruch, den ein Aktiv-Gerät-Token verhindern soll (R3).
  tablet.adopt(r2.snapshot);
  assert.equal(tablet.state.fields[0]!.crop, 'wheat');
  assert.equal(tablet.state.fields[1]!.crop, null);
});

test('Regression: Fork und Replay teilen sich Sequenznummern — Inhalt entscheidet', () => {
  // Ursprünglicher Bug: Die Idempotenz-Prüfung hing allein an der `seq`. Ein
  // zweites Gerät, das vom selben Snapshot aus offline ging, benutzt zwangsläufig
  // dieselben Nummern — und wurde deshalb als „schon erledigt" durchgewinkt.
  // Seine Offline-Arbeit verschwand kommentarlos.
  const server = new Server(initialState(3), T0, CURRENT_RULESET_VERSION);

  const original = {
    baseSeq: 0,
    rulesetVersion: CURRENT_RULESET_VERSION,
    commands: [{ seq: 1, tick: 0, type: 'PLANT' as const, field: 0 }],
  };
  assert.equal(server.sync(original, T0 + 1000).ok, true);

  // Gleiche seq, gleicher baseSeq, ANDERE Aktion → das ist ein Fork, kein Replay.
  const forked = {
    baseSeq: 0,
    rulesetVersion: CURRENT_RULESET_VERSION,
    commands: [{ seq: 1, tick: 0, type: 'PLANT' as const, field: 2 }],
  };
  const res = server.sync(forked, T0 + 2000);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'BASE_SEQ_MISMATCH');

  // Und der echte Replay bleibt weiterhin ein sauberes No-op.
  const replay = server.sync(original, T0 + 3000);
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  assert.equal(replay.kind, 'duplicate');
});

test('R2 — nicht mehr unterstützte Ruleset-Version erzwingt ein Update', () => {
  const server = new Server(initialState(3), T0, CURRENT_RULESET_VERSION);

  const res = server.sync(
    { baseSeq: 0, rulesetVersion: 99, commands: [{ seq: 1, tick: 0, type: 'PLANT', field: 0 }] },
    T0 + 1000,
  );

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'UNSUPPORTED_RULESET');
});

test('Lücken in der Sequenz werden abgelehnt', () => {
  const server = new Server(initialState(3), T0, CURRENT_RULESET_VERSION);

  const res = server.sync(
    {
      baseSeq: 0,
      rulesetVersion: CURRENT_RULESET_VERSION,
      commands: [
        { seq: 1, tick: 0, type: 'PLANT', field: 0 },
        { seq: 3, tick: 10, type: 'PLANT', field: 1 }, // seq 2 fehlt
      ],
    },
    T0 + 100 * 1000,
  );

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'SEQ_GAP');
});

test('R1 — der Kanarienvogel schlägt bei einem Determinismus-Bug an', () => {
  const server = new Server(initialState(3), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  client.plant(0);
  client.advanceClock(7200);
  client.harvest(0);

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

/**
 * Beweis auf Session-Ebene (Risiko R1, Architektur §3).
 *
 * Eine komplette Offline-Sitzung wird auf drei Wegen gerechnet:
 *   1. Client, optimistisch, segmentweise
 *   2. Server, Re-Simulation aus dem Command-Log
 *   3. Referenz, stur Tick für Tick
 *
 * Alle drei müssen bit-für-bit denselben Zustand liefern. Weg 3 ist der
 * eigentliche Wert: Er prüft die Segment-Optimierung gegen die Grundwahrheit
 * über eine ganze Sitzung hinweg, nicht nur pro Aufruf.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '../src/client/client.ts';
import { Server } from '../src/server/server.ts';
import { getRuleset, CURRENT_RULESET_VERSION } from '../src/sim/rules.ts';
import { initialState, cloneState, stored } from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';
import { advanceCoopReference } from '../src/sim/produce.ts';
import { hashState } from '../src/sim/hash.ts';
import type { State } from '../src/sim/state.ts';
import type { Command } from '../src/sim/commands.ts';

const T0 = 1_700_000_000_000;

/** Unabhängiger Weg: Zeit stur Tick für Tick, Command-Wirkung via Sim-Kern. */
function referenceRun(start: State, cmds: readonly Command[]): State {
  const rules = getRuleset(CURRENT_RULESET_VERSION);
  let s = cloneState(start);

  for (const cmd of cmds) {
    while (s.tick < cmd.tick) {
      const space = rules.siloCapacity - stored(s);
      const r = advanceCoopReference(1, s.coopProgress, space, rules.coopTicksPerEgg);
      s.eggs += r.eggs;
      s.coopProgress = r.coopProgress;
      s.tick++;
    }
    // s.tick === cmd.tick, advanceTo ist hier ein No-op → nur die Wirkung zählt.
    s = simulate(s, cmd, rules);
  }
  return s;
}

test('Client, Server und Tick-für-Tick-Referenz stimmen exakt überein', () => {
  const server = new Server(initialState(6), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);
  const start = cloneState(server.snapshot.state);

  // ── Eine realistische Offline-Sitzung ──────────────────────────────
  assert.equal(client.plant(0).ok, true);
  assert.equal(client.plant(1).ok, true);
  assert.equal(client.plant(2).ok, true);

  client.advanceClock(7200); // 2h → Weizen reif, 12 Eier
  assert.equal(client.harvest(0).ok, true);
  assert.equal(client.harvest(1).ok, true);
  assert.equal(client.harvest(2).ok, true);
  assert.equal(client.plant(0).ok, true);
  assert.equal(client.plant(1).ok, true);

  client.advanceClock(3600);
  assert.equal(client.sellNpc('wheat', 20).ok, true);

  client.advanceClock(3600); // Felder 0,1 wieder reif
  assert.equal(client.harvest(0).ok, true);
  assert.equal(client.harvest(1).ok, true);

  client.advanceClock(1800);
  assert.equal(client.sellNpc('eggs', 15).ok, true);

  const offlineTicks = client.localTick;
  assert.ok(client.queue.length >= 10);

  // ── Weg 3: Referenz ────────────────────────────────────────────────
  const reference = referenceRun(start, client.queue);
  assert.deepEqual(client.state, reference, 'Client weicht von der Grundwahrheit ab');

  // ── Weg 2: Server-Re-Simulation ────────────────────────────────────
  const nowMs = T0 + offlineTicks * 1000;
  const res = server.sync(client.buildSyncRequest(), nowMs);

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.kind, 'applied');
  assert.equal(res.divergence, false, 'Kanarienvogel meldet Determinismus-Bug');
  assert.deepEqual(server.divergenceAlerts, []);

  // Der Vergleichspunkt ist der Zustand nach dem letzten Command.
  assert.equal(hashState(client.state), hashState(reference));

  // Der ehrliche Spieler verliert nichts: alle Commands sind übernommen.
  assert.equal(res.snapshot.seq, client.queue.length);
  assert.equal(res.snapshot.state.gold, client.state.gold);
  assert.equal(res.snapshot.state.wheat, client.state.wheat);
});

test('Sync ist für den ehrlichen Spieler unsichtbar — nichts geht verloren', () => {
  const server = new Server(initialState(3), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  client.plant(0);
  client.advanceClock(7200);
  client.harvest(0);

  const beforeGold = client.state.gold;
  const beforeWheat = client.state.wheat;

  const res = server.sync(client.buildSyncRequest(), T0 + 7200 * 1000);
  assert.equal(res.ok, true);
  if (!res.ok) return;

  client.adopt(res.snapshot);

  assert.equal(client.state.wheat, beforeWheat);
  assert.equal(client.state.gold, beforeGold);
  assert.equal(client.queue.length, 0);
});

test('geteilte Arrays: ein neuer Zustand verändert den alten nie', () => {
  // `cloneState` teilt die Arrays aus Kostengründen. Das ist nur zulässig,
  // solange niemand sie an Ort und Stelle verändert — sonst wäre `simulate`
  // keine reine Funktion mehr, und ein Re-Sim liefe anders als der erste Lauf.
  const rules = getRuleset(CURRENT_RULESET_VERSION);
  const start = initialState(4);

  const history: State[] = [start];
  const snapshots: string[] = [hashState(start)];

  const cmds: Command[] = [
    { seq: 1, tick: 0, type: 'PLANT', field: 0 },
    { seq: 2, tick: 1, type: 'PLANT', field: 1 },
    { seq: 3, tick: 7200, type: 'HARVEST', field: 0 },
    { seq: 4, tick: 7201, type: 'LIST_ORDER', item: 'wheat', amount: 5, price: 3 },
    { seq: 5, tick: 7202, type: 'HARVEST', field: 1 },
    { seq: 6, tick: 7203, type: 'SELL_NPC', item: 'wheat', amount: 5 },
  ];

  let s = start;
  for (const cmd of cmds) {
    s = simulate(s, cmd, rules);
    history.push(s);
    snapshots.push(hashState(s));
  }

  // Jeder frühere Zustand muss noch exakt so aussehen wie damals.
  history.forEach((state, i) => {
    assert.equal(hashState(state), snapshots[i], `Zustand ${i} wurde nachträglich verändert`);
  });

  // Und die Arrays dürfen sich nicht gegenseitig überschrieben haben.
  assert.equal(history[0]!.fields[0]!.crop, null, 'Startzustand hat ein Feld bekommen');
  assert.equal(history[1]!.fields[1]!.crop, null, 'Zustand 1 hat Feld 2 zu früh');
  assert.equal(history[0]!.orders.length, 0);
  assert.equal(history[3]!.orders.length, 0, 'Auftrag rückwirkend eingefügt');
});

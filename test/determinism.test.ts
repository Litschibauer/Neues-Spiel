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
import { EMPTY_PLOT, initialState, cloneState, count } from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';
import { hashState } from '../src/sim/hash.ts';
import { referenceRun } from './helpers/session.ts';
import type { State } from '../src/sim/state.ts';
import type { Command } from '../src/sim/commands.ts';

const T0 = 1_700_000_000_000;
const rules = getRuleset(CURRENT_RULESET_VERSION);

const WHEAT = 1;
const EGGS = 2;
const GOLD = 0;
const R_WHEAT = 0;

test('Client, Server und Tick-für-Tick-Referenz stimmen exakt überein', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);
  const start = cloneState(server.snapshot.state);

  // ── Eine realistische Offline-Sitzung ──────────────────────────────
  assert.equal(client.start(0, R_WHEAT).ok, true);
  assert.equal(client.start(1, R_WHEAT).ok, true);
  assert.equal(client.start(2, R_WHEAT).ok, true);

  client.advanceClock(7200); // 2h → Weizen reif, 12 Eier
  assert.equal(client.collect(0).ok, true);
  assert.equal(client.collect(1).ok, true);
  assert.equal(client.collect(2).ok, true);
  assert.equal(client.start(0, R_WHEAT).ok, true);
  assert.equal(client.start(1, R_WHEAT).ok, true);

  client.advanceClock(3600);
  assert.equal(client.sellNpc(WHEAT, 20).ok, true);

  client.advanceClock(3600); // Plätze 0,1 wieder fertig
  assert.equal(client.collect(0).ok, true);
  assert.equal(client.collect(1).ok, true);

  client.advanceClock(1800);
  assert.equal(client.sellNpc(EGGS, 15).ok, true);

  const offlineTicks = client.localTick;
  assert.ok(client.queue.length >= 10);

  // ── Weg 3: Referenz ────────────────────────────────────────────────
  const reference = referenceRun(start, client.queue, rules);
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
  assert.deepEqual(res.snapshot.state.items, client.state.items);
});

test('Produktionskette über drei Stufen: Weizen → Mehl → Brot', () => {
  // Der eigentliche Beweis für „Inhalt ist Daten": Mühle und Bäckerei
  // brauchten keine Zeile Sim-Code. Sie sind Plätze mit Rezepten, und die
  // Kette entsteht daraus, dass die Ausgabe des einen die Eingabe des
  // anderen ist.
  const v3 = getRuleset(3);
  const MILL = 6;
  const BAKERY = 7;
  const R_FLOUR = 3;
  const R_BREAD = 4;
  const FLOUR = 4;
  const BREAD = 5;

  const server = new Server(initialState(v3), T0, 3);
  const client = new Client(server.snapshot);
  const start = cloneState(server.snapshot.state);

  // Zwei Felder Weizen ernten → 20 Weizen.
  assert.equal(client.start(0, 0).ok, true);
  assert.equal(client.start(1, 0).ok, true);
  client.advanceClock(v3.recipes[0]!.durationTicks);
  assert.equal(client.collect(0).ok, true);
  assert.equal(client.collect(1).ok, true);

  // Zweimal mahlen → 2 Mehl.
  for (let i = 0; i < 2; i++) {
    assert.equal(client.start(MILL, R_FLOUR).ok, true);
    client.advanceClock(v3.recipes[R_FLOUR]!.durationTicks);
    assert.equal(client.collect(MILL).ok, true);
  }
  assert.equal(count(client.state, FLOUR), 2);

  // Backen braucht 2 Mehl und 1 Ei — beides ist da.
  assert.equal(client.start(BAKERY, R_BREAD).ok, true);
  assert.equal(count(client.state, FLOUR), 0, 'das Mehl ist sofort weg (Escrow-Logik)');
  client.advanceClock(v3.recipes[R_BREAD]!.durationTicks);
  assert.equal(client.collect(BAKERY).ok, true);
  assert.equal(count(client.state, BREAD), 1);

  // Und der teuerste Test: Alle drei Wege müssen übereinstimmen.
  assert.deepEqual(client.state, referenceRun(start, client.queue, v3));
  const res = server.sync(client.buildSyncRequest(), T0 + client.localTick * 1000);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.divergence, false);
});

test('ein Rezept auf dem falschen Platz wird abgelehnt', () => {
  const v3 = getRuleset(3);
  const client = new Client({ state: initialState(v3), seq: 0, serverTs: T0, rulesetVersion: 3 });

  // Brot auf dem Acker gibt es nicht — und die Ablehnung passiert offline,
  // ohne dass irgendetwas im Log landet.
  const res = client.start(0, 4);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'RECIPE_NOT_ALLOWED');
  assert.equal(client.queue.length, 0);
});

test('Sync ist für den ehrlichen Spieler unsichtbar — nichts geht verloren', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  client.start(0, R_WHEAT);
  client.advanceClock(7200);
  client.collect(0);

  const before = client.state.items.slice();

  const res = server.sync(client.buildSyncRequest(), T0 + 7200 * 1000);
  assert.equal(res.ok, true);
  if (!res.ok) return;

  client.adopt(res.snapshot);

  assert.deepEqual(client.state.items, before);
  assert.equal(count(client.state, GOLD), 0);
  assert.equal(client.queue.length, 0);
});

test('geteilte Arrays: ein neuer Zustand verändert den alten nie', () => {
  // `cloneState` teilt die Arrays aus Kostengründen. Das ist nur zulässig,
  // solange niemand sie an Ort und Stelle verändert — sonst wäre `simulate`
  // keine reine Funktion mehr, und ein Re-Sim liefe anders als der erste Lauf.
  const start = initialState(rules);

  const history: State[] = [start];
  const snapshots: string[] = [hashState(start)];

  const cmds: Command[] = [
    { seq: 1, tick: 0, type: 'START', plot: 0, recipe: R_WHEAT },
    { seq: 2, tick: 1, type: 'START', plot: 1, recipe: R_WHEAT },
    { seq: 3, tick: 7200, type: 'COLLECT', plot: 0 },
    { seq: 4, tick: 7201, type: 'LIST_ORDER', item: WHEAT, amount: 5, price: 3 },
    { seq: 5, tick: 7202, type: 'COLLECT', plot: 1 },
    { seq: 6, tick: 7203, type: 'SELL_NPC', item: WHEAT, amount: 5 },
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
  assert.equal(history[0]!.plots[0]!.recipe, EMPTY_PLOT, 'Startzustand hat einen Platz bekommen');
  assert.equal(history[1]!.plots[1]!.recipe, EMPTY_PLOT, 'Zustand 1 hat Platz 2 zu früh');
  assert.equal(history[0]!.items[WHEAT], 0, 'Inventar rückwirkend verändert');
  assert.equal(history[0]!.orders.length, 0);
  assert.equal(history[3]!.orders.length, 0, 'Auftrag rückwirkend eingefügt');
});

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
import { Client, DISCARD_QUEUE } from '../src/client/client.ts';
import { Server } from '../src/server/server.ts';
import { getRuleset, CURRENT_RULESET_VERSION } from '../src/sim/rules.ts';
import { EMPTY_PLOT, initialState, cloneState, count } from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';
import { hashState } from '../src/sim/hash.ts';
import { fuzzStart, referenceRun } from './helpers/session.ts';
import type { State } from '../src/sim/state.ts';
import type { Command } from '../src/sim/commands.ts';

const T0 = 1_700_000_000_000;
const rules = getRuleset(CURRENT_RULESET_VERSION);

const GOLD = 0;
const WHEAT = 1;
const FEED = 2;
const EGGS = 3;
const R_WHEAT = 0;
const R_FEED = 1;
const R_EGGS = 2;
const MILL = 6;
const COOP = 7;

const GROW = rules.recipes[R_WHEAT]!.durationTicks;
const SEED_COST = rules.recipes[R_WHEAT]!.inputs.find((i) => i.item === WHEAT)?.amount ?? 0;
const YIELD = rules.recipes[R_WHEAT]!.output.amount;
const START_WHEAT = rules.startingItems.find((x) => x.item === WHEAT)?.amount ?? 0;
const GRIND = rules.recipes[R_FEED]!.inputs.find((i) => i.item === WHEAT)?.amount ?? 0;
/** Weizen nach `n` Ernten auf einem frischen Hof: Vorrat − Saat + Ertrag. */
const afterHarvests = (n: number) => START_WHEAT + n * (YIELD - SEED_COST);

/**
 * Hof mit Kapital UND Erfahrung.
 *
 * Beides wird gebraucht, seit Plätze hinter Leveln liegen (M8): Gold allein
 * kauft keine Mühle mehr. Tests, die das Kaufen prüfen, sollen nicht erst
 * zwanzig Minuten Weizen anbauen — dafür gibt es den Kernkreislauf-Test.
 */
function established(gold: number) {
  return { ...fuzzStart(rules, gold), xp: 5000 };
}

test('DER KERNKREISLAUF: Feld → Mühle → Gehege → Eier, über drei Rechenwege', () => {
  // Genau die Schrittfolge, um die es im Spiel geht. Startkapital, damit der
  // Test die Kaufschritte prüft und nicht das Weizen-Grinden davor.
  const server = new Server(established(1000), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);
  const start = cloneState(server.snapshot.state);

  // 1. Feld bestellen, warten, Weizen ernten.
  assert.equal(client.start(0, R_WHEAT).ok, true);
  assert.equal(client.start(1, R_WHEAT).ok, true);
  client.advanceClock(GROW);
  assert.equal(client.collect(0).ok, true);
  assert.equal(client.collect(1).ok, true);
  assert.equal(count(client.state, WHEAT), afterHarvests(2));

  // 2. Mühle kaufen und Hühnerfutter mahlen.
  assert.equal(client.buy(MILL).ok, true);
  assert.equal(client.start(MILL, R_FEED).ok, true);
  assert.equal(count(client.state, WHEAT), afterHarvests(2) - GRIND, 'drei Weizen sind sofort weg');
  client.advanceClock(rules.recipes[R_FEED]!.durationTicks);
  assert.equal(client.collect(MILL).ok, true);
  assert.equal(count(client.state, FEED), 2);

  // 3. Gehege kaufen — leer legt es noch keine Eier.
  assert.equal(client.buy(COOP).ok, true);
  const empty = client.start(COOP, R_EGGS);
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.code, 'RECIPE_NOT_ALLOWED', 'Gehege ohne Hühner');

  // 4. Hühner kaufen, füttern, warten, Eier sammeln.
  assert.equal(client.buy(COOP).ok, true);
  assert.equal(client.start(COOP, R_EGGS).ok, true);
  assert.equal(count(client.state, FEED), 1, 'ein Futter ist verfüttert');
  client.advanceClock(rules.recipes[R_EGGS]!.durationTicks);
  assert.equal(client.collect(COOP).ok, true);
  assert.equal(count(client.state, EGGS), 3);

  // 5. Eier verkaufen — der Kreislauf schließt sich.
  assert.equal(client.sellNpc(EGGS, 3).ok, true);
  assert.ok(count(client.state, GOLD) > 0);

  // Und Erfahrung ist unterwegs angefallen, ohne dass ein Command dafür nötig war.
  assert.ok(client.state.xp > start.xp, 'keine Erfahrung gesammelt');

  // ── Weg 3: Referenz ────────────────────────────────────────────────
  const reference = referenceRun(start, client.queue, rules);
  assert.deepEqual(client.state, reference, 'Client weicht von der Grundwahrheit ab');

  // ── Weg 2: Server-Re-Simulation ────────────────────────────────────
  const res = server.sync(client.buildSyncRequest(), T0 + client.localTick * 1000);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.kind, 'applied');
  assert.equal(res.divergence, false, 'Kanarienvogel meldet Determinismus-Bug');
  assert.deepEqual(server.divergenceAlerts, []);
  assert.equal(hashState(client.state), hashState(reference));
  assert.deepEqual(res.snapshot.state.items, client.state.items);
});

test('ohne Level gibt es kein Gehege — auch nicht mit vollen Taschen', () => {
  // Die ganze Wirkung von M8: eine Schwelle, hinter der etwas auftaucht.
  const rich = new Client({
    state: fuzzStart(rules, 100_000),
    seq: 0,
    serverTs: T0,
    rulesetVersion: 1,
  });

  const tooEarly = rich.buy(COOP);
  assert.equal(tooEarly.ok, false);
  if (!tooEarly.ok) assert.equal(tooEarly.code, 'PLAYER_LEVEL_TOO_LOW');

  // Mit Erfahrung geht derselbe Kauf durch — Geld war nie das Problem.
  const seasoned = new Client({
    state: established(100_000),
    seq: 0,
    serverTs: T0,
    rulesetVersion: 1,
  });
  assert.equal(seasoned.buy(COOP).ok, true);
});

test('ohne Geld gibt es kein Gehege — und ohne Gehege keine Eier', () => {
  const client = new Client({
    state: { ...initialState(rules), xp: 5000 },
    seq: 0,
    serverTs: T0,
    rulesetVersion: 1,
  });

  const broke = client.buy(COOP);
  assert.equal(broke.ok, false);
  if (!broke.ok) assert.equal(broke.code, 'CANT_AFFORD');

  const locked = client.start(COOP, R_EGGS);
  assert.equal(locked.ok, false);
  if (!locked.ok) assert.equal(locked.code, 'PLOT_LOCKED');

  // Beides offline abgelehnt — nichts davon landet im Log.
  assert.equal(client.queue.length, 0);
});

test('ein Rezept auf dem falschen Platz wird abgelehnt', () => {
  const client = new Client({
    state: established(1000),
    seq: 0,
    serverTs: T0,
    rulesetVersion: 1,
  });

  // Eier auf dem Acker gibt es nicht — und die Ablehnung passiert offline.
  const res = client.start(0, R_EGGS);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'RECIPE_NOT_ALLOWED');
  assert.equal(client.queue.length, 0);
});

test('ein voll ausgebauter Platz lässt sich nicht weiter kaufen', () => {
  const client = new Client({
    state: established(100_000),
    seq: 0,
    serverTs: T0,
    rulesetVersion: 1,
  });

  assert.equal(client.buy(COOP).ok, true);
  assert.equal(client.buy(COOP).ok, true);
  const tooMuch = client.buy(COOP);
  assert.equal(tooMuch.ok, false);
  if (!tooMuch.ok) assert.equal(tooMuch.code, 'MAX_LEVEL');
});

test('ausbauen geht nur bei leerem Platz', () => {
  const client = new Client({
    state: established(100_000),
    seq: 0,
    serverTs: T0,
    rulesetVersion: 1,
  });

  assert.equal(client.buy(COOP).ok, true); // Gehege
  assert.equal(client.buy(COOP).ok, true); // Hühner
  assert.equal(client.buy(MILL).ok, true);
  // Das Startsaatgut muss weg, sonst hätte die Mühle etwas zu mahlen.
  assert.equal(client.sellNpc(WHEAT, START_WHEAT).ok, true);
  assert.equal(client.start(MILL, R_FEED).ok, false, 'ohne Weizen kein Futter');

  // Ein laufendes Feld blockiert seinen eigenen Ausbau, bis abgeholt wurde.
  assert.equal(client.buy(3).ok, true);
  assert.equal(client.buyNpc(WHEAT, SEED_COST).ok, true, 'Saatgut nachkaufen');
  assert.equal(client.start(3, R_WHEAT).ok, true);
  const busy = client.buy(3);
  assert.equal(busy.ok, false);
  if (!busy.ok) assert.equal(busy.code, 'PLOT_BUSY');
});

test('Sync ist für den ehrlichen Spieler unsichtbar — nichts geht verloren', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  client.start(0, R_WHEAT);
  client.advanceClock(GROW);
  client.collect(0);

  const before = client.state.items.slice();

  const res = server.sync(client.buildSyncRequest(), T0 + GROW * 1000);
  assert.equal(res.ok, true);
  if (!res.ok) return;

  client.adopt(res.snapshot, DISCARD_QUEUE);

  assert.deepEqual(client.state.items, before);
  assert.equal(client.queue.length, 0);
});

test('geteilte Arrays: ein neuer Zustand verändert den alten nie', () => {
  // `cloneState` teilt die Arrays aus Kostengründen. Das ist nur zulässig,
  // solange niemand sie an Ort und Stelle verändert — sonst wäre `simulate`
  // keine reine Funktion mehr, und ein Re-Sim liefe anders als der erste Lauf.
  const start = established(1000);

  const history: State[] = [start];
  const snapshots: string[] = [hashState(start)];

  const cmds: Command[] = [
    { seq: 1, tick: 0, type: 'START', plot: 0, recipe: R_WHEAT },
    { seq: 2, tick: 1, type: 'START', plot: 1, recipe: R_WHEAT },
    { seq: 3, tick: 2, type: 'BUY', plot: MILL },
    { seq: 4, tick: GROW, type: 'COLLECT', plot: 0 },
    { seq: 5, tick: GROW, type: 'LIST_ORDER', item: WHEAT, amount: 5, price: 3 },
    { seq: 6, tick: GROW + 1, type: 'COLLECT', plot: 1 },
    { seq: 7, tick: GROW + 2, type: 'SELL_NPC', item: WHEAT, amount: 5 },
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
  assert.equal(history[0]!.plots[MILL]!.level, 0, 'Mühle rückwirkend gekauft');
  assert.equal(history[0]!.items[WHEAT], START_WHEAT, 'Inventar rückwirkend verändert');
  assert.equal(history[3]!.orders.length, 0, 'Auftrag rückwirkend eingefügt');
});

/**
 * Lagerlimits (Architektur §7).
 *
 * Kernaussage: Das Limit ist eine Regel INNERHALB der Sim, kein nachträglicher
 * Server-Check. Deshalb lässt der Client den Verstoß offline gar nicht erst zu —
 * es gibt nichts, was beim Sync auffallen könnte.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '../src/client/client.ts';
import { Server } from '../src/server/server.ts';
import { getRuleset, CURRENT_RULESET_VERSION } from '../src/sim/rules.ts';
import { initialState, count, stored } from '../src/sim/state.ts';
import { advanceTo } from '../src/sim/sim.ts';

const T0 = 1_700_000_000_000;
const rules = getRuleset(CURRENT_RULESET_VERSION);

// Katalogindizes unter v1 — hier bewusst ausgeschrieben statt aus dem Regelwerk
// gezogen: Ein Test, der seine Erwartung aus derselben Quelle holt wie der Code,
// prüft am Ende nur noch sich selbst.
const WHEAT = 1;
const EGGS = 2;
const R_WHEAT = 0;

test('Lagerlimit kann offline gar nicht überschritten werden', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  client.start(0, R_WHEAT);
  client.advanceClock(60_000); // Stall füllt das Lager exakt auf 100 Eier

  const before = client.queue.length;
  const res = client.collect(0);

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'SILO_FULL');
  // Entscheidend: Das Command landet nicht mal im Log.
  assert.equal(client.queue.length, before);
});

test('Hard block statt stillem Verlust: der fertige Platz bleibt stehen', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  client.start(0, R_WHEAT);
  client.advanceClock(60_000);
  client.collect(0); // blockiert

  // Platz schaffen → dieselbe Ernte geht jetzt durch, nichts ist verloren.
  assert.equal(client.sellNpc(EGGS, 20).ok, true);
  assert.equal(client.collect(0).ok, true);
  assert.equal(count(client.state, WHEAT), 10);
  assert.equal(count(client.state, EGGS), 80);
  assert.equal(stored(client.state, rules), 90);

  const sync = server.sync(client.buildSyncRequest(), T0 + 60_000 * 1000);
  assert.equal(sync.ok, true);
  if (!sync.ok) return;
  assert.equal(sync.divergence, false);
});

test('der Stall stallt bei vollem Lager — und bunkert keine Zeit', () => {
  let s = initialState(rules);
  s = advanceTo(s, 60_000, rules); // 100 Eier, Lager voll
  assert.equal(count(s, EGGS), 100);
  assert.equal(stored(s, rules), rules.siloCapacity);

  // Weitere 10h bei vollem Lager: nichts entsteht, nichts wird angespart.
  const later = advanceTo(s, 60_000 + 36_000, rules);
  assert.equal(count(later, EGGS), 100);
  assert.equal(later.passives[0], 0);

  // Nach dem Freiräumen gibt es KEINEN Schwall aus gebunkerter Zeit.
  const freed = { ...later, items: [0, 0, 50] };
  const resumed = advanceTo(freed, later.tick + 600, rules);
  assert.equal(count(resumed, EGGS), 51, 'genau ein Ei nach genau einem Intervall');
});

test('Server lehnt einen handgebauten Log ab, der das Limit verletzt', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);

  // Ein manipulierter Client, der die lokale Prüfung einfach überspringt.
  const res = server.sync(
    {
      baseSeq: 0,
      rulesetVersion: CURRENT_RULESET_VERSION,
      commands: [
        { seq: 1, tick: 0, type: 'START', plot: 0, recipe: R_WHEAT },
        { seq: 2, tick: 60_000, type: 'COLLECT', plot: 0 }, // Lager ist da voll
      ],
    },
    T0 + 60_000 * 1000,
  );

  // Präfix-Commit: Das legale Pflanzen bleibt, die illegale Ernte nicht.
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.kind, 'partial');
  assert.equal(res.rejectedFrom, 2);
  assert.equal(res.reason, 'ILLEGAL_COMMAND:SILO_FULL');
  assert.equal(res.snapshot.seq, 1);
  assert.equal(count(res.snapshot.state, WHEAT), 0, 'die Ernte hat nicht stattgefunden');
});

test('Eingaben verbrauchen macht Platz — die Kette entlastet das Lager', () => {
  // v3 hat Mühle und Bäckerei. Drei Weizen werden zu einem Mehl: Der
  // Produktionsplatz ist damit auch ein Ventil gegen ein volles Lager.
  const v3 = getRuleset(3);
  const MILL = 6;
  const R_FLOUR = 3;
  const FLOUR = 4;

  const s = { ...initialState(v3), items: [0, 30, 0, 0, 0, 0] };
  assert.equal(stored(s, v3), 30);

  // Über den Sim-Kern, nicht von Hand: START verbraucht die Eingaben sofort.
  const client = new Client({ state: s, seq: 0, serverTs: T0, rulesetVersion: 3 });
  assert.equal(client.start(MILL, R_FLOUR).ok, true);
  assert.equal(stored(client.state, v3), 27, 'drei Weizen sind aus dem Lager weg');

  client.advanceClock(v3.recipes[R_FLOUR]!.durationTicks);
  assert.equal(client.collect(MILL).ok, true);
  assert.equal(count(client.state, FLOUR), 1);
});

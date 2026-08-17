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
import type { Ruleset } from '../src/sim/rules.ts';
import { initialState, count, stored } from '../src/sim/state.ts';
import { advanceTo } from '../src/sim/sim.ts';

const T0 = 1_700_000_000_000;
const rules = getRuleset(CURRENT_RULESET_VERSION);

// Katalogindizes unter v1 — hier bewusst ausgeschrieben statt aus dem Regelwerk
// gezogen: Ein Test, der seine Erwartung aus derselben Quelle holt wie der Code,
// prüft am Ende nur noch sich selbst.
const WHEAT = 1;
const FEED = 2;
const R_WHEAT = 0;
const R_FEED = 1;
const MILL = 6;
const GROW = rules.recipes[R_WHEAT]!.durationTicks;
const YIELD = rules.recipes[R_WHEAT]!.output.amount;

/** Spielstand mit fast vollem Lager. */
function nearlyFull(freeSpace: number) {
  const base = initialState(rules);
  const items = base.items.slice();
  items[WHEAT] = rules.siloCapacity - freeSpace;
  return { ...base, items };
}

test('Lagerlimit kann offline gar nicht überschritten werden', () => {
  // Nur noch Platz für 5, die Ernte bringt 10.
  const server = new Server(nearlyFull(5), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  client.start(0, R_WHEAT);
  client.advanceClock(GROW);

  const before = client.queue.length;
  const res = client.collect(0);

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'SILO_FULL');
  // Entscheidend: Das Command landet nicht mal im Log.
  assert.equal(client.queue.length, before);
});

test('Hard block statt stillem Verlust: der fertige Platz bleibt stehen', () => {
  const server = new Server(nearlyFull(5), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  client.start(0, R_WHEAT);
  client.advanceClock(GROW);
  client.collect(0); // blockiert

  // Platz schaffen → dieselbe Ernte geht jetzt durch, nichts ist verloren.
  assert.equal(client.sellNpc(WHEAT, 20).ok, true);
  assert.equal(client.collect(0).ok, true);
  assert.equal(count(client.state, WHEAT), rules.siloCapacity - 5 - 20 + YIELD);

  const sync = server.sync(client.buildSyncRequest(), T0 + GROW * 1000);
  assert.equal(sync.ok, true);
  if (!sync.ok) return;
  assert.equal(sync.divergence, false);
});

test('Server lehnt einen handgebauten Log ab, der das Limit verletzt', () => {
  const server = new Server(nearlyFull(5), T0, CURRENT_RULESET_VERSION);

  // Ein manipulierter Client, der die lokale Prüfung einfach überspringt.
  const res = server.sync(
    {
      baseSeq: 0,
      rulesetVersion: CURRENT_RULESET_VERSION,
      commands: [
        { seq: 1, tick: 0, type: 'START', plot: 0, recipe: R_WHEAT },
        { seq: 2, tick: GROW, type: 'COLLECT', plot: 0 },
      ],
    },
    T0 + GROW * 1000,
  );

  // Präfix-Commit: Das legale Pflanzen bleibt, die illegale Ernte nicht.
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.kind, 'partial');
  assert.equal(res.rejectedFrom, 2);
  assert.equal(res.reason, 'ILLEGAL_COMMAND:SILO_FULL');
  assert.equal(res.snapshot.seq, 1);
  assert.equal(count(res.snapshot.state, WHEAT), rules.siloCapacity - 5);
});

test('Eingaben verbrauchen macht Platz — die Mühle entlastet das Lager', () => {
  // Drei Weizen werden zu zwei Futter: Der Produktionsplatz ist damit auch ein
  // Ventil gegen ein volles Lager.
  const base = nearlyFull(0);
  const withMill = {
    ...base,
    plots: base.plots.map((p, i) => (i === MILL ? { ...p, level: 1 } : p)),
  };
  const client = new Client({ state: withMill, seq: 0, serverTs: T0, rulesetVersion: 1 });

  assert.equal(stored(client.state, rules), rules.siloCapacity, 'Lager ist randvoll');
  assert.equal(client.start(MILL, R_FEED).ok, true);
  assert.equal(stored(client.state, rules), rules.siloCapacity - 3, 'drei Weizen sind weg');

  client.advanceClock(rules.recipes[R_FEED]!.durationTicks);
  assert.equal(client.collect(MILL).ok, true);
  assert.equal(count(client.state, FEED), 2);
});

test('ein passiver Produzent stallt bei vollem Lager — und bunkert keine Zeit', () => {
  // Der Basis-Kreislauf hat keinen passiven Platz. Die Mechanik steht trotzdem
  // im Kern (siehe rules.ts) und muss geprüft bleiben — hier über ein
  // synthetisches Regelwerk, damit die Integration nicht ungetestet verrottet.
  const withCoop: Ruleset = {
    ...rules,
    recipes: [
      ...rules.recipes,
      { id: 'trickle', inputs: [], output: { item: WHEAT, amount: 1 }, durationTicks: 600 },
    ],
    passives: [{ id: 'well', recipe: rules.recipes.length }],
  };

  let s = { ...initialState(withCoop) };
  s = advanceTo(s, 600 * rules.siloCapacity, withCoop); // exakt voll
  assert.equal(count(s, WHEAT), rules.siloCapacity);
  assert.equal(stored(s, withCoop), withCoop.siloCapacity);

  // Weitere 10h bei vollem Lager: nichts entsteht, nichts wird angespart.
  const later = advanceTo(s, s.tick + 36_000, withCoop);
  assert.equal(count(later, WHEAT), rules.siloCapacity);
  assert.equal(later.passives[0], 0);

  // Nach dem Freiräumen gibt es KEINEN Schwall aus gebunkerter Zeit.
  const freed = { ...later, items: later.items.map((v, i) => (i === WHEAT ? 50 : v)) };
  const resumed = advanceTo(freed, later.tick + 600, withCoop);
  assert.equal(count(resumed, WHEAT), 51, 'genau eine Einheit nach genau einem Intervall');
});

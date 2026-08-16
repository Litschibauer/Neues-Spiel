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
import { initialState, stored } from '../src/sim/state.ts';
import { advanceTo } from '../src/sim/sim.ts';

const T0 = 1_700_000_000_000;
const rules = getRuleset(CURRENT_RULESET_VERSION);

test('Lagerlimit kann offline gar nicht überschritten werden', () => {
  const server = new Server(initialState(3), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  client.plant(0);
  client.advanceClock(60_000); // Stall füllt das Lager exakt auf 100 Eier

  const before = client.queue.length;
  const res = client.harvest(0);

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'SILO_FULL');
  // Entscheidend: Das Command landet nicht mal im Log.
  assert.equal(client.queue.length, before);
});

test('Hard block statt stillem Verlust: das Feld bleibt reif stehen', () => {
  const server = new Server(initialState(3), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  client.plant(0);
  client.advanceClock(60_000);
  client.harvest(0); // blockiert

  // Platz schaffen → dieselbe Ernte geht jetzt durch, nichts ist verloren.
  assert.equal(client.sellNpc('eggs', 20).ok, true);
  assert.equal(client.harvest(0).ok, true);
  assert.equal(client.state.wheat, 10);
  assert.equal(client.state.eggs, 80);
  assert.equal(stored(client.state), 90);

  const sync = server.sync(client.buildSyncRequest(), T0 + 60_000 * 1000);
  assert.equal(sync.ok, true);
  if (!sync.ok) return;
  assert.equal(sync.divergence, false);
});

test('der Stall stallt bei vollem Lager — und bunkert keine Zeit', () => {
  let s = initialState(1);
  s = advanceTo(s, 60_000, rules); // 100 Eier, Lager voll
  assert.equal(s.eggs, 100);
  assert.equal(stored(s), rules.siloCapacity);

  // Weitere 10h bei vollem Lager: nichts entsteht, nichts wird angespart.
  const later = advanceTo(s, 60_000 + 36_000, rules);
  assert.equal(later.eggs, 100);
  assert.equal(later.coopProgress, 0);

  // Nach dem Freiräumen gibt es KEINEN Schwall aus gebunkerter Zeit.
  const freed = { ...later, eggs: 50 };
  const resumed = advanceTo(freed, later.tick + 600, rules);
  assert.equal(resumed.eggs, 51, 'genau ein Ei nach genau einem Intervall');
});

test('Server lehnt einen handgebauten Log ab, der das Limit verletzt', () => {
  const server = new Server(initialState(3), T0, CURRENT_RULESET_VERSION);

  // Ein manipulierter Client, der die lokale Prüfung einfach überspringt.
  const res = server.sync(
    {
      baseSeq: 0,
      rulesetVersion: CURRENT_RULESET_VERSION,
      commands: [
        { seq: 1, tick: 0, type: 'PLANT', field: 0 },
        { seq: 2, tick: 60_000, type: 'HARVEST', field: 0 }, // Lager ist da voll
      ],
    },
    T0 + 60_000 * 1000,
  );

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'ILLEGAL_COMMAND:SILO_FULL');
  assert.equal(res.snapshot.seq, 0);
});

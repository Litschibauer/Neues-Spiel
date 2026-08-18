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

const WHEAT = 1;
const FEED = 2;
const R_WHEAT = 0;
const R_FEED = 1;
const MILL = 6;
const GROW = rules.recipes[R_WHEAT]!.durationTicks;
const YIELD = rules.recipes[R_WHEAT]!.output.amount;

function nearlyFull(freeSpace: number) {
  const base = initialState(rules);
  const items = base.items.map(() => 0);
  items[WHEAT] = rules.siloCapacity - freeSpace;
  return { ...base, items };
}

const TIGHT = YIELD - 2;

const SEED = rules.recipes[R_WHEAT]!.inputs.find((i) => i.item === WHEAT)?.amount ?? 0;

test('Lagerlimit kann offline gar nicht überschritten werden', () => {
  const server = new Server(nearlyFull(TIGHT), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  client.start(0, R_WHEAT);
  client.advanceClock(GROW);

  const before = client.queue.length;
  const res = client.collect(0);

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'SILO_FULL');

  assert.equal(client.queue.length, before);
});

test('Hard block statt stillem Verlust: der fertige Platz bleibt stehen', () => {
  const server = new Server(nearlyFull(TIGHT), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  client.start(0, R_WHEAT);
  client.advanceClock(GROW);
  client.collect(0);

  assert.equal(client.sellNpc(WHEAT, 20).ok, true);
  assert.equal(client.collect(0).ok, true);
  assert.equal(count(client.state, WHEAT), rules.siloCapacity - TIGHT - SEED - 20 + YIELD);

  const sync = server.sync(client.buildSyncRequest(), T0 + GROW * 1000);
  assert.equal(sync.ok, true);
  if (!sync.ok) return;
  assert.equal(sync.divergence, false);
});

test('Server lehnt einen handgebauten Log ab, der das Limit verletzt', () => {
  const server = new Server(nearlyFull(TIGHT), T0, CURRENT_RULESET_VERSION);

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

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.kind, 'partial');
  assert.equal(res.rejectedFrom, 2);
  assert.equal(res.reason, 'ILLEGAL_COMMAND:SILO_FULL');
  assert.equal(res.snapshot.seq, 1);

  assert.equal(count(res.snapshot.state, WHEAT), rules.siloCapacity - TIGHT - SEED);
});

test('Eingaben verbrauchen macht Platz — die Mühle entlastet das Lager', () => {
  const base = nearlyFull(0);
  const withMill = {
    ...base,
    plots: base.plots.map((p, i) =>
      i === MILL ? { ...p, level: 1, slots: [{ recipe: -1, startedAt: 0 }] } : p,
    ),
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
  const withCoop: Ruleset = {
    ...rules,
    recipes: [
      ...rules.recipes,
      { id: 'trickle', inputs: [], output: { item: WHEAT, amount: 1 }, durationTicks: 600 },
    ],
    passives: [{ id: 'well', recipe: rules.recipes.length }],
  };

  let s = { ...initialState(withCoop) };
  s = advanceTo(s, 600 * rules.siloCapacity, withCoop);
  assert.equal(count(s, WHEAT), rules.siloCapacity);
  assert.equal(stored(s, withCoop), withCoop.siloCapacity);

  const later = advanceTo(s, s.tick + 36_000, withCoop);
  assert.equal(count(later, WHEAT), rules.siloCapacity);
  assert.equal(later.passives[0], 0);

  const freed = { ...later, items: later.items.map((v, i) => (i === WHEAT ? 50 : v)) };
  const resumed = advanceTo(freed, later.tick + 600, withCoop);
  assert.equal(count(resumed, WHEAT), 51, 'genau eine Einheit nach genau einem Intervall');
});

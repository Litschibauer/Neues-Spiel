import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '../src/client/client.ts';
import { getRuleset, slotsAt, validateRuleset } from '../src/sim/rules.ts';
import { initialState, count } from '../src/sim/state.ts';
import { migrateState, assertInvariants } from '../src/sim/migrate.ts';
import { farmView } from '../src/client/view.ts';
import type { State } from '../src/sim/state.ts';

const T0 = 1_700_000_000_000;
const V4 = getRuleset(4);
const rules = getRuleset(5);

const GOLD = 0;
const WHEAT = 1;
const FEED = 2;
const EGGS = 3;
const CORN = 4;
const MILK = 5;
const COW_FEED = 9;

const R_FEED = 1;
const R_EGGS = 2;
const R_MILK = 4;
const R_COW_FEED = 8;

const MILL = rules.plots.findIndex((p) => p.id === 'mill');
const COOP = rules.plots.findIndex((p) => p.id === 'coop-1');
const PASTURE = rules.plots.findIndex((p) => p.id === 'pasture-1');

function rich(patch: Partial<State> = {}): State {
  const base = initialState(rules);
  const items = base.items.slice();
  items[GOLD] = 100_000;
  items[WHEAT] = 60;
  items[CORN] = 30;
  return { ...base, items, xp: rules.levelThresholds[10]!, ...patch };
}

function client(state = rich()): Client {
  return new Client({ state, seq: 0, serverTs: T0, rulesetVersion: 5 });
}

test('ein Stall fasst genau drei Tiere — nicht mehr', () => {
  for (const plot of [COOP, PASTURE, rules.plots.findIndex((p) => p.id === 'coop-2')]) {
    const levels = rules.plots[plot]!.levels;
    assert.equal(levels.length, 3, `${rules.plots[plot]!.id}: nicht drei Ausbaustufen`);
    assert.deepEqual(
      levels.map((_, i) => slotsAt(rules, plot, i + 1)),
      [1, 2, 3],
      `${rules.plots[plot]!.id}: Tierzahl wächst nicht 1 → 2 → 3`,
    );
  }
});

test('jedes Tier derselben Art kostet gleich viel', () => {
  const chickens = [COOP, rules.plots.findIndex((p) => p.id === 'coop-2')].flatMap((plot) =>
    rules.plots[plot]!.levels.slice(1).map((l) => l.cost[0]!.amount),
  );
  assert.equal(new Set(chickens).size, 1, `Hühner kosten unterschiedlich: ${chickens.join(', ')}`);

  const cows = rules.plots[PASTURE]!.levels.slice(1).map((l) => l.cost[0]!.amount);
  assert.equal(new Set(cows).size, 1, `Kühe kosten unterschiedlich: ${cows.join(', ')}`);
});

test('Tiere werden einzeln gekauft — Stufe für Stufe, nie zwei auf einmal', () => {
  const c = client();
  assert.equal(c.buy(COOP).ok, true);
  assert.equal(c.preview().plots[COOP]!.slots.length, 1);
  assert.equal(c.buy(COOP).ok, true);
  assert.equal(c.preview().plots[COOP]!.slots.length, 2);
  assert.equal(c.buy(COOP).ok, true);
  assert.equal(c.preview().plots[COOP]!.slots.length, 3);

  const voll = c.buy(COOP);
  assert.equal(voll.ok, false);
  if (!voll.ok) assert.equal(voll.code, 'MAX_LEVEL');
});

test('jede Tierart hat ihr eigenes Futter', () => {
  const chicken = rules.recipes[R_FEED]!;
  assert.deepEqual(
    chicken.inputs.map((i) => [i.item, i.amount]),
    [[WHEAT, 3]],
    'Hühnerfutter ist nicht 3 Weizen',
  );
  assert.equal(chicken.output.item, FEED);
  assert.equal(chicken.output.amount, 2);

  const cow = rules.recipes[R_COW_FEED]!;
  assert.deepEqual(
    cow.inputs.map((i) => [i.item, i.amount]),
    [
      [CORN, 1],
      [WHEAT, 2],
    ],
    'Kuhfutter ist nicht 1 Mais + 2 Weizen',
  );
  assert.equal(cow.output.item, COW_FEED);
  assert.equal(cow.output.amount, 2);

  assert.deepEqual(rules.recipes[R_EGGS]!.inputs.map((i) => i.item), [FEED]);
  assert.deepEqual(rules.recipes[R_MILK]!.inputs.map((i) => i.item), [COW_FEED]);

  assert.deepEqual(rules.plots[MILL]!.levels[0]!.recipes, [R_FEED, R_COW_FEED]);
});

test('ein Tier frisst genau eine Portion', () => {
  for (const recipe of [R_EGGS, R_MILK]) {
    const inputs = rules.recipes[recipe]!.inputs;
    assert.equal(inputs.length, 1, `Rezept ${rules.recipes[recipe]!.id} hat mehr als eine Zutat`);
    assert.equal(inputs[0]!.amount, 1, `Rezept ${rules.recipes[recipe]!.id} frisst mehr als 1`);
  }
});

test('drei Hühner fressen dreimal — jedes einzeln', () => {
  const items = rich().items.slice();
  items[FEED] = 3;
  const c = client(rich({ items }));
  c.buy(COOP);
  c.buy(COOP);
  c.buy(COOP);

  assert.equal(c.start(COOP, R_EGGS, 0).ok, true);
  assert.equal(count(c.state, FEED), 2);
  assert.equal(c.start(COOP, R_EGGS, 1).ok, true);
  assert.equal(count(c.state, FEED), 1);
  assert.equal(c.start(COOP, R_EGGS, 2).ok, true);
  assert.equal(count(c.state, FEED), 0);

  const hungrig = c.start(COOP, R_EGGS, 0);
  assert.equal(hungrig.ok, false);
  if (!hungrig.ok) assert.equal(hungrig.code, 'PLOT_BUSY');
});

test('jedes Tier hat seine eigene Uhr', () => {
  const dauer = rules.recipes[R_EGGS]!.durationTicks;
  const items = rich().items.slice();
  items[FEED] = 3;
  const c = client(rich({ items }));
  c.buy(COOP);
  c.buy(COOP);

  c.start(COOP, R_EGGS, 0);
  c.advanceClock(60);
  c.start(COOP, R_EGGS, 1);

  c.advanceClock(dauer - 60);
  const view = farmView(c.preview(), rules);
  const stall = view.plots[COOP]!;

  assert.equal(stall.slots[0]!.done, true, 'das erste Huhn ist fertig');
  assert.equal(stall.slots[1]!.done, false, 'das zweite Huhn ist noch nicht so weit');
  assert.equal(stall.slots[1]!.remaining, 60);

  assert.equal(c.collect(COOP, 0).ok, true);
  assert.equal(count(c.state, EGGS), rules.recipes[R_EGGS]!.output.amount);

  const zuFrueh = c.collect(COOP, 1);
  assert.equal(zuFrueh.ok, false);
  if (!zuFrueh.ok) assert.equal(zuFrueh.code, 'NOT_DONE');

  c.advanceClock(60);
  assert.equal(c.collect(COOP, 1).ok, true);
  assert.equal(count(c.state, EGGS), 2 * rules.recipes[R_EGGS]!.output.amount);
});

test('ein Platz, den es nicht gibt, wird sauber abgewiesen', () => {
  const c = client();
  c.buy(COOP);
  const res = c.start(COOP, R_EGGS, 7);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'NO_SUCH_SLOT');
});

test('das nächste Tier lässt sich kaufen, während das erste arbeitet', () => {
  const items = rich().items.slice();
  items[FEED] = 3;
  const c = client(rich({ items }));
  c.buy(COOP);
  c.start(COOP, R_EGGS, 0);
  c.advanceClock(100);

  assert.equal(c.buy(COOP).ok, true, 'Tierkauf blockiert durch laufende Produktion');

  const stall = c.preview().plots[COOP]!;
  assert.equal(stall.slots.length, 2);
  assert.equal(stall.slots[0]!.recipe, R_EGGS, 'das laufende Huhn wurde zurückgesetzt');
  assert.equal(stall.slots[1]!.recipe, -1);
});

test('die Kuhweide gibt Milch nur gegen Kuhfutter', () => {
  const items = rich().items.slice();
  items[FEED] = 5;
  const c = client(rich({ items }));
  c.buy(PASTURE);

  const ohne = c.start(PASTURE, R_MILK, 0);
  assert.equal(ohne.ok, false, 'Hühnerfutter macht keine Milch');
  if (!ohne.ok) assert.equal(ohne.code, 'NOT_ENOUGH_ITEMS');

  c.buy(MILL);
  assert.equal(c.start(MILL, R_COW_FEED).ok, true);
  c.advanceClock(rules.recipes[R_COW_FEED]!.durationTicks);
  assert.equal(c.collect(MILL).ok, true);
  assert.equal(count(c.state, COW_FEED), 2);

  assert.equal(c.start(PASTURE, R_MILK, 0).ok, true);
  c.advanceClock(rules.recipes[R_MILK]!.durationTicks);
  assert.equal(c.collect(PASTURE, 0).ok, true);
  assert.equal(count(c.state, MILK), rules.recipes[R_MILK]!.output.amount);
});

test('ein Hof aus v4 bekommt beim Patch Ställe statt kaputter Plätze', () => {
  const base = initialState(V4);
  const plots = base.plots.map((p, i) => {
    if (i === COOP) return { level: 2, slots: [{ recipe: R_EGGS, startedAt: 0 }] };
    if (i === PASTURE) return { level: 1, slots: [] };
    return p;
  });

  const migrated = migrateState({ ...base, tick: 10, plots }, 4, 5);
  assertInvariants(migrated, rules);

  assert.equal(migrated.plots[COOP]!.level, 2);
  assert.equal(migrated.plots[COOP]!.slots.length, 2, 'zwei Hühner, wie bezahlt');
  assert.equal(migrated.plots[COOP]!.slots[0]!.recipe, R_EGGS, 'das laufende Huhn ging verloren');
  assert.equal(migrated.plots[PASTURE]!.slots.length, 1, 'die leere Weide bekommt ihre Kuh');
  assert.equal(count(migrated, COW_FEED), 0, 'Kuhfutter beginnt bei null');
});

test('das Regelwerk v5 ist in sich stimmig', () => {
  assert.deepEqual(validateRuleset(rules), []);
});

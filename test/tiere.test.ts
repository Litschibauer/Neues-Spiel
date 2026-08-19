import test from 'node:test';
import assert from 'node:assert/strict';
import { LATEST_RULESET_VERSION, blockiert, getRuleset, sizeOf, slotsAt } from '../src/sim/rules.ts';
import type { Ruleset } from '../src/sim/rules.ts';
import { initialState } from '../src/sim/state.ts';
import type { State } from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';
import { assertInvariants, migrateState } from '../src/sim/migrate.ts';
import { farmView } from '../src/client/view.ts';

const V16 = getRuleset(16);
const V15 = getRuleset(15);
const GOLD = 0;

function plotOf(rules: Ruleset, id: string): number {
  const i = rules.plots.findIndex((p) => p.id === id);
  assert.notEqual(i, -1, `${id} fehlt`);
  return i;
}

const COOP = plotOf(V16, 'coop-1');
const R_EGGS = V16.plots[COOP]!.levels[0]!.recipes[0]!;
const FEED = V16.recipes[R_EGGS]!.inputs[0]!.item;

function freieStelle(rules: Ruleset, plot: number): { gx: number; gy: number } {
  const raster = rules.grid!;
  const g = sizeOf(rules, plot);
  for (let y = 0; y + g.h <= raster.h; y++) {
    for (let x = 0; x + g.w <= raster.w; x++) {
      if (!blockiert(rules, x, y, g.w, g.h)) return { gx: x, gy: y };
    }
  }
  throw new Error('kein freies Feld');
}

function hofMitStall(gold = 100_000, feed = 20): State {
  const base = initialState(V16);
  const items = base.items.map(() => 0);
  items[GOLD] = gold;
  items[FEED] = feed;
  const stelle = freieStelle(V16, COOP);
  const plots = base.plots.map((p, i) =>
    i === COOP
      ? {
          ...p,
          level: 1,
          slots: [0, 1, 2].map(() => ({ recipe: -1, startedAt: 0 })),
          gx: stelle.gx,
          gy: stelle.gy,
        }
      : p,
  );
  return { ...base, items, plots, xp: 100_000 };
}

test('ein frisch gebauter Stall ist leer', () => {
  const s = hofMitStall();
  const p = farmView(s, V16).plots[COOP]!;

  assert.equal(p.stall!.places, 3);
  assert.equal(p.stall!.animals, 0);
  assert.equal(p.stall!.free, 3);
  assert.ok(p.slots.every((slot) => slot.animal === 'none'));
  assert.equal(p.tap, 'buy-animal');
});

test('ohne Tier lässt sich kein Platz starten', () => {
  const s = hofMitStall();
  assert.throws(
    () => simulate(s, { seq: 1, tick: 0, type: 'START', plot: COOP, recipe: R_EGGS, slot: 0 }, V16),
    { code: 'NO_ANIMAL' },
  );
});

test('ein gekauftes Küken kostet Gold, wächst und legt dann', () => {
  const tier = V16.plots[COOP]!.animal!;
  const s = hofMitStall();

  const gekauft = simulate(s, { seq: 1, tick: 0, type: 'BUY_ANIMAL', plot: COOP }, V16);
  assert.equal(gekauft.items[GOLD], s.items[GOLD]! - tier.cost);
  assert.deepEqual(gekauft.plots[COOP]!.tiere, [0]);

  const jung = farmView(gekauft, V16).plots[COOP]!;
  assert.equal(jung.slots[0]!.animal, 'young');
  assert.equal(jung.slots[0]!.grownIn, tier.growTicks);
  assert.equal(jung.slots[0]!.tap, 'none');

  assert.throws(
    () =>
      simulate(
        gekauft,
        { seq: 2, tick: tier.growTicks - 1, type: 'START', plot: COOP, recipe: R_EGGS, slot: 0 },
        V16,
      ),
    { code: 'ANIMAL_TOO_YOUNG' },
  );

  const erwachsen = farmView({ ...gekauft, tick: tier.growTicks }, V16).plots[COOP]!;
  assert.equal(erwachsen.slots[0]!.animal, 'grown');

  const laeuft = simulate(
    gekauft,
    { seq: 2, tick: tier.growTicks, type: 'START', plot: COOP, recipe: R_EGGS, slot: 0 },
    V16,
  );
  assert.equal(laeuft.plots[COOP]!.slots[0]!.recipe, R_EGGS);
});

test('Tiere kommen einzeln und nur so viele, wie Plätze da sind', () => {
  let s = hofMitStall();
  for (let n = 1; n <= 3; n++) {
    s = simulate(s, { seq: n, tick: 0, type: 'BUY_ANIMAL', plot: COOP }, V16);
    assert.equal(s.plots[COOP]!.tiere.length, n);
  }
  assert.throws(
    () => simulate(s, { seq: 4, tick: 0, type: 'BUY_ANIMAL', plot: COOP }, V16),
    { code: 'NO_ANIMAL_SPACE' },
  );
  assertInvariants(s, V16);
});

test('wer das Gold nicht hat, bekommt kein Tier', () => {
  const arm = hofMitStall(10);
  assert.throws(
    () => simulate(arm, { seq: 1, tick: 0, type: 'BUY_ANIMAL', plot: COOP }, V16),
    { code: 'CANT_AFFORD' },
  );
});

test('ein Platz ohne Tiere weist den Kauf ab', () => {
  const feld = plotOf(V16, 'field-1');
  const s = hofMitStall();
  assert.throws(
    () => simulate(s, { seq: 1, tick: 0, type: 'BUY_ANIMAL', plot: feld }, V16),
    { code: 'NOT_AN_ANIMAL_PLOT' },
  );
});

test('wer schon Hühner hatte, behält sie beim Umzug auf v16', () => {
  const alt = initialState(V15);
  const stall = plotOf(V15, 'coop-1');
  const plots = alt.plots.map((p, i) =>
    i === stall
      ? {
          ...p,
          level: 2,
          slots: [0, 1].map(() => ({ recipe: -1, startedAt: 0 })),
          ...freieStelle(V15, stall),
        }
      : p,
  );
  const vorher = { ...alt, plots, tick: 5000, xp: 100_000 };
  assert.equal(slotsAt(V15, stall, 2), 2);

  const neu = migrateState(vorher, 15, 16);
  assert.equal(neu.plots[stall]!.tiere.length, 2, 'die zwei Hühner sind weg');
  assert.equal(neu.plots[stall]!.slots.length, slotsAt(V16, stall, 2));

  const v = farmView(neu, V16).plots[stall]!;
  assert.ok(
    v.slots.slice(0, 2).every((s) => s.animal === 'grown'),
    'die alten Hühner sind plötzlich wieder Küken',
  );
  assert.equal(v.slots[2]!.animal, 'none');
  assert.equal(v.stall!.free, slotsAt(V16, stall, 2) - 2);
});

test('vor v16 bleiben die Ställe, wie sie waren', () => {
  const s = initialState(V15);
  const stall = plotOf(V15, 'coop-1');
  const p = farmView({ ...s, plots: s.plots.map((x, i) => (i === stall ? { ...x, level: 1, slots: [{ recipe: -1, startedAt: 0 }], ...freieStelle(V15, stall) } : x)) }, V15)
    .plots[stall]!;
  assert.equal(p.stall, null);
  assert.equal(p.slots[0]!.animal, null);
});

test('jeder Tierplatz im neuesten Regelwerk ist bezahlbar beschrieben', () => {
  const rules = getRuleset(LATEST_RULESET_VERSION);
  let welche = 0;
  rules.plots.forEach((def, i) => {
    if (!def.animal) return;
    welche++;
    assert.ok(def.animal.cost > 0, `${def.id}: Tier kostet nichts`);
    assert.ok(def.animal.growTicks > 0, `${def.id}: Tier wächst nicht`);
    assert.ok(slotsAt(rules, i, 1) >= 1, `${def.id}: keine Plätze auf Stufe 1`);
  });
  assert.ok(welche >= 3, `nur ${welche} Ställe mit Tieren`);
});

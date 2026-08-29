import test from 'node:test';
import assert from 'node:assert/strict';
import { getRuleset, itemUnlockLevel, recipeOutputs, LATEST_RULESET_VERSION } from '../src/sim/rules.ts';
import { initialState, EMPTY_PLOT } from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';

const V = getRuleset(23);

function idOf(id: string): number {
  const i = V.items.findIndex((x) => x.id === id);
  assert.notEqual(i, -1, `${id} fehlt im Katalog`);
  return i;
}
function plotOf(id: string): number {
  const i = V.plots.findIndex((p) => p.id === id);
  assert.notEqual(i, -1, `${id} fehlt`);
  return i;
}
function recipeOf(id: string): number {
  const i = V.recipes.findIndex((r) => r.id === id);
  assert.notEqual(i, -1, `${id} fehlt`);
  return i;
}

const COAL = idOf('coal');
const IRON = idOf('iron-ore');
const GOLD = idOf('gold-ore');
const IRON_BAR = idOf('iron-bar');
const GOLD_BAR = idOf('gold-bar');
const MINE = plotOf('mine');
const FORGE = plotOf('forge');

// Setzt einen Platz auf einen fertigen Slot mit dem Rezept und erntet.
function ernte(recipeId: string, plot: number, vorrat: [number, number][]): readonly number[] {
  const base = initialState(V);
  const items = base.items.map(() => 0);
  for (const [i, n] of vorrat) items[i] = n;
  const dauer = V.recipes[recipeOf(recipeId)]!.durationTicks;
  const plots = base.plots.slice();
  plots[plot] = { level: 1, slots: [{ recipe: recipeOf(recipeId), startedAt: 0 }], gx: -1, gy: -1, tiere: [] };
  const s = { ...base, items, plots, tick: dauer + 1, xp: 10_000_000 };
  return simulate(s, { seq: 1, tick: dauer + 1, type: 'COLLECT', plot, slot: 0 }, V).items;
}

test('v23 hat die Bergbau-Waren im Katalog', () => {
  ['explosive', 'coal', 'iron-ore', 'gold-ore', 'iron-bar', 'gold-bar'].forEach((id) => idOf(id));
  assert.ok(LATEST_RULESET_VERSION >= 23);
});

test('graben gibt mehrere Erze auf einmal — Werkzeug bestimmt die Menge', () => {
  const rSch = V.recipes[recipeOf('dig-shovel')]!;
  const rHacke = V.recipes[recipeOf('dig-pickaxe')]!;
  const rBlast = V.recipes[recipeOf('dig-blast')]!;

  const summe = (r: typeof rSch) => recipeOutputs(r).reduce((n, o) => n + o.amount, 0);
  assert.ok(summe(rSch) < summe(rHacke), 'Schaufel weniger als Spitzhacke');
  assert.ok(summe(rHacke) < summe(rBlast), 'Spitzhacke weniger als Sprengstoff');

  // Schaufel: nur Kohle + Eisen, kein Gold
  const nachSchaufel = ernte('dig-shovel', MINE, [[idOf('shovel'), 1]]);
  assert.equal(nachSchaufel[COAL], 2);
  assert.equal(nachSchaufel[IRON], 1);
  assert.equal(nachSchaufel[GOLD], 0, 'Schaufel gibt kein Gold');

  // Sprengstoff: das meiste, inklusive Gold
  const nachBlast = ernte('dig-blast', MINE, [[idOf('explosive'), 1]]);
  assert.equal(nachBlast[COAL], 5);
  assert.equal(nachBlast[IRON], 3);
  assert.equal(nachBlast[GOLD], 2);
});

test('die Schmiede macht aus Erz und Kohle Barren', () => {
  const nach = ernte('iron-bar', FORGE, [[IRON, 2], [COAL, 1]]);
  assert.equal(nach[IRON_BAR], 1);
  const gold = ernte('gold-bar', FORGE, [[GOLD, 2], [COAL, 1]]);
  assert.equal(gold[GOLD_BAR], 1);
});

test('die Bergbau-Waren schalten sich erst mit der Mine/Schmiede frei', () => {
  assert.equal(itemUnlockLevel(V, COAL), 10);
  assert.equal(itemUnlockLevel(V, IRON), 10);
  assert.equal(itemUnlockLevel(V, GOLD), 10);
  assert.equal(itemUnlockLevel(V, IRON_BAR), 11);
  assert.equal(itemUnlockLevel(V, GOLD_BAR), 11);
});

test('ein voller Erz-Ertrag scheitert, wenn das Lager keinen Platz hat', () => {
  const base = initialState(V);
  const items = base.items.map(() => 0);
  items[idOf('explosive')] = 1;
  // Lager fast voll füllen
  const kapazität = V.siloCapacity;
  items[COAL] = kapazität; // Lager voll mit Kohle
  const plots = base.plots.slice();
  const dauer = V.recipes[recipeOf('dig-blast')]!.durationTicks;
  plots[MINE] = { level: 1, slots: [{ recipe: recipeOf('dig-blast'), startedAt: 0 }], gx: -1, gy: -1, tiere: [] };
  const s = { ...base, items, plots, tick: dauer + 1, xp: 10_000_000 };
  assert.throws(
    () => simulate(s, { seq: 1, tick: dauer + 1, type: 'COLLECT', plot: MINE, slot: 0 }, V),
    { code: 'SILO_FULL' },
  );
  void EMPTY_PLOT;
});

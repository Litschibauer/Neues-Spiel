import test from 'node:test';
import assert from 'node:assert/strict';
import { getRuleset } from '../src/sim/rules.ts';
import { initialState } from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';

const V = getRuleset(32);

test('ab v32 gibt es abreißbare Deko-Plätze', () => {
  const decos = V.plots.filter((p) => p.deco);
  assert.ok(decos.length >= 3, 'mindestens drei Dekorationen');
  assert.ok(decos.every((p) => !p.fixed && p.levels.length === 1), 'frei platzierbar, kein Ausbau');
});

test('ein gebautes Bauwerk abreißen gibt halbes Gold zurück und macht den Platz frei', () => {
  const MILL = V.plots.findIndex((p) => p.id === 'mill');
  const base = initialState(V);
  const plots = base.plots.map((p, i) => (i === MILL ? { ...p, level: 1 } : p));
  const s = { ...base, plots, items: base.items.map(() => 0), xp: 0 };

  const goldEinsatz = V.plots[MILL]!.levels[0]!.cost
    .filter((c) => c.item === V.currency)
    .reduce((n, c) => n + c.amount, 0);

  const nach = simulate(s, { seq: 1, tick: 0, type: 'REMOVE_PLOT', plot: MILL }, V);
  assert.equal(nach.items[V.currency], Math.floor(goldEinsatz / 2), 'halbes Gold zurück');
  assert.equal(nach.plots[MILL]!.level, 0, 'Platz wieder frei');
  assert.equal(nach.plots[MILL]!.gx, -1, 'vom Raster genommen');
});

test('feste Bauwerke (Mine) lassen sich nicht abreißen', () => {
  const MINE = V.plots.findIndex((p) => p.id === 'mine');
  const base = initialState(V);
  const plots = base.plots.map((p, i) => (i === MINE ? { ...p, level: 1 } : p));
  const s = { ...base, plots };
  assert.throws(
    () => simulate(s, { seq: 1, tick: 0, type: 'REMOVE_PLOT', plot: MINE }, V),
    { code: 'CANT_REMOVE' },
  );
});

test('einen leeren Platz kann man nicht abreißen', () => {
  const BENCH = V.plots.findIndex((p) => p.id === 'deco-bench');
  const s = initialState(V); // Deko ungebaut
  assert.throws(
    () => simulate(s, { seq: 1, tick: 0, type: 'REMOVE_PLOT', plot: BENCH }, V),
    { code: 'PLOT_LOCKED' },
  );
});

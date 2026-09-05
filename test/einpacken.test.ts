import test from 'node:test';
import assert from 'node:assert/strict';
import { getRuleset, LATEST_RULESET_VERSION } from '../src/sim/rules.ts';
import { initialState } from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';

const V = getRuleset(LATEST_RULESET_VERSION);
const FENCE = V.plots.findIndex((p) => p.id === 'deco-fence');
const MINE = V.plots.findIndex((p) => p.id === 'mine');

function mitGebautem(plot: number) {
  const base = initialState(V);
  const plots = base.plots.map((p, i) => (i === plot ? { ...p, level: 1, gx: 5, gy: 5 } : p));
  // Genug XP und Gold, damit ein späteres Aufstellen grundsätzlich ginge.
  return { ...base, plots, xp: 100000, items: base.items.map((_, i) => (i === V.currency ? 100000 : 0)) };
}

test('Dekoration einpacken nimmt sie vom Feld und merkt sie sich', () => {
  const s = mitGebautem(FENCE);
  const goldVor = s.items[V.currency];
  const nach = simulate(s, { seq: 1, tick: 0, type: 'PACK_PLOT', plot: FENCE }, V);
  assert.equal(nach.plots[FENCE]!.level, 0, 'vom Feld genommen');
  assert.equal(nach.plots[FENCE]!.gx, -1, 'vom Raster genommen');
  assert.ok(nach.eingepackt.includes(FENCE), 'als eingepackt gemerkt');
  assert.equal(nach.items[V.currency], goldVor, 'kein Gold-Verlust, kein -gewinn');
});

test('eingepackte Deko stellt man kostenlos wieder auf', () => {
  let s = mitGebautem(FENCE);
  s = simulate(s, { seq: 1, tick: 0, type: 'PACK_PLOT', plot: FENCE }, V);
  const goldVor = s.items[V.currency];
  const nach = simulate(s, { seq: 2, tick: 0, type: 'BUY', plot: FENCE }, V);
  assert.equal(nach.plots[FENCE]!.level, 1, 'wieder aufgestellt');
  assert.equal(nach.items[V.currency], goldVor, 'kostenlos — kein Gold abgezogen');
  assert.ok(!nach.eingepackt.includes(FENCE), 'nicht mehr eingepackt');
});

test('ein normaler Kauf (ohne Einpacken) kostet weiterhin Gold', () => {
  const base = initialState(V);
  const s = { ...base, xp: 100000, items: base.items.map((_, i) => (i === V.currency ? 100000 : 0)) };
  const kosten = V.plots[FENCE]!.levels[0]!.cost
    .filter((c) => c.item === V.currency)
    .reduce((n, c) => n + c.amount, 0);
  const nach = simulate(s, { seq: 1, tick: 0, type: 'BUY', plot: FENCE }, V);
  assert.equal(nach.items[V.currency], 100000 - kosten, 'volle Kosten abgezogen');
});

test('nur Dekoration lässt sich einpacken — Bauwerke nicht', () => {
  const s = mitGebautem(MINE);
  assert.throws(
    () => simulate(s, { seq: 1, tick: 0, type: 'PACK_PLOT', plot: MINE }, V),
    { code: 'NOT_PACKABLE' },
  );
});

test('einen leeren Platz kann man nicht einpacken', () => {
  const s = initialState(V);
  assert.throws(
    () => simulate(s, { seq: 1, tick: 0, type: 'PACK_PLOT', plot: FENCE }, V),
    { code: 'PLOT_LOCKED' },
  );
});

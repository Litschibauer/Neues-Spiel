import test from 'node:test';
import assert from 'node:assert/strict';
import { blockiert, getRuleset, inSperre, validateRuleset, LATEST_RULESET_VERSION } from '../src/sim/rules.ts';
import { initialState, startPlatz, type State } from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';
import { migrateState } from '../src/sim/migrate.ts';
import { topUpChests } from '../src/server/chests.ts';

const rules = getRuleset(51);
const alt = getRuleset(50);
const WEG = rules.grid!.sperren!.find((z) => z.id === 'weg')!;
const UFER = rules.grid!.sperren!.find((z) => z.id === 'ufer')!;

test('Wegrand und Ufer sind Sperrzonen: nichts darf dort stehen', () => {
  assert.equal(WEG.gy, 0);
  assert.equal(WEG.h, 3);
  assert.equal(WEG.w, rules.grid!.w);
  assert.ok(inSperre(rules, 40, 2, 1, 1) && !inSperre(rules, 40, 3, 1, 1));
  assert.ok(blockiert(rules, 50, 1, 2, 2));
  assert.ok(blockiert(rules, UFER.gx, UFER.gy, 1, 1), 'das Ufer ist gesperrt');
  assert.equal(inSperre(alt, 40, 2, 1, 1), false, 'Fassung 50 kennt keine Sperrzonen');
  let s = initialState(rules);
  s = { ...s, items: s.items.map((n, i) => (i === rules.currency ? 100_000 : n)), xp: 100_000 };
  const MILL = rules.plots.findIndex((p) => p.id === 'mill');
  s = simulate(s, { seq: 1, tick: 0, type: 'BUY', plot: MILL }, rules);
  assert.throws(() => simulate(s, { seq: 2, tick: 0, type: 'PLACE', plot: MILL, gx: 40, gy: 1 }, rules), /CELL_TAKEN/);
  assert.throws(() => simulate(s, { seq: 2, tick: 0, type: 'PLACE', plot: MILL, gx: 2, gy: 10 }, rules), /CELL_TAKEN/);
});

test('Hindernisse in Sperrzonen bleiben liegen — und Kisten fallen nie hinein', () => {
  const drin = (rules.obstacles ?? []).findIndex((h) => inSperre(rules, h.gx, h.gy, h.w, h.h));
  assert.ok(drin >= 0, 'es gibt Hindernisse im Wegrand oder am Ufer');
  let s = initialState(rules);
  s = { ...s, items: s.items.map(() => 50), xp: 100_000 };
  assert.throws(() => simulate(s, { seq: 1, tick: 0, type: 'CLEAR_OBSTACLE', index: drin }, rules), /CELL_TAKEN/);
  // Hundert Kisten wuerfeln — keine im Wegrand, keine am Ufer.
  let seed = 7;
  const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  for (let k = 0; k < 100; k++) {
    const { chests } = topUpChests({ ...s, chests: [] }, rules, rnd);
    for (const c of chests) if (c.gx >= 0) assert.equal(inSperre(rules, c.gx, c.gy, 1, 1), false, `Kiste bei ${c.gx},${c.gy}`);
  }
});

test('zwoelf Felder, vier davon am Start — alle mit allen Feldfruechten und im Regen', () => {
  const felder = rules.plots.map((p, i) => i).filter((i) => rules.plots[i]!.id.indexOf('field-') === 0);
  assert.equal(felder.length, 12);
  const s = initialState(rules);
  const amStart = felder.filter((i) => s.plots[i]!.level > 0);
  assert.equal(amStart.length, 4);
  for (const i of amStart) {
    const p = s.plots[i]!;
    assert.ok(p.gx >= 0 && !blockiert(rules, p.gx, p.gy, 2, 2), `${rules.plots[i]!.id} steht frei`);
  }
  for (const i of felder) {
    assert.deepEqual(rules.plots[i]!.levels[0]!.recipes, rules.plots[0]!.levels[0]!.recipes);
    assert.ok(rules.wetter!.plaetze.includes(i), 'Regen wirkt auf jedes Feld');
  }
  assert.deepEqual(validateRuleset(rules), []);
  assert.equal(LATEST_RULESET_VERSION, 51);
});

test('der Umzug nach 51 holt Bauten aus dem Wegrand und vom Ufer', () => {
  let s = initialState(alt);
  s = { ...s, items: s.items.map((n, i) => (i === alt.currency ? 100_000 : n)), xp: 100_000 };
  const MILL = alt.plots.findIndex((p) => p.id === 'mill');
  s = simulate(s, { seq: 1, tick: 0, type: 'BUY', plot: MILL }, alt);
  s = simulate(s, { seq: 2, tick: 0, type: 'PLACE', plot: MILL, gx: 2, gy: 0 }, alt);
  const neu = migrateState(s, 50, 51);
  const m = neu.plots[MILL]!;
  assert.equal(m.level, 1);
  assert.ok(m.gx >= 0 && !blockiert(rules, m.gx, m.gy, 2, 2), `Mühle steht jetzt bei ${m.gx},${m.gy}`);
  // Der Startplatz von Feld 4 liegt nicht am Ufer.
  const F4 = rules.plots.findIndex((p) => p.id === 'field-4');
  const st = startPlatz(rules, F4);
  assert.equal(inSperre(rules, st.gx, st.gy, 2, 2), false);
});

test('eine Sperrzone ausserhalb des Rasters faellt auf', () => {
  const kaputt = { ...rules, grid: { ...rules.grid!, sperren: [{ id: 'x', gx: 100, gy: 0, w: 10, h: 3 }] } };
  assert.ok(validateRuleset(kaputt).some((x) => /Sperrzone/.test(x)));
});

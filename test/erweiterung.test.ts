import test from 'node:test';
import assert from 'node:assert/strict';
import { getRuleset, blockiert, LATEST_RULESET_VERSION } from '../src/sim/rules.ts';
import { initialState } from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';
import { farmView } from '../src/client/view.ts';

const V22 = getRuleset(22);

function idOf(id: string): number {
  const i = V22.items.findIndex((x) => x.id === id);
  assert.notEqual(i, -1, `${id} fehlt im Katalog`);
  return i;
}

const MAP = idOf('map');
const MALLET = idOf('mallet');
const STAKE = idOf('stake');

function reich(level: number) {
  const base = initialState(V22);
  const items = base.items.map(() => 0);
  items[MAP] = 20;
  items[MALLET] = 20;
  items[STAKE] = 20;
  const xp = V22.levelThresholds[level - 2] ?? 0;
  return { ...base, items, xp };
}

test('das Raster ist nach rechts verdreifacht', () => {
  assert.equal(V22.grid?.w, 39);
  assert.equal(V22.grid?.h, 13);
  assert.equal(V22.expansions?.length, 6);
});

test('das rechte Zweidrittel ist gesperrt, bis man es freischaltet', () => {
  const w1 = V22.expansions!.find((e) => e.id === 'w1')!;
  assert.ok(blockiert(V22, w1.gx, w1.gy, 1, 1, [], []), 'gesperrtes Feld muss blockieren');
  assert.ok(!blockiert(V22, w1.gx, w1.gy, 1, 1, [], ['w1']), 'freigeschaltet nicht mehr');
  assert.ok(!blockiert(V22, 1, 8, 2, 2, [], []), 'linkes Drittel ist frei');
});

test('Freischalten kostet Landkarten, Bauhämmer und Steckpfähle', () => {
  const w1 = V22.expansions!.find((e) => e.id === 'w1')!;
  const s = reich(w1.minLevel);
  const nach = simulate(s, { seq: 1, tick: 0, type: 'EXPAND', id: 'w1' }, V22);
  assert.ok(nach.expandiert.includes('w1'));
  for (const c of w1.cost) {
    assert.equal(nach.items[c.item], s.items[c.item]! - c.amount, 'Kosten müssen abgezogen werden');
  }
});

test('ohne die nötige Stufe geht kein Freischalten', () => {
  const w3 = V22.expansions!.find((e) => e.id === 'w3')!;
  const s = { ...reich(w3.minLevel), xp: 0 };
  assert.throws(
    () => simulate(s, { seq: 1, tick: 0, type: 'EXPAND', id: 'w3' }, V22),
    { code: 'PLAYER_LEVEL_TOO_LOW' },
  );
});

test('ohne die Gegenstände geht kein Freischalten', () => {
  const w1 = V22.expansions!.find((e) => e.id === 'w1')!;
  const base = initialState(V22);
  const arm = { ...base, items: base.items.map(() => 0), xp: V22.levelThresholds[w1.minLevel - 2] ?? 0 };
  assert.throws(
    () => simulate(arm, { seq: 1, tick: 0, type: 'EXPAND', id: 'w1' }, V22),
    { code: 'NOT_ENOUGH_ITEMS' },
  );
});

test('dasselbe Feld lässt sich nicht zweimal freischalten', () => {
  const s = reich(12);
  const eins = simulate(s, { seq: 1, tick: 0, type: 'EXPAND', id: 'w1' }, V22);
  assert.throws(
    () => simulate(eins, { seq: 2, tick: 0, type: 'EXPAND', id: 'w1' }, V22),
    { code: 'ALREADY_EXPANDED' },
  );
});

test('ein Platz lässt sich erst nach dem Freischalten ins rechte Feld stellen', () => {
  const w1 = V22.expansions!.find((e) => e.id === 'w1')!;
  const s = reich(12);
  const feld = V22.plots.findIndex((p) => p.id === 'field-4');
  const gestellt = simulate(s, { seq: 1, tick: 0, type: 'EXPAND', id: 'w1' }, V22);
  const platz = { ...gestellt };
  const plots = platz.plots.slice();
  plots[feld] = { ...plots[feld]!, level: 1, slots: [] };
  platz.plots = plots;

  assert.throws(
    () => {
      const s2 = { ...s, plots };
      return simulate(s2, { seq: 5, tick: 0, type: 'PLACE', plot: feld, gx: w1.gx, gy: w1.gy }, V22);
    },
    { code: 'CELL_TAKEN' },
    'ohne Freischalten muss das rechte Feld gesperrt sein',
  );

  const ok = simulate(platz, { seq: 5, tick: 0, type: 'PLACE', plot: feld, gx: w1.gx, gy: w1.gy }, V22);
  assert.equal(ok.plots[feld]!.gx, w1.gx);
});

test('das Ansichtsmodell meldet, was freigeschaltet werden kann', () => {
  const s = reich(5);
  const v = farmView(s, V22, false);
  assert.equal(v.expansions.length, 6);
  const w1 = v.expansions.find((e) => e.id === 'w1')!;
  assert.equal(w1.unlocked, false);
  assert.equal(w1.reachedLevel, true);
  assert.equal(w1.affordable, true);
  const w6 = v.expansions.find((e) => e.id === 'w6')!;
  assert.equal(w6.reachedLevel, false);
});

test('Landkarte, Bauhammer und Steckpfahl fallen aus Truhen', () => {
  const namen = new Set(V22.items.map((i) => i.id));
  assert.ok(namen.has('map') && namen.has('mallet') && namen.has('stake'));
  const drops = new Set((V22.chestKinds ?? []).flatMap((k) => k.drops.map((d) => d.item)));
  assert.ok(drops.has(MAP) && drops.has(MALLET) && drops.has(STAKE), 'müssen als Drop vorkommen');
});

test('ältere Regelwerke kennen keine Erweiterungen', () => {
  const v21 = getRuleset(21);
  assert.equal(v21.expansions, undefined);
  assert.equal(v21.grid?.w, 13);
  assert.equal(LATEST_RULESET_VERSION, 22);
});

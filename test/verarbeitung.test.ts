import test from 'node:test';
import assert from 'node:assert/strict';
import { getRuleset } from '../src/sim/rules.ts';
import { initialState } from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';

const V = getRuleset(29);
const item = (id: string) => V.items.findIndex((i) => i.id === id);
const recIdx = (id: string) => V.recipes.findIndex((r) => r.id === id);

test('v29: Mehl, Brot, Apfelkuchen und Spiegeleier sind verdrahtet', () => {
  for (const id of ['flour', 'bread', 'apple-pie', 'fried-egg']) {
    assert.ok(item(id) >= 0, `Ware ${id} fehlt`);
    assert.ok(recIdx(id) >= 0, `Rezept ${id} fehlt`);
  }

  const mill = V.plots.find((p) => p.id === 'mill')!;
  assert.ok(
    mill.levels.some((l) => l.recipes.includes(recIdx('flour'))),
    'die Mühle mahlt Mehl',
  );

  const oven = V.plots.find((p) => p.id === 'oven')!;
  assert.ok(oven, 'Backofen existiert');
  assert.ok(
    oven.levels[0]!.recipes.includes(recIdx('bread')) &&
      oven.levels[0]!.recipes.includes(recIdx('apple-pie')),
    'der Backofen macht Brot und Apfelkuchen',
  );

  const grill = V.plots.find((p) => p.id === 'grill')!;
  assert.ok(grill && grill.levels[0]!.recipes.includes(recIdx('fried-egg')), 'der Grill macht Spiegeleier');

  const pie = V.recipes[recIdx('apple-pie')]!;
  const zutaten = new Set(pie.inputs.map((x) => x.item));
  assert.ok(
    zutaten.has(item('flour')) && zutaten.has(item('milk')) && zutaten.has(item('apple')),
    'Apfelkuchen = Mehl + Milch + Apfel',
  );
});

test('v30: alle neuen Waren tauchen in Aufträgen auf', () => {
  const V30 = getRuleset(30);
  const gefragt = new Set<number>();
  for (const t of V30.requestTemplates) for (const w of t.wants) gefragt.add(w.item);
  for (const id of ['apple', 'flour', 'bread', 'apple-pie', 'fried-egg', 'coal', 'iron-ore', 'gold-ore', 'iron-bar', 'gold-bar', 'cow-feed']) {
    const i = V30.items.findIndex((x) => x.id === id);
    assert.ok(gefragt.has(i), `kein Auftrag verlangt ${id}`);
  }
});

test('die Mühle mahlt Weizen zu Mehl (Start → warten → Ernte)', () => {
  const MILL = V.plots.findIndex((p) => p.id === 'mill');
  const WHEAT = item('wheat');
  const FLOUR = item('flour');
  const R_FLOUR = recIdx('flour');

  let s = initialState(V);
  const items = s.items.map((n, i) => (i === V.currency ? 100_000 : i === WHEAT ? 40 : n));
  s = { ...s, xp: 10_000, items };

  // Mühle bauen …
  s = simulate(s, { seq: 1, tick: 0, type: 'BUY', plot: MILL }, V);

  // … und auf eine freie Rasterzelle stellen.
  const g = V.grid!;
  let gesetzt = false;
  for (let gy = 0; gy <= g.h - 2 && !gesetzt; gy++) {
    for (let gx = 0; gx <= g.w - 2 && !gesetzt; gx++) {
      try {
        s = simulate(s, { seq: 2, tick: 0, type: 'PLACE', plot: MILL, gx, gy }, V);
        gesetzt = true;
      } catch {
        /* belegt */
      }
    }
  }
  assert.ok(gesetzt, 'Mühle hingestellt');

  s = simulate(s, { seq: 3, tick: 0, type: 'START', plot: MILL, slot: 0, recipe: R_FLOUR }, V);
  const dauer = V.recipes[R_FLOUR]!.durationTicks;
  s = simulate(s, { seq: 4, tick: dauer, type: 'COLLECT', plot: MILL, slot: 0 }, V);
  assert.ok(s.items[FLOUR]! >= 1, 'Mehl im Lager');
});

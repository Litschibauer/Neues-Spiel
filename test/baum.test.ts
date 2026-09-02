import test from 'node:test';
import assert from 'node:assert/strict';
import { getRuleset, baumStufe } from '../src/sim/rules.ts';
import { initialState } from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';
import { farmView } from '../src/client/view.ts';

const V = getRuleset(26);
const BAUM = V.plots.findIndex((p) => p.id === 'apple-tree');
const APFEL = V.items.findIndex((i) => i.id === 'apple');
const SAEGE = V.items.findIndex((i) => i.id === 'saw');
const def = V.plots[BAUM]!.baum!;

// Ein Hof mit genug Erfahrung (Stufe 8), Gold und einer Säge.
function startHof() {
  const base = initialState(V);
  const items = base.items.map(() => 0);
  items[V.currency] = 5000;
  items[SAEGE] = 1;
  return { ...base, xp: 3000, items };
}

// Eine freie 2×2-Zelle fürs Pflanzen suchen.
function freieZelle(s: ReturnType<typeof startHof>) {
  for (let gy = 0; gy <= V.grid!.h - 2; gy++) {
    for (let gx = 0; gx <= V.grid!.w - 2; gx++) {
      try {
        simulate(s, { seq: 99, tick: 0, type: 'PLACE', plot: BAUM, gx, gy }, V);
        return { gx, gy };
      } catch {
        /* belegt — nächste Zelle */
      }
    }
  }
  throw new Error('keine freie Zelle');
}

test('der Apfelbaum steht ab v26 im Baumenü und ist ein normales Bauwerk', () => {
  assert.ok(BAUM >= 0 && APFEL >= 0);
  assert.equal(V.plots[BAUM]!.fixed, undefined, 'kein festes Bauwerk');
  const s = startHof();
  const v = farmView(s, V, false);
  assert.ok(
    v.buildable.some((b) => b.plot === BAUM && b.unlocked && b.affordable),
    'ab Stufe 8 mit Gold baubar',
  );
});

test('Setzling → wächst → reif → Ernte × N → verwelkt → gefällt', () => {
  let s = startHof();

  // Kaufen: wird zum Setzling, aber noch nicht gepflanzt (kein Rasterplatz).
  s = simulate(s, { seq: 1, tick: 0, type: 'BUY', plot: BAUM }, V);
  assert.equal(s.plots[BAUM]!.level, 1);
  assert.ok(s.plots[BAUM]!.baum, 'hat einen Baum-Zustand');
  assert.equal(s.plots[BAUM]!.baum!.geerntet, 0);

  // Pflanzen: die Setzlingsuhr startet.
  const zelle = freieZelle(s);
  s = simulate(s, { seq: 2, tick: 0, type: 'PLACE', plot: BAUM, gx: zelle.gx, gy: zelle.gy }, V);
  assert.equal(s.plots[BAUM]!.baum!.reifSeit, def.setzlingTicks, 'reif erst nach Setzlingszeit');
  assert.equal(
    baumStufe(def, s.plots[BAUM]!.baum!.reifSeit, s.plots[BAUM]!.baum!.geerntet, 0),
    'setzling',
  );

  // Als Setzling lässt sich nichts ernten.
  assert.throws(
    () => simulate(s, { seq: 3, tick: 10, type: 'HARVEST_TREE', plot: BAUM }, V),
    { code: 'TREE_NOT_RIPE' },
  );

  // Sechs Ernten im Abstand der Reifezeit.
  let apfelZuvor = 0;
  for (let n = 1; n <= def.ernten; n++) {
    const reifBei = s.plots[BAUM]!.baum!.reifSeit + def.reifeTicks;
    // Kurz vor der Reife: noch nichts zu holen.
    assert.throws(
      () => simulate(s, { seq: 100 + n, tick: reifBei - 1, type: 'HARVEST_TREE', plot: BAUM }, V),
      { code: 'TREE_NOT_RIPE' },
      `Ernte ${n}: eine Sekunde zu früh`,
    );
    apfelZuvor = s.items[APFEL]!;
    s = simulate(s, { seq: 200 + n, tick: reifBei, type: 'HARVEST_TREE', plot: BAUM }, V);
    assert.equal(s.items[APFEL]! - apfelZuvor, def.ertrag.amount, `Ernte ${n}: Äpfel gutgeschrieben`);
    assert.equal(s.plots[BAUM]!.baum!.geerntet, n);
  }

  assert.equal(s.items[APFEL], def.ernten * def.ertrag.amount, 'alle Äpfel im Lager');

  const tick = s.plots[BAUM]!.baum!.reifSeit + def.reifeTicks + 100;
  assert.equal(
    baumStufe(def, s.plots[BAUM]!.baum!.reifSeit, s.plots[BAUM]!.baum!.geerntet, tick),
    'verwelkt',
    'nach der letzten Ernte verwelkt der Baum',
  );

  // Verwelkt: keine Ernte mehr.
  assert.throws(
    () => simulate(s, { seq: 300, tick, type: 'HARVEST_TREE', plot: BAUM }, V),
    { code: 'TREE_NOT_RIPE' },
  );

  // Fällen braucht eine Säge.
  const ohneSaege = { ...s, items: s.items.map((n, i) => (i === SAEGE ? 0 : n)) };
  assert.throws(
    () => simulate(ohneSaege, { seq: 301, tick, type: 'FELL_TREE', plot: BAUM }, V),
    { code: 'NEEDS_TOOL' },
  );

  // Mit Säge: Baum weg, Platz frei, Säge verbraucht.
  const xpVorher = s.xp;
  s = simulate(s, { seq: 302, tick, type: 'FELL_TREE', plot: BAUM }, V);
  assert.equal(s.plots[BAUM]!.level, 0, 'Platz zurück auf Stufe 0');
  assert.equal(s.plots[BAUM]!.gx, -1, 'vom Raster genommen');
  assert.equal(s.plots[BAUM]!.baum, undefined, 'kein Baum-Zustand mehr');
  assert.equal(s.items[SAEGE], 0, 'Säge verbraucht');
  assert.equal(s.xp, xpVorher + def.faellenXp, 'Fäll-XP gutgeschrieben');
});

test('ab v28 gibt es fünf Apfelbaum-Plätze — fünf Bäume gleichzeitig', () => {
  const V28 = getRuleset(28);
  const baeume = V28.plots.filter((p) => p.id.indexOf('apple-tree') === 0);
  assert.equal(baeume.length, 5, 'fünf Apfelbaum-Plätze');
  assert.ok(
    baeume.every((p) => p.baum && p.baum.ernten === 6 && !p.fixed),
    'alle gleich konfiguriert und frei platzierbar',
  );
  // Frischer Hof: alle fünf ungebaut (gx -1), also im Baumenü verfügbar.
  const s = initialState(V28);
  assert.ok(
    baeume.every((_, k) => {
      const idx = V28.plots.findIndex((p) => p.id === baeume[k]!.id);
      return s.plots[idx]!.gx === -1;
    }),
    'alle fünf sind zu Beginn ungebaut',
  );
});

test('einen Baum, den es nicht gibt, kann man nicht ernten oder fällen', () => {
  const s = startHof();
  assert.throws(
    () => simulate(s, { seq: 1, tick: 0, type: 'HARVEST_TREE', plot: BAUM }, V),
    { code: 'NOT_A_TREE' },
    'ungepflanzt: kein Baum-Zustand',
  );
});

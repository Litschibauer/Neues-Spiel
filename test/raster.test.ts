import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '../src/client/client.ts';
import { RULESETS, getRuleset, sizeOf, validateRuleset } from '../src/sim/rules.ts';
import { initialState } from '../src/sim/state.ts';
import { farmView } from '../src/client/view.ts';
import { assertInvariants, migrateState } from '../src/sim/migrate.ts';
import type { State } from '../src/sim/state.ts';

const T0 = 1_700_000_000_000;
const rules = getRuleset(10);
const V9 = getRuleset(9);
const GOLD = 0;

const MILL = rules.plots.findIndex((p) => p.id === 'mill');
const FIELD1 = rules.plots.findIndex((p) => p.id === 'field-1');
const PASTURE = rules.plots.findIndex((p) => p.id === 'pasture-1');

function hof(patch: Partial<State> = {}): State {
  const base = initialState(rules);
  const items = base.items.slice();
  items[GOLD] = 50_000;
  return { ...base, items, xp: rules.levelThresholds[10]!, ...patch };
}

function client(state = hof()): Client {
  return new Client({ state, seq: 0, serverTs: T0, rulesetVersion: 10 });
}

test('am Anfang stehen nur die Startfelder auf dem Hof', () => {
  const v = farmView(initialState(rules), rules);
  const platziert = v.plots.filter((p) => p.gx >= 0);

  assert.equal(platziert.length, 3, 'es soll mit drei Feldern losgehen');
  assert.ok(
    platziert.every((p) => p.id.startsWith('field-')),
    'da steht etwas anderes als Felder',
  );
  assert.equal(v.buildable.length, rules.plots.length - 3, 'der Rest muss gebaut werden');
});

test('gekauft heißt noch nicht hingestellt', () => {
  const c = client();
  assert.equal(c.buy(MILL).ok, true);
  assert.equal(c.state.plots[MILL]!.gx, -1);

  const ohneOrt = c.start(MILL, 1, 0);
  assert.equal(ohneOrt.ok, false, 'eine Mühle im Nirgendwo mahlt');
  if (!ohneOrt.ok) assert.equal(ohneOrt.code, 'NOT_PLACED');

  assert.equal(c.place(MILL, 0, 0).ok, true);
  assert.equal(c.state.plots[MILL]!.gx, 0);
});

test('zwei Gebäude passen nicht auf dasselbe Feld', () => {
  const c = client();
  c.buy(MILL);
  assert.equal(c.place(MILL, 2, 2).ok, true);

  c.buy(PASTURE);
  const drauf = c.place(PASTURE, 3, 2);
  assert.equal(drauf.ok, false, 'die Weide steht in der Mühle');
  if (!drauf.ok) assert.equal(drauf.code, 'CELL_TAKEN');

  assert.equal(c.place(PASTURE, 4, 2).ok, true, 'daneben muss gehen');
});

test('über den Rand geht nichts', () => {
  const c = client();
  const raster = rules.grid!;
  const groesse = sizeOf(rules, FIELD1);

  const raus = c.place(FIELD1, raster.w - groesse.w + 1, 0);
  assert.equal(raus.ok, false);
  if (!raus.ok) assert.equal(raus.code, 'OFF_GRID');

  assert.equal(c.place(FIELD1, raster.w - groesse.w, raster.h - groesse.h).ok, true);
});

test('verschieben ist dasselbe Command und behält alles', () => {
  const c = client();
  assert.equal(c.start(FIELD1, 0, 0).ok, true);
  const gestartet = c.state.plots[FIELD1]!.slots[0]!.startedAt;

  assert.equal(c.place(FIELD1, 5, 1).ok, true);
  assert.equal(c.state.plots[FIELD1]!.gx, 5);
  assert.equal(c.state.plots[FIELD1]!.gy, 1);
  assert.equal(
    c.state.plots[FIELD1]!.slots[0]!.startedAt,
    gestartet,
    'die laufende Saat wurde beim Umzug zurückgesetzt',
  );
});

test('ein Ausbau lässt das Gebäude stehen, wo es steht', () => {
  const c = client();
  const coop = rules.plots.findIndex((p) => p.id === 'coop-1');
  c.buy(coop);
  c.place(coop, 1, 1);
  assert.equal(c.buy(coop).ok, true, 'zweites Huhn');
  assert.equal(c.state.plots[coop]!.gx, 1);
  assert.equal(c.state.plots[coop]!.gy, 1);
  assert.equal(c.state.plots[coop]!.slots.length, 2);
});

test('ein Hof aus v9 bekommt seine Stellen und keine doppelten', () => {
  const alt = initialState(V9);
  const neu = migrateState({ ...alt, tick: 900 }, 9, 10);
  assertInvariants(neu, rules);

  const platziert = neu.plots.filter((p) => p.gx >= 0);
  assert.equal(platziert.length, 3);

  const belegt = new Set<string>();
  neu.plots.forEach((p, i) => {
    if (p.gx < 0) return;
    const groesse = sizeOf(rules, i);
    for (let y = p.gy; y < p.gy + groesse.h; y++) {
      for (let x = p.gx; x < p.gx + groesse.w; x++) {
        const feld = `${x},${y}`;
        assert.ok(!belegt.has(feld), `Feld ${feld} doppelt belegt`);
        belegt.add(feld);
      }
    }
  });
});

test('ein voll gebauter Hof aus v9 findet für jedes Gebäude Platz', () => {
  const alt = initialState(V9);
  const plots = alt.plots.map((p, i) => ({
    ...p,
    level: Math.max(1, p.level),
    slots: p.slots.length > 0 ? p.slots : [{ recipe: -1, startedAt: 0 }],
    gx: -1,
    gy: -1,
  }));

  const neu = migrateState({ ...alt, plots }, 9, 10);
  assertInvariants(neu, rules);
  assert.equal(neu.plots.filter((p) => p.gx >= 0).length, rules.plots.length);
});

test('das Regelwerk v10 ist in sich stimmig', () => {
  assert.deepEqual(validateRuleset(rules), []);
  assert.ok(rules.grid, 'v10 ohne Raster');

  const flaeche = rules.plots.reduce((sum, _, i) => {
    const g = sizeOf(rules, i);
    return sum + g.w * g.h;
  }, 0);
  assert.ok(
    flaeche <= rules.grid!.w * rules.grid!.h,
    `alle Gebäude brauchen ${flaeche} Felder, das Raster hat ${rules.grid!.w * rules.grid!.h}`,
  );
  assert.ok(
    flaeche * 1.5 <= rules.grid!.w * rules.grid!.h,
    'das Raster ist zu eng, um frei zu stellen',
  );
});

test('ein Regelwerk ohne Raster bleibt zeichenbar — jeder Platz hat einen Ort', () => {
  for (const version of [...RULESETS.keys()]) {
    const r = getRuleset(version);
    if (r.grid) continue;

    const v = farmView(initialState(r), r);
    assert.equal(v.grid, null, `v${version}: Raster gemeldet, wo keins ist`);
    assert.ok(
      v.plots.every((p) => p.gx < 0),
      `v${version}: Stellen ohne Raster`,
    );
    assert.ok(
      r.plots.every((p) => p.place),
      `v${version}: ohne Raster und ohne place wäre der Hof unsichtbar`,
    );
  }
});

test('ein Hof auf einem alten Regelwerk verliert seine Gebäude nicht', () => {
  const v9 = farmView(initialState(V9), V9);
  const gebaut = v9.plots.filter((p) => p.level > 0);
  assert.equal(gebaut.length, 3, 'v9 startet nicht mit drei Feldern');
  assert.ok(
    gebaut.every((p) => V9.plots[p.index]!.place),
    'ein gebauter Platz ohne Ort ist auf dem Hof unsichtbar',
  );
});

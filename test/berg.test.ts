import test from 'node:test';
import assert from 'node:assert/strict';
import { getRuleset, obstacleLocked } from '../src/sim/rules.ts';
import { initialState } from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';
import { farmView } from '../src/client/view.ts';

const V = getRuleset(25);

test('nur die Mine ist fest; die Schmiede baut man wie einen Stall', () => {
  const mine = V.plots.findIndex((p) => p.id === 'mine');
  const forge = V.plots.findIndex((p) => p.id === 'forge');
  assert.equal(V.plots[mine]!.fixed, true);
  assert.notEqual(V.plots[forge]!.fixed, true, 'die Schmiede ist kein festes Bauwerk mehr');

  const s = initialState(V);
  assert.ok(s.plots[mine]!.gx >= 0, 'die Mine ist von Anfang an platziert');
  assert.equal(s.plots[mine]!.level, 0, 'aber noch nicht gebaut');
  assert.equal(s.plots[forge]!.gx, -1, 'die Schmiede wird erst über das Baumenü gesetzt');
});

test('freigeschaltetes Land trägt Hindernisse, gesperrtes verbirgt sie', () => {
  const w1 = V.expansions!.find((e) => e.id === 'w1')!;
  const drin = (V.obstacles ?? []).findIndex(
    (h) => h.gx >= w1.gx && h.gx < w1.gx + w1.w && h.gy >= w1.gy && h.gy < w1.gy + w1.h,
  );
  assert.notEqual(drin, -1, 'in w1 wächst etwas');

  assert.equal(obstacleLocked(V, drin, []), true, 'solange gesperrt: verborgen');
  assert.equal(obstacleLocked(V, drin, ['w1']), false, 'nach dem Freischalten: sichtbar');
});

test('ein Hindernis im gesperrten Land lässt sich nicht wegräumen', () => {
  const w1 = V.expansions!.find((e) => e.id === 'w1')!;
  const drin = (V.obstacles ?? []).findIndex(
    (h) => h.gx >= w1.gx && h.gx < w1.gx + w1.w && h.gy >= w1.gy && h.gy < w1.gy + w1.h && h.kind === 'tree',
  );
  const saw = V.items.findIndex((i) => i.id === 'saw');
  const base = initialState(V);
  const items = base.items.map(() => 0);
  items[saw] = 5;
  const s = { ...base, items };

  assert.throws(
    () => simulate(s, { seq: 1, tick: 0, type: 'CLEAR_OBSTACLE', index: drin }, V),
    { code: 'CELL_TAKEN' },
    'gesperrtes Land: kein Wegräumen',
  );

  const frei = { ...s, expandiert: ['w1'] };
  const nach = simulate(frei, { seq: 1, tick: 0, type: 'CLEAR_OBSTACLE', index: drin }, V);
  assert.ok(nach.clearedObstacles.includes(drin), 'freigeschaltet: geht');
});

test('das Ansichtsmodell blendet Hindernisse in gesperrtem Land aus', () => {
  const s = initialState(V);
  const w1 = V.expansions!.find((e) => e.id === 'w1')!;
  const sichtbarInW1 = (idx: readonly { gx: number; gy: number }[]) =>
    idx.some((o) => o.gx >= w1.gx && o.gx < w1.gx + w1.w && o.gy >= w1.gy && o.gy < w1.gy + w1.h);

  const gesperrt = farmView(s, V, false);
  assert.equal(sichtbarInW1(gesperrt.obstacles), false, 'gesperrt: keine Hindernisse in w1 sichtbar');

  const auf = farmView({ ...s, expandiert: ['w1'] }, V, false);
  assert.equal(sichtbarInW1(auf.obstacles), true, 'freigeschaltet: jetzt sichtbar');
});

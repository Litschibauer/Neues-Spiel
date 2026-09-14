import test from 'node:test';
import assert from 'node:assert/strict';
import { getRuleset, blockiert, LATEST_RULESET_VERSION } from '../src/sim/rules.ts';
import { initialState } from '../src/sim/state.ts';
import { migrateState } from '../src/sim/migrate.ts';

// Regelwerk 54: Die beiden Felder rechts vom Starthof (w1 oben, w4 unten)
// gehören jedem Hof von Anfang an, mit etwas weniger Unkraut. Die Hindernis-
// liste bleibt gleich — Indizes stecken in jedem Stand —, nur die Startliste
// der geräumten Hindernisse ist gefüllt.
const V53 = getRuleset(53);
const V54 = getRuleset(54);

test('w1 und w4 sind in 54 keine Erweiterungen mehr, der Rest bleibt', () => {
  const alt = (V53.expansions ?? []).map((e) => e.id);
  const neu = (V54.expansions ?? []).map((e) => e.id);
  assert.ok(alt.includes('w1') && alt.includes('w4'));
  assert.ok(!neu.includes('w1') && !neu.includes('w4'));
  assert.deepEqual(neu, alt.filter((id) => id !== 'w1' && id !== 'w4'));
  assert.equal(V54.obstacles?.length, V53.obstacles?.length, 'kein Hindernis rutscht');
});

test('ein neuer Hof beginnt mit freiem Land in w1 und w4 und weniger Unkraut dort', () => {
  const s = initialState(V54);
  assert.deepEqual(s.clearedObstacles, V54.vorgeraeumt);
  const w1 = V53.expansions!.find((e) => e.id === 'w1')!;
  const w4 = V53.expansions!.find((e) => e.id === 'w4')!;
  // Jedes vorgeräumte Hindernis liegt in w1 oder w4 — nirgends sonst.
  for (const i of V54.vorgeraeumt ?? []) {
    const h = V54.obstacles![i]!;
    const drin = (e: typeof w1) => h.gx >= e.gx && h.gx < e.gx + e.w && h.gy >= e.gy && h.gy < e.gy + e.h;
    assert.ok(drin(w1) || drin(w4), `Hindernis ${i} liegt außerhalb von w1/w4`);
  }
  // Eine Zelle, die in 53 gesperrt war, ist in 54 ohne Freischaltung frei.
  assert.ok(blockiert(V53, 14, 4, 1, 1, [], []), 'in 53 gesperrt');
  assert.ok(!blockiert(V54, 14, 4, 1, 1, s.clearedObstacles, s.expandiert), 'in 54 frei');
  // Das vorgeräumte Hindernis 23 (17,4) blockiert nicht mehr, das gebliebene 22 (16,4) schon.
  assert.ok(!blockiert(V54, 17, 4, 1, 1, s.clearedObstacles, s.expandiert));
  assert.ok(blockiert(V54, 16, 4, 1, 1, s.clearedObstacles, s.expandiert));
  // w2 bleibt gesperrt.
  assert.ok(blockiert(V54, 23, 4, 1, 1, s.clearedObstacles, s.expandiert));
});

test('die Wanderung 53→54 ergänzt das Vorgeräumte und lässt eigene Räumungen stehen', () => {
  const alt = { ...initialState(V53), clearedObstacles: [3, 23], expandiert: ['w1'] };
  const neu = migrateState(alt, 53, 54);
  assert.deepEqual([...neu.clearedObstacles].sort((a, b) => a - b), [3, 23, 25, 27, 28, 56, 57, 58, 60, 62]);
  assert.ok(!neu.expandiert.includes('w1'), 'das gekaufte w1 ist jetzt Starthof, der Eintrag geht');
  assert.ok(!blockiert(V54, 14, 8, 1, 1, neu.clearedObstacles, neu.expandiert), 'w4 ist frei, ohne je gekauft zu sein');
});

test('die Tageszettel verlangen in 54 deutlich mehr als in 53, bei gleicher Belohnung', () => {
  const alt = new Map((V53.tagesaufgaben ?? []).map((a) => [a.id, a]));
  let mehr = 0;
  for (const a of V54.tagesaufgaben ?? []) {
    const v = alt.get(a.id)!;
    assert.ok(v, `Zettel ${a.id} ist neu`);
    assert.ok(a.menge >= v.menge, `${a.id} verlangt weniger`);
    if (a.menge > v.menge) mehr += 1;
    assert.equal(a.gold, v.gold);
    assert.equal(a.xp, v.xp);
    assert.equal(a.art, v.art);
    if (a.menge > v.menge) assert.notEqual(a.label, v.label, `${a.id}: Menge neu, Text alt`);
  }
  assert.ok(mehr >= 10, `nur ${mehr} Zettel wurden länger`);
  assert.ok(LATEST_RULESET_VERSION >= 54);
});

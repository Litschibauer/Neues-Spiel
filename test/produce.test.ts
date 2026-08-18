import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advancePassives,
  advancePassivesNaive,
  advancePassivesReference,
} from '../src/sim/produce.ts';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('ein Produzent: geschlossene Form == Grundwahrheit (20.000 Zufallsfälle)', () => {
  const rnd = mulberry32(0xc0ffee);
  let cappedCases = 0;

  for (let i = 0; i < 20_000; i++) {
    const interval = 1 + Math.floor(rnd() * 1000);
    const elapsed = Math.floor(rnd() * 20_000);
    const progress = Math.floor(rnd() * interval);
    const space = Math.floor(rnd() * 50);

    const fast = advancePassives(elapsed, [progress], space, [interval]);
    const truth = advancePassivesReference(elapsed, [progress], space, [interval]);

    assert.deepEqual(
      fast,
      truth,
      `Divergenz bei elapsed=${elapsed} progress=${progress} space=${space} interval=${interval}`,
    );

    if (Math.floor((progress + elapsed) / interval) > space) cappedCases++;
  }

  assert.ok(cappedCases > 1000, `zu wenige Lager-voll-Fälle im Fuzz: ${cappedCases}`);
});

test('mehrere Produzenten am selben Deckel: geschlossene Form == Grundwahrheit', () => {
  const rnd = mulberry32(0xbeef);
  let cappedCases = 0;
  let raceCases = 0;

  for (let i = 0; i < 20_000; i++) {
    const n = 1 + Math.floor(rnd() * 4);
    const intervals: number[] = [];
    const progress: number[] = [];
    for (let k = 0; k < n; k++) {
      const interval = 1 + Math.floor(rnd() * 40);
      intervals.push(interval);
      progress.push(Math.floor(rnd() * interval));
    }
    const elapsed = Math.floor(rnd() * 5_000);
    const space = Math.floor(rnd() * 60);

    const fast = advancePassives(elapsed, progress, space, intervals);
    const truth = advancePassivesReference(elapsed, progress, space, intervals);

    assert.deepEqual(
      fast,
      truth,
      `Divergenz bei elapsed=${elapsed} progress=[${progress}] space=${space} intervals=[${intervals}]`,
    );

    const wanted = intervals.reduce(
      (sum, t, k) => sum + Math.floor((progress[k]! + elapsed) / t),
      0,
    );
    if (wanted > space) cappedCases++;
    if (wanted > space && n > 1) raceCases++;
  }

  assert.ok(cappedCases > 1000, `zu wenige Lager-voll-Fälle: ${cappedCases}`);
  assert.ok(raceCases > 800, `zu wenige Rennen um den letzten Platz: ${raceCases}`);
});

test('Grenzfälle', () => {
  assert.deepEqual(advancePassives(9999, [42], 0, [600]), { produced: [0], progress: [42] });

  assert.deepEqual(advancePassives(0, [42], 10, [600]), { produced: [0], progress: [42] });

  assert.deepEqual(advancePassives(9999, [], 10, []), { produced: [], progress: [] });

  assert.deepEqual(advancePassives(1200, [0], 10, [600]), { produced: [2], progress: [0] });

  assert.deepEqual(advancePassives(7250, [0], 2, [600]), { produced: [2], progress: [0] });
});

test('Regression: Gleichstand friert den Fortschritt ein', () => {
  const fast = advancePassives(7604, [313], 8, [932]);
  assert.deepEqual(fast, advancePassivesReference(7604, [313], 8, [932]));
  assert.deepEqual(fast, { produced: [8], progress: [0] });
});

test('Regression: der letzte Platz geht an den, der zeitlich zuerst fertig ist', () => {
  const fast = advancePassives(100, [0, 0], 1, [90, 10]);
  assert.deepEqual(fast, advancePassivesReference(100, [0, 0], 1, [90, 10]));
  assert.deepEqual(fast.produced, [0, 1]);

  assert.equal(fast.progress[0], 10);
});

test('Gleichstand im selben Tick: die Reihenfolge im Regelwerk entscheidet', () => {
  const fast = advancePassives(10, [0, 0], 1, [10, 10]);
  assert.deepEqual(fast, advancePassivesReference(10, [0, 0], 1, [10, 10]));
  assert.deepEqual(fast.produced, [1, 0]);
});

test('der naive Bug divergiert nachweislich — der Test hat Zähne', () => {
  const fast = advancePassives(7250, [0], 2, [600]);
  const naive = advancePassivesNaive(7250, [0], 2, [600]);
  const truth = advancePassivesReference(7250, [0], 2, [600]);

  assert.deepEqual(fast, truth);
  assert.notDeepEqual(naive, truth);
  assert.equal(naive.progress[0], 50);

  const rnd = mulberry32(7);
  let divergences = 0;
  for (let i = 0; i < 5_000; i++) {
    const interval = 1 + Math.floor(rnd() * 1000);
    const elapsed = Math.floor(rnd() * 20_000);
    const progress = Math.floor(rnd() * interval);
    const space = Math.floor(rnd() * 20);
    const a = advancePassivesNaive(elapsed, [progress], space, [interval]);
    const b = advancePassivesReference(elapsed, [progress], space, [interval]);
    if (a.produced[0] !== b.produced[0] || a.progress[0] !== b.progress[0]) divergences++;
  }
  assert.ok(divergences > 500, `naive Divergenzen: ${divergences}`);
});

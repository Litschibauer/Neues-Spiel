/**
 * DER KERNBEWEIS (Risiko R1, Architektur §7).
 *
 * Die geschlossene Produktionsformel ist eine Optimierung: Sie rechnet in O(1),
 * was eigentlich Tick für Tick passiert. Genau solche Optimierungen sind die
 * Stelle, an der Client und Server auseinanderlaufen.
 *
 * Deshalb wird sie hier gegen eine offensichtlich korrekte Tick-für-Tick-
 * Grundwahrheit gefuzzt. Das ist kein Selbstgespräch: zwei unabhängige
 * Implementierungen müssen für zehntausende Zufallseingaben exakt gleich sein.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceCoop, advanceCoopNaive, advanceCoopReference } from '../src/sim/produce.ts';

/** Deterministischer PRNG — ein fehlschlagender Testlauf ist exakt reproduzierbar. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('geschlossene Form == Tick-für-Tick-Grundwahrheit (20.000 Zufallsfälle)', () => {
  const rnd = mulberry32(0xc0ffee);
  let cappedCases = 0;

  for (let i = 0; i < 20_000; i++) {
    const ticksPerEgg = 1 + Math.floor(rnd() * 1000);
    const elapsed = Math.floor(rnd() * 20_000);
    const progress = Math.floor(rnd() * ticksPerEgg);
    const space = Math.floor(rnd() * 50);

    const fast = advanceCoop(elapsed, progress, space, ticksPerEgg);
    const truth = advanceCoopReference(elapsed, progress, space, ticksPerEgg);

    assert.deepEqual(
      fast,
      truth,
      `Divergenz bei elapsed=${elapsed} progress=${progress} space=${space} tpe=${ticksPerEgg}`,
    );

    if (Math.floor((progress + elapsed) / ticksPerEgg) > space) cappedCases++;
  }

  // Absicherung, dass der Fuzz überhaupt den interessanten Fall trifft:
  // ohne Lager-Anschlag würde der Test nichts beweisen.
  assert.ok(cappedCases > 1000, `zu wenige Lager-voll-Fälle im Fuzz: ${cappedCases}`);
});

test('Grenzfälle', () => {
  // Kein Platz → nichts passiert, Fortschritt friert ein.
  assert.deepEqual(advanceCoop(9999, 42, 0, 600), { eggs: 0, coopProgress: 42 });
  // Keine Zeit → nichts passiert.
  assert.deepEqual(advanceCoop(0, 42, 10, 600), { eggs: 0, coopProgress: 42 });
  // Exakt aufgehend.
  assert.deepEqual(advanceCoop(1200, 0, 10, 600), { eggs: 2, coopProgress: 0 });
  // Genau am Limit: letztes Ei passt noch rein, danach blockiert.
  assert.deepEqual(advanceCoop(7250, 0, 2, 600), { eggs: 2, coopProgress: 0 });
});

test('Regression: Gleichstand wanted === space friert den Fortschritt ein', () => {
  // Dieser Fall kam aus dem Fuzz und war der ursprüngliche Off-by-one:
  // Die geschlossene Form nahm `wanted <= space` als „passt locker" und sparte
  // die Restzeit an — obwohl das letzte Ei das Lager exakt gefüllt hatte.
  // Genau so entsteht ein Rollback für einen ehrlichen Spieler (R1).
  const args = [7604, 313, 8, 932] as const;
  assert.deepEqual(advanceCoop(...args), advanceCoopReference(...args));
  assert.deepEqual(advanceCoop(...args), { eggs: 8, coopProgress: 0 });
});

test('der naive Bug divergiert nachweislich — der Test hat Zähne', () => {
  // 5h offline, Lager nach 2 Eiern voll. Die naive Variante bunkert weiter
  // Fortschritt an, obwohl der Stall längst blockiert ist.
  const fast = advanceCoop(7250, 0, 2, 600);
  const naive = advanceCoopNaive(7250, 0, 2, 600);
  const truth = advanceCoopReference(7250, 0, 2, 600);

  assert.deepEqual(fast, truth);
  assert.notDeepEqual(naive, truth);
  assert.equal(naive.coopProgress, 50); // 50 Ticks aus dem Nichts gebunkert

  // Und das ist kein exotischer Einzelfall.
  const rnd = mulberry32(7);
  let divergences = 0;
  for (let i = 0; i < 5_000; i++) {
    const ticksPerEgg = 1 + Math.floor(rnd() * 1000);
    const elapsed = Math.floor(rnd() * 20_000);
    const progress = Math.floor(rnd() * ticksPerEgg);
    const space = Math.floor(rnd() * 20);
    const a = advanceCoopNaive(elapsed, progress, space, ticksPerEgg);
    const b = advanceCoopReference(elapsed, progress, space, ticksPerEgg);
    if (a.eggs !== b.eggs || a.coopProgress !== b.coopProgress) divergences++;
  }
  assert.ok(divergences > 500, `naive Divergenzen: ${divergences}`);
});

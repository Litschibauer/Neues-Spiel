import test from 'node:test';
import assert from 'node:assert/strict';
import { getRuleset } from '../src/sim/rules.ts';
import { initialState, capacityOf, storedIn } from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';
import { advancePassives } from '../src/sim/produce.ts';
import { assertInvariants } from '../src/sim/migrate.ts';

const V = getRuleset(27);
const WHEAT = V.items.findIndex((i) => i.id === 'wheat');

test('das Postfach-Limit von 20 ist weg', () => {
  assert.ok(V.mailCapacity >= 999, `Postfach viel zu klein: ${V.mailCapacity}`);
});

test('das Lager darf per Postfach überlaufen — und ist dann ein gültiger Zustand', () => {
  const base = initialState(V);
  const cap = capacityOf(base, V);
  const items = base.items.map(() => 0);
  items[V.currency] = 10_000;
  items[WHEAT] = cap; // Lager exakt voll
  const s = { ...base, items, mail: [{ item: WHEAT, amount: 40, arrivedAt: 0 }] };

  const nach = simulate(s, { seq: 1, tick: 0, type: 'COLLECT_MAIL' }, V);
  assert.equal(nach.items[WHEAT], cap + 40, 'die ganze Postfach-Ladung wandert ins Lager');
  assert.ok(storedIn(nach.items, V) > cap, 'das Lager ist jetzt übervoll');
  assert.equal(nach.mail.length, 0, 'Postfach geleert');
  assertInvariants(nach, V); // ein übervolles Lager ist bei siloUeberlauf erlaubt
});

test('ein übervolles Lager füllt sich nicht von selbst — Passive und Ernte pausieren', () => {
  // Passive Produktion: kein Restplatz (oder negativer) → es wächst nichts nach.
  const intervals = [10, 15];
  assert.deepEqual(
    advancePassives(1000, [0, 0], -20, intervals).produced,
    [0, 0],
    'übervoll: Passive pausieren',
  );
  assert.ok(advancePassives(1000, [0, 0], 100, intervals).produced[0]! > 0, 'mit Platz wächst es');

  const base = initialState(V);
  const cap = capacityOf(base, V);
  // Feld 0 mit fertigem Weizen bestücken.
  const fertig = (items: number[]) => ({
    ...base,
    items,
    tick: 1000,
    plots: base.plots.map((p, i) =>
      i === 0
        ? { ...p, slots: p.slots.map((sl, j) => (j === 0 ? { recipe: 0, startedAt: 0 } : sl)) }
        : p,
    ),
  });

  // Übervoll → Ernte blockiert.
  const voll = base.items.map(() => 0);
  voll[WHEAT] = cap + 30;
  assert.throws(
    () => simulate(fertig(voll), { seq: 1, tick: 1000, type: 'COLLECT', plot: 0, slot: 0 }, V),
    { code: 'SILO_FULL' },
    'übervoll: keine Ernte',
  );

  // Wieder Platz → Ernte geht.
  const leer = base.items.map(() => 0);
  const ok = simulate(fertig(leer), { seq: 1, tick: 1000, type: 'COLLECT', plot: 0, slot: 0 }, V);
  assert.ok(ok.items[WHEAT]! > 0, 'mit Platz lässt sich wieder ernten');
});

test('Ware lässt sich endgültig aus dem Lager löschen — ohne Gegenwert', () => {
  const base = initialState(V);
  const items = base.items.map(() => 0);
  items[WHEAT] = 20;
  items[V.currency] = 500;
  const s = { ...base, items };

  const nach = simulate(s, { seq: 1, tick: 0, type: 'DISCARD', item: WHEAT, amount: 8 }, V);
  assert.equal(nach.items[WHEAT], 12, 'acht Weizen weniger');
  assert.equal(nach.items[V.currency], 500, 'kein Gold als Gegenwert');

  assert.throws(
    () => simulate(s, { seq: 1, tick: 0, type: 'DISCARD', item: WHEAT, amount: 99 }, V),
    { code: 'NOT_ENOUGH_ITEMS' },
    'mehr löschen als da ist geht nicht',
  );
  assert.throws(
    () => simulate(s, { seq: 1, tick: 0, type: 'DISCARD', item: WHEAT, amount: 0 }, V),
    { code: 'BAD_AMOUNT' },
  );
});

test('ältere Regelwerke bleiben streng — kein Überlauf', () => {
  const V26 = getRuleset(26);
  assert.notEqual(V26.siloUeberlauf, true);
  assert.equal(V26.mailCapacity, 20, 'v26 behält das alte Postfach-Limit');
});

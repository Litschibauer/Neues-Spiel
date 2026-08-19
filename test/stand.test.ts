import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LATEST_RULESET_VERSION,
  PRODUCTION_VERSIONS,
  getRuleset,
  isTradable,
  offerLimits,
  priceBand,
  validateRuleset,
} from '../src/sim/rules.ts';
import type { Ruleset } from '../src/sim/rules.ts';
import { initialState } from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';
import { farmView } from '../src/client/view.ts';

const V14 = getRuleset(14);
const V13 = getRuleset(13);

function mit(rules: Ruleset, item: number, amount: number, gold = 100_000) {
  const base = initialState(rules);
  const items = base.items.map(() => 0);
  items[item] = amount;
  items[0] = gold;
  return { ...base, items };
}

function idOf(rules: Ruleset, id: string): number {
  const i = rules.items.findIndex((x) => x.id === id);
  assert.notEqual(i, -1, `${id} fehlt im Katalog`);
  return i;
}

const WHEAT14 = idOf(V14, 'wheat');
const CHEESE14 = idOf(V14, 'cheese');

test('ein Kästchen nimmt höchstens zehn Stück', () => {
  const s = mit(V14, WHEAT14, 40);
  const preis = offerLimits(V14, WHEAT14).maxPrice;

  assert.throws(
    () => simulate(s, { seq: 1, tick: 0, type: 'LIST_ORDER', item: WHEAT14, amount: 11, price: preis }, V14),
    { code: 'TOO_MANY_PER_SLOT' },
  );

  const zehn = simulate(
    s,
    { seq: 1, tick: 0, type: 'LIST_ORDER', item: WHEAT14, amount: 10, price: preis },
    V14,
  );
  assert.equal(zehn.orders.length, 1);
  assert.equal(zehn.orders[0]!.amount, 10);
});

test('der Preisdeckel greift über dem Band — und nur da, wo er beißt', () => {
  const band = priceBand(V14, CHEESE14);
  const limits = offerLimits(V14, CHEESE14);

  assert.ok(band.max > limits.maxPrice, 'Käse soll wirklich gedeckelt sein');
  assert.equal(limits.maxPrice, V14.maxOfferPrice);

  const s = mit(V14, CHEESE14, 10);
  assert.throws(
    () =>
      simulate(
        s,
        { seq: 1, tick: 0, type: 'LIST_ORDER', item: CHEESE14, amount: 1, price: limits.maxPrice + 1 },
        V14,
      ),
    { code: 'PRICE_OUT_OF_BAND' },
  );
  assert.equal(
    simulate(
      s,
      { seq: 1, tick: 0, type: 'LIST_ORDER', item: CHEESE14, amount: 1, price: limits.maxPrice },
      V14,
    ).orders.length,
    1,
  );

  const weizen = offerLimits(V14, WHEAT14);
  assert.equal(weizen.maxPrice, priceBand(V14, WHEAT14).max);
});

test('die alten Regelwerke bleiben unberührt — sonst spielt sich ihr Log anders ab', () => {
  const wheat13 = idOf(V13, 'wheat');
  const s = mit(V13, wheat13, 40);
  const preis = priceBand(V13, wheat13).max;

  const viel = simulate(
    s,
    { seq: 1, tick: 0, type: 'LIST_ORDER', item: wheat13, amount: 20, price: preis },
    V13,
  );
  assert.equal(viel.orders[0]!.amount, 20);
  assert.equal(offerLimits(V13, wheat13).maxAmount, 0);
});

test('kein Regelwerk deckelt den Preis unter den Mindestpreis seines Bandes', () => {
  for (const v of PRODUCTION_VERSIONS) {
    assert.deepEqual(validateRuleset(getRuleset(v)), [], `v${v}`);
  }

  const kaputt: Ruleset = { ...V14, maxOfferPrice: 2 };
  assert.ok(
    validateRuleset(kaputt).some((p) => p.includes('Preisdeckel')),
    'ein zu tiefer Deckel muss auffallen',
  );
});

test('die Oberfläche bekommt dieselben Grenzen wie die Sim', () => {
  const v = farmView(mit(V14, CHEESE14, 30), V14);
  const kaese = v.stock[CHEESE14]!;

  assert.equal(kaese.maxAmount, V14.maxOfferAmount);
  assert.equal(kaese.bandMax, offerLimits(V14, CHEESE14).maxPrice);
  assert.equal(kaese.bandMin, priceBand(V14, CHEESE14).min);
  assert.equal(v.orderSlots, V14.orderSlots);
  assert.equal(v.orderSlotsFree, V14.orderSlots);
});

test('jede handelbare Ware im neuesten Regelwerk lässt sich auch wirklich hinstellen', () => {
  const rules = getRuleset(LATEST_RULESET_VERSION);
  for (let i = 0; i < rules.items.length; i++) {
    if (!isTradable(rules, i)) continue;
    const limits = offerLimits(rules, i);
    assert.ok(limits.maxAmount >= 1, `${rules.items[i]!.id}: Kästchen fasst nichts`);
    assert.ok(limits.minPrice <= limits.maxPrice, `${rules.items[i]!.id}: Preisspanne leer`);

    const s = mit(rules, i, limits.maxAmount);
    const next = simulate(
      s,
      { seq: 1, tick: 0, type: 'LIST_ORDER', item: i, amount: limits.maxAmount, price: limits.maxPrice },
      rules,
    );
    assert.equal(next.orders.length, 1, `${rules.items[i]!.id} ließ sich nicht hinstellen`);
  }
});

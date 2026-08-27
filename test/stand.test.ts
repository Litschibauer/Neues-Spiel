import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LATEST_RULESET_VERSION,
  PRODUCTION_VERSIONS,
  getRuleset,
  isTradable,
  itemUnlockLevel,
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
  return { ...base, items, xp: 10_000_000 };
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

test('Werkzeug lässt sich verkaufen — Sägen, Nägel, Bretter', () => {
  const SAW14 = idOf(V14, 'saw');
  assert.equal(isTradable(V14, SAW14), false, 'in v14 war Werkzeug noch nicht handelbar');

  const rules = getRuleset(20);
  const saw = idOf(rules, 'saw');
  assert.equal(isTradable(rules, saw), true);
  assert.equal(itemUnlockLevel(rules, saw), 0, 'Werkzeug hat keine Stufensperre');

  const s = mit(rules, saw, 3);
  const preis = offerLimits(rules, saw).maxPrice;
  const next = simulate(
    s,
    { seq: 1, tick: 0, type: 'LIST_ORDER', item: saw, amount: 2, price: preis },
    rules,
  );
  assert.equal(next.orders.length, 1);
  assert.equal(next.orders[0]!.item, saw);
});

test('was die Stufe noch nicht hergibt, lässt sich nicht anbieten', () => {
  const rules = getRuleset(20);
  const cheese = idOf(rules, 'cheese');
  assert.ok(itemUnlockLevel(rules, cheese) > 1, 'Käse sollte eine Stufe brauchen');

  const jung = mit(rules, cheese, 5);
  jung.xp = 0;
  const band = offerLimits(rules, cheese);
  assert.throws(
    () =>
      simulate(jung, { seq: 1, tick: 0, type: 'LIST_ORDER', item: cheese, amount: 1, price: band.minPrice }, rules),
    { code: 'ITEM_LOCKED' },
  );

  const reif = mit(rules, cheese, 5);
  assert.equal(
    simulate(reif, { seq: 1, tick: 0, type: 'LIST_ORDER', item: cheese, amount: 1, price: band.minPrice }, rules).orders.length,
    1,
    'mit genug XP muss es gehen',
  );
});

test('die Stufensperre gilt nur ab dem Regelwerk, das sie kennt', () => {
  const v19 = getRuleset(19);
  assert.equal(v19.offerNeedsLevel, undefined);
  const wheat19 = idOf(v19, 'wheat');
  const s = { ...mit(v19, wheat19, 10), xp: 0 };
  assert.equal(
    simulate(s, { seq: 1, tick: 0, type: 'LIST_ORDER', item: wheat19, amount: 5, price: 3 }, v19).orders.length,
    1,
    'v19 kennt keine Stufensperre — alter Log muss gleich bleiben',
  );
});

test('die Oberfläche kreuzt gesperrte Waren an, statt sie zu verstecken', () => {
  const rules = getRuleset(20);
  const cheese = idOf(rules, 'cheese');
  const s = mit(rules, cheese, 5);
  s.xp = 0;
  const kaese = farmView(s, rules).stock[cheese]!;
  assert.equal(kaese.locked, true);
  assert.ok(kaese.unlockLevel > 1);

  const saw = idOf(rules, 'saw');
  const saege = farmView(mit(rules, saw, 2), rules).stock[saw]!;
  assert.equal(saege.sellable, true);
  assert.equal(saege.locked, false);
});

test('wer die Stufe nicht hat, kann eine gesperrte Ware auch nicht kaufen', () => {
  const rules = getRuleset(21);
  const cheese = idOf(rules, 'cheese');
  const stufe = itemUnlockLevel(rules, cheese);
  assert.ok(stufe > 1, 'Käse sollte eine Stufe brauchen');

  const angebot = {
    id: 1,
    item: cheese,
    amount: 2,
    price: 10,
    seller: 'FREMD1',
    hof: 'Nachbarhof',
    headline: false,
  };

  const arm = { ...mit(rules, 0, 100_000), xp: 0, offers: [angebot] };
  assert.throws(
    () => simulate(arm, { seq: 1, tick: 0, type: 'BUY_OFFER', offerId: 1 }, rules),
    { code: 'ITEM_LOCKED' },
  );

  const reif = { ...mit(rules, 0, 100_000), offers: [angebot] };
  const nach = simulate(reif, { seq: 1, tick: 0, type: 'BUY_OFFER', offerId: 1 }, rules);
  assert.equal(nach.offers.length, 0, 'mit genug Stufe muss der Kauf durchgehen');
  assert.equal(nach.items[cheese], 2);
});

test('die Kaufsperre gilt erst ab dem Regelwerk, das sie kennt', () => {
  const v20 = getRuleset(20);
  assert.equal(v20.buyNeedsLevel, undefined);
  const cheese = idOf(v20, 'cheese');
  const angebot = {
    id: 1,
    item: cheese,
    amount: 1,
    price: 5,
    seller: 'FREMD1',
    hof: 'Nachbarhof',
    headline: false,
  };
  const arm = { ...mit(v20, 0, 100_000), xp: 0, offers: [angebot] };
  const nach = simulate(arm, { seq: 1, tick: 0, type: 'BUY_OFFER', offerId: 1 }, v20);
  assert.equal(nach.offers.length, 0, 'v20 kennt keine Kaufsperre — alter Log bleibt gleich');
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

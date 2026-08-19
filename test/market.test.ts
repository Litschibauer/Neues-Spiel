import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Market, connectMarket, publishOrders, settleSales } from '../src/server/market.ts';
import { SqliteStorage } from '../src/server/storage.ts';
import { Server } from '../src/server/server.ts';
import { Client } from '../src/client/client.ts';
import { getRuleset, CURRENT_RULESET_VERSION } from '../src/sim/rules.ts';
import { count, initialState, totalGoods } from '../src/sim/state.ts';
import type { State } from '../src/sim/state.ts';

const T0 = 1_700_000_000_000;
const rules = getRuleset(CURRENT_RULESET_VERSION);
const GOLD = rules.currency;
const WHEAT = 1;
const R_WHEAT = 0;

const FEE_BUDGET = 500;

const STARTING_WHEAT = rules.startingItems.find((x) => x.item === WHEAT)?.amount ?? 0;

function listingFee(item: number, amount: number): number {
  return Math.floor((rules.items[item]!.npcPrice * amount * rules.listingFeePct + 99) / 100);
}

function farm(
  market: Market,
  live: Map<string, Server>,
  id: string,
  gold: number,
  wheat = 0,
) {
  const state = initialState(rules);
  const items = state.items.slice();
  items[GOLD] = gold + FEE_BUDGET;
  items[WHEAT] = wheat;
  const game = new Server({ ...state, items }, T0, CURRENT_RULESET_VERSION);
  connectMarket(market, id, game, (other) => live.get(other) ?? null);
  live.set(id, game);
  return game;
}

function play(game: Server, act: (c: Client) => void, atMs = T0 + 60_000) {
  const client = new Client(game.snapshot);
  act(client);
  return game.sync(client.buildSyncRequest(), atMs);
}

function goodsAcross(...states: State[]): number {
  return states.reduce((n, s) => n + totalGoods(s, rules), 0);
}

function goldAcross(...games: Server[]): number {
  return games.reduce((n, g) => {
    const inMail = g.snapshot.state.mail
      .filter((m) => m.item === GOLD)
      .reduce((a, m) => a + m.amount, 0);
    const pending = g.pendingDeliveries
      .filter((m) => m.item === GOLD)
      .reduce((a, m) => a + m.amount, 0);
    return n + count(g.snapshot.state, GOLD) + inMail + pending;
  }, 0);
}

function setup() {
  const market = new Market(null);
  const live = new Map<string, Server>();
  return { market, live };
}

test('zwei Höfe handeln wirklich miteinander', () => {
  const { market, live } = setup();
  const anna = farm(market, live, 'anna', 0, 30);
  const ben = farm(market, live, 'ben', 500);

  play(anna, (c) => c.listOrder(WHEAT, 20, 3));
  publishOrders(market, 'anna', anna);
  assert.equal(market.size, 1, 'der Auftrag steht nicht im Buch');
  assert.equal(count(anna.snapshot.state, WHEAT), 10, 'Escrow hat nichts aus dem Lager genommen');

  ben.stockOffers();
  anna.stockOffers();
  assert.equal(ben.snapshot.state.offers.length, 1);
  assert.equal(anna.snapshot.state.offers.length, 0, 'Anna sieht ihr eigenes Angebot');

  const offer = ben.snapshot.state.offers[0]!;
  assert.equal(offer.item, WHEAT);
  assert.equal(offer.amount, 20);
  assert.equal(offer.price, 3);

  const result = play(ben, (c) => c.buyOffer(offer.id));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.kind, 'applied');

  assert.equal(count(ben.snapshot.state, WHEAT), 20);
  assert.equal(count(ben.snapshot.state, GOLD), 500 + FEE_BUDGET - 60);

  assert.equal(anna.snapshot.state.orders.length, 0, 'Annas Auftrag steht noch');
  assert.equal(market.size, 0, 'das Angebot steht noch im Buch');

  play(anna, (c) => c.start(0, R_WHEAT));
  const mailGold = anna.snapshot.state.mail.find((m) => m.item === GOLD);
  assert.equal(mailGold?.amount, 60, 'Anna hat ihren Erlös nicht bekommen');
  assert.ok(
    count(anna.snapshot.state, GOLD) < FEE_BUDGET,
    'der Erlös ist direkt im Lager gelandet statt im Postfach',
  );
});

test('DER KERNPUNKT: ein Handel erschafft und vernichtet nichts', () => {
  const { market, live } = setup();
  const anna = farm(market, live, 'anna', 100, 40);
  const ben = farm(market, live, 'ben', 400);

  const goodsBefore = goodsAcross(anna.snapshot.state, ben.snapshot.state);
  const goldBefore = goldAcross(anna, ben);

  play(anna, (c) => c.listOrder(WHEAT, 25, 4));
  publishOrders(market, 'anna', anna);
  ben.stockOffers();
  play(ben, (c) => c.buyOffer(ben.snapshot.state.offers[0]!.id));

  const goodsAfter = goodsAcross(anna.snapshot.state, ben.snapshot.state);
  const goldAfter = goldAcross(anna, ben);

  assert.equal(goodsAfter, goodsBefore, 'Ware ist aus dem Nichts entstanden oder verschwunden');

  const fee = listingFee(WHEAT, 25);
  assert.ok(fee > 0, 'die Gebühr rundet auf null ab');
  assert.equal(goldBefore - goldAfter, fee, 'es ist mehr oder weniger als die Gebühr verschwunden');
});

test('zwei Käufer, ein Angebot — genau einer gewinnt', () => {
  const { market, live } = setup();
  const anna = farm(market, live, 'anna', 0, 20);
  const ben = farm(market, live, 'ben', 500);
  const cem = farm(market, live, 'cem', 500);

  play(anna, (c) => c.listOrder(WHEAT, 10, 3));
  publishOrders(market, 'anna', anna);

  ben.stockOffers();
  cem.stockOffers();
  const offerId = ben.snapshot.state.offers[0]!.id;
  assert.equal(cem.snapshot.state.offers[0]!.id, offerId);

  const first = play(ben, (c) => c.buyOffer(offerId));
  const second = play(cem, (c) => c.buyOffer(offerId));

  assert.equal(first.ok, true);
  assert.equal(count(ben.snapshot.state, WHEAT), 10, 'der Gewinner hat die Ware nicht');

  assert.equal(second.ok, true, 'der Verlierer bekommt keine verwertbare Antwort');
  if (second.ok) {
    assert.equal(second.kind, 'partial');
    assert.match(second.reason ?? '', /OFFER_GONE/);
    assert.deepEqual(second.dropped, [1], 'genau der Kauf fällt weg, nichts sonst');
  }
  assert.equal(count(cem.snapshot.state, WHEAT), 0, 'der Verlierer hat Ware bekommen');
  assert.equal(
    count(cem.snapshot.state, GOLD),
    500 + FEE_BUDGET,
    'dem Verlierer wurde Geld abgezogen',
  );
});

test('was vor dem verlorenen Kauf lag, bleibt bestehen', () => {
  const { market, live } = setup();
  const anna = farm(market, live, 'anna', 0, 20);
  const ben = farm(market, live, 'ben', 500);

  const cem = farm(market, live, 'cem', 500, STARTING_WHEAT);

  play(anna, (c) => c.listOrder(WHEAT, 10, 3));
  publishOrders(market, 'anna', anna);
  ben.stockOffers();
  cem.stockOffers();
  const offerId = cem.snapshot.state.offers[0]!.id;

  play(ben, (c) => c.buyOffer(offerId));

  const client = new Client(cem.snapshot);
  client.start(0, R_WHEAT);
  client.advanceClock(rules.recipes[R_WHEAT]!.durationTicks);
  client.collect(0);
  client.buyOffer(offerId);
  const result = cem.sync(client.buildSyncRequest(), T0 + 600_000);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.kind, 'partial');

    assert.equal(result.rejectedFrom, 3, 'abgeschnitten wurde an der falschen Stelle');
  }
  assert.equal(
    count(cem.snapshot.state, WHEAT),
    STARTING_WHEAT - 1 + rules.recipes[R_WHEAT]!.output.amount,
    'Cems eigene Ernte ist mit verworfen worden',
  );
});

test('was NACH dem verlorenen Kauf lag, überlebt ihn — solange es allein steht', () => {
  const { market, live } = setup();
  const anna = farm(market, live, 'anna', 0, 20);
  const ben = farm(market, live, 'ben', 500);
  const cem = farm(market, live, 'cem', 500, STARTING_WHEAT);

  play(anna, (c) => c.listOrder(WHEAT, 10, 3));
  publishOrders(market, 'anna', anna);
  ben.stockOffers();
  cem.stockOffers();
  const offerId = cem.snapshot.state.offers[0]!.id;

  play(ben, (c) => c.buyOffer(offerId));

  const client = new Client(cem.snapshot);
  client.buyOffer(offerId);
  client.start(0, R_WHEAT);
  client.advanceClock(rules.recipes[R_WHEAT]!.durationTicks);
  client.collect(0);
  const result = cem.sync(client.buildSyncRequest(), T0 + 600_000);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.kind, 'partial');
    assert.deepEqual(result.dropped, [1], 'es fiel mehr weg als der Kauf');
  }

  assert.equal(
    count(cem.snapshot.state, WHEAT),
    STARTING_WHEAT - 1 + rules.recipes[R_WHEAT]!.output.amount,
    'die Ernte nach dem verlorenen Kauf ist mit verworfen worden',
  );
  assert.equal(
    count(cem.snapshot.state, GOLD),
    500 + FEE_BUDGET,
    'der verlorene Kauf hat doch Geld gekostet',
  );
});

test('was auf dem verlorenen Kauf aufbaute, fällt mit — aber nur das', () => {
  const { market, live } = setup();
  const anna = farm(market, live, 'anna', 0, 20);
  const ben = farm(market, live, 'ben', 500);
  const cem = farm(market, live, 'cem', 500, 0);

  play(anna, (c) => c.listOrder(WHEAT, 10, 3));
  publishOrders(market, 'anna', anna);
  ben.stockOffers();
  cem.stockOffers();
  const offerId = cem.snapshot.state.offers[0]!.id;

  play(ben, (c) => c.buyOffer(offerId));

  const client = new Client(cem.snapshot);
  client.buyOffer(offerId);
  client.start(0, R_WHEAT);
  const result = cem.sync(client.buildSyncRequest(), T0 + 600_000);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.dropped, [1, 2], 'die Saat aus gekauftem Weizen wurde gutgeschrieben');
  }
  assert.equal(count(cem.snapshot.state, WHEAT), 0);
});

test('nach einem verlorenen Kauf gilt der Stapel als erledigt — kein zweiter Anlauf', () => {
  const { market, live } = setup();
  const anna = farm(market, live, 'anna', 0, 20);
  const ben = farm(market, live, 'ben', 500);
  const cem = farm(market, live, 'cem', 500, STARTING_WHEAT);

  play(anna, (c) => c.listOrder(WHEAT, 10, 3));
  publishOrders(market, 'anna', anna);
  ben.stockOffers();
  cem.stockOffers();
  const offerId = cem.snapshot.state.offers[0]!.id;
  play(ben, (c) => c.buyOffer(offerId));

  const client = new Client(cem.snapshot);
  client.buyOffer(offerId);
  const anfrage = client.buildSyncRequest();

  const erst = cem.sync(anfrage, T0 + 600_000);
  assert.equal(erst.ok, true);

  const nochmal = cem.sync(anfrage, T0 + 600_001);
  assert.equal(nochmal.ok, true, 'die verlorene Antwort löst einen Fork-Alarm aus');
  if (nochmal.ok) assert.equal(nochmal.kind, 'duplicate');
  assert.equal(count(cem.snapshot.state, GOLD), 500 + FEE_BUDGET);
});

test('offline zurückziehen verliert gegen einen echten Kauf', () => {
  const { market, live } = setup();
  const anna = farm(market, live, 'anna', 0, 20);
  const ben = farm(market, live, 'ben', 500);

  play(anna, (c) => c.listOrder(WHEAT, 10, 3));
  publishOrders(market, 'anna', anna);

  const annaOffline = new Client(anna.snapshot);

  live.delete('anna');
  ben.stockOffers();
  play(ben, (c) => c.buyOffer(ben.snapshot.state.offers[0]!.id));
  assert.equal(market.peekSettlements('anna').length, 1, 'der Verkauf ist nirgends vermerkt');

  annaOffline.advanceClock(30);
  assert.equal(annaOffline.cancelOrder(1).ok, true);
  assert.equal(count(annaOffline.preview(), WHEAT), 20, 'lokal ist die Ware nicht zurück');

  settleSales(market, 'anna', anna);
  const result = anna.sync(annaOffline.buildSyncRequest(), T0 + 120_000);

  assert.equal(result.ok, false, 'das Zurückziehen wurde übernommen');
  if (!result.ok) assert.match(result.reason, /NO_SUCH_ORDER/);

  const total = count(anna.snapshot.state, WHEAT) + count(ben.snapshot.state, WHEAT);
  assert.equal(total, 20, `Ware verdoppelt oder verloren: ${total} statt 20`);
  assert.equal(count(anna.snapshot.state, WHEAT), 10, 'Anna hat ihren Rest nicht');
  assert.equal(count(ben.snapshot.state, WHEAT), 10, 'Ben hat seinen Kauf nicht');
});

test('ein Verkauf löst keinen Divergenz-Fehlalarm aus', () => {
  const { market, live } = setup();
  const anna = farm(market, live, 'anna', 0, 20);
  const ben = farm(market, live, 'ben', 500);

  play(anna, (c) => c.listOrder(WHEAT, 10, 3));
  publishOrders(market, 'anna', anna);

  const annaOffline = new Client(anna.snapshot);
  live.delete('anna');
  ben.stockOffers();
  play(ben, (c) => c.buyOffer(ben.snapshot.state.offers[0]!.id));

  annaOffline.start(0, R_WHEAT);
  annaOffline.advanceClock(rules.recipes[R_WHEAT]!.durationTicks);
  annaOffline.collect(0);

  settleSales(market, 'anna', anna);
  const result = anna.sync(annaOffline.buildSyncRequest(), T0 + 600_000);

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.divergence, null, 'Kanarienvogel hat falsch angeschlagen');
  assert.equal(anna.divergenceAlerts.length, 0, 'ein Alarm ist im Monitoring gelandet');

  const next = new Client(anna.snapshot);
  next.advanceClock(5);
  next.start(1, R_WHEAT);
  const again = anna.sync(next.buildSyncRequest(), T0 + 900_000);
  assert.equal(again.ok, true);
  if (again.ok) assert.equal(again.divergence, false, 'Kanarienvogel bleibt stumm');
});

test('das Buch folgt dem Escrow, nicht umgekehrt', () => {
  const { market, live } = setup();
  const anna = farm(market, live, 'anna', 0, 40);

  play(anna, (c) => c.listOrder(WHEAT, 10, 3));
  publishOrders(market, 'anna', anna);
  assert.equal(market.size, 1);

  publishOrders(market, 'anna', anna);
  assert.equal(market.size, 1, 'derselbe Auftrag steht doppelt im Buch');

  play(anna, (c) => c.cancelOrder(1), T0 + 120_000);
  publishOrders(market, 'anna', anna);
  assert.equal(market.size, 0, 'das Angebot steht noch im Buch');
});

test('ein Angebot bleibt liegen, solange der Verkäufer weg ist', () => {
  const { market, live } = setup();
  const anna = farm(market, live, 'anna', 0, 20);

  play(anna, (c) => c.listOrder(WHEAT, 10, 3));
  publishOrders(market, 'anna', anna);
  assert.equal(market.size, 1);

  const later = 100 * 86_400;
  const client = new Client(anna.snapshot);
  client.advanceClock(later);
  client.sellNpc(WHEAT, 1);
  anna.sync(client.buildSyncRequest(), T0 + (later + 100) * 1000);

  assert.equal(anna.snapshot.state.orders.length, 1, 'der Auftrag ist verfallen');
  assert.equal(anna.snapshot.state.mail.length, 0, 'etwas ist ins Postfach zurückgefallen');
  publishOrders(market, 'anna', anna);
  assert.equal(market.size, 1, 'das Angebot ist aus dem Buch verschwunden');
  assert.equal(market.browse('ben', 10).length, 1, 'niemand kann es mehr kaufen');
});

test('zurückgezogen verschwindet es dagegen sofort aus dem Buch', () => {
  const { market, live } = setup();
  const anna = farm(market, live, 'anna', 0, 20);

  play(anna, (c) => c.listOrder(WHEAT, 10, 3));
  publishOrders(market, 'anna', anna);
  assert.equal(market.size, 1);

  play(anna, (c) => c.cancelOrder(1), T0 + 120_000);
  publishOrders(market, 'anna', anna);
  assert.equal(market.size, 0);
  assert.equal(count(anna.snapshot.state, WHEAT), 20, 'die Ware ist nicht zurückgekommen');
});

test('niemand kauft bei sich selbst', () => {
  const { market, live } = setup();
  const anna = farm(market, live, 'anna', 500, 20);

  play(anna, (c) => c.listOrder(WHEAT, 10, 3));
  publishOrders(market, 'anna', anna);

  anna.stockOffers();
  assert.equal(anna.snapshot.state.offers.length, 0);

  const entry = market.entries()[0]!;
  assert.equal(market.claim(entry.id, 'anna', T0), null);
  assert.equal(market.size, 1, 'das Angebot ist trotz Ablehnung verschwunden');
});

test('das Buch überlebt einen Neustart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-market-'));
  try {
    const db = new SqliteStorage(join(dir, 'spiel.db'));
    const market = new Market(db);
    const live = new Map<string, Server>();
    const anna = farm(market, live, 'anna', 0, 20);
    play(anna, (c) => c.listOrder(WHEAT, 10, 3));
    publishOrders(market, 'anna', anna);
    market.flush();

    market.claim(market.entries()[0]!.id, 'ben', T0);
    db.close();

    const again = new Market(new SqliteStorage(join(dir, 'spiel.db')));
    assert.equal(again.size, 0, 'das verkaufte Angebot steht wieder im Buch');
    assert.equal(again.peekSettlements('anna').length, 1, 'Annas Erlös ist verloren');
    assert.equal(again.peekSettlements('anna')[0]!.gold, 30);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ein eingestelltes Angebot überlebt einen Neustart ebenfalls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-market-'));
  try {
    const db = new SqliteStorage(join(dir, 'spiel.db'));
    const market = new Market(db);
    const live = new Map<string, Server>();
    const anna = farm(market, live, 'anna', 0, 20);
    play(anna, (c) => c.listOrder(WHEAT, 10, 3));
    publishOrders(market, 'anna', anna);

    assert.equal(market.flush(), 0, 'das Angebot wartet noch aufs Schreiben');
    db.close();

    const again = new Market(new SqliteStorage(join(dir, 'spiel.db')));
    assert.equal(again.size, 1);
    assert.equal(again.browse('ben', 10)[0]!.amount, 10);

    again.reconcile('cem', [{ id: 1, item: WHEAT, amount: 5, price: 3, listedAt: 0, verkauft: 0 }], T0);
    assert.notEqual(again.browse('anna', 10)[0]!.id, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ein Verkauf während langer Abwesenheit verdoppelt nichts', () => {
  const { market, live } = setup();
  const anna = farm(market, live, 'anna', 0, 30);
  const ben = farm(market, live, 'ben', 500);

  play(anna, (c) => c.listOrder(WHEAT, 20, 3));
  publishOrders(market, 'anna', anna);

  live.delete('anna');
  ben.stockOffers();
  play(ben, (c) => c.buyOffer(ben.snapshot.state.offers[0]!.id));
  assert.equal(count(ben.snapshot.state, WHEAT), 20);

  const later = 3 * 86_400;
  settleSales(market, 'anna', anna);
  const client = new Client(anna.snapshot);
  client.advanceClock(later);
  client.start(1, R_WHEAT);
  anna.sync(client.buildSyncRequest(), T0 + (later + 60) * 1000);

  const wheatInMail = anna.snapshot.state.mail
    .filter((m) => m.item === WHEAT)
    .reduce((n, m) => n + m.amount, 0);
  assert.equal(wheatInMail, 0, 'die verkaufte Ware kam dem Verkäufer zurück');
  assert.equal(anna.snapshot.state.orders.length, 0, 'der verkaufte Auftrag steht noch');

  const seeded = rules.recipes[R_WHEAT]!.inputs.find((i) => i.item === WHEAT)?.amount ?? 0;
  const total =
    count(anna.snapshot.state, WHEAT) + wheatInMail + count(ben.snapshot.state, WHEAT);
  assert.equal(
    total,
    30 - seeded,
    `Ware verdoppelt oder verloren: ${total} statt ${30 - seeded}`,
  );

  const gold = anna.snapshot.state.mail.find((m) => m.item === GOLD);
  assert.equal(gold?.amount, 60, 'Anna hat ihren Erlös nicht bekommen');
});

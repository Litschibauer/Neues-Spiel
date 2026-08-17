/**
 * Das Orderbuch (M5) — die erste Stelle, an der zwei Höfe einander begegnen.
 *
 * Bis hierhin war jeder Spielstand für sich prüfbar: Ein Command, ein Hof, eine
 * Antwort. Ab hier hängt das Ergebnis davon ab, was jemand anders im selben
 * Moment tut — und **das** ist die Klasse von Fehlern, die man nicht durch
 * Nachdenken findet.
 *
 * Deshalb prüft diese Datei vor allem eine einzige Eigenschaft, in mehreren
 * Verkleidungen: **Ware wird weder erschaffen noch vernichtet.** Ein Markt, der
 * unter Gleichzeitigkeit Eier verdoppelt, ist schlimmer als gar kein Markt —
 * er entwertet jede Stunde, die irgendjemand ehrlich gespielt hat.
 */

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

/**
 * Ein Hof am Markt — genau so verdrahtet wie im Betrieb.
 *
 * `live` ist die Landkarte der geladenen Höfe, die im Server die HTTP-Schicht
 * hält. Hier ist sie eine Map; die Verdrahtung selbst kommt aus `market.ts`,
 * damit dieser Test das Echte prüft und keine Nachbildung.
 */
function farm(market: Market, live: Map<string, Server>, id: string, gold: number, wheat = 0) {
  const state = initialState(rules);
  const items = state.items.slice();
  items[GOLD] = gold;
  items[WHEAT] = wheat;
  const game = new Server({ ...state, items }, T0, CURRENT_RULESET_VERSION);
  connectMarket(market, id, game, (other) => live.get(other) ?? null);
  live.set(id, game);
  return game;
}

/** Einen Zug spielen und sofort syncen — der Online-Fall. */
function play(game: Server, act: (c: Client) => void, atMs = T0 + 60_000) {
  const client = new Client(game.snapshot);
  act(client);
  return game.sync(client.buildSyncRequest(), atMs);
}

/** Alle Waren beider Höfe zusammen — Lager, Escrow und Postfach (§7). */
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

  // Anna stellt zwanzig Weizen zu 3 Münzen ein.
  play(anna, (c) => c.listOrder(WHEAT, 20, 3));
  publishOrders(market, 'anna', anna);
  assert.equal(market.size, 1, 'der Auftrag steht nicht im Buch');
  assert.equal(count(anna.snapshot.state, WHEAT), 10, 'Escrow hat nichts aus dem Lager genommen');

  // Ben sieht ihn — und Anna sieht ihren eigenen nicht.
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

  // Ben hat die Ware und 60 Münzen weniger.
  assert.equal(count(ben.snapshot.state, WHEAT), 20);
  assert.equal(count(ben.snapshot.state, GOLD), 440);

  // Anna war live, also ist ihr Auftrag schon weg und das Geld unterwegs.
  assert.equal(anna.snapshot.state.orders.length, 0, 'Annas Auftrag steht noch');
  assert.equal(market.size, 0, 'das Angebot steht noch im Buch');

  // Es kommt durchs Postfach — Anna war nicht dabei und konnte nichts wissen
  // (§7). Zugestellt wird beim nächsten echten Sync, also braucht es einen Zug;
  // ein Sync ohne Commands ist ein No-op und rührt nichts an.
  play(anna, (c) => c.start(0, R_WHEAT));
  const mailGold = anna.snapshot.state.mail.find((m) => m.item === GOLD);
  assert.equal(mailGold?.amount, 60, 'Anna hat ihren Erlös nicht bekommen');
  assert.equal(count(anna.snapshot.state, GOLD), 0, 'Geld ist direkt im Lager gelandet');
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
  assert.equal(goldAfter, goldBefore, 'Münzen sind aus dem Nichts entstanden oder verschwunden');
});

test('zwei Käufer, ein Angebot — genau einer gewinnt', () => {
  const { market, live } = setup();
  const anna = farm(market, live, 'anna', 0, 20);
  const ben = farm(market, live, 'ben', 500);
  const cem = farm(market, live, 'cem', 500);

  play(anna, (c) => c.listOrder(WHEAT, 10, 3));
  publishOrders(market, 'anna', anna);

  // Beide haben dasselbe Angebot in ihrer Auslage — genau die Situation, in der
  // ein Markt Ware verdoppelt, wenn er nicht aufpasst.
  ben.stockOffers();
  cem.stockOffers();
  const offerId = ben.snapshot.state.offers[0]!.id;
  assert.equal(cem.snapshot.state.offers[0]!.id, offerId);

  const first = play(ben, (c) => c.buyOffer(offerId));
  const second = play(cem, (c) => c.buyOffer(offerId));

  assert.equal(first.ok, true);
  assert.equal(count(ben.snapshot.state, WHEAT), 10, 'der Gewinner hat die Ware nicht');

  // Der Zweite bekommt kein Bußgeld, sondern eine Absage: Er hat nichts falsch
  // gemacht, er war nur langsamer.
  assert.equal(second.ok, false);
  if (!second.ok) assert.match(second.reason, /OFFER_GONE/);
  assert.equal(count(cem.snapshot.state, WHEAT), 0, 'der Verlierer hat Ware bekommen');
  assert.equal(count(cem.snapshot.state, GOLD), 500, 'dem Verlierer wurde Geld abgezogen');
});

test('was vor dem verlorenen Kauf lag, bleibt bestehen', () => {
  // Präfix-Commit (§9): Ein verlorenes Rennen ganz hinten im Log darf nicht die
  // halbe Sitzung kosten.
  const { market, live } = setup();
  const anna = farm(market, live, 'anna', 0, 20);
  const ben = farm(market, live, 'ben', 500);
  const cem = farm(market, live, 'cem', 500);

  play(anna, (c) => c.listOrder(WHEAT, 10, 3));
  publishOrders(market, 'anna', anna);
  ben.stockOffers();
  cem.stockOffers();
  const offerId = cem.snapshot.state.offers[0]!.id;

  play(ben, (c) => c.buyOffer(offerId)); // Ben gewinnt

  // Cem hat vorher ehrlich gearbeitet und danach gekauft.
  const client = new Client(cem.snapshot);
  client.start(0, R_WHEAT);
  client.advanceClock(rules.recipes[R_WHEAT]!.durationTicks);
  client.collect(0);
  client.buyOffer(offerId);
  const result = cem.sync(client.buildSyncRequest(), T0 + 600_000);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.kind, 'partial');
    // seq 1 = START, seq 2 = COLLECT, seq 3 = der verlorene Kauf. Das Warten
    // dazwischen ist kein Command — es stellt nur die Uhr.
    assert.equal(result.rejectedFrom, 3, 'abgeschnitten wurde an der falschen Stelle');
  }
  assert.equal(count(cem.snapshot.state, WHEAT), 10, 'Cems eigene Ernte ist mit verworfen worden');
});

test('offline zurückziehen verliert gegen einen echten Kauf', () => {
  // Der unangenehmste Fall überhaupt: Anna zieht ihren Auftrag im Funkloch
  // zurück, während Ben ihn längst gekauft hat. Nur eine Seite kann gewinnen —
  // und es muss die sein, auf der jemand bezahlt hat.
  const { market, live } = setup();
  const anna = farm(market, live, 'anna', 0, 20);
  const ben = farm(market, live, 'ben', 500);

  play(anna, (c) => c.listOrder(WHEAT, 10, 3));
  publishOrders(market, 'anna', anna);

  // Anna geht offline: Ihr Client behält den Snapshot MIT dem Auftrag.
  const annaOffline = new Client(anna.snapshot);

  // Anna ist nicht mehr „live" — der Verkauf bleibt beim Markt liegen.
  live.delete('anna');
  ben.stockOffers();
  play(ben, (c) => c.buyOffer(ben.snapshot.state.offers[0]!.id));
  assert.equal(market.peekSettlements('anna').length, 1, 'der Verkauf ist nirgends vermerkt');

  // Im Funkloch zieht Anna zurück — lokal geht das, sie weiß es ja nicht besser.
  annaOffline.advanceClock(30);
  assert.equal(annaOffline.cancelOrder(1).ok, true);
  assert.equal(count(annaOffline.preview(), WHEAT), 20, 'lokal ist die Ware nicht zurück');

  // Beim Sync wird abgerechnet, BEVOR nachgerechnet wird.
  settleSales(market, 'anna', anna);
  const result = anna.sync(annaOffline.buildSyncRequest(), T0 + 120_000);

  assert.equal(result.ok, false, 'das Zurückziehen wurde übernommen');
  if (!result.ok) assert.match(result.reason, /NO_SUCH_ORDER/);

  // Und jetzt der eigentliche Punkt: Die zehn Weizen gibt es genau einmal.
  const total = count(anna.snapshot.state, WHEAT) + count(ben.snapshot.state, WHEAT);
  assert.equal(total, 20, `Ware verdoppelt oder verloren: ${total} statt 20`);
  assert.equal(count(anna.snapshot.state, WHEAT), 10, 'Anna hat ihren Rest nicht');
  assert.equal(count(ben.snapshot.state, WHEAT), 10, 'Ben hat seinen Kauf nicht');
});

test('ein Verkauf löst keinen Divergenz-Fehlalarm aus', () => {
  // Der Zustand hat sich unter dem Client geändert, ohne dass er etwas falsch
  // gemacht hätte. Ein Alarm hier wäre eine Fehlermeldung über einen Bug, den
  // es nicht gibt — und würde echte Alarme im Rauschen ersticken (R1).
  const { market, live } = setup();
  const anna = farm(market, live, 'anna', 0, 20);
  const ben = farm(market, live, 'ben', 500);

  play(anna, (c) => c.listOrder(WHEAT, 10, 3));
  publishOrders(market, 'anna', anna);

  const annaOffline = new Client(anna.snapshot);
  live.delete('anna');
  ben.stockOffers();
  play(ben, (c) => c.buyOffer(ben.snapshot.state.offers[0]!.id));

  // Anna spielt offline etwas völlig Unverfängliches.
  annaOffline.start(0, R_WHEAT);
  annaOffline.advanceClock(rules.recipes[R_WHEAT]!.durationTicks);
  annaOffline.collect(0);

  settleSales(market, 'anna', anna);
  const result = anna.sync(annaOffline.buildSyncRequest(), T0 + 600_000);

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.divergence, null, 'Kanarienvogel hat falsch angeschlagen');
  assert.equal(anna.divergenceAlerts.length, 0, 'ein Alarm ist im Monitoring gelandet');

  // Und beim nächsten Sync ist er wieder scharf.
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

  // Zweimal abgleichen darf nicht zwei Angebote ergeben.
  publishOrders(market, 'anna', anna);
  assert.equal(market.size, 1, 'derselbe Auftrag steht doppelt im Buch');

  // Zurückgezogen → raus aus dem Buch. Sonst könnte jemand Ware kaufen, die
  // niemand mehr hat.
  play(anna, (c) => c.cancelOrder(1), T0 + 120_000);
  publishOrders(market, 'anna', anna);
  assert.equal(market.size, 0, 'das Angebot steht noch im Buch');
});

test('ein verfallener Auftrag verschwindet auch aus dem Buch', () => {
  const { market, live } = setup();
  const anna = farm(market, live, 'anna', 0, 20);

  play(anna, (c) => c.listOrder(WHEAT, 10, 3));
  publishOrders(market, 'anna', anna);
  assert.equal(market.size, 1);

  // Weit über die Frist hinausspielen — der Auftrag fällt ins Postfach (§8).
  const client = new Client(anna.snapshot);
  client.advanceClock(rules.orderTtlTicks + 10);
  client.collectMail();
  anna.sync(client.buildSyncRequest(), T0 + (rules.orderTtlTicks + 100) * 1000);

  assert.equal(anna.snapshot.state.orders.length, 0, 'der Auftrag lebt noch');
  publishOrders(market, 'anna', anna);
  assert.equal(market.size, 0, 'ein verfallener Auftrag steht weiter zum Verkauf');
});

test('niemand kauft bei sich selbst', () => {
  // Sonst wäre es eine Geldpresse: Gold zurück, Ware zurück, Auftrag weg.
  const { market, live } = setup();
  const anna = farm(market, live, 'anna', 500, 20);

  play(anna, (c) => c.listOrder(WHEAT, 10, 3));
  publishOrders(market, 'anna', anna);

  // Die Auslage zeigt es ihr gar nicht erst …
  anna.stockOffers();
  assert.equal(anna.snapshot.state.offers.length, 0);

  // … und selbst wenn die Nummer bekannt wäre, lehnt der Markt ab.
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

    // Ein Verkauf, der noch nicht abgerechnet ist — das ist der Teil, dessen
    // Verlust wirklich wehtäte: Ben hätte bezahlt und Anna nichts bekommen.
    // Deshalb wird er sofort geschrieben und nicht gesammelt.
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
    // Kein `flush` nötig: Ein eingestelltes Angebot geht sofort durch. Sonst
    // wäre es sichtbar, aber nicht kaufbar — der Kauf wird im Speicher
    // entschieden, nicht in der Auslage.
    assert.equal(market.flush(), 0, 'das Angebot wartet noch aufs Schreiben');
    db.close();

    const again = new Market(new SqliteStorage(join(dir, 'spiel.db')));
    assert.equal(again.size, 1);
    assert.equal(again.browse('ben', 10)[0]!.amount, 10);
    // Die Nummernvergabe läuft weiter, statt bei 1 neu zu beginnen — sonst
    // bekäme ein neues Angebot die Nummer eines alten.
    again.reconcile('cem', [{ id: 1, item: WHEAT, amount: 5, price: 3, listedAt: 0 }], T0);
    assert.notEqual(again.browse('anna', 10)[0]!.id, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Verfallen, während man weg war — und zwar über den echten Weg.
 *
 * Die Sim-Tests stellen die Uhr direkt. Im Betrieb passiert es anders: Der
 * Verkäufer ist zwei Tage offline, kommt zurück, und seine Spielzeit springt
 * beim ersten Command nach vorn. Erst dabei greift die Frist.
 *
 * Geprüft wird die Frage, die für die Wirtschaft zählt: **Wird die Ware
 * vernichtet?** Nein — sie kommt zurück, und zwar durchs Postfach.
 */
test('ein Auftrag, der im Funkloch abläuft, gibt die Ware zurück', () => {
  const { market, live } = setup();
  const anna = farm(market, live, 'anna', 0, 30);

  play(anna, (c) => c.listOrder(WHEAT, 20, 3));
  publishOrders(market, 'anna', anna);
  assert.equal(count(anna.snapshot.state, WHEAT), 10, 'Escrow hat nichts genommen');
  assert.equal(market.size, 1);

  // Zwei Tage später meldet sich Anna wieder — mehr als die Ablauffrist.
  const later = rules.orderTtlTicks + 500;
  const client = new Client(anna.snapshot);
  client.advanceClock(later);
  client.start(1, R_WHEAT);
  const result = anna.sync(client.buildSyncRequest(), T0 + (later + 60) * 1000);
  assert.equal(result.ok, true);

  // Die Ware ist weder im Nichts noch im Lager, sondern im Postfach (§7).
  assert.equal(anna.snapshot.state.orders.length, 0, 'der Auftrag lebt noch');
  const returned = anna.snapshot.state.mail.find((m) => m.item === WHEAT);
  assert.equal(returned?.amount, 20, 'die Ware ist nicht zurückgekommen');

  // Und niemand kann sie mehr kaufen.
  publishOrders(market, 'anna', anna);
  assert.equal(market.size, 0, 'ein verfallener Auftrag steht weiter zum Verkauf');

  // Abholen bringt sie ins Lager — die Bilanz ist wieder bei 30.
  const pickup = new Client(anna.snapshot);
  pickup.advanceClock(5);
  pickup.collectMail();
  anna.sync(pickup.buildSyncRequest(), T0 + (later + 120) * 1000);
  assert.equal(count(anna.snapshot.state, WHEAT), 30, 'unterm Strich fehlt Ware');
});

/**
 * DER GEFÄHRLICHE FALL: verkauft UND abgelaufen.
 *
 * Der Verkäufer ist so lange weg, dass sein Auftrag verfallen wäre — aber
 * jemand hat ihn vorher gekauft. Beide Wege wollen dieselbe Ware anfassen:
 * Der Verkauf gibt sie dem Käufer, die Frist gäbe sie dem Verkäufer zurück.
 * Passierte beides, gäbe es sie zweimal.
 */
test('verkauft schlägt abgelaufen — die Ware gibt es genau einmal', () => {
  const { market, live } = setup();
  const anna = farm(market, live, 'anna', 0, 30);
  const ben = farm(market, live, 'ben', 500);

  play(anna, (c) => c.listOrder(WHEAT, 20, 3));
  publishOrders(market, 'anna', anna);

  // Anna verschwindet. Ben kauft.
  live.delete('anna');
  ben.stockOffers();
  play(ben, (c) => c.buyOffer(ben.snapshot.state.offers[0]!.id));
  assert.equal(count(ben.snapshot.state, WHEAT), 20);

  // Anna kommt erst weit NACH der Ablauffrist zurück.
  const later = rules.orderTtlTicks + 500;
  settleSales(market, 'anna', anna);
  const client = new Client(anna.snapshot);
  client.advanceClock(later);
  client.start(1, R_WHEAT);
  anna.sync(client.buildSyncRequest(), T0 + (later + 60) * 1000);

  // Kein Weizen zurück ins Postfach — er gehört Ben.
  const wheatInMail = anna.snapshot.state.mail
    .filter((m) => m.item === WHEAT)
    .reduce((n, m) => n + m.amount, 0);
  assert.equal(wheatInMail, 0, 'die verkaufte Ware kam dem Verkäufer zurück');

  // Die Gegenprobe über beide Höfe: 30 waren es, 30 sind es.
  const total =
    count(anna.snapshot.state, WHEAT) + wheatInMail + count(ben.snapshot.state, WHEAT);
  assert.equal(total, 30, `Ware verdoppelt oder verloren: ${total} statt 30`);

  // Und das Geld ist trotzdem angekommen.
  const gold = anna.snapshot.state.mail.find((m) => m.item === GOLD);
  assert.equal(gold?.amount, 60, 'Anna hat ihren Erlös nicht bekommen');
});

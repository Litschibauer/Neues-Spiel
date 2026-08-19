import test from 'node:test';
import assert from 'node:assert/strict';
import { Market, publishOrders, settleSales } from '../src/server/market.ts';
import { Server } from '../src/server/server.ts';
import { Client } from '../src/client/client.ts';
import { LATEST_RULESET_VERSION, getRuleset, offerLimits } from '../src/sim/rules.ts';
import { count, initialState } from '../src/sim/state.ts';
import { advanceTo, simulate } from '../src/sim/sim.ts';
import { assertInvariants } from '../src/sim/migrate.ts';
import { farmView } from '../src/client/view.ts';

const T0 = 1_700_000_000_000;
const RULES = getRuleset(LATEST_RULESET_VERSION);
const GOLD = RULES.currency;
const WHEAT = RULES.items.findIndex((i) => i.id === 'wheat');

function hof(gold: number, weizen: number) {
  const base = initialState(RULES);
  const items = base.items.map(() => 0);
  items[GOLD] = gold;
  items[WHEAT] = weizen;
  return { ...base, items };
}

function verkaufe(): { server: Server; markt: Market; kaeufer: Server } {
  const markt = new Market(null);
  const server = new Server(hof(1000, 20), T0, LATEST_RULESET_VERSION);
  const kaeufer = new Server(hof(10_000, 0), T0, LATEST_RULESET_VERSION);

  const client = new Client(server.snapshot);
  const preis = offerLimits(RULES, WHEAT).minPrice;
  assert.equal(client.listOrder(WHEAT, 5, preis).ok, true);
  const res = server.sync(client.buildSyncRequest(), T0);
  assert.equal(res.ok, true);

  publishOrders(markt, 'anna', server);
  const eintrag = markt.entries()[0]!;
  assert.ok(markt.claim(eintrag.id, 'ben', T0));
  settleSales(markt, 'anna', server);

  return { server, markt, kaeufer };
}

test('verkauftes Gold bleibt im Kästchen, statt ins Postfach zu wandern', () => {
  const { server } = verkaufe();
  const state = server.snapshot.state;

  assert.equal(state.orders.length, 1, 'das Kästchen ist einfach verschwunden');
  assert.ok(state.orders[0]!.verkauft > 0, 'im Kästchen liegt kein Erlös');
  assert.equal(
    server.pendingDeliveries.filter((d) => d.item === GOLD).length,
    0,
    'das Gold liegt trotzdem im Postfach',
  );
  assertInvariants(state, RULES);
});

test('ein Tipp holt das Gold ab und macht das Kästchen frei', () => {
  const { server } = verkaufe();
  const vorher = server.snapshot.state;
  const erloes = vorher.orders[0]!.verkauft;
  const gold = count(vorher, GOLD);

  const nachher = simulate(
    vorher,
    { seq: 1, tick: vorher.tick, type: 'COLLECT_SALE', orderId: vorher.orders[0]!.id },
    RULES,
  );

  assert.equal(count(nachher, GOLD), gold + erloes);
  assert.equal(nachher.orders.length, 0, 'das Kästchen bleibt belegt');
});

test('ein verkauftes Kästchen lässt sich nicht mehr zurückholen', () => {
  const { server } = verkaufe();
  const state = server.snapshot.state;
  assert.throws(
    () =>
      simulate(
        state,
        { seq: 1, tick: state.tick, type: 'CANCEL_ORDER', orderId: state.orders[0]!.id },
        RULES,
      ),
    { code: 'ALREADY_SOLD' },
  );
});

test('was noch nicht verkauft ist, gibt auch kein Gold her', () => {
  const markt = new Market(null);
  const server = new Server(hof(1000, 20), T0, LATEST_RULESET_VERSION);
  const client = new Client(server.snapshot);
  client.listOrder(WHEAT, 5, offerLimits(RULES, WHEAT).minPrice);
  server.sync(client.buildSyncRequest(), T0);
  publishOrders(markt, 'anna', server);

  const state = server.snapshot.state;
  assert.throws(
    () =>
      simulate(
        state,
        { seq: 1, tick: state.tick, type: 'COLLECT_SALE', orderId: state.orders[0]!.id },
        RULES,
      ),
    { code: 'NOT_SOLD' },
  );
});

test('das verkaufte Kästchen steht nicht wieder im Marktbuch', () => {
  const { server, markt } = verkaufe();
  assert.equal(markt.size, 0, 'das Angebot ist zurück im Buch');

  publishOrders(markt, 'anna', server);
  assert.equal(markt.size, 0, 'der Abgleich stellt das verkaufte Kästchen wieder hin');
});

test('ein verkauftes Kästchen läuft nicht ab', () => {
  const { server } = verkaufe();
  const state = server.snapshot.state;
  const weit = RULES.orderTtlTicks > 0 ? RULES.orderTtlTicks * 3 : 100_000;

  const spaeter = advanceTo(state, state.tick + weit, RULES);
  assert.equal(spaeter.orders.length, 1, 'der Erlös ist verfallen');
  assert.ok(spaeter.orders[0]!.verkauft > 0);
});

test('die Oberfläche zeigt den Erlös am Kästchen', () => {
  const { server } = verkaufe();
  const v = farmView(server.snapshot.state, RULES);

  assert.equal(v.orders.length, 1);
  assert.ok(v.orders[0]!.sold > 0);
  assert.equal(v.orders[0]!.expiresIn, null, 'ein verkauftes Kästchen zeigt noch eine Restzeit');
  assert.equal(v.orderSlotsFree, RULES.orderSlots - 1, 'der Platz gilt schon als frei');
});

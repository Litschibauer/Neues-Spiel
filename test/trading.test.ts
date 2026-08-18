import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, DISCARD_QUEUE } from '../src/client/client.ts';
import { Server } from '../src/server/server.ts';
import { getRuleset, CURRENT_RULESET_VERSION } from '../src/sim/rules.ts';
import { EMPTY_PLOT, initialState, count, stored, totalGoods } from '../src/sim/state.ts';
import { advanceTo, simulate } from '../src/sim/sim.ts';
import { assertInvariants } from '../src/sim/migrate.ts';
import { mulberry32 } from './helpers/session.ts';

const T0 = 1_700_000_000_000;
const rules = getRuleset(CURRENT_RULESET_VERSION);

const GOLD = 0;
const WHEAT = 1;
const EGGS = 3;
const R_WHEAT = 0;
const EGG_PRICE = rules.items[EGGS]!.npcPrice;
const GROW = rules.recipes[R_WHEAT]!.durationTicks;
const YIELD = rules.recipes[R_WHEAT]!.output.amount;
const SEED = rules.recipes[R_WHEAT]!.inputs.find((i) => i.item === WHEAT)?.amount ?? 0;

const AFTER_ONE_HARVEST =
  (rules.startingItems.find((x) => x.item === WHEAT)?.amount ?? 0) - SEED + YIELD;

function bare() {
  const base = initialState(rules);
  return { ...base, items: base.items.map(() => 0) };
}

function fullSilo() {
  const base = bare();
  const items = base.items.slice();
  items[EGGS] = rules.siloCapacity;

  items[GOLD] = 10_000;
  return { ...base, items };
}

function withEggs(amount: number) {
  const base = bare();
  const items = base.items.slice();
  items[EGGS] = amount;
  items[GOLD] = 10_000;
  return { ...base, items };
}

test('Verkaufen ist einseitig und funktioniert offline', () => {
  const server = new Server(withEggs(10), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  const res = client.sellNpc(EGGS, 1);
  assert.equal(res.ok, true);

  assert.equal(client.listOrder(EGGS, 5, EGG_PRICE).ok, true);

  assert.equal(count(client.state, EGGS), 4);
  assert.equal(client.state.orders.length, 1);
  assert.equal(client.state.orders[0]!.amount, 5);

  assert.equal(totalGoods(client.state, rules), 9);
});

test('Münzen sind ein Gegenstand, aber kein Lagerplatz', () => {
  const client = new Client({
    state: fullSilo(),
    seq: 0,
    serverTs: T0,
    rulesetVersion: CURRENT_RULESET_VERSION,
  });

  assert.equal(stored(client.state, rules), rules.siloCapacity);
  const goldBefore = count(client.state, GOLD);
  assert.equal(client.sellNpc(EGGS, 10).ok, true);
  assert.equal(count(client.state, GOLD) - goldBefore, 10 * EGG_PRICE);

  assert.equal(stored(client.state, rules), rules.siloCapacity - 10);

  const sellGold = client.sellNpc(GOLD, 1);
  assert.equal(sellGold.ok, false);
  if (sellGold.ok) return;
  assert.equal(sellGold.code, 'NOT_SELLABLE');
});

function runStashAttack(rounds: number) {
  const start = initialState(rules);
  const items = start.items.slice();
  items[GOLD] = 1_000_000;
  const client = new Client({
    state: { ...start, items },
    seq: 0,
    serverTs: T0,
    rulesetVersion: CURRENT_RULESET_VERSION,
  });

  for (let round = 0; round < rounds; round++) {
    const s = client.preview();
    const have = count(s, WHEAT);
    if (have > 0) client.listOrder(WHEAT, Math.min(have, 20), rules.items[WHEAT]!.npcPrice);
    for (let plot = 0; plot < 3; plot++) client.start(plot, R_WHEAT);
    client.advanceClock(GROW);
    for (let plot = 0; plot < 3; plot++) client.collect(plot);

    if (count(client.preview(), WHEAT) < 3) client.buyNpc(WHEAT, 6);
  }
  return client.preview();
}

test('DER EXPLOIT: Escrow lässt sich nicht als unendliches Lager missbrauchen', () => {
  const short = runStashAttack(2);
  const long = runStashAttack(400);
  const absurd = runStashAttack(900);

  assert.ok(
    totalGoods(long, rules) > totalGoods(short, rules),
    'die Testkulisse läuft überhaupt voll',
  );
  assert.equal(
    totalGoods(absurd, rules),
    totalGoods(long, rules),
    'Gesamtmenge wächst weiter — Escrow ist ein Leck',
  );

  assert.equal(absurd.orders.length, rules.orderSlots);
  assert.equal(absurd.mail.length, 0, 'ohne Frist darf nichts ins Postfach zurückfallen');

  assert.ok(
    stored(absurd, rules) > rules.siloCapacity - YIELD,
    `Lager nicht am Anschlag: ${stored(absurd, rules)}`,
  );
  assert.ok(stored(absurd, rules) <= rules.siloCapacity);
  assertInvariants(absurd, rules);

  const ceiling = rules.siloCapacity + rules.orderSlots * rules.siloCapacity;
  assert.ok(
    totalGoods(absurd, rules) <= ceiling,
    `über der rechnerischen Grenze: ${totalGoods(absurd, rules)} > ${ceiling}`,
  );
});

test('Parken kostet — der Angriff bezahlt jedes Hinlegen', () => {
  const before = 1_000_000;
  const after = count(runStashAttack(400), GOLD);
  assert.ok(after < before, 'die Einstellgebühr hat nichts gekostet');
});

test('bei vollen Behältern ist auch kein neuer Auftrag mehr möglich', () => {
  const saturated = runStashAttack(12000);
  const client = new Client({
    state: saturated,
    seq: 0,
    serverTs: T0,
    rulesetVersion: CURRENT_RULESET_VERSION,
  });

  const blocked = client.listOrder(EGGS, 1, EGG_PRICE);
  assert.equal(blocked.ok, false);
  if (blocked.ok) return;
  assert.equal(blocked.code, 'NO_ORDER_SLOTS');
});

test('Preisband verhindert das Parken zu Fantasiepreisen', () => {
  const client = new Client({
    state: fullSilo(),
    seq: 0,
    serverTs: T0,
    rulesetVersion: CURRENT_RULESET_VERSION,
  });

  const tooHigh = client.listOrder(EGGS, 5, EGG_PRICE * 10);
  assert.equal(tooHigh.ok, false);
  if (tooHigh.ok) return;
  assert.equal(tooHigh.code, 'PRICE_OUT_OF_BAND');

  assert.equal(client.listOrder(EGGS, 5, 0).ok, false);

  assert.equal(client.listOrder(EGGS, 5, EGG_PRICE).ok, true);
});

test('Auftrag zurückziehen gibt die Ware zurück — aber nicht über das Limit', () => {
  const server = new Server(withEggs(10), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  assert.equal(client.listOrder(EGGS, 8, EGG_PRICE).ok, true);
  const id = client.state.orders[0]!.id;

  assert.equal(client.cancelOrder(id).ok, true);
  assert.equal(count(client.state, EGGS), 10);
  assert.equal(client.state.orders.length, 0);

  const full = new Client({
    state: {
      ...fullSilo(),
      orders: [{ id: 1, item: EGGS, amount: 10, price: 5, listedAt: 0 }],
      nextOrderId: 2,
    },
    seq: 0,
    serverTs: T0,
    rulesetVersion: CURRENT_RULESET_VERSION,
  });
  const blocked = full.cancelOrder(1);
  assert.equal(blocked.ok, false);
  if (blocked.ok) return;
  assert.equal(blocked.code, 'SILO_FULL');
});

const withTtl = { ...rules, orderTtlTicks: 86_400 };

test('mit Frist landen verfallene Aufträge im Postfach statt im Nichts', () => {
  let s = withEggs(10);
  s = advanceTo(s, 6000, withTtl);
  s = simulate(
    s,
    { seq: 1, tick: 6000, type: 'LIST_ORDER', item: EGGS, amount: 6, price: EGG_PRICE },
    withTtl,
  );
  assert.equal(s.orders.length, 1);

  s = advanceTo(s, 6000 + withTtl.orderTtlTicks, withTtl);

  assert.equal(s.orders.length, 0);
  assert.equal(s.mail.length, 1);
  assert.equal(s.mail[0]!.amount, 6);
  assertInvariants(s, withTtl);
});

test('OHNE Frist bleibt eingestellte Ware liegen — Parken kostet Gebühr, nicht Zeit', () => {
  let s = withEggs(10);
  s = simulate(
    s,
    { seq: 1, tick: 0, type: 'LIST_ORDER', item: EGGS, amount: 6, price: EGG_PRICE },
    rules,
  );
  assert.equal(rules.orderTtlTicks, 0, 'die Produktionsregel hat wieder eine Frist');

  s = advanceTo(s, 100 * 86_400, rules);
  assert.equal(s.orders.length, 1, 'der Auftrag ist verfallen');
  assert.equal(s.mail.length, 0);
  assertInvariants(s, rules);
});

test('Einstellen kostet eine Gebühr — sofort und unabhängig vom Verkauf', () => {
  const before = withEggs(10);
  const goldBefore = count(before, GOLD);
  const s = simulate(
    before,
    { seq: 1, tick: 0, type: 'LIST_ORDER', item: EGGS, amount: 10, price: EGG_PRICE },
    rules,
  );

  const expected = Math.ceil((EGG_PRICE * 10 * rules.listingFeePct) / 100);
  assert.ok(expected > 0, 'die Gebühr rundet auf null ab');
  assert.equal(goldBefore - count(s, GOLD), expected);
});

test('ohne Geld für die Gebühr kommt nichts in die Auslage', () => {
  const base = bare();
  const items = base.items.slice();
  items[EGGS] = 10;
  const broke = { ...base, items };

  assert.throws(
    () =>
      simulate(
        broke,
        { seq: 1, tick: 0, type: 'LIST_ORDER', item: EGGS, amount: 10, price: EGG_PRICE },
        rules,
      ),
    /CANT_AFFORD/,
  );
});

test('ist das Postfach voll, bleibt der Auftrag stehen statt zu verfallen', () => {
  const mail = Array.from({ length: withTtl.mailCapacity }, () => ({
    item: WHEAT,
    amount: 1,
    arrivedAt: 0,
  }));
  let s = { ...withEggs(10), tick: 1000, mail };
  s = simulate(
    s,
    { seq: 1, tick: 1000, type: 'LIST_ORDER', item: EGGS, amount: 5, price: EGG_PRICE },
    withTtl,
  );

  s = advanceTo(s, 1000 + withTtl.orderTtlTicks + 100, withTtl);

  assert.equal(s.orders.length, 1);
  assert.equal(s.mail.length, withTtl.mailCapacity);
  assertInvariants(s, withTtl);
});

test('Postfach abholen nimmt mit, was ins Lager passt — der Rest bleibt liegen', () => {
  const base = bare();
  const withGoods = base.items.slice();
  withGoods[EGGS] = rules.siloCapacity - 4;
  let s: ReturnType<typeof bare> = { ...base, items: withGoods };
  const space = rules.siloCapacity - stored(s, rules);

  s = {
    ...s,
    mail: [
      { item: GOLD, amount: 50, arrivedAt: 0 },
      { item: EGGS, amount: space, arrivedAt: 0 },
      { item: EGGS, amount: 10, arrivedAt: 0 },
    ],
  };

  s = simulate(s, { seq: 1, tick: 0, type: 'COLLECT_MAIL' }, rules);

  assert.equal(count(s, GOLD), 50, 'Gold passt immer');
  assert.equal(stored(s, rules), rules.siloCapacity);
  assert.equal(s.mail.length, 1, 'der Rest wartet weiter');
  assertInvariants(s, rules);
});

test('externe Zustellung landet im Postfach — und löst keinen Fehlalarm aus', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  client.start(0, R_WHEAT);
  client.advanceClock(GROW);
  client.collect(0);

  server.deliver({ item: EGGS, amount: 5, arrivedAt: T0 });

  const res = server.sync(client.buildSyncRequest(), T0 + GROW * 1000);

  assert.equal(res.ok, true);
  if (!res.ok) return;

  assert.equal(res.divergence, false);
  assert.deepEqual(server.divergenceAlerts, []);

  assert.equal(res.snapshot.state.mail.length, 1);
  assert.equal(res.snapshot.state.mail[0]!.amount, 5);

  assert.equal(count(res.snapshot.state, EGGS), 0);
  assert.equal(count(res.snapshot.state, WHEAT), AFTER_ONE_HARVEST);
});

test('Zustellungen bei vollem Postfach gehen nicht verloren', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  for (let i = 0; i < rules.mailCapacity + 5; i++) {
    server.deliver({ item: WHEAT, amount: 1, arrivedAt: T0 });
  }

  const client = new Client(server.snapshot);
  client.start(0, R_WHEAT);
  client.advanceClock(10);
  const res = server.sync(client.buildSyncRequest(), T0 + 10_000);

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.snapshot.state.mail.length, rules.mailCapacity);

  assert.equal(server.pendingDeliveries.length, 5);
  assertInvariants(res.snapshot.state, rules);
});

test('Behälter-Invariante hält über zufällige Handelssitzungen', () => {
  for (let seed = 1; seed <= 150; seed++) {
    const rnd = mulberry32(seed);
    const pick = (n: number) => Math.floor(rnd() * n);
    const server = new Server(withEggs(20), T0, CURRENT_RULESET_VERSION);
    const client = new Client(server.snapshot);

    for (let step = 0; step < 40; step++) {
      const s = client.preview();
      switch (pick(6)) {
        case 0:
          client.advanceClock(1 + pick(30_000));
          break;
        case 1:
          client.start(pick(3), R_WHEAT);
          break;
        case 2:
          client.collect(pick(3));
          break;
        case 3: {
          const eggs = count(s, EGGS);
          const wheat = count(s, WHEAT);
          if (eggs > 0) client.listOrder(EGGS, 1 + pick(eggs), 1 + pick(7));
          else if (wheat > 0) client.listOrder(WHEAT, 1 + pick(wheat), 1 + pick(4));
          break;
        }
        case 4:
          if (s.orders.length > 0) client.cancelOrder(s.orders[pick(s.orders.length)]!.id);
          break;
        default:
          client.collectMail();
          break;
      }

      const now = client.preview();
      assert.ok(now.orders.length <= rules.orderSlots, `seed=${seed}: Slots überschritten`);
      assert.ok(now.mail.length <= rules.mailCapacity, `seed=${seed}: Postfach überschritten`);
      assert.ok(stored(now, rules) <= rules.siloCapacity, `seed=${seed}: Lager überschritten`);
      assertInvariants(now, rules);
    }

    if (client.queue.length > 0) {
      const res = server.sync(client.buildSyncRequest(), T0 + client.localTick * 1000);
      assert.equal(res.ok, true, `seed=${seed}: Server lehnt legale Sitzung ab`);
      if (res.ok) assert.equal(res.divergence, false, `seed=${seed}: Kanarienvogel`);
    }
  }
});

test('Admin-Zeitgutschrift löst keinen Divergenz-Fehlalarm aus', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  client.start(0, R_WHEAT);
  const first = server.sync(client.buildSyncRequest(), T0 + 1000);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  client.adopt(first.snapshot, DISCARD_QUEUE);

  server.grantTime(GROW);
  client.adopt(server.snapshot, DISCARD_QUEUE);

  client.advanceClock(GROW);
  assert.equal(client.collect(0).ok, true, 'Platz muss durch die Zeitgutschrift fertig sein');

  const res = server.sync(client.buildSyncRequest(), T0 + 1000);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.divergence, false, 'Kanarienvogel darf nicht anschlagen');
  assert.deepEqual(server.divergenceAlerts, []);
  assert.equal(count(res.snapshot.state, WHEAT), AFTER_ONE_HARVEST);
});

test('Zurücksetzen hinterlässt einen sauberen, leeren Hof', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);
  client.start(0, R_WHEAT);
  server.sync(client.buildSyncRequest(), T0 + 1000);
  server.deliver({ item: EGGS, amount: 5, arrivedAt: T0 });
  assert.equal(server.snapshot.state.plots[0]!.recipe, R_WHEAT);

  server.reset(initialState(rules), T0 + 5000, CURRENT_RULESET_VERSION);

  assert.equal(server.snapshot.seq, 0);
  assert.equal(server.appliedLog.length, 0);
  assert.equal(server.pendingDeliveries.length, 0);
  assert.equal(server.snapshot.state.plots[0]!.recipe, EMPTY_PLOT);
  assertInvariants(server.snapshot.state, rules);

  const fresh = new Client(server.snapshot);
  assert.equal(fresh.start(0, R_WHEAT).ok, true);
  assert.equal(server.sync(fresh.buildSyncRequest(), T0 + 6000).ok, true);
});

/**
 * Escrow, Auftrags-Slots und Postfach (Architektur §7, §8).
 *
 * Der Kern hier ist der Exploit, den das Escrow selbst erst aufreißt:
 * Ware zu einem unverkäuflichen Preis einstellen, Lager leert sich,
 * weiterproduzieren, wiederholen — und schon ist das Lagerlimit bedeutungslos
 * und mit ihm die Inflationsbremse.
 *
 * Getestet wird deshalb nicht nur „Handel funktioniert", sondern vor allem:
 * **jeder Behälter ist gedeckelt.**
 */

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

/** Spielstand mit vollem Lager, um am Limit zu testen. */
function fullSilo() {
  const base = initialState(rules);
  const items = base.items.slice();
  items[EGGS] = rules.siloCapacity;
  return { ...base, items };
}

/** Spielstand mit Eiern im Lager und ein paar Feldern — der Handelsalltag. */
function withEggs(amount: number) {
  const base = initialState(rules);
  const items = base.items.slice();
  items[EGGS] = amount;
  return { ...base, items };
}

test('Verkaufen ist einseitig und funktioniert offline', () => {
  const server = new Server(withEggs(10), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  const res = client.sellNpc(EGGS, 1);
  assert.equal(res.ok, true);

  assert.equal(client.listOrder(EGGS, 5, EGG_PRICE).ok, true);

  // Escrow: Die Ware hat das Lager verlassen, ist aber noch nicht verkauft.
  assert.equal(count(client.state, EGGS), 4);
  assert.equal(client.state.orders.length, 1);
  assert.equal(client.state.orders[0]!.amount, 5);
  // Nichts entstanden, nichts verschwunden.
  assert.equal(totalGoods(client.state, rules), 9);
});

test('Münzen sind ein Gegenstand, aber kein Lagerplatz', () => {
  // Gold liegt im selben Inventar wie alles andere — es ist nur nicht
  // lagerpflichtig. Damit braucht das Postfach keinen Sonderfall für Geld.
  const client = new Client({
    state: fullSilo(),
    seq: 0,
    serverTs: T0,
    rulesetVersion: CURRENT_RULESET_VERSION,
  });

  assert.equal(stored(client.state, rules), rules.siloCapacity);
  assert.equal(client.sellNpc(EGGS, 10).ok, true);
  assert.equal(count(client.state, GOLD), 10 * EGG_PRICE);
  // Das Gold zählt nicht mit — sonst wäre das Lager sofort wieder voll.
  assert.equal(stored(client.state, rules), rules.siloCapacity - 10);

  // Und Münzen selbst kann man weder verkaufen noch einstellen.
  const sellGold = client.sellNpc(GOLD, 1);
  assert.equal(sellGold.ok, false);
  if (sellGold.ok) return;
  assert.equal(sellGold.code, 'NOT_SELLABLE');
});

/**
 * Der Angriff: einstellen, Lager leert sich, nachproduzieren, wiederholen.
 *
 * Nachschub kommt aus den drei Startfeldern — mehr hat ein frischer Hof nicht,
 * und genau das macht den Angriff realistisch. Geparkt wird Weizen, weil er
 * nachwächst; Eier wären nach ein paar Runden alle.
 */
function runStashAttack(rounds: number) {
  const client = new Client({
    state: initialState(rules),
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
  }
  return client.preview();
}

test('DER EXPLOIT: Escrow lässt sich nicht als unendliches Lager missbrauchen', () => {
  // Wichtig: Der Riegel ist NICHT „nach 4 Aufträgen ist Schluss". Aufträge
  // verfallen ja und geben ihren Slot wieder frei. Der Riegel ist, dass die
  // Kette dahinter ebenfalls gedeckelt ist — Slots UND Postfach.
  //
  // Die zu prüfende Eigenschaft ist deshalb Sättigung, nicht Blockade:
  // Ab irgendwann bringt Weiterspielen des Angriffs nichts mehr.
  const short = runStashAttack(20);
  const long = runStashAttack(8000);
  const absurd = runStashAttack(12000);

  assert.ok(
    totalGoods(long, rules) > totalGoods(short, rules),
    'die Testkulisse läuft überhaupt voll',
  );
  assert.equal(
    totalGoods(absurd, rules),
    totalGoods(long, rules),
    'Gesamtmenge wächst weiter — Escrow ist ein Leck',
  );

  // Alle Behälter stehen am Anschlag, keiner darüber.
  assert.equal(absurd.orders.length, rules.orderSlots);
  assert.equal(absurd.mail.length, rules.mailCapacity);
  assert.equal(stored(absurd, rules), rules.siloCapacity);
  assertInvariants(absurd, rules);

  // Und die Obergrenze ist die, die aus den Limits folgt — keine Überraschung.
  const ceiling = rules.siloCapacity + (rules.orderSlots + rules.mailCapacity) * 20;
  assert.ok(
    totalGoods(absurd, rules) <= ceiling,
    `über der rechnerischen Grenze: ${totalGoods(absurd, rules)} > ${ceiling}`,
  );
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
  // Innerhalb des Bandes geht es.
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

  // Bei vollem Lager blockiert die Rücknahme, statt das Limit zu umgehen.
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

test('verfallene Aufträge landen im Postfach statt im Nichts', () => {
  let s = withEggs(10);
  s = advanceTo(s, 6000, rules);
  s = simulate(
    s,
    { seq: 1, tick: 6000, type: 'LIST_ORDER', item: EGGS, amount: 6, price: EGG_PRICE },
    rules,
  );
  assert.equal(s.orders.length, 1);

  // Über die Ablauffrist hinaus warten.
  s = advanceTo(s, 6000 + rules.orderTtlTicks, rules);

  assert.equal(s.orders.length, 0);
  assert.equal(s.mail.length, 1);
  assert.equal(s.mail[0]!.amount, 6);
  assertInvariants(s, rules);
});

test('ist das Postfach voll, bleibt der Auftrag stehen statt zu verfallen', () => {
  const mail = Array.from({ length: rules.mailCapacity }, () => ({
    item: WHEAT,
    amount: 1,
    arrivedAt: 0,
  }));
  let s = { ...withEggs(10), tick: 1000, mail };
  s = simulate(
    s,
    { seq: 1, tick: 1000, type: 'LIST_ORDER', item: EGGS, amount: 5, price: EGG_PRICE },
    rules,
  );

  s = advanceTo(s, 1000 + rules.orderTtlTicks + 100, rules);

  // Nichts vernichtet: Der Auftrag wartet, bis Platz da ist.
  assert.equal(s.orders.length, 1);
  assert.equal(s.mail.length, rules.mailCapacity);
  assertInvariants(s, rules);
});

test('Postfach abholen nimmt mit, was ins Lager passt — der Rest bleibt liegen', () => {
  let s = withEggs(rules.siloCapacity - 4); // fast voll
  const space = rules.siloCapacity - stored(s, rules);

  s = {
    ...s,
    mail: [
      { item: GOLD, amount: 50, arrivedAt: 0 },
      { item: EGGS, amount: space, arrivedAt: 0 },
      { item: EGGS, amount: 10, arrivedAt: 0 }, // passt nicht mehr
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

  // Während der Spieler offline war, schickt ein Nachbar ein Geschenk.
  server.deliver({ item: EGGS, amount: 5, arrivedAt: T0 });

  const res = server.sync(client.buildSyncRequest(), T0 + GROW * 1000);

  assert.equal(res.ok, true);
  if (!res.ok) return;
  // Entscheidend: KEIN Divergenz-Alarm. Der Kanarienvogel vergleicht die
  // Kausalkette des Spielers, das Geschenk kommt danach dazu.
  assert.equal(res.divergence, false);
  assert.deepEqual(server.divergenceAlerts, []);

  assert.equal(res.snapshot.state.mail.length, 1);
  assert.equal(res.snapshot.state.mail[0]!.amount, 5);
  // Und es liegt im Postfach, nicht im Lager: Der Spieler hat nur seinen
  // eigenen Weizen, von den Eiern weiß er noch nichts.
  assert.equal(count(res.snapshot.state, EGGS), 0);
  assert.equal(count(res.snapshot.state, WHEAT), YIELD);
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
  // Der Überhang wartet auf den nächsten Sync, statt zu verfallen.
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

    // Und der Server akzeptiert die Sitzung ohne Divergenz.
    if (client.queue.length > 0) {
      const res = server.sync(client.buildSyncRequest(), T0 + client.localTick * 1000);
      assert.equal(res.ok, true, `seed=${seed}: Server lehnt legale Sitzung ab`);
      if (res.ok) assert.equal(res.divergence, false, `seed=${seed}: Kanarienvogel`);
    }
  }
});

test('Admin-Zeitgutschrift löst keinen Divergenz-Fehlalarm aus', () => {
  // Ein Eingriff, der den ZUSTAND anfasst, würde beim nächsten Sync den
  // Kanarienvogel auslösen — der Client hätte ja anders gerechnet. Die
  // Zeitgutschrift verstellt deshalb nur die Uhr aus §4, nicht den Zustand.
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  client.start(0, R_WHEAT);
  const first = server.sync(client.buildSyncRequest(), T0 + 1000);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  client.adopt(first.snapshot, DISCARD_QUEUE);

  // Werkbank: die volle Wachstumszeit gutschreiben.
  server.grantTime(GROW);
  client.adopt(server.snapshot, DISCARD_QUEUE);

  // Der Client darf jetzt so weit vorspulen — und ernten.
  client.advanceClock(GROW);
  assert.equal(client.collect(0).ok, true, 'Platz muss durch die Zeitgutschrift fertig sein');

  const res = server.sync(client.buildSyncRequest(), T0 + 1000);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.divergence, false, 'Kanarienvogel darf nicht anschlagen');
  assert.deepEqual(server.divergenceAlerts, []);
  assert.equal(count(res.snapshot.state, WHEAT), YIELD);
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

  // Und ein frischer Client kann sofort weiterspielen.
  const fresh = new Client(server.snapshot);
  assert.equal(fresh.start(0, R_WHEAT).ok, true);
  assert.equal(server.sync(fresh.buildSyncRequest(), T0 + 6000).ok, true);
});

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
import { Client } from '../src/client/client.ts';
import { Server } from '../src/server/server.ts';
import { getRuleset, CURRENT_RULESET_VERSION } from '../src/sim/rules.ts';
import { initialState, stored, totalGoods } from '../src/sim/state.ts';
import { advanceTo, simulate } from '../src/sim/sim.ts';
import { assertInvariants } from '../src/sim/migrate.ts';
import { mulberry32 } from './helpers/session.ts';

const T0 = 1_700_000_000_000;
const rules = getRuleset(CURRENT_RULESET_VERSION);

/** Spielstand mit vollem Lager, um am Limit zu testen. */
function fullSilo() {
  return advanceTo(initialState(3), 60_000, rules);
}

test('Verkaufen ist einseitig und funktioniert offline', () => {
  const server = new Server(initialState(3), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  client.advanceClock(6000); // 10 Eier
  const res = client.sellNpc('eggs', 1);
  assert.equal(res.ok, true);

  assert.equal(client.listOrder('eggs', 5, rules.npcPrices.eggs).ok, true);

  // Escrow: Die Ware hat das Lager verlassen, ist aber noch nicht verkauft.
  assert.equal(client.state.eggs, 4);
  assert.equal(client.state.orders.length, 1);
  assert.equal(client.state.orders[0]!.amount, 5);
  // Nichts entstanden, nichts verschwunden.
  assert.equal(totalGoods(client.state), 9);
});

/** Der Angriff: einstellen, Lager leert sich, nachproduzieren, wiederholen. */
function runStashAttack(rounds: number) {
  const client = new Client({
    state: fullSilo(),
    seq: 0,
    serverTs: T0,
    rulesetVersion: CURRENT_RULESET_VERSION,
  });

  for (let round = 0; round < rounds; round++) {
    const s = client.preview();
    if (s.eggs > 0) client.listOrder('eggs', Math.min(s.eggs, 20), rules.npcPrices.eggs);
    client.advanceClock(60_000);
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
  const long = runStashAttack(200);
  const absurd = runStashAttack(2000);

  assert.ok(totalGoods(long) > totalGoods(short), 'die Testkulisse läuft überhaupt voll');
  assert.equal(
    totalGoods(absurd),
    totalGoods(long),
    'Gesamtmenge wächst weiter — Escrow ist ein Leck',
  );

  // Alle Behälter stehen am Anschlag, keiner darüber.
  assert.equal(absurd.orders.length, rules.orderSlots);
  assert.equal(absurd.mail.length, rules.mailCapacity);
  assert.equal(stored(absurd), rules.siloCapacity);
  assertInvariants(absurd, rules);

  // Und die Obergrenze ist die, die aus den Limits folgt — keine Überraschung.
  const ceiling = rules.siloCapacity + (rules.orderSlots + rules.mailCapacity) * 20;
  assert.ok(
    totalGoods(absurd) <= ceiling,
    `über der rechnerischen Grenze: ${totalGoods(absurd)} > ${ceiling}`,
  );
});

test('bei vollen Behältern ist auch kein neuer Auftrag mehr möglich', () => {
  const saturated = runStashAttack(2000);
  const client = new Client({
    state: saturated,
    seq: 0,
    serverTs: T0,
    rulesetVersion: CURRENT_RULESET_VERSION,
  });

  const blocked = client.listOrder('eggs', 1, rules.npcPrices.eggs);
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

  const ref = rules.npcPrices.eggs;
  const tooHigh = client.listOrder('eggs', 5, ref * 10);
  assert.equal(tooHigh.ok, false);
  if (tooHigh.ok) return;
  assert.equal(tooHigh.code, 'PRICE_OUT_OF_BAND');

  assert.equal(client.listOrder('eggs', 5, 0).ok, false);
  // Innerhalb des Bandes geht es.
  assert.equal(client.listOrder('eggs', 5, ref).ok, true);
});

test('Auftrag zurückziehen gibt die Ware zurück — aber nicht über das Limit', () => {
  const server = new Server(initialState(3), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  client.advanceClock(6000);
  assert.equal(client.listOrder('eggs', 8, 5).ok, true);
  const id = client.state.orders[0]!.id;

  assert.equal(client.cancelOrder(id).ok, true);
  assert.equal(client.state.eggs, 10);
  assert.equal(client.state.orders.length, 0);

  // Bei vollem Lager blockiert die Rücknahme, statt das Limit zu umgehen.
  const full = new Client({
    state: { ...fullSilo(), orders: [{ id: 1, item: 'eggs', amount: 10, price: 5, listedAt: 0 }], nextOrderId: 2 },
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
  let s = initialState(3);
  s = advanceTo(s, 6000, rules);
  s = simulate(s, { seq: 1, tick: 6000, type: 'LIST_ORDER', item: 'eggs', amount: 6, price: 5 }, rules);
  assert.equal(s.orders.length, 1);

  // Über die Ablauffrist hinaus warten.
  s = advanceTo(s, 6000 + rules.orderTtlTicks, rules);

  assert.equal(s.orders.length, 0);
  assert.equal(s.mail.length, 1);
  assert.equal(s.mail[0]!.amount, 6);
  assertInvariants(s, rules);
});

test('ist das Postfach voll, bleibt der Auftrag stehen statt zu verfallen', () => {
  const mail = Array.from({ length: rules.mailCapacity }, (_, i) => ({
    item: 'wheat' as const,
    amount: 1,
    arrivedAt: 0,
  }));
  let s = { ...initialState(3), tick: 1000, mail, eggs: 10 };
  s = simulate(s, { seq: 1, tick: 1000, type: 'LIST_ORDER', item: 'eggs', amount: 5, price: 5 }, rules);

  s = advanceTo(s, 1000 + rules.orderTtlTicks + 100, rules);

  // Nichts vernichtet: Der Auftrag wartet, bis Platz da ist.
  assert.equal(s.orders.length, 1);
  assert.equal(s.mail.length, rules.mailCapacity);
  assertInvariants(s, rules);
});

test('Postfach abholen nimmt mit, was ins Lager passt — der Rest bleibt liegen', () => {
  let s = advanceTo(initialState(3), 59_000, rules); // fast voll
  const space = rules.siloCapacity - stored(s);

  s = {
    ...s,
    mail: [
      { item: 'gold', amount: 50, arrivedAt: 0 },
      { item: 'eggs', amount: space, arrivedAt: 0 },
      { item: 'eggs', amount: 10, arrivedAt: 0 }, // passt nicht mehr
    ],
  };

  s = simulate(s, { seq: 1, tick: 59_000, type: 'COLLECT_MAIL' }, rules);

  assert.equal(s.gold, 50, 'Gold passt immer');
  assert.equal(stored(s), rules.siloCapacity);
  assert.equal(s.mail.length, 1, 'der Rest wartet weiter');
  assertInvariants(s, rules);
});

test('externe Zustellung landet im Postfach — und löst keinen Fehlalarm aus', () => {
  const server = new Server(initialState(3), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  client.plant(0);
  client.advanceClock(7200);
  client.harvest(0);

  // Während der Spieler offline war, schickt ein Nachbar ein Geschenk.
  server.deliver({ item: 'eggs', amount: 5, arrivedAt: T0 });

  const res = server.sync(client.buildSyncRequest(), T0 + 7200 * 1000);

  assert.equal(res.ok, true);
  if (!res.ok) return;
  // Entscheidend: KEIN Divergenz-Alarm. Der Kanarienvogel vergleicht die
  // Kausalkette des Spielers, das Geschenk kommt danach dazu.
  assert.equal(res.divergence, false);
  assert.deepEqual(server.divergenceAlerts, []);

  assert.equal(res.snapshot.state.mail.length, 1);
  assert.equal(res.snapshot.state.mail[0]!.amount, 5);
  // Und es liegt im Postfach, nicht im Lager.
  assert.equal(res.snapshot.state.eggs, 12);
});

test('Zustellungen bei vollem Postfach gehen nicht verloren', () => {
  const server = new Server(initialState(3), T0, CURRENT_RULESET_VERSION);
  for (let i = 0; i < rules.mailCapacity + 5; i++) {
    server.deliver({ item: 'wheat', amount: 1, arrivedAt: T0 });
  }

  const client = new Client(server.snapshot);
  client.plant(0);
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
    const server = new Server(initialState(4), T0, CURRENT_RULESET_VERSION);
    const client = new Client(server.snapshot);

    for (let step = 0; step < 40; step++) {
      const s = client.preview();
      switch (pick(6)) {
        case 0:
          client.advanceClock(1 + pick(30_000));
          break;
        case 1:
          client.plant(pick(4));
          break;
        case 2:
          client.harvest(pick(4));
          break;
        case 3:
          if (s.eggs > 0) client.listOrder('eggs', 1 + pick(s.eggs), 1 + pick(7));
          else if (s.wheat > 0) client.listOrder('wheat', 1 + pick(s.wheat), 1 + pick(4));
          break;
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
      assert.ok(stored(now) <= rules.siloCapacity, `seed=${seed}: Lager überschritten`);
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

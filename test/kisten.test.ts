import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '../src/client/client.ts';
import { Server } from '../src/server/server.ts';
import { getRuleset, validateRuleset } from '../src/sim/rules.ts';
import { capacityOf, initialState, count, stored } from '../src/sim/state.ts';
import { farmView } from '../src/client/view.ts';
import { assertInvariants, migrateState } from '../src/sim/migrate.ts';
import { rollChest, topUpChests } from '../src/server/chests.ts';
import { mulberry32 } from './helpers/session.ts';
import { canonicalize } from '../src/sim/canonical.ts';
import type { State } from '../src/sim/state.ts';

const T0 = 1_700_000_000_000;
const rules = getRuleset(9);
const V8 = getRuleset(8);

const GOLD = 0;
const PLANK = 10;
const NAIL = 11;

function hof(patch: Partial<State> = {}): State {
  const base = initialState(rules);
  return {
    ...base,
    chests: [
      { id: 1, kind: 0, readyAt: 0 },
      { id: 2, kind: 1, readyAt: 500 },
    ],
    nextChestId: 3,
    ...patch,
  };
}

function client(state = hof()): Client {
  return new Client({ state, seq: 0, serverTs: T0, rulesetVersion: 9 });
}

test('eine Kiste öffnet sich erst, wenn ihre Zeit da ist', () => {
  const c = client();

  const zuFrueh = c.openChest(2);
  assert.equal(zuFrueh.ok, false);
  if (!zuFrueh.ok) assert.equal(zuFrueh.code, 'CHEST_NOT_READY');

  assert.equal(c.openChest(1).ok, true);
  assert.equal(c.state.chests.length, 1);
  assert.deepEqual(c.state.pendingBoxes, [0]);

  c.advanceClock(500);
  assert.equal(c.openChest(2).ok, true);
  assert.deepEqual(c.state.pendingBoxes, [0, 1]);
});

test('der Inhalt steht NICHT im Zustand — der Client kann ihn nicht vorher sehen', () => {
  const c = client();
  const vorher = count(c.state, PLANK) + count(c.state, NAIL) + count(c.state, GOLD);
  assert.equal(c.openChest(1).ok, true);

  assert.equal(
    count(c.state, PLANK) + count(c.state, NAIL) + count(c.state, GOLD),
    vorher,
    'Öffnen darf lokal nichts ausschütten',
  );

  const text = canonicalize(c.state);
  assert.ok(text.includes('boxes=[0]'), 'die offene Kiste steht als Art im Zustand');
  assert.ok(!/plank|nail/.test(text), 'im Zustand steht kein Inhalt');
});

test('der Server würfelt beim Sync und legt die Beute ins Postfach', () => {
  const server = new Server(hof(), T0, 9);
  server.rollChest = mulberry32(4);

  const c = new Client(server.snapshot);
  assert.equal(c.openChest(1).ok, true);

  const res = server.sync(c.buildSyncRequest(), T0 + 1000);
  assert.equal(res.ok, true);
  if (!res.ok) return;

  assert.deepEqual(res.snapshot.state.pendingBoxes, [], 'die Kiste bleibt nicht offen');
  assert.ok(res.snapshot.state.mail.length > 0, 'nichts im Postfach');

  const beute = res.snapshot.state.mail;
  for (const stück of beute) {
    assert.ok(stück.amount > 0, 'leerer Posten');
    assert.ok(rules.items[stück.item], `Gegenstand ${stück.item} gibt es nicht`);
  }
});

test('zwei Kisten derselben Art geben nicht zwangsläufig dasselbe', () => {
  const ergebnisse = new Set<string>();
  for (let seed = 1; seed <= 12; seed++) {
    const beute = rollChest(0, rules, mulberry32(seed));
    ergebnisse.add(beute.map((b) => `${b.item}x${b.amount}`).join('+'));
  }
  assert.ok(ergebnisse.size > 3, `nur ${ergebnisse.size} verschiedene Ergebnisse`);
});

test('jede Ziehung bleibt in ihrer Tabelle und doppelt keinen Posten', () => {
  for (let seed = 1; seed <= 60; seed++) {
    for (const art of [0, 1]) {
      const beute = rollChest(art, rules, mulberry32(seed * 31 + art));
      const tabelle = rules.chestKinds![art]!;
      assert.ok(beute.length <= tabelle.picks, 'mehr Posten als erlaubt');

      const gesehen = new Set<number>();
      for (const stück of beute) {
        const eintrag = tabelle.drops.find((d) => d.item === stück.item);
        assert.ok(eintrag, `Gegenstand ${stück.item} steht nicht in der Tabelle`);
        assert.ok(
          stück.amount >= eintrag!.min && stück.amount <= eintrag!.max,
          `Menge ${stück.amount} außerhalb von ${eintrag!.min}…${eintrag!.max}`,
        );
        assert.ok(!gesehen.has(stück.item), 'derselbe Posten zweimal');
        gesehen.add(stück.item);
      }
    }
  }
});

test('der Kistenvorrat wird aufgefüllt und liegt immer in der Zukunft', () => {
  const leer = initialState(rules);
  const { chests, nextChestId } = topUpChests(leer, rules, mulberry32(3));

  assert.equal(chests.length, rules.chestQueueMax);
  assert.equal(nextChestId, rules.chestQueueMax! + 1);

  let vorher = leer.tick;
  for (const kiste of chests) {
    assert.ok(kiste.readyAt > vorher, 'zwei Kisten zur selben Zeit');
    vorher = kiste.readyAt;
    assert.ok(kiste.kind >= 0 && kiste.kind < rules.chestKinds!.length);
  }
});

test('das Lager wächst nur gegen Material', () => {
  const c = client();

  const arm = c.upgradeSilo();
  assert.equal(arm.ok, false);
  if (!arm.ok) assert.equal(arm.code, 'CANT_AFFORD');

  const items = c.state.items.slice();
  items[PLANK] = 8;
  items[NAIL] = 4;
  items[GOLD] = 300;
  const reich = client(hof({ items }));

  assert.equal(capacityOf(reich.state, rules), 200);
  assert.equal(reich.upgradeSilo().ok, true);
  assert.equal(capacityOf(reich.state, rules), 280);
  assert.equal(count(reich.state, PLANK), 0, 'Bretter wurden nicht verbaut');
  assert.equal(count(reich.state, GOLD), 0);

  assert.equal(farmView(reich.preview(), rules).silo.capacity, 280);
});

test('Baumaterial belegt keinen Lagerplatz', () => {
  const items = initialState(rules).items.slice();
  items[PLANK] = 40;
  items[NAIL] = 40;
  const voll = { ...hof(), items };

  assert.equal(stored(voll, rules), 9, 'Bretter und Nägel zählen ins Lager');
});

test('mehr Platz heißt auch: mehr passt hinein', () => {
  const items = initialState(rules).items.slice();
  items[1] = 199;
  items[4] = 0;
  const eng = client(hof({ items }));
  assert.equal(farmView(eng.state, rules).silo.free, 1);

  const gross = { ...eng.state, siloLevel: 1 };
  assert.equal(farmView(gross, rules).silo.free, 81);
});

test('das Anzeigemodell zeigt nur fertige Kisten als antippbar', () => {
  const v = farmView(hof(), rules);
  assert.equal(v.chests.length, 2);
  assert.equal(v.chests[0]!.ready, true);
  assert.equal(v.chests[0]!.kind, 'Holzkiste');
  assert.equal(v.chests[1]!.ready, false);
  assert.equal(v.chests[1]!.readyIn, 500);
});

test('ein Hof aus v8 bekommt Kisten und ein ausbaubares Lager', () => {
  const alt = initialState(V8);
  const items = alt.items.slice();
  items[1] = 40;

  const neu = migrateState({ ...alt, items, tick: 300 }, 8, 9);
  assertInvariants(neu, rules);

  assert.equal(count(neu, 1), 40);
  assert.equal(neu.siloLevel, 0);
  assert.deepEqual(neu.chests, []);
  assert.equal(count(neu, PLANK), 0, 'Material beginnt bei null');
  assert.equal(capacityOf(neu, rules), V8.siloCapacity, 'Grundstufe ist das alte Lager');
});

test('das Regelwerk v9 ist in sich stimmig', () => {
  assert.deepEqual(validateRuleset(rules), []);

  const stufen = rules.siloLevels!;
  for (let i = 1; i < stufen.length; i++) {
    assert.ok(stufen[i]!.capacity > stufen[i - 1]!.capacity, `Stufe ${i} wird nicht größer`);
    assert.ok(stufen[i]!.cost.length > 0, `Stufe ${i} kostet nichts`);
  }
  assert.equal(stufen[0]!.capacity, rules.siloCapacity, 'Grundstufe weicht vom Lagerwert ab');

  for (const art of rules.chestKinds!) {
    assert.ok(art.picks >= 1);
    assert.ok(art.drops.length >= art.picks, `${art.id}: zu wenige Posten für ${art.picks} Züge`);
    for (const drop of art.drops) {
      assert.ok(drop.weight > 0, `${art.id}: Gewicht 0 — der Posten kommt nie`);
      assert.ok(drop.min >= 1 && drop.max >= drop.min, `${art.id}: Spanne verkehrt`);
      assert.ok(rules.items[drop.item], `${art.id}: Gegenstand ${drop.item} unbekannt`);
    }
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '../src/client/client.ts';
import { getRuleset, validateRuleset } from '../src/sim/rules.ts';
import { initialState, count } from '../src/sim/state.ts';
import { farmView } from '../src/client/view.ts';
import { assertInvariants, migrateState } from '../src/sim/migrate.ts';
import type { Request, State } from '../src/sim/state.ts';

const T0 = 1_700_000_000_000;
const rules = getRuleset(7);
const V6 = getRuleset(6);

const GOLD = 0;
const WHEAT = 1;
const CORN = 4;

const FRACHT: Request = {
  id: 1,
  wants: [
    { item: WHEAT, amount: 4 },
    { item: CORN, amount: 2 },
  ],
  reward: [{ item: GOLD, amount: 100 }],
  xp: 20,
};

const NAECHSTE: Request = {
  id: 2,
  wants: [{ item: WHEAT, amount: 3 }],
  reward: [{ item: GOLD, amount: 40 }],
  xp: 8,
};

function hof(patch: Partial<State> = {}): State {
  const base = initialState(rules);
  const items = base.items.slice();
  items[WHEAT] = 20;
  items[CORN] = 10;
  return { ...base, items, requests: [FRACHT, NAECHSTE], ...patch };
}

function client(state = hof()): Client {
  return new Client({ state, seq: 0, serverTs: T0, rulesetVersion: 7 });
}

test('der Wagen nimmt Posten für Posten an, und nie mehr als verlangt', () => {
  const c = client();

  assert.equal(c.loadTruck(0, 3).ok, true);
  assert.equal(count(c.state, WHEAT), 17, 'geladene Ware bleibt im Lager liegen');

  const zuViel = c.loadTruck(0, 2);
  assert.equal(zuViel.ok, false);
  if (!zuViel.ok) assert.equal(zuViel.code, 'TOO_MUCH');

  assert.equal(c.loadTruck(0, 1).ok, true);
  assert.equal(c.state.truck.loaded[0], 4);
});

test('ohne volle Ladung fährt er nicht', () => {
  const c = client();
  c.loadTruck(0, 4);

  const zuFrueh = c.sendTruck();
  assert.equal(zuFrueh.ok, false);
  if (!zuFrueh.ok) assert.equal(zuFrueh.code, 'TRUCK_NOT_FULL');

  c.loadTruck(1, 2);
  assert.equal(c.sendTruck().ok, true);
});

test('abgefahren heißt bezahlt, weg, und der nächste Frachtbrief liegt bereit', () => {
  const c = client();
  c.loadTruck(0, 4);
  c.loadTruck(1, 2);

  const goldVorher = count(c.state, GOLD);
  assert.equal(c.sendTruck().ok, true);

  assert.equal(count(c.state, GOLD), goldVorher + 100);
  assert.equal(c.state.xp, 20);
  assert.equal(c.state.requests[0]!.id, NAECHSTE.id, 'der nächste Frachtbrief rückt nach');
  assert.deepEqual(c.state.truck.loaded, [0], 'die Ladefläche ist leer');
  assert.equal(c.state.truck.awayUntil, rules.truckAwayTicks);

  const nochmal = c.loadTruck(0, 1);
  assert.equal(nochmal.ok, false);
  if (!nochmal.ok) assert.equal(nochmal.code, 'TRUCK_AWAY');

  c.advanceClock(rules.truckAwayTicks!);
  assert.equal(c.loadTruck(0, 1).ok, true, 'nach der Fahrzeit geht es weiter');
});

test('einen Frachtbrief wegschicken gibt die Ladung zurück', () => {
  const c = client();
  c.loadTruck(0, 4);
  c.loadTruck(1, 2);
  assert.equal(count(c.state, WHEAT), 16);
  assert.equal(count(c.state, CORN), 8);

  assert.equal(c.skipRequest(FRACHT.id).ok, true);

  assert.equal(count(c.state, WHEAT), 20, 'Weizen kam nicht zurück');
  assert.equal(count(c.state, CORN), 10, 'Mais kam nicht zurück');
  assert.equal(c.state.requests[0]!.id, NAECHSTE.id);
  assert.deepEqual(c.state.truck.loaded, [0]);
});

test('ein Frachtbrief, der aus der Warteschlange fällt, nimmt keine Ladung mit', () => {
  const c = client();
  c.loadTruck(0, 4);

  assert.equal(c.fillRequest(FRACHT.id).ok, true, 'alte Kundenlieferung geht noch');

  assert.equal(
    count(c.state, WHEAT),
    16,
    'ohne Erstattung wären es 12: 20 minus 4 geladen minus 4 geliefert',
  );
  assert.deepEqual(c.state.truck.loaded, [0], 'die Ladung wandert nicht auf den nächsten Brief');
});

test('ohne Frachtbrief passiert nichts', () => {
  const c = client(hof({ requests: [] }));
  const res = c.loadTruck(0, 1);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'NO_WAYBILL');
});

test('in einem Regelwerk ohne Wagen bleibt der Wagen aus', () => {
  const alt = new Client({ state: initialState(V6), seq: 0, serverTs: T0, rulesetVersion: 6 });
  const res = alt.loadTruck(0, 1);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'TRUCK_DISABLED');

  assert.equal(farmView(alt.state, V6).truck.enabled, false);
});

test('das Anzeigemodell sagt, was fehlt und was es bringt', () => {
  const c = client();
  c.loadTruck(0, 1);

  const v = farmView(c.preview(), rules);
  const t = v.truck;

  assert.equal(t.enabled, true);
  assert.equal(t.here, true);
  assert.equal(t.waybill!.stacks[0]!.loaded, 1);
  assert.equal(t.waybill!.stacks[0]!.missing, 3);
  assert.equal(t.waybill!.stacks[0]!.loadable, 3, 'Lager reicht für den Rest');
  assert.equal(t.waybill!.full, false);
  assert.deepEqual(t.waybill!.reward, [{ item: GOLD, amount: 100 }]);
  assert.equal(t.next!.wants[0]!.amount, 3, 'der nächste Brief ist schon sichtbar');

  c.loadTruck(0, 3);
  c.loadTruck(1, 2);
  assert.equal(farmView(c.preview(), rules).truck.waybill!.full, true);
});

test('offline reicht die vorgewürfelte Warteschlange für mehrere Fuhren', () => {
  const vorrat: Request[] = [];
  for (let i = 0; i < 5; i++) {
    vorrat.push({
      id: i + 1,
      wants: [{ item: WHEAT, amount: 2 }],
      reward: [{ item: GOLD, amount: 30 }],
      xp: 5,
    });
  }
  const c = client(hof({ requests: vorrat }));

  for (let i = 0; i < 5; i++) {
    assert.equal(c.loadTruck(0, 2).ok, true, `Fuhre ${i + 1}: laden`);
    assert.equal(c.sendTruck().ok, true, `Fuhre ${i + 1}: abfahren`);
    c.advanceClock(rules.truckAwayTicks!);
  }

  assert.equal(count(c.state, GOLD), 5 * 30);
  assert.equal(c.state.requests.length, 0);
});

test('ein Hof aus v6 bekommt den Wagen, ohne dass etwas verloren geht', () => {
  const alt = initialState(V6);
  const items = alt.items.slice();
  items[WHEAT] = 33;

  const neu = migrateState({ ...alt, items, tick: 500 }, 6, 7);
  assertInvariants(neu, rules);

  assert.equal(count(neu, WHEAT), 33);
  assert.equal(neu.truck.awayUntil, 0, 'der Wagen steht sofort bereit');
  assert.deepEqual(neu.truck.loaded, []);
});

test('das Regelwerk v7 ist in sich stimmig', () => {
  assert.deepEqual(validateRuleset(rules), []);
  assert.ok((rules.truckAwayTicks ?? 0) > 0, 'v7 ohne Wagen');
  assert.ok(
    rules.requestTemplates.every((t) => t.id.startsWith('fuhre-')),
    'in v7 sind die Vorlagen Fuhren, keine Kundenwünsche',
  );
});

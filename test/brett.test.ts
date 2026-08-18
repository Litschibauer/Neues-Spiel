import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '../src/client/client.ts';
import { getRuleset, validateRuleset } from '../src/sim/rules.ts';
import { initialState, count } from '../src/sim/state.ts';
import { farmView } from '../src/client/view.ts';
import { assertInvariants, migrateState } from '../src/sim/migrate.ts';
import { topUpRequests } from '../src/server/requests.ts';
import { mulberry32 } from './helpers/session.ts';
import type { Request, State } from '../src/sim/state.ts';

const T0 = 1_700_000_000_000;
const rules = getRuleset(8);
const V7 = getRuleset(7);

const GOLD = 0;
const WHEAT = 1;
const CORN = 4;

function zettel(id: number, wheat: number, dest = 0): Request {
  return {
    id,
    wants: [{ item: WHEAT, amount: wheat }],
    reward: [{ item: GOLD, amount: wheat * 8 }],
    xp: wheat,
    dest,
  };
}

function hof(patch: Partial<State> = {}): State {
  const base = initialState(rules);
  const items = base.items.slice();
  items[WHEAT] = 30;
  items[CORN] = 10;
  return {
    ...base,
    items,
    requests: [zettel(1, 5, 0), zettel(2, 6, 1), zettel(3, 7, 2), zettel(4, 8, 3), zettel(5, 9, 4)],
    ...patch,
  };
}

function client(state = hof()): Client {
  return new Client({ state, seq: 0, serverTs: T0, rulesetVersion: 8 });
}

test('am Brett hängen vier Zettel, der Rest wartet dahinter', () => {
  assert.equal(rules.requestSlots, 4);
  const v = farmView(hof(), rules);
  assert.equal(v.truck.board.length, 4);
  assert.deepEqual(
    v.truck.board.map((z) => z.id),
    [1, 2, 3, 4],
  );
  assert.equal(v.truck.board[0]!.dest, rules.destinations![0]);
});

test('ein Zettel geht raus, der nächste rückt nach, der Wagen ist weg', () => {
  const c = client();
  const goldVorher = count(c.state, GOLD);

  assert.equal(c.sendSlip(1).ok, true, 'auch der zweite Zettel lässt sich schicken');
  assert.equal(count(c.state, GOLD), goldVorher + 48);
  assert.equal(count(c.state, WHEAT), 24);
  assert.equal(c.state.xp, 6);

  const board = farmView(c.preview(), rules).truck.board;
  assert.deepEqual(board.map((z) => z.id), [1, 3, 4, 5], 'der Zettel dahinter rückt ans Brett');

  const sofort = c.sendSlip(0);
  assert.equal(sofort.ok, false, 'zwei Fuhren gleichzeitig');
  if (!sofort.ok) assert.equal(sofort.code, 'TRUCK_AWAY');

  c.advanceClock(rules.truckAwayTicks!);
  assert.equal(c.sendSlip(0).ok, true, 'nach neun Sekunden fährt er wieder');
});

test('ohne Ware bleibt der Zettel hängen', () => {
  const arm = hof();
  const items = arm.items.slice();
  items[WHEAT] = 2;
  const c = client({ ...arm, items });

  const res = c.sendSlip(0);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'NOT_ENOUGH_ITEMS');

  const z = farmView(c.preview(), rules).truck.board[0]!;
  assert.equal(z.deliverable, false);
  assert.deepEqual(z.missing, [{ item: WHEAT, amount: 3 }]);
});

test('hinter das Brett greifen geht nicht', () => {
  const c = client();
  const res = c.sendSlip(4);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'NO_SUCH_SLIP');
});

test('ein Zettel lässt sich tauschen — mit Wartezeit', () => {
  const c = client();
  assert.equal(c.skipRequest(1).ok, true);
  assert.deepEqual(
    farmView(c.preview(), rules).truck.board.map((z) => z.id),
    [2, 3, 4, 5],
  );

  const sofort = c.skipRequest(3);
  assert.equal(sofort.ok, false);
  if (!sofort.ok) assert.equal(sofort.code, 'SKIP_ON_COOLDOWN');

  c.advanceClock(rules.requestSkipCooldownTicks);
  assert.equal(c.skipRequest(3).ok, true);
});

test('an den Händler verkauft niemand mehr', () => {
  const c = client();
  const res = c.sellNpc(WHEAT, 1);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'NPC_DISABLED');
});

test('die alte Kundenlieferung ist zu — es geht nur noch über das Brett', () => {
  const c = client();
  const res = c.fillRequest(1);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'USE_THE_BOARD');
});

test('nachkaufen nur, wenn wirklich nichts mehr da ist, und dann eins', () => {
  const c = client();

  const vollesLager = c.buyNpc(WHEAT, 1);
  assert.equal(vollesLager.ok, false);
  if (!vollesLager.ok) assert.equal(vollesLager.code, 'ONLY_WHEN_EMPTY');

  const leer = hof();
  const items = leer.items.slice();
  items[WHEAT] = 0;
  const arm = client({ ...leer, items });

  const zuViel = arm.buyNpc(WHEAT, 3);
  assert.equal(zuViel.ok, false);
  if (!zuViel.ok) assert.equal(zuViel.code, 'BAD_AMOUNT');

  assert.equal(arm.buyNpc(WHEAT, 1).ok, true);
  assert.equal(count(arm.state, WHEAT), 1);

  const nochmal = arm.buyNpc(WHEAT, 1);
  assert.equal(nochmal.ok, false, 'mit einem Korn im Lager ist Schluss');
  if (!nochmal.ok) assert.equal(nochmal.code, 'ONLY_WHEN_EMPTY');
});

test('ein leergespielter Hof kommt aus eigener Kraft zurück', () => {
  const leer = initialState(rules);
  const items = leer.items.slice();
  items[WHEAT] = 0;
  items[CORN] = 0;
  const c = client({ ...leer, items, requests: [zettel(1, 4)] });

  assert.equal(c.buyNpc(WHEAT, 1).ok, true, 'ein Korn muss man sich kaufen können');
  assert.ok(count(c.state, GOLD) >= 0);

  for (let runde = 0; runde < 4; runde++) {
    assert.equal(c.start(0, 0, 0).ok, true, `Runde ${runde}: säen`);
    c.advanceClock(rules.recipes[0]!.durationTicks);
    assert.equal(c.collect(0, 0).ok, true, `Runde ${runde}: ernten`);
  }
  assert.ok(count(c.state, WHEAT) >= 4, `aus einem Korn wurden ${count(c.state, WHEAT)}`);
  assert.equal(c.sendSlip(0).ok, true, 'und damit fährt wieder ein Zettel raus');
});

test('jeder Zettel bekommt beim Würfeln ein Ziel', () => {
  const leer = initialState(rules);
  const { requests } = topUpRequests(leer, rules, 1, mulberry32(7));
  assert.ok(requests.length > 0);
  for (const r of requests) {
    assert.ok(
      Number.isInteger(r.dest) && r.dest >= 0 && r.dest < rules.destinations!.length,
      `Ziel ${r.dest} gibt es nicht`,
    );
  }
  assert.ok(new Set(requests.map((r) => r.dest)).size > 1, 'alle Zettel gehen an denselben Ort');
});

test('ein Hof aus v7 kommt heil am Brett an', () => {
  const alt = initialState(V7);
  const items = alt.items.slice();
  items[WHEAT] = 15;
  const mit = {
    ...alt,
    items,
    tick: 400,
    requests: [
      {
        id: 9,
        wants: [{ item: WHEAT, amount: 3 }],
        reward: [{ item: GOLD, amount: 24 }],
        xp: 1,
        dest: 0,
      },
    ],
    truck: { loaded: [2], awayUntil: 0 },
  };

  const neu = migrateState(mit, 7, 8);
  assertInvariants(neu, rules);
  assert.equal(count(neu, WHEAT), 15);
  assert.equal(neu.requests.length, 1);
});

test('das Regelwerk v8 ist in sich stimmig', () => {
  assert.deepEqual(validateRuleset(rules), []);
  assert.equal(rules.boardDeliveryOnly, true);
  assert.equal(rules.sellNpcDisabled, true);
  assert.equal(rules.emergencyBuyOnly, true);
  assert.ok((rules.destinations ?? []).length >= 4);
  assert.ok((rules.truckAwayTicks ?? 0) <= 15, 'der Wagen soll gleich wieder da sein');
});

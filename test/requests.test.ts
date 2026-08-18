import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '../src/client/client.ts';
import { Server } from '../src/server/server.ts';
import { getRuleset, CURRENT_RULESET_VERSION } from '../src/sim/rules.ts';
import { initialState, count } from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';
import { reachableItems, topUpRequests } from '../src/server/requests.ts';
import { assertInvariants } from '../src/sim/migrate.ts';
import { fuzzStart, mulberry32 } from './helpers/session.ts';

const T0 = 1_700_000_000_000;
const rules = getRuleset(CURRENT_RULESET_VERSION);

const GOLD = 0;
const WHEAT = 1;
const FEED = 2;
const EGGS = 3;
const R_WHEAT = 0;
const MILL = 6;
const COOP = 7;

function stocked(items: Partial<Record<number, number>>, seed = 1) {
  const base = initialState(rules);
  const inventory = base.items.slice();
  for (const [index, amount] of Object.entries(items)) inventory[Number(index)] = amount!;
  const withItems = { ...base, items: inventory };
  const { requests } = topUpRequests(withItems, rules, 1, mulberry32(seed));
  return { ...withItems, requests };
}

test('ein Auftrag nimmt Ware und gibt Belohnung', () => {
  const state = stocked({ [WHEAT]: 40 });
  const client = new Client({ state, seq: 0, serverTs: T0, rulesetVersion: 1 });

  const request = client.state.requests[0]!;
  const before = request.wants.map((w) => count(client.state, w.item));

  assert.equal(client.fillRequest(request.id).ok, true);

  request.wants.forEach((w, i) => {
    assert.equal(count(client.state, w.item), before[i]! - w.amount, 'Ware nicht abgegeben');
  });
  for (const r of request.reward) {
    assert.ok(count(client.state, r.item) >= r.amount, 'Belohnung fehlt');
  }
  assert.equal(
    client.state.requests.find((r) => r.id === request.id),
    undefined,
    'erledigter Auftrag steht noch da',
  );
});

test('ohne die Ware geht gar nichts — und zwar schon offline', () => {
  const state = stocked({});
  const client = new Client({ state, seq: 0, serverTs: T0, rulesetVersion: 1 });

  const res = client.fillRequest(state.requests[0]!.id);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'NOT_ENOUGH_ITEMS');
  assert.equal(client.queue.length, 0, 'abgelehnte Lieferung landet im Log');
});

test('nur die vorderen Plätze sind annehmbar — der Rest ist Vorrat', () => {
  const state = stocked({ [WHEAT]: 90, [FEED]: 10 });
  const client = new Client({ state, seq: 0, serverTs: T0, rulesetVersion: 1 });

  assert.ok(state.requests.length > rules.requestSlots, 'Testkulisse hat keinen Vorrat');
  const hidden = state.requests[rules.requestSlots]!;

  const res = client.fillRequest(hidden.id);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'REQUEST_NOT_ACTIVE');
});

test('erledigt ein Auftrag den Slot, rückt der nächste nach — ohne Netz', () => {
  const state = stocked({ [WHEAT]: 90, [FEED]: 12 });
  const client = new Client({ state, seq: 0, serverTs: T0, rulesetVersion: 1 });

  const queueBefore = client.state.requests.length;
  const wasHidden = client.state.requests[rules.requestSlots]!;

  const active = client.state.requests
    .slice(0, rules.requestSlots)
    .find((r) => r.wants.every((w) => count(client.state, w.item) >= w.amount))!;
  assert.ok(active, 'kein erfüllbarer Auftrag in der Testkulisse');
  assert.equal(client.fillRequest(active.id).ok, true);

  assert.equal(client.state.requests.length, queueBefore - 1);
  const nowActive = client.state.requests.slice(0, rules.requestSlots).map((r) => r.id);
  assert.ok(nowActive.includes(wasHidden.id), 'der Vorrat ist nicht nachgerückt');
});

test('eine ganze Sitzung im Funkloch: anbauen, ernten, liefern, wiederholen', () => {
  const state = stocked({});
  const client = new Client({ state, seq: 0, serverTs: T0, rulesetVersion: 1 });
  const grow = rules.recipes[R_WHEAT]!.durationTicks;

  let filled = 0;
  for (let round = 0; round < 40; round++) {
    if (count(client.state, WHEAT) < 3) client.buyNpc(WHEAT, 6);
    for (let plot = 0; plot < 3; plot++) client.start(plot, R_WHEAT);
    client.advanceClock(grow);
    for (let plot = 0; plot < 3; plot++) client.collect(plot);

    for (;;) {
      const active = client.state.requests
        .slice(0, rules.requestSlots)
        .find((r) => r.wants.every((w) => count(client.state, w.item) >= w.amount));
      if (!active) break;
      assert.equal(client.fillRequest(active.id).ok, true);
      filled++;
    }
  }

  assert.ok(filled >= 15, `zu wenige Aufträge offline erfüllbar: ${filled}`);
  assert.ok(count(client.state, GOLD) > 0, 'keine Belohnung angekommen');

  assert.equal(client.sellNpc(WHEAT, count(client.state, WHEAT)).ok, true);
});

test('Aufträge lohnen sich mehr als der NPC-Verkauf', () => {
  for (const template of rules.requestTemplates) {
    const npcValue = template.wants.reduce(
      (sum, w) => sum + w.amount * rules.items[w.item]!.npcPrice,
      0,
    );
    const reward = template.reward.reduce((sum, r) => sum + r.amount, 0);
    assert.ok(
      reward > npcValue,
      `${template.id}: Belohnung ${reward} <= NPC-Wert ${npcValue}`,
    );
  }
});

test('der Server verteilt nur, was der Hof auch herstellen kann', () => {
  const fresh = initialState(rules);
  assert.deepEqual([...reachableItems(fresh, rules)], [WHEAT]);

  const { requests } = topUpRequests(fresh, rules, 1, mulberry32(7));
  assert.equal(requests.length, rules.requestQueueMax);
  for (const r of requests) {
    for (const w of r.wants) {
      assert.equal(w.item, WHEAT, `frischer Hof bekommt Auftrag über ${rules.items[w.item]!.id}`);
    }
  }
});

test('mit Mühle und Gehege wächst das Auftragsangebot mit', () => {
  const base = initialState(rules);
  const built = {
    ...base,
    plots: base.plots.map((p, i) => {
      if (i === MILL) return { ...p, level: 1 };
      if (i === COOP) return { ...p, level: 2 };
      return p;
    }),
  };

  const reachable = reachableItems(built, rules);
  assert.deepEqual([...reachable].sort((a, b) => a - b), [WHEAT, FEED, EGGS]);

  const { requests } = topUpRequests(built, rules, 1, mulberry32(3));
  const wanted = new Set(requests.flatMap((r) => r.wants.map((w) => w.item)));
  assert.ok(wanted.size > 1, 'nach dem Ausbau immer noch nur eine Ware gefragt');
});

test('der Server füllt beim Sync auf — hinten, nicht vorne', () => {
  const server = new Server(stocked({ [WHEAT]: 60 }), T0, CURRENT_RULESET_VERSION);
  server.rollRequest = mulberry32(11);
  const client = new Client(server.snapshot);

  const activeBefore = client.state.requests.slice(0, rules.requestSlots).map((r) => r.id);
  const target = client.state.requests
    .slice(0, rules.requestSlots)
    .find((r) => r.wants.every((w) => count(client.state, w.item) >= w.amount))!;
  assert.equal(client.fillRequest(target.id).ok, true);

  const res = server.sync(client.buildSyncRequest(), T0 + 1000);
  assert.equal(res.ok, true);
  if (!res.ok) return;

  assert.equal(res.divergence, false);
  assert.deepEqual(server.divergenceAlerts, []);

  assert.equal(res.snapshot.state.requests.length, rules.requestQueueMax);
  const survivors = activeBefore.filter((id) => id !== target.id);
  const nowFront = res.snapshot.state.requests.slice(0, rules.requestSlots).map((r) => r.id);
  for (const id of survivors) {
    assert.ok(nowFront.includes(id), `Auftrag ${id} wurde nach hinten geschoben`);
  }
  assertInvariants(res.snapshot.state, rules);
});

test('Auftragsnummern werden nie zweimal vergeben', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  server.rollRequest = mulberry32(5);
  server.stockRequests();

  const seen = new Set<number>(server.snapshot.state.requests.map((r) => r.id));
  const client = new Client(server.snapshot);

  for (let round = 0; round < 5; round++) {
    server.deliver({ item: WHEAT, amount: 20, arrivedAt: T0 });
    const res = server.sync(
      { baseSeq: server.snapshot.seq, rulesetVersion: 1, commands: [] },
      T0 + round * 1000,
    );
    for (const r of server.snapshot.state.requests) {
      if (!seen.has(r.id)) seen.add(r.id);
    }
    assert.equal(res.ok, true);
  }

  const ids = server.snapshot.state.requests.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'doppelte Auftragsnummer im Zustand');
  assert.ok(client.state.requests.length > 0);
});

test('ein frischer Hof hat sofort etwas zu tun — auch ohne Sync', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  server.rollRequest = mulberry32(2);
  server.stockRequests();

  assert.equal(server.snapshot.state.requests.length, rules.requestQueueMax);

  const client = new Client(server.snapshot);
  assert.ok(client.state.requests.length >= rules.requestSlots);

  assert.equal(client.start(0, R_WHEAT).ok, true);
});

test('Belohnungen sprengen das Lager nicht', () => {
  const tightRules = {
    ...rules,
    requestTemplates: [
      {
        id: 'gives-wheat',
        wants: [{ item: FEED, amount: 1 }],
        reward: [{ item: WHEAT, amount: 50 }],
      },
    ],
  };
  const base = initialState(tightRules);
  const items = base.items.slice();
  items[WHEAT] = tightRules.siloCapacity - 10;
  items[FEED] = 5;
  const withItems = { ...base, items };
  const state = {
    ...withItems,

    plots: withItems.plots.map((p, i) => (i === MILL ? { ...p, level: 1 } : p)),
  };
  state.requests = topUpRequests(state, tightRules, 1, mulberry32(1)).requests;
  assert.ok(state.requests.length > 0, 'Testkulisse hat keine Aufträge');

  const request = state.requests[0]!;
  assert.throws(
    () =>
      simulate(state, { seq: 1, tick: 0, type: 'FILL_REQUEST', requestId: request.id }, tightRules),
    /SILO_FULL/,
  );

  const roomy = { ...state, items: state.items.map((v, i) => (i === WHEAT ? 10 : v)) };
  const after = simulate(
    roomy,
    { seq: 1, tick: 0, type: 'FILL_REQUEST', requestId: request.id },
    tightRules,
  );
  assert.equal(count(after, WHEAT), 60);
});

test('zufällige Sitzungen mit Aufträgen bleiben invariant', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const start = fuzzStart(rules, 3000, mulberry32(seed));
    assertInvariants(start, rules);
    assert.equal(start.requests.length, rules.requestQueueMax);
  }
});

const COOLDOWN = rules.requestSkipCooldownTicks;

test('einen Auftrag wegschicken lässt den nächsten nachrücken', () => {
  const state = stocked({ [WHEAT]: 40 });
  const client = new Client({ state, seq: 0, serverTs: T0, rulesetVersion: 1 });

  const before = client.state.requests.slice(0, rules.requestSlots).map((r) => r.id);
  const vorrat = client.state.requests.length;

  assert.equal(client.skipRequest(before[0]!).ok, true);

  const after = client.state.requests.slice(0, rules.requestSlots).map((r) => r.id);
  assert.ok(!after.includes(before[0]!), 'der weggeschickte Auftrag steht noch da');
  assert.equal(client.state.requests.length, vorrat - 1, 'es ist genau einer verschwunden');

  assert.equal(after.length, Math.min(rules.requestSlots, vorrat - 1));
  assert.equal(after[0], before[1], 'die Reihenfolge stimmt nicht');
});

test('DER PUNKT: bezahlt wird mit Wartezeit, nicht mit Geld', () => {
  const state = stocked({ [WHEAT]: 40, [GOLD]: 100_000 });
  const client = new Client({ state, seq: 0, serverTs: T0, rulesetVersion: 1 });
  const goldBefore = count(client.state, GOLD);

  assert.equal(client.skipRequest(client.state.requests[0]!.id).ok, true);
  assert.equal(count(client.state, GOLD), goldBefore, 'Wegschicken hat Gold gekostet');

  const second = client.skipRequest(client.state.requests[0]!.id);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.code, 'SKIP_ON_COOLDOWN');
});

test('nach der Wartezeit geht es wieder — auf die Sekunde genau', () => {
  const state = stocked({ [WHEAT]: 40 });
  const client = new Client({ state, seq: 0, serverTs: T0, rulesetVersion: 1 });

  assert.equal(client.skipRequest(client.state.requests[0]!.id).ok, true);

  client.advanceClock(COOLDOWN - 1);
  const early = client.skipRequest(client.state.requests[0]!.id);
  assert.equal(early.ok, false);
  if (!early.ok) assert.equal(early.code, 'SKIP_ON_COOLDOWN');

  client.advanceClock(1);
  assert.equal(client.skipRequest(client.state.requests[0]!.id).ok, true);
});

test('der Vorrat ist kein Regal: hinten wird nicht ausgesucht', () => {
  const state = stocked({ [WHEAT]: 40 });
  const client = new Client({ state, seq: 0, serverTs: T0, rulesetVersion: 1 });

  const hinten = client.state.requests[rules.requestSlots]!;
  const res = client.skipRequest(hinten.id);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'REQUEST_NOT_ACTIVE');
});

test('einen Auftrag, den es nicht gibt, kann man auch nicht wegschicken', () => {
  const state = stocked({ [WHEAT]: 40 });
  const client = new Client({ state, seq: 0, serverTs: T0, rulesetVersion: 1 });

  const res = client.skipRequest(9999);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'NO_SUCH_REQUEST');

  assert.equal(client.skipRequest(client.state.requests[0]!.id).ok, true);
});

test('Wegschicken geht offline — der Server rechnet es kommentarlos nach', () => {
  const server = new Server(fuzzStart(rules, 0, mulberry32(7)), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  assert.equal(client.skipRequest(client.state.requests[0]!.id).ok, true);
  client.advanceClock(COOLDOWN);
  assert.equal(client.skipRequest(client.state.requests[0]!.id).ok, true);

  const res = server.sync(client.buildSyncRequest(), T0 + COOLDOWN * 1000);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.divergence, false, 'Kanarienvogel meldet Abweichung');
  assert.deepEqual(server.divergenceAlerts, []);
});

test('die Wartezeit überlebt einen Sync — sie steht im Zustand, nicht im Client', () => {
  const server = new Server(fuzzStart(rules, 0, mulberry32(9)), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  assert.equal(client.skipRequest(client.state.requests[0]!.id).ok, true);
  const res = server.sync(client.buildSyncRequest(), T0 + 1000);
  assert.equal(res.ok, true);
  if (!res.ok) return;

  assert.ok(res.snapshot.state.skipReadyAt > res.snapshot.state.tick, 'Wartezeit ist nicht gesetzt');

  const zweiter = new Client(res.snapshot);
  const sofort = zweiter.skipRequest(zweiter.state.requests[0]!.id);
  assert.equal(sofort.ok, false);
  if (!sofort.ok) assert.equal(sofort.code, 'SKIP_ON_COOLDOWN');
});

test('ein Regelwerk ohne Wartezeit kennt das Wegschicken gar nicht', () => {
  const ohne = { ...rules, requestSkipCooldownTicks: 0 };
  const state = stocked({ [WHEAT]: 40 });
  const cmd = { seq: 1, tick: 0, type: 'SKIP_REQUEST' as const, requestId: state.requests[0]!.id };

  assert.throws(() => simulate(state, cmd, ohne), { code: 'SKIP_DISABLED' });
});

test('Wegschicken verändert nichts außer der Schlange und der Uhr', () => {
  const state = stocked({ [WHEAT]: 40, [GOLD]: 500 });
  const client = new Client({ state, seq: 0, serverTs: T0, rulesetVersion: 1 });

  const vorher = client.state;
  assert.equal(client.skipRequest(vorher.requests[0]!.id).ok, true);
  const nachher = client.state;

  assert.deepEqual(nachher.items, vorher.items);
  assert.equal(nachher.xp, vorher.xp);
  assert.deepEqual(nachher.plots, vorher.plots);
  assert.deepEqual(nachher.orders, vorher.orders);
  assert.deepEqual(nachher.mail, vorher.mail);
  assertInvariants(nachher, rules);
});

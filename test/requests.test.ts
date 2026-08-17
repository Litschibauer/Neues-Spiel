/**
 * Kundenaufträge (M6) — und warum sie offline funktionieren, obwohl sie
 * zufällig sind.
 *
 * Das ist der interessante Teil. Zufall gehört dem Server (§5), aber ein
 * Auftrag, den man erst nach dem Sync erfüllen kann, wäre kein Offline-Feature.
 * Die Auflösung ist **Vorrat statt Verbindung** (Architektur §6): Der Server
 * würfelt im Voraus und schickt einen Stapel mit. Der Client verbraucht ihn
 * ohne Netz, ohne selbst je zu würfeln.
 *
 * Geprüft wird deshalb beides: die Regel im Sim-Kern und die Eigenschaft,
 * dass der Vorrat offline nicht ausgeht.
 */

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

/** Ein Hof mit Ware im Lager und einem vollen Auftragsvorrat. */
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
  // Sonst wäre die Schlange ein Regal, aus dem man sich den besten Auftrag
  // heraussucht. Der Vorrat soll nachrücken, nicht zur Auswahl stehen.
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
  // DAS ist die Eigenschaft, die M6 offline-fähig macht.
  const state = stocked({ [WHEAT]: 90, [FEED]: 12 });
  const client = new Client({ state, seq: 0, serverTs: T0, rulesetVersion: 1 });

  const queueBefore = client.state.requests.length;
  const wasHidden = client.state.requests[rules.requestSlots]!;

  // Den ersten erfüllbaren Auftrag im Slot-Fenster beliefern.
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
  // Der Praxistest für „Vorrat statt Verbindung": kein einziger Sync, nur
  // spielen. Das Lagerlimit macht Vorratshaltung unmöglich, also muss zwischen
  // den Lieferungen wirklich produziert werden — genau wie im Spiel.
  const state = stocked({});
  const client = new Client({ state, seq: 0, serverTs: T0, rulesetVersion: 1 });
  const grow = rules.recipes[R_WHEAT]!.durationTicks;

  let filled = 0;
  for (let round = 0; round < 40; round++) {
    // Saatgut nachkaufen, wenn keines mehr da ist — seit Säen ein Korn kostet,
    // gehört das zur Sitzung dazu. Genau dafür gibt es den Händler.
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

  // Der Vorrat muss eine ganze Sitzung tragen, nicht nur ein paar Minuten.
  assert.ok(filled >= 15, `zu wenige Aufträge offline erfüllbar: ${filled}`);
  assert.ok(count(client.state, GOLD) > 0, 'keine Belohnung angekommen');

  // Und wenn er doch leerläuft, ist das keine Sackgasse: Der NPC-Verkauf
  // bleibt offen (§6). Genau das ist das Ventil gegen den Leerlauf.
  assert.equal(client.sellNpc(WHEAT, count(client.state, WHEAT)).ok, true);
});

test('Aufträge lohnen sich mehr als der NPC-Verkauf', () => {
  // Sonst wären sie Zierde, und der Kreislauf hätte weiterhin kein Ziel.
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
  // Ein frischer Hof hat drei Felder und sonst nichts. Bekäme er Aufträge über
  // Eier, wären drei Slots blockiert und offline gäbe es nichts zu tun —
  // genau der Leerlauf, den Architektur §6 verbietet.
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

  // Und es kommen wirklich Aufträge über die neuen Waren durch.
  const { requests } = topUpRequests(built, rules, 1, mulberry32(3));
  const wanted = new Set(requests.flatMap((r) => r.wants.map((w) => w.item)));
  assert.ok(wanted.size > 1, 'nach dem Ausbau immer noch nur eine Ware gefragt');
});

test('der Server füllt beim Sync auf — hinten, nicht vorne', () => {
  // Ein Sync darf dem Spieler nicht die Auswahl unter den Fingern wegziehen.
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
  // Kein Fehlalarm: Der Nachschub kommt NACH dem Kanarienvogel-Vergleich.
  assert.equal(res.divergence, false);
  assert.deepEqual(server.divergenceAlerts, []);

  // Wieder voll, und die verbliebenen alten Aufträge stehen weiterhin vorn.
  assert.equal(res.snapshot.state.requests.length, rules.requestQueueMax);
  const survivors = activeBefore.filter((id) => id !== target.id);
  const nowFront = res.snapshot.state.requests.slice(0, rules.requestSlots).map((r) => r.id);
  for (const id of survivors) {
    assert.ok(nowFront.includes(id), `Auftrag ${id} wurde nach hinten geschoben`);
  }
  assertInvariants(res.snapshot.state, rules);
});

test('Auftragsnummern werden nie zweimal vergeben', () => {
  // Zwei Aufträge mit derselben Nummer machen `FILL_REQUEST` mehrdeutig.
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  server.rollRequest = mulberry32(5);
  server.stockRequests();

  const seen = new Set<number>(server.snapshot.state.requests.map((r) => r.id));
  const client = new Client(server.snapshot);

  // Ein paar Runden liefern und syncen — jedes Mal kommt Nachschub.
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
  // Die Leerlauf-Regel aus §6, als Test. Wer die App startet, soll nicht erst
  // eine Verbindung brauchen, um ein Ziel zu haben.
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  server.rollRequest = mulberry32(2);
  server.stockRequests();

  assert.equal(server.snapshot.state.requests.length, rules.requestQueueMax);

  const client = new Client(server.snapshot);
  assert.ok(client.state.requests.length >= rules.requestSlots);
  // Und die Felder laufen: Es gibt einen Weg von hier zum ersten Auftrag.
  assert.equal(client.start(0, R_WHEAT).ok, true);
});

test('Belohnungen sprengen das Lager nicht', () => {
  // Eine lagerpflichtige Belohnung braucht Platz — wie alles andere (§7).
  // Der Basis-Inhalt zahlt nur in Münzen, also über ein eigenes Regelwerk:
  // Die Regel muss stehen, bevor der erste Auftrag Ware ausschüttet.
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
    // Ein Hof mit Mühle, sonst gälte Futter als unerreichbar.
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

  // Mit Platz geht derselbe Auftrag durch — der Riegel ist die Kapazität,
  // nicht der Auftrag.
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

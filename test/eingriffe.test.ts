import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, DISCARD_QUEUE } from '../src/client/client.ts';
import { Server, xpFuerStufe } from '../src/server/server.ts';
import { getRuleset, LATEST_RULESET_VERSION, levelOf, slotsAt } from '../src/sim/rules.ts';
import { EMPTY_PLOT, count, initialState, type State } from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';

const T0 = 1_700_000_000_000;
const V = LATEST_RULESET_VERSION;
const rules = getRuleset(V);
const R_WHEAT = 0;
const plotIdx = (id: string) => rules.plots.findIndex((p) => p.id === id);
const COOP = plotIdx('coop-1');
const MILL = plotIdx('mill');

function setzeIrgendwo(s: State, plot: number, seq: number): State {
  if (!rules.grid || s.plots[plot]!.gx >= 0) return s;
  for (let gy = 0; gy < rules.grid.h; gy++) {
    for (let gx = 0; gx < rules.grid.w; gx++) {
      try {
        return simulate(s, { seq, tick: s.tick, type: 'PLACE', plot, gx, gy }, rules);
      } catch {
        // belegt oder gesperrt — weiter
      }
    }
  }
  throw new Error('nirgends Platz');
}

// Ein reicher Hof mit Huehnerstall — die Werkbank soll an etwas ansetzen koennen.
function reicherHof(): State {
  let s = initialState(rules);
  s = { ...s, xp: 5000, items: s.items.map((n, i) => (i === rules.currency ? 50_000 : n)) };
  s = simulate(s, { seq: 1, tick: 0, type: 'BUY', plot: COOP }, rules);
  s = setzeIrgendwo(s, COOP, 2);
  return s;
}

function hof() {
  const server = new Server(reicherHof(), T0, V);
  const client = new Client(server.snapshot, 'handy');
  return { server, client };
}

function abgleich(server: Server, client: Client, nowMs: number) {
  const res = server.sync(client.buildSyncRequest(), nowMs);
  assert.equal(res.ok, true, res.ok ? '' : `abgelehnt: ${res.reason}`);
  client.adopt(server.snapshot, DISCARD_QUEUE);
  return res;
}

test('Eingriffe warten auf den Abgleich und greifen NACH den Offline-Befehlen des Spielers', () => {
  const { server, client } = hof();
  // Der Spieler saet offline ...
  assert.equal(client.start(0, R_WHEAT).ok, true);
  // ... derweil die Werkbank alles fertigstellt und die Zettel erneuert.
  const zettelVorher = server.snapshot.state.requests.map((r) => r.id);
  server.eingreifen({ art: 'alles-fertig' });
  server.eingreifen({ art: 'zettel-neu' });
  assert.equal(server.eingriffe.length, 2, 'noch nicht angewendet');
  assert.equal(server.snapshot.state.plots[0]!.slots[0]!.recipe, EMPTY_PLOT, 'der Server weiss noch nichts von der Saat');

  abgleich(server, client, T0 + 1000);
  const st = server.snapshot.state;
  assert.equal(server.eingriffe.length, 0, 'abgearbeitet');
  const slot = st.plots[0]!.slots[0]!;
  assert.equal(slot.recipe, R_WHEAT, 'die Saat des Spielers ist da');
  assert.ok(st.tick - slot.startedAt >= rules.recipes[R_WHEAT]!.durationTicks, 'und schon reif');
  assert.ok(st.requests.length > 0 && st.requests.every((r) => !zettelVorher.includes(r.id)), 'lauter neue Zettel');
  // Das Geraet hat den Serverstand uebernommen — beide sehen dasselbe.
  assert.equal(client.preview().plots[0]!.slots[0]!.startedAt, slot.startedAt);
});

test('Kiste schicken: die Truhe wird beim Abgleich gewuerfelt und kommt mit der Post', () => {
  const { server, client } = hof();
  server.eingreifen({ art: 'kiste-schicken', kind: 0 });
  assert.equal(client.start(0, R_WHEAT).ok, true);
  const postVorher = server.pendingDeliveries.length + server.snapshot.state.mail.length;
  abgleich(server, client, T0 + 1000);
  const postNachher = server.pendingDeliveries.length + server.snapshot.state.mail.length;
  assert.ok(postNachher > postVorher, 'Beute im Postfach oder unterwegs');
  assert.deepEqual(server.snapshot.state.pendingBoxes, []);
  // Eine Kistenart, die es nicht gibt, bleibt folgenlos.
  server.eingreifen({ art: 'kiste-schicken', kind: 999 });
  server.receiveExternal(T0 + 2000);
  assert.deepEqual(server.snapshot.state.pendingBoxes, []);
});

test('Tier schenken: nur, solange im Stall Platz ist — ausgewachsen', () => {
  const { server } = hof();
  const plaetze = slotsAt(rules, COOP, 1);
  for (let i = 0; i < plaetze + 2; i++) server.eingreifen({ art: 'tier-schenken', plot: COOP });
  server.receiveExternal(T0 + 1000);
  const st = server.snapshot.state;
  assert.equal(st.plots[COOP]!.tiere.length, plaetze, 'voller Stall, nicht mehr');
  const grow = rules.plots[COOP]!.animal!.growTicks;
  assert.ok(st.plots[COOP]!.tiere.every((geboren) => st.tick - geboren >= grow), 'keine Kueken');
  // Ein Stall, der nicht steht, bekommt nichts.
  server.eingreifen({ art: 'tier-schenken', plot: plotIdx('coop-2') });
  server.receiveExternal(T0 + 2000);
  assert.equal(server.snapshot.state.plots[plotIdx('coop-2')]!.tiere.length, 0);
});

test('Bau schenken: liegt eingepackt bereit und wird kostenlos aufgestellt', () => {
  const { server, client } = hof();
  server.eingreifen({ art: 'bau-schenken', plot: MILL });
  server.eingreifen({ art: 'bau-schenken', plot: MILL });
  abgleich(server, client, T0 + 1000);
  assert.deepEqual(server.snapshot.state.eingepackt.filter((i) => i === MILL), [MILL], 'einmal, nicht zweimal');
  const goldVor = count(client.preview(), rules.currency);
  assert.equal(client.buy(MILL).ok, true);
  assert.equal(count(client.preview(), rules.currency), goldVor, 'kostet nichts');
  abgleich(server, client, T0 + 2000);
  assert.equal(server.snapshot.state.plots[MILL]!.level, 1);
  assert.equal(server.snapshot.state.eingepackt.includes(MILL), false);
  // Was schon steht, bekommt kein Paket.
  server.eingreifen({ art: 'bau-schenken', plot: MILL });
  server.receiveExternal(T0 + 3000);
  assert.equal(server.snapshot.state.eingepackt.includes(MILL), false);
});

test('Stufe setzen hebt nur an, nie ab — und trifft die Stufe genau', () => {
  for (const n of [2, 5, 12, 30]) {
    const xp = xpFuerStufe(rules, n);
    assert.equal(levelOf(rules, xp), n);
    assert.equal(levelOf(rules, xp - 1), n - 1);
  }
  const { server } = hof();
  const xpVor = server.snapshot.state.xp;
  server.eingreifen({ art: 'stufe', level: 2 });
  server.receiveExternal(T0 + 1000);
  assert.equal(server.snapshot.state.xp, xpVor, 'schon drueber — bleibt');
  server.eingreifen({ art: 'stufe', level: 20 });
  server.receiveExternal(T0 + 2000);
  assert.equal(levelOf(rules, server.snapshot.state.xp), 20);
});

test('Lager, Land, Hindernis, Boot, Booster, Wagen, Kiste auf dem Hof — jeder Eingriff prueft sich selbst', () => {
  const { server } = hof();
  const st0 = server.snapshot.state;
  const stufen = (rules.siloLevels ?? []).length;
  const erw = (rules.expansions ?? [])[0]!.id;
  server.eingreifen({ art: 'lager-ausbauen', stufen: 99 });
  server.eingreifen({ art: 'land-freimachen', id: erw });
  server.eingreifen({ art: 'land-freimachen', id: 'gibt-es-nicht' });
  server.eingreifen({ art: 'hindernis-raeumen', index: 0 });
  server.eingreifen({ art: 'hindernis-raeumen', index: 0 });
  server.eingreifen({ art: 'boot-reparieren' });
  server.eingreifen({ art: 'booster', ticks: 600 });
  server.eingreifen({ art: 'wagen-zurueck' });
  server.eingreifen({ art: 'kiste-auf-hof' });
  server.receiveExternal(T0 + 1000);
  const st = server.snapshot.state;
  assert.equal(st.siloLevel, stufen - 1, 'gedeckelt auf die letzte Stufe');
  assert.deepEqual(st.expandiert, [erw]);
  assert.deepEqual(st.clearedObstacles, [0]);
  assert.equal(st.bootRepariert, true);
  assert.ok(st.xpDoppeltBis >= st.tick + 600);
  assert.ok(st.truck.awayUntil <= st.tick);
  assert.ok(st.chestReadyAt <= st.tick);
  assert.equal(st.items[rules.currency], st0.items[rules.currency], 'kein Gold bewegt');
});

test('Abzug: nimmt nur, was nach den Offline-Befehlen noch da ist', () => {
  const { server, client } = hof();
  const WHEAT = 1;
  server.snapshot = { ...server.snapshot, state: { ...server.snapshot.state, items: server.snapshot.state.items.map((n, i) => (i === WHEAT ? 5 : n)) } };
  client.adopt(server.snapshot, DISCARD_QUEUE);
  // Der Spieler verbraucht offline drei Weizen (Huehnerfutter braucht die Muehle — nehmen wir DISCARD).
  assert.equal(client.discard(WHEAT, 3).ok, true);
  server.nimmAb(WHEAT, 3);
  abgleich(server, client, T0 + 1000);
  assert.equal(count(server.snapshot.state, WHEAT), 2, 'der Abzug passte nicht mehr und blieb aus');
});

test('Zuruecksetzen leert auch die Warteschlangen der Werkbank', () => {
  const { server } = hof();
  server.eingreifen({ art: 'alles-fertig' });
  server.grantXp(50);
  server.nimmAb(1, 1);
  server.reset(initialState(rules), T0 + 5000, V);
  assert.equal(server.eingriffe.length, 0);
  assert.equal(server.pendingXp, 0);
  assert.equal(server.pendingAbzuege.length, 0);
});

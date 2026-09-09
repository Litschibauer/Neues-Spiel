import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, DISCARD_QUEUE } from '../src/client/client.ts';
import { Server } from '../src/server/server.ts';
import { CURRENT_RULESET_VERSION, getRuleset } from '../src/sim/rules.ts';
import { ZAEHLER, initialState, zaehlerStand } from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';
import { migrateState } from '../src/sim/migrate.ts';

const T0 = 1_700_000_000_000;
const TAG_MS = 86_400_000;
const rules = getRuleset(CURRENT_RULESET_VERSION);
const R_WHEAT = 0;

test('Ernten und Starten laufen in die Lebenszeit-Zähler', () => {
  let s = initialState(rules);
  assert.equal(zaehlerStand(s, ZAEHLER.STARTEN), 0, 'ein frischer Hof hat nichts geleistet');

  s = simulate(s, { seq: 1, tick: 0, type: 'START', plot: 0, recipe: R_WHEAT }, rules);
  assert.equal(zaehlerStand(s, ZAEHLER.STARTEN), 1);
  assert.equal(zaehlerStand(s, ZAEHLER.ERNTEN), 0, 'Säen ist noch keine Ernte');

  s = simulate(s, { seq: 2, tick: 7200, type: 'COLLECT', plot: 0 }, rules);
  assert.equal(zaehlerStand(s, ZAEHLER.ERNTEN), 1);
});

test('verkaufte Ware zählt nach Stück, verdientes Gold nach Betrag', () => {
  let s = initialState(rules);
  const goldVorher = s.items[rules.currency] ?? 0;

  s = simulate(s, { seq: 1, tick: 0, type: 'SELL_NPC', item: 1, amount: 3 }, rules);

  assert.equal(zaehlerStand(s, ZAEHLER.VERKAUFT), 3, 'drei Stück, nicht ein Verkauf');
  const dazu = (s.items[rules.currency] ?? 0) - goldVorher;
  assert.ok(dazu > 0, 'der Verkauf hat Gold gebracht');
  assert.equal(zaehlerStand(s, ZAEHLER.GOLD), dazu, 'genau das verdiente Gold steht im Zähler');
});

test('ein abgelehnter Befehl zählt nichts — nur was wirklich passiert ist', () => {
  const s = initialState(rules);
  assert.throws(() => simulate(s, { seq: 1, tick: 0, type: 'COLLECT', plot: 0 }, rules));
  assert.equal(zaehlerStand(s, ZAEHLER.ERNTEN), 0);
});

test('die Sim fasst den Server-Tag nie an — nur der Server stempelt ihn', () => {
  let s = { ...initialState(rules), serverTag: 20_000 };
  s = simulate(s, { seq: 1, tick: 0, type: 'START', plot: 0, recipe: R_WHEAT }, rules);
  s = simulate(s, { seq: 2, tick: 7200, type: 'COLLECT', plot: 0 }, rules);
  assert.equal(s.serverTag, 20_000, 'Befehle dürfen den Kalendertag nicht verschieben');
});

test('der Server stempelt seinen Kalendertag in den Spielstand', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  client.start(0, R_WHEAT);
  const res = server.sync(client.buildSyncRequest(), T0);
  assert.equal(res.ok, true);

  const erwartet = Math.floor(T0 / TAG_MS);
  assert.equal(server.snapshot.state.serverTag, erwartet, 'der Tag kommt von der Serveruhr');
});

test('der Tag rollt erst beim nächsten Kontakt weiter, der Fortschritt zählt trotzdem', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  client.start(0, R_WHEAT);
  assert.equal(server.sync(client.buildSyncRequest(), T0).ok, true);
  const tagEins = server.snapshot.state.serverTag;

  // Der Client geht offline: adoptiert den Stand, spielt weiter, synct nicht.
  client.adopt(server.snapshot, DISCARD_QUEUE);
  client.advanceClock(7200);
  client.collect(0);

  assert.equal(
    client.preview().serverTag,
    tagEins,
    'ohne Verbindung bleibt der Tag stehen — Aufgaben rollen nicht weiter',
  );
  assert.ok(
    zaehlerStand(client.preview(), ZAEHLER.ERNTEN) > 0,
    'gesammelt wird trotzdem, sonst wäre Offline-Spielen wertlos',
  );

  // Erst der Kontakt am nächsten Tag setzt den Tag weiter.
  const spaeter = T0 + TAG_MS;
  assert.equal(server.sync(client.buildSyncRequest(), spaeter).ok, true);
  assert.equal(server.snapshot.state.serverTag, tagEins + 1, 'jetzt ist der neue Tag da');
  assert.ok(
    zaehlerStand(server.snapshot.state, ZAEHLER.ERNTEN) > 0,
    'die Offline-Ernte ist beim Server angekommen',
  );
});

test('die Geräteuhr verschiebt den Tag nicht — der Server bleibt die Quelle', () => {
  const server = new Server(initialState(rules), T0, CURRENT_RULESET_VERSION);
  const client = new Client(server.snapshot);

  client.start(0, R_WHEAT);
  assert.equal(server.sync(client.buildSyncRequest(), T0).ok, true);

  // Ein Client, der behauptet, es sei ein Jahr später.
  const geschummelt = { ...server.snapshot, state: { ...server.snapshot.state, serverTag: 99_999 } };
  const betrueger = new Client(geschummelt);
  betrueger.advanceClock(60);
  betrueger.start(1, R_WHEAT);
  server.sync(betrueger.buildSyncRequest(), T0 + 60_000);

  assert.equal(
    server.snapshot.state.serverTag,
    Math.floor((T0 + 60_000) / TAG_MS),
    'der Server überschreibt den erfundenen Tag mit seinem eigenen',
  );
});

test('ein Hof aus v37 bekommt Zähler auf null und einen noch leeren Server-Tag', () => {
  const alt = initialState(getRuleset(37));
  const roh = { ...alt } as Record<string, unknown>;
  delete roh.zaehler;
  delete roh.serverTag;

  const neu = migrateState(roh as never, 37, 38);

  assert.equal(neu.zaehler.length, 9, 'alle Zählerplätze sind da');
  assert.ok(
    neu.zaehler.every((n) => n === 0),
    'rückwirkend zählen lässt sich nichts',
  );
  assert.equal(neu.serverTag, 0, 'der Tag kommt erst beim ersten Kontakt');
});

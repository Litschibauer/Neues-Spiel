import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, DISCARD_QUEUE } from '../src/client/client.ts';
import { Server } from '../src/server/server.ts';
import { PRODUCTION_VERSIONS, getRuleset, tagesAufgabenFuer, wochenAufgabenFuer } from '../src/sim/rules.ts';
import {
  WOCHE_ABSCHLUSS,
  ZAEHLER,
  count,
  initialState,
  wocheVonTag,
  wochenAbgenommen,
  wochenFortschritt,
} from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';
import { migrateState } from '../src/sim/migrate.ts';

const T0 = 1_700_000_000_000;
const TAG_MS = 86_400_000;
const rules = getRuleset(42);
const R_WHEAT = 0;
const TAG = Math.floor(T0 / TAG_MS);
const WOCHE = wocheVonTag(TAG);

test('die Woche beginnt am Montag — Tag 0 der Epoche war ein Donnerstag', () => {
  // 1970-01-05 war ein Montag: Tag 4.
  assert.equal(wocheVonTag(3), 0, 'Sonntag, 4.1.1970, gehört noch zur ersten Woche');
  assert.equal(wocheVonTag(4), 1, 'Montag, 5.1.1970, eröffnet die zweite');
  assert.equal(wocheVonTag(10), 1, 'Sonntag, 11.1.1970, schließt sie');
  assert.equal(wocheVonTag(11), 2);
  // Und ein beliebiger Montag heute: 2026-09-07 (Tag 20703).
  const montag = Math.floor(Date.UTC(2026, 8, 7) / TAG_MS);
  assert.equal(wocheVonTag(montag), wocheVonTag(montag - 1) + 1, 'ein Montag beginnt eine neue Woche');
  assert.equal(wocheVonTag(montag + 6), wocheVonTag(montag), 'der Sonntag danach gehört noch dazu');
});

test('die Wochenaufgaben stehen fest und unterscheiden sich von den Tagesaufgaben', () => {
  const a = wochenAufgabenFuer(rules, WOCHE, 10).map((x) => x.id);
  const b = wochenAufgabenFuer(rules, WOCHE, 10).map((x) => x.id);
  assert.deepEqual(a, b, 'Client und Server müssen ohne Absprache dieselbe Woche sehen');
  assert.equal(a.length, rules.aufgabenProWoche);
  assert.ok(a.every((id) => id.startsWith('w-')), 'Wochenzettel kommen aus dem Wochentopf');
  const tages = tagesAufgabenFuer(rules, TAG, 10).map((x) => x.id);
  assert.ok(a.every((id) => !tages.includes(id)), 'kein Zettel hängt zweimal am Brett');
});

test('eine andere Woche bringt andere Zettel', () => {
  const diese = wochenAufgabenFuer(rules, WOCHE, 10).map((x) => x.id).join();
  let anders = false;
  for (let w = 1; w <= 6 && !anders; w++) {
    if (wochenAufgabenFuer(rules, WOCHE + w, 10).map((x) => x.id).join() !== diese) anders = true;
  }
  assert.ok(anders, 'in sechs Wochen muss sich der Satz mindestens einmal ändern');
});

test('die Tagesaufgaben sind durch die Woche nicht verrutscht', () => {
  // Die Ziehung wurde geteilt — der Tag muss dieselbe Reihe liefern wie vorher.
  const alt = tagesAufgabenFuer(getRuleset(41), TAG, 10).map((x) => x.id);
  const neu = tagesAufgabenFuer(rules, TAG, 10).map((x) => x.id);
  assert.deepEqual(neu, alt);
});

function hofMitWoche() {
  const server = new Server(initialState(rules), T0, 42);
  const client = new Client(server.snapshot);
  client.start(0, R_WHEAT);
  assert.equal(server.sync(client.buildSyncRequest(), T0).ok, true);
  client.adopt(server.snapshot, DISCARD_QUEUE);
  return { server, client };
}

test('der Server stempelt die Woche zusammen mit dem Tag', () => {
  const { server } = hofMitWoche();
  const st = server.snapshot.state;
  assert.equal(st.wochenNummer, WOCHE);
  assert.deepEqual(st.wochenStart, st.zaehler, 'der Nullpunkt ist der Stand bei Wochenbeginn');
  assert.deepEqual(st.wochenGeholt, []);
});

test('Wochenfortschritt zählt ab Wochenbeginn und überlebt den Tageswechsel', () => {
  const { server, client } = hofMitWoche();
  client.advanceClock(10);
  client.start(1, R_WHEAT);
  assert.equal(server.sync(client.buildSyncRequest(), T0 + 20_000).ok, true);
  const vorher = wochenFortschritt(server.snapshot.state, ZAEHLER.STARTEN);
  assert.ok(vorher > 0);

  // Ein Tag später, dieselbe Woche: Der Tag setzt zurück, die Woche nicht.
  client.adopt(server.snapshot, DISCARD_QUEUE);
  client.advanceClock(5);
  client.start(2, R_WHEAT);
  const naechsterTag = T0 + TAG_MS;
  assert.equal(wocheVonTag(Math.floor(naechsterTag / TAG_MS)), WOCHE, 'für den Test muss der nächste Tag in derselben Woche liegen');
  assert.equal(server.sync(client.buildSyncRequest(), naechsterTag).ok, true);
  const st = server.snapshot.state;
  assert.equal(st.tagNummer, TAG + 1, 'der Tag ist weiter');
  assert.equal(st.wochenNummer, WOCHE, 'die Woche nicht');
  assert.equal(wochenFortschritt(st, ZAEHLER.STARTEN), vorher + 1, 'die Woche zählt beide Tage zusammen');
});

test('der Wochenwechsel setzt Fortschritt und Abholungen zurück', () => {
  const { server, client } = hofMitWoche();
  client.advanceClock(10);
  client.start(1, R_WHEAT);
  assert.equal(server.sync(client.buildSyncRequest(), T0 + 20_000).ok, true);

  client.adopt(server.snapshot, DISCARD_QUEUE);
  client.advanceClock(5);
  client.start(2, R_WHEAT);
  assert.equal(server.sync(client.buildSyncRequest(), T0 + 7 * TAG_MS).ok, true);
  const st = server.snapshot.state;
  assert.equal(st.wochenNummer, WOCHE + 1);
  assert.deepEqual(st.wochenGeholt, []);
  assert.deepEqual(st.wochenStart, st.zaehler);
  assert.equal(wochenFortschritt(st, ZAEHLER.STARTEN), 0);
});

const SATZ = wochenAufgabenFuer(rules, WOCHE, 1).length;
function hofMitAbnahmen(anzahl: number) {
  const diese = wochenAufgabenFuer(rules, WOCHE, 1);
  return {
    ...initialState(rules),
    serverTag: TAG,
    tagNummer: TAG,
    wochenNummer: WOCHE,
    wochenGeholt: diese.slice(0, anzahl).map((a) => a.id),
  };
}

test('abholen geht erst, wenn der Wochenzettel wirklich erfüllt ist', () => {
  const { client } = hofMitWoche();
  const auf = wochenAufgabenFuer(rules, WOCHE, 1).find((a) => a.art === ZAEHLER.STARTEN);
  assert.ok(auf, 'für den Test braucht es einen Sä-Zettel in dieser Woche');
  const res = client.claimWeekTask(auf.id);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'NOT_YET_EARNED');
});

test('solange ein Wochenzettel offen ist, gibt es keinen Wochenabschluss', () => {
  assert.ok(SATZ > 0);
  const s = hofMitAbnahmen(SATZ - 1);
  assert.throws(() => simulate(s, { seq: 1, tick: 0, type: 'CLAIM_WEEK' }, rules), /NOT_YET_EARNED/);
});

test('der Wochenabschluss zahlt Gold und XP und legt die Wochentruhe in die Warteschlange', () => {
  const s = hofMitAbnahmen(SATZ);
  const lohn = rules.wochenAbschluss!;
  const fertig = simulate(s, { seq: 1, tick: 0, type: 'CLAIM_WEEK' }, rules);
  assert.equal(count(fertig, rules.currency), count(s, rules.currency) + lohn.gold);
  assert.equal(fertig.xp, s.xp + lohn.xp);
  assert.ok(fertig.wochenGeholt.includes(WOCHE_ABSCHLUSS));
  assert.deepEqual(fertig.pendingBoxes, [lohn.kiste], 'die Truhe wartet auf den Server');
  assert.equal(rules.chestKinds![lohn.kiste!]!.id, 'wochentruhe');
  assert.throws(() => simulate(fertig, { seq: 2, tick: 1, type: 'CLAIM_WEEK' }, rules), /ALREADY_CLAIMED/);
});

test('der Server würfelt die Wochentruhe beim nächsten Kontakt und liefert sie mit der Post', () => {
  const server = new Server(hofMitAbnahmen(SATZ) as never, T0, 42);
  const client = new Client(server.snapshot);
  const postVor = server.snapshot.state.mail.length;
  assert.equal(client.claimWeek().ok, true);
  assert.equal(server.sync(client.buildSyncRequest(), T0 + 1000).ok, true);
  const st = server.snapshot.state;
  assert.deepEqual(st.pendingBoxes, [], 'die Truhe ist aufgemacht');
  assert.ok(st.mail.length > postVor, 'die Beute liegt in der Post');
});

test('die Wochentruhe hängt hinten an — keine alte Kiste hat ihren Platz gewechselt', () => {
  const alt = getRuleset(41).chestKinds!;
  const neu = rules.chestKinds!;
  assert.equal(neu.length, alt.length + 1);
  alt.forEach((k, i) => assert.equal(neu[i]!.id, k.id));
});

test('ein Hof aus v41 bekommt eine leere Woche, die der Server dann füllt', () => {
  const roh = { ...initialState(getRuleset(41)) } as Record<string, unknown>;
  delete roh.wochenNummer;
  delete roh.wochenStart;
  delete roh.wochenGeholt;
  const neu = migrateState(roh as never, 41, 42);
  assert.equal(neu.wochenNummer, 0);
  assert.deepEqual(neu.wochenStart, []);
  assert.deepEqual(neu.wochenGeholt, []);
  assert.equal(wochenAbgenommen(neu), 0);
});

test('keine Aufgabe heißt wie der Wochenabschluss, und keine Wochen-Id kollidiert mit einer Tages-Id', () => {
  for (const version of PRODUCTION_VERSIONS) {
    const r = getRuleset(version);
    const tages = new Set((r.tagesaufgaben ?? []).map((a) => a.id));
    for (const a of r.wochenaufgaben ?? []) {
      assert.notEqual(a.id, WOCHE_ABSCHLUSS);
      assert.ok(!tages.has(a.id), `Regelwerk ${version}: „${a.id}" ist Tag und Woche zugleich`);
    }
  }
});

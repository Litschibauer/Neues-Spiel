import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, DISCARD_QUEUE } from '../src/client/client.ts';
import { Server } from '../src/server/server.ts';
import { PRODUCTION_VERSIONS, getRuleset, tagesAufgabenFuer } from '../src/sim/rules.ts';
import {
  TAG_ABSCHLUSS,
  ZAEHLER,
  count,
  initialState,
  tagesAbgenommen,
  tagesFortschritt,
} from '../src/sim/state.ts';
import { simulate } from '../src/sim/sim.ts';

const T0 = 1_700_000_000_000;
const TAG_MS = 86_400_000;
const rules = getRuleset(39);
const R_WHEAT = 0;
const TAG = Math.floor(T0 / TAG_MS);

test('die Aufgaben eines Tages stehen fest — jede Rechnung liefert dasselbe', () => {
  const a = tagesAufgabenFuer(rules, TAG, 10);
  const b = tagesAufgabenFuer(rules, TAG, 10);
  assert.deepEqual(
    a.map((x) => x.id),
    b.map((x) => x.id),
    'Client und Server müssen ohne Absprache dieselben Aufgaben sehen',
  );
  assert.equal(a.length, rules.aufgabenProTag);
});

test('ein anderer Tag bringt andere Aufgaben', () => {
  const heute = tagesAufgabenFuer(rules, TAG, 10).map((x) => x.id);
  let andersGefunden = false;
  for (let i = 1; i <= 7 && !andersGefunden; i++) {
    const morgen = tagesAufgabenFuer(rules, TAG + i, 10).map((x) => x.id);
    if (morgen.join() !== heute.join()) andersGefunden = true;
  }
  assert.ok(andersGefunden, 'in einer Woche muss sich der Satz mindestens einmal ändern');
});

test('eine Aufgabe kommt nie doppelt an einem Tag vor', () => {
  for (let t = TAG; t < TAG + 60; t++) {
    const ids = tagesAufgabenFuer(rules, t, 20).map((x) => x.id);
    assert.equal(new Set(ids).size, ids.length, `Tag ${t} hat eine Aufgabe doppelt: ${ids}`);
  }
});

test('Anfänger bekommen nur Aufgaben, die sie überhaupt erreichen können', () => {
  for (let t = TAG; t < TAG + 30; t++) {
    for (const a of tagesAufgabenFuer(rules, t, 1)) {
      assert.ok(
        (a.minLevel ?? 0) <= 1,
        `Stufe 1 bekam "${a.id}", die erst ab Stufe ${a.minLevel} geht`,
      );
    }
  }
});

test('ohne Serverkontakt gibt es keine Aufgaben und nichts abzuholen', () => {
  const s = initialState(rules);
  assert.equal(s.serverTag, 0);
  assert.equal(tagesFortschritt(s, ZAEHLER.ERNTEN), 0);
  assert.throws(
    () => simulate(s, { seq: 1, tick: 0, type: 'CLAIM_TASK', id: 'ernte10' }, rules),
    /NO_TASKS_YET/,
  );
});

// Ein Hof, der schon Kontakt hatte: Der Server hat Tag und Nullpunkt gesetzt.
function hofMitTag() {
  const server = new Server(initialState(rules), T0, 39);
  const client = new Client(server.snapshot);
  client.start(0, R_WHEAT);
  assert.equal(server.sync(client.buildSyncRequest(), T0).ok, true);
  client.adopt(server.snapshot, DISCARD_QUEUE);
  return { server, client };
}

test('der Server setzt Tag und Nullpunkt gemeinsam', () => {
  const { server } = hofMitTag();
  const st = server.snapshot.state;
  assert.equal(st.serverTag, TAG);
  assert.equal(st.tagNummer, TAG, 'Tag und Nullpunkt dürfen nicht auseinanderlaufen');
  assert.deepEqual(st.tagStart, st.zaehler, 'der Nullpunkt ist der Stand bei Tagesbeginn');
  assert.deepEqual(st.tagGeholt, []);
});

test('Fortschritt zählt ab Tagesbeginn, nicht ab Hofgründung', () => {
  const { server, client } = hofMitTag();
  const vorher = tagesFortschritt(client.preview(), ZAEHLER.STARTEN);

  client.advanceClock(10);
  client.start(1, R_WHEAT);
  assert.equal(
    tagesFortschritt(client.preview(), ZAEHLER.STARTEN),
    vorher + 1,
    'was heute passiert, zählt für heute',
  );
  assert.ok(server.snapshot.state.zaehler[ZAEHLER.STARTEN]! > 0, 'der Lebenszeit-Zähler läuft weiter');
});

test('abholen geht erst, wenn die Aufgabe wirklich erfüllt ist', () => {
  const { client } = hofMitTag();
  const auf = tagesAufgabenFuer(rules, TAG, 1).find((a) => a.art === ZAEHLER.STARTEN);
  assert.ok(auf, 'für den Test braucht es eine Sä-Aufgabe an diesem Tag');

  const zuFrueh = client.claimTask(auf.id);
  assert.equal(zuFrueh.ok, false);
  assert.equal(zuFrueh.code, 'NOT_YET_EARNED');
});

test('erfüllte Aufgabe zahlt genau einmal aus', () => {
  const { client } = hofMitTag();
  const auf = tagesAufgabenFuer(rules, TAG, 1).find((a) => a.art === ZAEHLER.STARTEN);
  assert.ok(auf);

  // So oft ansetzen und abernten, bis die Aufgabe voll ist.
  let plot = 0;
  while (tagesFortschritt(client.preview(), ZAEHLER.STARTEN) < auf.menge) {
    client.advanceClock(1);
    if (!client.start(plot, R_WHEAT).ok) {
      client.advanceClock(7200);
      client.collect(plot);
      continue;
    }
    plot = (plot + 1) % 3;
  }

  const goldVor = count(client.preview(), rules.currency);
  const xpVor = client.preview().xp;

  const erste = client.claimTask(auf.id);
  assert.equal(erste.ok, true, 'jetzt ist sie erfüllt');
  assert.equal(count(client.preview(), rules.currency), goldVor + auf.gold);
  assert.equal(client.preview().xp, xpVor + auf.xp);

  const zweite = client.claimTask(auf.id);
  assert.equal(zweite.ok, false, 'zweimal abholen geht nicht');
  assert.equal(zweite.code, 'ALREADY_CLAIMED');
});

test('eine Aufgabe, die heute gar nicht dran ist, lässt sich nicht abholen', () => {
  const { client } = hofMitTag();
  const heute = new Set(tagesAufgabenFuer(rules, TAG, 1).map((a) => a.id));
  const fremd = rules.tagesaufgaben!.find((a) => !heute.has(a.id));
  assert.ok(fremd);

  const res = client.claimTask(fremd.id);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'NO_SUCH_TASK');
});

// Der gefährlichste Fall beim Umstieg: Ein Stand, der noch unter v38 auf die
// Platte kam, trägt den Kalendertag schon, den Nullpunkt der Aufgaben aber
// nicht. Wird das nicht getrennt geprüft, zählt die gesamte Lebensleistung als
// heute geleistet und alle Aufgaben sind sofort erfüllt.
test('ein Stand aus v38 startet mit leerem Tageskonto, nicht mit seiner Lebensleistung', () => {
  const heute = Math.floor((T0 + 7300 * 1000) / TAG_MS);
  const alt = initialState(getRuleset(38));
  const gespeichert = {
    ...alt,
    serverTag: heute,
    zaehler: [7, 7, 2, 0, 0, 0, 0, 0, 0],
  } as Record<string, unknown>;
  delete gespeichert.tagNummer;
  delete gespeichert.tagStart;
  delete gespeichert.tagGeholt;

  const server = new Server(gespeichert as never, T0 + 7200 * 1000, 38, 39);
  const client = new Client(server.snapshot);
  client.advanceClock(60);
  client.start(0, R_WHEAT);
  assert.equal(server.sync(client.buildSyncRequest(), T0 + 7300 * 1000).ok, true);

  const st = server.snapshot.state;
  assert.equal(st.tagNummer, heute, 'der Nullpunkt wird nachgezogen');
  assert.equal(
    tagesFortschritt(st, ZAEHLER.ERNTEN),
    0,
    'die sieben Ernten von früher zählen nicht für heute',
  );
  assert.ok(st.zaehler[ZAEHLER.ERNTEN]! >= 7, 'der Lebenszeit-Zähler bleibt aber erhalten');
});

test('der Tageswechsel setzt Fortschritt und Abholungen zurück', () => {
  const { server, client } = hofMitTag();

  client.advanceClock(10);
  client.start(1, R_WHEAT);
  assert.equal(server.sync(client.buildSyncRequest(), T0 + 20_000).ok, true);
  assert.ok(tagesFortschritt(server.snapshot.state, ZAEHLER.STARTEN) > 0);

  client.adopt(server.snapshot, DISCARD_QUEUE);
  client.advanceClock(5);
  client.start(2, R_WHEAT);
  assert.equal(server.sync(client.buildSyncRequest(), T0 + TAG_MS).ok, true);

  const st = server.snapshot.state;
  assert.equal(st.tagNummer, TAG + 1, 'der neue Tag ist da');
  assert.deepEqual(st.tagGeholt, [], 'Abholungen sind zurückgesetzt');
  assert.deepEqual(st.tagStart, st.zaehler, 'der Nullpunkt sitzt auf dem aktuellen Stand');
  assert.equal(
    tagesFortschritt(st, ZAEHLER.STARTEN),
    0,
    'der Fortschritt von gestern zählt heute nicht mehr',
  );
});

// — Der Tagesabschluss ————————————————————————————————————————————————
// Drei Zettel sind schnell erzaehlt, aber ohne Schlussstrich bleibt der Tag
// ein Sack voll Einzelaufgaben. Der Abschluss ist der Grund, den dritten auch
// noch zu holen, statt nach dem zweiten aufzuhoeren.
const regelnMitAbschluss = getRuleset(40);

// Ein Hof mit Tag und schon abgenommenen Zetteln — ohne den langen Weg dorthin.
function hofMitAbnahmen(anzahl: number) {
  const heute = tagesAufgabenFuer(regelnMitAbschluss, TAG, 1);
  return {
    ...initialState(regelnMitAbschluss),
    serverTag: TAG,
    tagNummer: TAG,
    tagGeholt: heute.slice(0, anzahl).map((a) => a.id),
  };
}

test('solange ein Zettel offen ist, gibt es keinen Abschluss', () => {
  const s = hofMitAbnahmen(SATZ_HEUTE - 1);
  assert.throws(
    () => simulate(s, { seq: 1, tick: 0, type: 'CLAIM_DAY' }, regelnMitAbschluss),
    /NOT_YET_EARNED/,
  );
});

// Auf Stufe 1 gibt der Topf nur zwei Aufgaben her — der Abschluss verlangt
// deshalb den heutigen Satz, nicht die Wunschzahl. Sonst koennten ausgerechnet
// Anfaenger ihn nie holen.
const SATZ_HEUTE = tagesAufgabenFuer(getRuleset(40), TAG, 1).length;

test('auf Stufe 1 ist der Satz kürzer als drei — der Abschluss richtet sich danach', () => {
  assert.ok(SATZ_HEUTE > 0 && SATZ_HEUTE < 3, `Stufe 1 bekam ${SATZ_HEUTE} Aufgaben`);
  const s = hofMitAbnahmen(SATZ_HEUTE);
  assert.doesNotThrow(() => simulate(s, { seq: 1, tick: 0, type: 'CLAIM_DAY' }, regelnMitAbschluss));
});

test('wer alle Zettel abnimmt, schließt den Tag ab — und das genau einmal', () => {
  const s = hofMitAbnahmen(SATZ_HEUTE);
  const lohn = regelnMitAbschluss.tagesAbschluss!;
  const goldVor = count(s, regelnMitAbschluss.currency);

  const fertig = simulate(s, { seq: 1, tick: 0, type: 'CLAIM_DAY' }, regelnMitAbschluss);
  assert.equal(count(fertig, regelnMitAbschluss.currency), goldVor + lohn.gold);
  assert.equal(fertig.xp, s.xp + lohn.xp);
  assert.ok(fertig.tagGeholt.includes(TAG_ABSCHLUSS));

  assert.throws(
    () => simulate(fertig, { seq: 2, tick: 1, type: 'CLAIM_DAY' }, regelnMitAbschluss),
    /ALREADY_CLAIMED/,
  );
});

test('der Abschluss zählt sich selbst nicht als Zettel', () => {
  // Sonst waere er mit einem Zettel weniger plus dem Eintrag von sich selbst
  // zu haben.
  const basis = hofMitAbnahmen(SATZ_HEUTE - 1);
  const s = { ...basis, tagGeholt: [...basis.tagGeholt, TAG_ABSCHLUSS] };
  assert.equal(tagesAbgenommen(s), SATZ_HEUTE - 1);
  assert.throws(
    () => simulate(s, { seq: 1, tick: 0, type: 'CLAIM_DAY' }, regelnMitAbschluss),
    /ALREADY_CLAIMED/,
  );
});

test('ein Regelwerk ohne Abschluss kennt den Befehl nicht', () => {
  const s = { ...initialState(rules), serverTag: TAG, tagNummer: TAG, tagGeholt: ['a', 'b', 'c'] };
  assert.throws(() => simulate(s, { seq: 1, tick: 0, type: 'CLAIM_DAY' }, rules), /NO_DAY_BONUS/);
});

test('ohne Serverkontakt gibt es auch keinen Abschluss', () => {
  const s = initialState(regelnMitAbschluss);
  assert.throws(
    () => simulate(s, { seq: 1, tick: 0, type: 'CLAIM_DAY' }, regelnMitAbschluss),
    /NO_TASKS_YET/,
  );
});

test('der Tageswechsel öffnet den Abschluss wieder', () => {
  const server = new Server(hofMitAbnahmen(SATZ_HEUTE) as never, T0, 40);
  const client = new Client(server.snapshot);
  assert.equal(client.claimDay().ok, true, 'heute geht er');
  assert.equal(server.sync(client.buildSyncRequest(), T0).ok, true);

  client.adopt(server.snapshot, DISCARD_QUEUE);
  client.advanceClock(5);
  client.start(0, R_WHEAT);
  assert.equal(server.sync(client.buildSyncRequest(), T0 + TAG_MS).ok, true);

  const st = server.snapshot.state;
  assert.deepEqual(st.tagGeholt, [], 'am neuen Tag ist die Liste leer');
  assert.equal(tagesAbgenommen(st), 0, 'und damit auch der Abschluss wieder zu verdienen');
});

test('keine Aufgabe heißt wie der Abschluss — sonst ließe er sich doppelt holen', () => {
  for (const version of PRODUCTION_VERSIONS) {
    for (const a of getRuleset(version).tagesaufgaben ?? []) {
      assert.notEqual(a.id, TAG_ABSCHLUSS, `Regelwerk ${version} hat eine Aufgabe „${TAG_ABSCHLUSS}"`);
    }
  }
});

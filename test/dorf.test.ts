import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/server/db.ts';
import { Dorf, DANKESWOCHE_MS, PROJEKTE, mengeFuer, type Messung } from '../src/server/dorf.ts';

const leer = (aktive: number): (() => Messung) => () => ({ aktive, vorrat: () => 0 });

const T0 = 1_700_000_000_000;

test('der Bedarf ist ein Anteil des gemessenen Vorrats — mit Grundmenge und Deckel', () => {
  assert.equal(mengeFuer(32, 0), 32, 'niemand hat es: Grundmenge');
  assert.equal(mengeFuer(32, 100), 32, 'zu wenig da: Grundmenge');
  assert.equal(mengeFuer(32, 1000), 300, '30 Prozent des Vorrats');
  assert.equal(mengeFuer(32, 1_000_000), 6400, 'Deckel: das Zweihundertfache');
});

test('beim Start wird gemessen, und die Mengen bleiben für das Projekt fest', () => {
  const db = openDb(':memory:');
  let vorrat = 2000;
  const dorf = new Dorf(db, () => ({ aktive: 40, vorrat: (item) => (item === 'plank' ? vorrat : 0) }));
  const s = dorf.stand(T0, 'anna');
  assert.equal(s.faktor, 40, 'aktive Höfe zur Anzeige');
  assert.equal(s.etappen[0]!.bedarf[0]!.menge, 600, 'Bretter: 30 Prozent von 2000');
  assert.equal(s.etappen[0]!.bedarf[1]!.menge, 6, 'Eisen hat niemand: Grundmenge');
  vorrat = 10;
  assert.equal(dorf.stand(T0 + 1, 'anna').etappen[0]!.bedarf[0]!.menge, 600, 'später gemessen ändert nichts mehr');
  assert.equal(dorf.offen('plank', T0 + 2), 600);
});

test('jedes Projekt hat Etappen, Bedarf und Dank, und jede Ware taucht auf', () => {
  for (const p of PROJEKTE) {
    assert.ok(p.etappen.length >= 2, p.id);
    for (const e of p.etappen) assert.ok(e.bedarf.length > 0 && e.bedarf.every((b) => b.menge > 0), p.id + '/' + e.name);
    assert.ok(p.dank.length > 0, p.id);
  }
});

test('Beiträge füllen Etappen, das Projekt wird fertig, dann läuft die Dankeswoche, dann kommt das nächste', () => {
  const db = openDb(':memory:');
  const dorf = new Dorf(db, leer(4));
  const s0 = dorf.stand(T0, 'anna');
  assert.equal(s0.projekt.id, 'brunnen');
  assert.equal(s0.faktor, 4);
  assert.equal(s0.etappe, 0);
  assert.equal(s0.fertig, false);
  assert.equal(s0.mein, 0);

  // Nicht gebraucht: Weizen, und Bretter über den Bedarf hinaus werden gekappt.
  assert.equal(dorf.offen('wheat', T0), 0);
  assert.equal(dorf.offen('plank', T0), 32);
  const zuviel = dorf.beitrag('anna', 'plank', 100, T0);
  assert.ok(zuviel.ok && zuviel.angenommen === 32 && !zuviel.etappeFertig, JSON.stringify(zuviel));
  assert.equal(dorf.offen('plank', T0), 0);
  assert.deepEqual(dorf.beitrag('anna', 'plank', 1, T0), { ok: false, grund: 'NOT_NEEDED' });

  const eisen = dorf.beitrag('ben', 'iron-bar', 6, T0 + 1000);
  assert.ok(eisen.ok && eisen.etappeFertig && !eisen.projektFertig, JSON.stringify(eisen));
  const s1 = dorf.stand(T0 + 2000, 'anna');
  assert.equal(s1.etappe, 1);
  assert.equal(s1.etappen[0]!.fertig, true);
  assert.equal(s1.etappen[0]!.bedarf[0]!.geliefert, 32);
  assert.equal(s1.mein, 32);
  assert.deepEqual(s1.helfer.map((h) => h.konto), ['anna', 'ben']);

  // Rest durchfüllen.
  let letzte = eisen;
  for (let i = 0; i < 6 && !(letzte.ok && letzte.projektFertig); i++) letzte = dorf.fuelle('carla', T0 + 5000 + i);
  assert.ok(letzte.ok && letzte.projektFertig, JSON.stringify(letzte));
  const s2 = dorf.stand(T0 + 10_000, 'carla');
  assert.equal(s2.fertig, true);
  assert.equal(s2.dankeswoche, true);
  assert.equal(s2.dankeswocheBis, s2.fertigMs + DANKESWOCHE_MS);
  assert.ok(s2.etappen.every((e) => e.fertig));
  assert.equal(dorf.dankeswoche(T0 + 10_000), true);
  assert.equal(dorf.offen('plank', T0 + 10_000), 0, 'fertig heißt: nichts mehr annehmen');

  // Nach der Dankeswoche: das nächste Projekt, neu gemessen.
  const spaeter = s2.fertigMs + DANKESWOCHE_MS + 1;
  const dorf2 = new Dorf(db, () => ({ aktive: 20, vorrat: (item) => (item === 'stake' ? 1000 : 0) }));
  const s3 = dorf2.stand(spaeter, 'anna');
  assert.equal(s3.projekt.id, 'bruecke');
  assert.equal(s3.faktor, 20);
  assert.equal(s3.fertig, false);
  assert.equal(s3.mein, 0, 'Beiträge zählen je Projekt');
  assert.equal(dorf2.offen('stake', spaeter), 300, 'neu gemessen: 30 Prozent von 1000');
  assert.equal(dorf2.dankeswoche(spaeter), false);
});

test('ein gelöschter Hof verschwindet von der Helferliste, seine Ware bleibt verbaut', () => {
  const db = openDb(':memory:');
  const dorf = new Dorf(db, leer(1));
  dorf.beitrag('anna', 'plank', 10, T0);
  dorf.beitrag('ben', 'plank', 6, T0);
  dorf.vergissHof('anna');
  const s = dorf.stand(T0, 'ben');
  assert.deepEqual(s.helfer, [{ konto: 'ben', menge: 6 }]);
  // Die Baustelle zählt nur noch, was noch da ist — ehrlich, aber nie negativ.
  assert.equal(dorf.offen('plank', T0), 26);
});

test('der Zwischenspeicher lügt nie: nach jedem Beitrag stimmt der Stand sofort', () => {
  const db = openDb(':memory:');
  const dorf = new Dorf(db, leer(1));
  const vorher = dorf.stand(T0, 'anna');
  assert.equal(vorher.etappen[0]!.bedarf[0]!.geliefert, 0);
  dorf.beitrag('anna', 'plank', 5, T0);
  const danach = dorf.stand(T0, 'anna');
  assert.equal(danach.etappen[0]!.bedarf[0]!.geliefert, 5);
  assert.equal(danach.mein, 5);
  dorf.beitrag('ben', 'plank', 1, T0 + 1);
  assert.deepEqual(dorf.stand(T0 + 2, 'ben').helfer.map((h) => h.konto), ['anna', 'ben']);
});

test('nach dem letzten Projekt bleibt das Bauwerk stehen — der Bahnhof steht, kein nächstes Projekt', () => {
  const db = openDb(':memory:');
  const dorf = new Dorf(db, leer(2), 1);
  let t = T0;
  for (let p = 0; p < PROJEKTE.length; p++) {
    let erg = dorf.fuelle('anna', t);
    for (let i = 0; i < 6 && !(erg.ok && erg.projektFertig); i++) erg = dorf.fuelle('anna', ++t);
    assert.ok(erg.ok && erg.projektFertig, `Projekt ${p} fertig`);
    t += 10;
  }
  assert.equal(dorf.alleGebaut(), true);
  assert.equal(dorf.bahnhofSteht(), true);
  const s = dorf.stand(t + 100_000, 'anna');
  assert.equal(s.projekt.id, 'bahnhof');
  assert.equal(s.fertig, true);
  assert.equal(s.alleGebaut, true);
  assert.equal(s.naechstesMs, 0, 'kein nächstes Projekt');
  assert.equal(dorf.offen('plank', t + 100_000), 0);
});

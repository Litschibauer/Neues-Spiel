import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/server/db.ts';
import { Dorf, DANKESWOCHE_MS, PROJEKTE, faktorFuer } from '../src/server/dorf.ts';

const T0 = 1_700_000_000_000;

test('der Bedarf wächst mit den aktiven Höfen, aber gedeckelt', () => {
  assert.equal(faktorFuer(0), 1);
  assert.equal(faktorFuer(4), 1);
  assert.equal(faktorFuer(8), 1);
  assert.equal(faktorFuer(9), 2);
  assert.equal(faktorFuer(80), 10);
  assert.equal(faktorFuer(100_000), 25);
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
  const dorf = new Dorf(db, () => 4);
  const s0 = dorf.stand(T0, 'anna');
  assert.equal(s0.projekt.id, 'brunnen');
  assert.equal(s0.faktor, 1);
  assert.equal(s0.etappe, 0);
  assert.equal(s0.fertig, false);
  assert.equal(s0.mein, 0);

  // Nicht gebraucht: Weizen, und Bretter über den Bedarf hinaus werden gekappt.
  assert.equal(dorf.offen('wheat', T0), 0);
  assert.equal(dorf.offen('plank', T0), 16);
  const zuviel = dorf.beitrag('anna', 'plank', 100, T0);
  assert.ok(zuviel.ok && zuviel.angenommen === 16 && !zuviel.etappeFertig, JSON.stringify(zuviel));
  assert.equal(dorf.offen('plank', T0), 0);
  assert.deepEqual(dorf.beitrag('anna', 'plank', 1, T0), { ok: false, grund: 'NOT_NEEDED' });

  const eisen = dorf.beitrag('ben', 'iron-bar', 3, T0 + 1000);
  assert.ok(eisen.ok && eisen.etappeFertig && !eisen.projektFertig, JSON.stringify(eisen));
  const s1 = dorf.stand(T0 + 2000, 'anna');
  assert.equal(s1.etappe, 1);
  assert.equal(s1.etappen[0]!.fertig, true);
  assert.equal(s1.etappen[0]!.bedarf[0]!.geliefert, 16);
  assert.equal(s1.mein, 16);
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

  // Nach der Dankeswoche: das nächste Projekt, mit neuem Faktor.
  const spaeter = s2.fertigMs + DANKESWOCHE_MS + 1;
  const dorf2 = new Dorf(db, () => 20);
  const s3 = dorf2.stand(spaeter, 'anna');
  assert.equal(s3.projekt.id, 'bruecke');
  assert.equal(s3.faktor, 3);
  assert.equal(s3.fertig, false);
  assert.equal(s3.mein, 0, 'Beiträge zählen je Projekt');
  assert.equal(dorf2.offen('stake', spaeter), 60);
  assert.equal(dorf2.dankeswoche(spaeter), false);
});

test('ein gelöschter Hof verschwindet von der Helferliste, seine Ware bleibt verbaut', () => {
  const db = openDb(':memory:');
  const dorf = new Dorf(db, () => 1);
  dorf.beitrag('anna', 'plank', 10, T0);
  dorf.beitrag('ben', 'plank', 6, T0);
  dorf.vergissHof('anna');
  const s = dorf.stand(T0, 'ben');
  assert.deepEqual(s.helfer, [{ konto: 'ben', menge: 6 }]);
  // Die Baustelle zählt nur noch, was noch da ist — ehrlich, aber nie negativ.
  assert.equal(dorf.offen('plank', T0), 10);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/server/db.ts';
import { Zug, ZUG_WAREN, ZUG_WAREN_JE_FAHRT, zugBestellung, zugWoche, zugAbfahrtMs } from '../src/server/zug.ts';
import { wochentagVon } from '../src/sim/rules.ts';
import { tagVon } from '../src/server/sozial.ts';

const T0 = 1_700_000_000_000;
const leer = () => ({ aktive: 3, vorrat: () => 0 });

test('die Bestellung hängt an der Woche: vier verschiedene Waren, überall dieselben', () => {
  const a = zugBestellung(7, () => 0);
  const b = zugBestellung(7, () => 0);
  const c = zugBestellung(8, () => 0);
  assert.equal(a.length, ZUG_WAREN_JE_FAHRT);
  assert.deepEqual(a, b, 'gleiche Woche, gleiche Bestellung');
  assert.notDeepEqual(a.map((x) => x.item), c.map((x) => x.item), 'andere Woche, andere Waren');
  assert.equal(new Set(a.map((x) => x.item)).size, a.length, 'keine Ware doppelt');
  for (const w of a) assert.ok(ZUG_WAREN.some((z) => z.item === w.item && z.menge === w.menge), 'ohne Vorrat: Grundmenge');
  const gross = zugBestellung(7, () => 1000);
  assert.ok(gross.every((w) => w.menge === 300), '30 Prozent von 1000');
});

test('Abfahrt ist der nächste Montag um Mitternacht', () => {
  const woche = zugWoche(T0);
  const ab = zugAbfahrtMs(woche);
  assert.ok(ab > T0);
  assert.equal(wochentagVon(tagVon(ab)), 0, 'Montag');
  assert.equal(zugWoche(ab - 1), woche, 'bis zur letzten Millisekunde dieselbe Woche');
  assert.equal(zugWoche(ab), woche + 1);
});

test('ohne Bahnhof kein Zug; mit Bahnhof eine Fahrt je Woche, Beiträge, Abfahrt, nächste Woche neu', () => {
  const db = openDb(':memory:');
  let steht = false;
  const zug = new Zug(db, leer, () => steht);
  assert.equal(zug.stand(T0, 'anna'), null);
  assert.equal(zug.offen('bread', T0), 0);
  steht = true;
  const s0 = zug.stand(T0, 'anna')!;
  assert.equal(s0.bestellung.length, ZUG_WAREN_JE_FAHRT);
  assert.equal(s0.fertig, false);
  assert.equal(s0.mein, 0);
  const erste = s0.bestellung[0]!;
  assert.equal(zug.offen(erste.item, T0), erste.menge);
  assert.equal(zug.offen('wheat', T0), 0, 'Weizen will niemand');

  const zuviel = zug.beitrag('anna', erste.item, 999, T0 + 1);
  assert.ok(zuviel.ok && zuviel.angenommen === erste.menge && !zuviel.fertig, JSON.stringify(zuviel));
  assert.deepEqual(zug.beitrag('anna', erste.item, 1, T0 + 2), { ok: false, grund: 'NOT_NEEDED' });
  let letzte = zug.fuelle('ben', T0 + 3);
  assert.ok(letzte.ok && letzte.fertig, 'alles drin — der Zug fährt');
  const s1 = zug.stand(T0 + 4, 'anna')!;
  assert.equal(s1.fertig, true);
  assert.deepEqual(s1.helfer.map((h) => h.konto).sort(), ['anna', 'ben']);
  assert.equal(s1.mein, erste.menge);
  assert.equal(zug.offen(erste.item, T0 + 5), 0, 'fertig heißt: nichts mehr annehmen');
  assert.deepEqual(zug.fuelle('carla', T0 + 6), { ok: false, grund: 'NOT_NEEDED' });

  // Nächste Woche: neue Fahrt, neue Bestellung, leere Helferliste.
  const naechste = zugAbfahrtMs(s1.woche) + 1;
  const s2 = zug.stand(naechste, 'anna')!;
  assert.equal(s2.woche, s1.woche + 1);
  assert.equal(s2.fertig, false);
  assert.equal(s2.helfer.length, 0);
  assert.equal(s2.mein, 0);
});

test('ein gelöschter Hof verschwindet aus der Helferliste', () => {
  const db = openDb(':memory:');
  const zug = new Zug(db, leer, () => true);
  const s = zug.stand(T0, 'anna')!;
  zug.beitrag('anna', s.bestellung[0]!.item, 1, T0);
  zug.beitrag('ben', s.bestellung[0]!.item, 1, T0 + 1);
  zug.vergissHof('anna');
  assert.deepEqual(zug.stand(T0 + 2, 'ben')!.helfer.map((h) => h.konto), ['ben']);
});

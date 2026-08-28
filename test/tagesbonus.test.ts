import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/server/db.ts';
import { Tagesbonus, stufeFuer, TAGESBONUS } from '../src/server/tagesbonus.ts';

const TAG = 86_400_000;

function mitKonto(): { db: ReturnType<typeof openDb>; id: string } {
  const db = openDb(':memory:');
  const id = 'a123';
  db.prepare(
    'insert into accounts (id, key_hash, created_at, last_seen_ms, game) values (?, ?, 0, 0, ?)',
  ).run(id, 'h', '{}');
  return { db, id };
}

test('die Leiter steigt und plateaut auf der letzten Stufe', () => {
  assert.equal(stufeFuer(1).gold, TAGESBONUS[0]!.gold);
  assert.equal(stufeFuer(7).gold, TAGESBONUS[6]!.gold);
  assert.equal(stufeFuer(99).gold, TAGESBONUS[6]!.gold, 'jenseits von Tag 7 bleibt es die letzte Stufe');
  assert.equal(stufeFuer(0).gold, TAGESBONUS[0]!.gold, 'nie unter Stufe 1');
});

test('der erste Bonus startet den Streak bei 1', () => {
  const { db, id } = mitKonto();
  const b = new Tagesbonus(db);
  const jetzt = 100 * TAG + 5000;
  assert.equal(b.status(id, jetzt).verfuegbar, true);
  const holen = b.hole(id, jetzt)!;
  assert.equal(holen.streak, 1);
  assert.equal(holen.lohn.gold, TAGESBONUS[0]!.gold);
});

test('zweimal am selben Tag geht nicht', () => {
  const { db, id } = mitKonto();
  const b = new Tagesbonus(db);
  const jetzt = 200 * TAG;
  b.hole(id, jetzt);
  assert.equal(b.status(id, jetzt).verfuegbar, false);
  assert.equal(b.hole(id, jetzt + 1000), null, 'ein zweites Mal am selben Tag ist gesperrt');
});

test('am Folgetag wächst der Streak', () => {
  const { db, id } = mitKonto();
  const b = new Tagesbonus(db);
  const tag = 300 * TAG;
  assert.equal(b.hole(id, tag)!.streak, 1);
  assert.equal(b.hole(id, tag + TAG)!.streak, 2);
  assert.equal(b.hole(id, tag + 2 * TAG)!.streak, 3);
});

test('ein ausgelassener Tag setzt den Streak zurück', () => {
  const { db, id } = mitKonto();
  const b = new Tagesbonus(db);
  const tag = 400 * TAG;
  b.hole(id, tag);
  b.hole(id, tag + TAG); // Streak 2
  const nachLuecke = b.hole(id, tag + 3 * TAG)!; // Tag 3 ausgelassen
  assert.equal(nachLuecke.streak, 1, 'nach einer Lücke fängt der Streak wieder bei 1 an');
});

test('der Status zeigt vorab, was es heute gäbe', () => {
  const { db, id } = mitKonto();
  const b = new Tagesbonus(db);
  const tag = 500 * TAG;
  b.hole(id, tag); // Streak 1
  const morgen = b.status(id, tag + TAG);
  assert.equal(morgen.verfuegbar, true);
  assert.equal(morgen.streak, 2, 'morgen wäre es Streak 2');
  assert.equal(morgen.heute.gold, TAGESBONUS[1]!.gold);
});

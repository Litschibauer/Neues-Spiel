import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/server/db.ts';
import { Sozial, nameAusCode, saubererName, tagVon } from '../src/server/sozial.ts';
import { Server } from '../src/server/server.ts';
import { Client } from '../src/client/client.ts';
import { LATEST_RULESET_VERSION, getRuleset, helpSpeedup } from '../src/sim/rules.ts';
import { initialState } from '../src/sim/state.ts';
import { mulberry32 } from './helpers/session.ts';

const T0 = 1_700_000_000_000;
const RULES = getRuleset(LATEST_RULESET_VERSION);

function db() {
  const d = openDb(':memory:');
  d.prepare(
    'insert into accounts (id, key_hash, created_at, last_seen_ms, game) values (?, ?, 0, 0, ?)',
  ).run('anna', 'h1', '{}');
  d.prepare(
    'insert into accounts (id, key_hash, created_at, last_seen_ms, game) values (?, ?, 0, 0, ?)',
  ).run('ben', 'h2', '{}');
  return d;
}

test('jeder Hof bekommt einen Code, und zwar immer denselben', () => {
  const sozial = new Sozial(db(), mulberry32(7));

  const erst = sozial.karte('anna')!;
  assert.match(erst.code, /^[ACDEFGHJKLMNPQRSTUVWXY3456789]{6}$/);
  assert.equal(sozial.karte('anna')!.code, erst.code, 'der Code wechselt zwischen zwei Blicken');

  const ben = sozial.karte('ben')!;
  assert.notEqual(ben.code, erst.code, 'zwei Höfe teilen sich einen Code');

  assert.equal(sozial.perCode(erst.code)!.id, 'anna');
  assert.equal(sozial.perCode(erst.code.toLowerCase())!.id, 'anna', 'Kleinschreibung findet nichts');
  assert.equal(sozial.perCode('ZZZZZZ'), null);
});

test('ohne eigenen Namen trägt der Hof einen aus seinem Code', () => {
  const sozial = new Sozial(db(), mulberry32(3));
  const karte = sozial.karte('anna')!;
  assert.equal(karte.name, nameAusCode(karte.code));
  assert.ok(karte.name.length > 3);

  assert.equal(sozial.benenne('anna', 'Bauernhof Meier'), true);
  assert.equal(sozial.karte('anna')!.name, 'Bauernhof Meier');

  assert.equal(sozial.benenne('anna', 'x'), false, 'ein Zeichen reicht als Name');
  assert.equal(sozial.benenne('anna', '<script>'), false, 'Markup kommt durch');
  assert.equal(sozial.karte('anna')!.name, 'Bauernhof Meier', 'der alte Name ging verloren');
});

test('Namen werden aufgeräumt, nicht abgelehnt', () => {
  assert.equal(saubererName('  Zwei   Wörter '), 'Zwei Wörter');
  assert.equal(saubererName('Émile’s Hof-1'), 'Émile’s Hof-1');
  assert.equal(saubererName(''), null);
  assert.equal(saubererName('a'.repeat(40)), null);
});

test('Freundschaft braucht zwei — eine Anfrage reicht nicht', () => {
  const sozial = new Sozial(db(), mulberry32(11));
  sozial.karte('anna');
  sozial.karte('ben');

  assert.deepEqual(sozial.freunde('anna'), []);
  assert.equal(sozial.beziehung('anna', 'ben'), 'keine');

  assert.equal(sozial.frage('anna', 'ben', T0), 'gefragt');
  assert.equal(sozial.beziehung('anna', 'ben'), 'gefragt');
  assert.equal(sozial.beziehung('ben', 'anna'), 'wartet');
  assert.deepEqual(sozial.freunde('anna'), [], 'einseitig reicht schon als Freundschaft');
  assert.deepEqual(sozial.freunde('ben'), []);
  assert.equal(sozial.anfragenAn('ben').length, 1, 'Ben sieht die Anfrage nicht');
  assert.equal(sozial.anfragenVon('anna').length, 1);

  assert.equal(sozial.frage('anna', 'ben', T0 + 5), 'gefragt', 'nochmal fragen macht Freunde');
  assert.deepEqual(sozial.freunde('ben'), []);

  assert.equal(sozial.frage('ben', 'anna', T0 + 10), 'freund');
  assert.equal(sozial.istFreund('anna', 'ben'), true);
  assert.equal(sozial.istFreund('ben', 'anna'), true, 'Freundschaft gilt nur in eine Richtung');
  assert.equal(sozial.freunde('anna').length, 1);
  assert.equal(sozial.freunde('ben').length, 1);
  assert.equal(sozial.anfragenAn('ben').length, 0, 'die Anfrage steht noch offen');
});

test('wer sich selbst hinzufügt, bekommt nichts', () => {
  const sozial = new Sozial(db(), mulberry32(11));
  assert.equal(sozial.frage('anna', 'anna', T0), 'nein');
  assert.deepEqual(sozial.freunde('anna'), []);
});

test('entfernen löst die Freundschaft auf beiden Seiten', () => {
  const sozial = new Sozial(db(), mulberry32(11));
  sozial.frage('anna', 'ben', T0);
  sozial.frage('ben', 'anna', T0 + 1);
  assert.equal(sozial.istFreund('anna', 'ben'), true);

  sozial.vergiss('anna', 'ben');
  assert.equal(sozial.istFreund('anna', 'ben'), false);
  assert.equal(sozial.istFreund('ben', 'anna'), false, 'einer bleibt mit einem Geist befreundet');
  assert.equal(sozial.beziehung('ben', 'anna'), 'keine');
});

test('dreimal am Tag je Hof — und morgen wieder', () => {
  const sozial = new Sozial(db(), mulberry32(5));
  const grenze = RULES.helpPerFarmPerDay!;

  for (let i = 1; i <= grenze; i++) {
    assert.ok(sozial.hilfenHeute('anna', 'ben', T0) < grenze);
    assert.equal(sozial.zaehleHilfe('anna', 'ben', T0), i);
  }
  assert.equal(sozial.hilfenHeute('anna', 'ben', T0), grenze);

  const morgen = T0 + 86_400_000;
  assert.equal(tagVon(morgen), tagVon(T0) + 1);
  assert.equal(sozial.hilfenHeute('anna', 'ben', morgen), 0, 'der Zähler läuft nie zurück');

  assert.equal(sozial.hilfenHeute('anna', 'cem', T0), 0, 'die Grenze gilt über alle Höfe zusammen');
});

test('alte Hilfszähler werden weggeräumt', () => {
  const sozial = new Sozial(db(), mulberry32(5));
  sozial.zaehleHilfe('anna', 'ben', T0);
  assert.equal(sozial.raeumeAuf(T0), 0, 'heute wurde weggeräumt');
  assert.ok(sozial.raeumeAuf(T0 + 5 * 86_400_000) > 0);
  assert.equal(sozial.hilfenHeute('anna', 'ben', T0), 0);
});

function hofMitFeld() {
  const server = new Server(initialState(RULES), T0, LATEST_RULESET_VERSION);
  const client = new Client(server.snapshot);
  const rezept = RULES.plots[0]!.levels[0]!.recipes[0]!;
  assert.equal(client.start(0, rezept).ok, true);
  const res = server.sync(client.buildSyncRequest(), T0);
  assert.equal(res.ok, true);
  return { server, rezept };
}

test('Helfen kürzt genau einen laufenden Platz', () => {
  const { server, rezept } = hofMitFeld();
  const vorher = server.snapshot.state.plots[0]!.slots[0]!.startedAt;

  const getan = server.helfen(0, 0);
  assert.equal(getan.ok, true);
  if (!getan.ok) return;
  assert.equal(getan.ticks, helpSpeedup(RULES, rezept));
  assert.equal(server.snapshot.state.plots[0]!.slots[0]!.startedAt, vorher - getan.ticks);

  assert.equal(server.helfen(0, 1).ok, false, 'ein leerer Platz nimmt Hilfe an');
  assert.equal(server.helfen(99, 0).ok, false, 'ein Platz, den es nicht gibt, nimmt Hilfe an');
});

test('was schon fertig ist, braucht keine Hilfe mehr', () => {
  const { server, rezept } = hofMitFeld();
  const dauer = RULES.recipes[rezept]!.durationTicks;

  for (let i = 0; i < 40; i++) {
    const getan = server.helfen(0, 0);
    if (!getan.ok) break;
  }
  const slot = server.snapshot.state.plots[0]!.slots[0]!;
  assert.ok(server.snapshot.state.tick - slot.startedAt >= dauer, 'der Platz wurde nie fertig');
  assert.equal(server.helfen(0, 0).ok, false, 'ein fertiger Platz lässt sich weiter beschleunigen');
});

test('XP für den Helfer kommt an, ohne seinen Log zu verbiegen', () => {
  const server = new Server(initialState(RULES), T0, LATEST_RULESET_VERSION);
  const vorher = server.snapshot.state.xp;

  server.grantXp(RULES.helpXp!);
  server.receiveExternal();

  assert.equal(server.snapshot.state.xp, vorher + RULES.helpXp!);
  assert.equal(server.snapshot.seq, 0, 'die Belohnung hat einen Command erfunden');

  server.receiveExternal();
  assert.equal(server.snapshot.state.xp, vorher + RULES.helpXp!, 'die XP kam doppelt an');
});

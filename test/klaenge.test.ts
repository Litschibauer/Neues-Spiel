import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildKlaenge } from '../scripts/build-conformance.ts';

// Die Klänge sind Dateien, keine Formeln. Was das Spiel aufruft, muss als
// Aufnahme da sein — und die Aufnahmen müssen klein und gleichförmig bleiben,
// weil sie als Data-URI in die Seite wandern.

const ROOT = join(import.meta.dirname, '..');
const KLAENGE = join(ROOT, 'web', 'farm', 'klaenge');

function wavKopf(buf: Buffer) {
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
  // Das fmt-Chunk suchen (libsndfile schreibt es direkt nach RIFF/WAVE).
  let at = 12;
  let fmt: { kanaele: number; rate: number; bits: number } | null = null;
  let daten = 0;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const groesse = buf.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      fmt = { kanaele: buf.readUInt16LE(at + 10), rate: buf.readUInt32LE(at + 12), bits: buf.readUInt16LE(at + 22) };
    }
    if (id === 'data') daten = groesse;
    at += 8 + groesse + (groesse % 2);
  }
  assert.ok(fmt, 'kein fmt-Chunk');
  return { ...fmt!, sekunden: daten / (fmt!.rate * fmt!.kanaele * (fmt!.bits / 8)) };
}

function aufgerufeneKlaenge(): Set<string> {
  const namen = new Set<string>();
  const dir = join(ROOT, 'web', 'farm');
  for (const datei of readdirSync(dir)) {
    if (!datei.endsWith('.js') || datei === 'klang.js') continue;
    const quelle = readFileSync(join(dir, datei), 'utf8');
    for (const m of quelle.matchAll(/klang\('([a-z]+)'\)/g)) namen.add(m[1]!);
    for (const m of quelle.matchAll(/klang: '([a-z]+)'/g)) namen.add(m[1]!);
    // act(…, 'ton') am Ende eines Aufrufs: der letzte String-Parameter.
    for (const m of quelle.matchAll(/act\([^;]*?'([a-z]+)'\);/g)) namen.add(m[1]!);
  }
  namen.add('ernte'); // ernteKlang spielt sie mit verschobener Tonhöhe
  return namen;
}

test('jeder Klang, den das Spiel aufruft, liegt als Aufnahme vor', () => {
  const dateien = new Set(readdirSync(KLAENGE).filter((d) => d.endsWith('.wav')).map((d) => d.slice(0, -4)));
  const fehlt = [...aufgerufeneKlaenge()].filter((n) => !dateien.has(n));
  assert.deepEqual(fehlt, [], 'ohne Aufnahme');
  assert.ok(dateien.has('tipp'), 'der Ersatzklang für Unbekanntes');
});

test('die Aufnahmen sind mono, 22 kHz, 16 Bit, kurz und klein — und in der Lizenzliste', () => {
  const lizenz = readFileSync(join(KLAENGE, 'LIZENZ.txt'), 'utf8');
  let gesamt = 0;
  for (const datei of readdirSync(KLAENGE)) {
    if (!datei.endsWith('.wav')) continue;
    const buf = readFileSync(join(KLAENGE, datei));
    const k = wavKopf(buf);
    assert.equal(k.kanaele, 1, `${datei}: mono`);
    assert.equal(k.rate, 22050, `${datei}: 22050 Hz`);
    assert.equal(k.bits, 16, `${datei}: 16 Bit`);
    assert.ok(k.sekunden > 0.005 && k.sekunden <= 1.2, `${datei}: ${k.sekunden.toFixed(2)} s`);
    assert.ok(buf.length <= 60 * 1024, `${datei}: ${buf.length} Bytes`);
    assert.ok(new RegExp(`^\\s*${datei.slice(0, -4)}\\s`, 'm').test(lizenz), `${datei}: steht nicht in LIZENZ.txt`);
    gesamt += buf.length;
  }
  assert.ok(gesamt <= 400 * 1024, `alle zusammen ${gesamt} Bytes`);
});

test('beim Bauen wandern die Klänge als Data-URIs in die Seite', () => {
  const js = buildKlaenge();
  assert.ok(js.startsWith('var KLAENGE_DATEN = {'));
  for (const name of ['tipp', 'ernte', 'muenzen', 'stufe', 'fehler']) {
    assert.ok(js.includes(`"${name}": 'data:audio/wav;base64,`), name);
  }
});

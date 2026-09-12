import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Die Hintergrundmusik ist frei (CC0) und einheitlich: Jeder Track hat einen
// Anzeigenamen, steht mit Autor und Quelle in der Lizenzliste, ist ein echtes
// MP3 und bleibt klein genug fürs Mobilfunknetz.

const ROOT = join(import.meta.dirname, '..');
const MUSIK = join(ROOT, 'web', 'musik');

function mp3Kopf(buf: Buffer): boolean {
  // ID3v2-Kopf überspringen, dann ein MPEG-Frame-Sync (0xFFE…) erwarten.
  let at = 0;
  if (buf.toString('ascii', 0, 3) === 'ID3') {
    const groesse = ((buf[6]! & 0x7f) << 21) | ((buf[7]! & 0x7f) << 14) | ((buf[8]! & 0x7f) << 7) | (buf[9]! & 0x7f);
    at = 10 + groesse;
  }
  for (let i = at; i < Math.min(buf.length - 1, at + 4096); i++) {
    if (buf[i] === 0xff && (buf[i + 1]! & 0xe0) === 0xe0) return true;
  }
  return false;
}

test('jeder Track ist ein MP3, hat einen Namen und steht in der Lizenzliste', () => {
  const lizenz = readFileSync(join(MUSIK, 'LIZENZ.txt'), 'utf8');
  const namen = readFileSync(join(ROOT, 'web', 'farm', 'musik-namen.js'), 'utf8');
  const tracks = readdirSync(MUSIK).filter((d) => d.endsWith('.mp3')).sort();
  assert.ok(tracks.length >= 8, `nur ${tracks.length} Tracks`);
  let gesamt = 0;
  for (const t of tracks) {
    const buf = readFileSync(join(MUSIK, t));
    assert.ok(mp3Kopf(buf), `${t}: kein MPEG-Rahmen gefunden`);
    assert.ok(buf.length <= 6 * 1024 * 1024, `${t}: ${(buf.length / 1048576).toFixed(1)} MB`);
    assert.ok(namen.includes(`"${t}":`), `${t}: kein Anzeigename in musik-namen.js`);
    assert.ok(new RegExp(`^${t.replace('.', '\\.')}\\s+„.+“ von .+ — https://`, 'm').test(lizenz), `${t}: nicht in LIZENZ.txt mit Autor und Quelle`);
    assert.ok(!/stardew/i.test(t), `${t}: kein freies Stück`);
    gesamt += statSync(join(MUSIK, t)).size;
  }
  assert.ok(gesamt <= 60 * 1024 * 1024, `alle zusammen ${(gesamt / 1048576).toFixed(0)} MB`);
  assert.ok(/CC0/.test(lizenz), 'die Lizenzliste nennt CC0');
});

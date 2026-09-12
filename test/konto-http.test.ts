import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Der Weg zurück in den Hof, das Löschen, die Briefkästen und die Bremsen —
// gegen den echten HTTP-Server, so wie ein Gerät ihn sieht. Läuft ohne
// Browser: Der Server wird als Kindprozess gestartet und wieder beendet.

const PORT = 8781 + Math.floor(Math.random() * 100);
const TOKEN = 'test-admin-token-0123456789';
const ROOT = join(import.meta.dirname, '..');
const B = `http://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function j(path: string, init: RequestInit = {}) {
  const r = await fetch(B + path, init);
  let body: any = null;
  try { body = await r.json(); } catch { /* kein JSON */ }
  return { status: r.status, body, retry: r.headers.get('retry-after') };
}
const auth = (key: string) => ({ authorization: 'Bearer ' + key, 'content-type': 'application/json' });
const JSON_KOPF = { 'content-type': 'application/json' };
function zaehleHoefe(dbPfad: string): number {
  const db = new DatabaseSync(dbPfad, { readOnly: true });
  try { return Number((db.prepare('select count(*) as n from accounts').get() as { n: number }).n); } finally { db.close(); }
}

test('Konto über HTTP: Wort, Wiederherstellung, Bremsen, Briefkästen, Löschen', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-konto-http-'));
  const server = spawn('node', ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', 'src/server/http.ts', '--env=dev'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NEUES_SPIEL_HOST: '127.0.0.1', NEUES_SPIEL_TOKEN: TOKEN, NEUES_SPIEL_SAVE: join(dir, 'save.json'), NEUES_SPIEL_TOKEN_FILE: join(dir, 'token') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  t.after(() => { server.kill(); rmSync(dir, { recursive: true, force: true }); });
  let bereit = false;
  for (let i = 0; i < 100 && !bereit; i++) { try { bereit = (await fetch(B + '/health')).ok; } catch { /* noch nicht */ } if (!bereit) await wait(200); }
  assert.ok(bereit, 'Server kam nicht hoch:\n' + log.slice(-2000));
  const ok = (name: string, cond: boolean, detail?: unknown) => assert.ok(cond, name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : ''));
  const health = await j('/health');
  ok('health nennt den Stand', /^[0-9a-f]{7}$/.test(health.body.version), health.body.version);
  const recht = await fetch(B + '/impressum'); const rechtText = await recht.text();
  ok('/impressum liefert die Seite mit Platzhaltern', recht.status === 200 && /Impressum/.test(rechtText) && /platzhalter/.test(rechtText));
  ok('/datenschutz ebenso', (await fetch(B + '/datenschutz')).status === 200);

  const a = await j('/api/account', { method: 'POST' });
  const key = a.body.key as string; const id = a.body.accountId as string;
  const hof = await j('/api/hof', { headers: auth(key) }); const code = hof.body.code as string;
  ok('Hof angelegt, Code da', a.status === 201 && /^[A-Z0-9]{6}$/.test(code), code);

  const w0 = await j('/api/wiederherstellung', { headers: auth(key) });
  ok('noch kein Wort', w0.body.gesetzt === false, w0.body);
  const wKurz = await j('/api/wiederherstellung', { method: 'POST', headers: auth(key), body: JSON.stringify({ wort: 'kurz' }) });
  ok('zu kurzes Wort abgelehnt', wKurz.status === 400, wKurz.body);
  const w1 = await j('/api/wiederherstellung', { method: 'POST', headers: auth(key), body: JSON.stringify({ wort: 'Apfelbaum am Hof' }) });
  ok('Wort gesetzt', w1.status === 200 && w1.body.gesetzt === true);
  const falsch = await j('/api/wiederherstellen', { method: 'POST', headers: JSON_KOPF, body: JSON.stringify({ code, wort: 'falsches Wort' }) });
  ok('falsches Wort → 401', falsch.status === 401 && falsch.body.error === 'WRONG_WORD');
  const alt = await j('/api/state?deviceId=d1', { headers: auth(key) });
  ok('alter Schlüssel gilt nach Fehlversuch noch', alt.status === 200);
  const wieder = await j('/api/wiederherstellen', { method: 'POST', headers: JSON_KOPF, body: JSON.stringify({ code: code.toLowerCase(), wort: 'Apfelbaum am Hof' }) });
  const key2 = wieder.body.key as string;
  ok('richtiges Wort → neuer Schlüssel + Spielstand', wieder.status === 200 && typeof key2 === 'string' && key2 !== key && wieder.body.accountId === id && !!wieder.body.snapshot);
  ok('alter Schlüssel ist tot', (await j('/api/state?deviceId=d1', { headers: auth(key) })).status === 401);
  ok('neuer Schlüssel öffnet den Hof', (await j('/api/state?deviceId=d2', { headers: auth(key2) })).status === 200);

  // Bremse Wiederherstellung: 5 Fehlversuche je Hofcode
  let letzte = 0;
  for (let i = 0; i < 6; i++) letzte = (await j('/api/wiederherstellen', { method: 'POST', headers: JSON_KOPF, body: JSON.stringify({ code, wort: 'immer falsch!' }) })).status;
  ok('nach fünf Fehlversuchen bremst der Hofcode (429)', letzte === 429, letzte);

  // Rueckmeldung
  const r1 = await j('/api/rueckmeldung', { method: 'POST', headers: auth(key2), body: JSON.stringify({ art: 'idee', text: 'Mehr Kühe bitte', version: 'abc1234', huelle: 'h', regelwerk: 1001, geraet: 'Test' }) });
  ok('Rückmeldung angenommen', r1.status === 200 && r1.body.id > 0, r1.body);
  ok('Unsinn abgelehnt', (await j('/api/rueckmeldung', { method: 'POST', headers: auth(key2), body: JSON.stringify({ art: 'quatsch', text: 'x' }) })).status === 400);
  // Fehler
  const f1 = await j('/api/fehler', { method: 'POST', headers: JSON_KOPF, body: JSON.stringify({ meldungen: [{ text: 'TypeError: x is not a function', ort: '/:12:3', stapel: 'at y' }, { text: 'TypeError: x is not a function', ort: '/:12:3' }], version: 'abc1234', geraet: 'iOS · Browser' }) });
  ok('Fehlerbericht ohne Schlüssel angenommen', f1.status === 200 && f1.body.angenommen === 2, f1.body);
  const f2 = await j('/api/fehler', { method: 'POST', headers: auth(key2), body: JSON.stringify({ meldungen: [{ text: 'TypeError: x is not a function', ort: '/:12:3' }] }) });
  ok('mit Schlüssel auch', f2.status === 200);
  const adminH = { authorization: 'Bearer ' + TOKEN };
  const post = await j('/api/admin/rueckmeldungen', { headers: adminH });
  ok('Werkbank sieht die Rückmeldung mit Hofcode', post.body.rueckmeldungen.length === 1 && post.body.rueckmeldungen[0].code === code && post.body.rueckmeldungen[0].text === 'Mehr Kühe bitte', post.body.rueckmeldungen[0]);
  const fl = await j('/api/admin/fehler', { headers: adminH });
  ok('Werkbank sieht EINEN Fehler, dreimal gezählt, mit Konto nachgetragen', fl.body.fehler.length === 1 && fl.body.fehler[0].anzahl === 3 && fl.body.fehler[0].konto === id, fl.body.fehler[0]);
  const erl = await j('/api/admin/rueckmeldungen?id=' + post.body.rueckmeldungen[0].id + '&erledigt=1', { method: 'POST', headers: adminH });
  ok('erledigt markieren', erl.body.ok === true && (await j('/api/admin/rueckmeldungen', { headers: adminH })).body.rueckmeldungen.length === 0);
  const konten = await j('/api/admin/accounts', { headers: adminH });
  ok('Hofliste zeigt das Wort-Flag', konten.body.accounts[0].wort === true);

  // Sync-Bremse: 240/min
  let bremse = 0, zuletzt: any = null;
  for (let i = 0; i < 245; i++) { zuletzt = await j('/api/sync', { method: 'POST', headers: auth(key2), body: JSON.stringify({ deviceId: 'd2', commands: [] }) }); if (zuletzt.status === 429) { bremse = i; break; } }
  ok('der 241. Abgleich in der Minute wird gebremst (429, retry-after)', zuletzt.status === 429 && zuletzt.body.error === 'TOO_FAST' && bremse === 240 && !!zuletzt.retry, { bremse, retry: zuletzt.retry });

  // Löschen
  ok('Löschen mit falschem Code scheitert', (await j('/api/konto', { method: 'DELETE', headers: auth(key2), body: JSON.stringify({ code: 'XXXXXX' }) })).status === 400);
  const weg = await j('/api/konto', { method: 'DELETE', headers: auth(key2), body: JSON.stringify({ code }) });
  ok('Löschen mit Hofcode klappt', weg.status === 200 && weg.body.ok === true);
  ok('danach 401', (await j('/api/state?deviceId=d2', { headers: auth(key2) })).status === 401);
  ok('Hof aus der Liste', (await j('/api/admin/accounts', { headers: adminH })).body.count === 0);
  ok('Hofcode löst nichts mehr auf', (await j('/api/wiederherstellen', { method: 'POST', headers: JSON_KOPF, body: JSON.stringify({ code: 'ABCDEF', wort: 'Apfelbaum am Hof' }) })).status === 401);

  // Der Wipe: zwei Höfe, falscher Satz, richtiger Satz, Sicherung, leere Welt.
  const h1 = await j('/api/account', { method: 'POST' });
  const h2 = await j('/api/account', { method: 'POST' });
  await j('/api/hof', { headers: auth(h1.body.key) });
  const satzInfo = await j('/api/admin/wipe', { headers: adminH });
  ok('Die Werkbank nennt den Satz mit Umgebung und Hofzahl', satzInfo.body.satz === 'ALLES LÖSCHEN dev 2', satzInfo.body);
  const falschSatz = await j('/api/admin/wipe', { method: 'POST', headers: { ...adminH, ...JSON_KOPF }, body: JSON.stringify({ bestaetigung: 'ALLES LÖSCHEN dev 1' }) });
  ok('Ein falscher Satz löscht nichts', falschSatz.status === 400 && (await j('/api/admin/accounts', { headers: adminH })).body.count === 2);
  ok('Ohne Token geht es gar nicht', (await j('/api/admin/wipe', { method: 'POST', headers: JSON_KOPF, body: JSON.stringify({ bestaetigung: 'ALLES LÖSCHEN dev 2' }) })).status === 401);
  const wipe = await j('/api/admin/wipe', { method: 'POST', headers: { ...adminH, ...JSON_KOPF }, body: JSON.stringify({ bestaetigung: 'ALLES LÖSCHEN dev 2' }) });
  ok('Der richtige Satz löscht alles und nennt die Sicherung', wipe.status === 200 && wipe.body.geloescht === 2 && /vor-wipe-dev-/.test(wipe.body.sicherung), wipe.body);
  ok('Die Sicherung liegt da und enthält die zwei Höfe', existsSync(wipe.body.sicherung) && zaehleHoefe(wipe.body.sicherung) === 2);
  ok('Danach: keine Höfe, alte Schlüssel tot', (await j('/api/admin/accounts', { headers: adminH })).body.count === 0 && (await j('/api/state?deviceId=x', { headers: auth(h2.body.key) })).status === 401);
  const frisch = await j('/api/account', { method: 'POST' });
  ok('Ein neuer Hof geht wieder — das Universum lebt', frisch.status === 201);
  ok('Der Satz zählt jetzt einen Hof', (await j('/api/admin/wipe', { headers: adminH })).body.satz === 'ALLES LÖSCHEN dev 1');
});

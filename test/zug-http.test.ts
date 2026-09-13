import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Der Zug gegen den echten Server: erst muss das Dorf alles gebaut haben
// (Dankeswoche auf eine Millisekunde gestellt), dann steht der Zug im
// Bahnhof — Bestellung, abgelehnte und angenommene Beiträge, Abfahrt, Dank.

const PORT = 9081 + Math.floor(Math.random() * 100);
const TOKEN = 'test-admin-token-0123456789';
const ROOT = join(import.meta.dirname, '..');
const B = `http://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function j(path: string, init: RequestInit = {}) {
  const r = await fetch(B + path, init);
  let body: any = null;
  try { body = await r.json(); } catch { /* kein JSON */ }
  return { status: r.status, body };
}
const auth = (key: string) => ({ authorization: 'Bearer ' + key, 'content-type': 'application/json' });
const admin = { authorization: 'Bearer ' + TOKEN };

test('Zug über HTTP: erst Bahnhof bauen, dann Bestellung, Beiträge, Abfahrt, Dank', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-zug-http-'));
  const server = spawn('node', ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', 'src/server/http.ts', '--env=dev'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NEUES_SPIEL_HOST: '127.0.0.1', NEUES_SPIEL_TOKEN: TOKEN, NEUES_SPIEL_SAVE: join(dir, 'save.json'), NEUES_SPIEL_TOKEN_FILE: join(dir, 'token'), NEUES_SPIEL_DANKESWOCHE_MS: '1' },
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

  const a = await j('/api/account', { method: 'POST' });
  const key = a.body.key as string; const id = a.body.accountId as string;
  const b = await j('/api/account', { method: 'POST' });
  const key2 = b.body.key as string;

  const vorher = await j('/api/dorf', { headers: auth(key) });
  ok('ohne Bahnhof kein Zug', vorher.body.zug === null && vorher.body.alleGebaut === false, { zug: vorher.body.zug, alle: vorher.body.alleGebaut });
  ok('Beitrag zum Zug ohne Zug: abgelehnt', (await j('/api/zug/beitrag?item=bread&amount=1', { method: 'POST', headers: auth(key) })).status === 409);

  // Drei Projekte à drei Etappen aus der Werkbank füllen — die Dankeswoche ist eine Millisekunde.
  let fertigZaehler = 0;
  for (let i = 0; i < 12 && fertigZaehler < 3; i++) {
    const f = await j(`/api/admin/dorf/fuellen?account=${id}`, { method: 'POST', headers: admin });
    if (f.status !== 200) break;
    if (f.body.projektFertig) fertigZaehler++;
    await wait(5);
  }
  ok('drei Projekte gebaut', fertigZaehler === 3, fertigZaehler);
  const danach = await j('/api/dorf', { headers: auth(key) });
  ok('der Bahnhof bleibt stehen, alles gebaut', danach.body.projekt.id === 'bahnhof' && danach.body.fertig === true && danach.body.alleGebaut === true, { projekt: danach.body.projekt.id, fertig: danach.body.fertig, alle: danach.body.alleGebaut });
  ok('kein Füllen mehr am Dorf', (await j('/api/admin/dorf/fuellen', { method: 'POST', headers: admin })).status === 409);

  const zug = danach.body.zug;
  ok('jetzt steht ein Zug mit vier Waren im Bahnhof', zug && zug.bestellung.length === 4 && zug.fertig === false && zug.abfahrtMs > Date.now() && zug.helfer.length === 0, zug);
  const erste = zug.bestellung[0].item as string;
  ok('Weizen will der Zug nicht', (await j('/api/zug/beitrag?item=wheat&amount=1', { method: 'POST', headers: auth(key) })).body.error === 'NOT_NEEDED');
  ok('ohne Ware im Lager: abgelehnt', (await j(`/api/zug/beitrag?item=${erste}&amount=1`, { method: 'POST', headers: auth(key) })).body.error === 'NOT_ENOUGH_ITEMS');
  ok('Gold geht nicht', (await j('/api/zug/beitrag?item=gold&amount=1', { method: 'POST', headers: auth(key) })).status === 400);

  const mailVor = ((await j(`/api/admin/status?account=${id}`, { headers: admin })).body.state.mail as unknown[]).length;
  const f = await j(`/api/admin/zug/fuellen?account=${id}`, { method: 'POST', headers: admin });
  ok('Werkbank lädt den Zug voll — er fährt', f.status === 200 && f.body.fertig === true && f.body.stand.zug.fertig === true, f.body);
  const nachher = await j('/api/dorf', { headers: auth(key) });
  ok('Hof a steht als Helfer, „du" markiert', nachher.body.zug.fertig && nachher.body.zug.helfer.length === 1 && nachher.body.zug.helfer[0].du === true && nachher.body.zug.mein > 0, nachher.body.zug.helfer);
  ok('nichts mehr annehmen', (await j(`/api/admin/zug/fuellen`, { method: 'POST', headers: admin })).status === 409);
  const mailA = (await j(`/api/admin/status?account=${id}`, { headers: admin })).body.state.mail as Array<{ item: number; amount: number }>;
  ok('der Helfer hat drei Stücke Dank mehr in der Post, darunter 300 Gold', mailA.length === mailVor + 3 && mailA.some((m) => m.amount === 300), { vor: mailVor, nach: mailA.length });
  const mailB = (await j(`/api/admin/status?account=${b.body.accountId}`, { headers: admin })).body.state.mail as unknown[];
  ok('wer nichts eingeladen hat, bekommt nichts', mailB.length === 0, mailB.length);

  // Löschen nimmt den Hof vom Zug.
  const hof = await j('/api/hof', { headers: auth(key) });
  ok('Hof gelöscht', (await j('/api/konto', { method: 'DELETE', headers: auth(key), body: JSON.stringify({ code: hof.body.code }) })).status === 200);
  const s3 = await j('/api/dorf', { headers: auth(key2) });
  ok('der gelöschte Hof steht nicht mehr auf der Helferliste des Zugs', s3.body.zug.helfer.length === 0, s3.body.zug.helfer);
});

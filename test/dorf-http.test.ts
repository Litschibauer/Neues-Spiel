import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Das Dorfprojekt gegen den echten Server: Stand, abgelehnte Beiträge,
// gefüllte Etappen aus der Werkbank, der Dank als Post, die Dankeswoche
// im Tagesbonus und das Vergessen beim Löschen.

const PORT = 8981 + Math.floor(Math.random() * 100);
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

test('Dorfprojekt über HTTP: Stand, Beitrag, Etappen, Dank, Dankeswoche', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-dorf-http-'));
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

  const a = await j('/api/account', { method: 'POST' });
  const key = a.body.key as string; const id = a.body.accountId as string;
  const b = await j('/api/account', { method: 'POST' });
  const key2 = b.body.key as string;
  ok('zwei Höfe angelegt', a.status === 201 && b.status === 201);

  const s0 = await j('/api/dorf', { headers: auth(key) });
  ok('der Stand nennt Projekt, Etappen mit Bedarf, Faktor 1 bei zwei Höfen', s0.status === 200 && s0.body.projekt.id === 'brunnen' && s0.body.faktor === 1 && s0.body.etappen.length === 3 && s0.body.etappen[0].bedarf[0].item === 'plank' && s0.body.fertig === false, s0.body);
  ok('ohne Schlüssel kein Stand', (await j('/api/dorf')).status === 401);

  // Beiträge: was nicht gebraucht wird, was man nicht hat.
  ok('Weizen will die Baustelle nicht', (await j('/api/dorf/beitrag?item=wheat&amount=1', { method: 'POST', headers: auth(key) })).body.error === 'NOT_NEEDED');
  ok('Gold geht nicht', (await j('/api/dorf/beitrag?item=gold&amount=1', { method: 'POST', headers: auth(key) })).status === 400);
  ok('ohne Bretter im Lager: abgelehnt, nichts gebucht', (await j('/api/dorf/beitrag?item=plank&amount=2', { method: 'POST', headers: auth(key) })).body.error === 'NOT_ENOUGH_ITEMS');
  ok('Unsinnige Menge abgelehnt', (await j('/api/dorf/beitrag?item=plank&amount=0', { method: 'POST', headers: auth(key) })).status === 400);
  const s1 = await j('/api/dorf', { headers: auth(key) });
  ok('nach abgelehnten Beiträgen ist nichts geliefert', s1.body.etappen[0].bedarf.every((x: { geliefert: number }) => x.geliefert === 0) && s1.body.helfer.length === 0, s1.body.etappen[0]);

  // Werkbank füllt Etappe für Etappe, gutgeschrieben Hof a.
  const f1 = await j(`/api/admin/dorf/fuellen?account=${id}`, { method: 'POST', headers: admin });
  ok('Etappe 1 gefüllt, Projekt läuft weiter', f1.status === 200 && f1.body.projektFertig === false && f1.body.stand.etappe === 1, f1.body);
  const s2 = await j('/api/dorf', { headers: auth(key) });
  ok('Hof a steht als Helfer mit Namen, „du" markiert, Etappe 1 fertig', s2.body.helfer.length === 1 && s2.body.helfer[0].du === true && typeof s2.body.helfer[0].name === 'string' && s2.body.etappen[0].fertig === true && s2.body.mein > 0, s2.body.helfer);
  const bonusVorher = await j('/api/tagesbonus', { headers: auth(key2) });
  ok('vor dem Bau: keine Dankeswoche', bonusVorher.body.dorfwoche === false, bonusVorher.body);

  const f2 = await j(`/api/admin/dorf/fuellen?account=${id}`, { method: 'POST', headers: admin });
  const f3 = await j(`/api/admin/dorf/fuellen?account=${id}`, { method: 'POST', headers: admin });
  ok('nach drei Etappen steht das Bauwerk', f2.body.projektFertig === false && f3.body.projektFertig === true && f3.body.stand.fertig === true && f3.body.stand.dankeswoche === true, { f2: f2.body.stand?.etappe, f3: f3.body });
  ok('fertig heißt: nichts mehr annehmen', (await j(`/api/admin/dorf/fuellen`, { method: 'POST', headers: admin })).status === 409);

  // Dank als Post beim Helfer, nicht beim Zuschauer.
  const statA = await j(`/api/admin/status?account=${id}`, { headers: admin });
  const postA = (statA.body.state.mail ?? []) as Array<{ item: number; amount: number }>;
  ok('der Helfer hat Post: Karten und Gold', postA.some((m) => m.amount === 400) && postA.some((m) => m.amount === 2), postA);
  const statB = await j(`/api/admin/status?account=${b.body.accountId}`, { headers: admin });
  ok('wer nichts gegeben hat, bekommt keinen Dank', ((statB.body.state.mail ?? []) as unknown[]).length === 0, statB.body.state.mail);

  // Dankeswoche: Tagesbonus doppelt, für alle.
  const bonus = await j('/api/tagesbonus', { method: 'POST', headers: auth(key2) });
  ok('Tagesbonus in der Dankeswoche: doppelt (100 statt 50), auch für Zuschauer', bonus.status === 200 && bonus.body.dorfwoche === true && bonus.body.gold === 100, bonus.body);

  // Hof löschen nimmt ihn von der Helferliste.
  const hof = await j('/api/hof', { headers: auth(key) });
  const weg = await j('/api/konto', { method: 'DELETE', headers: auth(key), body: JSON.stringify({ code: hof.body.code }) });
  ok('Hof gelöscht', weg.status === 200, weg.body);
  const s3 = await j('/api/admin/dorf', { headers: admin });
  ok('der gelöschte Hof steht nicht mehr auf der Helferliste', s3.body.helfer.length === 0, s3.body.helfer);
});

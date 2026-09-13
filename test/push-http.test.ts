import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify as verifyRaw } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Der ganze Weg einer Benachrichtigung gegen den echten Server — mit einem
// nachgebauten Push-Dienst auf dem eigenen Rechner: Abo anlegen, Probe
// schicken, und dann prüfen, was beim Dienst ankam: Ausweis, Kopfzeilen und
// ob das Gerät die Nachricht wieder lesen kann.

const PORT = 8881 + Math.floor(Math.random() * 100);
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

type Eingang = { headers: IncomingMessage['headers']; body: Buffer };

test('Benachrichtigung über HTTP: Abo, Probe, Ausweis, Entschlüsselung, tote Abos', async (t) => {
  // Nachgebauter Push-Dienst: nimmt an, was kommt, und antwortet, wie wir es
  // gerade wollen (201 = angenommen, 410 = Abo tot).
  const eingang: Eingang[] = [];
  let antwort = 201;
  const dienst = createServer((req, res) => {
    const teile: Buffer[] = [];
    req.on('data', (c) => teile.push(c));
    req.on('end', () => {
      eingang.push({ headers: req.headers, body: Buffer.concat(teile) });
      res.writeHead(antwort);
      res.end();
    });
  });
  await new Promise<void>((r) => dienst.listen(0, '127.0.0.1', r));
  const dienstPort = (dienst.address() as { port: number }).port;
  const endpoint = `http://127.0.0.1:${dienstPort}/abo/geraet-1`;

  const dir = mkdtempSync(join(tmpdir(), 'ns-push-http-'));
  const server = spawn('node', ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', 'src/server/http.ts', '--env=dev'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NEUES_SPIEL_HOST: '127.0.0.1', NEUES_SPIEL_TOKEN: TOKEN, NEUES_SPIEL_SAVE: join(dir, 'save.json'), NEUES_SPIEL_TOKEN_FILE: join(dir, 'token'), NEUES_SPIEL_PUSH_KONTAKT: 'https://hof.example.com' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  t.after(() => { server.kill(); dienst.close(); rmSync(dir, { recursive: true, force: true }); });
  let bereit = false;
  for (let i = 0; i < 100 && !bereit; i++) { try { bereit = (await fetch(B + '/health')).ok; } catch { /* noch nicht */ } if (!bereit) await wait(200); }
  assert.ok(bereit, 'Server kam nicht hoch:\n' + log.slice(-2000));
  const ok = (name: string, cond: boolean, detail?: unknown) => assert.ok(cond, name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : ''));

  const a = await j('/api/account', { method: 'POST' });
  const key = a.body.key as string;
  ok('Hof angelegt', a.status === 201);

  // Ohne Abo sagt die Probe das ehrlich.
  const leer = await j('/api/push/probe', { method: 'POST', headers: auth(key) });
  ok('Probe ohne Abo: 0 Geräte und ein Grund', leer.status === 200 && leer.body.geraete === 0 && /nicht angemeldet/.test(leer.body.fehler[0]), leer.body);

  // Das Gerät: ein Schlüsselpaar und ein Geheimnis, wie der Browser sie ausstellt.
  const geraet = createECDH('prime256v1');
  geraet.generateKeys();
  const geheimnis = randomBytes(16);
  const abo = await j('/api/push/abo', { method: 'POST', headers: auth(key), body: JSON.stringify({ endpoint, keys: { p256dh: geraet.getPublicKey().toString('base64url'), auth: geheimnis.toString('base64url') } }) });
  ok('Abo angenommen', abo.status === 200 && abo.body.art === 'web', abo.body);
  ok('Abo mit https-fremdem Ziel abgelehnt', (await j('/api/push/abo', { method: 'POST', headers: auth(key), body: JSON.stringify({ endpoint: 'http://push.example.com/x', keys: { p256dh: 'a', auth: 'b' } }) })).status === 400);

  const probe = await j('/api/push/probe', { method: 'POST', headers: auth(key) });
  ok('Probe: ein Gerät, eine Zustellung', probe.status === 200 && probe.body.geraete === 1 && probe.body.gesendet === 1 && probe.body.entfernt === 0, probe.body);
  ok('der Push-Dienst hat genau eine Nachricht bekommen', eingang.length === 1);
  const post = eingang[0]!;
  ok('Kopfzeilen nach RFC 8291/8292', post.headers['content-encoding'] === 'aes128gcm' && post.headers['content-type'] === 'application/octet-stream' && post.headers['ttl'] === '86400', post.headers);

  // Der Ausweis: JWT, Publikum ist der Dienst, Absender eine gültige Adresse,
  // Signatur mit dem öffentlichen Schlüssel prüfbar, den das Spiel abholt.
  const ausweis = /^vapid t=([^,]+), k=(.+)$/.exec(String(post.headers['authorization']));
  ok('Authorization im VAPID-Format', !!ausweis, post.headers['authorization']);
  const [kopf, rumpf, sig] = ausweis![1]!.split('.');
  const anspruch = JSON.parse(Buffer.from(rumpf!, 'base64url').toString());
  ok('aud ist der Ursprung des Push-Dienstes', anspruch.aud === `http://127.0.0.1:${dienstPort}`, anspruch);
  ok('sub ist der eingestellte Kontakt', anspruch.sub === 'https://hof.example.com', anspruch);
  ok('exp liegt in der Zukunft, höchstens 24 h', anspruch.exp > Date.now() / 1000 && anspruch.exp < Date.now() / 1000 + 86400);
  const oeffentlich = (await j('/api/push/schluessel')).body.key as string;
  ok('k im Ausweis ist derselbe Schlüssel, den das Spiel abholt', ausweis![2] === oeffentlich);
  const spki = Buffer.concat([Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'), Buffer.from(oeffentlich, 'base64url')]);
  const pub = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  ok('Signatur gültig', verifyRaw('sha256', Buffer.from(`${kopf}.${rumpf}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig!, 'base64url')));

  // Das Gerät packt aus, wie der Browser es täte.
  const body = post.body;
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const serverPub = body.subarray(21, 21 + idlen);
  const geheim = body.subarray(21 + idlen);
  const gemeinsam = geraet.computeSecret(serverPub);
  const prk = Buffer.from(hkdfSync('sha256', gemeinsam, geheimnis, Buffer.concat([Buffer.from('WebPush: info\0'), geraet.getPublicKey(), serverPub]), 32));
  const cek = Buffer.from(hkdfSync('sha256', prk, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', prk, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(geheim.subarray(geheim.length - 16));
  const offen = Buffer.concat([decipher.update(geheim.subarray(0, geheim.length - 16)), decipher.final()]);
  const nachricht = JSON.parse(offen.subarray(0, offen.length - 1).toString());
  ok('die Nachricht kommt lesbar an: Titel, Text, Art', nachricht.titel === 'Probe vom Hof' && /Benachrichtigungen/.test(nachricht.text) && nachricht.art === 'probe', nachricht);

  // Werkbank sieht das Gerät.
  const stand = await j('/api/admin/push/stand', { headers: { authorization: 'Bearer ' + TOKEN } });
  ok('Werkbank zählt ein Browser-Gerät', stand.body.abos === 1 && stand.body.web === 1, stand.body);

  // Antwortet der Dienst 410, ist das Abo tot und fliegt raus.
  antwort = 410;
  const tot = await j('/api/push/probe', { method: 'POST', headers: auth(key) });
  ok('410 → nichts zugestellt, Abo entfernt, Grund genannt', tot.body.gesendet === 0 && tot.body.entfernt === 1 && /410/.test(tot.body.fehler[0]), tot.body);
  const danach = await j('/api/push/probe', { method: 'POST', headers: auth(key) });
  ok('danach ist kein Gerät mehr angemeldet', danach.body.geraete === 0, danach.body);

  // Bremse: sechs je Stunde.
  let letzte = 200;
  for (let i = 0; i < 4 && letzte !== 429; i++) letzte = (await j('/api/push/probe', { method: 'POST', headers: auth(key) })).status;
  ok('nach sechs Proben bremst der Server (429)', letzte === 429, letzte);
});

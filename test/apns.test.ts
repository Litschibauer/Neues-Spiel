import test from 'node:test';
import assert from 'node:assert/strict';
import { createSecureServer } from 'node:http2';
import { generateKeyPairSync, verify as verifyRaw } from 'node:crypto';
import { apnsAusUmgebung, apnsNutzlast, apnsToken, apnsTokenVergessen, sendeApns } from '../src/server/apns.ts';
import type { ApnsConfig } from '../src/server/apns.ts';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const cfg: ApnsConfig = {
  keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  keyId: 'ABC1234567',
  teamId: 'TEAM123456',
  bundleId: 'com.litschibauer.neuesspiel',
  sandbox: true,
};

test('ohne vollständige Angaben bleibt APNs aus', () => {
  assert.equal(apnsAusUmgebung({}), null, 'gar nichts gesetzt');
  assert.equal(
    apnsAusUmgebung({ NEUES_SPIEL_APNS_KEY_ID: 'X', NEUES_SPIEL_APNS_TEAM_ID: 'Y' }),
    null,
    'halb gesetzt reicht nicht',
  );
});

test('das APNs-Token ist ein ES256-JWT mit Key-ID und Team-ID', () => {
  apnsTokenVergessen();
  const jwt = apnsToken(cfg, 1_700_000_000_000);
  const [kopf, rumpf, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(kopf!, 'base64url').toString()), {
    alg: 'ES256',
    kid: 'ABC1234567',
  });
  assert.deepEqual(JSON.parse(Buffer.from(rumpf!, 'base64url').toString()), {
    iss: 'TEAM123456',
    iat: 1_700_000_000,
  });
  assert.ok(
    verifyRaw('sha256', Buffer.from(`${kopf}.${rumpf}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(sig!, 'base64url')),
    'Apple kann die Signatur prüfen',
  );
});

test('dasselbe Token wird wiederverwendet — Apple mag kein Dauersignieren', () => {
  apnsTokenVergessen();
  const a = apnsToken(cfg, 1_700_000_000_000);
  const b = apnsToken(cfg, 1_700_000_000_000 + 60_000);
  assert.equal(a, b, 'innerhalb einer Stunde dasselbe');
  const c = apnsToken(cfg, 1_700_000_000_000 + 60 * 60_000);
  assert.notEqual(a, c, 'danach ein frisches');
});

test('die Nutzlast sieht aus, wie iOS sie erwartet', () => {
  const p = apnsNutzlast('Dein Hof', 'Zwei Reusen sind voll', 'fertig') as {
    aps: { alert: { title: string; body: string }; sound: string };
  };
  assert.equal(p.aps.alert.title, 'Dein Hof');
  assert.equal(p.aps.alert.body, 'Zwei Reusen sind voll');
  assert.equal(p.aps.sound, 'default');
});

// Gegenprobe gegen einen echten HTTP/2-Server: Kopfzeilen und Rumpf müssen
// stimmen, sonst weist Apple die Zustellung ab.
test('die Zustellung trägt Pfad, Topic und Token so, wie Apple es verlangt', async () => {
  const zert = await macheZertifikat();
  const empfangen: Array<{ pfad: string; topic: string; auth: string; body: string }> = [];
  const server = createSecureServer({ key: zert.key, cert: zert.cert });
  server.on('stream', (stream, headers) => {
    const teile: Buffer[] = [];
    stream.on('data', (c) => teile.push(c));
    stream.on('end', () => {
      empfangen.push({
        pfad: String(headers[':path']),
        topic: String(headers['apns-topic']),
        auth: String(headers.authorization),
        body: Buffer.concat(teile).toString(),
      });
      stream.respond({ ':status': 200 });
      stream.end('');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;

  const vorher = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    const r = await sendeApns(cfg, 'a1b2c3d4e5f60718', 'Titel', 'Text', 'admin', `https://127.0.0.1:${port}`);
    assert.equal(r.ok, true, `Zustellung ok (Status ${r.status})`);
  } finally {
    if (vorher === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = vorher;
    server.close();
  }

  const z = empfangen[0]!;
  assert.equal(z.pfad, '/3/device/a1b2c3d4e5f60718');
  assert.equal(z.topic, 'com.litschibauer.neuesspiel');
  assert.ok(z.auth.startsWith('bearer '), 'Bearer-Token dabei');
  assert.equal(JSON.parse(z.body).aps.alert.title, 'Titel');
});

// Ein Wegwerf-Zertifikat, damit der Test einen echten TLS-HTTP/2-Server hat.
async function macheZertifikat(): Promise<{ key: string; cert: string }> {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'apns-cert-'));
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=127.0.0.1',
      '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'),
    ], { stdio: 'ignore' });
    return {
      key: readFileSync(join(dir, 'k.pem'), 'utf8'),
      cert: readFileSync(join(dir, 'c.pem'), 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

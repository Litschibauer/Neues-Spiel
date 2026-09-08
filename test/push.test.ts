import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  hkdfSync,
  randomBytes,
  verify as verifyRaw,
} from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ladeVapid, pruefeVapid, verschluessele, vapidToken, type PushSub } from '../src/server/push.ts';

const pfad = join(tmpdir(), `vapid-test-${process.pid}.json`);
const keys = ladeVapid(pfad, 'mailto:hof@example.com');

test('der VAPID-Schlüssel ist ein gültiger P-256-Punkt und bleibt stabil', () => {
  assert.ok(pruefeVapid(keys), 'Schlüsselpaar gültig');
  const nochmal = ladeVapid(pfad, 'mailto:hof@example.com');
  assert.equal(nochmal.publicKey, keys.publicKey, 'derselbe Schlüssel nach Neustart');
  const punkt = Buffer.from(keys.publicKey, 'base64url');
  assert.equal(punkt.length, 65);
  assert.equal(punkt[0], 4, 'unkomprimierter Punkt');
});

test('das VAPID-Token ist ein ES256-JWT, das mit dem Schlüssel prüfbar ist', () => {
  const jwt = vapidToken(keys, 'https://push.example.com', 1_700_000_000_000);
  const [kopf, rumpf, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(kopf!, 'base64url').toString()), {
    typ: 'JWT',
    alg: 'ES256',
  });
  const daten = JSON.parse(Buffer.from(rumpf!, 'base64url').toString());
  assert.equal(daten.aud, 'https://push.example.com');
  assert.equal(daten.sub, 'mailto:hof@example.com');
  assert.ok(daten.exp > 1_700_000_000, 'läuft in der Zukunft ab');

  // Die Signatur muss mit dem öffentlichen Punkt prüfbar sein — sonst weist
  // der Push-Dienst uns ab.
  const spki = Buffer.concat([
    Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'),
    Buffer.from(keys.publicKey, 'base64url'),
  ]);
  const pub = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  assert.ok(
    verifyRaw('sha256', Buffer.from(`${kopf}.${rumpf}`), { key: pub, dsaEncoding: 'ieee-p1363' },
      Buffer.from(sig!, 'base64url')),
    'Signatur gültig',
  );
});

// Der Gegenbeweis: Wir spielen den Browser und entschlüsseln, was der Server
// verschlüsselt hat. Genau dieser Weg läuft auf dem echten Gerät.
test('eine verschlüsselte Nachricht lässt sich mit dem Geräteschlüssel wieder lesen', () => {
  const geraet = createECDH('prime256v1');
  geraet.generateKeys();
  const auth = randomBytes(16);
  const sub: PushSub = {
    endpoint: 'https://push.example.com/abc',
    p256dh: geraet.getPublicKey().toString('base64url'),
    auth: auth.toString('base64url'),
  };

  const klartext = JSON.stringify({ titel: 'Dein Feld ist reif', text: 'Schau mal vorbei' });
  const rumpf = verschluessele(sub, Buffer.from(klartext));

  const salt = rumpf.subarray(0, 16);
  const idlen = rumpf.readUInt8(20);
  const serverPub = rumpf.subarray(21, 21 + idlen);
  const geheim = rumpf.subarray(21 + idlen);

  const gemeinsam = geraet.computeSecret(serverPub);
  const info = Buffer.concat([
    Buffer.from('WebPush: info\0'),
    geraet.getPublicKey(),
    serverPub,
  ]);
  const prk = Buffer.from(hkdfSync('sha256', gemeinsam, auth, info, 32));
  const cek = Buffer.from(hkdfSync('sha256', prk, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', prk, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const tag = geheim.subarray(geheim.length - 16);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const offen = Buffer.concat([decipher.update(geheim.subarray(0, geheim.length - 16)), decipher.final()]);

  assert.equal(offen[offen.length - 1], 2, 'Padding-Trenner am Ende');
  assert.equal(offen.subarray(0, offen.length - 1).toString(), klartext, 'Inhalt kommt heil an');
});

test('Datensatzgröße und Schlüssellänge stehen im Kopf, wie der Standard es will', () => {
  const geraet = createECDH('prime256v1');
  geraet.generateKeys();
  const sub: PushSub = {
    endpoint: 'https://push.example.com/abc',
    p256dh: geraet.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };
  const rumpf = verschluessele(sub, Buffer.from('hallo'));
  assert.equal(rumpf.readUInt32BE(16), 4096, 'Datensatzgröße');
  assert.equal(rumpf.readUInt8(20), 65, 'Länge des Serverschlüssels');
  assert.ok(rumpf.length > 21 + 65, 'Geheimtext hängt dran');
});

test.after(() => rmSync(pfad, { force: true }));

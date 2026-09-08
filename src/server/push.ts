// Web-Push ohne Fremdbibliothek. Zwei Dinge müssen wir selbst können:
//
//   1. VAPID — ein signiertes JWT (ES256), mit dem sich der Server beim
//      Push-Dienst des Browsers ausweist (RFC 8292).
//   2. Verschlüsselung — die Nachricht wird für genau dieses Gerät
//      verschlüsselt, der Push-Dienst kann sie nicht lesen (RFC 8291, aes128gcm).
//
// Beides steckt in node:crypto, es braucht also kein npm-Paket.

import {
  createECDH,
  createCipheriv,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign as signRaw,
} from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type PushSub = {
  endpoint: string;
  p256dh: string; // öffentlicher Schlüssel des Geräts, base64url
  auth: string; // gemeinsames Geheimnis, base64url
};

export type VapidKeys = { publicKey: string; privateKeyPem: string; subject: string };

const b64url = (b: Buffer): string => b.toString('base64url');
const fromB64url = (s: string): Buffer => Buffer.from(s, 'base64url');

// Schlüsselpaar liegt neben den anderen Serverdaten und wird beim ersten Start
// erzeugt. Es darf sich nie ändern: Der Browser merkt sich, für welchen
// Absender er ein Abo ausgestellt hat.
export function ladeVapid(pfad: string, subject: string): VapidKeys {
  if (existsSync(pfad)) {
    const roh = JSON.parse(readFileSync(pfad, 'utf8')) as VapidKeys;
    if (roh.publicKey && roh.privateKeyPem) return { ...roh, subject };
  }
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  // Der öffentliche Schlüssel muss als unkomprimierter Punkt raus (65 Byte,
  // beginnt mit 0x04) — genau das erwartet der Browser bei applicationServerKey.
  const roh = publicKey.export({ type: 'spki', format: 'der' });
  const punkt = roh.subarray(roh.length - 65);
  const keys: VapidKeys = {
    publicKey: b64url(punkt),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    subject,
  };
  mkdirSync(dirname(pfad), { recursive: true });
  writeFileSync(pfad, JSON.stringify({ publicKey: keys.publicKey, privateKeyPem: keys.privateKeyPem }, null, 2));
  return keys;
}

// JWT nach RFC 8292: Kopf und Nutzlast base64url, Signatur ES256 im rohen
// r||s-Format (nicht DER — daran scheitern die meisten Eigenbauten).
export function vapidToken(keys: VapidKeys, aud: string, jetzt: number): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64url(
    Buffer.from(
      JSON.stringify({
        aud,
        exp: Math.floor(jetzt / 1000) + 12 * 60 * 60,
        sub: keys.subject,
      }),
    ),
  );
  const daten = Buffer.from(`${header}.${body}`);
  const sig = signRaw('sha256', daten, {
    key: createPrivateKey(keys.privateKeyPem),
    dsaEncoding: 'ieee-p1363',
  });
  return `${header}.${body}.${b64url(sig)}`;
}

// Verschlüsselt die Nachricht für ein Gerät (RFC 8291). Ergebnis ist der
// komplette Rumpf: salt | Datensatzgröße | Länge | Serverschlüssel | Geheimtext.
export function verschluessele(sub: PushSub, klartext: Buffer): Buffer {
  const geraet = fromB64url(sub.p256dh);
  const auth = fromB64url(sub.auth);

  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const serverPub = ecdh.getPublicKey();
  const gemeinsam = ecdh.computeSecret(geraet);

  // Erst aus dem gemeinsamen Geheimnis und `auth` einen Zwischenschlüssel,
  // dabei fließen beide öffentlichen Schlüssel in den Info-Block ein.
  const info = Buffer.concat([
    Buffer.from('WebPush: info\0'),
    geraet,
    serverPub,
  ]);
  const prk = Buffer.from(hkdfSync('sha256', gemeinsam, auth, info, 32));

  const salt = randomBytes(16);
  const cek = Buffer.from(
    hkdfSync('sha256', prk, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', prk, salt, Buffer.from('Content-Encoding: nonce\0'), 12),
  );

  // 0x02 schließt den einzigen Datensatz ab (Padding-Trenner).
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const geheim = Buffer.concat([
    cipher.update(Buffer.concat([klartext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const kopf = Buffer.alloc(21);
  salt.copy(kopf, 0);
  kopf.writeUInt32BE(4096, 16); // Datensatzgröße
  kopf.writeUInt8(serverPub.length, 20);
  return Buffer.concat([kopf, serverPub, geheim]);
}

export type PushErgebnis = { ok: boolean; status: number; weg: boolean };

// Schickt eine Nachricht an ein Gerät. `weg` heißt: Das Abo ist tot (404/410),
// der Aufrufer soll es löschen.
export async function sendePush(
  keys: VapidKeys,
  sub: PushSub,
  nutzlast: unknown,
  jetzt = Date.now(),
): Promise<PushErgebnis> {
  let aud: string;
  try {
    aud = new URL(sub.endpoint).origin;
  } catch {
    return { ok: false, status: 0, weg: true };
  }

  const rumpf = verschluessele(sub, Buffer.from(JSON.stringify(nutzlast)));
  let res: Response;
  try {
    res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: '86400',
        urgency: 'normal',
        authorization: `vapid t=${vapidToken(keys, aud, jetzt)}, k=${keys.publicKey}`,
      },
      body: rumpf,
    });
  } catch {
    return { ok: false, status: 0, weg: false };
  }
  return { ok: res.status >= 200 && res.status < 300, status: res.status, weg: res.status === 404 || res.status === 410 };
}

// Nur zum Prüfen im Test: Ist der öffentliche Schlüssel ein gültiger Punkt?
export function pruefeVapid(keys: VapidKeys): boolean {
  const punkt = fromB64url(keys.publicKey);
  if (punkt.length !== 65 || punkt[0] !== 4) return false;
  try {
    createPublicKey(createPrivateKey(keys.privateKeyPem));
    return true;
  } catch {
    return false;
  }
}

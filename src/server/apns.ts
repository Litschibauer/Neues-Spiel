// Apple Push Notification service. Für die native iOS-App reicht Web-Push
// nicht: Apple unterstützt das nur für PWAs auf dem Startbildschirm, nicht in
// der WKWebView einer App. Eine echte App bekommt ihre Meldungen über APNs.
//
// Auch das geht ohne Fremdbibliothek: Das Token ist wieder ein ES256-JWT (wie
// bei VAPID), zugestellt wird über HTTP/2, das in node:http2 steckt.
//
// Was von Apple gebraucht wird: ein Schlüssel (.p8), dessen Key-ID, die
// Team-ID und die Bundle-ID der App. Fehlt eines davon, ist APNs schlicht aus.

import { connect, constants } from 'node:http2';
import { createPrivateKey, sign as signRaw } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

export type ApnsConfig = {
  keyPem: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  sandbox: boolean;
};

export type ApnsErgebnis = { ok: boolean; status: number; weg: boolean; grund?: string };

// Liest die Einstellungen aus der Umgebung. Ohne vollständige Angaben bleibt
// APNs aus, und der Server läuft ganz normal weiter.
export function apnsAusUmgebung(env: NodeJS.ProcessEnv = process.env): ApnsConfig | null {
  const datei = env.NEUES_SPIEL_APNS_KEY_FILE?.trim();
  const keyId = env.NEUES_SPIEL_APNS_KEY_ID?.trim();
  const teamId = env.NEUES_SPIEL_APNS_TEAM_ID?.trim();
  const bundleId = env.NEUES_SPIEL_APNS_BUNDLE_ID?.trim();
  if (!datei || !keyId || !teamId || !bundleId) return null;
  if (!existsSync(datei)) {
    console.warn(`[apns] Schlüsseldatei nicht gefunden: ${datei} — APNs bleibt aus.`);
    return null;
  }
  return {
    keyPem: readFileSync(datei, 'utf8'),
    keyId,
    teamId,
    bundleId,
    sandbox: (env.NEUES_SPIEL_APNS_SANDBOX ?? '').trim() === '1',
  };
}

// Apple erlaubt dasselbe Token bis zu einer Stunde. Wir erneuern nach 50
// Minuten; öfter neu zu signieren wertet Apple als Missbrauch.
let tokenCache: { wert: string; bis: number } | null = null;

export function apnsToken(cfg: ApnsConfig, jetzt = Date.now()): string {
  if (tokenCache && tokenCache.bis > jetzt) return tokenCache.wert;
  const kopf = Buffer.from(JSON.stringify({ alg: 'ES256', kid: cfg.keyId })).toString('base64url');
  const rumpf = Buffer.from(
    JSON.stringify({ iss: cfg.teamId, iat: Math.floor(jetzt / 1000) }),
  ).toString('base64url');
  const sig = signRaw('sha256', Buffer.from(`${kopf}.${rumpf}`), {
    key: createPrivateKey(cfg.keyPem),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  const wert = `${kopf}.${rumpf}.${sig}`;
  tokenCache = { wert, bis: jetzt + 50 * 60 * 1000 };
  return wert;
}

export function apnsTokenVergessen(): void {
  tokenCache = null;
}

// Baut die Nutzlast, die iOS als Mitteilung anzeigt.
export function apnsNutzlast(titel: string, text: string, art: string): unknown {
  return {
    aps: {
      alert: { title: titel, body: text },
      sound: 'default',
      'thread-id': `hof-${art}`,
    },
    art,
  };
}

export async function sendeApns(
  cfg: ApnsConfig,
  geraeteToken: string,
  titel: string,
  text: string,
  art: string,
  ziel?: string,
): Promise<ApnsErgebnis> {
  const host = ziel ?? (cfg.sandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');
  const rumpf = Buffer.from(JSON.stringify(apnsNutzlast(titel, text, art)));

  return new Promise<ApnsErgebnis>((fertig) => {
    const client = connect(host);
    let erledigt = false;
    const schliessen = (r: ApnsErgebnis) => {
      if (erledigt) return;
      erledigt = true;
      client.close();
      fertig(r);
    };
    client.on('error', () => schliessen({ ok: false, status: 0, weg: false }));

    const req = client.request({
      [constants.HTTP2_HEADER_METHOD]: 'POST',
      [constants.HTTP2_HEADER_PATH]: `/3/device/${geraeteToken}`,
      authorization: `bearer ${apnsToken(cfg)}`,
      'apns-topic': cfg.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    });

    let status = 0;
    const teile: Buffer[] = [];
    req.on('response', (h) => {
      status = Number(h[constants.HTTP2_HEADER_STATUS] ?? 0);
    });
    req.on('data', (c: Buffer) => teile.push(c));
    req.on('error', () => schliessen({ ok: false, status: 0, weg: false }));
    req.on('end', () => {
      let grund: string | undefined;
      if (teile.length > 0) {
        try {
          grund = (JSON.parse(Buffer.concat(teile).toString()) as { reason?: string }).reason;
        } catch {
          grund = undefined;
        }
      }
      // 410 heißt: Das Gerät hat die App entfernt. 400 mit BadDeviceToken
      // ebenso — beide Abos dürfen weg.
      const weg = status === 410 || grund === 'BadDeviceToken' || grund === 'Unregistered';
      schliessen({ ok: status === 200, status, weg, grund });
    });
    req.setTimeout(10_000, () => schliessen({ ok: false, status: 0, weg: false }));
    req.end(rumpf);
  });
}

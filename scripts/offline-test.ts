/**
 * Der Feldtest, automatisiert: **im Funkloch neu laden.**
 *
 *   node --experimental-strip-types scripts/offline-test.ts
 *
 * Alles andere in diesem Projekt lässt sich in Node prüfen. Das hier nicht:
 * Ob eine Seite ohne Netz startet, hängt an Service Worker, Cache und
 * `localStorage` — an Dingen, die es nur im Browser gibt. Ein Test mit
 * Attrappen würde genau das nicht beweisen, worum es geht.
 *
 * Deshalb fährt dieses Skript einen echten Chromium und redet über das
 * DevTools-Protokoll mit ihm. Node 22 bringt einen WebSocket-Client mit, also
 * kostet das **keine Abhängigkeit** — die Kernaussage des Projekts bleibt
 * „npm test, keine Dependencies".
 *
 * Bewusst NICHT Teil von `npm test`: Es braucht einen Browser und einen
 * laufenden Server. Ein Testlauf, der ohne beides rot wird, sagt nichts.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
];

function findChromium(): string {
  for (const path of CHROME_CANDIDATES) {
    if (path && existsSync(path)) return path;
  }
  throw new Error(
    'Kein Chromium gefunden. Pfad über CHROMIUM_PATH setzen.\n' +
      `Gesucht in: ${CHROME_CANDIDATES.filter(Boolean).join(', ')}`,
  );
}

// ── Ein sehr kleiner DevTools-Klient ─────────────────────────────────────
//
// Genug für: Seite öffnen, JavaScript auswerten, Netz abschalten, neu laden.

type CdpResult = Record<string, unknown>;

class Cdp {
  private socket: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: CdpResult) => void; reject: (e: Error) => void }>();

  /** Ereignisse ohne `id` — Dialoge, Konsolenausgaben, Fehler. */
  onEvent: (method: string, params: CdpResult) => void = () => {};

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.socket.addEventListener('message', (event) => {
      const msg = JSON.parse(String((event as MessageEvent).data)) as {
        id?: number;
        method?: string;
        params?: CdpResult;
        result?: CdpResult;
        error?: { message: string };
      };
      if (msg.id === undefined) {
        if (msg.method) this.onEvent(msg.method, msg.params ?? {});
        return;
      }
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message));
      else waiter.resolve(msg.result ?? {});
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error(`WebSocket zu ${url} fehlgeschlagen`)), {
        once: true,
      });
    });
    return new Cdp(socket);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<CdpResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`Zeitüberschreitung bei ${method}`));
      }, 30_000);
    });
  }

  close(): void {
    this.socket.close();
  }
}

/** JavaScript in der Seite auswerten und das Ergebnis zurückholen. */
async function evaluate<T>(cdp: Cdp, expression: string): Promise<T> {
  const res = (await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })) as {
    result?: { value?: T };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  };
  if (res.exceptionDetails) {
    const detail = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text;
    throw new Error(`Fehler in der Seite: ${detail}`);
  }
  return res.result?.value as T;
}

/** Auf eine Bedingung in der Seite warten. */
async function waitFor(cdp: Cdp, expression: string, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate<boolean>(cdp, `!!(${expression})`)) return;
    if (Date.now() > deadline) throw new Error(`Zeitüberschreitung: ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Der eigentliche Test ─────────────────────────────────────────────────

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`);
}

/** Nur noch fürs Admin-Panel — Spieler melden sich mit ihrem Hof-Schlüssel an. */
const ADMIN_TOKEN = 'offline-test-admin-0123456789';
const PORT = 8799;
const dataDir = mkdtempSync(join(tmpdir(), 'ns-offline-'));
const profileDir = mkdtempSync(join(tmpdir(), 'ns-chrome-'));
const ROOT = join(import.meta.dirname, '..');

const chromium = findChromium();
console.log(`\nChromium: ${chromium}`);
console.log(`Server:   http://127.0.0.1:${PORT}\n`);

/**
 * Den ECHTEN Server starten, nicht eine nachgebaute Kopie.
 *
 * Ein Testserver, der die Routen nachbildet, prüft am Ende sich selbst. Der
 * Service Worker hängt an Kleinigkeiten wie Content-Type und Cache-Header —
 * genau an dem, was eine Attrappe anders macht.
 */
const server = spawn(
  process.execPath,
  ['--experimental-strip-types', join(ROOT, 'src', 'server', 'http.ts'), '--env=dev'],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(PORT),
      NEUES_SPIEL_TOKEN: ADMIN_TOKEN,
      NEUES_SPIEL_SAVE: join(dataDir, 'save.json'),
      NEUES_SPIEL_TOKEN_FILE: join(dataDir, 'token'),
      NEUES_SPIEL_VERSION: 'offline-test',
    },
  },
);

let serverLog = '';
server.stdout?.on('data', (d) => (serverLog += d));
server.stderr?.on('data', (d) => (serverLog += d));
server.on('exit', (code) => {
  if (code !== null && code !== 0) console.error(`  Server beendet mit ${code}`);
});

const api = (path: string, method = 'GET') =>
  fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  }).then((r) => r.json() as Promise<Record<string, unknown>>);

const browser = spawn(
  chromium,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--remote-debugging-port=9333',
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let cdp: Cdp | null = null;
let failed = false;

try {
  // Auf den Server warten.
  let up = false;
  let lastError = '';
  for (let i = 0; i < 80 && !up; i++) {
    await sleep(250);
    try {
      up = ((await api('/health')) as { ok?: boolean }).ok === true;
    } catch (e) {
      lastError = (e as Error).message;
    }
  }
  if (!up) {
    console.error('  Serverprotokoll:', serverLog.split('\n').filter(Boolean).slice(-8).join(' | '));
    throw new Error(`Server ist nicht hochgekommen (${lastError})`);
  }

  // Auf den Debug-Port warten.
  let wsUrl = '';
  for (let i = 0; i < 60 && !wsUrl; i++) {
    await sleep(250);
    try {
      const info = (await (await fetch('http://127.0.0.1:9333/json/version')).json()) as {
        webSocketDebuggerUrl: string;
      };
      wsUrl = info.webSocketDebuggerUrl;
    } catch {
      /* noch nicht da */
    }
  }
  if (!wsUrl) throw new Error('Chromium hat den Debug-Port nicht geöffnet');

  const browserCdp = await Cdp.connect(wsUrl);
  const target = (await browserCdp.send('Target.createTarget', { url: 'about:blank' })) as {
    targetId: string;
  };
  const pageWs = `ws://127.0.0.1:9333/devtools/page/${target.targetId}`;
  cdp = await Cdp.connect(pageWs);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');

  // Ein offener `alert()` blockiert JEDE weitere Auswertung — der Browser
  // wartet auf einen Menschen, den es hier nicht gibt. Also wegklicken und
  // den Text mitschreiben: Er ist meist die eigentliche Fehlermeldung.
  const dialogs: string[] = [];
  cdp.onEvent = (method, params) => {
    if (method === 'Page.javascriptDialogOpening') {
      dialogs.push(String((params as { message?: string }).message ?? ''));
      void cdp!.send('Page.handleJavaScriptDialog', { accept: true });
    }
    if (method === 'Runtime.exceptionThrown') {
      const d = params as { exceptionDetails?: { text?: string } };
      console.error('  Seitenfehler:', d.exceptionDetails?.text);
    }
  };

  // ── 1. Erster Besuch: Hof anlegen, Schlüssel bekommen, spielen ────────
  console.log('1. Erster Besuch — neuen Hof anlegen');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await waitFor(cdp, 'document.getElementById("create")', 'Seite geladen');
  await evaluate(cdp, `document.getElementById('create').click()`);
  await waitFor(cdp, '!document.getElementById("keybox").hidden', 'Schlüssel gezeigt');

  const shownKey = await evaluate<string>(cdp, `document.getElementById('keyvalue').textContent`);
  check(
    'Der Schlüssel wird gezeigt, statt still weggespeichert zu werden',
    /^hof_[0-9A-Z]{6}-[0-9A-Z]{6}-[0-9A-Z]{6}-[0-9A-Z]{6}$/.test(shownKey),
    shownKey,
  );

  await evaluate(cdp, `document.getElementById('keydone').click()`);
  try {
    await waitFor(cdp, '!document.getElementById("game").hidden', 'Spiel sichtbar', 10_000);
  } catch (e) {
    const diag = await evaluate<string>(
      cdp,
      `JSON.stringify({
         log: [...document.querySelectorAll('#log div')].map(d => d.textContent).slice(0, 5),
         setupHidden: document.getElementById('setup').hidden,
       })`,
    );
    console.error('  Diagnose:', diag, '| Dialoge:', JSON.stringify(dialogs));
    throw e;
  }
  check('Seite verbindet und zeigt den Hof', true);

  // Zeitbudget erst JETZT — der Hof existiert vorher noch nicht.
  await api('/api/admin/time?seconds=4000', 'POST');

  // Zwei Felder bestellen, damit es etwas zu verlieren gibt. Das dritte bleibt
  // frei — daran wird später gezeigt, dass man OHNE Netz weiterspielen kann.
  try {
    await waitFor(
      cdp,
      "document.querySelectorAll('#fields .field').length >= 3",
      'Plätze gezeichnet',
      8000,
    );
  } catch (e) {
    console.error(
      '  Diagnose:',
      await evaluate<string>(
        cdp,
        `JSON.stringify({
           fieldsHtml: (document.getElementById('fields')||{}).innerHTML?.slice(0,200),
           log: [...document.querySelectorAll('#log div')].map(d => d.textContent).slice(0, 6)
         })`,
      ),
    );
    throw e;
  }
  for (const index of [0, 1]) {
    await evaluate(cdp, `document.querySelectorAll('#fields .field')[${index}].click()`);
    await sleep(150);
  }
  await sleep(300);
  const queued = await evaluate<number>(cdp, "Number(document.getElementById('s-queue').textContent)");
  check('Aktionen landen in der Warteschlange', queued >= 2, `${queued} Commands`);

  const savedRaw = await evaluate<string | null>(
    cdp,
    `localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('ns-save:')))`,
  );
  check('Spielstand liegt lokal auf dem Gerät', !!savedRaw && savedRaw.length > 100);

  // Warten, bis der Service Worker die Hülle im Cache hat.
  await waitFor(
    cdp,
    'navigator.serviceWorker.controller || navigator.serviceWorker.ready',
    'Service Worker bereit',
  );
  await evaluate(cdp, 'navigator.serviceWorker.ready');
  await sleep(600);
  const cached = await evaluate<boolean>(
    cdp,
    `caches.keys().then(ks => Promise.all(ks.map(k => caches.open(k).then(c => c.keys())))
       .then(all => all.flat().some(r => new URL(r.url).pathname === '/')))`,
  );
  check('Service Worker hat die Hülle im Cache', cached);

  // ── 2. Netz kappen und NEU LADEN ──────────────────────────────────────
  console.log('\n2. Funkloch — Netz aus, Seite neu laden');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });

  await cdp.send('Page.reload', { ignoreCache: false });
  await sleep(1500);

  const loadedOffline = await evaluate<boolean>(
    cdp,
    `!!document.getElementById('game') && !document.getElementById('game').hidden`,
  );
  check('App startet ohne Netz — kein Dinosaurier', loadedOffline);

  const restored = await evaluate<number>(cdp, "Number(document.getElementById('s-queue').textContent)");
  check(
    'Nicht bestätigte Aktionen haben den Neustart überlebt',
    restored === queued,
    `${restored} von ${queued}`,
  );

  const stateMatches = await evaluate<boolean>(
    cdp,
    "document.querySelectorAll('#fields .field.growing').length >= 2",
  );
  check('Der Hof sieht aus wie vorher — die Felder laufen', stateMatches);

  // ── 3. Offline WEITERSPIELEN ──────────────────────────────────────────
  console.log('\n3. Offline weiterspielen');
  const before = await evaluate<number>(cdp, "Number(document.getElementById('s-queue').textContent)");
  await evaluate(cdp, `document.querySelectorAll('#fields .field')[2].click()`);
  await sleep(300);
  const after = await evaluate<number>(cdp, "Number(document.getElementById('s-queue').textContent)");
  check('Aktionen gehen im Funkloch weiter', after > before, `${before} → ${after}`);

  // ── 4. Netz zurück, alles ankommen lassen ─────────────────────────────
  console.log('\n4. Netz zurück');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await evaluate(cdp, `window.dispatchEvent(new Event('online'))`);

  let synced = false;
  for (let i = 0; i < 40 && !synced; i++) {
    await sleep(500);
    synced = await evaluate<boolean>(
      cdp,
      "Number(document.getElementById('s-queue').textContent) === 0",
    );
  }
  check('Alles bestätigt, Warteschlange leer', synced);

  const status = (await api('/api/admin/status')) as {
    seq: number;
    divergenceAlerts: number;
    accountId: string;
  };
  check('Server hat die Offline-Arbeit übernommen', status.seq >= after, `seq ${status.seq}`);
  check('Kein Divergenz-Alarm', status.divergenceAlerts === 0);

  // ── 5. Zweiter Hof: die Stände dürfen sich nicht vermischen ───────────
  console.log('\n5. Zweiter Hof auf demselben Server');
  const second = (await (
    await fetch(`http://127.0.0.1:${PORT}/api/account`, { method: 'POST' })
  ).json()) as { key: string; accountId: string };
  const secondState = (await (
    await fetch(`http://127.0.0.1:${PORT}/api/state`, {
      headers: { authorization: `Bearer ${second.key}` },
    })
  ).json()) as { accountId: string; snapshot: { seq: number } };

  check('Der zweite Hof ist ein anderer', second.accountId !== status.accountId);
  check('Und er ist leer — keine fremde Arbeit', secondState.snapshot.seq === 0);
  check(
    'Der Admin sieht beide',
    ((await api('/api/admin/accounts')) as { count: number }).count === 2,
  );
} catch (err) {
  failed = true;
  console.error(`\nAbbruch: ${(err as Error).message}`);
} finally {
  cdp?.close();
  browser.kill('SIGKILL');
  server.kill('SIGKILL');
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(profileDir, { recursive: true, force: true });
}

const passed = checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${checks.length} Prüfungen bestanden`);
if (failed || passed !== checks.length) process.exit(1);

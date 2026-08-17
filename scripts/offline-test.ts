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
let serverLog = '';

function startServer() {
  const child = spawn(
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
  child.stdout?.on('data', (d) => (serverLog += d));
  child.stderr?.on('data', (d) => (serverLog += d));
  child.on('exit', (code, signal) => {
    // Ein absichtlicher Neustart ist kein Fehler — SIGTERM und SIGKILL kommen
    // aus diesem Skript.
    if (code !== null && code !== 0 && signal === null) {
      console.error(`  Server beendet mit ${code}`);
    }
  });
  return child;
}

/** Veränderlich, weil Abschnitt 9 den Server absichtlich neu startet. */
let server = startServer();

/** Warten, bis `/health` antwortet. Gibt zurück, ob es geklappt hat. */
async function serverUp(tries = 80): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    await sleep(250);
    try {
      if (((await api('/health')) as { ok?: boolean }).ok === true) return true;
    } catch {
      /* noch nicht da */
    }
  }
  return false;
}

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
      // `text` ist meist nur „Uncaught". Was wirklich passiert ist, steht in
      // der Beschreibung samt Stack — ohne die sucht man im Dunkeln.
      const d = params as {
        exceptionDetails?: {
          text?: string;
          lineNumber?: number;
          exception?: { description?: string };
        };
      };
      console.error(
        '  Seitenfehler:',
        d.exceptionDetails?.exception?.description ??
          `${d.exceptionDetails?.text} (Zeile ${d.exceptionDetails?.lineNumber})`,
      );
    }
  };

  // ── 1. Erster Besuch: Hof anlegen, Schlüssel bekommen, spielen ────────
  console.log('1. Erster Besuch — neuen Hof anlegen (Feldtest-Ansicht)');
  // Bewusst die Feldtest-Ansicht: Sie zeigt Warteschlange, `seq` und Tick im
  // DOM, und genau daran hängen die Prüfungen unten. Das Spiel selbst liegt
  // auf `/` und wird in Abschnitt 7 geprüft.
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/feldtest` });
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

  // ── 6. Handel: zwei Höfe im selben Browser-Test ───────────────────────
  //
  // Bis hierhin war jeder Hof eine Insel. Jetzt stellt der zweite etwas ein,
  // der erste sieht es im Regal und kauft es mit einem echten Klick — über
  // echtes HTTP, nicht über eine Attrappe.
  console.log('\n6. Markt — der zweite Hof verkauft, der erste kauft');

  /** Einen Batch für einen bestimmten Hof abschicken, ohne Browser. */
  const syncAs = async (key: string, baseSeq: number, commands: unknown[]) =>
    (await (
      await fetch(`http://127.0.0.1:${PORT}/api/sync`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ baseSeq, rulesetVersion: 1001, commands }),
      })
    ).json()) as { ok: boolean; kind?: string; reason?: string; snapshot: { seq: number } };

  const stateAs = async (key: string) =>
    (await (
      await fetch(`http://127.0.0.1:${PORT}/api/state`, {
        headers: { authorization: `Bearer ${key}` },
      })
    ).json()) as { snapshot: { seq: number; state: { items: number[]; orders: unknown[] } } };

  // Der Verkäufer bekommt Weizen ins Postfach, holt ihn ab und stellt ihn ein.
  await api(`/api/admin/grant?account=${second.accountId}&item=wheat&amount=30`, 'POST');

  // Der Zustandsabruf allein muss das Postfach füllen — ohne dass der Spieler
  // irgendetwas getan hätte. Genau daran hakte es vorher.
  const beforeAnyAction = await stateAs(second.key);
  check(
    'Ein Geschenk erreicht das Postfach ohne Zutun des Spielers',
    beforeAnyAction.snapshot.seq === 0,
  );
  // Einstellen kostet eine Gebühr, und ein frischer Hof hat kein Gold. Also
  // erst ein paar Körner an den Händler — genau der Weg, den ein echter
  // Spieler geht, bevor er zum ersten Mal selbst anbietet.
  await syncAs(second.key, 0, [
    { seq: 1, tick: 0, type: 'COLLECT_MAIL' },
    { seq: 2, tick: 0, type: 'SELL_NPC', item: 1, amount: 5 },
  ]);
  const listed = await syncAs(second.key, 2, [
    { seq: 3, tick: 0, type: 'LIST_ORDER', item: 1, amount: 20, price: 3 },
  ]);
  check('Der zweite Hof stellt einen Auftrag ein', listed.ok, listed.reason ?? listed.kind);
  check(
    'Der Auftrag steht im Buch',
    ((await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()) as { offers: number })
      .offers === 1,
  );

  // Der Käufer braucht Münzen — sie kommen wie jedes Geschenk ins Postfach.
  await api(`/api/admin/grant?account=${status.accountId}&item=gold&amount=500`, 'POST');
  await evaluate(cdp, `document.getElementById('sync').click()`);
  await waitFor(cdp, `document.querySelectorAll('#market .offer').length === 1`, 'Angebot sichtbar');
  await evaluate(cdp, `document.getElementById('collect').click()`);
  await waitFor(
    cdp,
    `Number(document.querySelectorAll('#inventory .stat')[0].querySelector('dd').textContent) >= 360`,
    'Münzen im Lager',
  );

  const shelfText = await evaluate<string>(
    cdp,
    `document.querySelector('#market .offer').textContent`,
  );
  check('Der Käufer sieht das fremde Angebot', /20 Weizen/.test(shelfText), shelfText);

  // Ausgegraut ohne Netz — die Regel aus §6, direkt im DOM nachgesehen.
  // Echtes Funkloch, nicht nur ein abgefeuertes Ereignis: `navigator.onLine`
  // ändert sich sonst gar nicht, und genau die Fahne liest die Seite.
  await cdp.send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  await evaluate(cdp, `window.dispatchEvent(new Event('offline'))`);
  const greyed = await evaluate<boolean>(
    cdp,
    `document.getElementById('market').className === 'no-net'
       && document.querySelector('#market .offer').disabled
       && document.querySelectorAll('#market .offer').length === 1`,
  );
  check('Ohne Netz ist der Markt ausgegraut, nicht verschwunden', greyed);

  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await evaluate(cdp, `window.dispatchEvent(new Event('online'))`);

  // Auf den Sync warten, den das Netz-zurück auslöst — nicht nur darauf, dass
  // der Knopf wieder klickbar aussieht. Sonst klickt man in eine Auslage, die
  // im nächsten Wimpernschlag neu gezeichnet wird, und der Klick fällt ins
  // Leere. Genau daran war dieser Test einmal flatterhaft.
  await waitFor(
    cdp,
    `document.getElementById('pill').className.indexOf('live') >= 0
       && Number(document.getElementById('s-queue').textContent) === 0
       && document.querySelector('#market .offer')
       && !document.querySelector('#market .offer').disabled`,
    'Verbindung steht und Kaufknopf ist aktiv',
  );

  const wheatBefore = await evaluate<number>(
    cdp,
    `Number(document.querySelectorAll('#inventory .stat')[1].querySelector('dd').textContent)`,
  );
  await evaluate(cdp, `document.querySelector('#market .offer').click()`);
  await waitFor(
    cdp,
    `Number(document.getElementById('s-queue').textContent) === 0`,
    'Kauf bestätigt',
  );

  const wheatAfter = await evaluate<number>(
    cdp,
    `Number(document.querySelectorAll('#inventory .stat')[1].querySelector('dd').textContent)`,
  );
  if (wheatAfter === wheatBefore) {
    console.error(
      '  Seitenprotokoll:',
      await evaluate<string>(
        cdp,
        `JSON.stringify([...document.querySelectorAll('#log div')].map(d => d.textContent).slice(0, 8))`,
      ),
    );
    console.error(
      '  Knopf:',
      await evaluate<string>(
        cdp,
        `JSON.stringify({
           n: document.querySelectorAll('#market .offer').length,
           disabled: document.querySelector('#market .offer') ? document.querySelector('#market .offer').disabled : null,
           gold: document.querySelectorAll('#inventory .stat')[0].querySelector('dd').textContent,
         })`,
      ),
    );
  }
  check('Die gekaufte Ware ist da', wheatAfter === wheatBefore + 20, `${wheatBefore} → ${wheatAfter}`);
  check(
    'Und aus dem Buch verschwunden',
    ((await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()) as { offers: number })
      .offers === 0,
  );

  // Der Verkäufer war offline. Sein Erlös muss ihn trotzdem erreichen — durchs
  // Postfach, wie jedes Ereignis, von dem er nichts wissen konnte (§7).
  const sellerState = (await (
    await fetch(`http://127.0.0.1:${PORT}/api/state`, {
      headers: { authorization: `Bearer ${second.key}` },
    })
  ).json()) as { snapshot: { state: { orders: unknown[] } } };
  check('Der verkaufte Auftrag ist beim Verkäufer weg', sellerState.snapshot.state.orders.length === 0);

  const paid = await syncAs(second.key, 3, [{ seq: 4, tick: 0, type: 'COLLECT_MAIL' }]);
  const sellerAfter = (await (
    await fetch(`http://127.0.0.1:${PORT}/api/state`, {
      headers: { authorization: `Bearer ${second.key}` },
    })
  ).json()) as { snapshot: { state: { items: number[] } } };
  // 5 Weizen an den Händler (15) − Einstellgebühr (3) + Verkaufserlös (60).
  const expectedCoins = 15 - 3 + 60;
  check(
    `Der Verkäufer hat sein Geld — 20 × 3 = 60, abzüglich Gebühr`,
    paid.ok && sellerAfter.snapshot.state.items[0] === expectedCoins,
    `${sellerAfter.snapshot.state.items[0]} statt ${expectedCoins} Münzen`,
  );
  // ── 7. Die Spieloberfläche ────────────────────────────────────────────
  //
  // Zwei Oberflächen auf einem Kern: Wenn das Spiel denselben Hof anders sieht
  // als das Messgerät, liegt es an einer Anzeige — und das will man merken.
  // Geprüft wird deshalb nicht das Aussehen, sondern dass dieselben Zahlen
  // ankommen und dass eine Ernte über echte Klicks funktioniert.
  console.log('\n7. Die Spieloberfläche auf /');

  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  // Null-sicher: Direkt nach `Page.navigate` gibt es das Element noch nicht,
  // und `waitFor` würde an der Ausnahme abbrechen statt weiterzuwarten.
  await waitFor(
    cdp,
    'document.getElementById("shell") && !document.getElementById("shell").hidden',
    'Spiel geladen',
    20_000,
  );
  check('Das Spiel startet mit dem gespeicherten Hof — ohne Schlüsseleingabe', true);

  const shown = await evaluate<{ gold: string; plots: number; lvl: string }>(
    cdp,
    `({
       gold: document.getElementById('gold').textContent,
       plots: document.querySelectorAll('#plots .plot').length,
       lvl: document.getElementById('lvl').textContent,
     })`,
  );
  // Mit `?account=`: Ohne Angabe nimmt die Werkbank den ZULETZT angelegten Hof
  // — das wäre hier der Verkäufer aus Abschnitt 6, nicht der im Browser.
  const truth = (await api(`/api/admin/status?account=${status.accountId}`)) as {
    state: { items: number[]; plots: unknown[] };
  };
  check(
    'Es zeigt dieselben Zahlen wie der Server',
    Number(shown.gold) === truth.state.items[0] && shown.plots === truth.state.plots.length,
    `${shown.gold} Gold, ${shown.plots} Plätze, Stufe ${shown.lvl}`,
  );

  // Jeder Platz zeichnet sich selbst — aus dem Katalog, nicht aus einer Liste
  // in der Seite. Ein neues Gebäude taucht damit von allein auf.
  check(
    'Jeder Platz hat ein Bild',
    (await evaluate<number>(cdp, `document.querySelectorAll('#plots .plot svg.art').length`)) ===
      shown.plots,
  );

  // Ernten über einen echten Klick: Zeit gutschreiben, bis etwas reif ist.
  await api('/api/admin/time?seconds=4000', 'POST');
  await evaluate(cdp, `window.dispatchEvent(new Event('online'))`);
  // Auf den Sync warten, den das Netz-zurück auslöst — nicht nur darauf, dass
  // irgendwo „reif" steht. Sonst klickt man auf eine Kachel, die der nächste
  // Neuzeichnung schon ersetzt hat, und der Klick fällt ins Leere.
  await waitFor(
    cdp,
    `document.getElementById('conn').className.indexOf('live') >= 0
       && document.querySelector('#plots .plot.ripe')`,
    'Verbindung steht und ein Platz ist reif',
    20_000,
  );

  const stockOf = (name: string) =>
    evaluate<number>(
      cdp,
      `(function () {
         var c = [...document.querySelectorAll('#stock .chip')].find(function (x) {
           return x.textContent.indexOf(${JSON.stringify(name)}) === 0;
         });
         return c ? Number(c.querySelector('.n').textContent) : -1;
       })()`,
    );

  const beforeHarvest = await stockOf('Weizen');
  await evaluate(cdp, `document.querySelector('#plots .plot.ripe').click()`);

  // Bewusst eine eigene Schleife statt `waitFor`: Bei einer Zeitüberschreitung
  // bricht `waitFor` ab, und dann steht man ohne die eine Information da, die
  // man bräuchte — was die Seite in diesem Moment eigentlich anzeigte.
  let afterHarvest = beforeHarvest;
  for (let i = 0; i < 40 && afterHarvest <= beforeHarvest; i++) {
    await sleep(250);
    afterHarvest = await stockOf('Weizen');
  }
  if (afterHarvest <= beforeHarvest) {
    console.error(
      '  Plätze:',
      await evaluate<string>(
        cdp,
        `JSON.stringify([...document.querySelectorAll('#plots .plot')].map(function (p) {
           return p.querySelector('.name').textContent + '=' + p.querySelector('.status').textContent;
         }))`,
      ),
    );
    console.error(
      '  Zustand:',
      await evaluate<string>(
        cdp,
        `JSON.stringify({
           meldung: document.getElementById('toast').textContent,
           gesperrt: !document.getElementById('lease').hidden,
           verbindung: document.getElementById('conn').textContent,
           lager: document.getElementById('silo-num').textContent,
         })`,
      ),
    );
    const truth2 = (await api(`/api/admin/status?account=${status.accountId}`)) as {
      seq: number;
      state: { items: number[]; plots: Array<{ recipe: number }> };
    };
    console.error(
      '  Server:',
      JSON.stringify({
        seq: truth2.seq,
        weizen: truth2.state.items[1],
        belegteFelder: truth2.state.plots.filter((p) => p.recipe !== -1).length,
      }),
    );
  }
  check(
    'Ernten geht mit einem Tipp auf den Platz',
    afterHarvest > beforeHarvest,
    `${beforeHarvest} → ${afterHarvest} Weizen`,
  );

  // Die Navigation muss die vier Ansichten wirklich umschalten — sonst ist der
  // halbe Hof unerreichbar.
  const tabs = await evaluate<string>(
    cdp,
    `JSON.stringify(['orders', 'market', 'store', 'farm'].map(function (name) {
       document.querySelector('nav button[data-view="' + name + '"]').click();
       return document.getElementById('view-' + name).hidden === false;
     }))`,
  );
  check('Alle vier Ansichten öffnen sich', JSON.parse(tabs).every(Boolean), tabs);

  // Und die Offline-Regel aus §6, jetzt in der echten Oberfläche.
  await cdp.send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  await evaluate(cdp, `window.dispatchEvent(new Event('offline'))`);
  await evaluate(cdp, `document.querySelector('nav button[data-view="market"]').click()`);
  check(
    'Ohne Netz ist der Markt ausgegraut und der Hinweis sichtbar',
    await evaluate<boolean>(
      cdp,
      `document.getElementById('market-list').className === 'no-net'
         && !document.getElementById('market-note').hidden`,
    ),
  );

  // Neu laden im Funkloch — dieselbe Prüfung wie für das Messgerät, jetzt für
  // die Seite, die Spieler wirklich sehen.
  await cdp.send('Page.reload', { ignoreCache: false });
  let gameOffline = false;
  for (let i = 0; i < 40 && !gameOffline; i++) {
    await sleep(500);
    gameOffline = await evaluate<boolean>(
      cdp,
      `!!document.getElementById('shell') && !document.getElementById('shell').hidden`,
    ).catch(() => false);
  }
  check('Das Spiel startet im Funkloch — kein Dinosaurier', gameOffline);

  // ── 8. Live-Anstöße ───────────────────────────────────────────────────
  //
  // Die Prüfung, die es vorher nicht geben konnte: Ein Angebot, das jemand
  // ANDERS einstellt, muss auf einem stillstehenden Bildschirm auftauchen,
  // ohne dass jemand tippt oder neu lädt.
  //
  // Dass hier wirklich der Anstoß wirkt und nicht der Vier-Sekunden-Timer,
  // liegt an der Sync-Maschine: Ein Hof mit leerer Warteschlange sendet ohne
  // `force` gar nichts (`nothing-to-do`). Wer nichts tut, bliebe also ewig auf
  // einem alten Markt sitzen — genau das war die Beschwerde.
  console.log('\n8. Live — ein fremdes Angebot erscheint ohne Zutun');

  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await evaluate(cdp, `window.dispatchEvent(new Event('online'))`);
  await waitFor(
    cdp,
    `document.getElementById('conn').className.indexOf('live') >= 0`,
    'wieder verbunden',
    20_000,
  );

  // Die Leitung steht — von außen sichtbar, ohne in den Browser zu schauen.
  let streams = 0;
  for (let i = 0; i < 40 && streams === 0; i++) {
    await sleep(250);
    streams = ((await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()) as {
      streams: number;
    }).streams;
  }
  check('Der Browser hält eine Live-Leitung offen', streams >= 1, `${streams} offen`);

  const offersBefore = await evaluate<number>(
    cdp,
    `document.querySelectorAll('#market-list .card').length`,
  );

  // Jetzt stellt der zweite Hof etwas ein — komplett am Browser vorbei.
  await api(`/api/admin/grant?account=${second.accountId}&item=eggs&amount=6`, 'POST');
  const sellerSeq = (await stateAs(second.key)).snapshot.seq;
  await syncAs(second.key, sellerSeq, [
    { seq: sellerSeq + 1, tick: 0, type: 'COLLECT_MAIL' },
    { seq: sellerSeq + 2, tick: 0, type: 'LIST_ORDER', item: 3, amount: 6, price: 12 },
  ]);

  // Kein Klick, kein Neuladen, kein Tastendruck: nur warten.
  let offersAfter = offersBefore;
  for (let i = 0; i < 40 && offersAfter <= offersBefore; i++) {
    await sleep(250);
    offersAfter = await evaluate<number>(
      cdp,
      `document.querySelectorAll('#market-list .card').length`,
    );
  }
  check(
    'Ein neues Angebot erscheint von selbst — ohne Neuladen',
    offersAfter > offersBefore,
    `${offersBefore} → ${offersAfter} Angebote`,
  );

  // ── 9. Neustart des Servers, mitten im Spiel ──────────────────────────
  //
  // Der Fall, den es im Betrieb garantiert gibt: neue Version ausrollen,
  // Kernel-Update, Kiste neu gestartet. Für den Spieler darf das nichts
  // anderes sein als ein kurzes Funkloch — und dafür ist die ganze Architektur
  // gebaut. Hier wird das einmal wirklich durchgespielt statt behauptet.
  console.log('\n9. Neustart des Servers, während jemand spielt');

  // Die Seite hält ihren Client bewusst privat. Was sie nach außen gibt, ist
  // der Spielstand im Gerätespeicher — und der reicht: Er enthält den
  // bestätigten Snapshot und die noch offene Warteschlange.
  const savedState = () =>
    evaluate<{ seq: number; queue: number }>(
      cdp!,
      `(function () {
         var raw = localStorage.getItem(globalThis.NeuesSpiel.storageKeyFor(location.origin));
         var blob = JSON.parse(raw);
         return { seq: blob.snapshot.seq, queue: blob.queue.length };
       })()`,
    );

  const seqBeforeRestart = (await savedState()).seq;

  const stopped = Date.now();
  server.kill('SIGTERM');
  await new Promise<void>((resolve) => server.once('exit', () => resolve()));
  const stopMs = Date.now() - stopped;
  // Zwanzig Sekunden gibt systemd (TimeoutStopSec), danach räumt es hart ab.
  // Zwei sind die eigene Notbremse im Server. Alles darüber wäre ein Hänger.
  check('SIGTERM beendet den Server zügig', stopMs < 3000, `${stopMs} ms`);

  // Der Spieler tippt weiter, während gar nichts da ist.
  await evaluate(cdp, `document.querySelector('nav button[data-view="farm"]').click()`);
  const beforeQueue = (await savedState()).queue;
  await evaluate(
    cdp,
    `(function () {
       var tile = [...document.querySelectorAll('#plots .plot')].find(function (p) {
         return !p.disabled;
       });
       if (tile) tile.click();
     })()`,
  );
  const queuedWhileDown = (await savedState()).queue;
  check(
    'Ohne Server geht das Spielen weiter — die Aktion wartet in der Warteschlange',
    queuedWhileDown > beforeQueue,
    `${beforeQueue} → ${queuedWhileDown} Commands`,
  );

  server = startServer();
  if (!(await serverUp())) {
    console.error('  Serverprotokoll:', serverLog.split('\n').filter(Boolean).slice(-8).join(' | '));
    throw new Error('Server kam nach dem Neustart nicht hoch');
  }

  // Ab hier: kein Klick, kein Neuladen. Die Seite muss sich allein fangen.
  const recovering = Date.now();
  await waitFor(
    cdp,
    `document.getElementById('conn').className.indexOf('live') >= 0
       && JSON.parse(localStorage.getItem(globalThis.NeuesSpiel.storageKeyFor(location.origin))).queue.length === 0`,
    'Seite fängt sich nach dem Neustart',
    40_000,
  );
  check(
    'Die Seite verbindet sich von selbst wieder — ohne Neuladen',
    true,
    `nach ${Date.now() - recovering} ms`,
  );

  const seqAfterRestart = (await savedState()).seq;
  check(
    'Was während der Ausfallzeit getippt wurde, ist angekommen',
    seqAfterRestart > seqBeforeRestart,
    `seq ${seqBeforeRestart} → ${seqAfterRestart}`,
  );

  // Und die Live-Leitung baut sich ebenfalls allein wieder auf — sonst wäre
  // der Markt nach dem ersten Neustart für immer wieder auf dem Timer.
  let streamsBack = 0;
  for (let i = 0; i < 60 && streamsBack === 0; i++) {
    await sleep(250);
    streamsBack = ((await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()) as {
      streams: number;
    }).streams;
  }
  check('Die Live-Leitung kommt von allein zurück', streamsBack >= 1, `${streamsBack} offen`);
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

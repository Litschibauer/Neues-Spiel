import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRuleset, listingFee } from '../src/sim/rules.ts';

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

type CdpResult = Record<string, unknown>;

class Cdp {
  private socket: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: CdpResult) => void; reject: (e: Error) => void }>();

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

async function waitFor(cdp: Cdp, expression: string, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate<boolean>(cdp, `!!(${expression})`)) return;
    if (Date.now() > deadline) throw new Error(`Zeitüberschreitung: ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tippeBisGesetzt(cdp: Cdp): Promise<boolean> {
  for (const x of [0.5, 0.25, 0.75, 0.35, 0.65, 0.15]) {
    for (const y of [0.5, 0.6, 0.7, 0.45, 0.8, 0.9]) {
      await evaluate(
        cdp,
        `(function () {
           var hof = document.getElementById('hof');
           var r = hof.getBoundingClientRect();
           hof.dispatchEvent(new MouseEvent('click', {
             clientX: r.left + r.width * ${x},
             clientY: r.top + r.height * ${y},
             bubbles: true,
           }));
         })()`,
      );
      await sleep(280);
      if (await evaluate<boolean>(cdp, `document.getElementById('setzen').hidden`)) return true;
    }
  }
  return false;
}

async function baueUndStelle(cdp: Cdp, name: string): Promise<boolean> {
  await evaluate(cdp, `document.getElementById('bauen').click()`);
  await sleep(350);
  const gekauft = await evaluate<boolean>(
    cdp,
    `(function () {
       var k = [...document.querySelectorAll('#bauliste .card')].find(function (c) {
         return !c.disabled && c.querySelector('.top').textContent.indexOf(${JSON.stringify(name)}) === 0;
       });
       if (!k) { document.getElementById('bau-close').click(); return false; }
       k.click();
       return true;
     })()`,
  );
  if (!gekauft) return false;
  await sleep(500);
  return tippeBisGesetzt(cdp);
}

const plantAll = `(function () {
     var n = 0;
     for (var k = 0; k < 12; k++) {
       var tile = [...document.querySelectorAll('#plots .plot')].find(function (t) {
         var s = t.querySelector('.status').textContent;
         return /→/.test(s) || / oder /.test(s);
       });
       if (!tile) break;
       tile.click();
       var sheet = document.getElementById('pick-bg');
       if (sheet.hidden) { n++; continue; }
       var opt = [...document.querySelectorAll('#pick-list .opt')].find(function (o) {
         return !o.disabled && o.querySelector('.top').textContent === 'Weizen';
       });
       if (!opt) { document.getElementById('pick-close').click(); break; }
       opt.click();
       n++;
     }
     return n;
   })()`;

const harvestAll = `(function () {
     var n = 0;
     for (var k = 0; k < 12; k++) {
       var tile = [...document.querySelectorAll('#plots .plot')].find(function (t) {
         return t.querySelector('.status').textContent.indexOf('fertig') === 0;
       });
       if (!tile) break;
       tile.click();
       n++;
     }
     return n;
   })()`;



async function plantSomething(cdp: Cdp): Promise<boolean> {
  await evaluate(cdp, `document.getElementById('brett-close') && (document.getElementById('brett-bg').hidden = true, document.getElementById('lager-bg').hidden = true, document.getElementById('stand-bg').hidden = true)`);
  await sleep(200);

  const clicked = await evaluate<boolean>(
    cdp,
    `(function () {
       var tile = [...document.querySelectorAll('#plots .plot')].find(function (p) {
         var s = p.querySelector('.status').textContent;
         return /→/.test(s) || / oder /.test(s);
       });
       if (!tile) return false;
       tile.click();
       return true;
     })()`,
  );
  if (!clicked) return false;

  await sleep(200);

  return await evaluate<boolean>(
    cdp,
    `(function () {
       var sheet = document.getElementById('pick-bg');
       if (sheet.hidden) return true;
       var opt = [...document.querySelectorAll('#pick-list .opt')].find(function (o) {
         return !o.disabled;
       });
       if (!opt) { document.getElementById('pick-close').click(); return false; }
       opt.click();
       return true;
     })()`,
  );
}

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`);
}

const ADMIN_TOKEN = 'offline-test-admin-0123456789';
const PORT = 8799;
const dataDir = mkdtempSync(join(tmpdir(), 'ns-offline-'));
const profileDir = mkdtempSync(join(tmpdir(), 'ns-chrome-'));
const ROOT = join(import.meta.dirname, '..');

const chromium = findChromium();
console.log(`\nChromium: ${chromium}`);
console.log(`Server:   http://127.0.0.1:${PORT}\n`);

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
    if (code !== null && code !== 0 && signal === null) {
      console.error(`  Server beendet mit ${code}`);
    }
  });
  return child;
}

let server = startServer();

async function serverUp(tries = 80): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    await sleep(250);
    try {
      if (((await api('/health')) as { ok?: boolean }).ok === true) return true;
    } catch {
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

  let wsUrl = '';
  for (let i = 0; i < 60 && !wsUrl; i++) {
    await sleep(250);
    try {
      const info = (await (await fetch('http://127.0.0.1:9333/json/version')).json()) as {
        webSocketDebuggerUrl: string;
      };
      wsUrl = info.webSocketDebuggerUrl;
    } catch {
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

  const dialogs: string[] = [];
  cdp.onEvent = (method, params) => {
    if (method === 'Page.javascriptDialogOpening') {
      dialogs.push(String((params as { message?: string }).message ?? ''));
      void cdp!.send('Page.handleJavaScriptDialog', { accept: true });
    }
    if (method === 'Runtime.exceptionThrown') {
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

  console.log('1. Erster Besuch — neuen Hof anlegen (Feldtest-Ansicht)');

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

  await api('/api/admin/time?seconds=4000', 'POST');

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

  console.log('\n3. Offline weiterspielen');
  const before = await evaluate<number>(cdp, "Number(document.getElementById('s-queue').textContent)");
  await evaluate(cdp, `document.querySelectorAll('#fields .field')[2].click()`);
  await sleep(300);
  const after = await evaluate<number>(cdp, "Number(document.getElementById('s-queue').textContent)");
  check('Aktionen gehen im Funkloch weiter', after > before, `${before} → ${after}`);

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

  console.log('\n6. Markt — der zweite Hof verkauft, der erste kauft');

  const syncAs = async (key: string, baseSeq: number, commands: unknown[]) =>
    (await (
      await fetch(`http://127.0.0.1:${PORT}/api/sync`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ baseSeq, rulesetVersion: 1001, commands }),
      })
    ).json()) as { ok: boolean; kind?: string; reason?: string; snapshot: { seq: number } };

  const tickFuer = (snap: { seq: number; serverTs: number; state: { tick: number } }) =>
    snap.state.tick + Math.max(0, Math.floor((Date.now() - snap.serverTs) / 1000) - 2);

  const stateAs = async (key: string) =>
    (await (
      await fetch(`http://127.0.0.1:${PORT}/api/state`, {
        headers: { authorization: `Bearer ${key}` },
      })
    ).json()) as {
      snapshot: {
        seq: number;
        serverTs: number;
        state: { tick: number; items: number[]; orders: unknown[] };
      };
    };

  await api(`/api/admin/grant?account=${second.accountId}&item=wheat&amount=30`, 'POST');

  const beforeAnyAction = await stateAs(second.key);
  check(
    'Ein Geschenk erreicht das Postfach ohne Zutun des Spielers',
    beforeAnyAction.snapshot.seq === 0,
  );

  await syncAs(second.key, 0, [{ seq: 1, tick: 0, type: 'COLLECT_MAIL' }]);
  const listed = await syncAs(second.key, 1, [
    { seq: 2, tick: 0, type: 'LIST_ORDER', item: 1, amount: 10, price: 3 },
  ]);
  check('Der zweite Hof stellt einen Auftrag ein', listed.ok, listed.reason ?? listed.kind);
  check(
    'Der Auftrag steht im Buch',
    ((await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()) as { offers: number })
      .offers === 1,
  );

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
  check('Der Käufer sieht das fremde Angebot', /10 Weizen/.test(shelfText), shelfText);

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
  check('Die gekaufte Ware ist da', wheatAfter === wheatBefore + 10, `${wheatBefore} → ${wheatAfter}`);
  check(
    'Und aus dem Buch verschwunden',
    ((await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()) as { offers: number })
      .offers === 0,
  );

  const sellerState = (await (
    await fetch(`http://127.0.0.1:${PORT}/api/state`, {
      headers: { authorization: `Bearer ${second.key}` },
    })
  ).json()) as {
    snapshot: { seq: number; state: { orders: Array<{ id: number; verkauft: number }> } };
  };
  const verkauftesKaestchen = sellerState.snapshot.state.orders[0];
  check(
    'Das verkaufte Kästchen bleibt stehen — mit dem Erlös darin',
    sellerState.snapshot.state.orders.length === 1 && (verkauftesKaestchen?.verkauft ?? 0) === 30,
    JSON.stringify(sellerState.snapshot.state.orders),
  );

  const vorAbholung = (await (
    await fetch(`http://127.0.0.1:${PORT}/api/state`, {
      headers: { authorization: `Bearer ${second.key}` },
    })
  ).json()) as { snapshot: { state: { items: number[] } } };

  const devRules = getRuleset(1001);
  const startGold = devRules.startingItems.find((x) => x.item === 0)?.amount ?? 0;
  const vorErwartet = startGold - listingFee(devRules, 1, 10);
  check(
    'Vor dem Abholen ist das Gold noch nicht auf dem Konto',
    vorAbholung.snapshot.state.items[0] === vorErwartet,
    `${vorAbholung.snapshot.state.items[0]} statt ${vorErwartet} Münzen`,
  );

  const abgeholt = await syncAs(second.key, sellerState.snapshot.seq, [
    {
      seq: sellerState.snapshot.seq + 1,
      tick: 0,
      type: 'COLLECT_SALE',
      orderId: verkauftesKaestchen?.id ?? 0,
    },
  ]);
  const sellerPaid = (await (
    await fetch(`http://127.0.0.1:${PORT}/api/state`, {
      headers: { authorization: `Bearer ${second.key}` },
    })
  ).json()) as { snapshot: { state: { items: number[]; orders: unknown[] } } };

  const expectedCoins = vorErwartet + 10 * 3;
  check(
    `Ein Tipp holt den Erlös ab — 10 × 3 = 30 — und macht das Kästchen frei`,
    abgeholt.ok &&
      sellerPaid.snapshot.state.items[0] === expectedCoins &&
      sellerPaid.snapshot.state.orders.length === 0,
    `${sellerPaid.snapshot.state.items[0]} statt ${expectedCoins} Münzen, ` +
      `${sellerPaid.snapshot.state.orders.length} Kästchen belegt`,
  );

  console.log('\n7. Die Spieloberfläche auf / (Telefonformat 390 × 844)');

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  });

  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });

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

  const truth = (await api(`/api/admin/status?account=${status.accountId}`)) as {
    state: { items: number[]; plots: Array<{ gx: number }> };
  };
  check(
    'Es zeigt dieselben Zahlen wie der Server',
    Number(shown.gold) === truth.state.items[0] &&
      shown.plots === truth.state.plots.filter((p) => (p as { gx: number }).gx >= 0).length,
    `${shown.gold} Gold, ${shown.plots} Plätze, Stufe ${shown.lvl}`,
  );

  check(
    'Jeder Platz hat ein Bild',
    (await evaluate<number>(cdp, `document.querySelectorAll('#plots .plot svg.art').length`)) ===
      shown.plots,
  );

  const hof = await evaluate<{
    landschaft: boolean;
    verteilt: number;
    imBild: boolean;
    ueberlappt: number;
  }>(
    cdp,
    `(function () {
       var rahmen = document.getElementById('hof').getBoundingClientRect();
       var kacheln = [...document.querySelectorAll('#plots .plot')].map(function (t) {
         return t.getBoundingClientRect();
       });
       var stellen = {};
       kacheln.forEach(function (r) { stellen[Math.round(r.left) + 'x' + Math.round(r.top)] = 1; });
       var ueberlappt = 0;
       for (var i = 0; i < kacheln.length; i++) {
         for (var j = i + 1; j < kacheln.length; j++) {
           var a = kacheln[i], b = kacheln[j];
           if (!(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top)) {
             ueberlappt++;
           }
         }
       }
       return {
         landschaft: document.getElementById('scene').children.length > 0,
         verteilt: Object.keys(stellen).length,
         imBild: kacheln.every(function (r) {
           return r.left >= rahmen.left - 1 && r.right <= rahmen.right + 1
             && r.top >= rahmen.top - 1 && r.bottom <= rahmen.bottom + 1;
         }),
         ueberlappt: ueberlappt,
       };
     })()`,
  );
  check(
    'Der Hof ist ein Ort: Landschaft dahinter, jeder Platz an seiner eigenen Stelle',
    hof.landschaft && hof.verteilt === shown.plots && hof.imBild && hof.ueberlappt === 0,
    `Landschaft ${hof.landschaft}, ${hof.verteilt} Stellen, im Bild ${hof.imBild}, ` +
      `${hof.ueberlappt} Überschneidungen`,
  );

  check(
    'Der ganze Hof passt aufs Bild — ohne Scrollen',
    await evaluate<boolean>(
      cdp,
      `document.getElementById('hof').getBoundingClientRect().bottom <= window.innerHeight`,
    ),
  );

  await api('/api/admin/time?seconds=4000', 'POST');
  await evaluate(cdp, `window.dispatchEvent(new Event('online'))`);

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
        belegteFelder: truth2.state.plots.filter((p) => p.slots.some((x) => x.recipe !== -1)).length,
      }),
    );
  }
  const flugzahl = await evaluate<string>(
    cdp,
    `(function () {
       var el = document.querySelector('.flug');
       return el ? el.className + ':' + el.textContent : 'keine';
     })()`,
  );
  check(
    'Beim Ernten steigt die Ausbeute über dem Feld auf',
    /flug/.test(flugzahl) && /\+/.test(flugzahl),
    flugzahl,
  );

  check(
    'Ernten geht mit einem Tipp auf den Platz',
    afterHarvest > beforeHarvest,
    `${beforeHarvest} → ${afterHarvest} Weizen`,
  );

  const obenauf = await evaluate<string>(
    cdp,
    `(function () {
       var tile = [...document.querySelectorAll('#plots .plot')].find(function (t) {
         var s = t.querySelector('.status').textContent;
         return /→/.test(s) || / oder /.test(s);
       });
       if (!tile) return 'kein Platz zum Starten';
       tile.click();
       var sheet = document.getElementById('pick-bg');
       if (sheet.hidden) return 'Blatt blieb zu';
       var karte = document.querySelector('#pick-list .opt');
       var r = karte.getBoundingClientRect();
       var treffer = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
       var drin = sheet.contains(treffer);
       document.getElementById('pick-close').click();
       return drin ? 'ok' : 'verdeckt von ' + (treffer ? treffer.className : 'nichts');
     })()`,
  );
  check(
    'Das Auswahlblatt liegt vor dem Hof, nicht dahinter',
    obenauf === 'ok',
    obenauf,
  );


  const haeuser = await evaluate<string>(
    cdp,
    `JSON.stringify([['brett', 'brett'], ['lagerhaus', 'lager'], ['stand', 'stand']]
       .map(function (paar) {
         document.getElementById(paar[0]).click();
         var offen = document.getElementById(paar[1] + '-bg').hidden === false;
         document.getElementById(paar[1] + '-close').click();
         return offen && document.getElementById(paar[1] + '-bg').hidden === true;
       }))`,
  );
  check(
    'Brett, Lager und Stand öffnen und schließen sich auf dem Hof',
    JSON.parse(haeuser).every(Boolean),
    haeuser,
  );

  const wagenTipp = await evaluate<string>(
    cdp,
    `(function () {
       document.getElementById('wagen').click();
       var offen = document.getElementById('brett-bg').hidden === false;
       var titel = document.getElementById('brett-titel').textContent;
       document.getElementById('brett-close').click();
       return offen ? titel : 'nichts geöffnet';
     })()`,
  );
  check(
    'Ein Tipp auf den Wagen führt zum Brett, nicht in eine Sackgasse',
    wagenTipp === 'Das Brett',
    wagenTipp,
  );

  const bilder = await evaluate<{ chips: number; mitBild: number; geladen: number }>(
    cdp,
    `(function () {
       document.getElementById('lagerhaus').click();
       var chips = [...document.querySelectorAll('#stock .chip')];
       var bilder = chips.filter(function (c) { return c.querySelector('img.ic'); });
       var geladen = bilder.filter(function (c) {
         var i = c.querySelector('img.ic');
         return i.complete && i.naturalWidth > 0;
       });
       document.getElementById('lager-close').click();
       return { chips: chips.length, mitBild: bilder.length, geladen: geladen.length };
     })()`,
  );
  check(
    'Jede Ware hat ein Bild, und die Bilder stecken in der Seite',
    bilder.chips > 0 && bilder.mitBild === bilder.chips && bilder.geladen === bilder.chips,
    `${bilder.geladen}/${bilder.chips} geladen`,
  );

  await cdp.send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  await evaluate(cdp, `window.dispatchEvent(new Event('offline'))`);
  const standZu = await evaluate<string>(
    cdp,
    `(function () {
       document.getElementById('stand').click();
       return document.getElementById('stand-bg').hidden ? 'gar nicht auf' : 'trotzdem offen';
     })()`,
  );
  check(
    'Ohne Netz lässt sich der Verkaufsstand nicht öffnen — Fehlerquelle zu',
    standZu === 'gar nicht auf',
    standZu,
  );

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

  let streams = 0;
  for (let i = 0; i < 40 && streams === 0; i++) {
    await sleep(250);
    streams = ((await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()) as {
      streams: number;
    }).streams;
  }
  check('Der Browser hält eine Live-Leitung offen', streams >= 1, `${streams} offen`);

  await evaluate(cdp, `document.getElementById('stand').click()`);
  const offersBefore = await evaluate<number>(
    cdp,
    `document.querySelectorAll('#zeitung .card.anzeige').length`,
  );

  await api(`/api/admin/grant?account=${second.accountId}&item=eggs&amount=6`, 'POST');
  const sellerSeq = (await stateAs(second.key)).snapshot.seq;
  await syncAs(second.key, sellerSeq, [
    { seq: sellerSeq + 1, tick: 0, type: 'COLLECT_MAIL' },
    { seq: sellerSeq + 2, tick: 0, type: 'LIST_ORDER', item: 3, amount: 6, price: 12 },
  ]);

  let offersAfter = offersBefore;
  for (let i = 0; i < 40 && offersAfter <= offersBefore; i++) {
    await sleep(250);
    offersAfter = await evaluate<number>(
      cdp,
      `document.querySelectorAll('#zeitung .card.anzeige').length`,
    );
  }
  check(
    'Ein fremder Hof erscheint von selbst in der Zeitung — ohne Neuladen',
    offersAfter > offersBefore,
    `${offersBefore} → ${offersAfter} Höfe im Blatt`,
  );

  console.log('\n8b. Kästchen füllen: Ware, Menge, Preis');

  await evaluate(cdp, `document.getElementById('stand').click()`);

  const wheatStock = await evaluate<number>(
    cdp,
    `(function () {
       var c = [...document.querySelectorAll('#stock .chip')].find(function (x) {
         return x.textContent.indexOf('Weizen') === 0;
       });
       return c ? Number(c.querySelector('.n').textContent) : -1;
     })()`,
  );

  const kaesten = await evaluate<{ gesamt: number; leer: number; voll: number }>(
    cdp,
    `(function () {
       return {
         gesamt: document.querySelectorAll('#stand-kaesten .kaestchen').length,
         leer: document.querySelectorAll('#stand-kaesten .kaestchen.leer').length,
         voll: document.querySelectorAll('#stand-kaesten .kaestchen.voll').length,
       };
     })()`,
  );
  check(
    'Der Stand steht als Reihe von Kästchen da, nicht als Formular',
    kaesten.gesamt > 0 && kaesten.gesamt === kaesten.leer + kaesten.voll,
    `${kaesten.gesamt} Kästchen, ${kaesten.leer} frei`,
  );

  await evaluate(cdp, `document.querySelector('#stand-kaesten .kaestchen.leer').click()`);
  const warenwahl = await evaluate<{ offen: boolean; waren: number; weizen: boolean }>(
    cdp,
    `(function () {
       var wahl = [...document.querySelectorAll('#stand-fuellen .kaestchen.wahl')];
       return {
         offen: !document.getElementById('stand-fuellen').hidden,
         waren: wahl.length,
         weizen: wahl.some(function (b) { return b.textContent.indexOf('Weizen') >= 0; }),
       };
     })()`,
  );
  check(
    'Ein leeres Kästchen fragt zuerst, welche Ware hinein soll',
    warenwahl.offen && warenwahl.waren > 0 && warenwahl.weizen,
    `${warenwahl.waren} Waren zur Auswahl`,
  );

  await evaluate(
    cdp,
    `[...document.querySelectorAll('#stand-fuellen .kaestchen.wahl')]
       .find(function (b) { return b.textContent.indexOf('Weizen') >= 0; }).click()`,
  );

  const grenze = await evaluate<{ vorschlag: number; max: number; label: string }>(
    cdp,
    `(function () {
       var input = document.querySelector('#stand-fuellen .pick input');
       return {
         vorschlag: Number(input.value),
         max: Number(input.max),
         label: document.querySelector('#stand-fuellen .pick .max').textContent,
       };
     })()`,
  );
  check(
    'Mehr als zehn Stück passen nicht in ein Kästchen',
    grenze.max === 10 && grenze.vorschlag <= 10 && grenze.label === 'max 10',
    `Vorrat ${wheatStock}, Kästchen fasst ${grenze.max} (${grenze.label})`,
  );

  await evaluate(
    cdp,
    `(function () {
       var pick = document.querySelector('#stand-fuellen .pick');
       pick.querySelectorAll('button')[0].click();
       pick.querySelectorAll('button')[0].click();
     })()`,
  );
  const chosen = await evaluate<number>(
    cdp,
    `Number(document.querySelector('#stand-fuellen .pick input').value)`,
  );
  check(
    'Die Menge lässt sich herunterzählen, statt immer alles anzubieten',
    chosen === Math.min(wheatStock, 10) - 2,
    `${grenze.vorschlag} → ${chosen}`,
  );

  const band = await evaluate<{ value: number; max: number; dip: number }>(
    cdp,
    `(function () {
       var priceRow = function () { return document.querySelectorAll('#stand-fuellen .pick')[1]; };
       for (var i = 0; i < 2; i++) priceRow().querySelectorAll('button')[0].click();
       var dip = Number(priceRow().querySelector('input').value);
       for (var j = 0; j < 50; j++) priceRow().querySelectorAll('button')[1].click();
       var after = priceRow().querySelector('input');
       return { value: Number(after.value), max: Number(after.max), dip: dip };
     })()`,
  );
  check(
    'Der Preis lässt sich frei wählen und nicht über den Deckel hinaus',
    band.dip < band.max && band.value === band.max && band.max > 0,
    `runter auf ${band.dip}, hoch bis höchstens ${band.max} → ${band.value}`,
  );

  const schnellpreis = await evaluate<{ knoepfe: number; guenstig: number; hoch: number }>(
    cdp,
    `(function () {
       var wert = function () {
         return Number(document.querySelectorAll('#stand-fuellen .pick')[1].querySelector('input').value);
       };
       var knopf = function (text) {
         return [...document.querySelectorAll('#stand-fuellen .preisknoepfe button')]
           .find(function (b) { return b.textContent === text; });
       };
       var anzahl = document.querySelectorAll('#stand-fuellen .preisknoepfe button').length;
       knopf('günstig').click();
       var tief = wert();
       knopf('Höchstpreis').click();
       return { knoepfe: anzahl, guenstig: tief, hoch: wert() };
     })()`,
  );
  check(
    'Drei Knöpfe setzen den Preis, ohne dass jemand tippen muss',
    schnellpreis.knoepfe === 3 && schnellpreis.guenstig < schnellpreis.hoch,
    `günstig ${schnellpreis.guenstig}, Höchstpreis ${schnellpreis.hoch}`,
  );

  await evaluate(cdp, `document.querySelector('#stand-fuellen .done').click()`);
  await sleep(400);
  const standDanach = await evaluate<{ leftOver: number; voll: number; zurueck: boolean }>(
    cdp,
    `(function () {
       var c = [...document.querySelectorAll('#stock .chip')].find(function (x) {
         return x.textContent.indexOf('Weizen') === 0;
       });
       return {
         leftOver: c ? Number(c.querySelector('.n').textContent) : -1,
         voll: document.querySelectorAll('#stand-kaesten .kaestchen.voll').length,
         zurueck: document.getElementById('stand-fuellen').hidden,
       };
     })()`,
  );
  check(
    'Hingestellt wird genau die gewählte Menge — der Rest bleibt liegen',
    standDanach.leftOver === wheatStock - chosen &&
      standDanach.voll === kaesten.voll + 1 &&
      standDanach.zurueck,
    `${wheatStock} → ${standDanach.leftOver} Weizen, ${kaesten.voll} → ${standDanach.voll} belegte Kästchen`,
  );

  const zurueckgeholt = await evaluate<number>(
    cdp,
    `(function () {
       document.querySelector('#stand-kaesten .kaestchen.voll').click();
       return document.querySelectorAll('#stand-kaesten .kaestchen.voll').length;
     })()`,
  );
  check(
    'Ein volles Kästchen holt die Ware mit einem Tipp zurück',
    zurueckgeholt === standDanach.voll - 1,
    `${standDanach.voll} → ${zurueckgeholt} belegt`,
  );

  // Werkzeug verkaufen, gesperrte Ware nur ausgegraut
  await api(`/api/admin/grant?account=${status.accountId}&item=saw&amount=2`, 'POST');
  await api(`/api/admin/grant?account=${status.accountId}&item=cheese&amount=3`, 'POST');
  await sleep(500);
  await evaluate(cdp, `document.getElementById('lagerhaus').click()`);
  await waitFor(cdp, `document.querySelectorAll('#mail .card').length > 0`, 'Werkzeug im Postfach');
  for (let i = 0; i < 4; i++) {
    const c = await evaluate<boolean>(cdp, `!!document.querySelector('#mail .card')`);
    if (!c) break;
    await evaluate(cdp, `document.querySelector('#mail .card').click()`);
    await sleep(300);
  }
  await evaluate(cdp, `document.getElementById('lager-close').click()`);
  await sleep(200);

  const werkzeugStand = await evaluate<{ saege: boolean; kaeseGesperrt: boolean; kaeseText: string }>(
    cdp,
    `(function () {
       document.getElementById('stand').click();
       var frei = document.querySelector('#stand-kaesten .kaestchen.leer');
       frei.click();
       var wahl = [...document.querySelectorAll('#stand-fuellen .kaestchen.wahl')];
       var saege = wahl.find(function (b) { return b.textContent.indexOf('Säge') >= 0; });
       var kaese = wahl.find(function (b) { return b.textContent.indexOf('Käse') >= 0; });
       return {
         saege: !!saege && !saege.disabled,
         kaeseGesperrt: !!kaese && kaese.classList.contains('gesperrt') && kaese.disabled,
         kaeseText: kaese ? kaese.textContent : 'kein Käse',
       };
     })()`,
  );
  check(
    'Werkzeug wie die Säge lässt sich anbieten',
    werkzeugStand.saege,
    `Säge wählbar: ${werkzeugStand.saege}`,
  );
  check(
    'Was die Stufe noch nicht hergibt, steht nur ausgegraut und gesperrt da',
    werkzeugStand.kaeseGesperrt && /ab Stufe/.test(werkzeugStand.kaeseText),
    werkzeugStand.kaeseText,
  );
  await evaluate(cdp, `document.querySelector('#stand-fuellen .zurueck').click()`);
  await evaluate(cdp, `document.getElementById('stand-close').click()`);
  await sleep(200);

  // Das rechte Zweidrittel: überwuchert, gesperrt, in sechs Feldern
  const sperren = await evaluate<{ anzahl: number; text: string }>(
    cdp,
    `(function () {
       var s = [...document.querySelectorAll('#erweiterungen .feld-sperre')];
       return { anzahl: s.length, text: s.map(function (x) { return x.textContent; }).join(' | ') };
     })()`,
  );
  check(
    'Das rechte Zweidrittel liegt in sechs gesperrten Feldern',
    sperren.anzahl === 6,
    `${sperren.anzahl} Felder`,
  );
  check(
    'Ein gesperrtes Feld zeigt seine Stufe',
    /ab Stufe/.test(sperren.text),
    sperren.text.slice(0, 60),
  );

  const sperrSheet = await evaluate<{ auf: boolean; text: string; gesperrt: boolean }>(
    cdp,
    `(function () {
       document.querySelector('#erweiterungen .feld-sperre').click();
       var auf = !document.getElementById('erweiterung-bg').hidden;
       var box = document.getElementById('erweiterung-inhalt');
       var knopf = box.querySelector('.primär');
       return { auf: auf, text: box.textContent, gesperrt: !!knopf && knopf.disabled };
     })()`,
  );
  check(
    'Antippen öffnet das Freischalt-Fenster mit Landkarte, Bauhammer und Steckpfahl',
    sperrSheet.auf &&
      /Landkarte/.test(sperrSheet.text) &&
      /Bauhammer/.test(sperrSheet.text) &&
      /Steckpfahl/.test(sperrSheet.text),
    sperrSheet.text.slice(0, 80),
  );
  check('Solange die Stufe fehlt, ist der Freischalt-Knopf gesperrt', sperrSheet.gesperrt);
  await evaluate(cdp, `document.getElementById('erweiterung-close').click()`);
  await sleep(150);

  const seqBeforeTap = ((await api(`/api/admin/status?account=${status.accountId}`)) as { seq: number })
    .seq;
  const tapped = Date.now();
  const planted = await plantSomething(cdp);
  check('Der Rezeptwähler lässt eine Frucht auswählen', planted);
  let arrived = -1;
  for (let i = 0; i < 120; i++) {
    const now = ((await api(`/api/admin/status?account=${status.accountId}`)) as { seq: number }).seq;
    if (now > seqBeforeTap) {
      arrived = Date.now() - tapped;
      break;
    }
    await sleep(50);
  }
  check(
    'Eine Aktion ist in unter zwei Sekunden beim Server — nicht erst im nächsten Takt',
    arrived >= 0 && arrived < 2000,
    arrived < 0 ? 'gar nicht angekommen' : `${arrived} ms`,
  );

  await evaluate(cdp, `document.getElementById('lagerhaus').click()`);
  const frachtText = `[...document.querySelectorAll('#requests .zettel')]
       .map(function (z) { return z.dataset.zettel; }).join(',')`;
  const vorherFracht = await evaluate<string>(cdp, frachtText);
  const skipLabel = await evaluate<string>(cdp, `document.querySelector('#requests .skip').textContent`);
  await evaluate(cdp, `document.querySelector('#requests .skip').click()`);
  await sleep(400);
  const afterSkip = await evaluate<{ fracht: string; label: string; disabled: boolean }>(
    cdp,
    `(function () {
       var s = document.querySelector('#requests .skip');
       return {
         fracht: ${frachtText},
         label: s ? s.textContent : '',
         disabled: s ? s.disabled : false,
       };
     })()`,
  );
  check(
    'Ein Zettel lässt sich tauschen — es kommt ein anderer',
    skipLabel === 'Tauschen' && afterSkip.fracht !== vorherFracht,
    `${vorherFracht} → ${afterSkip.fracht}`,
  );
  check(
    'Danach ist der Knopf gesperrt und sagt, wie lange noch',
    afterSkip.disabled && /in \d/.test(afterSkip.label),
    afterSkip.label,
  );

  console.log('\n9. Neustart des Servers, während jemand spielt');

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

  check('SIGTERM beendet den Server zügig', stopMs < 3000, `${stopMs} ms`);

  const beforeQueue = (await savedState()).queue;
  await evaluate(cdp, plantAll);
  await sleep(200);
  await evaluate(cdp, harvestAll);
  await sleep(300);
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

  let streamsBack = 0;
  for (let i = 0; i < 60 && streamsBack === 0; i++) {
    await sleep(250);
    streamsBack = ((await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()) as {
      streams: number;
    }).streams;
  }
  check('Die Live-Leitung kommt von allein zurück', streamsBack >= 1, `${streamsBack} offen`);


  console.log('\n9b. Ein leerer Stall, Küken einzeln dazu');

  const farmTab = `document.getElementById('brett-close') && (document.getElementById('brett-bg').hidden = true, document.getElementById('lager-bg').hidden = true, document.getElementById('stand-bg').hidden = true)`;
  const ordersTab = `document.getElementById('lagerhaus').click()`;

  await api(`/api/admin/grant?account=${status.accountId}&item=gold&amount=6000`, 'POST');
  await evaluate(cdp, ordersTab);
  try {
    await waitFor(cdp, `document.querySelectorAll('#mail .card').length > 0`, 'Post da', 20_000);
  } catch (e) {
    console.error(
      '  Diagnose Post:',
      await evaluate<string>(
        cdp,
        `JSON.stringify({
           mail: document.getElementById('mail').innerHTML.slice(0, 200),
           sichtbar: !document.getElementById('view-orders').hidden,
           gold: document.getElementById('gold').textContent,
         })`,
      ).catch((x) => String(x)),
      '| Server:',
      JSON.stringify(await api(`/api/admin/status?account=${status.accountId}`)).slice(0, 400),
    );
    throw e;
  }
  await evaluate(cdp, `document.querySelector('#mail .card').click()`);
  await sleep(300);

  const levelNow = async () =>
    Number(await evaluate<string>(cdp, `document.getElementById('lvl').textContent`));

  await evaluate(cdp, farmTab);
  for (let round = 0; round < 30 && (await levelNow()) < 3; round++) {
    await evaluate<number>(cdp, plantAll);
    await sleep(150);
    await api(`/api/admin/time?account=${status.accountId}&seconds=600`, 'POST');
    await sleep(400);
    await evaluate<number>(cdp, harvestAll);
    await sleep(250);
  }
  check('Mit Weizen allein kommt man auf Stufe 3', (await levelNow()) >= 3, `Stufe ${await levelNow()}`);

  const feier = await evaluate<{ da: boolean; zahl: string; neu: string }>(
    cdp,
    `(function () {
       var f = document.getElementById('stufe-feier');
       return {
         da: !f.hidden,
         zahl: document.getElementById('stufe-zahl').textContent,
         neu: document.getElementById('stufe-neu').textContent.slice(0, 80),
       };
     })()`,
  );
  check(
    'Ein Stufenaufstieg feiert sich — mit der neuen Stufe und was sie bringt',
    feier.da && Number(feier.zahl) >= 2 && feier.neu.length > 0,
    JSON.stringify(feier),
  );
  check(
    'Die Feier nennt, was neu freigeschaltet ist',
    /Feld|Mühle|Hühnerstall|Kuhweide|Molkerei/.test(feier.neu),
    feier.neu,
  );
  await evaluate(cdp, `document.getElementById('stufe-weiter').click()`);
  await sleep(200);
  check(
    'Weiter schließt die Feier',
    await evaluate<boolean>(cdp, `document.getElementById('stufe-feier').hidden`),
  );

  const pfad = await evaluate<{
    offen: boolean;
    steine: number;
    jetzt: string;
    hatBalken: boolean;
    fehlt: boolean;
    freischalt: string;
  }>(
    cdp,
    `(function () {
       document.getElementById('pfad-auf').click();
       var steine = [...document.querySelectorAll('#pfad-liste .stein')];
       var jetzt = document.querySelector('#pfad-liste .stein.jetzt');
       var mitGabe = steine.filter(function (s) { return s.querySelector('.gabe'); });
       return {
         offen: !document.getElementById('pfad-bg').hidden,
         steine: steine.length,
         jetzt: jetzt ? jetzt.querySelector('.knoten').textContent : 'keiner',
         hatBalken: !!document.querySelector('#pfad-kopf .balken i'),
         fehlt: /noch [0-9]+ XP/.test(document.getElementById('pfad-kopf').textContent),
         freischalt: mitGabe.map(function (s) {
           return s.querySelector('.knoten').textContent + ':' +
             [...s.querySelectorAll('.gabe span:last-child')].map(function (g) { return g.textContent; }).join('+');
         }).slice(0, 6).join(' | '),
       };
     })()`,
  );
  check(
    'Ein Tipp auf die Stufenleiste öffnet den Pfad mit einem Stein je Stufe',
    pfad.offen && pfad.steine >= 8 && pfad.jetzt === '3',
    `${pfad.steine} Steine, hier bei ${pfad.jetzt}`,
  );
  check(
    'Der Pfad zeigt, was jede Stufe freischaltet',
    /Feld|Hühnerstall|Kuhweide|Molkerei|Butter|Käse/.test(pfad.freischalt),
    pfad.freischalt,
  );
  check(
    'Der Kopf zeigt den Fortschritt: Balken und wie viel XP noch fehlt',
    pfad.hatBalken && pfad.fehlt,
    `Balken ${pfad.hatBalken}, Rest-XP ${pfad.fehlt}`,
  );
  await evaluate(cdp, `document.getElementById('pfad-close').click()`);
  await sleep(150);

  await baueUndStelle(cdp, 'Mühle');
  await sleep(300);
  await baueUndStelle(cdp, 'Hühnerstall');
  await sleep(300);

  const stallTile = `[...document.querySelectorAll('#plots .plot')].find(function (t) {
       return t.querySelector('.name').textContent.indexOf('Hühnerstall') === 0;
     })`;

  const leerStatus = await evaluate<string>(
    cdp,
    `(function () { var t = ${stallTile}; return t ? t.querySelector('.status').textContent : 'weg'; })()`,
  );
  check(
    'Ein frisch gebauter Stall steht leer da und sagt, was fehlt',
    /leer/.test(leerStatus) && /Küken/.test(leerStatus),
    leerStatus,
  );

  await evaluate(cdp, `${stallTile}.click()`);
  await sleep(250);

  const leereRegale = await evaluate<{ titel: string; plaetze: number; leer: number }>(
    cdp,
    `(function () {
       var zeilen = [...document.querySelectorAll('#pick-list .tierplatz')];
       return {
         titel: document.getElementById('pick-title').textContent,
         plaetze: zeilen.length,
         leer: zeilen.filter(function (z) { return z.dataset.tier === 'none'; }).length,
       };
     })()`,
  );
  check(
    'Das Stall-GUI zeigt jeden Platz einzeln — alle noch leer',
    leereRegale.plaetze === 3 && leereRegale.leer === 3 && /0 von 3/.test(leereRegale.titel),
    `${leereRegale.leer}/${leereRegale.plaetze} leer, Titel „${leereRegale.titel}"`,
  );

  const kaufeKueken = `(function () {
       var frei = [...document.querySelectorAll('#pick-list .tierplatz')]
         .find(function (z) { return z.dataset.tier === 'none' && !z.disabled; });
       if (!frei) return 'kein freier Platz';
       frei.click();
       return 'gekauft';
     })()`;

  const goldVorKueken = Number(
    await evaluate<string>(cdp, `document.getElementById('gold').textContent`),
  );
  await evaluate<string>(cdp, kaufeKueken);
  await sleep(250);
  await evaluate<string>(cdp, kaufeKueken);
  await sleep(250);

  const nachKauf = await evaluate<{ jung: number; leer: number; gold: number; titel: string }>(
    cdp,
    `(function () {
       var zeilen = [...document.querySelectorAll('#pick-list .tierplatz')];
       return {
         jung: zeilen.filter(function (z) { return z.dataset.tier === 'young'; }).length,
         leer: zeilen.filter(function (z) { return z.dataset.tier === 'none'; }).length,
         gold: Number(document.getElementById('gold').textContent),
         titel: document.getElementById('pick-title').textContent,
       };
     })()`,
  );
  check(
    'Küken kauft man einzeln in den Stall — jedes kostet Gold',
    nachKauf.jung === 2 && nachKauf.leer === 1 && nachKauf.gold === goldVorKueken - 500,
    `${nachKauf.jung} Küken, ${nachKauf.leer} frei, ${goldVorKueken} → ${nachKauf.gold} Gold`,
  );
  check(
    'Über dem Stall steht, wie voll er ist',
    /2 von 3/.test(nachKauf.titel),
    nachKauf.titel,
  );

  await api(`/api/admin/time?account=${status.accountId}&seconds=600`, 'POST');
  try {
    await waitFor(
      cdp,
      `[...document.querySelectorAll('#pick-list .tierplatz')]
         .filter(function (z) { return z.dataset.tier === 'grown'; }).length === 2`,
      'Küken erwachsen',
      15_000,
    );
  } catch {
  }
  const erwachsen = await evaluate<{ gross: number; namen: string }>(
    cdp,
    `(function () {
       var zeilen = [...document.querySelectorAll('#pick-list .tierplatz')];
       return {
         gross: zeilen.filter(function (z) { return z.dataset.tier === 'grown'; }).length,
         namen: zeilen.map(function (z) { return z.querySelector('.top').textContent; }).join(', '),
       };
     })()`,
  );
  check(
    'Aus Küken werden Hühner — der leere Platz bleibt leer',
    erwachsen.gross === 2 && /Huhn 1/.test(erwachsen.namen) && /Leerer Platz/.test(erwachsen.namen),
    erwachsen.namen,
  );

  await evaluate(cdp, `document.getElementById('pick-close').click()`);
  await sleep(200);
  await evaluate(
    cdp,
    `(function () {
       var tile = [...document.querySelectorAll('#plots .plot')].find(function (t) {
         return t.querySelector('.name').textContent.indexOf('Mühle') === 0;
       });
       tile.click();
       var opt = [...document.querySelectorAll('#pick-list .opt')].find(function (o) {
         return o.textContent.indexOf('Hühnerfutter') >= 0 && !o.disabled;
       });
       if (opt) opt.click(); else document.getElementById('pick-close').click();
     })()`,
  );
  await api(`/api/admin/time?account=${status.accountId}&seconds=600`, 'POST');
  await sleep(500);
  await evaluate(
    cdp,
    `(function () {
       var tile = [...document.querySelectorAll('#plots .plot')].find(function (t) {
         return t.querySelector('.name').textContent.indexOf('Mühle') === 0;
       });
       if (tile.querySelector('.status').textContent.indexOf('fertig') === 0) tile.click();
     })()`,
  );
  await sleep(300);

  await evaluate(cdp, `${stallTile}.click()`);
  await sleep(250);

  const stallRows = await evaluate<string>(
    cdp,
    `(function () {
       if (document.getElementById('pick-bg').hidden) return 'zu';
       return JSON.stringify({
         titel: document.getElementById('pick-title').textContent,
         zeilen: [...document.querySelectorAll('#pick-list .opt')].map(function (o) {
           return o.querySelector('.top').textContent;
         }),
       });
     })()`,
  );
  check(
    'Ein Tipp auf den Stall öffnet ein GUI mit einer Zeile pro Tier',
    /Huhn 1/.test(stallRows) && /Huhn 2/.test(stallRows),
    stallRows,
  );

  await evaluate(
    cdp,
    `(function () {
       var row = [...document.querySelectorAll('#pick-list .opt')].find(function (o) {
         return o.querySelector('.top').textContent === 'Huhn 1' && !o.disabled;
       });
       if (row) row.click();
     })()`,
  );
  await sleep(400);

  const einzeln = await evaluate<string>(
    cdp,
    `(function () {
       return JSON.stringify([...document.querySelectorAll('#pick-list .opt')].map(function (o) {
         return o.querySelector('.top').textContent + ': ' + o.querySelector('.sub').textContent;
       }));
     })()`,
  );
  check(
    'Nur das gefütterte Tier läuft — das andere bleibt hungrig',
    /Huhn 1: noch/.test(einzeln) && !/Huhn 2: noch/.test(einzeln),
    einzeln,
  );

  await api(`/api/admin/time?account=${status.accountId}&seconds=600`, 'POST');
  const huhnEins = `(function () {
       var row = [...document.querySelectorAll('#pick-list .opt')].find(function (o) {
         return o.querySelector('.top').textContent === 'Huhn 1';
       });
       return row ? row.querySelector('.sub').textContent : 'weg';
     })()`;
  try {
    await waitFor(cdp, `/fertig/.test(${huhnEins})`, 'Huhn 1 fertig', 15_000);
  } catch {
  }
  const geerntet = await evaluate<string>(cdp, huhnEins);
  check('Jedes Tier wird einzeln fertig und einzeln abgeerntet', /fertig/.test(geerntet), geerntet);

  await evaluate(cdp, `document.getElementById('pick-close').click()`);
  await sleep(200);


  console.log('\n9c. Ein Zettel vom Brett, der Wagen fährt los');

  await evaluate(cdp, farmTab);
  await sleep(300);

  check(
    'Wagen, Brett, Lager und Stand stehen auf dem Hof',
    await evaluate<boolean>(
      cdp,
      `!document.getElementById('wagen').hidden
         && !!document.getElementById('brett')
         && !!document.getElementById('lagerhaus')
         && !!document.getElementById('stand')`,
    ),
  );

  const brettJetzt = (await api(`/api/admin/status?account=${status.accountId}`)) as {
    itemIds: string[];
    state: { requests: Array<{ wants: Array<{ item: number; amount: number }> }> };
  };
  const zettel = brettJetzt.state.requests[0]!;
  for (const posten of zettel.wants) {
    await api(
      `/api/admin/grant?account=${status.accountId}` +
        `&item=${brettJetzt.itemIds[posten.item]}&amount=${posten.amount}`,
      'POST',
    );
  }
  await sleep(800);
  await evaluate(cdp, `document.getElementById('lagerhaus').click()`);
  await waitFor(cdp, `document.querySelectorAll('#mail .card').length > 0`, 'Ware im Postfach');
  await evaluate(cdp, `document.querySelector('#mail .card').click()`);
  await sleep(500);
  await evaluate(cdp, `document.getElementById('lager-close').click()`);
  await sleep(300);

  const bereit = await evaluate<string>(
    cdp,
    `(function () {
       document.getElementById('brett').click();
       var karten = [...document.querySelectorAll('#requests .zettel')];
       var los = karten.map(function (k) { return k.querySelector('.abfahrt'); })
         .filter(function (b) { return b && !b.disabled && b.textContent === 'Abschicken'; });
       return karten.length + '/' + los.length;
     })()`,
  );
  check(
    'Am Brett hängen vier Zettel, einer davon ist lieferbar',
    /^4\/[1-9]/.test(bereit),
    bereit,
  );

  const goldVorher = await evaluate<number>(
    cdp,
    `Number(document.getElementById('gold').textContent)`,
  );
  await evaluate(
    cdp,
    `(function () {
       var b = [...document.querySelectorAll('#requests .abfahrt')].find(function (x) {
         return !x.disabled && x.textContent === 'Abschicken';
       });
       if (b) b.click();
     })()`,
  );
  await sleep(700);

  const nachAbfahrt = await evaluate<{ gold: number; unterwegs: boolean; zettel: number }>(
    cdp,
    `(function () {
       var w = document.getElementById('wagen');
       return {
         gold: Number(document.getElementById('gold').textContent),
         unterwegs: w.className.indexOf('unterwegs') >= 0,
         zettel: document.querySelectorAll('#requests .zettel').length,
       };
     })()`,
  );
  check(
    'Abgeschickt: Lohn sofort, Wagen sichtbar unterwegs, Zettel nachgerückt',
    nachAbfahrt.gold > goldVorher && nachAbfahrt.unterwegs && nachAbfahrt.zettel === 4,
    `${goldVorher} → ${nachAbfahrt.gold} Gold, unterwegs ${nachAbfahrt.unterwegs}, ` +
      `${nachAbfahrt.zettel} Zettel`,
  );

  const gesperrt = await evaluate<boolean>(
    cdp,
    `[...document.querySelectorAll('#requests .abfahrt')].every(function (b) {
       return b.disabled || b.textContent !== 'Abschicken';
     })`,
  );
  check('Solange er fährt, geht kein zweiter Zettel raus', gesperrt);

  try {
    await waitFor(
      cdp,
      `document.getElementById('wagen').className.indexOf('unterwegs') < 0`,
      'Wagen zurück',
      20_000,
    );
  } catch {
  }
  check(
    'Nach der Fahrt steht er wieder da',
    await evaluate<boolean>(
      cdp,
      `document.getElementById('wagen').className.indexOf('unterwegs') < 0`,
    ),
  );

  await evaluate(cdp, `document.getElementById('brett-close').click()`);
  await sleep(200);


  console.log('\n9d. Schatzkisten und der Lagerausbau');

  const kistenStand = (await api(`/api/admin/status?account=${status.accountId}`)) as {
    state: { chests: Array<{ id: number; gx: number }>; tick: number; chestReadyAt: number };
  };
  check(
    'Es liegt genau eine Kiste da, die nächste wartet unsichtbar',
    kistenStand.state.chests.length === 2,
    `${kistenStand.state.chests.length} Kisten im Vorrat`,
  );

  try {
    await waitFor(
      cdp,
      `document.querySelectorAll('#kisten .schatz').length > 0`,
      'Kiste steht da',
      20_000,
    );
  } catch {
  }
  const kistenAufDemRaster = await evaluate<{ aufRaster: number; ecke: boolean }>(
    cdp,
    `(function () {
       return {
         aufRaster: document.querySelectorAll('#kisten .schatz').length,
         ecke: !document.getElementById('kiste').hidden,
       };
     })()`,
  );
  check(
    'Wenn ihre Zeit da ist, steht die Kiste irgendwo auf dem Raster',
    kistenAufDemRaster.aufRaster > 0,
    `${kistenAufDemRaster.aufRaster} auf dem Raster, Ecke ${kistenAufDemRaster.ecke}`,
  );

  const vorKiste = (await api(`/api/admin/status?account=${status.accountId}`)) as {
    state: { items: number[]; mail: unknown[] };
  };
  await evaluate(cdp, `document.querySelector('#kisten .schatz').click()`);
  await sleep(1500);

  const nachKiste = (await api(`/api/admin/status?account=${status.accountId}`)) as {
    state: { items: number[]; mail: Array<{ item: number; amount: number }>; pendingBoxes: number[] };
  };
  check(
    'Geöffnet wird sie beim Server — die Beute kommt ins Postfach',
    nachKiste.state.mail.length > vorKiste.state.mail.length &&
      nachKiste.state.pendingBoxes.length === 0,
    `Postfach ${vorKiste.state.mail.length} → ${nachKiste.state.mail.length}`,
  );

  const nachDemOeffnen = await evaluate<number>(
    cdp,
    `document.querySelectorAll('#kisten .schatz').length`,
  );
  check(
    'Danach ist keine Kiste mehr da — die nächste braucht ihre Zeit',
    nachDemOeffnen === 0,
    `${nachDemOeffnen} sichtbar`,
  );

  await api(`/api/admin/time?account=${status.accountId}&seconds=90`, 'POST');
  let wiederDa = 0;
  for (let i = 0; i < 40 && wiederDa === 0; i++) {
    await sleep(250);
    wiederDa = await evaluate<number>(cdp, `document.querySelectorAll('#kisten .schatz').length`);
  }
  check(
    'Nach der Wartezeit liegt genau eine neue da',
    wiederDa === 1,
    `${wiederDa} Kisten`,
  );

  await evaluate(cdp, `document.getElementById('lagerhaus').click()`);
  await sleep(400);
  await evaluate(cdp, `var c = document.querySelector('#mail .card'); if (c) c.click()`);
  await sleep(500);

  const ausbau = await evaluate<string>(
    cdp,
    `(function () {
       var k = document.querySelector('#ausbau .card');
       return k ? k.textContent : 'kein Ausbau';
     })()`,
  );
  check(
    'Im Lager steht, was der nächste Ausbau kostet',
    /Erweiterung/.test(ausbau) && /Bretter|Nägel/.test(ausbau),
    ausbau.slice(0, 90),
  );

  const platzVorher = await evaluate<string>(cdp, `document.getElementById('silo-num').textContent`);
  for (const zutat of ['plank', 'nail']) {
    await api(`/api/admin/grant?account=${status.accountId}&item=${zutat}&amount=30`, 'POST');
  }
  await api(`/api/admin/grant?account=${status.accountId}&item=gold&amount=600`, 'POST');
  await sleep(1200);
  await waitFor(cdp, `document.querySelectorAll('#mail .card').length > 0`, 'Material im Postfach');
  await evaluate(cdp, `document.querySelector('#mail .card').click()`);
  await sleep(600);

  await evaluate(
    cdp,
    `(function () {
       var k = document.querySelector('#ausbau .card');
       if (k && !k.disabled) k.click();
     })()`,
  );
  await sleep(700);
  const platzNachher = await evaluate<string>(cdp, `document.getElementById('silo-num').textContent`);
  check(
    'Mit Material wächst das Lager',
    Number(platzNachher.split('/')[1]) > Number(platzVorher.split('/')[1]),
    `${platzVorher} → ${platzNachher}`,
  );

  await evaluate(cdp, `document.getElementById('lager-close').click()`);
  await sleep(200);


  console.log('\n9e. Leergespielt — der Weg zurück steht am Feld, nicht im Lager');

  await evaluate(cdp, farmTab);
  await sleep(300);
  await evaluate(cdp, harvestAll);
  await sleep(400);

  const ausraeumen = `(function (name) {
       document.getElementById('stand').click();
       var zurueck = document.querySelector('#stand-fuellen .zurueck');
       if (zurueck && !document.getElementById('stand-fuellen').hidden) zurueck.click();
       for (var k = 0; k < 12; k++) {
         var kasse = document.querySelector('#stand-kaesten .kaestchen.verkauft');
         if (!kasse) break;
         kasse.click();
       }
       var frei = document.querySelector('#stand-kaesten .kaestchen.leer');
       if (!frei) return 'kein Kästchen frei';
       frei.click();
       var wahl = [...document.querySelectorAll('#stand-fuellen .kaestchen.wahl')]
         .find(function (x) { return x.textContent.indexOf(name) >= 0; });
       if (!wahl) return 'nichts mehr da';
       wahl.click();
       var go = document.querySelector('#stand-fuellen .done');
       if (!go || go.disabled) return 'gesperrt';
       go.click();
       return 'hingestellt';
     })`;

  await api(`/api/admin/grant?account=${second.accountId}&item=gold&amount=100000`, 'POST');

  const zweiterKauftAlles = async (): Promise<number> => {
    let gekauft = 0;
    for (let versuch = 0; versuch < 8; versuch++) {
      const drin = await stateAs(second.key);
      const shelf = (drin.snapshot.state as { offers?: { id: number }[] }).offers ?? [];
      if (shelf.length === 0) break;
      const commands = shelf.map((o, i) => ({
        seq: drin.snapshot.seq + 1 + i,
        tick: 0,
        type: 'BUY_OFFER' as const,
        offerId: o.id,
      }));
      const res = await syncAs(second.key, drin.snapshot.seq, commands);
      if (!res.ok) break;
      gekauft += commands.length;
      await syncAs(second.key, res.snapshot.seq, [
        { seq: res.snapshot.seq + 1, tick: 0, type: 'COLLECT_MAIL' },
      ]);
    }
    return gekauft;
  };

  for (let runde = 0; runde < 8; runde++) {
    let hingestellt = 0;
    for (const ware of ['Mais', 'Weizen']) {
      for (let i = 0; i < 8; i++) {
        const wie = await evaluate<string>(cdp, `${ausraeumen}(${JSON.stringify(ware)})`);
        await sleep(200);
        if (wie !== 'hingestellt') break;
        hingestellt++;
      }
    }
    if (hingestellt === 0) break;

    await evaluate(cdp, `document.getElementById('stand-close').click()`);
    await sleep(1400);
    await zweiterKauftAlles();
    await sleep(1400);
  }
  await evaluate(cdp, `document.getElementById('stand-close').click()`);
  await sleep(400);

  const imLager = await evaluate<string>(
    cdp,
    `(function () {
       document.getElementById('lagerhaus').click();
       var hat = {
         nachschub: !!document.getElementById('buy'),
         abmelden: !!document.getElementById('lager-bg').querySelector('#forget'),
         vorraete: document.querySelectorAll('#stock .chip').length > 0,
         ausbau: !!document.querySelector('#ausbau .card'),
       };
       document.getElementById('lager-close').click();
       return JSON.stringify(hat);
     })()`,
  );
  check(
    'Im Lager steht nur noch Lager',
    imLager === '{"nachschub":false,"abmelden":false,"vorraete":true,"ausbau":true}',
    imLager,
  );

  const hinterZahnrad = await evaluate<string>(
    cdp,
    `(function () {
       document.getElementById('zahnrad').click();
       var offen = document.getElementById('rest-bg').hidden === false;
       var abmelden = !!document.getElementById('rest-bg').querySelector('#forget');
       document.getElementById('rest-close').click();
       return offen + '/' + abmelden;
     })()`,
  );
  check('Der Rest sitzt hinterm Zahnrad', hinterZahnrad === 'true/true', hinterZahnrad);

  const tonSchalter = await evaluate<string>(
    cdp,
    `(function () {
       document.getElementById('zahnrad').click();
       var stand = function () { return document.getElementById('tonstand').textContent; };
       var vorher = stand();
       document.getElementById('tonknopf').click();
       var danach = stand();
       var gemerkt = localStorage.getItem('ns-ton');
       document.getElementById('tonknopf').click();
       document.getElementById('rest-close').click();
       return vorher + '/' + danach + '/' + gemerkt + '/' + stand();
     })()`,
  );
  check(
    'Töne lassen sich abschalten, und das Gerät merkt es sich',
    tonSchalter === 'an/aus/aus/an',
    tonSchalter,
  );

  const leeresFeld = await evaluate<string>(
    cdp,
    `(function () {
       var t = [...document.querySelectorAll('#plots .plot')].find(function (x) {
         return /Zutaten/.test(x.querySelector('.status').textContent)
           && /^Feld /.test(x.querySelector('.name').textContent);
       });
       if (!t) return 'kein leeres Feld';
       t.click();
       var zeilen = [...document.querySelectorAll('#pick-list .nachkauf')];
       return zeilen.length + ':' + (zeilen[0] ? zeilen[0].textContent.slice(0, 40) : '') +
         ' (' + document.getElementById('pick-title').textContent + ')';
     })()`,
  );
  check(
    'Ist die Saat aus, steht der Nachkauf im Anpflanz-Menü',
    /^[1-9]/.test(leeresFeld) && /ausgegangen/.test(leeresFeld),
    leeresFeld,
  );

  const nachDemKauf = await evaluate<string>(
    cdp,
    `(function () {
       var k = document.querySelector('#pick-list .nachkauf .kaufen');
       if (!k) return 'kein Kaufknopf';
       if (k.disabled) return 'Kaufknopf gesperrt: ' + k.textContent;
       k.click();

       var zeilen = document.querySelectorAll('#pick-list .nachkauf').length;
       var startbar = [...document.querySelectorAll('#pick-list .opt')].filter(function (o) {
         return !o.disabled;
       }).length;
       var titel = document.getElementById('pick-title').textContent;
       document.getElementById('pick-close').click();
       return zeilen + '/' + startbar + ' (' + titel + ')';
     })()`,
  );
  check(
    'Ein Korn reicht: der Hinweis geht weg, das Rezept wird startbar',
    /^1\/1 /.test(nachDemKauf),
    nachDemKauf,
  );


  console.log('\n9f. Bauen und frei hinstellen');

  await evaluate(cdp, farmTab);
  await sleep(300);

  const startbild = await evaluate<{ plots: number; raster: boolean }>(
    cdp,
    `(function () {
       return {
         plots: document.querySelectorAll('#plots .plot').length,
         raster: !!document.getElementById('scene').innerHTML.match(/acker/),
       };
     })()`,
  );
  check(
    'Auf dem Hof steht nur, was schon gebaut ist',
    startbild.raster && startbild.plots > 0 && startbild.plots < 11,
    `${startbild.plots} Gebäude auf dem Raster`,
  );

  const gebautVorher = startbild.plots;
  await evaluate(cdp, `document.getElementById('bauen').click()`);
  await sleep(400);

  const gekauft = await evaluate<string>(
    cdp,
    `(function () {
       var k = [...document.querySelectorAll('#bauliste .card')].find(function (c) {
         return !c.disabled;
       });
       if (!k) return 'nichts bezahlbar';
       var name = k.querySelector('.top').textContent;
       k.click();
       return name;
     })()`,
  );
  await sleep(600);

  const imSetzen = await evaluate<{ banner: boolean; text: string }>(
    cdp,
    `(function () {
       return {
         banner: !document.getElementById('setzen').hidden,
         text: document.getElementById('setzen-text').textContent,
       };
     })()`,
  );
  check(
    'Nach dem Kauf fragt der Hof, wohin',
    imSetzen.banner && /wohin/.test(imSetzen.text),
    `${gekauft} → ${imSetzen.text}`,
  );

  await tippeBisGesetzt(cdp);
  await sleep(500);

  const nachSetzen = await evaluate<{ plots: number; banner: boolean }>(
    cdp,
    `(function () {
       return {
         plots: document.querySelectorAll('#plots .plot').length,
         banner: !document.getElementById('setzen').hidden,
       };
     })()`,
  );
  check(
    'Ein Tipp aufs Raster setzt das Gebäude hin',
    nachSetzen.plots === gebautVorher + 1 && !nachSetzen.banner,
    `${gebautVorher} → ${nachSetzen.plots} Gebäude`,
  );

  const hindernisse = await evaluate<string>(
    cdp,
    `(function () {
       var arten = [...document.querySelectorAll('#hindernisse .hindernis')]
         .map(function (h) { return h.getAttribute('aria-label'); });
       return [...new Set(arten)].sort().join('+');
     })()`,
  );
  check(
    'Bäume, Steine und ein Tümpel stehen auf dem Raster',
    hindernisse === 'Baum+Stein+Tümpel',
    hindernisse || 'keine Hindernisse gezeichnet',
  );

  const serverWeiss = (await api(`/api/admin/status?account=${status.accountId}`)) as {
    state: { plots: Array<{ gx: number; gy: number; level: number }> };
  };
  check(
    'Der Server kennt die Stelle — sie ist Spielzustand, keine Ansichtssache',
    serverWeiss.state.plots.filter((p) => p.gx >= 0).length === nachSetzen.plots,
    `${serverWeiss.state.plots.filter((p) => p.gx >= 0).length} platziert beim Server`,
  );

  const schiebeStart = await evaluate<string>(
    cdp,
    `(function () {
       var t = [...document.querySelectorAll('#plots .plot')].find(function (x) {
         return /^Feld 1/.test(x.querySelector('.name').textContent);
       });
       if (!t) return 'kein Feld 1';
       t.click();
       return 'auf';
     })()`,
  );
  await sleep(400);
  const konnteSchieben = await evaluate<string>(
    cdp,
    `(function () {
       var k = [...document.querySelectorAll('#pick-list button')].find(function (b) {
         return b.textContent === 'Verschieben';
       });
       if (!k) return 'kein Knopf';
       k.click();
       return 'geklickt';
     })()`,
  );
  await sleep(300);
  const imSetzmodus = await evaluate<boolean>(
    cdp,
    `!document.getElementById('setzen').hidden
       && document.getElementById('pick-bg').hidden`,
  );
  await evaluate(cdp, `document.getElementById('setzen-ab').click()`);
  await sleep(200);
  const gezogen = await evaluate<string>(
    cdp,
    `(function () {
       var tile = [...document.querySelectorAll('#plots .plot')].find(function (x) {
         return /^Feld 2/.test(x.querySelector('.name').textContent);
       });
       if (!tile) return Promise.resolve('kein Feld 2');
       var vorher = tile.style.left + ',' + tile.style.top;
       var r = tile.getBoundingClientRect();
       var hof = document.getElementById('hof').getBoundingClientRect();

       tile.dispatchEvent(new PointerEvent('pointerdown', {
         clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, button: 0,
       }));

       var stellen = [];
       for (var sy = 0.28; sy <= 0.74; sy += 0.06) {
         for (var sx = 0.25; sx <= 0.78; sx += 0.13) stellen.push([sx, sy]);
       }
       return new Promise(function (fertig) {
         setTimeout(function () {
           var lang = document.getElementById('setzen').hidden === false
             && tile.classList.contains('zieht');
           var gefolgt = false;
           var passt = false;

           for (var i = 0; i < stellen.length; i++) {
             document.dispatchEvent(new PointerEvent('pointermove', {
               clientX: hof.left + hof.width * stellen[i][0],
               clientY: hof.top + hof.height * stellen[i][1],
               bubbles: true,
             }));
             if (tile.style.left + ',' + tile.style.top !== vorher) gefolgt = true;
             if (!tile.classList.contains('geht-nicht')
                 && tile.style.left + ',' + tile.style.top !== vorher) { passt = true; break; }
           }
           document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));

           setTimeout(function () {
             var jetzt = [...document.querySelectorAll('#plots .plot')].find(function (x) {
               return /^Feld 2/.test(x.querySelector('.name').textContent);
             });
             fertig([
               lang ? 'lang' : 'kein-langdruck',
               gefolgt ? 'folgt' : 'klebt',
               passt ? 'frei-gefunden' : 'nur-besetzt',
               jetzt && jetzt.style.left + ',' + jetzt.style.top !== vorher ? 'umgezogen' : 'zurück',
               document.getElementById('setzen').hidden ? 'banner-zu' : 'banner-offen',
             ].join(' '));
           }, 500);
         }, 600);
       });
     })()`,
  );
  check(
    'Langes Drücken hebt ein Gebäude an, Ziehen setzt es woanders ab',
    gezogen === 'lang folgt frei-gefunden umgezogen banner-zu',
    gezogen,
  );

  check(
    'Ein gebautes Feld lässt sich zum Verschieben aufnehmen',
    schiebeStart === 'auf' && konnteSchieben === 'geklickt' && imSetzmodus,
    `${konnteSchieben}, Setzmodus ${imSetzmodus}`,
  );


  console.log('\n9g. Hindernisse wegräumen');

  await evaluate(cdp, farmTab);
  await sleep(300);

  const stehen = await evaluate<number>(
    cdp,
    `document.querySelectorAll('#hindernisse .hindernis').length`,
  );
  check('Bäume, Steine und Tümpel stehen als eigene Dinge auf dem Hof', stehen >= 5, `${stehen}`);

  const stehenBaeume = await evaluate<number>(
    cdp,
    `[...document.querySelectorAll('#hindernisse .hindernis')].filter(function (h) {
       return h.getAttribute('aria-label') === 'Baum';
     }).length`,
  );

  // Welches Werkzeug fehlt sicher? Kisten würfeln random, also erst nachsehen,
  // statt blind auf die Säge zu setzen.
  const inv = (await api(`/api/admin/status?account=${status.accountId}`)) as {
    itemIds: string[];
    state: { items: number[] };
  };
  const hat = (id: string) => {
    const i = inv.itemIds.indexOf(id);
    return i >= 0 ? inv.state.items[i]! : 0;
  };
  const werkzeuge: Array<{ art: string; werkzeug: string }> = [
    { art: 'Baum', werkzeug: 'saw' },
    { art: 'Stein', werkzeug: 'pickaxe' },
    { art: 'Tümpel', werkzeug: 'shovel' },
  ];
  const fehlt = werkzeuge.find((w) => hat(w.werkzeug) === 0) ?? werkzeuge[0]!;

  const ohneWerkzeug = await evaluate<string>(
    cdp,
    `(function (art) {
       var h = [...document.querySelectorAll('#hindernisse .hindernis')].find(function (x) {
         return x.getAttribute('aria-label') === art;
       });
       if (!h) return 'kein Hindernis: ' + art;
       h.click();
       var knopf = document.querySelector('#pick-list .abfahrt');
       var text = knopf ? knopf.textContent : '';
       var gesperrt = knopf ? knopf.disabled : false;
       document.getElementById('pick-close').click();
       return (gesperrt ? 'gesperrt' : 'offen') + ': ' + text;
     })(${JSON.stringify(fehlt.art)})`,
  );
  check(
    'Ohne das passende Werkzeug geht das Hindernis nicht weg — und die Seite sagt warum',
    /^gesperrt/.test(ohneWerkzeug),
    `${fehlt.art} ohne ${fehlt.werkzeug}: ${ohneWerkzeug}`,
  );

  await api(`/api/admin/grant?account=${status.accountId}&item=saw&amount=1`, 'POST');
  await sleep(1000);
  await evaluate(cdp, `document.getElementById('lagerhaus').click()`);
  await waitFor(cdp, `document.querySelectorAll('#mail .card').length > 0`, 'Säge im Postfach');
  await evaluate(cdp, `document.querySelector('#mail .card').click()`);
  await sleep(500);
  await evaluate(cdp, `document.getElementById('lager-close').click()`);
  await sleep(300);

  const xpVorher = await evaluate<string>(cdp, `document.getElementById('xp').textContent`);
  const geraeumt = await evaluate<string>(
    cdp,
    `(function () {
       var baum = [...document.querySelectorAll('#hindernisse .hindernis')].find(function (h) {
         return h.getAttribute('aria-label') === 'Baum';
       });
       baum.click();
       var knopf = document.querySelector('#pick-list .abfahrt');
       if (!knopf || knopf.disabled) return 'immer noch gesperrt';
       var text = knopf.textContent;
       knopf.click();
       return text;
     })()`,
  );
  await sleep(700);

  const danach = await evaluate<{ baeume: number; xp: string }>(
    cdp,
    `(function () {
       return {
         baeume: [...document.querySelectorAll('#hindernisse .hindernis')].filter(function (h) {
           return h.getAttribute('aria-label') === 'Baum';
         }).length,
         xp: document.getElementById('xp').textContent,
       };
     })()`,
  );
  check(
    'Mit Säge ist der Baum weg und bringt XP',
    /Wegräumen/.test(geraeumt) && danach.baeume === stehenBaeume - 1 && danach.xp !== xpVorher,
    `${geraeumt} · ${xpVorher} → ${danach.xp}`,
  );

  const platzFrei = (await api(`/api/admin/status?account=${status.accountId}`)) as {
    state: { clearedObstacles: number[] };
  };
  check(
    'Der Server weiß, dass da jetzt Platz ist',
    platzFrei.state.clearedObstacles.length === 1,
    `geräumt: ${JSON.stringify(platzFrei.state.clearedObstacles)}`,
  );

  console.log('\n9h. Die Zeitung — ein Aushang je Hof');

  const zeitungStand = await stateAs(second.key);
  await syncAs(second.key, zeitungStand.snapshot.seq, [
    { seq: zeitungStand.snapshot.seq + 1, tick: 0, type: 'LIST_ORDER', item: 1, amount: 6, price: 4 },
    { seq: zeitungStand.snapshot.seq + 2, tick: 0, type: 'LIST_ORDER', item: 1, amount: 3, price: 5 },
  ]);
  await sleep(500);

  await evaluate(cdp, farmTab);
  await sleep(1600);
  await evaluate(cdp, `document.getElementById('stand').click()`);
  await sleep(600);

  const blatt = await evaluate<{ hoefe: number; bilder: number; name: string; titel: string }>(
    cdp,
    `(function () {
       var karten = [...document.querySelectorAll('#zeitung .card.anzeige')];
       return {
         hoefe: karten.length,
         bilder: karten.filter(function (k) { return !!k.querySelector('img.ic'); }).length,
         name: karten[0] ? karten[0].querySelector('.top').textContent : '',
         titel: document.getElementById('zeitung-titel').textContent,
       };
     })()`,
  );
  check(
    'Mehrere Angebote, aber nur ein Eintrag — die Zeitung zeigt Höfe, nicht Kästchen',
    blatt.hoefe === 1 && blatt.bilder === 1 && blatt.titel === 'Die Zeitung',
    `${blatt.hoefe} Eintrag/Einträge, Hof „${blatt.name}"`,
  );
  check(
    'Der fremde Hof steht mit Namen da, nicht mit einer Kontonummer',
    blatt.name.length > 3 && !/hof_/.test(blatt.name),
    blatt.name,
  );

  const zurBesuch0 = await evaluate<string>(
    cdp,
    `(function () {
       var karte = document.querySelector('#zeitung .card.anzeige');
       if (!karte) return 'keine Anzeige';
       karte.click();
       return document.getElementById('besuch-bg').hidden ? 'nichts passiert' : 'unterwegs';
     })()`,
  );
  await sleep(1200);
  const beimNachbarn = await evaluate<string>(
    cdp,
    `(function () {
       document.getElementById('besuch-stand-knopf').click();
       return document.getElementById('besuch-titel').textContent + '|' +
         document.querySelectorAll('#besuch-stand .kaestchen').length;
     })()`,
  );
  check(
    'Aus der Zeitung geht es auf den Hof, nicht in eine Einkaufsliste',
    zurBesuch0 === 'unterwegs' && Number(beimNachbarn.split('|')[1]) >= 2,
    `${zurBesuch0}, dort: ${beimNachbarn}`,
  );

  await evaluate(cdp, `document.getElementById('fremdstand-close').click()`);
  await sleep(200);
  await evaluate(cdp, `document.getElementById('besuch-close').click()`);
  await sleep(200);
  await evaluate(cdp, `document.getElementById('stand-close').click()`);
  await sleep(200);

  console.log('\n9i. Nachbarn: Code, Besuch, Helfen, Kaufen beim anderen');

  const zweiterCode = await (async () => {
    const antwort = await fetch(`http://127.0.0.1:${PORT}/api/hof`, {
      headers: { authorization: `Bearer ${second.key}` },
    });
    return (await antwort.json()) as { code: string; name: string };
  })();
  check(
    'Jeder Hof hat einen Code und einen lesbaren Namen',
    /^[A-Z0-9]{6}$/.test(zweiterCode.code) && zweiterCode.name.length > 3,
    `${zweiterCode.code} — ${zweiterCode.name}`,
  );

  await fetch(
    `http://127.0.0.1:${PORT}/api/hof?name=${encodeURIComponent('Bens Bauernhof')}`,
    { method: 'POST', headers: { authorization: `Bearer ${second.key}` } },
  );

  await api(`/api/admin/grant?account=${second.accountId}&item=wheat&amount=20`, 'POST');
  await sleep(400);

  const zweiterStand2 = await stateAs(second.key);
  const jetztTick = tickFuer(zweiterStand2.snapshot);
  const saeen = await syncAs(second.key, zweiterStand2.snapshot.seq, [
    { seq: zweiterStand2.snapshot.seq + 1, tick: jetztTick, type: 'COLLECT_MAIL' },
    { seq: zweiterStand2.snapshot.seq + 2, tick: jetztTick, type: 'START', plot: 0, recipe: 0, slot: 0 },
    {
      seq: zweiterStand2.snapshot.seq + 3,
      tick: jetztTick,
      type: 'LIST_ORDER',
      item: 1,
      amount: 4,
      price: 4,
    },
  ]);
  check('Der Nachbar hat etwas am Laufen und etwas im Stand', saeen.ok, saeen.reason ?? saeen.kind);
  await sleep(600);

  await evaluate(cdp, farmTab);
  await sleep(300);
  const eigener = await evaluate<string>(
    cdp,
    `(function () {
       document.getElementById('nachbarn').click();
       return 'auf';
     })()`,
  );
  await sleep(700);
  const hofkarte = await evaluate<string>(
    cdp,
    `(function () {
       var feld = document.getElementById('hofnamefeld');
       var code = document.querySelector('#eigenerhof .code');
       return (feld ? feld.value : 'kein Feld') + '|' + (code ? code.textContent : 'kein Code');
     })()`,
  );
  check(
    'Der eigene Hof zeigt Name und Code zum Weitergeben',
    eigener === 'auf' && /\|[A-Z0-9]{6}$/.test(hofkarte) && hofkarte.split('|')[0]!.length > 3,
    hofkarte,
  );

  await evaluate(
    cdp,
    `(function () {
       document.getElementById('freundcode').value = ${JSON.stringify(zweiterCode.code)};
       document.getElementById('freundadd').click();
     })()`,
  );
  await sleep(900);
  const nachAnfrage = await evaluate<string>(
    cdp,
    `[...document.querySelectorAll('#freundeliste .nachbar')]
       .map(function (c) { return c.dataset.hof + ':' + c.querySelector('.sub').textContent; })
       .join(', ')`,
  );
  check(
    'Eine Anfrage macht noch keine Nachbarschaft — sie wartet auf Antwort',
    nachAnfrage.indexOf(zweiterCode.code) >= 0 && /wartet auf Antwort/.test(nachAnfrage),
    nachAnfrage,
  );

  const meinCode = await evaluate<string>(
    cdp,
    `document.querySelector('#eigenerhof .code').textContent`,
  );
  // Das Blatt bleibt offen. Der andere sagt zu — es muss von selbst umspringen,
  // ohne dass jemand das Blatt neu öffnet.
  await fetch(`http://127.0.0.1:${PORT}/api/freunde?code=${meinCode}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${second.key}` },
  });

  let nachbarliste = '';
  const seitZusage = Date.now();
  let umgesprungen = -1;
  for (let i = 0; i < 40; i++) {
    nachbarliste = await evaluate<string>(
      cdp,
      `[...document.querySelectorAll('#freundeliste .nachbar')]
         .map(function (c) { return c.dataset.hof + ':' + c.querySelector('.sub').textContent; })
         .join(', ')`,
    );
    if (/helfen möglich/.test(nachbarliste)) { umgesprungen = Date.now() - seitZusage; break; }
    await sleep(200);
  }
  check(
    'Sagt der andere ja, springt das offene Blatt von selbst auf Nachbarschaft um',
    umgesprungen >= 0 && umgesprungen < 4000,
    umgesprungen < 0 ? nachbarliste : `nach ${umgesprungen} ms live umgesprungen`,
  );

  await api(`/api/admin/grant?account=${second.accountId}&item=corn&amount=10`, 'POST');
  await sleep(400);
  const vorBesuch = await stateAs(second.key);
  const saatTick = tickFuer(vorBesuch.snapshot);
  const gesaet = await syncAs(second.key, vorBesuch.snapshot.seq, [
    { seq: vorBesuch.snapshot.seq + 1, tick: saatTick, type: 'COLLECT_MAIL' },
    { seq: vorBesuch.snapshot.seq + 2, tick: saatTick, type: 'START', plot: 1, recipe: 3, slot: 0 },
  ]);
  check('Der Nachbar pflanzt kurz vor dem Besuch etwas Langsames', gesaet.ok, gesaet.reason ?? gesaet.kind);

  await evaluate(cdp, `document.querySelector('#freundeliste .nachbar .go').click()`);
  await sleep(1200);
  const besuchBild = await evaluate<{
    titel: string;
    plots: number;
    boden: boolean;
    hindernisse: number;
    standKnopf: boolean;
    offen: boolean;
  }>(
    cdp,
    `(function () {
       return {
         titel: document.getElementById('besuch-titel').textContent,
         plots: document.querySelectorAll('#besuch-plots .plot').length,
         boden: document.getElementById('besuch-scene').childElementCount > 0,
         hindernisse: document.querySelectorAll('#besuch-hindernisse .hindernis').length,
         standKnopf: !document.getElementById('besuch-stand-knopf').disabled,
         offen: !document.getElementById('besuch-bg').hidden,
       };
     })()`,
  );
  check(
    'Man steht auf seinem ganzen Hof — Landschaft, Hindernisse, Gebäude',
    besuchBild.offen && besuchBild.titel === 'Bens Bauernhof' && besuchBild.plots > 0 &&
      besuchBild.boden && besuchBild.hindernisse > 0,
    JSON.stringify(besuchBild),
  );
  check(
    'Sein Stand steht auf dem Hof und will angetippt werden',
    besuchBild.standKnopf,
    `Stand tippbar: ${besuchBild.standKnopf}`,
  );

  const helferVorher = Number(await evaluate<string>(cdp, `document.getElementById('xp').textContent`)
    .then((t) => t.split(' ')[0]));

  const zweiterHof = (await api(`/api/admin/status?account=${second.accountId}`)) as {
    state: { plots: Array<{ level: number; slots: Array<{ recipe: number; startedAt: number }> }> };
  };
  const laufend = zweiterHof.state.plots.findIndex((p) =>
    p.slots.some((s) => s.recipe !== -1),
  );
  check(
    'Auf dem besuchten Hof läuft etwas, dem man helfen kann',
    laufend >= 0,
    `Platz ${laufend}`,
  );

  const geholfen = await evaluate<string>(
    cdp,
    `(function () {
       var kachel = [...document.querySelectorAll('#besuch-plots .plot')]
         .find(function (p) { return !p.disabled; });
       if (!kachel) return 'nichts zu tun: ' +
         [...document.querySelectorAll('#besuch-plots .plot')]
           .map(function (p) { return p.getAttribute('aria-label'); }).join(' / ');
       kachel.click();
       return 'getippt';
     })()`,
  );
  await sleep(1800);
  const nachHilfe = await evaluate<string>(
    cdp,
    `document.getElementById('toast').textContent + '|' +
     (document.querySelector('#besuch-kopf .hilfen') || { ariaLabel: 'keine' }).ariaLabel`,
  );
  check(
    'Helfen gibt XP und zählt herunter, wie oft es heute noch geht',
    geholfen === 'getippt' && /\+\d+ XP/.test(nachHilfe) &&
      /2 von 3 Hilfen offen/.test(nachHilfe),
    (geholfen === 'getippt' ? nachHilfe : geholfen).slice(0, 160),
  );

  const heuteDrin = (await api(`/api/admin/status?account=${status.accountId}`)) as { state: { xp: number } };
  check(
    'Die XP fürs Helfen steht auch beim Server',
    heuteDrin.state.xp > helferVorher,
    `${helferVorher} → ${heuteDrin.state.xp} XP`,
  );

  await evaluate(cdp, `document.getElementById('besuch-stand-knopf').click()`);
  await sleep(400);
  const standVorKauf = await evaluate<number>(
    cdp,
    `document.querySelectorAll('#besuch-stand .kaestchen').length`,
  );
  const gekauftBeimNachbarn = await evaluate<string>(
    cdp,
    `(function () {
       var k = [...document.querySelectorAll('#besuch-stand .kaestchen')]
         .find(function (x) { return !x.disabled; });
       if (!k) return 'alles gesperrt';
       k.click();
       return 'gekauft';
     })()`,
  );
  await sleep(2000);
  const standDanach2 = await evaluate<number>(
    cdp,
    `document.querySelectorAll('#besuch-stand .kaestchen').length`,
  );
  check(
    'Gekauft wird direkt in seinem Stand, nicht mehr aus der Zeitung',
    gekauftBeimNachbarn === 'gekauft' && standDanach2 === standVorKauf - 1,
    `${gekauftBeimNachbarn}, ${standVorKauf} → ${standDanach2} Kästchen`,
  );

  await evaluate(cdp, `document.getElementById('fremdstand-close').click()`);
  await sleep(300);
  const zurueckAufHof = await evaluate<boolean>(
    cdp,
    `!document.getElementById('besuch-bg').hidden
       && document.getElementById('fremdstand-bg').hidden`,
  );
  check('Nach dem Kauf steht man wieder auf seinem Hof', zurueckAufHof);

  await evaluate(cdp, `document.getElementById('besuch-close').click()`);
  await sleep(200);

  await evaluate(cdp, `document.getElementById('lagerhaus').click()`);
  await cdp.send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  await evaluate(cdp, `window.dispatchEvent(new Event('offline'))`);
  await sleep(600);
  const lagerBleibt = await evaluate<boolean>(
    cdp,
    `!document.getElementById('lager-bg').hidden`,
  );
  check(
    'Ohne Netz bleibt das Lager offen — es braucht keine Verbindung',
    lagerBleibt,
  );

  await evaluate(cdp, `document.getElementById('lager-close').click()`);
  await sleep(200);
  const rausgeworfen = await evaluate<string>(
    cdp,
    `(function () {
       document.getElementById('nachbarn').click();
       var offen = !document.getElementById('freunde-bg').hidden;
       return offen ? 'trotzdem offen' : 'gar nicht erst auf';
     })()`,
  );
  await sleep(400);
  const nachWurf = await evaluate<string>(
    cdp,
    `JSON.stringify({
       freunde: !document.getElementById('freunde-bg').hidden,
       besuch: !document.getElementById('besuch-bg').hidden,
       meldung: document.getElementById('toast').textContent,
     })`,
  );
  check(
    'Ohne Netz landet man aus den Nachbarn sofort wieder auf dem Hof',
    /"freunde":false/.test(nachWurf) && /"besuch":false/.test(nachWurf),
    `${rausgeworfen} · ${nachWurf}`,
  );

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
  const wiederDrin = await evaluate<boolean>(
    cdp,
    `(function () {
       document.getElementById('nachbarn').click();
       return !document.getElementById('freunde-bg').hidden;
     })()`,
  );
  check('Mit Netz gehen die Nachbarn wieder auf', wiederDrin);

  await evaluate(cdp, `document.getElementById('freunde-close').click()`);
  await sleep(200);

const schwenken = await evaluate<{ vorher: string; nachher: string; klar: boolean }>(
    cdp,
    `(function () {
       var welt = document.getElementById('welt');
       var hof = document.getElementById('hof');
       var r = hof.getBoundingClientRect();
       var mid = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
       // Erst reinzoomen (Strg+Rad), sonst gibt es bei Vollsicht nichts zu schwenken.
       for (var z = 0; z < 5; z++) {
         hof.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true, clientX: mid.clientX, clientY: mid.clientY }));
       }
       var vorher = welt.style.transform;
       // Auf leerem Boden (obere Ecke) aufsetzen und ziehen — nicht auf einem Feld.
       var x = r.left + r.width * 0.5, y = r.top + r.height * 0.2;
       hof.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true, button: 0 }));
       for (var i = 1; i <= 6; i++) {
         document.dispatchEvent(new PointerEvent('pointermove', {
           clientX: x - i * 12, clientY: y - i * 8, bubbles: true,
         }));
       }
       document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
       return { vorher: vorher, nachher: welt.style.transform, klar: hof.classList.contains('schwenkt') === false };
     })()`,
  );
  check(
    'Man kann die Farm schwenken — die Welt bewegt sich beim Ziehen',
    schwenken.vorher !== schwenken.nachher && schwenken.klar,
    `${schwenken.vorher} → ${schwenken.nachher}`,
  );

  console.log('\n9z. Neues Land vermessen und freischalten');
  await api(`/api/admin/grant?account=${status.accountId}&item=map&amount=2`, 'POST');
  await api(`/api/admin/grant?account=${status.accountId}&item=mallet&amount=2`, 'POST');
  await api(`/api/admin/grant?account=${status.accountId}&item=stake&amount=3`, 'POST');
  await api(`/api/admin/xp?account=${status.accountId}&amount=1200`, 'POST');
  await sleep(500);
  await evaluate(cdp, `document.getElementById('lagerhaus').click()`);
  await waitFor(cdp, `document.querySelectorAll('#mail .card').length > 0`, 'Vermessungszeug im Postfach');
  for (let i = 0; i < 6; i++) {
    const c = await evaluate<boolean>(cdp, `!!document.querySelector('#mail .card')`);
    if (!c) break;
    await evaluate(cdp, `document.querySelector('#mail .card').click()`);
    await sleep(250);
  }
  await evaluate(cdp, `document.getElementById('lager-close').click()`);
  await sleep(200);
  await evaluate(cdp, `(function () {
    var f = document.getElementById('stufe-feier');
    if (f && !f.hidden) { var w = document.getElementById('stufe-weiter'); if (w) w.click(); }
  })()`);
  await sleep(200);

  await waitFor(
    cdp,
    `document.querySelector('#erweiterungen .feld-sperre.bereit') !== null`,
    'ein Feld ist bereit zum Freischalten',
  );
  const freigeschaltet = await evaluate<{ vorher: number; nachher: number }>(
    cdp,
    `(async function () {
       var vorher = document.querySelectorAll('#erweiterungen .feld-sperre').length;
       document.querySelector('#erweiterungen .feld-sperre.bereit').click();
       await new Promise(function (r) { setTimeout(r, 250); });
       document.querySelector('#erweiterung-inhalt .primär').click();
       await new Promise(function (r) { setTimeout(r, 700); });
       return { vorher: vorher, nachher: document.querySelectorAll('#erweiterungen .feld-sperre').length };
     })()`,
  );
  check(
    'Freischalten macht aus einem gesperrten Feld freies Farmland',
    freigeschaltet.nachher === freigeschaltet.vorher - 1,
    `${freigeschaltet.vorher} → ${freigeschaltet.nachher} gesperrte Felder`,
  );

  console.log('\n10. Eine neue Version erreicht den Browser');

  const shellBefore = await evaluate<string>(cdp, `caches.keys().then(function (k) { return k.join(','); })`);
  check(
    'Der Cachename trägt einen Fingerabdruck der Seite',
    /neues-spiel-.*-[0-9a-f]{12}$/.test(shellBefore),
    shellBefore,
  );

  const template = join(ROOT, 'web', 'farm', 'page.html');
  const originalTemplate = readFileSync(template, 'utf8');
  const MARKER = 'NEUE-VERSION-PRUEFUNG';
  try {
    writeFileSync(
      template,
      originalTemplate.replace(
        '<h3 id="lager-titel">Lager</h3>',
        `<h3 id="lager-titel">Lager ${MARKER}</h3>`,
      ),
    );
    const built = spawn(
      process.execPath,
      ['--experimental-strip-types', join(ROOT, 'scripts', 'build-conformance.ts')],
      { stdio: 'ignore' },
    );
    await new Promise<void>((resolve) => built.once('exit', () => resolve()));

    server.kill('SIGTERM');
    await new Promise<void>((resolve) => server.once('exit', () => resolve()));
    server = startServer();
    if (!(await serverUp())) throw new Error('Server kam mit der neuen Version nicht hoch');

    await cdp.send('Page.reload', {});
    let sawNew = false;
    for (let i = 0; i < 60 && !sawNew; i++) {
      await sleep(500);
      sawNew = await evaluate<boolean>(
        cdp,
        `document.body.innerHTML.indexOf(${JSON.stringify(MARKER)}) >= 0`,
      ).catch(() => false);
    }
    check('Nach einem Neuladen ist die neue Oberfläche da — ohne Cache-Löschen', sawNew);

    const shellAfter = await evaluate<string>(
      cdp,
      `caches.keys().then(function (k) { return k.join(','); })`,
    );
    check(
      'Der alte Hüllen-Cache ist weggeräumt, nicht angesammelt',
      shellAfter !== shellBefore && !shellAfter.includes(','),
      `${shellBefore} → ${shellAfter}`,
    );
  } finally {
    writeFileSync(template, originalTemplate);
    const rebuilt = spawn(
      process.execPath,
      ['--experimental-strip-types', join(ROOT, 'scripts', 'build-conformance.ts')],
      { stdio: 'ignore' },
    );
    await new Promise<void>((resolve) => rebuilt.once('exit', () => resolve()));
  }
} catch (err) {
  failed = true;
  console.error(`\nAbbruch: ${(err as Error).message}`);
} finally {
  cdp?.close();
  browser.kill('SIGKILL');
  server.kill('SIGKILL');

  for (const path of [dataDir, profileDir]) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
    }
  }
}

const passed = checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${checks.length} Prüfungen bestanden`);
if (failed || passed !== checks.length) process.exit(1);

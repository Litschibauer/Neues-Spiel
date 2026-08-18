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

  const stateAs = async (key: string) =>
    (await (
      await fetch(`http://127.0.0.1:${PORT}/api/state`, {
        headers: { authorization: `Bearer ${key}` },
      })
    ).json()) as { snapshot: { seq: number; state: { items: number[]; orders: unknown[] } } };

  await api(`/api/admin/grant?account=${second.accountId}&item=wheat&amount=30`, 'POST');

  const beforeAnyAction = await stateAs(second.key);
  check(
    'Ein Geschenk erreicht das Postfach ohne Zutun des Spielers',
    beforeAnyAction.snapshot.seq === 0,
  );

  await syncAs(second.key, 0, [{ seq: 1, tick: 0, type: 'COLLECT_MAIL' }]);
  const listed = await syncAs(second.key, 1, [
    { seq: 2, tick: 0, type: 'LIST_ORDER', item: 1, amount: 20, price: 3 },
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
  check('Der Käufer sieht das fremde Angebot', /20 Weizen/.test(shelfText), shelfText);

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
  check('Die gekaufte Ware ist da', wheatAfter === wheatBefore + 20, `${wheatBefore} → ${wheatAfter}`);
  check(
    'Und aus dem Buch verschwunden',
    ((await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()) as { offers: number })
      .offers === 0,
  );

  const sellerState = (await (
    await fetch(`http://127.0.0.1:${PORT}/api/state`, {
      headers: { authorization: `Bearer ${second.key}` },
    })
  ).json()) as { snapshot: { state: { orders: unknown[] } } };
  check('Der verkaufte Auftrag ist beim Verkäufer weg', sellerState.snapshot.state.orders.length === 0);

  const paid = await syncAs(second.key, 2, [{ seq: 3, tick: 0, type: 'COLLECT_MAIL' }]);
  const sellerAfter = (await (
    await fetch(`http://127.0.0.1:${PORT}/api/state`, {
      headers: { authorization: `Bearer ${second.key}` },
    })
  ).json()) as { snapshot: { state: { items: number[] } } };

  const sellerPaid = (await (
    await fetch(`http://127.0.0.1:${PORT}/api/state`, {
      headers: { authorization: `Bearer ${second.key}` },
    })
  ).json()) as { snapshot: { state: { items: number[] } } };

  const devRules = getRuleset(1001);
  const startGold = devRules.startingItems.find((x) => x.item === 0)?.amount ?? 0;
  const expectedCoins = startGold - listingFee(devRules, 1, 20) + 20 * 3;
  check(
    `Der Verkäufer hat sein Geld — 20 × 3 = 60, abzüglich Gebühr`,
    paid.ok && sellerPaid.snapshot.state.items[0] === expectedCoins,
    `${sellerPaid.snapshot.state.items[0]} statt ${expectedCoins} Münzen ` +
      `(vor dem Postfach: ${sellerAfter.snapshot.state.items[0]})`,
  );

  console.log('\n7. Die Spieloberfläche auf / (Telefonformat 390 × 844)');

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
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
    state: { items: number[]; plots: unknown[] };
  };
  check(
    'Es zeigt dieselben Zahlen wie der Server',
    Number(shown.gold) === truth.state.items[0] && shown.plots === truth.state.plots.length,
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

  await cdp.send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  await evaluate(cdp, `window.dispatchEvent(new Event('offline'))`);
  await evaluate(cdp, `document.getElementById('stand').click()`);
  check(
    'Ohne Netz ist der Markt ausgegraut und der Hinweis sichtbar',
    await evaluate<boolean>(
      cdp,
      `document.getElementById('market-list').className === 'no-net'
         && !document.getElementById('market-note').hidden`,
    ),
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

  const offersBefore = await evaluate<number>(
    cdp,
    `document.querySelectorAll('#market-list .card').length`,
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
      `document.querySelectorAll('#market-list .card').length`,
    );
  }
  check(
    'Ein neues Angebot erscheint von selbst — ohne Neuladen',
    offersAfter > offersBefore,
    `${offersBefore} → ${offersAfter} Angebote`,
  );

  console.log('\n8b. Menge und Preis wählen, Auftrag wegschicken');

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

  await evaluate(
    cdp,
    `(function () {
       var pick = document.querySelector('#list .pick');
       pick.querySelectorAll('button')[0].click();
       pick.querySelectorAll('button')[0].click();
     })()`,
  );
  const chosen = await evaluate<number>(cdp, `Number(document.querySelector('#list .pick input').value)`);
  check(
    'Die Menge lässt sich herunterzählen, statt immer alles anzubieten',
    chosen === wheatStock - 2,
    `${wheatStock} → ${chosen}`,
  );

  const eigeneVorher = await evaluate<number>(
    cdp,
    `document.querySelectorAll('#my-orders .card').length`,
  );
  await evaluate(cdp, `document.querySelector('#list .done').click()`);
  await sleep(400);
  const leftOver = await evaluate<number>(
    cdp,
    `(function () {
       var c = [...document.querySelectorAll('#stock .chip')].find(function (x) {
         return x.textContent.indexOf('Weizen') === 0;
       });
       return c ? Number(c.querySelector('.n').textContent) : -1;
     })()`,
  );
  const eigeneNachher = await evaluate<number>(
    cdp,
    `document.querySelectorAll('#my-orders .card').length`,
  );
  check(
    'Angeboten wird genau die gewählte Menge — der Rest bleibt liegen',
    leftOver === 2 && eigeneNachher > eigeneVorher,
    `${wheatStock} → ${leftOver} Weizen, Auslage ${eigeneVorher} → ${eigeneNachher}`,
  );

  const band = await evaluate<{ value: number; max: number; dip: number }>(
    cdp,
    `(function () {
       // Zwischen den Tipps neu abfragen: Jede Änderung zeichnet den Bereich
       // neu, und ein Mensch tippt auch auf den Knopf, der dann dasteht.
       var priceRow = function () { return document.querySelectorAll('#list .trade .pick')[1]; };
       // Erst herunter, dann weit über das Band hinaus — das prüft beide
       // Richtungen UND die Grenze, statt auf dem Höchstwert sitzen zu bleiben,
       // auf dem der Vorschlag ohnehin startet.
       for (var i = 0; i < 2; i++) priceRow().querySelectorAll('button')[0].click();
       var dip = Number(priceRow().querySelector('input').value);
       for (var j = 0; j < 50; j++) priceRow().querySelectorAll('button')[1].click();
       var after = priceRow().querySelector('input');
       return { value: Number(after.value), max: Number(after.max), dip: dip };
     })()`,
  );
  check(
    'Der Preis lässt sich frei wählen und nicht über das Band hinaus',
    band.dip < band.max && band.value === band.max && band.max > 0,
    `runter auf ${band.dip}, hoch bis höchstens ${band.max} → ${band.value}`,
  );

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
  const frachtText = `[...document.querySelectorAll('#requests .posten')]
       .map(function (p) { return p.textContent; }).join(' | ')`;
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


  console.log('\n9b. Ein Stall mit drei Tieren — jedes einzeln');

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

  const buyUpgrade = (name: string) =>
    evaluate<boolean>(
      cdp,
      `(function () {
         var tile = [...document.querySelectorAll('#plots .plot')].find(function (t) {
           return t.querySelector('.name').textContent.indexOf(${JSON.stringify(name)}) === 0;
         });
         if (!tile) return false;
         var up = tile.querySelector('.upgrade');
         if (up && !up.disabled) { up.click(); return true; }
         if (tile.disabled) return false;
         tile.click();
         var sheet = document.getElementById('pick-bg');
         if (!sheet.hidden) { document.getElementById('pick-close').click(); return false; }
         return true;
       })()`,
    );

  await buyUpgrade('Mühle');
  await sleep(300);
  await buyUpgrade('Gehege 1');
  await sleep(300);
  await buyUpgrade('Gehege 1');
  await sleep(300);

  const stallStatus = await evaluate<string>(
    cdp,
    `(function () {
       var tile = [...document.querySelectorAll('#plots .plot')].find(function (t) {
         return t.querySelector('.name').textContent.indexOf('Gehege 1') === 0;
       });
       return tile ? tile.querySelector('.status').textContent : '';
     })()`,
  );
  check(
    'Ein Tier nach dem anderen: aus einem Stall mit einem Huhn wird einer mit zweien',
    /2 Hühner/.test(stallStatus),
    stallStatus,
  );

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

  await evaluate(
    cdp,
    `(function () {
       var tile = [...document.querySelectorAll('#plots .plot')].find(function (t) {
         return t.querySelector('.name').textContent.indexOf('Gehege 1') === 0;
       });
       tile.click();
     })()`,
  );
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
    state: { chests: Array<{ id: number; readyAt: number }>; tick: number };
  };
  check(
    'Der Server plant Kisten voraus, ohne den Inhalt zu verraten',
    kistenStand.state.chests.length >= 3 &&
      kistenStand.state.chests.every((k) => typeof k.readyAt === 'number'),
    `${kistenStand.state.chests.length} Kisten in der Warteschlange`,
  );

  const naechste = kistenStand.state.chests[0]!;
  const wartezeit = Math.max(60, naechste.readyAt - kistenStand.state.tick + 30);
  await api(`/api/admin/time?account=${status.accountId}&seconds=${wartezeit}`, 'POST');

  try {
    await waitFor(cdp, `!document.getElementById('kiste').hidden`, 'Kiste steht da', 20_000);
  } catch {
  }
  check(
    'Wenn ihre Zeit da ist, steht die Kiste auf dem Hof',
    await evaluate<boolean>(cdp, `!document.getElementById('kiste').hidden`),
  );

  const vorKiste = (await api(`/api/admin/status?account=${status.accountId}`)) as {
    state: { items: number[]; mail: unknown[] };
  };
  await evaluate(cdp, `document.getElementById('kiste').click()`);
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

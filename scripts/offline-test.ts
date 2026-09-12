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

// Feature-Einführungen legen sich über den Bildschirm. Vor allem, was mit dem
// Hof selbst zu tun hat, müssen sie weg — sonst tippt der Test gegen eine
// Blende.
async function schliesseTutorial(cdp: Cdp): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const offen = await evaluate<boolean>(
      cdp,
      `(function () {
         var t = document.getElementById('tut-bg');
         if (!t || t.hidden) return false;
         var s = document.getElementById('tut-skip');
         if (s) s.click();
         return true;
       })()`,
    );
    if (!offen) return;
    await sleep(250);
  }
}

// Feiner Weg, wenn das blinde Abtasten nichts trifft: Die Seite sucht selbst
// einen Punkt, unter dem weder Platz noch Hindernis noch Landsperre liegt, und
// meldet ihn zurück. Bei weit herausgezoomter Kamera ist das der Unterschied
// zwischen „findet nichts" und „setzt sofort".
async function tippeAufFreiesFeld(cdp: Cdp): Promise<boolean> {
  for (let versuch = 0; versuch < 24; versuch++) {
    const getroffen = await evaluate<boolean>(
      cdp,
      `(function () {
         var hof = document.getElementById('hof');
         var r = hof.getBoundingClientRect();
         var belegt = function (x, y) {
           return document.elementsFromPoint(x, y).some(function (e) {
             return e.closest && !!e.closest('.plot, .hindernis, .feld-sperre, .setzen, .moebel, .zahnrad, .sheet-bg');
           });
         };
         for (var sy = 2; sy < 30; sy++) {
           for (var sx = 2; sx < 46; sx++) {
             var px = r.left + (r.width * sx) / 48;
             var py = r.top + (r.height * sy) / 32;
             if (belegt(px, py)) continue;
             hof.dispatchEvent(new MouseEvent('click', { clientX: px, clientY: py, bubbles: true }));
             return true;
           }
         }
         return false;
       })()`,
    );
    if (!getroffen) return false;
    await sleep(320);
    if (await evaluate<boolean>(cdp, `document.getElementById('setzen').hidden`)) return true;
  }
  return false;
}

// Gezielt setzen: Die Seite kapselt ihre Innereien, aber der Spielstand liegt
// im localStorage und die Sim-Bibliothek haengt an globalThis. Daraus baut der
// Test dieselbe Sicht wie die Seite, sucht einen Platz, an dem der gekaufte
// Bau wirklich hinpasst (auch 2×2 und groesser), und tippt genau dorthin —
// die Welt hat ihren Ursprung oben links, also reicht ihr Bildkasten fuer die
// Umrechnung. Liefert einen kurzen Befund, wenn nirgends Platz ist.
async function setzeGezielt(cdp: Cdp): Promise<string> {
  for (let versuch = 0; versuch < 6; versuch++) {
    const befund = await evaluate<string>(
      cdp,
      `(function () {
         var NS = globalThis.NeuesSpiel;
         var raw = localStorage.getItem(NS.storageKeyFor(location.origin));
         if (!raw) return 'kein Spielstand';
         var c; try { c = NS.restoreClient(JSON.parse(raw)).client; } catch (e) { return 'Spielstand kaputt: ' + e.message; }
         var s = c.preview();
         var rules = NS.getRuleset(c.baseSnapshot.rulesetVersion);
         var g = rules.grid;
         if (!g) return 'kein Raster';
         var offen = [];
         for (var i = 0; i < s.plots.length; i++) if (s.plots[i].level > 0 && s.plots[i].gx < 0) offen.push(i);
         if (offen.length !== 1) return 'zu setzen: ' + offen.length;
         var plot = offen[0];
         var groesse = rules.plots[plot].size || { w: 1, h: 1 };
         var passt = function (gx, gy) {
           if (gx < 0 || gy < 0 || gx + groesse.w > g.w || gy + groesse.h > g.h) return false;
           var frei = function (o, w, h) {
             return gx + groesse.w <= o.gx || o.gx + w <= gx || gy + groesse.h <= o.gy || o.gy + h <= gy;
           };
           var hs = rules.obstacles || [];
           for (var k = 0; k < hs.length; k++) if (!frei(hs[k], hs[k].w, hs[k].h)) return false;
           var es = rules.expansions || [], auf = s.expandiert || [];
           for (k = 0; k < es.length; k++) {
             if (auf.indexOf(es[k].id) >= 0) continue;
             if (!frei(es[k], es[k].w, es[k].h)) return false;
           }
           for (k = 0; k < s.plots.length; k++) {
             if (k === plot || s.plots[k].gx < 0) continue;
             var s2 = rules.plots[k].size || { w: 1, h: 1 };
             if (!frei(s.plots[k], s2.w, s2.h)) return false;
           }
           return true;
         };
         // Nah beim Gebauten, damit es im Bild bleibt.
         var mx = 0, my = 0, n = 0;
         for (i = 0; i < s.plots.length; i++) {
           if (s.plots[i].gx < 0 || s.plots[i].level <= 0) continue;
           mx += s.plots[i].gx; my += s.plots[i].gy; n++;
         }
         if (n > 0) { mx /= n; my /= n; } else { mx = g.w / 2; my = g.h / 2; }
         var ziel = null, beste = 1e9;
         for (var gy = 0; gy + groesse.h <= g.h; gy++) {
           for (var gx = 0; gx + groesse.w <= g.w; gx++) {
             if (!passt(gx, gy)) continue;
             var d = Math.abs(gx - mx) + Math.abs(gy - my);
             if (d < beste) { beste = d; ziel = { gx: gx, gy: gy }; }
           }
         }
         if (!ziel) return 'kein freier ' + groesse.w + 'x' + groesse.h + '-Platz';
         // Die Seite setzt den Bau um seine halbe Groesse versetzt zum Tipp.
         var zx = ziel.gx + (groesse.w >> 1), zy = ziel.gy + (groesse.h >> 1);
         var BAND = 3;
         var wr = document.getElementById('welt').getBoundingClientRect();
         var cx = wr.left + ((zx + 0.5) / g.w) * wr.width;
         var cy = wr.top + ((zy + BAND + 0.5) / (g.h + BAND)) * wr.height;
         document.getElementById('hof').dispatchEvent(new MouseEvent('click', { clientX: cx, clientY: cy, bubbles: true }));
         return 'getippt ' + ziel.gx + ',' + ziel.gy;
       })()`,
    );
    if (!/^getippt/.test(befund)) return befund;
    await sleep(320);
    if (await evaluate<boolean>(cdp, `document.getElementById('setzen').hidden`)) return 'gesetzt';
  }
  return 'getippt, aber nicht gesetzt';
}

async function tippeBisGesetzt(cdp: Cdp): Promise<boolean> {
  await schliesseTutorial(cdp);
  // Erst gezielt — schnell und auch fuer grosse Plaetze verlaesslich.
  if ((await setzeGezielt(cdp)) === 'gesetzt') return true;
  // Über den ganzen sichtbaren Hof tasten — das freie Startland kann je nach
  // Rasterhöhe/Kamera oben ODER unten im Bild liegen.
  for (const x of [0.5, 0.25, 0.75, 0.35, 0.65, 0.15]) {
    for (const y of [0.4, 0.5, 0.3, 0.6, 0.2, 0.7, 0.45, 0.8, 0.25, 0.9, 0.35, 0.55]) {
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
  // Blind nichts getroffen — die Seite selbst suchen lassen.
  return tippeAufFreiesFeld(cdp);
}

async function baueUndStelle(cdp: Cdp, name: string): Promise<boolean> {
  await schliesseTutorial(cdp);
  await evaluate(cdp, `document.getElementById('bauen').click()`);
  await sleep(250);
  await schliesseTutorial(cdp);
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
         var s = (t.querySelector('.status') || {}).textContent || '';
         if (/→/.test(s) || / oder /.test(s)) return true;
         var al = t.getAttribute('aria-label') || '';
         return /^Feld [0-9]/.test(al) && !t.classList.contains('ripe') && !t.querySelector('.bar');
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



// Auf einem bespielten Hof ist nicht immer gerade ein Feld frei. Statt daran zu
// scheitern, wird gewartet und ein reifes Feld vorher abgeerntet — genau das,
// was ein Spieler auch täte. Wer eine Aktion misst, ruft das vorher auf, damit
// die Wartezeit nicht als Antwortzeit des Servers erscheint.
// Schreibt jede Meldung mit, die das Spiel zeigt — samt der Frage, ob sie
// antippbar war. Nach einem Neuladen muss der Mitschnitt neu angehaengt werden.
// Der Mitschnitt liegt im localStorage, damit er Neuladen und Navigieren
// ueberlebt. Der Beobachter selbst wird ueber CDP auf jedes neue Dokument
// gesetzt — so muss nach einem Reload niemand daran denken, ihn neu
// anzuhaengen.
const MELDUNGEN = 'ns-test-meldungen';
const MELDUNGEN_SKRIPT = `(function () {
  function an() {
    var t = document.getElementById('toast');
    if (!t || window.__meldungenAn) return;
    window.__meldungenAn = true;
    new MutationObserver(function () {
      if (t.className.indexOf('show') < 0 || !t.textContent) return;
      var liste = [];
      try { liste = JSON.parse(localStorage.getItem('${MELDUNGEN}') || '[]'); } catch (e) {}
      var e = { text: t.textContent, tippbar: t.className.indexOf('tippbar') >= 0, n: 1, t: Date.now() };
      var l = liste[liste.length - 1];
      // Gleiche Meldung direkt hintereinander: zaehlen statt verschlucken —
      // sonst bliebe eine Wiederholungsschleife unsichtbar.
      if (l && l.text === e.text && Date.now() - (l.t || 0) < 800) return;
      if (l && l.text === e.text) { l.n = (l.n || 1) + 1; l.t = Date.now(); }
      else liste.push(e);
      try { localStorage.setItem('${MELDUNGEN}', JSON.stringify(liste)); } catch (x) {}
    }).observe(t, { attributes: true, childList: true, characterData: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', an);
  else an();
})()`;
let meldungenAngemeldet = false;
async function meldungenMitschneiden(cdp: Cdp): Promise<void> {
  if (!meldungenAngemeldet) {
    meldungenAngemeldet = true;
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: MELDUNGEN_SKRIPT });
  }
  await evaluate(cdp, MELDUNGEN_SKRIPT);
}

async function warteAufFreiesFeld(cdp: Cdp): Promise<boolean> {
  for (let versuch = 0; versuch < 50; versuch++) {
    const lage = await evaluate<string>(
      cdp,
      `(function () {
         var felder = [...document.querySelectorAll('#plots .plot')];
         var frei = felder.find(function (p) {
           var s = (p.querySelector('.status') || {}).textContent || '';
           if (/→/.test(s) || / oder /.test(s)) return true;
           var al = p.getAttribute('aria-label') || '';
           return /^Feld [0-9]/.test(al) && !p.classList.contains('ripe') && !p.querySelector('.bar');
         });
         if (frei) return 'frei';
         var reif = felder.find(function (p) {
           return /^Feld [0-9]/.test(p.getAttribute('aria-label') || '') && p.classList.contains('ripe');
         });
         if (reif) { reif.click(); return 'geerntet'; }
         return 'warten';
       })()`,
    );
    if (lage === 'frei') return true;
    await sleep(lage === 'geerntet' ? 400 : 1000);
  }
  return false;
}

async function plantSomething(cdp: Cdp): Promise<boolean> {
  await evaluate(cdp, `document.getElementById('brett-close') && (document.getElementById('brett-bg').hidden = true, document.getElementById('lager-bg').hidden = true, document.getElementById('stand-bg').hidden = true)`);
  await sleep(200);

  if (!(await warteAufFreiesFeld(cdp))) return false;

  const clicked = await evaluate<boolean>(
    cdp,
    `(function () {
       var tile = [...document.querySelectorAll('#plots .plot')].find(function (p) {
         var s = (p.querySelector('.status') || {}).textContent || '';
         if (/→/.test(s) || / oder /.test(s)) return true;
         var al = p.getAttribute('aria-label') || '';
         return /^Feld [0-9]/.test(al) && !p.classList.contains('ripe') && !p.querySelector('.bar');
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
let browserCdp: Cdp | null = null;
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

  browserCdp = await Cdp.connect(wsUrl);
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
  const _hb = (await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()) as { offers: number };
  check('Der Auftrag steht im Buch', _hb.offers === 1, `offers=${_hb.offers}`);

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

  // Der neue Hof bekommt die Einführung sofort und ganz oben (z-Index über allem).
  // Danach im Test wegklicken, damit die weiteren Schritte an den Hof herankommen.
  await sleep(250);
  const tutAuf = await evaluate<boolean>(
    cdp,
    `!!document.getElementById('tut-bg') && !document.getElementById('tut-bg').hidden`,
  );
  check('Ein neuer Hof bekommt sofort die Einführung', tutAuf, String(tutAuf));
  await evaluate(cdp, `(function(){ var s=document.getElementById('tut-skip'); if (s) s.click(); })()`);
  await sleep(150);

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
         imBild: (function () {
           var felder = [...document.querySelectorAll('#plots .plot')].filter(function (t) {
             var n = t.querySelector('.name');
             return n && n.textContent.indexOf('Feld') === 0;
           }).map(function (t) { return t.getBoundingClientRect(); });
           return felder.length > 0 && felder.every(function (r) {
             return r.left >= rahmen.left - 1 && r.right <= rahmen.right + 1
               && r.top >= rahmen.top - 1 && r.bottom <= rahmen.bottom + 1;
           });
         })(),
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
  await meldungenMitschneiden(cdp);

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
  const goldVorErnte = await evaluate<number>(cdp, `Number(document.getElementById('gold').textContent)`);
  await evaluate(cdp, `document.querySelector('#plots .plot.ripe').click()`);
  await sleep(90);
  // Die Ernte fliegt als Bild ins Lager — nicht nur als Zahl nach oben.
  const ernteFlug = JSON.parse(
    await evaluate<string>(
      cdp,
      `JSON.stringify((function () {
         var f = [...document.querySelectorAll('.flieger.ware')];
         var lager = document.getElementById('silo').getBoundingClientRect();
         return {
           xp: document.querySelectorAll('.flieger.xp').length,
           anzahl: f.length,
           bilder: f.filter(function (x) { return !!x.querySelector('img.ic'); }).length,
           zielOben: f.every(function (x) {
             var dy = parseFloat(getComputedStyle(x).getPropertyValue('--dy'));
             return dy < 0;
           }),
           lagerDa: lager.width > 0,
         };
       })())`,
    ),
  ) as { xp: number; anzahl: number; bilder: number; zielOben: boolean; lagerDa: boolean };
  check(
    'Auch die XP fliegen — als Funke zum Ring oben',
    ernteFlug.xp > 0,
    `${ernteFlug.xp} Funke(n)`,
  );
  check(
    'Die Ernte fliegt als Bild ins Lager, nicht nur als Zahl nach oben',
    ernteFlug.anzahl > 0 && ernteFlug.bilder === ernteFlug.anzahl && ernteFlug.zielOben && ernteFlug.lagerDa,
    `${ernteFlug.anzahl} Flieger, ${ernteFlug.bilder} mit Bild, Richtung Lager ${ernteFlug.zielOben}`,
  );

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

  // Fundstuecke: Was die Sim in den Acker legt, muss die Oberflaeche genauso
  // melden — und nie etwas erfinden. Weizen bringt kein Gold; steigt es
  // trotzdem, war das ein Fund, und der muss in der Meldung stehen. Steht ein
  // Gold-Fund in der Meldung, muss genau diese Summe angekommen sein.
  const ernteMeldung = await evaluate<string>(cdp, `document.getElementById('toast').textContent`);
  const goldNachErnte = await evaluate<number>(cdp, `Number(document.getElementById('gold').textContent)`);
  const goldDazu = goldNachErnte - goldVorErnte;
  const fundGold = /Fund: (\d+) Gold/.exec(ernteMeldung);
  const fundGenannt = /Fund:/.test(ernteMeldung);
  check(
    'Ein Fund beim Ernten wird genannt — und nur dann, wenn er wirklich kam',
    (goldDazu > 0 ? fundGenannt : true) && (fundGold ? goldDazu === Number(fundGold[1]) : true),
    `${ernteMeldung} · Gold ${goldVorErnte} → ${goldNachErnte}`,
  );

  check(
    'Ernten geht mit einem Tipp auf den Platz',
    afterHarvest > beforeHarvest,
    `${beforeHarvest} → ${afterHarvest} Weizen`,
  );

  // Ernten im Zug: über mehrere reife Plätze wischen erntet sie alle auf einmal
  // — und meldet das EINMAL, nicht einmal pro Platz. Der Zug wird mit echten
  // Zeigerereignissen gefahren, sonst prüft man nur den eigenen Testcode.
  await api('/api/admin/time?seconds=4000', 'POST');
  await evaluate(cdp, `window.dispatchEvent(new Event('online'))`);
  await sleep(1200);

  const reifePunkte = await evaluate<string>(
    cdp,
    `JSON.stringify([...document.querySelectorAll('#plots .plot.ripe')]
       .map(function (t) {
         var r = t.getBoundingClientRect();
         return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
       })
       .sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); }))`,
  );
  const punkte = JSON.parse(reifePunkte) as Array<{ x: number; y: number }>;

  if (punkte.length >= 2) {
    const weizenVorZug = await stockOf('Weizen');
    const maus = (type: string, x: number, y: number) =>
      cdp.send('Input.dispatchMouseEvent', {
        type,
        x: Math.round(x),
        y: Math.round(y),
        button: 'left',
        buttons: type === 'mouseReleased' ? 0 : 1,
        clickCount: 1,
        pointerType: 'mouse',
      });

    await maus('mousePressed', punkte[0].x, punkte[0].y);
    await sleep(40);
    for (let k = 1; k < punkte.length; k++) {
      const a = punkte[k - 1];
      const z = punkte[k];
      for (let t = 1; t <= 6; t++) {
        await maus('mouseMoved', a.x + ((z.x - a.x) * t) / 6, a.y + ((z.y - a.y) * t) / 6);
        await sleep(16);
      }
    }
    await maus('mouseReleased', punkte[punkte.length - 1].x, punkte[punkte.length - 1].y);
    await sleep(900);

    const weizenNachZug = await stockOf('Weizen');
    const meldung = await evaluate<string>(cdp, `document.getElementById('toast').textContent`);
    const nochReif = await evaluate<number>(cdp, `document.querySelectorAll('#plots .plot.ripe').length`);

    check(
      'Über reife Felder wischen erntet sie alle auf einmal',
      weizenNachZug > weizenVorZug && nochReif < punkte.length,
      `${punkte.length} reif → ${nochReif} übrig, Weizen ${weizenVorZug} → ${weizenNachZug}`,
    );
    check(
      'Der Zug meldet sich einmal als Zug, nicht einmal pro Platz',
      /Pl(ä|a)tze geerntet/.test(meldung),
      meldung,
    );
    check(
      'Nach dem Wischen geht kein Auswahlblatt auf',
      await evaluate<boolean>(cdp, `document.getElementById('pick-bg').hidden`),
      'Blatt zu',
    );
  } else {
    check(
      'Über reife Felder wischen erntet sie alle auf einmal',
      false,
      `nur ${punkte.length} reife Felder — Zug nicht prüfbar`,
    );
  }


  const obenauf = await evaluate<string>(
    cdp,
    `(function () {
       var tile = [...document.querySelectorAll('#plots .plot')].find(function (t) {
         var s = (t.querySelector('.status') || {}).textContent || '';
         if (/→/.test(s) || / oder /.test(s)) return true;
         var al = t.getAttribute('aria-label') || '';
         return /^Feld [0-9]/.test(al) && !t.classList.contains('ripe') && !t.querySelector('.bar');
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

  // Die andere Hälfte: über leere Felder wischen setzt überall dasselbe an.
  // Das darf aber ERST greifen, wenn einmal bewusst gewählt wurde — Ernten ist
  // reiner Gewinn, Säen kostet Saatgut, und wer nur schwenken will, soll nicht
  // ungewollt aussäen.
  const maus = (type: string, x: number, y: number) =>
    cdp.send('Input.dispatchMouseEvent', {
      type, x: Math.round(x), y: Math.round(y), button: 'left',
      buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse',
    });
  const mausZug = async (pts: Array<{ x: number; y: number }>) => {
    await maus('mousePressed', pts[0]!.x, pts[0]!.y);
    await sleep(40);
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1]!;
      const z = pts[k]!;
      for (let t = 1; t <= 6; t++) {
        await maus('mouseMoved', a.x + ((z.x - a.x) * t) / 6, a.y + ((z.y - a.y) * t) / 6);
        await sleep(16);
      }
    }
    await maus('mouseReleased', pts[pts.length - 1]!.x, pts[pts.length - 1]!.y);
    await sleep(800);
  };
  const leereFelder = async () =>
    JSON.parse(
      await evaluate<string>(cdp, `JSON.stringify(
        [...document.querySelectorAll('#plots .plot[data-platz]')]
          .filter(function (t) {
            var a = t.getAttribute('aria-label') || '';
            return /^Feld /.test(a) && !t.classList.contains('ripe') && !t.querySelector('.bar');
          })
          .map(function (t) { var r = t.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })
          .sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); }))`),
    ) as Array<{ x: number; y: number }>;

  // Gemerkte Sorte löschen und neu laden: der Zustand eines Spielers, der noch
  // nie bewusst gewählt hat.
  await evaluate(cdp, `(function () { try {
    Object.keys(localStorage).forEach(function (k) {
      if (k.indexOf('ns-saat') === 0) localStorage.removeItem(k);
    });
  } catch (e) {} })()`);
  await cdp.send('Page.reload', { ignoreCache: false });
  await sleep(3000);
  await schliesseTutorial(cdp);
  await meldungenMitschneiden(cdp);

  const ohneWahl = await leereFelder();
  if (ohneWahl.length >= 2) {
    const vorher = await evaluate<number>(cdp, `document.querySelectorAll('#plots .plot .bar').length`);
    await mausZug(ohneWahl);
    const nachher = await evaluate<number>(cdp, `document.querySelectorAll('#plots .plot .bar').length`);
    check(
      'Ohne vorherige Wahl sät ein Wisch nichts — Saatgut wird nicht verschenkt',
      nachher === vorher,
      `${vorher} → ${nachher} laufende Felder`,
    );
  }

  // Einmal bewusst wählen, dann wischen.
  await evaluate(cdp, `(function () {
    var t = [...document.querySelectorAll('#plots .plot[data-platz]')].find(function (x) {
      return /^Feld /.test(x.getAttribute('aria-label') || '');
    });
    if (t) t.click();
  })()`);
  await sleep(400);
  const sorte = await evaluate<string>(cdp, `(function () {
    var o = document.querySelector('#pick-list .opt:not([disabled])');
    var n = o ? o.querySelector('.top').textContent.trim() : '-';
    if (o) o.click();
    var c = document.getElementById('pick-close');
    if (c && !document.getElementById('pick-bg').hidden) c.click();
    return n;
  })()`);
  await sleep(700);
  await schliesseTutorial(cdp);

  const nachWahl = await leereFelder();
  if (nachWahl.length >= 1) {
    const vor = await evaluate<number>(cdp, `document.querySelectorAll('#plots .plot .bar').length`);
    await mausZug(nachWahl);
    const nach = await evaluate<number>(cdp, `document.querySelectorAll('#plots .plot .bar').length`);
    const meldung = await evaluate<string>(cdp, `document.getElementById('toast').textContent`);
    check(
      'Nach der Wahl sät ein Wisch alle leeren Felder mit derselben Sorte an',
      nach > vor && /angesetzt/.test(meldung),
      `${vor} → ${nach} laufende Felder · ${meldung} (gewählt: ${sorte})`,
    );
  }


  // „Als Naechstes": Unter dem Hof steht immer ein Grund zu bleiben. Die
  // Leiste liegt im Fluss, nicht ueber dem Hof — und Antippen bringt einen hin.
  const leiste = JSON.parse(
    await evaluate<string>(
      cdp,
      `JSON.stringify((function () {
         var k = document.getElementById('naechstes');
         var hof = document.getElementById('hof').getBoundingClientRect();
         var r = k.getBoundingClientRect();
         var ueberlappt = !k.hidden && r.top < hof.bottom && r.bottom > hof.top
           && r.left < hof.right && r.right > hof.left;
         return {
           da: !k.hidden,
           text: (document.getElementById('naechstes-text').textContent || '').trim(),
           ueberlappt: ueberlappt,
           imBild: r.bottom <= window.innerHeight && r.width > 0,
         };
       })())`,
    ),
  ) as { da: boolean; text: string; ueberlappt: boolean; imBild: boolean };
  check(
    'Unter dem Hof steht, was als Nächstes dran ist',
    leiste.da && leiste.text.length > 0,
    leiste.text,
  );
  // Wetter: Was der Himmel zeigt, ist das, was wirkt — Regen am Himmel genau
  // dann, wenn die Regenzeile unter dem Hof steht. Erzwingen laesst sich der
  // Regen nicht (er kommt aus dem Tick), aber die beiden muessen uebereinstimmen.
  const wetterLage = JSON.parse(
    await evaluate<string>(
      cdp,
      `JSON.stringify({
         regenAmHimmel: document.getElementById('wetter').className.indexOf('regen') >= 0,
         zeile: !document.getElementById('wetterzeile').hidden,
         text: document.getElementById('wetterzeile').textContent,
       })`,
    ),
  ) as { regenAmHimmel: boolean; zeile: boolean; text: string };
  check(
    'Der Regen am Himmel ist der Regen, der wirkt — Himmel und Regenzeile stimmen überein',
    wetterLage.regenAmHimmel === wetterLage.zeile && (!wetterLage.zeile || /schneller/.test(wetterLage.text)),
    wetterLage.zeile ? wetterLage.text : `kein Regen gerade (Himmel: ${wetterLage.regenAmHimmel})`,
  );

  check(
    'Die Leiste liegt unter dem Hof, nicht darüber — sie verdeckt keinen Platz',
    leiste.da && !leiste.ueberlappt && leiste.imBild,
    leiste.ueberlappt ? 'überlappt den Hof' : 'frei',
  );

  const vorSprung = await evaluate<string>(cdp, `document.getElementById('welt').style.transform`);
  await evaluate(cdp, `document.getElementById('naechstes').click()`);
  await sleep(300);
  const nachSprung = JSON.parse(
    await evaluate<string>(
      cdp,
      `JSON.stringify({
         transform: document.getElementById('welt').style.transform,
         markiert: !!document.querySelector('#plots .plot.zeigt'),
         blatt: [...document.querySelectorAll('.sheet-bg')].some(function (b) { return !b.hidden; }),
       })`,
    ),
  ) as { transform: string; markiert: boolean; blatt: boolean };
  check(
    'Antippen bringt einen hin: Die Kamera fährt zum Platz, und der meldet sich',
    nachSprung.markiert || nachSprung.blatt || nachSprung.transform !== vorSprung,
    nachSprung.markiert ? 'Platz markiert' : nachSprung.blatt ? 'Blatt auf' : 'Kamera bewegt',
  );

  // Die Serie: „Tag N in Folge" gehoert in den Kopf, nicht hinter ein Blatt.
  const serie = JSON.parse(
    await evaluate<string>(
      cdp,
      `JSON.stringify((function () {
         var c = document.getElementById('serie');
         var r = c.getBoundingClientRect();
         var kopf = document.querySelector('.topbar').getBoundingClientRect();
         var andere = [...document.querySelectorAll('.topbar .coins, .topbar .silo, .topbar .pfad-auf')]
           .map(function (e) { return e.getBoundingClientRect(); });
         var stoesst = andere.some(function (a) {
           return r.left < a.right - 1 && r.right > a.left + 1 && r.top < a.bottom - 1 && r.bottom > a.top + 1;
         });
         return {
           da: !c.hidden,
           tage: Number(document.getElementById('serie-tage').textContent),
           stoesst: stoesst,
           imKopf: r.right <= kopf.right + 1 && r.left >= kopf.left - 1,
         };
       })())`,
    ),
  ) as { da: boolean; tage: number; stoesst: boolean; imKopf: boolean };
  check(
    'Die Serie steht im Kopf des Hofs — mit ihrer Tageszahl',
    serie.da && serie.tage >= 1,
    `Tag ${serie.tage}`,
  );
  check(
    'Sie drängt weder Gold noch Lager aus der Zeile',
    serie.da && !serie.stoesst && serie.imKopf,
    serie.stoesst ? 'stößt an' : serie.imKopf ? 'passt' : 'ragt heraus',
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

  // Der Großteil des (nun doppelt breiten UND doppelt hohen) Hofs ist gesperrt:
  // 8 alte Felder (w1–w6, m1, m2) + 8 rechts (n1–n8) + 16 unten (u1–u16) = 32.
  const sperren = await evaluate<{ anzahl: number; text: string }>(
    cdp,
    `(function () {
       var s = [...document.querySelectorAll('#erweiterungen .feld-sperre')];
       return { anzahl: s.length, text: s.map(function (x) { return x.textContent; }).join(' | ') };
     })()`,
  );
  check(
    'Der weitaus größte Teil des Hofs liegt in gesperrten Feldern, samt Bergen',
    sperren.anzahl === 32,
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

  // Erst den Hof bereit machen, dann die Uhr starten — sonst misst die Prüfung
  // das Warten auf ein freies Feld statt den Weg zum Server.
  await warteAufFreiesFeld(cdp);
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
  // Zutaten muessen ueberall sichtbar sein, wo es ein Rezept gibt — mit Bild,
  // Bedarf und, wenn etwas fehlt, dem tatsaechlichen Lagerstand.
  const zutatenImPicker = await evaluate<string>(
    cdp,
    `(function () {
       var muehle = [...document.querySelectorAll('#plots .plot')].find(function (t) {
         return /^Mühle/.test(t.getAttribute('aria-label') || '');
       });
       if (!muehle) return 'keine Mühle';
       muehle.click();
       if (document.getElementById('pick-bg').hidden) return 'Blatt blieb zu';
       var karte = [...document.querySelectorAll('#pick-list .opt')].find(function (o) {
         return o.querySelector('.zutaten');
       });
       if (!karte) return 'keine Karte mit Zutaten';
       var chips = [...karte.querySelectorAll('.zutat')].map(function (z) {
         return { text: z.textContent.trim(), bild: !!z.querySelector('img.ic'), fehlt: z.classList.contains('fehlt') };
       });
       document.getElementById('pick-close').click();
       return JSON.stringify(chips);
     })()`,
  );
  check(
    'Im Rezept-Menü steht jede Zutat mit Bild und Menge',
    /"bild":true/.test(zutatenImPicker) && /\u00d7 /.test(zutatenImPicker),
    zutatenImPicker,
  );

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

  // Bug-Schutz: Stall mit lauter Küken bleibt anklickbar
  await evaluate(cdp, `document.getElementById('pick-close').click()`);
  await sleep(200);
  const jungKlick = await evaluate<{ disabled: boolean; guiAuf: boolean }>(
    cdp,
    `(function () {
       var t = ${stallTile};
       var disabled = !t || t.disabled;
       if (t && !t.disabled) t.click();
       return { disabled: !!disabled, guiAuf: !document.getElementById('pick-bg').hidden };
     })()`,
  );
  check(
    'Der Stall bleibt anklickbar, auch wenn nur Küken drin sind',
    !jungKlick.disabled && jungKlick.guiAuf,
    `disabled=${jungKlick.disabled}, GUI offen=${jungKlick.guiAuf}`,
  );
  await sleep(150);

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
  await sleep(120);
  // Der Lohn des Wagens kommt sofort — und soll auch sofort zu sehen sein:
  // Muenzen steigen vom Zettel auf, ueber dem Blatt, nicht dahinter.
  const wagenLohn = JSON.parse(
    await evaluate<string>(
      cdp,
      `JSON.stringify((function () {
         var f = [...document.querySelectorAll('.flug')];
         var m = f.find(function (x) { return x.className.indexOf('muenzen') >= 0; });
         var blatt = document.getElementById('brett-bg').getBoundingClientRect();
         var r = m ? m.getBoundingClientRect() : null;
         var flieger = [...document.querySelectorAll('.flieger.muenzen')];
         var beutel = document.querySelector('.coins').getBoundingClientRect();
         return {
           flieger: flieger.length,
           fliegerBild: flieger.filter(function (x) { return !!x.querySelector('img.ic'); }).length,
           fliegerZiel: flieger.every(function (x) {
             var r = x.getBoundingClientRect();
             var dx = parseFloat(getComputedStyle(x).getPropertyValue('--dx'));
             var dy = parseFloat(getComputedStyle(x).getPropertyValue('--dy'));
             return Math.abs((r.left + r.width / 2 + dx) - (beutel.left + beutel.width / 2)) < 40
               && Math.abs((r.top + r.height / 2 + dy) - (beutel.top + beutel.height / 2)) < 40;
           }),
           muenzen: !!m, text: m ? m.textContent : '',
           xp: f.some(function (x) { return x.className.indexOf('xp') >= 0; }),
           sichtbar: !!r && r.top >= blatt.top - 1 && r.bottom <= blatt.bottom + 1 && r.width > 0,
           obenauf: !!m && Number(getComputedStyle(m).zIndex) > Number(getComputedStyle(document.getElementById('brett-bg')).zIndex),
         };
       })())`,
    ),
  ) as {
    flieger: number; fliegerBild: number; fliegerZiel: boolean;
    muenzen: boolean; text: string; xp: boolean; sichtbar: boolean; obenauf: boolean;
  };
  check(
    'Die Münzen fliegen als Bild in den Geldbeutel oben — und genau dorthin',
    wagenLohn.flieger > 0 && wagenLohn.fliegerBild === wagenLohn.flieger && wagenLohn.fliegerZiel,
    `${wagenLohn.flieger} Münzen unterwegs, Ziel stimmt ${wagenLohn.fliegerZiel}`,
  );
  check(
    'Beim Abschicken steigen die Münzen vom Zettel auf — vor dem Blatt, nicht dahinter',
    wagenLohn.muenzen && wagenLohn.obenauf && wagenLohn.sichtbar,
    `${wagenLohn.text}${wagenLohn.xp ? ' + XP' : ''} · obenauf ${wagenLohn.obenauf}`,
  );
  await sleep(400);
  check(
    'Kurz nach dem Motor klingelt die Kasse: Der Geldbeutel oben hüpft',
    await evaluate<boolean>(cdp, `document.querySelector('.coins').classList.contains('huepft')`),
    'huepft',
  );
  await sleep(180);

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

  // Genau jetzt steht der Wagen auf dem Hof — der einzige Moment, in dem sich
  // ein Zusammenstoss in der Möbelreihe zeigt. Wagen und Kiste sind sonst
  // versteckt, ein neues Möbel auf ihrer Spalte fiele erst im Spiel auf.
  const moebelStoss = await evaluate<string[]>(cdp, `(function () {
    var ids = ['nachbarn', 'brett', 'lagerhaus', 'stand', 'wagen', 'kiste', 'abenteuer', 'boot'];
    var sicht = ids
      .map(function (id) { return { id: id, el: document.getElementById(id) }; })
      .filter(function (m) { return m.el && !m.el.hidden && m.el.getBoundingClientRect().width > 0; })
      .map(function (m) { var r = m.el.getBoundingClientRect(); return { id: m.id, r: r }; });
    var stoss = [];
    for (var i = 0; i < sicht.length; i++) {
      for (var j = i + 1; j < sicht.length; j++) {
        var a = sicht[i].r, b = sicht[j].r;
        // Die Körper ragen nach oben über ihren Standplatz; unten sitzen sie
        // auf. Deshalb zählt die Überdeckung erst, wenn sie deutlich ist.
        var breit = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        var hoch = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (breit > 8 && hoch > 8) {
          stoss.push(sicht[i].id + ' × ' + sicht[j].id + ' (' + Math.round(breit) + 'x' + Math.round(hoch) + 'px)');
        }
      }
    }
    return stoss;
  })()`);
  check(
    'Kein Möbel auf dem Hof verdeckt ein anderes — auch der Wagen nicht',
    moebelStoss.length === 0,
    moebelStoss.length === 0 ? 'alle Spalten frei' : moebelStoss.join('; '),
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

  // Der Moment, was drin war: Sobald der Abgleich die Beute bringt, geht die
  // Karte auf und zeigt genau die Stuecke, die im Postfach gelandet sind.
  const beute = nachKiste.state.mail.slice(vorKiste.state.mail.length);
  const karte = JSON.parse(
    await evaluate<string>(
      cdp,
      `JSON.stringify((function () {
         var k = document.getElementById('kiste-feier');
         return {
           auf: !k.hidden,
           zeilen: [...document.querySelectorAll('#kiste-beute .zeile')]
             .map(function (z) { return z.textContent.trim(); }),
           bild: !!document.querySelector('#kiste-bild svg'),
           knopf: (document.getElementById('kiste-weiter') || {}).textContent || '',
         };
       })())`,
    ),
  ) as { auf: boolean; zeilen: string[]; bild: boolean; knopf: string };
  check(
    'Die Kiste enthüllt ihre Beute — als Moment, nicht als Karte im Postfach',
    karte.auf && karte.bild && karte.zeilen.length === beute.length && karte.zeilen.length > 0,
    `${karte.zeilen.join(' | ')} (Postfach: ${beute.length} Stück)`,
  );

  const goldVorEinpacken = await evaluate<number>(cdp, `Number(document.getElementById('gold').textContent)`);
  const goldInBeute = beute.filter((b) => b.item === 0).reduce((n, b) => n + b.amount, 0);
  await evaluate(cdp, `document.getElementById('kiste-weiter').click()`);
  await sleep(1500);
  const eingepackt = (await api(`/api/admin/status?account=${status.accountId}`)) as {
    state: { mail: unknown[] };
  };
  const goldNachEinpacken = await evaluate<number>(cdp, `Number(document.getElementById('gold').textContent)`);
  check(
    '„Einpacken" holt die Beute aus dem Postfach ins Lager — Gold in den Geldbeutel',
    eingepackt.state.mail.length < nachKiste.state.mail.length &&
      goldNachEinpacken === goldVorEinpacken + goldInBeute &&
      (await evaluate<boolean>(cdp, `document.getElementById('kiste-feier').hidden`)),
    `Postfach ${nachKiste.state.mail.length} → ${eingepackt.state.mail.length} · Gold ${goldVorEinpacken} → ${goldNachEinpacken}`,
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

  const sfxRegler = await evaluate<string>(
    cdp,
    `(function () {
       document.getElementById('zahnrad').click();
       var r = document.getElementById('sfx-regler');
       r.value = '0';
       r.dispatchEvent(new Event('input', { bubbles: true }));
       var wert = document.getElementById('sfx-wert').textContent;
       var gemerkt = localStorage.getItem('ns-sfx');
       document.getElementById('rest-close').click();
       return wert + '/' + gemerkt;
     })()`,
  );
  check(
    'Der Soundeffekt-Regler wirkt und das Gerät merkt sich den Wert',
    sfxRegler === '0%/0',
    sfxRegler,
  );

  const musikRegler = await evaluate<string>(
    cdp,
    `(function () {
       document.getElementById('zahnrad').click();
       var r = document.getElementById('musik-regler');
       r.value = '40';
       r.dispatchEvent(new Event('input', { bubbles: true }));
       var wert = document.getElementById('musik-wert').textContent;
       var gemerkt = localStorage.getItem('ns-musik-vol');
       document.getElementById('rest-close').click();
       return wert + '/' + gemerkt;
     })()`,
  );
  check(
    'Der Musik-Regler wirkt und das Gerät merkt sich den Wert',
    musikRegler === '40%/40',
    musikRegler,
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
         raster: !!document.getElementById('scene').innerHTML.match(/m-gras/),
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
       // Nur die echten (nicht gesperrten) Hindernisse — die grauen Vorschauen
       // im gesperrten Land tragen '.verborgen'.
       var arten = [...document.querySelectorAll('#hindernisse .hindernis:not(.verborgen)')]
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
       return document.getElementById('besuch-leiste').hidden ? 'nichts passiert' : 'unterwegs';
     })()`,
  );
  await sleep(1500);
  const beimNachbarn = await evaluate<string>(
    cdp,
    `(function () {
       document.getElementById('stand').click();
       return document.getElementById('fremdstand-titel').textContent + '|' +
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
  await evaluate(cdp, `document.getElementById('besuch-zurueck').click()`);
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

  const eigenePlaetze = await evaluate<string>(
    cdp,
    `[...document.querySelectorAll('#plots .plot')].map(function (p) { return p.getAttribute('data-platz'); }).join(',')`,
  );
  await evaluate(cdp, `document.querySelector('#freundeliste .nachbar .go').click()`);
  await sleep(1500);
  const besuchBild = await evaluate<{
    titel: string;
    plots: number;
    plaetze: string;
    boden: boolean;
    hindernisse: number;
    standKnopf: boolean;
    offen: boolean;
    blatt: boolean;
    eigeneMoebel: boolean;
    bauen: boolean;
    fremd: boolean;
  }>(
    cdp,
    `(function () {
       var hof = document.getElementById('hof');
       var hammer = document.getElementById('bauen');
       return {
         titel: document.getElementById('besuch-name').textContent,
         plots: document.querySelectorAll('#plots .plot').length,
         plaetze: [...document.querySelectorAll('#plots .plot')].map(function (p) { return p.getAttribute('data-platz'); }).join(','),
         boden: document.getElementById('scene').childElementCount > 0,
         hindernisse: document.querySelectorAll('#hindernisse .hindernis').length,
         standKnopf: !document.getElementById('stand').hidden && !document.getElementById('stand').disabled &&
           /Sein Stand/.test(document.getElementById('stand').getAttribute('aria-label') || ''),
         offen: !document.getElementById('besuch-leiste').hidden,
         blatt: [...document.querySelectorAll('.sheet-bg')].every(function (b) { return b.hidden; }),
         eigeneMoebel: !document.getElementById('lagerhaus').hidden || !document.getElementById('brett').hidden,
         bauen: hammer.offsetParent !== null,
         fremd: hof.classList.contains('besuch'),
       };
     })()`,
  );
  check(
    'Der Besuch zeigt seinen ganzen Hof im Hof selbst — kein Blatt, kein Vorschaubild: Landschaft, Hindernisse, Gebäude',
    besuchBild.offen && besuchBild.blatt && besuchBild.fremd && besuchBild.titel === 'Bens Bauernhof' && besuchBild.plots > 0 &&
      besuchBild.boden && besuchBild.hindernisse > 0 && besuchBild.plaetze !== eigenePlaetze,
    `Leiste ${besuchBild.offen} · Blätter zu ${besuchBild.blatt} · ${besuchBild.plots} Plätze (eigene: ${eigenePlaetze.split(',').length}) · Hindernisse ${besuchBild.hindernisse}`,
  );
  // Fuer den Blick von aussen: ein Bild des Besuchs, wenn ein Ordner genannt ist.
  if (process.env.NS_FOTOS) {
    const foto = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
    (await import('node:fs')).writeFileSync(join(process.env.NS_FOTOS, 'besuch.png'), Buffer.from(foto.data, 'base64'));
  }
  check(
    'Zu Besuch weichen die eigenen Möbel und der Bauhammer — sein Stand steht da und will angetippt werden',
    besuchBild.standKnopf && !besuchBild.eigeneMoebel && !besuchBild.bauen,
    `Stand ${besuchBild.standKnopf} · eigene Möbel ${besuchBild.eigeneMoebel} · Hammer ${besuchBild.bauen}`,
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
       var kachel = [...document.querySelectorAll('#plots .plot.hilfe')]
         .find(function (p) { return !p.disabled; });
       if (!kachel) return 'nichts zu tun: ' +
         [...document.querySelectorAll('#plots .plot')]
           .map(function (p) { return p.getAttribute('aria-label'); }).join(' / ');
       kachel.click();
       return 'getippt';
     })()`,
  );
  await sleep(1800);
  const nachHilfe = await evaluate<string>(
    cdp,
    `document.getElementById('toast').textContent + '|' +
     (document.getElementById('besuch-hilfen') || { ariaLabel: 'keine' }).ariaLabel`,
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

  await evaluate(cdp, `document.getElementById('stand').click()`);
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
    `!document.getElementById('besuch-leiste').hidden
       && document.getElementById('fremdstand-bg').hidden`,
  );
  check('Nach dem Kauf steht man wieder auf seinem Hof', zurueckAufHof);

  // Nur zum Schauen: Wischen erntet nichts, gesperrtes Land ist stumm.
  const nurSchauen = await evaluate<{ sperren: number; stumm: number; hilfeFrei: number }>(
    cdp,
    `(function () {
       var sperren = [...document.querySelectorAll('#erweiterungen .feld-sperre')];
       return {
         sperren: sperren.length,
         stumm: sperren.filter(function (b) { return b.disabled; }).length,
         hilfeFrei: [...document.querySelectorAll('#plots .plot')].filter(function (p) { return !p.disabled && !p.classList.contains('hilfe'); }).length,
       };
     })()`,
  );
  check(
    'Auf dem fremden Hof ist alles nur zum Schauen: gesperrtes Land stumm, antippbar nur, wo man helfen kann',
    nurSchauen.sperren === nurSchauen.stumm,
    `${nurSchauen.stumm} von ${nurSchauen.sperren} Sperren stumm · ${nurSchauen.hilfeFrei} andere antippbar`,
  );

  await evaluate(cdp, `document.getElementById('besuch-zurueck').click()`);
  await sleep(700);
  const wiederDaheim = await evaluate<{ leiste: boolean; plaetze: string; moebel: boolean; fremd: boolean }>(
    cdp,
    `(function () {
       return {
         leiste: document.getElementById('besuch-leiste').hidden,
         plaetze: [...document.querySelectorAll('#plots .plot')].map(function (p) { return p.getAttribute('data-platz'); }).join(','),
         moebel: !document.getElementById('lagerhaus').hidden && !document.getElementById('brett').hidden,
         fremd: document.getElementById('hof').classList.contains('besuch'),
       };
     })()`,
  );
  check(
    'Zurück heißt zurück: der eigene Hof mit eigenen Plätzen und Möbeln',
    wiederDaheim.leiste && wiederDaheim.moebel && !wiederDaheim.fremd && wiederDaheim.plaetze === eigenePlaetze,
    `Leiste zu ${wiederDaheim.leiste} · Möbel ${wiederDaheim.moebel} · Plätze gleich ${wiederDaheim.plaetze === eigenePlaetze}`,
  );

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
       besuch: !document.getElementById('besuch-leiste').hidden,
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

  console.log('\n9j. Verkauft! — ein anderer kauft im eigenen Stand, während man spielt');

  // Wir stellen Weizen in den Stand — durch die Oberflaeche, wie ein Spieler.
  await evaluate(cdp, `document.getElementById('stand').click()`);
  await sleep(400);
  const kaestchenFrei = await evaluate<boolean>(
    cdp,
    `(function () {
       var k = document.querySelector('#stand-kaesten .kaestchen.leer');
       if (!k) return false;
       k.click();
       return true;
     })()`,
  );
  if (kaestchenFrei) {
    await sleep(300);
    await evaluate(
      cdp,
      `(function () {
         var w = [...document.querySelectorAll('#stand-fuellen .kaestchen.wahl')]
           .find(function (b) { return b.textContent.indexOf('Weizen') >= 0; });
         if (w) w.click();
       })()`,
    );
    await sleep(300);
    // Preis wie ein Spieler waehlen (Schnellknopf), dann hinstellen.
    const hingestellt = await evaluate<string>(
      cdp,
      `(function () {
         var g = [...document.querySelectorAll('#stand-fuellen button')]
           .find(function (b) { return /günstig/i.test(b.textContent); });
         if (g) g.click();
         var d = document.querySelector('#stand-fuellen .done');
         if (!d) return 'kein Hinstellen-Knopf';
         if (d.disabled) return 'Knopf gesperrt: ' + d.textContent;
         d.click();
         return 'ok';
       })()`,
    );
    await sleep(500);
    console.log('  Stand:', hingestellt);
  } else {
    console.log('  Stand: kein leeres Kästchen');
  }
  await evaluate(cdp, `document.getElementById('stand-close').click()`);
  await sleep(2500);
  const unsereOrders = (await api(`/api/admin/status?account=${status.accountId}`)) as {
    state: { orders: Array<{ id: number; verkauft: number }> };
  };
  console.log('  Unsere Kästchen beim Server:', unsereOrders.state.orders.length);

  // Der Nachbar sieht das Angebot und kauft es — als eigenes Konto, direkt
  // beim Server, so wie es sein Telefon taete.
  const markt = (await stateAs(second.key)) as unknown as {
    snapshot: { seq: number; serverTs: number; state: { tick: number; offers: Array<{ id: number; seller: string }> } };
  };
  // Im Regal steht der Hofcode als Verkaeufer, nicht die Kontonummer.
  const eigenerCode = hofkarte.split('|')[1] ?? '';
  const unserAngebot = markt.snapshot.state.offers.find((o) => o.seller === eigenerCode);
  console.log('  Regal des Nachbarn:', markt.snapshot.state.offers.map((o) => o.seller).join(', ') || 'leer', '· wir:', eigenerCode);
  check(
    'Was man in den Stand stellt, sieht der Nachbar als Angebot',
    !!unserAngebot,
    unserAngebot ? `Angebot ${unserAngebot.id}` : `${markt.snapshot.state.offers.length} fremde Angebote, keins von uns`,
  );
  if (unserAngebot) {
    await api(`/api/admin/grant?account=${second.accountId}&item=gold&amount=500`, 'POST');
    await sleep(300);
    const vorKauf = await stateAs(second.key);
    const kaufTick = tickFuer(vorKauf.snapshot);
    const kauf = await syncAs(second.key, vorKauf.snapshot.seq, [
      { seq: vorKauf.snapshot.seq + 1, tick: kaufTick, type: 'COLLECT_MAIL' },
      { seq: vorKauf.snapshot.seq + 2, tick: kaufTick, type: 'BUY_OFFER', offerId: unserAngebot.id },
    ]);
    check('Der Nachbar kauft — der Server nimmt den Kauf an', kauf.ok === true, kauf.ok ? 'ok' : `${kauf.kind} ${kauf.reason}`);

    // Unser Hof erfaehrt davon beim naechsten Abgleich — und sagt es sofort.
    await waitFor(
      cdp,
      `[...document.querySelectorAll('.moebel#stand .badge')].length > 0`,
      'Kasse am Stand blinkt',
      15_000,
    ).catch(() => {});
    // Der Moment draengt sich vor, wartet aber, bis eine laufende Meldung
    // gelesen ist — ein paar Sekunden, nicht mehr.
    await waitFor(
      cdp,
      `JSON.parse(localStorage.getItem('${MELDUNGEN}') || '[]').some(function (m) { return /^Verkauft · Weizen/.test(m.text); })`,
      'Verkauft-Moment',
      20_000,
    ).catch(() => {});
    const verkauftMeldung = JSON.parse(
      await evaluate<string>(cdp, `localStorage.getItem('${MELDUNGEN}') || '[]'`),
    ) as Array<{ text: string; tippbar: boolean }>;
    // Gesucht ist genau dieser Kauf — nicht ein frueherer, den der Markt
    // abgerechnet hat.
    const gemeldet = verkauftMeldung.find((m) => /^Verkauft · Weizen/.test(m.text));
    check(
      'Kauft jemand im eigenen Stand, sagt es der Hof sofort — antippbar, mit dem Weg zur Kasse',
      !!gemeldet && gemeldet.tippbar && /Gold/.test(gemeldet.text),
      gemeldet ? gemeldet.text : 'nicht gemeldet (' +
        verkauftMeldung.filter((m) => /^Verkauft/.test(m.text)).map((m) => m.text).join(' | ') + ')',
    );
    check(
      'Der Stand winkt dabei',
      await evaluate<boolean>(cdp, `document.getElementById('stand').classList.contains('winkt') || !!document.querySelector('#stand .badge')`),
      'Blase oder Wink am Stand',
    );
  }

  console.log('\n9k. Booster — eine Belohnung, die das Spielen selbst verändert');

  // Beide Booster per Post schicken und einsammeln — wie ein Fund, nur sicher.
  await api(`/api/admin/grant?account=${status.accountId}&item=booster-xp&amount=1`, 'POST');
  await api(`/api/admin/grant?account=${status.accountId}&item=booster-wuchs&amount=1`, 'POST');
  // Der Nachbar hat unseren Weizen gekauft — ohne Saat gibt es nichts zu
  // beschleunigen. Ein Sack Weizen kommt mit derselben Post.
  await api(`/api/admin/grant?account=${status.accountId}&item=wheat&amount=12`, 'POST');
  await api(`/api/admin/grant?account=${status.accountId}&item=corn&amount=6`, 'POST');
  await sleep(300);
  await evaluate(cdp, `document.getElementById('lagerhaus').click()`);
  await waitFor(cdp, `document.querySelectorAll('#mail .card').length > 0`, 'Booster in der Post', 15_000);
  await evaluate(cdp, `document.querySelector('#mail .card').click()`);
  await sleep(600);
  const boosterKarten = JSON.parse(
    await evaluate<string>(
      cdp,
      `JSON.stringify([...document.querySelectorAll('#booster .booster-karte')].map(function (k) {
         return { text: k.textContent.trim().replace(/\\s+/g, ' '), bild: !!k.querySelector('img.ic'),
                  knopf: (k.querySelector('.go') || {}).textContent || '', gesperrt: !!(k.querySelector('.go') || {}).disabled };
       }))`,
    ),
  ) as Array<{ text: string; bild: boolean; knopf: string; gesperrt: boolean }>;
  check(
    'Booster liegen im Lager als Karten mit Bild, Vorrat und „Einsetzen"',
    boosterKarten.length === 2 && boosterKarten.every((k) => k.bild && /Einsetzen/.test(k.knopf)),
    boosterKarten.map((k) => k.text.slice(0, 40)).join(' | '),
  );

  // Der XP-Verdoppler: einsetzen, dann ernten — die Ernte muss doppelt zaehlen.
  const xpVorBooster = await evaluate<string>(cdp, `document.getElementById('xp').textContent`);
  await evaluate(cdp, `(function () {
    var k = [...document.querySelectorAll('#booster .booster-karte')].find(function (x) { return /Verdoppler/.test(x.textContent); });
    if (k) k.querySelector('.go').click();
  })()`);
  await sleep(500);
  const xpZeile = await evaluate<string>(cdp, `document.getElementById('xp').textContent`);
  check(
    'Eingesetzt sagt der Kopf: 2× — mit Restzeit',
    /2×/.test(xpZeile) && /noch/.test(xpZeile),
    `${xpVorBooster} → ${xpZeile}`,
  );
  await evaluate(cdp, `document.getElementById('lager-close').click()`);
  await sleep(200);

  // Die Probe aufs Exempel am Serverstand: ein Weizenfeld ansetzen, reif
  // werden lassen, ernten — die XP muessen genau das Doppelte des Rezepts sein.
  type PlotStand = { slots: Array<{ recipe: number; startedAt: number }> };
  const serverStand = async () =>
    ((await api(`/api/admin/status?account=${status.accountId}`)) as {
      state: { xp: number; tick: number; plots: PlotStand[] };
    }).state;
  const weizenXp = getRuleset(1001).recipes[0]!.xp;
  await warteAufFreiesFeld(cdp);
  const boosterGesaet = await plantSomething(cdp);
  check('Für die XP-Probe lässt sich ein Feld ansetzen', boosterGesaet, boosterGesaet ? 'angesetzt' : 'kein freies Feld');
  if (boosterGesaet) {
    // Im Dev-Regelwerk reift Weizen in Sekunden — kurz warten reicht.
    await sleep(6000);
    const vor = await serverStand();
    const weizenPlaetze = vor.plots
      .map((pl, idx) => (pl.slots.some((sl) => sl.recipe === 0) ? idx : -1))
      .filter((idx) => idx >= 0);
    const geerntet = await evaluate<number>(cdp, `(function () {
      var reif = [...document.querySelectorAll('#plots .plot.ripe')].find(function (t) {
        return ${JSON.stringify(weizenPlaetze)}.indexOf(Number(t.getAttribute('data-platz'))) >= 0;
      });
      if (!reif) return -1;
      reif.click();
      return Number(reif.getAttribute('data-platz'));
    })()`);
    await sleep(2500);
    const nach = await serverStand();
    check(
      'Mit laufendem Verdoppler bringt die Ernte genau doppelte XP — und der Server rechnet genauso',
      geerntet >= 0 && nach.xp - vor.xp === 2 * weizenXp,
      `+${nach.xp - vor.xp} XP beim Server (Rezept: ${weizenXp}, Platz ${geerntet})`,
    );
  }

  // Der Schnellwuchs braucht etwas, das laenger laeuft als der Weg zum Knopf:
  // Mais. Ansetzen, warten, bis der Server den Start kennt, dann einsetzen —
  // beim Server muss der Start jedes laufenden Fachs nach hinten geruckt sein.
  await warteAufFreiesFeld(cdp);
  const maisGesaet = await evaluate<boolean>(cdp, `(function () {
    var frei = [...document.querySelectorAll('#plots .plot')].find(function (p) {
      var al = p.getAttribute('aria-label') || '';
      return /^Feld [0-9]/.test(al) && !p.classList.contains('ripe') && !p.querySelector('.bar');
    });
    if (!frei) return false;
    frei.click();
    var opt = [...document.querySelectorAll('#pick-list .opt')].find(function (o) {
      return !o.disabled && /Mais/.test(o.textContent);
    });
    if (!opt) { document.getElementById('pick-close').click(); return false; }
    opt.click();
    return true;
  })()`);
  let laufende: Array<{ pi: number; si: number; startedAt: number }> = [];
  for (let w = 0; w < 12 && laufende.length === 0; w++) {
    await sleep(250);
    const st = await serverStand();
    laufende = st.plots.flatMap((pl, pi) => pl.slots.map((sl, si) => ({ pi, si, startedAt: sl.startedAt, recipe: sl.recipe })))
      .filter((x) => x.recipe === 3)
      .map((x) => ({ pi: x.pi, si: x.si, startedAt: x.startedAt }));
  }
  await evaluate(cdp, `document.getElementById('lagerhaus').click()`);
  await sleep(150);
  const wuchsGing = await evaluate<string>(cdp, `(function () {
    var k = [...document.querySelectorAll('#booster .booster-karte')].find(function (x) { return /Schnellwuchs/.test(x.textContent); });
    if (!k) return 'keine Karte';
    var b = k.querySelector('.go');
    if (b.disabled) return 'Knopf gesperrt: ' + k.textContent.replace(/\\s+/g, ' ').slice(0, 60);
    b.click();
    return 'geklickt';
  })()`);
  await sleep(300);
  const wuchsMeldung = await evaluate<string>(cdp, `document.getElementById('toast').textContent`);
  await sleep(2200);
  await evaluate(cdp, `document.getElementById('lager-close').click()`);
  const laufendNach = await serverStand();
  const geschoben = laufende.filter((x) => {
    const sl = laufendNach.plots[x.pi]?.slots[x.si];
    return !!sl && sl.startedAt < x.startedAt;
  }).length;
  check(
    'Der Schnellwuchs rückt das laufende Maisfeld vor — der Server hat den Start zurückgesetzt',
    maisGesaet && wuchsGing === 'geklickt' && laufende.length > 0 && geschoben > 0,
    `Mais gesät ${maisGesaet} · ${wuchsGing} · ${geschoben} von ${laufende.length} vorgerückt · „${wuchsMeldung}"`,
  );

  console.log('\n9l. Geschenke — etwas aus dem eigenen Lager an den Nachbarn');

  // Der Nachbar schenkt uns etwas — als eigenes Konto, direkt beim Server.
  await api(`/api/admin/grant?account=${second.accountId}&item=wheat&amount=5`, 'POST');
  await sleep(300);
  const vorGeschenk = await stateAs(second.key);
  await syncAs(second.key, vorGeschenk.snapshot.seq, [
    { seq: vorGeschenk.snapshot.seq + 1, tick: tickFuer(vorGeschenk.snapshot), type: 'COLLECT_MAIL' },
  ]);
  const postVorGeschenk = ((await api(`/api/admin/status?account=${status.accountId}`)) as {
    state: { mail: unknown[] };
  }).state.mail.length;
  const geschenkAntwort = await fetch(
    `http://127.0.0.1:${PORT}/api/geschenk?code=${encodeURIComponent(eigenerCode)}&item=wheat&amount=2`,
    { method: 'POST', headers: { authorization: `Bearer ${second.key}` } },
  );
  check('Der Nachbar kann uns beschenken — der Server nimmt es an', geschenkAntwort.ok, `HTTP ${geschenkAntwort.status}`);
  await sleep(800);
  const postNachGeschenk = ((await api(`/api/admin/status?account=${status.accountId}`)) as {
    state: { mail: unknown[] };
  }).state.mail.length;
  check(
    'Das Geschenk liegt in unserer Post',
    postNachGeschenk > postVorGeschenk,
    `Post ${postVorGeschenk} → ${postNachGeschenk}`,
  );
  let geschenkMeldung: { text: string; tippbar: boolean } | undefined;
  // Momente kommen nacheinander, mit Abstand — steht noch etwas an, dauert es.
  for (let w = 0; w < 130 && !geschenkMeldung; w++) {
    await sleep(300);
    const liste = JSON.parse(await evaluate<string>(cdp, `localStorage.getItem('${MELDUNGEN}') || '[]'`)) as Array<{ text: string; tippbar: boolean }>;
    geschenkMeldung = liste.find((m) => /Geschenk von/.test(m.text));
  }
  // Falls nicht gemeldet: Liegt das Geschenk noch ungesehen beim Server (dann
  // hat der Client nie nachgefragt) oder ist es abgeholt (dann fehlt der Moment)?
  const ungesehen = geschenkMeldung
    ? null
    : (((await (await fetch(`http://127.0.0.1:${PORT}/api/geschenke`, {
        headers: { authorization: `Bearer ${shownKey}` },
      })).json()) as { geschenke?: unknown[] }).geschenke ?? []).length;
  const letzteMeldungen = geschenkMeldung ? '' : (JSON.parse(await evaluate<string>(cdp, `localStorage.getItem('${MELDUNGEN}') || '[]'`)) as Array<{ text: string; n?: number; t?: number }>).slice(-8).map((m) => `${m.text.slice(0, 96)}${(m.n || 1) > 1 ? ' ×' + m.n : ''}@${Math.round(((m.t || 0) - Date.now()) / 1000)}s`).join(' | ');
  check(
    'Der Hof sagt sofort, von wem es kommt — antippbar, mit dem Weg zur Post',
    !!geschenkMeldung && geschenkMeldung.tippbar && /Weizen/.test(geschenkMeldung.text),
    geschenkMeldung ? geschenkMeldung.text : `nicht gemeldet · beim Server ungesehen: ${ungesehen} · zuletzt: ${letzteMeldungen}`,
  );

  // Und wir schenken zurueck — durch die Oberflaeche: Nachbarn, Karte, Schenken.
  await evaluate(cdp, `document.getElementById('nachbarn').click()`);
  await sleep(900);
  const geschenkKnopf = await evaluate<string>(cdp, `(function () {
    var karte = document.querySelector('#freundeliste .nachbar[data-hof="${zweiterCode.code}"]');
    if (!karte) return 'keine Karte';
    var b = karte.querySelector('.schenken');
    if (!b) return 'kein Knopf';
    if (b.disabled) return 'gesperrt: ' + b.textContent;
    b.click();
    return 'auf';
  })()`);
  await sleep(300);
  const gewaehlt = await evaluate<string>(cdp, `(function () {
    var karte = document.querySelector('#freundeliste .nachbar[data-hof="${zweiterCode.code}"]');
    var wahl = karte && karte.querySelector('.geschenk-wahl');
    if (!wahl) return 'kein Wähler';
    var chip = [...wahl.querySelectorAll('.chip')].find(function (c) { return /Weizen/.test(c.textContent); });
    if (!chip) return 'kein Weizen: ' + wahl.textContent.slice(0, 60);
    chip.click();
    var s = wahl.querySelector('.schicken');
    if (!s) return 'kein Schicken';
    s.click();
    return wahl.querySelector('.zahl').textContent;
  })()`);
  await sleep(2500);
  const nachbarPost = (await stateAs(second.key)).snapshot.state as unknown as { mail: unknown[] };
  check(
    'Schenken durch die Oberfläche: Der Weizen liegt in der Post des Nachbarn',
    geschenkKnopf === 'auf' && /Weizen/.test(gewaehlt) && nachbarPost.mail.length > 0,
    `${geschenkKnopf} · ${gewaehlt} · Post des Nachbarn: ${nachbarPost.mail.length}`,
  );
  await sleep(600);
  const nochmal = await evaluate<string>(cdp, `(function () {
    var karte = document.querySelector('#freundeliste .nachbar[data-hof="${zweiterCode.code}"]');
    var b = karte && karte.querySelector('.schenken');
    return b ? (b.disabled ? 'gesperrt: ' + b.textContent : 'offen') : 'kein Knopf';
  })()`);
  check(
    'Einmal am Tag je Nachbar — danach ist der Knopf zu und sagt es',
    /gesperrt: heute beschenkt/.test(nochmal),
    nochmal,
  );
  await evaluate(cdp, `document.getElementById('freunde-close').click()`);
  await sleep(300);

  console.log('\n9w. Bergbau: Mine bauen, graben, Erze ernten');
  await api(`/api/admin/xp?account=${status.accountId}&amount=16000`, 'POST');
  await api(`/api/admin/grant?account=${status.accountId}&item=plank&amount=60`, 'POST');
  await api(`/api/admin/grant?account=${status.accountId}&item=nail&amount=40`, 'POST');
  await api(`/api/admin/grant?account=${status.accountId}&item=gold&amount=20000`, 'POST');
  await api(`/api/admin/grant?account=${status.accountId}&item=shovel&amount=3`, 'POST');
  // Die Mine liegt jetzt im Sperrland — erst das Land freimachen. Dafür das
  // passende Werkzeug (Karte, Schlegel, Pflock) ins Postfach legen.
  await api(`/api/admin/grant?account=${status.accountId}&item=map&amount=10`, 'POST');
  await api(`/api/admin/grant?account=${status.accountId}&item=mallet&amount=10`, 'POST');
  await api(`/api/admin/grant?account=${status.accountId}&item=stake&amount=12`, 'POST');
  await sleep(500);
  await evaluate(cdp, `document.getElementById('lagerhaus').click()`);
  await waitFor(cdp, `document.querySelectorAll('#mail .card').length > 0`, 'Bau-Material im Postfach');
  for (let i = 0; i < 14; i++) {
    const c = await evaluate<boolean>(cdp, `!!document.querySelector('#mail .card')`);
    if (!c) break;
    await evaluate(cdp, `document.querySelector('#mail .card').click()`);
    await sleep(220);
  }
  await evaluate(cdp, `document.getElementById('lager-close').click()`);
  await sleep(200);
  await evaluate(cdp, `(function () {
    var f = document.getElementById('stufe-feier');
    if (f && !f.hidden) { var w = document.getElementById('stufe-weiter'); if (w) w.click(); }
  })()`);
  await sleep(200);

  // Die Mine liegt im Sperrland (Erweiterung m1) — erst das Land freimachen,
  // sonst bleibt sie unter der Sperre und lässt sich nicht bauen (LAND_LOCKED).
  // Über die Oberfläche: die Sperr-Kachel antippen, dann „Land freischalten".
  await evaluate(cdp, `(function () {
    var t = document.querySelector('.feld-sperre[data-feld="m1"]');
    if (t) t.click();
  })()`);
  await sleep(300);
  const landFrei = await evaluate<boolean>(cdp, `(function () {
    var b = document.querySelector('#erweiterung-inhalt .primär');
    if (b && !b.disabled) { b.click(); return true; }
    return false;
  })()`);
  await sleep(400);
  await api(`/api/admin/time?account=${status.accountId}&seconds=1`, 'POST');
  await evaluate(cdp, `window.dispatchEvent(new Event('online'))`);
  await sleep(400);
  check('Das Land um die Mine lässt sich freimachen', landFrei);

  // Die Mine ist fest — man baut sie an ihrem (nun freien) Platz am Berg.
  // Ein Tipp auf ein noch nicht gebautes Bauwerk zeigt erst die Bau-Info
  // (Stufe, Kosten, freies Land); gebaut wird über den Knopf darin.
  const mineGebaut = await evaluate<{
    gefunden: boolean;
    info: string;
    knopf: string;
    idx: number;
  }>(
    cdp,
    `(function () {
       function tile() {
         return [...document.querySelectorAll('#plots .plot')].find(function (x) {
           return x.querySelector('.name') && x.querySelector('.name').textContent.indexOf('Mine') === 0;
         });
       }
       var t = tile();
       if (!t) return { gefunden: false, info: 'keine Kachel', knopf: '', idx: -1 };
       var idx = parseInt(t.dataset.platz, 10);
       t.click();
       var info = document.getElementById('pick-list').textContent || '';
       var bauen = document.querySelector('#pick-list .abfahrt');
       var knopf = bauen ? bauen.textContent : '';
       if (bauen && !bauen.disabled) bauen.click();
       return { gefunden: true, info: info, knopf: knopf, idx: idx };
     })()`,
  );
  check(
    'Ein Tipp auf die ungebaute Mine zeigt, was sie braucht',
    /Stufe/.test(mineGebaut.info) && /Bretter|Nägel|Gold/.test(mineGebaut.info),
    mineGebaut.info.slice(0, 120),
  );
  await sleep(600);
  const truthMine = (await api(`/api/admin/status?account=${status.accountId}`)) as {
    state: { plots: { level: number }[] };
  };
  // Den echten Platz-Index aus der Kachel lesen — der Katalog wächst hinten,
  // darum ist die Mine nicht mehr fest das vorletzte Element.
  const mineIdx = mineGebaut.idx;
  check(
    'Die feste Mine baut man am Berg auf — ohne Hinstellen',
    mineGebaut.gefunden && (truthMine.state.plots[mineIdx]?.level ?? 0) >= 1,
    `Mine-Stufe ${truthMine.state.plots[mineIdx]?.level}`,
  );

  const grabWahl = await evaluate<{ opts: number; bundle: boolean; text: string }>(
    cdp,
    `(function () {
       var t = [...document.querySelectorAll('#plots .plot')].find(function (x) {
         return x.querySelector('.name') && x.querySelector('.name').textContent.indexOf('Mine') === 0;
       });
       if (!t) return { opts: 0, bundle: false, text: 'keine Mine' };
       t.click();
       var opts = [...document.querySelectorAll('#pick-list .card.opt:not(.ausbau)')];
       var mehrfach = opts.some(function (o) {
         return o.querySelectorAll('.yield img').length >= 2;
       });
       return { opts: opts.length, bundle: mehrfach, text: opts.map(function (o) { return o.querySelector('.top').textContent; }).join(' | ') };
     })()`,
  );
  check(
    'Die Mine bietet drei Grab-Rezepte, und der Ertrag zeigt mehrere Erze auf einmal',
    grabWahl.opts === 3 && grabWahl.bundle,
    `${grabWahl.opts} Rezepte (${grabWahl.text}), Bündel ${grabWahl.bundle}`,
  );

  const kohleVor = await stockOf('Kohle');
  await evaluate(
    cdp,
    `(function () {
       var o = [...document.querySelectorAll('#pick-list .card.opt')].find(function (c) {
         return /Schaufel/.test(c.querySelector('.top').textContent) && !c.disabled;
       });
       if (o) o.click();
     })()`,
  );
  await sleep(400);
  await api(`/api/admin/time?account=${status.accountId}&seconds=250`, 'POST');
  await evaluate(cdp, `window.dispatchEvent(new Event('online'))`);
  await waitFor(
    cdp,
    `[...document.querySelectorAll('#plots .plot')].some(function (t) {
       return t.querySelector('.name') && t.querySelector('.name').textContent.indexOf('Mine') === 0 && t.classList.contains('ripe');
     })`,
    'Der Stollen ist fertig',
    20_000,
  );
  await evaluate(
    cdp,
    `(function () {
       var t = [...document.querySelectorAll('#plots .plot')].find(function (x) {
         return x.querySelector('.name') && x.querySelector('.name').textContent.indexOf('Mine') === 0;
       });
       if (t) t.click();
     })()`,
  );
  let kohleNach = kohleVor;
  let eisenNach = -1;
  for (let i = 0; i < 40 && (kohleNach <= (kohleVor < 0 ? 0 : kohleVor) || eisenNach < 1); i++) {
    await sleep(250);
    kohleNach = await stockOf('Kohle');
    eisenNach = await stockOf('Eisenerz');
  }
  check(
    'Graben mit der Schaufel bringt Kohle und Eisenerz zugleich ins Lager',
    kohleNach >= 2 && eisenNach >= 1,
    `Kohle ${kohleNach}, Eisenerz ${eisenNach}`,
  );

  console.log('\n9x. Angelsee: Boot, Köder sieden, Reusen legen und einholen');
  await api(`/api/admin/grant?account=${status.accountId}&item=gold&amount=2000`, 'POST');
  await api(`/api/admin/grant?account=${status.accountId}&item=plank&amount=20`, 'POST');
  await api(`/api/admin/grant?account=${status.accountId}&item=nail&amount=20`, 'POST');
  await api(`/api/admin/grant?account=${status.accountId}&item=wheat&amount=40`, 'POST');
  await sleep(500);
  await evaluate(cdp, `document.getElementById('lagerhaus').click()`);
  await waitFor(cdp, `document.querySelectorAll('#mail .card').length > 0`, 'Material fürs Boot im Postfach');
  for (let i = 0; i < 10; i++) {
    if (!(await evaluate<boolean>(cdp, `!!document.querySelector('#mail .card')`))) break;
    await evaluate(cdp, `document.querySelector('#mail .card').click()`);
    await sleep(200);
  }
  await evaluate(cdp, `document.getElementById('lager-close').click()`);
  await sleep(250);

  // Das Boot steht kaputt am Hof; tippen öffnet die Reparatur.
  await evaluate(cdp, `document.getElementById('boot').click()`);
  await sleep(400);
  const reparaturAuf = await evaluate<string>(
    cdp,
    `(document.getElementById('pick-title') || {}).textContent || ''`,
  );
  check('Das kaputte Boot bietet die Reparatur an', /Boot/i.test(reparaturAuf), reparaturAuf);

  await evaluate(cdp, `(function () {
    var b = [...document.querySelectorAll('#pick-list button')].find(function (x) { return /Reparieren/i.test(x.textContent); });
    if (b) b.click();
  })()`);
  await sleep(900);
  // Beim ersten Betreten erklärt sich der See selbst.
  const seeTut = await evaluate<string>(cdp, `(function () {
    var t = document.getElementById('tut-bg');
    return (t && !t.hidden) ? (document.getElementById('tut-titel') || {}).textContent || 'offen' : 'zu';
  })()`);
  check('Beim ersten Besuch erklärt sich der Angelsee', /Angelsee|Köder|Reuse/i.test(seeTut), seeTut);
  await evaluate(cdp, `(function () {
    var t = document.getElementById('tut-bg');
    if (t && !t.hidden) document.getElementById('tut-skip').click();
  })()`);
  await sleep(400);

  const imSee = await evaluate<number>(cdp, `document.querySelectorAll('.see-spot').length`);
  check('Nach der Reparatur liegt der See mit seinen Angelstellen vor einem', imSee === 5, `${imSee} Stellen`);

  // Köder sieden: dauert und belegt einen Werkbank-Platz.
  await evaluate(cdp, `(function () {
    var h = [...document.querySelectorAll('.see-obj')].find(function (t) { return /Strandhaus/.test(t.getAttribute('aria-label') || ''); });
    if (h) h.click();
  })()`);
  await sleep(500);
  const sudPlaetze = await evaluate<number>(
    cdp,
    `[...document.querySelectorAll('#pick-list button')].filter(function (b) { return /Köder sieden/i.test(b.textContent); }).length`,
  );
  check('Das Strandhaus zeigt begrenzte Sud-Plätze', sudPlaetze === 2, `${sudPlaetze} Plätze`);

  await evaluate(cdp, `(function () {
    var b = [...document.querySelectorAll('#pick-list button')].find(function (x) { return /Köder sieden/i.test(x.textContent); });
    if (b) b.click();
  })()`);
  await sleep(500);
  const laueft = await evaluate<string>(
    cdp,
    `([...document.querySelectorAll('#pick-list .top')].map(function (e) { return e.textContent; }).join(' | '))`,
  );
  check('Der Sud läuft und zeigt seine Restzeit', /Sud 1 · noch/.test(laueft), laueft.slice(0, 80));

  const koederImBlatt = `(function () {
    var p = [...document.querySelectorAll('#pick-list p')].find(function (e) { return /Im Lager/.test(e.textContent); });
    var m = p && /(\\d+)/.exec(p.textContent);
    return m ? Number(m[1]) : -1;
  })()`;
  const koederVor = await evaluate<number>(cdp, koederImBlatt);
  check('Vor dem Abholen liegt noch kein Köder im Lager', koederVor === 0, `${koederVor} Köder`);

  await api('/api/admin/time?seconds=400', 'POST');
  await evaluate(cdp, `window.dispatchEvent(new Event('online'))`);
  const sudFertig = `[...document.querySelectorAll('#pick-list button')].some(function (b) { return /Köder fertig/i.test(b.textContent); })`;
  let sudReif = false;
  for (let i = 0; i < 60 && !sudReif; i++) {
    sudReif = await evaluate<boolean>(cdp, sudFertig);
    if (!sudReif) {
      await sleep(500);
      if (i % 10 === 9) await evaluate(cdp, `window.dispatchEvent(new Event('online'))`);
    }
  }
  check('Der Sud wird nach seiner Zeit fertig', sudReif, sudReif ? 'fertig' : 'blieb unfertig');
  await evaluate(cdp, `(function () {
    var b = [...document.querySelectorAll('#pick-list button')].find(function (x) { return /Köder fertig/i.test(x.textContent); });
    if (b) b.click();
  })()`);
  await sleep(600);
  const koederNach = await evaluate<number>(cdp, koederImBlatt);
  check(
    'Abgeholt landet der Sud als Köder im Lager',
    koederNach > koederVor,
    `${koederVor} → ${koederNach} Köder`,
  );

  await evaluate(cdp, `document.getElementById('pick-close').click()`);
  await sleep(300);

  // Reuse legen: kostet einen Köder und belegt die Stelle.
  await evaluate(cdp, `document.querySelectorAll('.see-spot')[0].click()`);
  await sleep(600);
  const nachLegen = await evaluate<{ koeder: number; zieht: boolean }>(cdp, `(function () {
    var m = /(\\d+)\\s*Köder/.exec(document.getElementById('see-hud-info').textContent || '');
    var s = document.querySelectorAll('.see-spot')[0];
    return { koeder: m ? Number(m[1]) : -1, zieht: s.classList.contains('zieht-noch') };
  })()`);
  check(
    'Köder legen kostet einen Köder und die Stelle zieht',
    nachLegen.koeder === koederNach - 1 && nachLegen.zieht,
    `${nachLegen.koeder} Köder, zieht ${nachLegen.zieht}`,
  );

  // Zu früh einholen bringt nichts — die Wartezeit steckt im Regelwerk.
  await evaluate(cdp, `document.querySelectorAll('.see-spot')[0].click()`);
  await sleep(400);
  const zuFrueh = await evaluate<boolean>(
    cdp,
    `document.querySelectorAll('.see-spot')[0].classList.contains('zieht-noch')`,
  );
  check('Zu früh antippen holt die Reuse nicht ein', zuFrueh, `zieht noch: ${zuFrueh}`);

  const fangVor = await evaluate<number>(cdp, `(function () {
    var m = /(\\d+)\\s*Fänge/.exec(document.getElementById('see-hud-info').textContent || '');
    return m ? Number(m[1]) : -1;
  })()`);

  await api('/api/admin/time?seconds=1200', 'POST');
  await evaluate(cdp, `window.dispatchEvent(new Event('online'))`);
  // Im Feldtest-Regelwerk zieht eine Reuse 20 Sekunden. Die Zeitspende erreicht
  // den Client hier nicht immer, darum warten wir notfalls in echt ab.
  let reuseVoll = false;
  for (let i = 0; i < 80 && !reuseVoll; i++) {
    reuseVoll = await evaluate<boolean>(cdp, `document.querySelectorAll('.see-spot')[0].classList.contains('ripe')`);
    if (!reuseVoll) {
      await sleep(500);
      if (i % 10 === 9) await evaluate(cdp, `window.dispatchEvent(new Event('online'))`);
    }
  }
  check('Die Reuse wird nach ihrer Zeit voll', reuseVoll, reuseVoll ? 'voll' : 'blieb leer');
  await evaluate(cdp, `document.querySelectorAll('.see-spot')[0].click()`);
  await sleep(700);
  const nachHolen = await evaluate<{ fang: number; frei: boolean }>(cdp, `(function () {
    var m = /(\\d+)\\s*Fänge/.exec(document.getElementById('see-hud-info').textContent || '');
    var s = document.querySelectorAll('.see-spot')[0];
    return { fang: m ? Number(m[1]) : -1, frei: !s.classList.contains('ripe') && !s.classList.contains('zieht-noch') };
  })()`);
  check(
    'Die volle Reuse bringt mehrere Züge und gibt die Stelle wieder frei',
    nachHolen.fang >= fangVor + 2 && nachHolen.frei,
    `Fänge ${fangVor} → ${nachHolen.fang}, frei ${nachHolen.frei}`,
  );

  // Am See müssen die Menü-Bildschirme trotzdem funktionieren.
  await evaluate(cdp, `document.getElementById('zahnrad').click()`);
  await sleep(400);
  await evaluate(cdp, `document.getElementById('ziele-auf').click()`);
  await sleep(600);
  const zieleAmSee = await evaluate<{ zeilen: number; gruppen: number }>(cdp, `({
    zeilen: document.querySelectorAll('#ziele-liste .ziel').length,
    gruppen: document.querySelectorAll('#ziele-liste .ziel-gruppe').length
  })`);
  check(
    'Auch am See sind Ziele und Erfolge gefüllt, nach Gruppen sortiert',
    zieleAmSee.zeilen > 20 && zieleAmSee.gruppen >= 4,
    `${zieleAmSee.zeilen} Ziele in ${zieleAmSee.gruppen} Gruppen`,
  );

  await evaluate(cdp, `document.getElementById('ziele-close').click()`);
  await sleep(300);

  // Die Aufgaben des Tages haengen am Abenteuerbrett — erreichbar ueber das
  // Zahnrad, mit eigener Optik und echtem Fortschritt.
  await evaluate(cdp, `document.getElementById('abenteuer-auf').click()`);
  await sleep(700);
  const brett = await evaluate<{
    offen: boolean;
    titel: string;
    zettel: string[];
    unter: string;
  }>(cdp, `(function () {
    return {
      offen: !document.getElementById('abenteuer-bg').hidden,
      titel: (document.getElementById('abenteuer-titel') || {}).textContent || '',
      unter: (document.getElementById('abenteuer-unter') || {}).textContent || '',
      zettel: [...document.querySelectorAll('#abenteuer-liste .zettel-brett:not(.woche):not(.fest)')]
        .map(function (z) { return z.textContent.trim().replace(/\\s+/g, ' '); }),
    };
  })()`);

  check(
    'Das Abenteuerbrett öffnet sich und hängt voller Tageszettel',
    brett.offen && /Abenteuerbrett/.test(brett.titel) && brett.zettel.length > 0,
    `${brett.titel} · ${brett.zettel.length} Zettel · ${brett.unter}`,
  );
  // Wann haengen neue Zettel? Die Uhrzeit steht in der Zeitzone des Geraets,
  // der Countdown laeuft auf der Serveruhr. Beides muss zusammenpassen: Jetzt
  // plus Restzeit ergibt die angezeigte Uhrzeit.
  const brettUhr = await evaluate<string>(cdp, `(function () {
    var u = document.getElementById('abenteuer-uhr');
    if (!u) return 'FEHLT';
    var t = u.textContent || '';
    var m = /(\\d{2}):(\\d{2})/.exec(t);
    var r = /noch (.+)$/.exec(t);
    if (!m || !r) return 'unvollstaendig: ' + t;
    // Restzeit grob zurueckrechnen und mit der genannten Uhrzeit vergleichen.
    var teile = /(?:(\\d+) h )?(?:(\\d+) min|(\\d+) s)/.exec(r[1]) || [];
    var min = (Number(teile[1] || 0) * 60) + Number(teile[2] || 0);
    var ziel = new Date(Date.now() + min * 60000);
    // In Minuten des Tages rechnen und ueber Mitternacht hinweg vergleichen:
    // Der Countdown rundet ab, also landet das Ziel kurz vor der vollen
    // Stunde — ein Stundenvergleich fiele genau dort auseinander (23 statt 0).
    var soll = (ziel.getHours() * 60) + ziel.getMinutes();
    var ist = (Number(m[1]) * 60) + Number(m[2]);
    var abstand = Math.abs(soll - ist);
    var stimmt = Math.min(abstand, 1440 - abstand) <= 2;
    return JSON.stringify({ text: t.trim(), uhrzeit: m[0], passt: stimmt });
  })()`);
  check(
    'Das Brett sagt, wann neue Zettel hängen — Uhrzeit und Countdown',
    /"passt":true/.test(brettUhr),
    brettUhr,
  );

  check(
    'Jeder Zettel zeigt Belohnung und entweder Stand oder Abhol-Knopf',
    brett.zettel.every((z) => /Gold|XP/.test(z)) &&
      brett.zettel.every((z) => /\d+ \/ \d+/.test(z) || /Abholen|abgeholt/.test(z)),
    brett.zettel.join(' | ').slice(0, 170),
  );

  const zettelAbgenommen = await evaluate<string>(cdp, `(function () {
    var k = document.querySelector('#abenteuer-liste .zettel-los');
    if (!k) return 'nichts fertig';
    var vorher = Number(document.getElementById('gold').textContent);
    k.click();
    return JSON.stringify({ vorher: vorher });
  })()`);
  if (zettelAbgenommen !== 'nichts fertig') {
    await sleep(700);
    const nachher = await evaluate<number>(cdp, `Number(document.getElementById('gold').textContent)`);
    const vorher = JSON.parse(zettelAbgenommen).vorher as number;
    check(
      'Einen fertigen Zettel abnehmen zahlt Gold aus',
      nachher > vorher,
      `${vorher} → ${nachher} Gold`,
    );
  }

  await evaluate(cdp, `document.getElementById('abenteuer-close').click()`);
  await sleep(300);
  await evaluate(cdp, `document.getElementById('rest-close').click()`);
  await sleep(300);

  // Zurück auf den Hof über den Steg.
  await evaluate(cdp, `(function () {
    var d = [...document.querySelectorAll('.see-obj')].find(function (t) { return /Hof/.test(t.getAttribute('aria-label') || ''); });
    if (d) d.click();
  })()`);
  await sleep(700);
  const zurueck = await evaluate<boolean>(cdp, `document.querySelectorAll('.see-spot').length === 0 && !!document.querySelector('#plots .plot')`);
  check('Über den Steg geht es zurück auf den Hof', zurueck, `zurück: ${zurueck}`);

  console.log('\n9v. Werkzeugkette: Holz schlagen, Bretter und Karten selbst machen');
  await api(`/api/admin/xp?account=${status.accountId}&amount=60000`, 'POST');
  await api(`/api/admin/grant?account=${status.accountId}&item=gold&amount=30000`, 'POST');
  await api(`/api/admin/grant?account=${status.accountId}&item=plank&amount=40`, 'POST');
  await api(`/api/admin/grant?account=${status.accountId}&item=nail&amount=30`, 'POST');
  await api(`/api/admin/grant?account=${status.accountId}&item=saw&amount=10`, 'POST');
  await api(`/api/admin/grant?account=${status.accountId}&item=pickaxe&amount=10`, 'POST');
  await api(`/api/admin/grant?account=${status.accountId}&item=shovel&amount=10`, 'POST');
  await api(`/api/admin/grant?account=${status.accountId}&item=iron-bar&amount=12`, 'POST');
  await sleep(500);
  await evaluate(cdp, `document.getElementById('lagerhaus').click()`);
  await waitFor(cdp, `document.querySelectorAll('#mail .card').length > 0`, 'Material für die Werkstatt');
  for (let i = 0; i < 12; i++) {
    if (!(await evaluate<boolean>(cdp, `!!document.querySelector('#mail .card')`))) break;
    await evaluate(cdp, `document.querySelector('#mail .card').click()`);
    await sleep(200);
  }
  await evaluate(cdp, `document.getElementById('lager-close').click()`);
  await sleep(250);
  await evaluate(cdp, `(function () {
    var f = document.getElementById('stufe-feier');
    if (f && !f.hidden) { var w = document.getElementById('stufe-weiter'); if (w) w.click(); }
  })()`);
  await sleep(300);

  // Ein Baum bringt jetzt Holz — vorher kostete Räumen nur eine Säge.
  const holzStand = `(function () {
    var c = [...document.querySelectorAll('#stock .chip')].find(function (x) { return /Holz/.test(x.textContent); });
    if (!c) return -1;
    var m = /(\\d+)\\s*$/.exec(c.textContent.trim());
    return m ? Number(m[1]) : -1;
  })()`;
  const holzVor = await evaluate<number>(cdp, holzStand);
  const gefaellt = await evaluate<boolean>(cdp, `(function () {
    var b = [...document.querySelectorAll('#hindernisse .hindernis.raeumbar')].find(function (h) {
      return /Baum/.test(h.getAttribute('aria-label') || '');
    });
    if (!b) return false;
    b.click();
    return true;
  })()`);
  if (gefaellt) {
    await sleep(400);
    await evaluate(cdp, `(function () {
      var k = [...document.querySelectorAll('#pick-list button')].find(function (x) { return /äumen|Fällen|Weg/i.test(x.textContent); });
      if (k) k.click();
    })()`);
    await sleep(700);
  }
  const holzNach = await evaluate<number>(cdp, holzStand);
  check(
    'Einen Baum zu fällen bringt Holz ins Lager',
    gefaellt && holzNach > Math.max(0, holzVor),
    `Holz ${holzVor} → ${holzNach}`,
  );

  // Die Testfarm ist an dieser Stelle zugewachsen. Erst Platz schaffen, sonst
  // findet das Aufstellen keine freie Zelle.
  let freigeraeumt = 0;
  for (let i = 0; i < 14; i++) {
    // Immer das Hindernis, das der Bildmitte am nächsten liegt — genau dort
    // tastet das Aufstellen später nach einer freien Zelle.
    const weg = await evaluate<boolean>(cdp, `(function () {
      var hof = document.getElementById('hof').getBoundingClientRect();
      var mx = hof.left + hof.width / 2, my = hof.top + hof.height / 2;
      var beste = null, best = Infinity;
      [...document.querySelectorAll('#hindernisse .hindernis.raeumbar')].forEach(function (h) {
        var r = h.getBoundingClientRect();
        if (r.width <= 0) return;
        var d = Math.pow(r.left + r.width / 2 - mx, 2) + Math.pow(r.top + r.height / 2 - my, 2);
        if (d < best) { best = d; beste = h; }
      });
      if (!beste) return false;
      beste.click();
      return true;
    })()`);
    if (!weg) break;
    await sleep(320);
    const bestaetigt = await evaluate<boolean>(cdp, `(function () {
      var k = [...document.querySelectorAll('#pick-list button')].find(function (x) { return /äumen|Fällen|Weg/i.test(x.textContent); });
      if (!k) { var c = document.getElementById('pick-close'); if (c) c.click(); return false; }
      k.click();
      return true;
    })()`);
    await sleep(420);
    if (bestaetigt) freigeraeumt++;
  }
  check(
    'Mit eigenem Werkzeug lässt sich der Hof freiräumen',
    freigeraeumt >= 4,
    `${freigeraeumt} Hindernisse geräumt`,
  );

  // Aufstellen wird hier nicht mehr geprüft: Der Hof ist nach Mine und Angelsee
  // so zugebaut, dass der Tipp-Sweep keine freie Zelle mehr findet. Dass Kauf
  // und Aufstellen funktionieren, deckt Abschnitt 9f auf dem leeren Hof ab.
  // Hier zählt, dass die neuen Bauwerke im Katalog stehen und richtig kosten.
  const neuImKatalog = await evaluate<Record<string, string>>(cdp, `(function () {
    document.getElementById('bauen').click();
    var raus = {};
    [...document.querySelectorAll('#bauliste .card')].forEach(function (c) {
      var name = c.querySelector('.top').textContent.split(' · ')[0].trim();
      var zut = c.querySelector('.zutaten');
      raus[name] = (c.disabled ? 'gesperrt: ' : '') + c.querySelector('.sub').textContent.trim() +
        (zut ? ' | ' + zut.textContent.trim() : '');
    });
    document.getElementById('bau-close').click();
    return raus;
  })()`);
  for (const [name, was] of [
    ['Waldstück', '8\u00d7 Bretter'],
    ['Werkstatt', '14\u00d7 Bretter'],
    ['Räucherei', '18\u00d7 Bretter'],
  ] as const) {
    const zeile = neuImKatalog[name];
    check(
      `${name} steht baubar im Katalog — mit sichtbaren Zutaten`,
      typeof zeile === 'string' && zeile.indexOf('gesperrt') < 0 && zeile.indexOf(was) >= 0,
      zeile ?? 'fehlt',
    );
  }

  console.log('\n9u. Schafe — Weide, Lamm, Wolle');

  await evaluate(cdp, `document.getElementById('bauen').click()`);
  await sleep(400);
  const bauAngebot = JSON.parse(
    await evaluate<string>(
      cdp,
      `JSON.stringify([...document.querySelectorAll('#bauliste .card')].map(function (c) {
         return { name: (c.querySelector('.top') || {}).textContent || '', frei: !c.disabled,
                  text: c.textContent.replace(/\\s+/g, ' ').slice(0, 80) };
       }).filter(function (c) { return /Schafweide|Weberei/.test(c.name); }))`,
    ),
  ) as Array<{ name: string; frei: boolean; text: string }>;
  check(
    'Die Bauliste kennt Schafweide und Weberei',
    bauAngebot.some((c) => /Schafweide/.test(c.name)) && bauAngebot.some((c) => /Weberei/.test(c.name)),
    bauAngebot.map((c) => c.name + (c.frei ? ' (baubar)' : ' (gesperrt)')).join(' · ') || 'keins gefunden',
  );
  const weidePlotsVorher = await evaluate<number>(cdp, `document.querySelectorAll('#plots .plot').length`);
  const weideGekauft = await evaluate<string>(
    cdp,
    `(function () {
       var k = [...document.querySelectorAll('#bauliste .card')].find(function (c) {
         return /Schafweide/.test((c.querySelector('.top') || {}).textContent || '') && !c.disabled;
       });
       if (!k) return 'nicht baubar';
       k.click();
       return 'gekauft';
     })()`,
  );
  await sleep(600);
  const nachKlick = await evaluate<string>(
    cdp,
    `JSON.stringify({ toast: document.getElementById('toast').textContent,
       setzen: !document.getElementById('setzen').hidden, bau: !document.getElementById('bau-bg').hidden,
       text: document.getElementById('setzen-text').textContent })`,
  );
  const gesetzt = weideGekauft === 'gekauft' ? await setzeGezielt(cdp) : 'nicht gekauft';
  if (gesetzt !== 'gesetzt' && weideGekauft === 'gekauft') await tippeBisGesetzt(cdp);
  await sleep(600);
  const weideToastDanach = await evaluate<string>(cdp, `document.getElementById('toast').textContent`);
  const weideDa = JSON.parse(
    await evaluate<string>(
      cdp,
      `JSON.stringify((function () {
         var t = [...document.querySelectorAll('#plots .plot')].find(function (p) {
           return /Schafweide/.test(p.getAttribute('aria-label') || '');
         });
         return { da: !!t, plots: document.querySelectorAll('#plots .plot').length, platz: t ? t.getAttribute('data-platz') : null };
       })())`,
    ),
  ) as { da: boolean; plots: number; platz: string | null };
  check(
    'Die Schafweide lässt sich kaufen und hinstellen — sie steht als eigener Platz auf dem Hof',
    weideGekauft === 'gekauft' && weideDa.da && weideDa.plots === weidePlotsVorher + 1,
    `${weideGekauft} · ${weidePlotsVorher} → ${weideDa.plots} Plätze · nach Klick ${nachKlick} · gesetzt ${gesetzt} · „${weideToastDanach}"`,
  );

  if (weideDa.da) {
    await evaluate(cdp, `document.querySelector('#plots .plot[data-platz="${weideDa.platz}"]').click()`);
    await sleep(400);
    const lamm = await evaluate<string>(
      cdp,
      `(function () {
         var k = [...document.querySelectorAll('#pick-list .tierplatz')].find(function (c) {
           return /Lamm/.test(c.textContent) && !c.disabled;
         });
         if (!k) return 'kein Lamm: ' + [...document.querySelectorAll('#pick-list .opt')].map(function (o) { return o.textContent.replace(/\\s+/g, ' ').slice(0, 30); }).join(' | ');
         k.click();
         return 'gekauft';
       })()`,
    );
    await sleep(700);
    const weideBild = JSON.parse(
      await evaluate<string>(
        cdp,
        `JSON.stringify((function () {
           document.getElementById('pick-close') && document.getElementById('pick-close').click();
           var t = document.querySelector('#plots .plot[data-platz="${weideDa.platz}"]');
           var tiere = t ? t.querySelectorAll('g.tier').length : -1;
           var schaf = t ? [...t.querySelectorAll('image')].some(function (i) { return (i.getAttribute('href') || '').length > 100; }) : false;
           return { tiere: tiere, schaf: schaf, meldung: document.getElementById('toast').textContent };
         })())`,
      ),
    ) as { tiere: number; schaf: boolean; meldung: string };
    check(
      'Ein Lamm lässt sich dazukaufen, und die Weide zeigt das Schaf',
      lamm === 'gekauft' && weideBild.tiere >= 1 && weideBild.schaf,
      `${lamm} · ${weideBild.tiere} Tier(e) im Bild · „${weideBild.meldung}"`,
    );
  }

  // Schafe fressen Futter aus der Mühle, wie Hühner und Kühe — die Mühle muss
  // Schaffutter anbieten, sobald die Weide erreichbar ist.
  const muehleFutter = JSON.parse(
    await evaluate<string>(
      cdp,
      `JSON.stringify((function () {
         var tile = [...document.querySelectorAll('#plots .plot')].find(function (t) {
           var n = t.querySelector('.name');
           return n && n.textContent.indexOf('Mühle') === 0;
         });
         if (!tile) return { muehle: false, optionen: [] };
         tile.click();
         var optionen = [...document.querySelectorAll('#pick-list .opt')].map(function (o) {
           return o.textContent.replace(/\\s+/g, ' ').slice(0, 40);
         });
         var close = document.getElementById('pick-close');
         if (close) close.click();
         return { muehle: true, optionen: optionen };
       })())`,
    ),
  ) as { muehle: boolean; optionen: string[] };
  check(
    'Die Mühle mahlt Schaffutter — Schafe fressen Futter wie Hühner und Kühe',
    muehleFutter.muehle && muehleFutter.optionen.some((o) => /Schaffutter/.test(o)),
    muehleFutter.muehle ? muehleFutter.optionen.join(' | ') : 'keine Mühle auf dem Hof',
  );

  console.log('\n9v. Meisterschaft — Sterne an der Mühle');
  // Weizen ins Postfach und ins Lager, damit die Mühle mehrfach mahlen kann.
  await api(`/api/admin/grant?account=${status.accountId}&item=wheat&amount=30`, 'POST');
  await waitFor(cdp, `document.querySelectorAll('#mail .card').length > 0`, 'Weizen im Postfach', 20_000);
  await evaluate(cdp, `document.querySelector('#mail .card').click()`);
  await sleep(400);
  const muehleTile = `[...document.querySelectorAll('#plots .plot')].find(function (t) {
       var n = t.querySelector('.name'); return n && n.textContent.indexOf('Mühle') === 0; })`;
  // Erst den Stand ablesen: Wie viele Abholungen hat die Mühle schon?
  const meisterVorher = JSON.parse(
    await evaluate<string>(
      cdp,
      `JSON.stringify((function () {
         var tile = ${muehleTile};
         if (!tile) return { da: false };
         tile.click();
         var karte = document.querySelector('#pick-list .card.meister');
         var text = karte ? karte.textContent.replace(/\\s+/g, ' ').trim() : '';
         document.getElementById('pick-close').click();
         return { da: true, karte: !!karte, text: text, sterne: (text.match(/★/g) || []).length };
       })())`,
    ),
  ) as { da: boolean; karte?: boolean; text?: string; sterne?: number };
  check(
    'Das Tipp-Menü der Mühle zeigt die Meisterschaft mit Weg zum nächsten Stern',
    meisterVorher.da && meisterVorher.karte === true && /Meisterschaft/.test(meisterVorher.text ?? '') && /Abholung/.test(meisterVorher.text ?? ''),
    meisterVorher.text ?? 'keine Mühle',
  );
  // So oft Hühnerfutter mahlen, wie der Feldtest für den ersten Stern verlangt.
  const sterneNoetig = getRuleset(1001).meisterschaft!.stufen[0]!;
  let meisterAbgeholt = 0;
  for (let runde = 0; runde < sterneNoetig + 2 && meisterAbgeholt < sterneNoetig; runde++) {
    await evaluate(
      cdp,
      `(function () {
         var tile = ${muehleTile};
         if (!tile) return;
         var s = tile.querySelector('.status').textContent;
         if (s.indexOf('fertig') === 0) { tile.click(); return; }
         tile.click();
         var opt = [...document.querySelectorAll('#pick-list .opt')].find(function (o) {
           return o.textContent.indexOf('Hühnerfutter') >= 0 && !o.disabled;
         });
         if (opt) opt.click(); else document.getElementById('pick-close').click();
       })()`,
    );
    await api(`/api/admin/time?account=${status.accountId}&seconds=60`, 'POST');
    await sleep(700);
    const geholt = await evaluate<boolean>(
      cdp,
      `(function () {
         var tile = ${muehleTile};
         if (!tile || tile.querySelector('.status').textContent.indexOf('fertig') !== 0) return false;
         tile.click();
         return true;
       })()`,
    );
    if (geholt) meisterAbgeholt++;
    await sleep(500);
  }
  // Der Stern reiht sich hinter anderen Momenten ein (Erfolge, Verkäufe) —
  // jeder braucht ein paar Sekunden. Warten, bis er dran war.
  let sternGemeldet = true;
  try {
    await waitFor(
      cdp,
      `JSON.parse(localStorage.getItem('${MELDUNGEN}') || '[]').some(function (m) { return /Meisterstern/.test(m.text); })`,
      'Meisterstern als Moment',
      90_000,
    );
  } catch (e) {
    sternGemeldet = false;
    console.log('    (Meisterstern-Moment: ' + String((e as Error).message) + ')');
  }
  await sleep(300);
  const meisterDanach = JSON.parse(
    await evaluate<string>(
      cdp,
      `JSON.stringify((function () {
         var tile = ${muehleTile};
         var dach = tile ? tile.querySelectorAll('.sterne polygon').length : -1;
         tile.click();
         var karte = document.querySelector('#pick-list .card.meister');
         var text = karte ? karte.textContent.replace(/\\s+/g, ' ').trim() : '';
         document.getElementById('pick-close').click();
         var liste = [];
         try { liste = JSON.parse(localStorage.getItem('${MELDUNGEN}') || '[]'); } catch (e) {}
         var moment = liste.filter(function (m) { return /Meisterstern/.test(m.text); }).map(function (m) { return m.text; });
         return { dach: dach, sterne: (text.match(/★/g) || []).length, text: text, moment: moment };
       })())`,
    ),
  ) as { dach: number; sterne: number; text: string; moment: string[] };
  check(
    'Nach genug Abholungen leuchtet der erste Stern — am Dach der Mühle und im Tipp-Menü',
    meisterDanach.sterne >= 1 && meisterDanach.dach >= 1,
    `${meisterAbgeholt} abgeholt · ${meisterDanach.dach} Stern(e) am Dach · „${meisterDanach.text}"`,
  );
  check(
    'Der neue Stern kommt als Moment mit seinem Vorteil',
    sternGemeldet && meisterDanach.moment.some((m) => /schneller/.test(m)),
    meisterDanach.moment.join(' | ') || 'kein Moment im Mitschnitt (90 s gewartet)',
  );

  console.log('\n9w. Werkbank — Eingriffe, die den Abgleich achten');
  const wb_schlange = () => evaluate<number>(
    cdp!,
    `(function () { try { return JSON.parse(localStorage.getItem(globalThis.NeuesSpiel.storageKeyFor(location.origin))).queue.length; } catch (e) { return -1; } })()`,
  );
  const wb_hofStand = async () => (await api(`/api/admin/sicht?account=${status.accountId}`)) as {
    sicht: { silo: { level: number; capacity: number }; mail: { entries: unknown[] }; plots: Array<{ done: boolean }> };
    technik: { eingriffe: unknown[]; pendingDeliveries: unknown[]; seq: number };
  };
  // Netz weg — der Spieler saet, der Befehl bleibt in der Schlange.
  await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await sleep(300);
  // Erst ernten, was reif ist, dann saeen — beides ohne Netz, beides bleibt liegen.
  const werkGeerntet = await evaluate<number>(cdp, harvestAll);
  await sleep(300);
  const werkGesaet = await evaluate<number>(cdp, plantAll);
  await sleep(300);
  const offlineSchlange = await wb_schlange();
  check(
    'Im Funkloch bleiben Ernte und Saat als Befehle in der Schlange liegen',
    werkGeerntet + werkGesaet > 0 && offlineSchlange > 0,
    `${werkGeerntet} geerntet · ${werkGesaet} gesät · ${offlineSchlange} in der Schlange`,
  );
  // Derweil greift die Werkbank ein — dreimal.
  const werkSeit = Date.now();
  const wb_vorEingriff = await wb_hofStand();
  const wb_e1 = (await api(`/api/admin/eingriff?account=${status.accountId}&art=alles-fertig`, 'POST')) as { ok: boolean };
  const wb_e2 = (await api(`/api/admin/eingriff?account=${status.accountId}&art=kiste-schicken&kind=0`, 'POST')) as { ok: boolean };
  const wb_e3 = (await api(`/api/admin/eingriff?account=${status.accountId}&art=lager-ausbauen&stufen=1`, 'POST')) as { ok: boolean; offen: number };
  const wb_wartend = await wb_hofStand();
  check(
    'Die Werkbank überschreibt nichts: Eingriffe warten auf den nächsten Abgleich des Hofs',
    wb_e1.ok && wb_e2.ok && wb_e3.ok && wb_e3.offen === 3 && wb_wartend.technik.eingriffe.length === 3 &&
      wb_wartend.sicht.silo.level === wb_vorEingriff.sicht.silo.level,
    `${wb_wartend.technik.eingriffe.length} Eingriffe warten · Lagerstufe noch ${wb_wartend.sicht.silo.level}`,
  );
  const wb_postVorher = wb_wartend.sicht.mail.entries.length + wb_wartend.technik.pendingDeliveries.length;
  // Netz zurueck: erst die Saat des Spielers, dann die Eingriffe obendrauf.
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await evaluate(cdp, `window.dispatchEvent(new Event('online'))`);
  await waitFor(
    cdp,
    `JSON.parse(localStorage.getItem(globalThis.NeuesSpiel.storageKeyFor(location.origin))).queue.length === 0`,
    'Schlange geleert',
    20_000,
  ).catch(() => {});
  await sleep(1000);
  const wb_danach = await wb_hofStand();
  const werkProtokoll = (await api(`/api/admin/protokoll?konto=${status.accountId}&limit=40`)) as {
    zeilen: Array<{ art: string; text: string; t: number }>;
  };
  const wb_abgelehnt = werkProtokoll.zeilen.filter((z) => z.art === 'abgelehnt' && z.t >= werkSeit);
  check(
    'Nach dem Abgleich ist die Saat des Spielers angenommen — kein Befehl abgelehnt, Schlange leer',
    wb_danach.technik.seq > wb_wartend.technik.seq && wb_abgelehnt.length === 0 && (await wb_schlange()) === 0,
    `seq ${wb_wartend.technik.seq} → ${wb_danach.technik.seq} · abgelehnt: ${wb_abgelehnt.map((z) => z.text).join(' | ') || 'nichts'}`,
  );
  const wb_postNachher = wb_danach.sicht.mail.entries.length + wb_danach.technik.pendingDeliveries.length;
  check(
    '… und die Eingriffe sind obendrauf angewendet: Lager ausgebaut, Kiste in der Post, nichts wartet mehr',
    wb_danach.technik.eingriffe.length === 0 && wb_danach.sicht.silo.level === wb_vorEingriff.sicht.silo.level + 1 && wb_postNachher > wb_postVorher,
    `Lagerstufe ${wb_vorEingriff.sicht.silo.level} → ${wb_danach.sicht.silo.level} · Post ${wb_postVorher} → ${wb_postNachher} · ${wb_danach.technik.eingriffe.length} offen`,
  );
  check(
    'Das Server-Protokoll hält jeden Eingriff fest',
    ['Alles fertig gestellt', 'geschickt', 'Lager +1'].every((t) => werkProtokoll.zeilen.some((z) => z.art === 'werkbank' && z.text.indexOf(t) >= 0)),
    werkProtokoll.zeilen.filter((z) => z.art === 'werkbank').slice(0, 4).map((z) => z.text).join(' | '),
  );

  // Die Werkbank-Seite selbst, in einem zweiten Fenster: Hof waehlen, Tabs,
  // ein Knopf — und der landet als Eingriff beim Server.
  const werkZiel = (await browserCdp!.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string };
  const werk = await Cdp.connect(`ws://127.0.0.1:9333/devtools/page/${werkZiel.targetId}`);
  await werk.send('Page.enable');
  await werk.send('Runtime.enable');
  await werk.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/admin` });
  await sleep(900);
  await evaluate(werk, `localStorage.setItem('ns-admin-token', ${JSON.stringify(ADMIN_TOKEN)})`);
  await werk.send('Page.reload');
  await sleep(1200);
  await waitFor(werk, `document.querySelectorAll('.hofzeile').length > 0`, 'Werkbank zeigt Höfe', 10_000).catch(() => {});
  // Die Ereignisleitung des Spiels kommt nach dem Funkloch mit Verzoegerung
  // zurueck — kurz warten, bis der Server wieder einen Zuhoerer sieht.
  let wb_eigenes: { id: string; code: string | null; zuhoerer: number; lastSyncMs: number | null } | undefined;
  for (let i = 0; i < 40; i++) {
    const wb_konten = (await api('/api/admin/accounts')) as { accounts: Array<{ id: string; code: string | null; zuhoerer: number; lastSyncMs: number | null }> };
    wb_eigenes = wb_konten.accounts.find((k) => k.id === status.accountId);
    if (wb_eigenes && wb_eigenes.zuhoerer > 0) break;
    await sleep(400);
  }
  await evaluate(werk, `document.getElementById('neuladen').click()`);
  await sleep(600);
  await evaluate(
    werk,
    `(function () { var b = [...document.querySelectorAll('.hofzeile')].find(function (x) { return x.textContent.indexOf(${JSON.stringify(wb_eigenes?.code ?? '')}) >= 0; }); if (b) b.click(); })()`,
  );
  await waitFor(werk, `/Stufe/.test(document.getElementById('kopf').textContent)`, 'Hof in der Werkbank', 10_000).catch(() => {});
  const werkSicht = JSON.parse(
    await evaluate<string>(
      werk,
      `JSON.stringify({
         kopf: document.getElementById('kopf').textContent.replace(/\\s+/g, ' '),
         zeilen: document.querySelectorAll('#tab-inhalt tbody tr').length,
         online: !!document.querySelector('.hofzeile.an .punkt.online'),
         aktiv: !!document.querySelector('.hofzeile.an .punkt.aktiv'),
       })`,
    ),
  ) as { kopf: string; zeilen: number; online: boolean; aktiv: boolean };
  check(
    'Die Werkbank zeigt den Hof: Stufe, Gold, Gerät und die Plätze — und sieht, dass er verbunden ist',
    /Stufe \d+/.test(werkSicht.kopf) && /Gold/.test(werkSicht.kopf) && werkSicht.zeilen >= 5 && (werkSicht.online || werkSicht.aktiv),
    `${werkSicht.zeilen} Plätze · online ${werkSicht.online} · aktiv ${werkSicht.aktiv} (Zuhörer ${wb_eigenes?.zuhoerer ?? '?'}) · ${werkSicht.kopf.slice(0, 90)}`,
  );
  await evaluate(werk, `document.querySelector('#tabs [data-tab="brett"]').click()`);
  await sleep(300);
  const werkBrett = await evaluate<string>(werk, `document.getElementById('tab-inhalt').textContent.replace(/\\s+/g, ' ')`);
  check(
    'Der Brett-Tab zeigt Tag, Woche, Fest, Erfolge und den Wagen',
    /Heute/.test(werkBrett) && /Diese Woche/.test(werkBrett) && /Fest/.test(werkBrett) && /Erfolge/.test(werkBrett) && /Wagen/.test(werkBrett),
    werkBrett.slice(0, 120),
  );
  await evaluate(
    werk,
    `[...document.querySelectorAll('[data-eingriff]')].find(function (b) { return b.getAttribute('data-eingriff') === 'wagen-zurueck'; }).click()`,
  );
  await waitFor(werk, `/Wagen zurückrufen/.test(document.getElementById('log').textContent)`, 'Verlauf in der Werkbank', 8_000).catch(() => {});
  await sleep(1500);
  const werkProtokoll2 = (await api(`/api/admin/protokoll?konto=${status.accountId}&limit=10`)) as { zeilen: Array<{ art: string; text: string }> };
  check(
    'Ein Knopf in der Werkbank wird zum Eingriff — und steht sofort im Server-Protokoll',
    werkProtokoll2.zeilen.some((z) => z.art === 'werkbank' && /Wagen zurückgerufen/.test(z.text)),
    werkProtokoll2.zeilen.slice(0, 3).map((z) => z.art + ': ' + z.text).join(' | '),
  );
  await browserCdp!.send('Target.closeTarget', { targetId: werkZiel.targetId }).catch(() => {});

  console.log('\n9x. Feldfrüchte — Möhren, Zuckerrohr, Saftpresse');
  await evaluate(cdp, `document.getElementById('bauen').click()`);
  await sleep(400);
  const presseImKatalog = await evaluate<string>(
    cdp,
    `(function () {
       var k = [...document.querySelectorAll('#bauliste .card')].find(function (c) { return /Saftpresse/.test((c.querySelector('.top') || {}).textContent || ''); });
       var t = k ? k.textContent.replace(/\\s+/g, ' ').slice(0, 80) : 'fehlt';
       document.getElementById('bau-close').click();
       return t;
     })()`,
  );
  check('Die Saftpresse steht im Baukatalog', presseImKatalog !== 'fehlt', presseImKatalog);
  await warteAufFreiesFeld(cdp);
  const feldMenue = JSON.parse(
    await evaluate<string>(
      cdp,
      `JSON.stringify((function () {
         var feld = [...document.querySelectorAll('#plots .plot')].find(function (p) {
           var s = (p.querySelector('.status') || {}).textContent || '';
           var al = p.getAttribute('aria-label') || '';
           return /^Feld [0-9]/.test(al) && !p.classList.contains('ripe') && !p.querySelector('.bar');
         });
         if (!feld) return { feld: false };
         feld.click();
         var opts = [...document.querySelectorAll('#pick-list .opt')].map(function (o) { return { name: (o.querySelector('.top') || {}).textContent || '', frei: !o.disabled }; });
         var kauf = [...document.querySelectorAll('#pick-list .nachkauf')].map(function (n) { return n.textContent.replace(/\\s+/g, ' ').slice(0, 60); });
         return { feld: true, opts: opts, kauf: kauf };
       })())`,
    ),
  ) as { feld: boolean; opts?: Array<{ name: string; frei: boolean }>; kauf?: string[] };
  const namen = (feldMenue.opts ?? []).map((o) => o.name);
  check(
    'Ein Feld bietet Möhren und Zuckerrohr an — die Saat kauft man nach wie Mais',
    feldMenue.feld && namen.some((n) => /Möhren/.test(n)) && namen.some((n) => /Zuckerrohr/.test(n)) &&
      (feldMenue.kauf ?? []).some((k) => /Möhre/.test(k)),
    `${namen.join(' | ')} · Nachkauf: ${(feldMenue.kauf ?? []).join(' | ')}`,
  );
  // Eine Möhre kaufen, dann säen.
  const gesaetMoehre = await evaluate<string>(
    cdp,
    `(function () {
       var zeile = [...document.querySelectorAll('#pick-list .nachkauf')].find(function (n) { return /Möhre/.test(n.textContent); });
       var k = zeile && zeile.querySelector('.kaufen');
       if (k) k.click();
       return k ? 'gekauft' : 'kein Nachkauf';
     })()`,
  );
  await sleep(700);
  const gesaetMoehre2 = await evaluate<string>(
    cdp,
    `(function () {
       var o = [...document.querySelectorAll('#pick-list .opt')].find(function (x) { return /Möhren/.test((x.querySelector('.top') || {}).textContent || '') && !x.disabled; });
       if (!o) return 'Möhren nicht startbar: ' + [...document.querySelectorAll('#pick-list .opt')].map(function (x) { return (x.querySelector('.top') || {}).textContent + (x.disabled ? '(x)' : ''); }).join(',');
       o.click();
       return 'gesät';
     })()`,
  );
  // Die Kachel sagt erst nach dem naechsten Zeichnen, was dort waechst.
  await waitFor(
    cdp,
    `[...document.querySelectorAll('#plots .plot')].some(function (p) { return /Möhren/.test(p.getAttribute('aria-label') || ''); })`,
    'Möhrenfeld beschriftet',
    5_000,
  ).catch(() => {});
  const moehrenFeld = await evaluate<string>(
    cdp,
    `([...document.querySelectorAll('#plots .plot')].find(function (p) { return /Möhren/.test(p.getAttribute('aria-label') || ''); }) || { getAttribute: function () { return 'nichts'; } }).getAttribute('aria-label')`,
  );
  check(
    'Nach dem Nachkauf lässt sich Möhre säen — das Feld sagt es',
    gesaetMoehre === 'gekauft' && gesaetMoehre2 === 'gesät' && /Möhren/.test(moehrenFeld),
    `${gesaetMoehre} · ${gesaetMoehre2} · „${moehrenFeld}"`,
  );
  await api(`/api/admin/time?account=${status.accountId}&seconds=60`, 'POST');
  await sleep(900);
  await evaluate(cdp, harvestAll);
  await sleep(600);
  const nachErnte = (await api(`/api/admin/status?account=${status.accountId}`)) as { state: { items: number[] }; itemIds: string[] };
  const moehrenImLager = nachErnte.state.items[nachErnte.itemIds.indexOf('carrot')] ?? 0;
  check('Aus einer Möhre werden zwei — die Ernte liegt im Lager', moehrenImLager >= 2, `${moehrenImLager} Möhren`);

  console.log('\n9y. Tagesbonus');
  await waitFor(
    cdp,
    `!document.getElementById('bonus-auf').hidden`,
    'Der Geschenk-Knopf taucht auf',
  );
  check('Ein verfügbarer Tagesbonus zeigt sich als Geschenk-Knopf', true);

  const bonusAuf = await evaluate<{ tage: number; heute: boolean; knopf: string }>(
    cdp,
    `(function () {
       document.getElementById('bonus-auf').click();
       var tage = document.querySelectorAll('#bonus-inhalt .bonus-tag');
       var heute = document.querySelector('#bonus-inhalt .bonus-tag.heute');
       var knopf = document.querySelector('#bonus-inhalt .primär');
       return { tage: tage.length, heute: !!heute, knopf: knopf ? knopf.textContent : 'kein Knopf' };
     })()`,
  );
  check(
    'Das Bonus-Fenster zeigt die Sieben-Tage-Leiter mit dem heutigen Tag markiert',
    bonusAuf.tage === 7 && bonusAuf.heute && /Abholen/.test(bonusAuf.knopf),
    `${bonusAuf.tage} Tage, heute markiert ${bonusAuf.heute}, Knopf „${bonusAuf.knopf}"`,
  );

  await evaluate(cdp, `document.querySelector('#bonus-inhalt .primär').click()`);
  await sleep(600);
  await waitFor(cdp, `document.querySelectorAll('#mail .card').length >= 0`, 'Sync nach Bonus');
  // Postfach öffnen und den Gold-Eingang bestätigen
  await evaluate(cdp, `document.getElementById('lagerhaus').click()`);
  await sleep(400);
  const bonusMail = await evaluate<boolean>(
    cdp,
    `[...document.querySelectorAll('#mail .card')].some(function (c) { return /Gold/.test(c.textContent); })`,
  );
  check('Der Bonus landet als Gold im Postfach', bonusMail);
  await evaluate(cdp, `document.getElementById('lager-close').click()`);
  await sleep(200);

  const nachBonus = await evaluate<{ knopfWeg: boolean; text: string }>(
    cdp,
    `(function () {
       document.getElementById('bonus-auf').click();
       return {
         knopfWeg: document.getElementById('bonus-auf').hidden,
         text: document.getElementById('bonus-inhalt').textContent,
       };
     })()`,
  );
  check(
    'Nach dem Abholen ist der Knopf weg und das Fenster sagt „morgen wieder"',
    nachBonus.knopfWeg && /morgen/.test(nachBonus.text),
    `Knopf weg ${nachBonus.knopfWeg}`,
  );
  await evaluate(cdp, `document.getElementById('bonus-close').click()`);
  await sleep(150);

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

  console.log('\n9y. Querformat: Layout auf dem Telefon (844 x 390)');

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 844,
    height: 390,
    deviceScaleFactor: 3,
    mobile: true,
  });
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await waitFor(cdp, 'document.getElementById("plots")', 'Hof nach dem Neuladen');
  await meldungenMitschneiden(cdp);
  await waitFor(
    cdp,
    'document.getElementById("shell") && !document.getElementById("shell").hidden',
    'Spiel im Querformat geladen',
    20_000,
  );
  await sleep(600);
  await evaluate(cdp, `(function () {
    var t = document.getElementById('tut-bg');
    if (t && !t.hidden) document.getElementById('tut-skip').click();
  })()`);
  await sleep(300);

  // Wichtig: Alles innerhalb von #hof liegt in der zoombaren Welt (CSS-transform
  // scale). Dessen Groessen aendern sich mit dem Zoom und sagen nichts ueber das
  // Layout aus. Geprueft wird deshalb nur die FESTE Bedienoberflaeche.
  const quer = await evaluate<{
    breite: number;
    ueberlauf: number;
    hofAnteil: number;
    kleinsteSchrift: number;
    kleinstesEl: string;
    zuKleineZiele: string;
    zuBreit: string;
  }>(
    cdp,
    `(function () {
       var vw = window.innerWidth, vh = window.innerHeight;
       var name = function (el) {
         if (el.id) return el.id;
         var c = el.getAttribute && el.getAttribute('class');
         return c || el.tagName.toLowerCase();
       };
       var fest = function (el) { return !el.closest('#hof'); };
       var sichtbar = function (el) {
         var r = el.getBoundingClientRect();
         if (r.width < 1 || r.height < 1) return false;
         var st = getComputedStyle(el);
         return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
       };

       var klein = 999, kleinEl = '';
       [].forEach.call(document.querySelectorAll('#shell *'), function (el) {
         if (!fest(el) || !sichtbar(el)) return;
         var eigener = [].some.call(el.childNodes, function (n) {
           return n.nodeType === 3 && n.textContent.trim().length > 0;
         });
         if (!eigener) return;
         var px = parseFloat(getComputedStyle(el).fontSize);
         if (px > 0 && px < klein) { klein = px; kleinEl = name(el); }
       });

       var zuKlein = [];
       [].forEach.call(
         document.querySelectorAll('.zahnrad, .see-hud button, .musikbar button, .topbar button'),
         function (el) {
           if (!fest(el) && !el.closest('.zahnrad')) return;
           if (!sichtbar(el)) return;
           var r = el.getBoundingClientRect();
           var kante = Math.min(r.width, r.height);
           if (kante < 44) zuKlein.push(name(el) + ' ' + Math.round(kante) + 'px');
         },
       );

       var breit = [];
       [].forEach.call(document.querySelectorAll('#shell *'), function (el) {
         if (!fest(el) || !sichtbar(el)) return;
         var r = el.getBoundingClientRect();
         if (r.width > vw + 1 && r.left < vw) breit.push(name(el));
       });

       var hof = document.getElementById('hof').getBoundingClientRect();
       return {
         breite: vw,
         ueberlauf: document.documentElement.scrollWidth - vw,
         hofAnteil: Math.round((hof.height / vh) * 100),
         kleinsteSchrift: Math.round(klein * 10) / 10,
         kleinstesEl: kleinEl,
         zuKleineZiele: zuKlein.join(', '),
         zuBreit: breit.slice(0, 5).join(', '),
       };
     })()`,
  );

  check(
    'Querformat: nichts laeuft seitlich aus dem Bild',
    quer.ueberlauf <= 1 && quer.zuBreit === '',
    `Überlauf ${quer.ueberlauf}px${quer.zuBreit ? ', zu breit: ' + quer.zuBreit : ''}`,
  );
  check(
    'Querformat: der Hof fuellt den Bildschirm aus',
    quer.hofAnteil >= 60,
    `Hof nimmt ${quer.hofAnteil}% der Hoehe ein`,
  );
  check(
    'Querformat: keine feste Schrift ist zu klein zum Lesen',
    quer.kleinsteSchrift >= 10,
    `kleinste feste Schrift ${quer.kleinsteSchrift}px (${quer.kleinstesEl})`,
  );
  check(
    'Querformat: feste Bedienknoepfe erreichen Apples 44px',
    quer.zuKleineZiele === '',
    quer.zuKleineZiele || 'alle >= 44px',
  );

  const zoomSchutz = await evaluate<{ viewport: string; touch: string }>(
    cdp,
    `(function () {
       var m = document.querySelector('meta[name=viewport]');
       return {
         viewport: m ? m.getAttribute('content') : '',
         touch: getComputedStyle(document.body).touchAction,
       };
     })()`,
  );
  check(
    'Kein Doppeltipp-Zoom wie auf einer Webseite',
    /user-scalable=no/.test(zoomSchutz.viewport) &&
      /maximum-scale=1/.test(zoomSchutz.viewport) &&
      zoomSchutz.touch === 'manipulation',
    `touch-action: ${zoomSchutz.touch}`,
  );

  const manifest = (await (await fetch(`http://127.0.0.1:${PORT}/manifest.webmanifest`)).json()) as {
    orientation?: string;
  };
  check(
    'Das Manifest fordert Querformat an',
    manifest.orientation === 'landscape',
    `orientation: ${manifest.orientation}`,
  );

  // Zurueck aufs Hochformat, damit der Rest der Pruefungen unveraendert laeuft.
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });

  console.log('\n9y2. Der Tagesabschluss — der Schlussstrich unter den Tag');

  await evaluate(cdp, `document.getElementById('abenteuer').click()`);
  await sleep(600);
  const urkunde = JSON.parse(
    await evaluate<string>(
      cdp,
      `JSON.stringify((function () {
         var u = document.querySelector('.tagesabschluss');
         return {
           da: !!u,
           zettel: document.querySelectorAll('#abenteuer-liste .zettel-brett:not(.woche):not(.fest)').length,
           text: u ? u.textContent.trim().replace(/\\s+/g, ' ') : '',
           knopf: !!(u && u.querySelector('.ta-los')),
           abgeholt: !!(u && u.classList.contains('abgeholt')),
         };
       })())`,
    ),
  ) as { da: boolean; zettel: number; text: string; knopf: boolean; abgeholt: boolean };

  // Was der Server über den Tag weiß — daran muss sich das Brett messen lassen.
  const tagStand = (await api(`/api/admin/status?account=${status.accountId}`)) as {
    state: { tagGeholt?: string[] };
  };
  const geholteZettel = (tagStand.state.tagGeholt ?? []).filter((id) => id !== 'tagesabschluss');
  const schonAbgeschlossen = (tagStand.state.tagGeholt ?? []).includes('tagesabschluss');
  const noetig = urkunde.zettel;

  check(
    'Unter den Zetteln hängt der Tagesabschluss mit seiner Belohnung',
    urkunde.da && /Tagesabschluss/.test(urkunde.text) && /Gold/.test(urkunde.text),
    urkunde.text.slice(0, 80),
  );
  check(
    'Er geht genau dann auf, wenn alle Zettel des Tages abgenommen sind',
    (geholteZettel.length >= noetig) === (urkunde.knopf || schonAbgeschlossen),
    `${geholteZettel.length}/${noetig} abgenommen · Knopf ${urkunde.knopf} · schon geholt ${schonAbgeschlossen}`,
  );

  if (urkunde.knopf) {
    const goldVorTag = await evaluate<number>(
      cdp,
      `Number(document.getElementById('gold').textContent)`,
    );
    await evaluate(cdp, `document.querySelector('.tagesabschluss .ta-los').click()`);
    await sleep(2000);
    const goldNachTag = await evaluate<number>(
      cdp,
      `Number(document.getElementById('gold').textContent)`,
    );
    const danach = (await api(`/api/admin/status?account=${status.accountId}`)) as {
      state: { tagGeholt?: string[] };
    };
    check(
      'Abholen zahlt den Tagesabschluss aus, und der Server schreibt ihn fest',
      goldNachTag > goldVorTag && (danach.state.tagGeholt ?? []).includes('tagesabschluss'),
      `${goldVorTag} → ${goldNachTag} Gold`,
    );
  } else if (schonAbgeschlossen) {
    check(
      'Ein abgeschlossener Tag lässt sich nicht zweimal abschließen',
      urkunde.abgeholt && !urkunde.knopf,
      urkunde.text.slice(0, 60),
    );
  } else {
    check(
      'Solange Zettel offen sind, sagt die Urkunde genau, wie viele noch fehlen',
      new RegExp('Noch ' + (noetig - geholteZettel.length) + ' von ' + noetig).test(urkunde.text),
      `${urkunde.text.slice(0, 60)} (offen: ${noetig - geholteZettel.length})`,
    );
  }

  // Die Woche: drei grosse Zettel und die Wochenurkunde — gemessen am Stand
  // des Servers, wie beim Tag.
  const woche = JSON.parse(
    await evaluate<string>(
      cdp,
      `JSON.stringify((function () {
         var u = document.querySelector('.tagesabschluss.woche');
         return {
           zettel: document.querySelectorAll('#abenteuer-liste .zettel-brett.woche').length,
           abschnitt: !!document.querySelector('#abenteuer-liste .brett-abschnitt'),
           urkunde: u ? u.textContent.trim().replace(/\\s+/g, ' ') : '',
           knopf: !!(u && u.querySelector('.ta-los')),
           uhr: (document.getElementById('abenteuer-wochenuhr') || {}).textContent || '',
         };
       })())`,
    ),
  ) as { zettel: number; abschnitt: boolean; urkunde: string; knopf: boolean; uhr: string };
  const wochenStand = (await api(`/api/admin/status?account=${status.accountId}`)) as {
    state: { wochenGeholt?: string[]; wochenNummer?: number; serverTag?: number };
  };
  const wochenGeholt = (wochenStand.state.wochenGeholt ?? []).filter((id) => id !== 'wochenabschluss');
  check(
    'Unter den Tageszetteln hängen drei Wochenzettel und die Wochenurkunde mit der Truhe',
    woche.abschnitt && woche.zettel === 3 && /Wochenabschluss/.test(woche.urkunde) && /Wochentruhe/.test(woche.urkunde),
    `${woche.zettel} Wochenzettel · ${woche.urkunde.slice(0, 70)}`,
  );
  check(
    'Die Woche des Servers beginnt am Montag und passt zum Tag',
    wochenStand.state.wochenNummer === Math.floor(((wochenStand.state.serverTag ?? 0) + 3) / 7),
    `Woche ${wochenStand.state.wochenNummer} zu Tag ${wochenStand.state.serverTag}`,
  );
  check(
    'Die Urkunde sagt, wie viele Wochenzettel noch fehlen — und stimmt mit dem Server überein',
    woche.knopf || new RegExp('Noch ' + (3 - wochenGeholt.length) + ' von 3').test(woche.urkunde) || /geschafft/.test(woche.urkunde),
    `${wochenGeholt.length}/3 abgenommen`,
  );
  check(
    'Das Brett sagt, wann die neuen Wochenzettel hängen — am Montag, mit Restzeit in Tagen',
    /Montag/.test(woche.uhr) && /noch/.test(woche.uhr),
    woche.uhr,
  );

  // Das Fest: Im Feldtest laeuft jeden Tag eines. Es haengt zwischen Tag und
  // Woche am Brett — mit Thema, Restzeit, drei Festzetteln und der Urkunde,
  // die Truhe und Deko verspricht.
  const fest = JSON.parse(
    await evaluate<string>(
      cdp,
      `JSON.stringify((function () {
         var kopf = document.querySelector('#abenteuer-liste .brett-abschnitt.fest');
         var u = document.querySelector('#abenteuer-liste .tagesabschluss.fest');
         var zettel = [...document.querySelectorAll('#abenteuer-liste .zettel-brett.fest')];
         return {
           kopf: kopf ? kopf.textContent.replace(/\\s+/g, ' ').trim() : '',
           zettel: zettel.length,
           staende: zettel.map(function (z) { var st = z.querySelector('.zettel-stand'); return st ? st.textContent : (z.querySelector('.zettel-los') ? 'abholbar' : 'abgeholt'); }),
           urkunde: u ? u.textContent.replace(/\\s+/g, ' ').trim() : '',
           abholbar: !!document.querySelector('#abenteuer-liste .zettel-los[data-fest]'),
         };
       })())`,
    ),
  ) as { kopf: string; zettel: number; staende: string[]; urkunde: string; abholbar: boolean };
  const festStand = (await api(`/api/admin/status?account=${status.accountId}`)) as {
    state: { festNummer?: number; serverTag?: number; festGeholt?: string[] };
  };
  check(
    'Am Brett hängt das Fest: Thema, Restzeit, drei Festzettel und die Urkunde mit Festtruhe und Deko',
    /Erntefest|Fischerfest|Markttag|Baufest/.test(fest.kopf) && /endet/.test(fest.kopf) && fest.zettel === 3 &&
      /Festtruhe/.test(fest.urkunde) && /geschafft/.test(fest.urkunde),
    `„${fest.kopf}" · ${fest.zettel} Zettel · ${fest.urkunde.slice(0, 80)}`,
  );
  check(
    'Der Server hat das Fest zur laufenden Woche gestempelt',
    festStand.state.festNummer === Math.floor(((festStand.state.serverTag ?? 0) + 3) / 7),
    `Fest ${festStand.state.festNummer} zu Tag ${festStand.state.serverTag}`,
  );
  const festFortschritt = fest.staende.some((st) => st === 'abholbar' || st === 'abgeholt' || /^[1-9]/.test(st));
  check(
    'Die Festzettel zählen, was seit Festbeginn auf dem Hof passiert ist',
    festFortschritt,
    fest.staende.join(' | '),
  );
  if (fest.abholbar) {
    await evaluate(cdp, `document.querySelector('#abenteuer-liste .zettel-los[data-fest]').click()`);
    await sleep(500);
    const festToast = await evaluate<string>(cdp, `document.getElementById('toast').textContent`);
    const festDanach = (await api(`/api/admin/status?account=${status.accountId}`)) as { state: { festGeholt?: string[] } };
    await sleep(400);
    check(
      'Ein erfüllter Festzettel lässt sich abholen — der Server merkt es sich',
      /Festzettel geschafft/.test(festToast) || (festDanach.state.festGeholt ?? []).length > 0,
      `„${festToast}" · geholt: ${(festDanach.state.festGeholt ?? []).join(', ') || '—'}`,
    );
  }

  await evaluate(cdp, `document.getElementById('abenteuer-close').click()`);
  await sleep(300);

  console.log('\n9z. Der Empfang — was der Hof erarbeitet hat, wenn man wiederkommt');

  // Ein echter Spieler legt das Telefon weg und kommt wieder — die Seite wird
  // dabei nicht neu geladen, sie war nur im Hintergrund. Genau das wird hier
  // nachgestellt: erst wegdrehen (dabei stempelt der Hof sein Lebenszeichen),
  // dann die Uhr des Lebenszeichens zurückdrehen, dann zurückkommen.
  const sichtbar = async (wie: 'hidden' | 'visible') => {
    await evaluate(
      cdp,
      `(function () {
         Object.defineProperty(document, 'visibilityState',
           { configurable: true, get: function () { return '${wie}'; } });
         Object.defineProperty(document, 'hidden',
           { configurable: true, get: function () { return ${wie === 'hidden'}; } });
         document.dispatchEvent(new Event('visibilitychange'));
       })()`,
    );
  };
  const wegGewesen = async (sekunden: number) => {
    await sichtbar('hidden');
    await sleep(400);
    await evaluate(
      cdp,
      `Object.keys(localStorage).forEach(function (k) {
         if (k.indexOf('ns-da') === 0) localStorage.setItem(k, String(Date.now() - ${sekunden} * 1000));
       })`,
    );
    await sichtbar('visible');
    await sleep(2500);
  };

  // Damit wirklich etwas wartet: notfalls etwas ansetzen und reif werden lassen.
  const zaehleReif = () =>
    evaluate<number>(cdp, `document.querySelectorAll('#plots .plot.ripe').length`);
  if ((await zaehleReif()) === 0) {
    await plantSomething(cdp);
    await sleep(33000);
  }

  // Wer eben erst weggeschaut hat, kommt nicht „zurück".
  await wegGewesen(30);
  check(
    'Nach kurzem Wegschauen empfängt niemand — das wäre nur ein Fenster zum Wegtippen',
    await evaluate<boolean>(cdp, `document.getElementById('empfang-bg').hidden`),
    'Blatt blieb zu',
  );

  // Drei Stunden weg: Jetzt zählt der Hof auf, was in der Zeit zusammenkam.
  await wegGewesen(3 * 3600);
  const empfang = JSON.parse(
    await evaluate<string>(
      cdp,
      `JSON.stringify((function () {
         var bg = document.getElementById('empfang-bg');
         return {
           offen: !bg.hidden,
           kopf: ((document.querySelector('#empfang-inhalt .lead') || {}).textContent || '').trim(),
           zeilen: [...document.querySelectorAll('.empfang-zeile')]
             .map(function (z) { return z.textContent.trim().replace(/\\s+/g, ' '); }),
           lohn: document.querySelectorAll('.empfang-zeile.lohn').length,
           knopf: ((document.getElementById('empfang-los') || {}).textContent || '').trim(),
         };
       })())`,
    ),
  ) as { offen: boolean; kopf: string; zeilen: string[]; lohn: number; knopf: string };

  check(
    'Nach Stunden ohne Hof geht der Empfang von selbst auf und sagt, wie lange man weg war',
    empfang.offen && /weg/.test(empfang.kopf),
    `${empfang.offen ? 'auf' : 'zu'} · ${empfang.kopf}`,
  );
  check(
    'Er zählt auf, was wartet — jede Zeile steht für etwas, das der Hof wirklich hat',
    empfang.zeilen.length > 0,
    empfang.zeilen.join(' | ').slice(0, 110),
  );

  const goldVorEmpfang = await evaluate<number>(
    cdp,
    `Number(document.getElementById('gold').textContent)`,
  );
  await evaluate(cdp, `document.getElementById('empfang-los').click()`);
  await sleep(2500);
  const nachEmpfang = JSON.parse(
    await evaluate<string>(
      cdp,
      `JSON.stringify({
         gold: Number(document.getElementById('gold').textContent),
         haken: document.querySelectorAll('.empfang-zeile.geholt').length,
         knopf: ((document.getElementById('empfang-los') || {}).textContent || '').trim(),
       })`,
    ),
  ) as { gold: number; haken: number; knopf: string };

  check(
    'Einsammeln zahlt wirklich aus — das Gold liegt danach im Geldbeutel, nicht im Postfach',
    nachEmpfang.gold > goldVorEmpfang,
    `${goldVorEmpfang} → ${nachEmpfang.gold} Gold`,
  );
  check(
    'Abgeholte Zeilen tragen den Haken, und der Knopf führt zurück auf den Hof',
    nachEmpfang.haken > 0 && /Hof/.test(nachEmpfang.knopf),
    `${nachEmpfang.haken} abgehakt · Knopf: ${nachEmpfang.knopf}`,
  );

  await evaluate(cdp, `document.getElementById('empfang-los').click()`);
  await sleep(500);
  check(
    'Danach steht man auf dem Hof, nicht vor einem Blatt',
    await evaluate<boolean>(cdp, `document.getElementById('empfang-bg').hidden`),
    'Blatt zu',
  );

  console.log('\n9z2. Momente — gute Nachrichten kommen von selbst');
  const meldungen = JSON.parse(
    await evaluate<string>(cdp, `localStorage.getItem('${MELDUNGEN}') || '[]'`),
  ) as Array<{ text: string; tippbar: boolean }>;
  // Kommen mehrere Erfolge auf einmal, legt der Hof sie zu einer Meldung zusammen.
  const erfolgMeldung = meldungen.find((m) => /★ Erfolg · Stufe 3 erreichen/.test(m.text)) ||
    meldungen.find((m) => /★ \d+ Erfolge — die Belohnungen warten/.test(m.text));
  check(
    'Wer Stufe 3 erreicht, erfährt sofort, dass ein Erfolg wartet — antippbar',
    !!erfolgMeldung && erfolgMeldung.tippbar,
    erfolgMeldung ? erfolgMeldung.text : `nicht gemeldet (${meldungen.length} Meldungen mitgeschnitten)`,
  );
  const wagenMeldung = meldungen.find((m) => /Der Wagen ist zurück/.test(m.text));
  check(
    'Kommt der Wagen zurück, sagt es der Hof — mit dem Weg zum Brett',
    !!wagenMeldung && wagenMeldung.tippbar,
    wagenMeldung ? wagenMeldung.text : 'nicht gemeldet',
  );
  const kisteMeldung = meldungen.find((m) => /Eine Kiste ist aufgetaucht/.test(m.text));
  check(
    'Taucht eine Kiste auf, sagt es der Hof — antippbar, die Kamera fährt hin',
    !!kisteMeldung && kisteMeldung.tippbar,
    kisteMeldung ? kisteMeldung.text : 'nicht gemeldet',
  );
  const zettelMeldung = meldungen.find((m) => /Zettel erfüllt/.test(m.text));
  const zettelGeschafft = empfang.zeilen.some((z) => /Geschafft/.test(z));
  check(
    'Kippt ein Zettel über die Ziellinie, sagt es der Hof — mit dem Weg zum Brett',
    !zettelGeschafft || (!!zettelMeldung && zettelMeldung.tippbar),
    zettelMeldung ? zettelMeldung.text : zettelGeschafft ? 'kein Zettel gemeldet' : 'im Lauf kippte kein Zettel',
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

    // Die Hülle kommt jetzt online direkt aus dem Netz (network-first), der neue
    // Service Worker übernimmt und räumt kurz danach den alten Cache weg. Darum
    // darauf warten, statt sofort zu prüfen.
    let shellAfter = shellBefore;
    for (let i = 0; i < 30; i++) {
      shellAfter = await evaluate<string>(
        cdp,
        `caches.keys().then(function (k) { return k.join(','); })`,
      ).catch(() => shellBefore);
      if (shellAfter !== shellBefore && !shellAfter.includes(',')) break;
      await sleep(500);
    }
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

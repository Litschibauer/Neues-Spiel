/**
 * Der Spielserver (Architektur §10).
 *
 *   npm run dev     # Entwicklung: schnelle Uhren, Werkbank an, Port 8788
 *   npm run prod    # Produktion:  echte Zeiten, Werkbank aus, Port 8787
 *
 * Beides kann gleichzeitig laufen: eigener Port, eigener Spielstand, eigenes
 * Token, eigenes Regelwerk (siehe config.ts). Damit lässt sich an einer neuen
 * Version herumprobieren, während die echten Spielstände unangetastet
 * weiterlaufen — und genau dafür ist die Trennung da.
 *
 * Nur `node:http` — keine Abhängigkeiten, damit das Ding auf einem Mini-Server
 * ohne npm-Installation läuft.
 */

import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Server } from './server.ts';
import type { SyncRequest } from './server.ts';
import { load, save } from './store.ts';
import { initialState, normalizeState } from '../sim/state.ts';
import { RULESETS, getRuleset } from '../sim/rules.ts';
import { ConfigError, describeConfig, isSecureTransport, resolveConfig } from './config.ts';
import { AccountStore, CreateLimiter, keyHashOf } from './accounts.ts';
import type { AccountRecord } from './accounts.ts';
import { Market, connectMarket, publishOrders, settleSales } from './market.ts';
import { EventHub } from './events.ts';

const ROOT = join(import.meta.dirname, '..', '..');

/**
 * Umgebung auflösen — und bei Unklarheit lieber gar nicht starten.
 *
 * Ein Server, der im Zweifel „irgendwas" tut, ist der Weg zu Dev-Regeln auf
 * echten Spielständen. Lieber eine klare Fehlermeldung.
 */
let CONFIG;
try {
  CONFIG = resolveConfig(process.env, process.argv.slice(2), ROOT);
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`\nStart abgebrochen: ${err.message}\n`);
  process.exit(1);
}

const PORT = CONFIG.port;
const SAVE_PATH = CONFIG.savePath;
const TARGET_RULESET = CONFIG.rulesetVersion;
const TOKEN_PATH = CONFIG.tokenPath;

/**
 * Das ADMIN-Token besorgen: Umgebungsvariable, sonst Datei, sonst neu erzeugen.
 *
 * Seit es Accounts gibt, ist das hier nicht mehr der Spielzugang — Spieler
 * melden sich mit ihrem eigenen Hof-Schlüssel an. Dieses Token öffnet nur die
 * Werkbank unter `/api/admin/*`, und die ist in Produktion ohnehin aus.
 *
 * Die Datei ist der bequeme Normalfall. Ein Token, das nur in der
 * Umgebungsvariable steht, landet in der Shell-History und ist nach dem
 * nächsten Neustart schlicht weg — dann steht man vor „wie finde ich das
 * eigentlich wieder heraus".
 */
function resolveToken(): string {
  const fromEnv = process.env.NEUES_SPIEL_TOKEN;
  if (fromEnv) {
    if (fromEnv.length < 16) {
      console.error('NEUES_SPIEL_TOKEN ist zu kurz (mindestens 16 Zeichen).');
      process.exit(1);
    }
    return fromEnv;
  }

  if (existsSync(TOKEN_PATH)) {
    const fromFile = readFileSync(TOKEN_PATH, 'utf8').trim();
    if (fromFile.length >= 16) return fromFile;
    console.error(`Token in ${TOKEN_PATH} ist zu kurz — bitte löschen, dann neu erzeugen.`);
    process.exit(1);
  }

  const generated = randomBytes(24).toString('base64url');
  mkdirSync(dirname(TOKEN_PATH), { recursive: true });
  writeFileSync(TOKEN_PATH, generated + '\n', { mode: 0o600 });
  console.log('\n' + '─'.repeat(52));
  console.log('  Neues Admin-Token erzeugt:\n');
  console.log(`  ${generated}\n`);
  console.log(`  Liegt in ${TOKEN_PATH} — jederzeit wieder abrufbar mit:`);
  console.log(`  cat ${TOKEN_PATH}`);
  console.log('─'.repeat(52) + '\n');
  return generated;
}

const TOKEN = resolveToken();

// ── Speicher ───────────────────────────────────────────────────────────
//
// Eine SQLite-Datei für Höfe UND Markt (siehe db.ts). Ein altes
// `accounts/`-Verzeichnis wird beim ersten Start übernommen.
const accounts = new AccountStore(CONFIG.dbPath, join(dirname(SAVE_PATH), 'accounts'));
const limiter = new CreateLimiter(
  Number(process.env.NEUES_SPIEL_NEW_PER_HOUR ?? 20),
  Number(process.env.NEUES_SPIEL_MAX_ACCOUNTS ?? 5000),
);

/**
 * Das Orderbuch (M5) — geteilt von allen Höfen dieser Umgebung.
 *
 * Eine Datei neben den Accounts, damit Dev und Produktion getrennte Märkte
 * haben: Ein Testverkauf darf nie in einer echten Auslage auftauchen.
 */
const market = new Market(accounts.storage);

/**
 * Geladene Höfe im Speicher.
 *
 * Geschrieben wird sofort, gehalten wird danach — ein Sync soll nicht bei
 * jedem Aufruf eine Datei lesen. Bei ein paar hundert Höfen ist das gemütlich;
 * ab Zehntausenden gehört hier eine Datenbank hin (Roadmap, Phase 4).
 */
const live = new Map<string, Server>();

/**
 * Die offenen Live-Leitungen (`/api/events`).
 *
 * Sie tragen nur Anstöße, keinen Zustand — warum das so ist, steht in
 * `events.ts`. Hier interessiert vor allem die Obergrenze: Jede offene
 * Verbindung kostet Speicher, auch wenn stundenlang nichts passiert.
 */
const events = new EventHub({
  minIntervalMs: Number(process.env.NEUES_SPIEL_NUDGE_MS ?? 1000),
  maxSubscribers: Number(process.env.NEUES_SPIEL_MAX_EVENT_STREAMS ?? 2000),
});

function freshGame(): Server {
  const game = new Server(
    initialState(getRuleset(TARGET_RULESET)),
    Date.now(),
    TARGET_RULESET,
    TARGET_RULESET,
  );
  // Kundenaufträge sofort auffüllen: Wer die App startet, soll nicht erst eine
  // Verbindung brauchen, um ein Ziel zu haben (Architektur §6).
  game.stockRequests();
  return game;
}

function snapshotOf(game: Server) {
  return {
    snapshot: game.snapshot,
    appliedLog: game.appliedLog,
    logStartSeq: game.logStartSeq,
    pendingDeliveries: game.pendingDeliveries,
    targetRulesetVersion: game.targetRulesetVersion,
    nextRequestId: game.nextRequestId,
  };
}

function gameFor(account: AccountRecord): Server {
  const cached = live.get(account.id);
  if (cached) return cached;

  const file = accounts.load(account.id);
  const game = new Server(
    initialState(getRuleset(TARGET_RULESET)),
    Date.now(),
    file ? file.snapshot.rulesetVersion : TARGET_RULESET,
    TARGET_RULESET,
  );
  if (file) {
    // Durch `normalizeState`, weil ein Stand von der Platte älter sein kann als
    // die heutige Zustandsform. Ein fehlendes Feld wäre sonst `undefined` in
    // einem Zahlenvergleich — kein Absturz, sondern eine Regel, die stumm nicht
    // mehr greift.
    game.snapshot = { ...file.snapshot, state: normalizeState(file.snapshot.state) };
    game.appliedLog = file.appliedLog;
    game.logStartSeq = file.logStartSeq ?? 1;
    // Ein Stand aus der Zeit vor dem Fenster bringt seinen ganzen Log mit —
    // der soll nicht dauerhaft im Speicher hängen bleiben.
    game.trimLog();
    game.pendingDeliveries = file.pendingDeliveries;
    game.nextRequestId = file.nextRequestId ?? 1;
    game.stockRequests();
  }
  wireMarket(account.id, game);
  live.set(account.id, game);
  return game;
}

/**
 * Den Markt an einen Hof anschließen (M5).
 *
 * Die eigentliche Naht steht in `market.ts` — hier wird nur nachgereicht, was
 * allein diese Schicht weiß: welche Höfe gerade geladen sind, und dass ein
 * Verkauf im Protokoll auftauchen soll.
 */
function wireMarket(accountId: string, game: Server): void {
  connectMarket(
    market,
    accountId,
    game,
    (id) => live.get(id) ?? null,
    // Der Verkäufer soll seinen Erlös sehen, während er zuschaut. Und weil ein
    // Angebot damit aus dem Buch ist, gehen alle anderen leer aus, wenn sie es
    // noch anzeigen — also einmal in die Runde.
    (sellerId) => {
      events.nudge(sellerId, 'farm');
      events.broadcast('market', accountId);
    },
  );
  const claim = game.claimOffer;
  game.claimOffer = (offerId) => {
    const ok = claim(offerId);
    if (ok) console.log(`[markt] ${accountId} kauft Angebot ${offerId}`);
    return ok;
  };
}

function settle(account: AccountRecord, game: Server): boolean {
  const done = settleSales(market, account.id, game);
  if (done) console.log(`[markt] ${account.id}: Verkauf abgerechnet`);
  return done;
}

function publish(accountId: string, game: Server): void {
  // Nur wenn sich am Buch wirklich etwas geändert hat. Ein Sync, der die
  // Auslage nicht berührt, soll niemanden aufwecken — sonst wäre jeder
  // Erntetipp irgendeines Spielers ein Anstoß für alle anderen.
  if (publishOrders(market, accountId, game)) events.broadcast('market', accountId);
}

/**
 * Mitzählen, warum Batches abgelehnt oder abgeschnitten wurden.
 *
 * Der Grund für diesen Zähler ist eine Frage, die sich sonst nicht beantworten
 * lässt: **Frisst der Deploy von eben gerade die Arbeit von Leuten, die offline
 * waren?** Ein einzelner abgeschnittener Batch sieht im Protokoll aus wie jeder
 * andere; erst die Häufung nach einem Ausrollen ist das Signal.
 *
 * Die Gründe sind sehr verschieden zu lesen:
 *
 *  - `OFFER_GONE` ist **normal** — jemand war beim Kauf schneller. Das ist die
 *    geteilte Welt, kein Fehler.
 *  - `UNKNOWN_COMMAND` heißt: Der Client kennt eine Aktion, die dieser Server
 *    nicht kennt. Das kann nur an einem Versionsunterschied liegen, und der
 *    ist immer unsere Schuld, nie die des Spielers.
 *  - Alles andere ist eine Regel, die beim Nachrechnen nicht mehr galt. Nach
 *    einem Ausrollen ist auch das ein Versionsverdacht.
 */
const rejections = new Map<string, number>();

function noteTruncation(result: { ok: boolean; reason?: string }, sent: number, id: string): void {
  const reason = result.reason;
  if (!reason) return;

  const key = reason.replace(/^ILLEGAL_COMMAND:/, '');
  rejections.set(key, (rejections.get(key) ?? 0) + 1);

  // Der eine Fall, der laut sein muss: Er bedeutet, dass Client und Server
  // nicht denselben Befehlssatz haben.
  if (key === 'UNKNOWN_COMMAND') {
    console.warn(
      `[version] ${id} schickte eine Aktion, die dieser Server nicht kennt — ` +
        `${sent} Commands eingereicht. Läuft dort eine neuere App als hier ein Server?`,
    );
  }
}

function persist(account: AccountRecord, game: Server): void {
  accounts.save({ ...account, lastSeenMs: Date.now() }, snapshotOf(game));
}

/**
 * Einen alten Ein-Spielstand-Server übernehmen.
 *
 * Vor den Accounts gab es genau einen Hof und ein Token. Wer so einen Stand
 * liegen hat, soll ihn nicht verlieren: Das alte Token wird zum Hof-Schlüssel,
 * der Spielstand zum ersten Account. Läuft genau einmal.
 */
if (accounts.count === 0 && existsSync(SAVE_PATH)) {
  const old = load(SAVE_PATH);
  if (old) {
    const now = Date.now();
    accounts.adopt(
      { id: 'a-imported', keyHash: keyHashOf(TOKEN), createdAt: now, lastSeenMs: now },
      {
        snapshot: old.snapshot,
        appliedLog: old.appliedLog,
        pendingDeliveries: old.pendingDeliveries,
        targetRulesetVersion: TARGET_RULESET,
        nextRequestId: old.nextRequestId ?? 1,
      },
    );
    console.log('Alter Einzel-Spielstand übernommen — das bisherige Token ist jetzt sein Schlüssel.');
  }
}

console.log(`Höfe: ${accounts.count}`);

// ── Hilfen ─────────────────────────────────────────────────────────────
function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

/** Nur fürs Admin-Panel. Spieler kommen mit ihrem Hof-Schlüssel (siehe unten). */
function isAdmin(req: IncomingMessage): boolean {
  const a = Buffer.from(bearer(req));
  const b = Buffer.from(TOKEN as string);
  // Längen zuerst prüfen: timingSafeEqual wirft bei ungleicher Länge.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Grobe Herkunft für die Anlege-Bremse. Reicht für Versehen, nicht gegen Botnetze.
 *
 * `x-forwarded-for` wird **nur hinter einem Proxy** geglaubt. Steht keiner
 * davor, kann jeder Aufrufer diesen Kopf selbst setzen — und die Bremse wäre
 * mit einer Zeile umgangen, indem man bei jedem Versuch eine andere Zahl
 * hineinschreibt.
 */
function originOf(req: IncomingMessage): string {
  if (CONFIG.behindProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0]!.trim();
    }
  }
  return req.socket.remoteAddress ?? 'unbekannt';
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readBody(req: IncomingMessage, limitBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // R4: Ein Angreifer wählt die Log-Länge frei. Also hart deckeln.
      if (size > limitBytes) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Gegenstandsname → Katalogindex, unter dem Regelwerk des aktuellen Snapshots.
 *
 * Die Admin-Schnittstelle spricht Namen, der Zustand spricht Indizes. Die
 * Übersetzung gehört genau hierhin — der Sim-Kern kennt keine Namen (§2.2),
 * und ein Mensch tippt keine Indizes.
 */
function resolveItem(game: Server, name: string): number | null {
  const rules = getRuleset(game.snapshot.rulesetVersion);
  const index = rules.items.findIndex((i) => i.id === name);
  return index >= 0 ? index : null;
}

function loadPage(name: string): string | null {
  const path = join(ROOT, 'dist', name);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/**
 * Zwei Oberflächen auf demselben Kern.
 *
 * `/` ist das Spiel. `/feldtest` ist das Messgerät: dieselbe Sim, aber mit
 * Warteschlangenlänge, `seq`, Tick und Protokoll im Bild. Beide sind echte
 * Clients — wenn sie auseinanderlaufen, liegt es an der Sim und nicht an einer
 * Anzeige, und genau das will man wissen können.
 */
const farmPage = loadPage('farm.html');
const page = loadPage('field-test.html');
const adminPage = loadPage('admin.html');

/**
 * Service Worker und Manifest — die App-Hülle, die ohne Netz startet.
 *
 * Der Cachename trägt einen **Fingerabdruck der ausgelieferten Seite**, und das
 * ist keine Feinheit, sondern die Stelle, an der diese Datei einmal richtig
 * falsch war.
 *
 * Vorher stand hier `CONFIG.version` — eine Umgebungsvariable, die auf
 * `unbekannt` steht, wenn niemand sie setzt. Der Cachename war damit bei jedem
 * Deploy derselbe, `sw.js` war byteweise identisch, der Browser sah keinen
 * Grund für eine Erneuerung, und weil die Hülle aus dem Cache zuerst kommt,
 * bekam der Spieler **für immer** die alte Seite. Auch nach einem frischen
 * Clone: Die veraltete Kopie liegt im Browser, nicht im Repo. Der Fehler war
 * genau deshalb so unangenehm, weil serverseitig alles richtig aussah.
 *
 * Ein Hash über die Seite kann man nicht vergessen zu setzen. Ändert sich die
 * Oberfläche, ändert sich der Name; ändert sie sich nicht, bleibt der Cache
 * stehen und ein Neustart kostet niemanden seine Offline-Hülle.
 */
const SHELL_VERSION = (() => {
  const fingerprint = createHash('sha256')
    .update(farmPage ?? 'kein-build')
    .digest('hex')
    .slice(0, 12);
  // Die lesbare Version bleibt vorn — im Cache-Namen des Browsers will man
  // erkennen können, welcher Stand da liegt.
  return `${CONFIG.version}-${fingerprint}`;
})();

const swSource = (() => {
  const path = join(ROOT, 'web', 'sw.template.js');
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8').replace('__VERSION__', SHELL_VERSION);
})();

const MANIFEST = JSON.stringify({
  name: 'Neues Spiel',
  short_name: 'Hof',
  start_url: '/',
  display: 'standalone',
  background_color: '#f2f5f6',
  theme_color: '#0f7f81',
  icons: [],
});

/**
 * Das Admin-Panel ist ein Testwerkzeug: In Dev an, in Produktion aus.
 * Es kann Gegenstände verschenken und Zeit gutschreiben — siehe config.ts.
 */
const ADMIN_ENABLED = CONFIG.adminEnabled;


/**
 * Die Werkbank (§ Feldtest).
 *
 * Alle Eingriffe laufen über Mechanismen, die es ohnehin gibt: Zustellungen
 * ins Postfach (§7) und das Zeitbudget (§4). Kein direkter Griff in Plätze
 * oder Bestände — der würde beim nächsten Sync einen Divergenz-Alarm
 * auslösen, obwohl gar kein Bug vorliegt.
 *
 * Seit es Accounts gibt, braucht jeder Eingriff ein Ziel: `?account=<id>`.
 * Ohne Angabe nimmt die Werkbank den zuletzt angelegten Hof — bequem, solange
 * man allein entwickelt, und in Produktion ist sie ohnehin aus.
 */
function handleAdmin(url: URL, req: IncomingMessage, res: ServerResponse) {
  if (url.pathname === '/api/admin/accounts') {
    return json(res, 200, {
      count: accounts.count,
      accounts: accounts.list().map((a) => ({
        id: a.id,
        createdAt: a.createdAt,
        lastSeenMs: a.lastSeenMs,
        seq: live.get(a.id)?.snapshot.seq ?? null,
      })),
    });
  }

  const wanted = url.searchParams.get('account');
  const target = wanted
    ? accounts.get(wanted)
    : (accounts.list().at(-1) ?? null);
  if (!target) return json(res, 404, { error: 'NO_SUCH_ACCOUNT' });
  const game = gameFor(target);

  if (url.pathname === '/api/admin/status') {
    return json(res, 200, {
      accountId: target.id,
      accounts: accounts.count,
      // Der Katalog gehört mit in die Antwort: Der Zustand hält nur Zahlen in
      // Katalogreihenfolge, und welche Reihenfolge das ist, hängt an der
      // Regelversion.
      itemIds: getRuleset(game.snapshot.rulesetVersion).items.map((i) => i.id),
      seq: game.snapshot.seq,
      tick: game.snapshot.state.tick,
      serverTs: game.snapshot.serverTs,
      serverTime: Date.now(),
      rulesetVersion: game.snapshot.rulesetVersion,
      targetRulesetVersion: game.targetRulesetVersion,
      pendingDeliveries: game.pendingDeliveries.length,
      activeDevice: game.activeDevice,
      divergenceAlerts: game.divergenceAlerts.length,
      migrationFailures: game.migrationFailures.length,
      state: game.snapshot.state,
    });
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });

  if (url.pathname === '/api/admin/time') {
    const seconds = Number(url.searchParams.get('seconds') ?? '0');
    if (!Number.isInteger(seconds) || seconds <= 0 || seconds > 90 * 86_400) {
      return json(res, 400, { error: 'BAD_SECONDS' });
    }
    game.grantTime(seconds);
    persist(target, game);
    console.log(`[admin] ${target.id}: ${seconds}s Zeit gutgeschrieben`);
    return json(res, 200, { ok: true, serverTs: game.snapshot.serverTs });
  }

  if (url.pathname === '/api/admin/grant') {
    const name = url.searchParams.get('item') ?? 'eggs';
    const amount = Number(url.searchParams.get('amount') ?? '10');
    const item = resolveItem(game, name);
    if (item === null || !Number.isInteger(amount) || amount <= 0) {
      return json(res, 400, { error: 'BAD_GRANT' });
    }
    game.deliver({ item, amount, arrivedAt: Date.now() });
    persist(target, game);
    console.log(`[admin] ${target.id}: ${amount} ${name} ins Postfach`);
    return json(res, 200, { ok: true, queued: game.pendingDeliveries.length });
  }

  if (url.pathname === '/api/admin/ruleset') {
    const version = Number(url.searchParams.get('version') ?? '0');
    if (!RULESETS.has(version)) return json(res, 400, { error: 'UNKNOWN_RULESET' });
    if (version < game.snapshot.rulesetVersion) {
      // Downgrades sind bewusst nicht vorgesehen (siehe migrate.ts).
      return json(res, 400, { error: 'DOWNGRADE_NOT_SUPPORTED' });
    }
    game.targetRulesetVersion = version;
    persist(target, game);
    console.log(`[admin] ${target.id}: Zielversion v${version} — greift beim nächsten Sync`);
    return json(res, 200, { ok: true, targetRulesetVersion: version });
  }

  if (url.pathname === '/api/admin/reset') {
    game.reset(initialState(getRuleset(TARGET_RULESET)), Date.now(), TARGET_RULESET);
    // Sonst stünden im Buch Angebote zu Aufträgen, die es nicht mehr gibt —
    // und jemand könnte Ware kaufen, die niemand mehr besitzt.
    market.forget(target.id);
    game.stockRequests();
    game.stockOffers();
    persist(target, game);
    console.log(`[admin] ${target.id}: Spielstand zurückgesetzt`);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'NOT_FOUND' });
}

// ── Routen ─────────────────────────────────────────────────────────────
async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // HSTS nur, wenn wir selbst verschlüsseln. Steht ein Endpunkt davor, setzt
  // der ihn — und ihn hier über eine Klartextverbindung mitzuschicken, wäre
  // ein Versprechen, das dieser Server nicht halten kann.
  if (CONFIG.tls) {
    res.setHeader('strict-transport-security', 'max-age=31536000');
  }

  // Browser fragen das ungefragt an; ein 404 im Log wäre nur Rauschen.
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }

  if (url.pathname === '/health') {
    // Umgebung und Stand gehören hier hinein: Nur so sieht man von außen,
    // WELCHE Version gerade läuft — die Frage, die man beim Deployen hat.
    //
    // Nichts über einzelne Höfe: Die Route braucht bewusst keine Zugangsdaten,
    // also darf sie auch nichts verraten, was einem Hof gehört.
    return json(res, 200, {
      ok: true,
      env: CONFIG.env,
      version: CONFIG.version,
      rulesetVersion: TARGET_RULESET,
      // Fingerabdruck der ausgelieferten Oberfläche. Steht hier, weil genau
      // diese Frage von außen sonst nicht zu beantworten ist: „Sehe ich die
      // neue Seite oder eine alte aus meinem Browser-Cache?" Stimmt der Wert
      // hier nicht mit dem Cachenamen im Browser überein, liegt es am Browser.
      shell: SHELL_VERSION,
      accounts: accounts.count,
      offers: market.size,
      // Wie viele Spielstände gerade auf das Schreiben warten. Steigt die Zahl
      // dauerhaft, kommt die Platte nicht hinterher.
      pendingWrites: accounts.pendingWrites,
      live: live.size,
      // Offene Live-Leitungen. Jede kostet Speicher, auch wenn nichts passiert
      // — auf einem kleinen Server die Zahl, die man im Auge behält.
      streams: events.size,
      // Warum Offline-Arbeit abgelehnt oder abgeschnitten wurde, seit dem
      // Start. Nach einem Ausrollen die erste Zahl, die man ansieht:
      // `OFFER_GONE` ist normal, `UNKNOWN_COMMAND` bedeutet Versionsbruch.
      rejections: Object.fromEntries(rejections),
      // Damit sich von außen prüfen lässt, ob wirklich verschlüsselt ankommt,
      // was man sich beim Aufsetzen vorgenommen hat.
      secure: isSecureTransport(CONFIG),
    });
  }

  // Die Hülle: ohne Token, weil sie nichts über den Spielstand verrät. Wer
  // spielen will, braucht danach trotzdem eines.
  if (url.pathname === '/sw.js' && req.method === 'GET') {
    if (!swSource) return json(res, 500, { error: 'sw.template.js fehlt' });
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      // Der Worker selbst darf nie aus dem Browser-Cache kommen — sonst
      // erneuert sich die Hülle nie wieder.
      'cache-control': 'no-cache',
    });
    return res.end(swSource);
  }

  if (url.pathname === '/manifest.webmanifest' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'application/manifest+json; charset=utf-8',
      'cache-control': 'no-cache',
    });
    return res.end(MANIFEST);
  }

  if (url.pathname === '/admin' && req.method === 'GET') {
    if (!ADMIN_ENABLED) return json(res, 403, { error: 'ADMIN_DISABLED' });
    if (!adminPage) return json(res, 500, { error: 'Seite fehlt — `npm run build`.' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(adminPage);
  }

  if (url.pathname === '/feldtest' && req.method === 'GET') {
    if (!page) return json(res, 500, { error: 'Seite fehlt — bitte `npm run build` ausführen.' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(page);
  }

  if (url.pathname === '/' && req.method === 'GET') {
    if (!farmPage) return json(res, 500, { error: 'Seite fehlt — bitte `npm run build` ausführen.' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(farmPage);
  }

  if (url.pathname.startsWith('/api/')) {
    // ── Neuen Hof anlegen ────────────────────────────────────────────
    //
    // Die einzige Route ohne Zugangsdaten — man hat ja noch keine. Deshalb
    // steht davor eine Bremse (R4): Ohne sie füllt jemand in einer Minute
    // die Platte.
    if (url.pathname === '/api/account' && req.method === 'POST') {
      const allowed = limiter.allow(originOf(req), Date.now(), accounts.count);
      if (!allowed.ok) return json(res, 429, { error: allowed.reason });

      const game = freshGame();
      const { account, key } = accounts.create(Date.now(), snapshotOf(game));
      wireMarket(account.id, game);
      game.stockOffers();
      live.set(account.id, game);
      console.log(`[account] neuer Hof ${account.id} (${accounts.count} gesamt)`);

      // Der Schlüssel wird GENAU EINMAL ausgeliefert. Danach kennt der Server
      // nur seinen Hash — auch wir können ihn nicht mehr nachschlagen.
      return json(res, 201, {
        key,
        accountId: account.id,
        snapshot: game.snapshot,
        serverTime: Date.now(),
        isActiveDevice: true,
        activeSince: null,
      });
    }

    // ── Admin: eigenes Token, eigener Pfad ───────────────────────────
    if (url.pathname.startsWith('/api/admin/')) {
      if (!ADMIN_ENABLED) return json(res, 403, { error: 'ADMIN_DISABLED' });
      if (!isAdmin(req)) return json(res, 401, { error: 'UNAUTHORIZED' });
      return handleAdmin(url, req, res);
    }

    // ── Alles Übrige gehört einem Hof ────────────────────────────────
    const account = accounts.resolve(bearer(req));
    if (!account) return json(res, 401, { error: 'UNAUTHORIZED' });
    const game = gameFor(account);

    if (url.pathname === '/api/state' && req.method === 'GET') {
      const deviceId = url.searchParams.get('deviceId') ?? undefined;
      // Verkäufe abrechnen und die Auslage frisch machen, BEVOR geantwortet
      // wird: Wer die App öffnet, soll den aktuellen Stand sehen und nicht
      // einen, der erst durch eine Aktion nachzieht.
      // Abrechnen und alles Zugestellte einarbeiten, BEVOR geantwortet wird:
      // Wer die App öffnet, soll seinen Erlös und die Auslage sofort sehen und
      // nicht erst, nachdem er zufällig irgendwo hingetippt hat.
      settle(account, game);
      game.receiveExternal();
      persist(account, game);
      return json(res, 200, {
        accountId: account.id,
        snapshot: game.snapshot,
        serverTime: Date.now(),
        // Damit ein zweites Gerät es erfährt, BEVOR es losspielt (R3).
        isActiveDevice: game.isActiveDevice(deviceId),
        activeSince: game.activeDevice?.lastSyncMs ?? null,
      });
    }

    /**
     * Die Live-Leitung: ein offener Strom, auf dem „sync jetzt" steht.
     *
     * Kein Zustand, keine Spieldaten — warum, steht in `events.ts`. Für diese
     * Schicht sind drei Dinge wichtig:
     *
     *  1. **Keine Kompression.** Ein `gzip`-Puffer, der auf mehr Daten wartet,
     *     hält genau die Nachricht zurück, deren einziger Zweck es ist, sofort
     *     anzukommen. `x-accel-buffering: no` sagt einem vorgeschalteten nginx
     *     dasselbe.
     *  2. **Kein Socket-Timeout.** Node schließt sonst eine Verbindung, auf der
     *     minutenlang nichts passiert — und das ist hier der Normalfall.
     *  3. **Eine Obergrenze.** Passt niemand mehr rein, gibt es eine ehrliche
     *     Absage statt einer Leitung, die nie etwas liefert. Der Client spielt
     *     dann mit seinem Timer weiter; er merkt nichts außer ein paar
     *     Sekunden Verzögerung.
     */
    if (url.pathname === '/api/events' && req.method === 'GET') {
      const stop = events.subscribe(account.id, {
        write: (chunk) => {
          if (res.writableEnded) return false;
          res.write(chunk);
          return true;
        },
        close: () => {
          if (!res.writableEnded) res.end();
        },
      });
      if (!stop) return json(res, 503, { error: 'TOO_MANY_STREAMS' });

      req.socket.setTimeout(0);
      req.socket.setNoDelay(true);
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      // Erste Zeile sofort, damit der Browser den Strom als offen ansieht und
      // `onopen` feuert — sonst hängt die Anzeige auf „verbinde…".
      res.write(': willkommen\n\n');

      req.on('close', stop);
      res.on('close', stop);
      return;
    }

    if (url.pathname === '/api/sync' && req.method === 'POST') {
      let body: string;
      try {
        body = await readBody(req, 512 * 1024);
      } catch {
        return json(res, 413, { error: 'PAYLOAD_TOO_LARGE' });
      }

      let parsed: SyncRequest;
      try {
        parsed = JSON.parse(body) as SyncRequest;
      } catch {
        return json(res, 400, { error: 'BAD_JSON' });
      }
      if (!parsed || !Array.isArray(parsed.commands)) {
        return json(res, 400, { error: 'BAD_REQUEST' });
      }
      if (parsed.commands.length > 5000) {
        return json(res, 413, { error: 'TOO_MANY_COMMANDS' });
      }

      // Erst abrechnen, dann rechnen: Ein Verkauf, der während der Abwesenheit
      // stattfand, muss VOR der Re-Simulation im Zustand stehen. Sonst könnte
      // ein offline zurückgezogener Auftrag denselben Warenposten ein zweites
      // Mal ins Lager holen (M5, siehe `applySale`).
      settle(account, game);

      // Zeitautorität: der Server misst selbst (§4).
      const result = game.sync(parsed, Date.now());
      // Was jetzt im Escrow liegt, ist die Wahrheit — das Buch zieht nach.
      publish(account.id, game);
      persist(account, game);

      // `serverTime` mitgeben, damit der Client seine Uhr gegen die des Servers
      // ausrichten kann. Ohne das müsste er seiner eigenen vertrauen — und die
      // ist genau das, was der Server nicht akzeptiert (§4).
      Object.assign(result as object, { serverTime: Date.now() });

      noteTruncation(result, parsed.commands.length, account.id);

      const label = result.ok ? result.kind : `abgelehnt: ${result.reason}`;
      console.log(
        `[sync] ${account.id} ${parsed.commands.length} Commands → ${label}, seq=${game.snapshot.seq}`,
      );
      return json(res, 200, result);
    }

    // Zustellung an den EIGENEN Hof — praktisch für Skripte und Tests.
    if (url.pathname === '/api/deliver' && req.method === 'POST') {
      const name = url.searchParams.get('item') ?? 'eggs';
      const amount = Number(url.searchParams.get('amount') ?? '5');
      const item = resolveItem(game, name);
      if (item === null || !Number.isInteger(amount) || amount <= 0) {
        return json(res, 400, { error: 'BAD_DELIVERY' });
      }
      game.deliver({ item, amount, arrivedAt: Date.now() });
      persist(account, game);
      return json(res, 200, { queued: game.pendingDeliveries.length });
    }

    return json(res, 404, { error: 'NOT_FOUND' });
  }

  return json(res, 404, { error: 'NOT_FOUND' });
}

/**
 * Zertifikat und Schlüssel einlesen — beim Start, nicht bei der ersten Anfrage.
 *
 * Ein unlesbarer Schlüssel soll beim Deployen auffallen, nicht später beim
 * ersten Spieler. Und er soll den Start abbrechen statt still auf Klartext
 * zurückzufallen: Genau dieser Rückfall ist der Fehler, den man nicht bemerkt.
 */
function createServer() {
  if (!CONFIG.tls) return createHttpServer(handle);

  const { certPath, keyPath, caPath } = CONFIG.tls;
  let cert: Buffer;
  let key: Buffer;
  try {
    cert = readFileSync(certPath);
    key = readFileSync(keyPath);
  } catch (err) {
    console.error(`\nStart abgebrochen: Zertifikat oder Schlüssel nicht lesbar.`);
    console.error(`  Zertifikat: ${certPath}`);
    console.error(`  Schlüssel:  ${keyPath}`);
    console.error(`  ${(err as Error).message}\n`);
    return process.exit(1);
  }

  const https = createHttpsServer(
    { cert, key, ca: caPath ? readFileSync(caPath) : undefined },
    handle,
  );

  /**
   * `http://` auf den TLS-Port ergibt beim Aufrufer „Empty reply from server" —
   * eine Fehlermeldung, die in jede Richtung zeigt außer in die richtige.
   *
   * Antworten kann der Server hier nicht: Der Handschlag ist gescheitert, und
   * was man auf diesen Socket schreibt, geht durch die tote TLS-Schicht und
   * kommt nie an. (Der rohe Socket läge darunter, aber nur über ein
   * Node-Internum — das ist es nicht wert.) Also wenigstens im Protokoll
   * sagen, was los ist; dort sucht man beim Aufsetzen ohnehin.
   */
  let lastPlaintextHint = 0;
  https.on('clientError', (err, socket) => {
    if ((err as NodeJS.ErrnoException).code === 'ERR_SSL_HTTP_REQUEST') {
      const now = Date.now();
      // Ein Scanner soll das Protokoll nicht zumüllen: höchstens einmal pro Minute.
      if (now - lastPlaintextHint > 60_000) {
        lastPlaintextHint = now;
        console.log(
          `[tls] unverschlüsselte Anfrage auf Port ${PORT} abgewiesen — ` +
            'dieser Port spricht https://, nicht http://.',
        );
      }
    }
    socket.destroy();
  });

  return https;
}

const server = createServer();

server.listen(PORT, CONFIG.host, () => {
  console.log('');
  for (const line of describeConfig(CONFIG)) console.log(line);
  console.log(`Regelwerk:   Ziel v${TARGET_RULESET}`);
  console.log(`Höfe:        ${accounts.count}`);
  console.log(`Spiel:       ${farmPage ? '/' : 'FEHLT (npm run build)'}`);
  console.log(`Feldtest:    ${page ? '/feldtest' : 'FEHLT (npm run build)'}`);
  console.log(`Admin:       …${TOKEN.slice(-4)}  (vollständig: cat ${TOKEN_PATH})`);
  console.log('');
});

/**
 * Gesammelt schreiben statt bei jedem Sync.
 *
 * DAS ist der Unterschied zwischen „ein paar Dutzend Spieler" und „ein paar
 * tausend": Zweitausend geänderte Spielstände kosten so einen Schreibvorgang
 * statt zweitausend. Der Preis ist ein Fenster von zwei Sekunden, in dem eine
 * Änderung nur im Speicher steht — deshalb ist es in Sekunden gemessen und
 * nicht in Minuten, und deshalb wird beim Beenden noch einmal geschrieben.
 */
const FLUSH_MS = Number(process.env.NEUES_SPIEL_FLUSH_MS ?? 2000);
const flushTimer = setInterval(() => {
  try {
    accounts.flush();
    market.flush();
  } catch (err) {
    // Nicht geschrieben heißt: bleibt gemerkt, nächster Versuch in zwei
    // Sekunden. Der Server soll daran nicht sterben.
    console.error(`[speicher] Schreiben fehlgeschlagen: ${(err as Error).message}`);
  }
}, FLUSH_MS);
flushTimer.unref();

/**
 * Aufgelaufene Anstöße rausschreiben, und die Leitungen wach halten.
 *
 * Zwei Takte, weil sie zwei verschiedene Dinge tun: Der schnelle bündelt, was
 * sich seit dem letzten Mal getan hat (der Hub wirft Doppelte weg und hält
 * seinen eigenen Mindestabstand ein), der langsame schickt ein Lebenszeichen,
 * damit Proxys und Mobilfunknetze die stille Leitung nicht zumachen.
 */
const nudgeTimer = setInterval(() => events.flush(), 250);
nudgeTimer.unref();
const heartbeatTimer = setInterval(() => events.heartbeat(), 25_000);
heartbeatTimer.unref();

/**
 * Ungenutzte Höfe aus dem Speicher werfen.
 *
 * Ohne das wächst `live` monoton: Wer einmal gespielt hat, bleibt bis zum
 * Neustart im Arbeitsspeicher. Bei ein paar tausend Spielern am Tag ist das
 * der Punkt, an dem ein Server mit 1 GB umkippt — und zwar nicht unter Last,
 * sondern irgendwann nachts.
 *
 * Rausgeworfen wird nur, was geschrieben ist; beim nächsten Zugriff wird der
 * Hof aus der Datenbank geladen, als wäre nichts gewesen.
 */
const IDLE_MS = Number(process.env.NEUES_SPIEL_IDLE_MS ?? 15 * 60_000);
const evictTimer = setInterval(() => {
  const cutoff = Date.now() - IDLE_MS;
  let evicted = 0;
  for (const [id] of live) {
    const account = accounts.get(id);
    if (!account || account.lastSeenMs > cutoff) continue;
    if (accounts.pendingWrites > 0) accounts.flush();
    live.delete(id);
    evicted++;
  }
  if (evicted > 0) console.log(`[speicher] ${evicted} ruhende Höfe aus dem Speicher entlassen`);
}, 60_000);
evictTimer.unref();

// Sauber beenden, damit der letzte Sync sicher auf der Platte liegt.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} — speichere und beende.`);
    // Erst die offenen Leitungen zumachen: Sonst wartet `server.close()` auf
    // Verbindungen, die per Konstruktion nie von selbst enden.
    events.closeAll();
    for (const [id, g] of live) {
      const account = accounts.get(id);
      if (account) persist(account, g);
    }
    market.flush();
    accounts.close();

    /**
     * Notausgang, falls `server.close()` nicht zurückkommt.
     *
     * Es wartet auf alle offenen Verbindungen, und eine davon kann hängen —
     * eine halb gesendete Anfrage, ein Client, der den Socket nicht zumacht.
     * Ohne diese Bremse liefe der Prozess dann bis `TimeoutStopSec` (20 s)
     * weiter, systemd räumte ihn hart ab, und aus zwei Sekunden Neustart
     * würden fünfundzwanzig.
     *
     * Verlieren kann man dabei nichts: Geschrieben ist oben schon, die
     * Datenbank ist zu. Was hier noch offen ist, sind Verbindungen, keine
     * Spielstände — und ein abgeschnittener Sync ist für den Client derselbe
     * Fall wie ein Funkloch. Er behält seine Warteschlange und schickt sie
     * gleich noch einmal (§9).
     */
    const giveUp = setTimeout(() => {
      console.log('[stop] offene Verbindungen hängen — beende trotzdem.');
      process.exit(0);
    }, 2000);
    giveUp.unref();

    server.close(() => {
      clearTimeout(giveUp);
      process.exit(0);
    });
  });
}

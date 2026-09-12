import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
  createReadStream,
  readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { freemem, totalmem } from 'node:os';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Server } from './server.ts';
import type { Eingriff, SyncRequest } from './server.ts';
import { farmView } from '../client/view.ts';
import { load, save } from './store.ts';
import { initialState, normalizeState, count } from '../sim/state.ts';
import { migrateState } from '../sim/migrate.ts';
import type { State } from '../sim/state.ts';
import { LATEST_RULESET_VERSION, RULESETS, getRuleset, levelOf } from '../sim/rules.ts';
import { ConfigError, describeConfig, isLoopback, isSecureTransport, resolveConfig } from './config.ts';
import { AccountStore, Bremse, CreateLimiter, keyHashOf, saubereWort, WORT_MAX, WORT_MIN } from './accounts.ts';
import type { AccountRecord } from './accounts.ts';
import { SqliteStorage } from './storage.ts';
import { NAME_MAX, Sozial, saubererName, tagVon } from './sozial.ts';
import type { HofKarte } from './sozial.ts';
import { Tagesbonus } from './tagesbonus.ts';
import { Market, connectMarket, publishOrders, settleSales } from './market.ts';
import { EventHub } from './events.ts';
import { ladeVapid, sendePush } from './push.ts';
import { apnsAusUmgebung, sendeApns } from './apns.ts';
import type { PushAbo } from './storage.ts';
import { EconStats } from './econstats.ts';

const ROOT = join(import.meta.dirname, '..', '..');

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

const accounts = new AccountStore(CONFIG.dbPath, join(dirname(SAVE_PATH), 'accounts'));
const econstats = new EconStats(join(dirname(SAVE_PATH), 'econstats.json'));
// Bremsen. Der Sync je Konto: Ein Mensch schafft ein paar Abgleiche je
// Sekunde, ein Skript tausend — dazwischen liegt die Grenze. Wiederherstellung
// je Hofcode UND je Herkunft, weil der Hofcode halb öffentlich ist (Nachbarn
// kennen ihn). Rückmeldungen je Konto, Fehlerberichte je Herkunft.
const SYNC_BREMSE = new Bremse(Number(process.env.NEUES_SPIEL_SYNC_PER_MIN ?? 240), 60_000);
const WIEDER_BREMSE_HOF = new Bremse(5, 3_600_000);
const WIEDER_BREMSE_HERKUNFT = new Bremse(20, 3_600_000);
const RUECK_BREMSE = new Bremse(10, 3_600_000);
const FEHLER_BREMSE = new Bremse(30, 3_600_000);

const limiter = new CreateLimiter(
  Number(process.env.NEUES_SPIEL_NEW_PER_HOUR ?? 20),
  Number(process.env.NEUES_SPIEL_MAX_ACCOUNTS ?? 5000),
);

const market = new Market(accounts.storage);

// Push: Schlüsselpaar liegt neben den Serverdaten und wird beim ersten Start
// erzeugt. Es darf sich nie ändern, sonst verfallen alle Abos der Spieler.
const VAPID = ladeVapid(join(dirname(SAVE_PATH), 'vapid.json'), 'mailto:hof@neues-spiel');

// Echte Push-Dienste sprechen immer HTTPS. Nur auf dem eigenen Rechner lassen
// wir HTTP zu, sonst ließe sich der Weg lokal nicht ausprobieren.
function pushZielErlaubt(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && isLoopback(u.hostname);
}

// Die native iOS-App bekommt ihre Meldungen über Apple, nicht über Web-Push.
// Ohne Schlüssel von Apple bleibt der Weg aus, alles andere läuft weiter.
const APNS = apnsAusUmgebung();
if (APNS) console.log(`[apns] aktiv für ${APNS.bundleId}${APNS.sandbox ? ' (Sandbox)' : ''}`);

// Schickt eine Nachricht an alle Geräte eines Kontos, jeweils auf dem Weg, den
// das Gerät braucht. Tote Abos fliegen raus, bei Netzfehlern bleiben sie.
async function pushAn(
  kontoIds: readonly string[],
  titel: string,
  text: string,
  art: string,
): Promise<{ gesendet: number; entfernt: number; ohneWeg: number; fehler: string[] }> {
  let gesendet = 0;
  let entfernt = 0;
  let ohneWeg = 0;
  // Gründe sammeln, aber nur einmal je Sorte — bei tausend Geräten will
  // niemand tausend gleiche Zeilen lesen.
  const gruende = new Map<string, number>();
  const merke = (grund: string) => gruende.set(grund, (gruende.get(grund) ?? 0) + 1);

  for (const id of kontoIds) {
    for (const abo of accounts.storage.listPushAbos(id)) {
      let r: { ok: boolean; status: number; weg: boolean; grund?: string };
      if (abo.art === 'ios') {
        if (!APNS) {
          ohneWeg++;
          merke('Apple-Schlüssel fehlt auf dem Server');
          continue;
        }
        r = await sendeApns(APNS, abo.endpoint, titel, text, art);
      } else {
        r = await sendePush(VAPID, abo, { titel, text, art });
      }
      if (r.ok) {
        gesendet++;
        accounts.storage.putPushAbo({ ...abo, zuletztMs: Date.now() });
        continue;
      }
      merke(apnsKlartext(abo.art, r.status, r.grund));
      if (r.weg) {
        accounts.storage.dropPushAbo(abo.endpoint);
        entfernt++;
      }
    }
  }

  const fehler = [...gruende].map(([grund, n]) => (n > 1 ? `${grund} (${n}x)` : grund));
  for (const zeile of fehler) console.warn(`[push] ${zeile}`);
  return { gesendet, entfernt, ohneWeg, fehler };
}

// Apples Fehlergründe sind knapp und englisch. Die häufigen übersetzen wir,
// weil genau sie beim Einrichten auftreten.
function apnsKlartext(art: string, status: number, grund?: string): string {
  if (art !== 'ios') return status === 0 ? 'Push-Dienst nicht erreichbar' : `Push-Dienst antwortet ${status}`;
  switch (grund) {
    case 'BadDeviceToken':
      return 'Token passt nicht zur Umgebung — steht NEUES_SPIEL_APNS_SANDBOX richtig? ' +
        '(1 für Xcode-Builds aufs Gerät, weg für TestFlight und App Store)';
    case 'TopicDisallowed':
    case 'DeviceTokenNotForTopic':
      return 'Bundle-ID passt nicht: NEUES_SPIEL_APNS_BUNDLE_ID muss der App-ID entsprechen';
    case 'InvalidProviderToken':
    case 'ExpiredProviderToken':
      return 'Apple lehnt den Schlüssel ab — Key-ID, Team-ID oder .p8-Datei stimmen nicht';
    case 'Unregistered':
      return 'App wurde vom Gerät entfernt, Abo gelöscht';
    default:
      return grund ? `Apple lehnt ab: ${grund}` : `Apple antwortet ${status}`;
  }
}
const sozial = new Sozial((accounts.storage as SqliteStorage).database);
const tagesbonus = new Tagesbonus((accounts.storage as SqliteStorage).database);
market.hofInfo = (id) => {
  const karte = sozial.karte(id);
  return karte ? { code: karte.code, name: karte.name } : { code: '', name: 'Unbekannt' };
};

const live = new Map<string, Server>();

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

  game.stockRequests();
  return game;
}

function zielKonto(id: string): AccountRecord {
  const konto = accounts.get(id);
  if (!konto) throw new Error(`Hof ${id} ist verschwunden`);
  return konto;
}

function hofZeile(karte: HofKarte, wer: string) {
  const rules = getRuleset(LATEST_RULESET_VERSION);
  const proTag = rules.helpPerFarmPerDay ?? 0;
  const stand = sozial.beziehung(wer, karte.id);
  return {
    code: karte.code,
    name: karte.name,
    stand,
    freund: stand === 'freund',
    heute: sozial.hilfenHeute(wer, karte.id, Date.now()),
    proTag,
  };
}

// Der Hof eines anderen, so wie der Besucher ihn sehen darf: der ganze
// Spielstand ohne Lager und Post, auf die Fassung des Besuchers gewandert, damit
// dessen Spiel ihn mit denselben Regeln zeichnen kann wie den eigenen Hof.
function besuchsBild(karte: HofKarte, wer: string, meineVersion: number) {
  const spiel = gameFor(zielKonto(karte.id));
  spiel.receiveExternal();
  let state: State = spiel.snapshot.state;
  let version = spiel.snapshot.rulesetVersion;
  if (meineVersion > version) {
    try {
      state = migrateState(state, version, meineVersion);
      version = meineVersion;
    } catch {
      // bleibt bei seiner Fassung — der Besucher sieht dann, dass es nicht passt
    }
  }
  const oeffentlich: State = {
    ...state,
    items: state.items.map(() => 0),
    mail: [],
    offers: [],
  };

  return {
    ...hofZeile(karte, wer),
    rulesetVersion: version,
    tick: state.tick,
    serverTs: spiel.snapshot.serverTs,
    xp: state.xp,
    zustand: oeffentlich,
    angebote: state.orders.map((o) => ({
      id: o.id,
      item: o.item,
      amount: o.amount,
      price: o.price,
      verkauft: o.verkauft,
    })),
  };
}

function snapshotOf(game: Server) {
  return {
    snapshot: game.snapshot,
    appliedLog: game.appliedLog,
    logStartSeq: game.logStartSeq,
    pendingDeliveries: game.pendingDeliveries,
    targetRulesetVersion: game.targetRulesetVersion,
    nextRequestId: game.nextRequestId,
    pendingXp: game.pendingXp,
    pendingAbzuege: game.pendingAbzuege,
    eingriffe: game.eingriffe,
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
    game.snapshot = { ...file.snapshot, state: normalizeState(file.snapshot.state) };
    game.appliedLog = file.appliedLog;
    game.logStartSeq = file.logStartSeq ?? 1;

    game.trimLog();
    game.pendingDeliveries = file.pendingDeliveries;
    game.nextRequestId = file.nextRequestId ?? 1;
    game.pendingXp = file.pendingXp ?? 0;
    game.pendingAbzuege = file.pendingAbzuege ?? [];
    game.eingriffe = file.eingriffe ?? [];
    game.stockRequests();
  }
  wireMarket(account.id, game);
  live.set(account.id, game);
  return game;
}

function wireMarket(accountId: string, game: Server): void {
  connectMarket(
    market,
    accountId,
    game,
    (id) => live.get(id) ?? null,

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
  if (publishOrders(market, accountId, game)) events.broadcast('market', accountId);
}

const rejections = new Map<string, number>();

// Das Protokoll der Werkbank: was der Server an einem Hof bemerkt hat
// (abgelehnte Abgleiche, Divergenzen, Geraetewechsel) und was die Werkbank
// getan hat. Ein Ringpuffer im Speicher — fuer den Blick von eben, nicht als
// Archiv.
type ProtokollZeile = { t: number; konto: string | null; art: string; text: string };
const protokoll: ProtokollZeile[] = [];
function notiere(art: string, konto: string | null, text: string): void {
  protokoll.push({ t: Date.now(), konto, art, text });
  if (protokoll.length > 400) protokoll.splice(0, protokoll.length - 400);
}

function resolvePlot(rules: ReturnType<typeof getRuleset>, name: string | null): number | null {
  if (name === null || name === '') return null;
  const n = Number(name);
  if (Number.isInteger(n)) return rules.plots[n] ? n : null;
  const i = rules.plots.findIndex((p) => p.id === name);
  return i >= 0 ? i : null;
}

function katalogVon(rules: ReturnType<typeof getRuleset>) {
  return {
    version: rules.version,
    items: rules.items.map((i) => ({ id: i.id, storable: i.storable, npcPrice: i.npcPrice })),
    plots: rules.plots.map((p) => ({
      id: p.id,
      deco: !!p.deco,
      animal: !!p.animal,
      baum: !!p.baum,
      nurFest: !!p.nurFest,
      fixed: !!p.fixed,
      levels: p.levels.map((l) => ({ label: l.label })),
    })),
    recipes: rules.recipes.map((r) => ({ id: r.id })),
    chestKinds: (rules.chestKinds ?? []).map((k) => ({ id: k.id, label: k.label })),
    expansions: (rules.expansions ?? []).map((e) => ({ id: e.id })),
    obstacles: (rules.obstacles ?? []).map((o, i) => ({ index: i, kind: o.kind })),
    feste: rules.feste ? { arten: rules.feste.arten.map((a) => ({ id: a.id, label: a.label })) } : null,
    siloLevels: (rules.siloLevels ?? []).length,
    booster: !!rules.booster,
    currency: rules.currency,
    versionen: [...RULESETS.keys()].sort((x, y) => x - y),
  };
}

function noteTruncation(result: { ok: boolean; reason?: string }, sent: number, id: string): void {
  const reason = result.reason;
  if (!reason) return;

  const key = reason.replace(/^ILLEGAL_COMMAND:/, '');
  rejections.set(key, (rejections.get(key) ?? 0) + 1);

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

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function isAdmin(req: IncomingMessage): boolean {
  const a = Buffer.from(bearer(req));
  const b = Buffer.from(TOKEN as string);

  return a.length === b.length && timingSafeEqual(a, b);
}

function originOf(req: IncomingMessage): string {
  if (CONFIG.behindProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0]!.trim();
    }
  }
  return req.socket.remoteAddress ?? 'unbekannt';
}

// Eine gebündelte App lädt ihre Oberfläche vom Gerät, nicht vom Server. Für
// deren Herkunft muss der Server ausdrücklich Zugriff erlauben — aber nur für
// die paar bekannten App-Herkünfte, nicht für jede Webseite der Welt.
const APP_HERKUENFTE = new Set(
  (process.env.NEUES_SPIEL_APP_ORIGINS ?? 'capacitor://localhost,ionic://localhost')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
);

function herkunftErlaubt(req: IncomingMessage): string | null {
  const herkunft = req.headers.origin;
  if (typeof herkunft !== 'string') return null;
  return APP_HERKUENFTE.has(herkunft) ? herkunft : null;
}

function setzeCors(req: IncomingMessage, res: ServerResponse): void {
  const herkunft = herkunftErlaubt(req);
  if (!herkunft) return;
  res.setHeader('access-control-allow-origin', herkunft);
  res.setHeader('access-control-allow-headers', 'authorization, content-type');
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('access-control-max-age', '86400');
  res.setHeader('vary', 'origin');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

// JSON-Rumpf lesen; bei Überlänge oder Unsinn null statt einer Ausnahme.
async function leseJson<T>(req: IncomingMessage, limitBytes: number): Promise<T | null> {
  try {
    const roh = await readBody(req, limitBytes);
    const wert = JSON.parse(roh) as unknown;
    return wert && typeof wert === 'object' ? (wert as T) : null;
  } catch {
    return null;
  }
}

function kuerze(wert: unknown, max: number): string {
  return String(wert ?? '').trim().slice(0, max);
}

function readBody(req: IncomingMessage, limitBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;

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

function resolveItem(game: Server, name: string): number | null {
  const rules = getRuleset(game.snapshot.rulesetVersion);
  const index = rules.items.findIndex((i) => i.id === name);
  return index >= 0 ? index : null;
}

function loadPage(name: string): string | null {
  const path = join(ROOT, 'dist', name);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

const farmPage = loadPage('farm.html');
const adminPage = loadPage('admin.html');
const rechtPage = loadPage('impressum.html');

// App-/PWA-Icon. Bevorzugt web/icon.png (schönes Master-Bild fürs Spiel & die
// spätere iOS-App), sonst das mitgelieferte SVG als Fallback. Beide werden unter
// /icon.png bzw. /icon.svg ausgeliefert; das Manifest listet beide.
const ICON_SVG = (() => {
  const p = join(ROOT, 'web', 'icon.svg');
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
})();
const ICON_PNG = (() => {
  const p = join(ROOT, 'web', 'icon.png');
  return existsSync(p) ? readFileSync(p) : null;
})();

// Optionale Hintergrundmusik. Alle Tracks liegen in einem Ordner und werden von
// der Platte GESTREAMT (nie in den RAM geladen — kann groß sein). Der Client holt
// die Liste über /musik/ und spielt sie als zufällige Playlist ab.
// Ordner-Suche (zur Laufzeit, damit nachträglich Abgelegtes ohne Neustart wirkt):
//   1. $NEUES_SPIEL_MUSIK (fester Pfad)
//   2. <Datenverzeichnis>/musik  (auf dem Server ablegen, außerhalb von git)
//   3. web/musik                 (Tracks direkt im Repo)
function musikDir(): string | null {
  const kandidaten = [
    process.env.NEUES_SPIEL_MUSIK?.trim(),
    join(dirname(SAVE_PATH), 'musik'),
    join(ROOT, 'web', 'musik'),
  ];
  for (const p of kandidaten) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

function musikListe(): string[] {
  const dir = musikDir();
  if (!dir) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.mp3'))
      .sort();
  } catch {
    return [];
  }
}

// Einen Audioausschnitt von der Platte streamen (Range- und HEAD-fähig).
function streamAudio(req: IncomingMessage, res: ServerResponse, pfad: string): void {
  const total = statSync(pfad).size;
  const range = req.headers.range;
  let start = 0;
  let end = total - 1;
  let status = 200;
  const kopf: Record<string, string | number> = {
    'content-type': 'audio/mpeg',
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=86400',
  };

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    start = m && m[1] ? parseInt(m[1], 10) : 0;
    end = m && m[2] ? parseInt(m[2], 10) : total - 1;
    if (Number.isNaN(start)) start = 0;
    if (Number.isNaN(end) || end >= total) end = total - 1;
    if (start > end || start >= total) {
      res.writeHead(416, { 'content-range': `bytes */${total}` });
      res.end();
      return;
    }
    status = 206;
    kopf['content-range'] = `bytes ${start}-${end}/${total}`;
  }

  kopf['content-length'] = end - start + 1;
  res.writeHead(status, kopf);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const strom = createReadStream(pfad, { start, end });
  strom.on('error', () => {
    try {
      res.destroy();
    } catch {
      /* egal */
    }
  });
  req.on('close', () => strom.destroy());
  strom.pipe(res);
}

const SHELL_VERSION = (() => {
  const fingerprint = createHash('sha256')
    .update(farmPage ?? 'kein-build')
    .digest('hex')
    .slice(0, 12);

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
  // Das Spiel ist fürs Querformat gebaut (breiter Hof, waagerechtes Schwenken).
  orientation: 'landscape',
  background_color: '#f2f5f6',
  theme_color: '#0f7f81',
  // PNG bevorzugt (falls hinterlegt), SVG als Fallback. Ein fehlendes Icon in
  // der Liste ignoriert der Browser einfach und nimmt das nächste.
  icons: [
    { src: '/icon.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
  ],
});

const ADMIN_ENABLED = CONFIG.adminEnabled;

// Der Wipe: alles weg, ein neues Universum. Zwei Riegel: Der Aufrufer muss den
// Satz „ALLES LÖSCHEN <umgebung> <anzahl höfe>" wörtlich mitschicken — die
// Zahl zwingt ihn, hinzusehen, was er löscht —, und vorher wird die Datenbank
// gesichert (vacuum into), damit ein Fettfinger nicht das Ende ist.
function wipeSatz(): string {
  return `ALLES LÖSCHEN ${CONFIG.env} ${accounts.count}`;
}

function sicherungVorWipe(): string | null {
  try {
    const dir = join(dirname(CONFIG.dbPath), 'sicherungen');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const ziel = join(dir, `vor-wipe-${CONFIG.env}-${stamp}.db`);
    accounts.flush();
    market.flush();
    (accounts.storage as SqliteStorage).database.exec(`vacuum into '${ziel.replace(/'/g, "''")}'`);
    return ziel;
  } catch (err) {
    console.error(`[wipe] Sicherung fehlgeschlagen: ${(err as Error).message}`);
    return null;
  }
}

async function handleWipe(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') return json(res, 200, { satz: wipeSatz(), hoefe: accounts.count, env: CONFIG.env });
  const body = await leseJson<{ bestaetigung?: string }>(req, 4 * 1024);
  const satz = String(body?.bestaetigung ?? '').trim();
  if (satz !== wipeSatz()) {
    notiere('werkbank', null, 'Wipe abgelehnt — Bestätigung stimmt nicht');
    return json(res, 400, { error: 'CONFIRMATION_MISMATCH', erwartet: wipeSatz() });
  }
  const sicherung = sicherungVorWipe();
  if (!sicherung) return json(res, 500, { error: 'BACKUP_FAILED' });

  const vorher = accounts.count;
  events.closeAll();
  live.clear();
  accounts.alleLoeschen();
  market.reset();
  rejections.clear();
  protokoll.length = 0;
  notiere('werkbank', null, `WIPE: ${vorher} Höfe gelöscht, Sicherung ${sicherung}`);
  console.log(`[wipe] ${vorher} Höfe gelöscht — neues Universum. Sicherung: ${sicherung}`);
  return json(res, 200, { ok: true, geloescht: vorher, sicherung });
}

function handleAdmin(url: URL, req: IncomingMessage, res: ServerResponse) {
  if (url.pathname === '/api/admin/wipe') return handleWipe(req, res);

  // Die Briefkästen hängen an keinem Hof.
  if (url.pathname === '/api/admin/rueckmeldungen') {
    if (req.method === 'POST') {
      const id = Number(url.searchParams.get('id'));
      const erledigt = url.searchParams.get('erledigt') !== '0';
      return json(res, 200, { ok: accounts.storage.erledigeRueckmeldung(id, erledigt) });
    }
    const alle = url.searchParams.get('alle') === '1';
    return json(res, 200, { rueckmeldungen: accounts.storage.listRueckmeldungen(200, !alle) });
  }
  if (url.pathname === '/api/admin/fehler') {
    if (req.method === 'POST') {
      const id = url.searchParams.get('id') ?? '';
      return json(res, 200, { weg: accounts.storage.dropFehler(id === 'alle' ? 'alle' : Number(id)) });
    }
    return json(res, 200, { fehler: accounts.storage.listFehler(200) });
  }

  if (url.pathname === '/api/admin/accounts') {
    return json(res, 200, {
      count: accounts.count,
      serverTime: Date.now(),
      accounts: accounts.list().map((a) => {
        const karte = sozial.karte(a.id);
        const cached = live.get(a.id);
        const blob = cached ? null : accounts.load(a.id);
        const snap = cached ? cached.snapshot : blob?.snapshot ?? null;
        const rules = snap ? getRuleset(snap.rulesetVersion) : null;
        return {
          id: a.id,
          name: karte?.name ?? null,
          code: karte?.code ?? null,
          createdAt: a.createdAt,
          lastSeenMs: a.lastSeenMs,
          seq: snap?.seq ?? null,
          level: snap && rules ? levelOf(rules, snap.state.xp) : null,
          gold: snap && rules ? snap.state.items[rules.currency] ?? 0 : null,
          rulesetVersion: snap?.rulesetVersion ?? null,
          targetRulesetVersion: cached ? cached.targetRulesetVersion : blob?.targetRulesetVersion ?? null,
          // Online heisst: Das Geraet haelt gerade die Ereignisleitung offen.
          zuhoerer: events.countFor(a.id),
          lastSyncMs: cached?.activeDevice?.lastSyncMs ?? null,
          geraet: cached?.activeDevice?.id ?? null,
          offen: {
            post: cached ? cached.pendingDeliveries.length : (blob?.pendingDeliveries ?? []).length,
            xp: cached ? cached.pendingXp : blob?.pendingXp ?? 0,
            abzuege: cached ? cached.pendingAbzuege.length : (blob?.pendingAbzuege ?? []).length,
            eingriffe: cached ? cached.eingriffe.length : (blob?.eingriffe ?? []).length,
          },
          alarme: cached ? cached.divergenceAlerts.length : 0,
          wanderungsfehler: cached ? cached.migrationFailures.length : 0,
          wort: accounts.hatWort(a.id),
        };
      }),
    });
  }

  if (url.pathname === '/api/admin/protokoll') {
    const konto = url.searchParams.get('konto');
    const limit = Math.max(1, Math.min(300, Number(url.searchParams.get('limit') ?? '120') || 120));
    const zeilen = (konto ? protokoll.filter((z) => z.konto === konto) : protokoll).slice(-limit).reverse();
    return json(res, 200, { zeilen, serverTime: Date.now() });
  }

  if (url.pathname === '/api/admin/stats') {
    let goldTotal = 0;
    let itemsTotal = 0;
    let xpTotal = 0;
    let farms = 0;
    for (const a of accounts.list()) {
      const cached = live.get(a.id);
      const snap = cached ? cached.snapshot : accounts.load(a.id)?.snapshot;
      if (!snap) continue;
      const rules = getRuleset(snap.rulesetVersion);
      const st = snap.state;
      goldTotal += st.items[rules.currency] ?? 0;
      for (let i = 0; i < st.items.length; i++) {
        if (rules.items[i]?.storable) itemsTotal += st.items[i] ?? 0;
      }
      xpTotal += st.xp ?? 0;
      farms++;
    }
    return json(res, 200, {
      farms,
      goldTotal,
      itemsTotal,
      xpTotal,
      itemsDiscarded: econstats.itemsDiscarded,
      serverTime: Date.now(),
    });
  }

  if (url.pathname === '/api/admin/push') {
    const titel = (url.searchParams.get('titel') ?? '').trim();
    const text = (url.searchParams.get('text') ?? '').trim();
    const anWen = url.searchParams.get('an') ?? 'alle';
    if (!titel || titel.length > 80 || text.length > 240) {
      return json(res, 400, { error: 'BAD_MESSAGE' });
    }
    const ziele =
      anWen === 'alle'
        ? [...new Set(accounts.storage.listPushAbos().map((a) => a.konto))]
        : anWen.split(',').map((x) => x.trim()).filter(Boolean);
    return pushAn(ziele, titel, text, 'admin').then((r) => {
      console.log(`[admin] Push an ${ziele.length} Höfe: ${r.gesendet} zugestellt, ${r.entfernt} tote Abos`);
      return json(res, 200, { ok: true, hoefe: ziele.length, ...r });
    });
  }

  if (url.pathname === '/api/admin/push/stand') {
    const abos = accounts.storage.listPushAbos();
    const proKonto = new Map<string, number>();
    for (const a of abos) proKonto.set(a.konto, (proKonto.get(a.konto) ?? 0) + 1);
    return json(res, 200, {
      abos: abos.length,
      web: abos.filter((a) => a.art !== 'ios').length,
      ios: abos.filter((a) => a.art === 'ios').length,
      apnsBereit: !!APNS,
      hoefe: proKonto.size,
      liste: [...proKonto].map(([konto, geraete]) => ({ konto, geraete })),
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

  if (url.pathname === '/api/admin/sicht') {
    const rules = getRuleset(game.snapshot.rulesetVersion);
    const st = game.snapshot.state;
    const karte = sozial.karte(target.id);
    return json(res, 200, {
      accountId: target.id,
      serverTime: Date.now(),
      sicht: farmView(st, rules, true),
      katalog: katalogVon(rules),
      technik: {
        name: karte?.name ?? null,
        code: karte?.code ?? null,
        createdAt: target.createdAt,
        lastSeenMs: target.lastSeenMs,
        seq: game.snapshot.seq,
        tick: st.tick,
        serverTs: game.snapshot.serverTs,
        rulesetVersion: game.snapshot.rulesetVersion,
        targetRulesetVersion: game.targetRulesetVersion,
        activeDevice: game.activeDevice,
        zuhoerer: events.countFor(target.id),
        pendingDeliveries: game.pendingDeliveries.map((m) => ({ item: m.item, amount: m.amount })),
        pendingXp: game.pendingXp,
        pendingAbzuege: game.pendingAbzuege,
        eingriffe: game.eingriffe,
        divergenceAlerts: game.divergenceAlerts,
        migrationFailures: game.migrationFailures,
        appliedLog: game.appliedLog.length,
        logStartSeq: game.logStartSeq,
        xp: st.xp,
        gold: st.items[rules.currency] ?? 0,
        level: levelOf(rules, st.xp),
        serverTag: st.serverTag,
        freunde: sozial.freunde(target.id).map((f) => ({ id: f.id, name: f.name, code: f.code })),
      },
    });
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });

  if (url.pathname === '/api/admin/eingriff') {
    const rules = getRuleset(game.snapshot.rulesetVersion);
    const p = url.searchParams;
    const art = p.get('art') ?? '';
    const zahl = (k: string, sonst: number) => {
      const n = Number(p.get(k) ?? String(sonst));
      return Number.isInteger(n) ? n : NaN;
    };
    let e: Eingriff | null = null;
    let text = '';
    if (art === 'wagen-zurueck') { e = { art }; text = 'Wagen zurückgerufen'; }
    else if (art === 'zettel-neu') { e = { art }; text = 'Zettel neu ausgelegt'; }
    else if (art === 'kiste-auf-hof') { e = { art }; text = 'Kiste auf den Hof gelegt'; }
    else if (art === 'alles-fertig') { e = { art }; text = 'Alles fertig gestellt'; }
    else if (art === 'boot-reparieren') { e = { art }; text = 'Boot repariert'; }
    else if (art === 'kiste-schicken') {
      const name = p.get('kind') ?? '';
      const n = Number(name);
      const kind = Number.isInteger(n) ? n : (rules.chestKinds ?? []).findIndex((k) => k.id === name);
      const def = (rules.chestKinds ?? [])[kind];
      if (def) { e = { art, kind }; text = `${def.label} geschickt`; }
    } else if (art === 'lager-ausbauen') {
      const stufen = zahl('stufen', 1);
      if (stufen >= 1 && stufen <= 10) { e = { art, stufen }; text = `Lager +${stufen}`; }
    } else if (art === 'tier-schenken' || art === 'bau-schenken') {
      const plot = resolvePlot(rules, p.get('plot'));
      if (plot !== null) {
        const def = rules.plots[plot]!;
        const stand = game.snapshot.state.plots[plot]!;
        if (art === 'tier-schenken' && def.animal && stand.level > 0) { e = { art, plot }; text = `Tier geschenkt: ${def.id}`; }
        if (art === 'bau-schenken' && stand.level <= 0 && !def.fixed) { e = { art, plot }; text = `Bau geschenkt: ${def.id}`; }
      }
    } else if (art === 'land-freimachen') {
      const id = p.get('id') ?? '';
      if ((rules.expansions ?? []).some((x) => x.id === id)) { e = { art, id }; text = `Land freigemacht: ${id}`; }
    } else if (art === 'hindernis-raeumen') {
      const index = zahl('index', -1);
      if (rules.obstacles?.[index]) { e = { art, index }; text = `Hindernis geräumt: ${index}`; }
    } else if (art === 'booster') {
      const minuten = zahl('minuten', 30);
      if (rules.booster && minuten >= 1 && minuten <= 1440) { e = { art, ticks: minuten * 60 }; text = `XP-Verdoppler ${minuten} min`; }
    } else if (art === 'stufe') {
      const level = zahl('level', 0);
      if (level >= 2 && level <= 200) { e = { art, level }; text = `Stufe ${level}`; }
    }
    if (!e) return json(res, 400, { error: 'BAD_EINGRIFF' });
    game.eingreifen(e);
    persist(target, game);
    events.nudge(target.id, 'farm');
    notiere('werkbank', target.id, text);
    console.log(`[admin] ${target.id}: Eingriff ${text}`);
    return json(res, 200, { ok: true, offen: game.eingriffe.length });
  }

  if (url.pathname === '/api/admin/abzug') {
    const name = url.searchParams.get('item') ?? '';
    const amount = Number(url.searchParams.get('amount') ?? '0');
    const item = resolveItem(game, name);
    if (item === null || !Number.isInteger(amount) || amount <= 0) return json(res, 400, { error: 'BAD_ABZUG' });
    game.nimmAb(item, amount);
    persist(target, game);
    events.nudge(target.id, 'farm');
    notiere('werkbank', target.id, `${amount}× ${name} abgezogen (wenn vorhanden)`);
    console.log(`[admin] ${target.id}: −${amount} ${name}`);
    return json(res, 200, { ok: true, offen: game.pendingAbzuege.length });
  }

  if (url.pathname === '/api/admin/geraet-frei') {
    const vorher = game.activeDevice?.id ?? null;
    game.activeDevice = null;
    persist(target, game);
    notiere('werkbank', target.id, `Gerät freigegeben (${vorher ?? 'keins'})`);
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/admin/alarme-loeschen') {
    const n = game.divergenceAlerts.length + game.migrationFailures.length;
    game.divergenceAlerts = [];
    game.migrationFailures = [];
    notiere('werkbank', target.id, `${n} Alarme gelöscht`);
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/admin/name') {
    const name = saubererName(url.searchParams.get('name') ?? '');
    if (name === null || !sozial.benenne(target.id, name)) return json(res, 400, { error: 'BAD_NAME' });
    events.nudge(target.id, 'sozial');
    notiere('werkbank', target.id, `Umbenannt in „${name}"`);
    return json(res, 200, { ok: true, name });
  }

  if (url.pathname === '/api/admin/freundschaft') {
    const mit = (url.searchParams.get('mit') ?? '').trim();
    const andere = sozial.perCode(mit.toUpperCase())?.id ?? (accounts.get(mit) ? mit : null);
    if (!andere || andere === target.id) return json(res, 400, { error: 'NO_SUCH_ACCOUNT' });
    const now = Date.now();
    sozial.frage(target.id, andere, now);
    const stand = sozial.frage(andere, target.id, now);
    if (stand !== 'freund') return json(res, 400, { error: 'NOT_FRIENDS' });
    events.nudge(target.id, 'sozial');
    events.nudge(andere, 'sozial');
    notiere('werkbank', target.id, `Freundschaft gestiftet mit ${andere}`);
    return json(res, 200, { ok: true, mit: andere });
  }

  if (url.pathname === '/api/admin/time') {
    const seconds = Number(url.searchParams.get('seconds') ?? '0');
    if (!Number.isInteger(seconds) || seconds <= 0 || seconds > 90 * 86_400) {
      return json(res, 400, { error: 'BAD_SECONDS' });
    }
    game.grantTime(seconds);
    persist(target, game);
    events.nudge(target.id, 'farm');
    notiere('werkbank', target.id, `${seconds} s Zeit gutgeschrieben`);
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
    events.nudge(target.id, 'farm');
    notiere('werkbank', target.id, `${amount}× ${name} ins Postfach`);
    console.log(`[admin] ${target.id}: ${amount} ${name} ins Postfach`);
    return json(res, 200, { ok: true, queued: game.pendingDeliveries.length });
  }

  if (url.pathname === '/api/admin/xp') {
    const amount = Number(url.searchParams.get('amount') ?? '0');
    if (!Number.isInteger(amount) || amount <= 0) return json(res, 400, { error: 'BAD_XP' });
    game.grantXp(amount);
    persist(target, game);
    events.nudge(target.id, 'farm');
    notiere('werkbank', target.id, `+${amount} XP`);
    console.log(`[admin] ${target.id}: +${amount} XP`);
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/admin/ruleset') {
    const version = Number(url.searchParams.get('version') ?? '0');
    if (!RULESETS.has(version)) return json(res, 400, { error: 'UNKNOWN_RULESET' });
    if (version < game.snapshot.rulesetVersion) {
      return json(res, 400, { error: 'DOWNGRADE_NOT_SUPPORTED' });
    }
    game.targetRulesetVersion = version;
    persist(target, game);
    notiere('werkbank', target.id, `Zielversion v${version}`);
    console.log(`[admin] ${target.id}: Zielversion v${version} — greift beim nächsten Sync`);
    return json(res, 200, { ok: true, targetRulesetVersion: version });
  }

  if (url.pathname === '/api/admin/reset') {
    game.reset(initialState(getRuleset(TARGET_RULESET)), Date.now(), TARGET_RULESET);

    market.forget(target.id);
    game.stockRequests();
    game.stockOffers();
    persist(target, game);
    notiere('werkbank', target.id, 'Spielstand zurückgesetzt');
    console.log(`[admin] ${target.id}: Spielstand zurückgesetzt`);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'NOT_FOUND' });
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // Für die gebündelte App: erlaubte Herkunft freigeben, Vorabfragen direkt
  // beantworten. Unbekannte Herkünfte bekommen gar keinen CORS-Kopf.
  setzeCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(herkunftErlaubt(req) ? 204 : 405);
    return res.end();
  }

  if (CONFIG.tls) {
    res.setHeader('strict-transport-security', 'max-age=31536000');
  }

  if (url.pathname === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }

  if (url.pathname === '/health') {
    // Der Riegel vor dem Deploy schreibt seinen Zustand nach data/deploy-stand.json —
    // so sieht man von außen, ob ein Stand hängt, ohne auf den Server zu müssen.
    let deploy: unknown = null;
    try {
      const pfad = join(ROOT, 'data', 'deploy-stand.json');
      if (existsSync(pfad)) deploy = JSON.parse(readFileSync(pfad, 'utf8'));
    } catch {
      deploy = null;
    }
    return json(res, 200, {
      ok: true,
      env: CONFIG.env,
      version: CONFIG.version,
      deploy,
      speicher: { rssMb: Math.round(process.memoryUsage().rss / 1048576), freiMb: Math.round(freemem() / 1048576), gesamtMb: Math.round(totalmem() / 1048576) },
      rulesetVersion: TARGET_RULESET,
      shell: SHELL_VERSION,
      accounts: accounts.count,
      offers: market.size,
      pendingWrites: accounts.pendingWrites,
      live: live.size,
      streams: events.size,
      rejections: Object.fromEntries(rejections),
      rulesets: Object.fromEntries(
        [...live.values()].reduce((zaehler, game) => {
          const v = String(game.snapshot.rulesetVersion);
          zaehler.set(v, (zaehler.get(v) ?? 0) + 1);
          return zaehler;
        }, new Map<string, number>()),
      ),
      migrationFailures: [...live.values()].reduce((n, game) => n + game.migrationFailures.length, 0),
      secure: isSecureTransport(CONFIG),
    });
  }

  if (url.pathname === '/sw.js' && req.method === 'GET') {
    if (!swSource) return json(res, 500, { error: 'sw.template.js fehlt' });
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',

      'cache-control': 'no-cache',
    });
    return res.end(swSource);
  }

  // Playlist-Verzeichnis: Titelliste als JSON.
  if (url.pathname === '/musik/' && req.method === 'GET') {
    return json(res, 200, { tracks: musikListe() });
  }

  // Einzelner Track. Nur Dateien, die wirklich in der Liste stehen — kein
  // Pfad-Ausbruch (../) möglich, weil gegen den Verzeichnisinhalt geprüft wird.
  if (url.pathname.startsWith('/musik/') && (req.method === 'GET' || req.method === 'HEAD')) {
    const dir = musikDir();
    let name = '';
    try {
      name = decodeURIComponent(url.pathname.slice('/musik/'.length));
    } catch {
      return json(res, 400, { error: 'ungültiger Name' });
    }
    if (!dir || !musikListe().includes(name)) {
      return json(res, 404, { error: 'kein solcher Track' });
    }
    return streamAudio(req, res, join(dir, name));
  }

  // Rückwärtskompatibel: eine einzelne web/OST.mp3, falls jemand sie ablegt.
  if (url.pathname === '/OST.mp3' && (req.method === 'GET' || req.method === 'HEAD')) {
    const pfad = [
      process.env.NEUES_SPIEL_OST?.trim(),
      join(dirname(SAVE_PATH), 'OST.mp3'),
      join(ROOT, 'web', 'OST.mp3'),
    ].find((p) => p && existsSync(p));
    if (!pfad) return json(res, 404, { error: 'keine Musik hinterlegt' });
    return streamAudio(req, res, pfad);
  }

  if (url.pathname === '/icon.png' && req.method === 'GET') {
    if (!ICON_PNG) return json(res, 404, { error: 'kein PNG-Icon' });
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
    return res.end(ICON_PNG);
  }

  if (url.pathname === '/icon.svg' && req.method === 'GET') {
    if (!ICON_SVG) return json(res, 404, { error: 'kein SVG-Icon' });
    res.writeHead(200, {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'public, max-age=86400',
    });
    return res.end(ICON_SVG);
  }

  if (url.pathname === '/api/push/schluessel' && req.method === 'GET') {
    return json(res, 200, { key: VAPID.publicKey });
  }

  if (url.pathname === '/manifest.webmanifest' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'application/manifest+json; charset=utf-8',
      'cache-control': 'no-cache',
    });
    return res.end(MANIFEST);
  }

  if ((url.pathname === '/impressum' || url.pathname === '/datenschutz') && req.method === 'GET') {
    if (!rechtPage) return json(res, 500, { error: 'Seite fehlt — `npm run build`.' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(rechtPage);
  }

  if (url.pathname === '/admin' && req.method === 'GET') {
    if (!ADMIN_ENABLED) return json(res, 403, { error: 'ADMIN_DISABLED' });
    if (!adminPage) return json(res, 500, { error: 'Seite fehlt — `npm run build`.' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(adminPage);
  }

  if (url.pathname === '/' && req.method === 'GET') {
    if (!farmPage) return json(res, 500, { error: 'Seite fehlt — bitte `npm run build` ausführen.' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(farmPage);
  }

  if (url.pathname.startsWith('/api/')) {
    if (url.pathname === '/api/account' && req.method === 'POST') {
      const allowed = limiter.allow(originOf(req), Date.now(), accounts.count);
      if (!allowed.ok) return json(res, 429, { error: allowed.reason });

      const game = freshGame();
      const { account, key } = accounts.create(Date.now(), snapshotOf(game));
      wireMarket(account.id, game);
      game.stockOffers();
      live.set(account.id, game);
      console.log(`[account] neuer Hof ${account.id} (${accounts.count} gesamt)`);

      return json(res, 201, {
        key,
        accountId: account.id,
        snapshot: game.snapshot,
        serverTime: Date.now(),
        isActiveDevice: true,
        activeSince: null,
      });
    }

    if (url.pathname.startsWith('/api/admin/')) {
      if (!ADMIN_ENABLED) return json(res, 403, { error: 'ADMIN_DISABLED' });
      if (!isAdmin(req)) return json(res, 401, { error: 'UNAUTHORIZED' });
      return handleAdmin(url, req, res);
    }

    // Der Weg zurück in den Hof: Hofcode + Wiederherstellungswort ergeben einen
    // frischen Schlüssel. Ohne Anmeldung — der Schlüssel ist ja gerade weg.
    if (url.pathname === '/api/wiederherstellen' && req.method === 'POST') {
      const herkunft = WIEDER_BREMSE_HERKUNFT.zaehle(originOf(req), Date.now());
      if (!herkunft.ok) return json(res, 429, { error: 'TOO_MANY_ATTEMPTS', warteMs: herkunft.warteMs });
      const body = await leseJson<{ code?: string; wort?: string }>(req, 4 * 1024);
      if (!body) return json(res, 400, { error: 'BAD_REQUEST' });
      const code = String(body.code ?? '').trim().toUpperCase();
      const wort = saubereWort(String(body.wort ?? ''));
      if (!code || !wort) return json(res, 400, { error: 'BAD_REQUEST' });
      const proHof = WIEDER_BREMSE_HOF.zaehle(code, Date.now());
      if (!proHof.ok) return json(res, 429, { error: 'TOO_MANY_ATTEMPTS', warteMs: proHof.warteMs });
      const karte = sozial.perCode(code);
      const neu = karte ? accounts.stelleWieder(karte.id, wort) : null;
      if (!karte || !neu) {
        notiere('konto', karte?.id ?? '-', `Wiederherstellung abgelehnt für ${code}`);
        return json(res, 401, { error: 'WRONG_WORD' });
      }
      WIEDER_BREMSE_HOF.vergiss(code);
      const game = gameFor(neu.account);
      // Das alte Gerät ist ab jetzt draußen — das neue darf sofort spielen.
      game.activeDevice = null;
      settle(neu.account, game);
      game.receiveExternal();
      persist(neu.account, game);
      events.closeFor(neu.account.id);
      notiere('konto', neu.account.id, 'Hof wiederhergestellt — neuer Schlüssel ausgegeben');
      console.log(`[konto] ${neu.account.id}: wiederhergestellt über ${code}`);
      return json(res, 200, {
        key: neu.key,
        accountId: neu.account.id,
        snapshot: game.snapshot,
        serverTime: Date.now(),
        isActiveDevice: true,
        activeSince: null,
      });
    }

    // Fehlerberichte vom Gerät. Ohne Zwang zur Anmeldung, denn gerade beim
    // Anmelden geht am meisten schief; mit Schlüssel hängt der Hof mit dran.
    if (url.pathname === '/api/fehler' && req.method === 'POST') {
      const bremse = FEHLER_BREMSE.zaehle(originOf(req), Date.now());
      if (!bremse.ok) return json(res, 429, { error: 'TOO_MANY_REPORTS', warteMs: bremse.warteMs });
      const body = await leseJson<{
        meldungen?: Array<{ text?: string; stapel?: string; ort?: string }>;
        version?: string;
        huelle?: string;
        regelwerk?: number;
        geraet?: string;
      }>(req, 64 * 1024);
      if (!body || !Array.isArray(body.meldungen)) return json(res, 400, { error: 'BAD_REQUEST' });
      const konto = accounts.resolve(bearer(req))?.id ?? '';
      let angenommen = 0;
      for (const m of body.meldungen.slice(0, 10)) {
        const text = kuerze(m?.text, 500);
        if (!text) continue;
        const ort = kuerze(m?.ort, 300);
        accounts.storage.putFehler({
          schluessel: createHash('sha256').update(`${text}\n${ort}`).digest('hex').slice(0, 24),
          konto,
          text,
          stapel: kuerze(m?.stapel, 4000),
          ort,
          version: kuerze(body.version, 80),
          huelle: kuerze(body.huelle, 80),
          regelwerk: Number.isInteger(body.regelwerk) ? Number(body.regelwerk) : 0,
          geraet: kuerze(body.geraet, 200),
          zuletztMs: Date.now(),
        });
        angenommen++;
      }
      if (angenommen > 0) console.log(`[fehler] ${angenommen} Bericht(e) von ${konto || originOf(req)}`);
      return json(res, 200, { ok: true, angenommen });
    }

    const account = accounts.resolve(bearer(req));
    if (!account) return json(res, 401, { error: 'UNAUTHORIZED' });
    const game = gameFor(account);

    // Wiederherstellungswort ansehen (nur ob eins da ist) oder setzen.
    if (url.pathname === '/api/wiederherstellung') {
      if (req.method === 'POST') {
        const body = await leseJson<{ wort?: string }>(req, 4 * 1024);
        const wort = body ? saubereWort(String(body.wort ?? '')) : null;
        if (!wort) return json(res, 400, { error: 'BAD_WORD', min: WORT_MIN, max: WORT_MAX });
        accounts.setzeWort(account.id, wort);
        notiere('konto', account.id, 'Wiederherstellungswort gesetzt');
        return json(res, 200, { ok: true, gesetzt: true });
      }
      return json(res, 200, { gesetzt: accounts.hatWort(account.id), min: WORT_MIN, max: WORT_MAX });
    }

    // Der Hof geht endgültig. Zur Sicherheit muss der eigene Hofcode mit.
    if (url.pathname === '/api/konto' && req.method === 'DELETE') {
      const body = await leseJson<{ code?: string }>(req, 4 * 1024);
      const karte = sozial.karte(account.id);
      const code = String(body?.code ?? '').trim().toUpperCase();
      if (!karte || !code || code !== karte.code) return json(res, 400, { error: 'CODE_MISMATCH' });
      events.closeFor(account.id);
      live.delete(account.id);
      market.forget(account.id);
      sozial.vergissHof(account.id);
      accounts.loesche(account.id);
      events.broadcast('market', account.id);
      notiere('konto', account.id, `Hof ${karte.code} auf Wunsch gelöscht`);
      console.log(`[konto] ${account.id}: gelöscht (${accounts.count} übrig)`);
      return json(res, 200, { ok: true });
    }

    // Eine Rückmeldung an den Betreiber — mit dem, was man zum Nachstellen braucht.
    if (url.pathname === '/api/rueckmeldung' && req.method === 'POST') {
      const bremse = RUECK_BREMSE.zaehle(account.id, Date.now());
      if (!bremse.ok) return json(res, 429, { error: 'TOO_MANY_REPORTS', warteMs: bremse.warteMs });
      const body = await leseJson<{
        art?: string;
        text?: string;
        version?: string;
        huelle?: string;
        regelwerk?: number;
        geraet?: string;
      }>(req, 16 * 1024);
      const art = String(body?.art ?? '');
      const text = kuerze(body?.text, 2000);
      if (!body || !['fehler', 'idee', 'lob', 'sonstiges'].includes(art) || text.length < 3) {
        return json(res, 400, { error: 'BAD_REQUEST' });
      }
      const id = accounts.storage.putRueckmeldung({
        konto: account.id,
        code: sozial.karte(account.id)?.code ?? '',
        art: art as 'fehler' | 'idee' | 'lob' | 'sonstiges',
        text,
        version: kuerze(body.version, 80),
        huelle: kuerze(body.huelle, 80),
        regelwerk: Number.isInteger(body.regelwerk) ? Number(body.regelwerk) : game.snapshot.rulesetVersion,
        geraet: kuerze(body.geraet, 200),
        zeitMs: Date.now(),
      });
      notiere('post', account.id, `Rückmeldung (${art}): ${text.slice(0, 80)}`);
      console.log(`[post] Rückmeldung #${id} von ${account.id} (${art})`);
      return json(res, 200, { ok: true, id });
    }

    if (url.pathname === '/api/state' && req.method === 'GET') {
      const deviceId = url.searchParams.get('deviceId') ?? undefined;

      settle(account, game);
      game.receiveExternal();
      persist(account, game);
      return json(res, 200, {
        accountId: account.id,
        snapshot: game.snapshot,
        serverTime: Date.now(),
        isActiveDevice: game.isActiveDevice(deviceId),
        activeSince: game.activeDevice?.lastSyncMs ?? null,
      });
    }

    if (url.pathname === '/api/push/abo' && req.method === 'POST') {
      let abo: {
        art?: string;
        token?: string;
        endpoint?: string;
        keys?: { p256dh?: string; auth?: string };
      };
      try {
        abo = JSON.parse(await readBody(req, 8 * 1024));
      } catch {
        return json(res, 400, { error: 'BAD_JSON' });
      }

      // Native App: nur das Geräte-Token, verschlüsselt wird bei Apple.
      if (abo.art === 'ios') {
        const token = String(abo.token ?? '').trim();
        if (!/^[0-9a-fA-F]{16,200}$/.test(token)) {
          return json(res, 400, { error: 'BAD_DEVICE_TOKEN' });
        }
        accounts.storage.putPushAbo({
          endpoint: token.toLowerCase(),
          konto: account.id,
          art: 'ios',
          p256dh: '',
          auth: '',
          seitMs: Date.now(),
          zuletztMs: 0,
        });
        return json(res, 200, { ok: true, art: 'ios', bereit: !!APNS });
      }

      const endpoint = String(abo.endpoint ?? '');
      const p256dh = String(abo.keys?.p256dh ?? '');
      const auth = String(abo.keys?.auth ?? '');
      if (!p256dh || !auth || !pushZielErlaubt(endpoint)) {
        return json(res, 400, { error: 'BAD_SUBSCRIPTION' });
      }
      accounts.storage.putPushAbo({
        endpoint,
        konto: account.id,
        art: 'web',
        p256dh,
        auth,
        seitMs: Date.now(),
        zuletztMs: 0,
      });
      return json(res, 200, { ok: true, art: 'web' });
    }

    if (url.pathname === '/api/push/abo' && req.method === 'DELETE') {
      const endpoint = url.searchParams.get('endpoint') ?? '';
      // Nur eigene Abos dürfen weg.
      const meins = accounts.storage.listPushAbos(account.id).some((a) => a.endpoint === endpoint);
      if (meins) accounts.storage.dropPushAbo(endpoint);
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/bestenliste' && req.method === 'GET') {
      const alle = accounts.list().map((a) => {
        const cached = live.get(a.id);
        const snap = cached ? cached.snapshot : accounts.load(a.id)?.snapshot;
        const xp = snap?.state.xp ?? 0;
        const rules = getRuleset(snap?.rulesetVersion ?? TARGET_RULESET);
        return { id: a.id, name: sozial.karte(a.id)?.name ?? 'Hof', level: levelOf(rules, xp), xp };
      });
      alle.sort((x, y) => y.xp - x.xp || x.id.localeCompare(y.id));
      const rang = alle.findIndex((e) => e.id === account.id) + 1;
      const ich = rang > 0 ? alle[rang - 1]! : null;
      return json(res, 200, {
        gesamt: alle.length,
        rang,
        ich: ich ? { platz: rang, name: ich.name, level: ich.level, xp: ich.xp } : null,
        top: alle.slice(0, 25).map((e, i) => ({
          platz: i + 1,
          name: e.name,
          level: e.level,
          xp: e.xp,
          ich: e.id === account.id,
        })),
      });
    }

    if (url.pathname === '/api/hof') {
      if (req.method === 'POST') {
        const wunsch = url.searchParams.get('name') ?? '';
        if (!sozial.benenne(account.id, wunsch)) return json(res, 400, { error: 'BAD_NAME' });
      }
      return json(res, 200, { ...sozial.karte(account.id), maxName: NAME_MAX });
    }

    if (url.pathname === '/api/freunde' && req.method === 'GET') {
      return json(res, 200, {
        freunde: sozial.freunde(account.id).map((f) => ({
          ...hofZeile(f, account.id),
          beschenkt: geschenktHeute(account.id, f.id, Date.now()),
        })),
        anfragen: sozial.anfragenAn(account.id).map((f) => hofZeile(f, account.id)),
        gefragt: sozial.anfragenVon(account.id).map((f) => hofZeile(f, account.id)),
      });
    }

    if (url.pathname === '/api/freunde' && req.method === 'POST') {
      const code = (url.searchParams.get('code') ?? '').trim().toUpperCase();
      const ziel = sozial.perCode(code);
      if (!ziel) return json(res, 404, { error: 'NO_SUCH_FARM' });
      if (ziel.id === account.id) return json(res, 400, { error: 'THATS_YOU' });

      const stand = sozial.frage(account.id, ziel.id, Date.now());
      if (stand === 'nein') return json(res, 400, { error: 'THATS_YOU' });
      events.nudge(ziel.id, 'sozial');
      return json(res, 200, { stand, hof: hofZeile(ziel, account.id) });
    }

    if (url.pathname === '/api/freunde' && req.method === 'DELETE') {
      const code = (url.searchParams.get('code') ?? '').trim().toUpperCase();
      const ziel = sozial.perCode(code);
      if (ziel) {
        sozial.vergiss(account.id, ziel.id);
        events.nudge(ziel.id, 'sozial');
      }
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/besuch' && req.method === 'GET') {
      const code = (url.searchParams.get('code') ?? '').trim().toUpperCase();
      const ziel = sozial.perCode(code);
      if (!ziel || ziel.id === account.id) return json(res, 404, { error: 'NO_SUCH_FARM' });
      return json(res, 200, besuchsBild(ziel, account.id, game.snapshot.rulesetVersion));
    }

    // Ein Geschenk an einen Nachbarn: Ware verlaesst diesen Hof und landet in
    // seiner Post. Kontouebergreifend, also Sache des Servers — der Abzug geht
    // den Weg der Hilfe-XP (aeussere Aenderung), die Lieferung den Weg jeder
    // Post. Einmal am Tag je Nachbar, hoechstens fuenf Stueck, nur Lagerware.
    if (url.pathname === '/api/geschenk' && req.method === 'POST') {
      const code = (url.searchParams.get('code') ?? '').trim().toUpperCase();
      const amount = Number(url.searchParams.get('amount') ?? '1');
      const ziel = sozial.perCode(code);
      if (!ziel || ziel.id === account.id) return json(res, 404, { error: 'NO_SUCH_FARM' });
      if (!sozial.istFreund(account.id, ziel.id)) return json(res, 403, { error: 'NOT_A_FRIEND' });
      const item = resolveItem(game, url.searchParams.get('item') ?? '');
      const rules = getRuleset(game.snapshot.rulesetVersion);
      if (item === null || item === rules.currency || !rules.items[item]?.storable) {
        return json(res, 400, { error: 'NOT_GIFTABLE' });
      }
      if (!Number.isInteger(amount) || amount <= 0 || amount > GESCHENK_MAX) {
        return json(res, 400, { error: 'BAD_AMOUNT' });
      }
      const jetzt = Date.now();
      if (geschenktHeute(account.id, ziel.id, jetzt)) return json(res, 429, { error: 'ALREADY_GIFTED' });

      game.receiveExternal();
      if (count(game.snapshot.state, item) < amount) return json(res, 409, { error: 'NOT_ENOUGH_ITEMS' });
      const vorher = count(game.snapshot.state, item);
      game.nimmAb(item, amount);
      game.receiveExternal();
      if (count(game.snapshot.state, item) !== vorher - amount) {
        return json(res, 409, { error: 'NOT_ENOUGH_ITEMS' });
      }
      persist(account, game);

      const zielSpiel = gameFor(zielKonto(ziel.id));
      zielSpiel.deliver({ item, amount, arrivedAt: jetzt });
      zielSpiel.receiveExternal();
      persist(zielKonto(ziel.id), zielSpiel);
      merkeGeschenk(account.id, ziel.id, jetzt);
      const von = sozial.karte(account.id);
      geschenkAblegen(ziel.id, { von: von?.name ?? 'Ein Nachbar', code: von?.code ?? '', item, amount, wann: jetzt });
      events.nudge(ziel.id, 'geschenk');
      events.nudge(ziel.id, 'farm');
      console.log(`[geschenk] ${account.id} -> ${ziel.id}: ${amount}x ${rules.items[item]?.id}`);
      return json(res, 200, { ok: true, item, amount, an: hofZeile(ziel, account.id) });
    }

    // Was einem geschenkt wurde und noch nicht gezeigt — einmal abgeholt, weg.
    if (url.pathname === '/api/geschenke' && req.method === 'GET') {
      const liste = geschenkeAbholen(account.id);
      return json(res, 200, { geschenke: liste });
    }

    if (url.pathname === '/api/helfen' && req.method === 'POST') {
      const code = (url.searchParams.get('code') ?? '').trim().toUpperCase();
      const plot = Number(url.searchParams.get('plot'));
      const slot = Number(url.searchParams.get('slot') ?? '0');
      const ziel = sozial.perCode(code);
      if (!ziel || ziel.id === account.id) return json(res, 404, { error: 'NO_SUCH_FARM' });
      if (!Number.isInteger(plot) || !Number.isInteger(slot)) {
        return json(res, 400, { error: 'BAD_SPOT' });
      }

      const rules = getRuleset(game.snapshot.rulesetVersion);
      const proTag = rules.helpPerFarmPerDay ?? 0;
      if (proTag <= 0) return json(res, 400, { error: 'HELP_DISABLED' });

      const jetzt = Date.now();
      if (sozial.hilfenHeute(account.id, ziel.id, jetzt) >= proTag) {
        return json(res, 429, { error: 'HELPED_ENOUGH' });
      }

      const zielSpiel = gameFor(zielKonto(ziel.id));
      zielSpiel.receiveExternal();
      const getan = zielSpiel.helfen(plot, slot);
      if (!getan.ok) return json(res, 409, { error: 'NOTHING_TO_HELP' });

      sozial.zaehleHilfe(account.id, ziel.id, jetzt);
      persist(zielKonto(ziel.id), zielSpiel);
      events.nudge(ziel.id, 'farm');

      const lohn = rules.helpXp ?? 0;
      game.grantXp(lohn);
      game.receiveExternal();
      persist(account, game);

      return json(res, 200, {
        ok: true,
        ticks: getan.ticks,
        xp: lohn,
        heute: sozial.hilfenHeute(account.id, ziel.id, jetzt),
        proTag,
        besuch: besuchsBild(ziel, account.id, game.snapshot.rulesetVersion),
      });
    }

    if (url.pathname === '/api/tagesbonus' && req.method === 'GET') {
      return json(res, 200, tagesbonus.status(account.id, Date.now()));
    }

    if (url.pathname === '/api/tagesbonus' && req.method === 'POST') {
      const geholt = tagesbonus.hole(account.id, Date.now());
      if (!geholt) return json(res, 409, { error: 'ALREADY_CLAIMED' });

      const currency = getRuleset(game.snapshot.rulesetVersion).currency;
      if (geholt.lohn.gold > 0) {
        game.deliver({ item: currency, amount: geholt.lohn.gold, arrivedAt: Date.now() });
      }
      if (geholt.lohn.xp > 0) game.grantXp(geholt.lohn.xp);
      game.receiveExternal();
      persist(account, game);
      events.nudge(account.id, 'farm');

      return json(res, 200, {
        ok: true,
        streak: geholt.streak,
        gold: geholt.lohn.gold,
        xp: geholt.lohn.xp,
        status: tagesbonus.status(account.id, Date.now()),
      });
    }

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
      const bremse = SYNC_BREMSE.zaehle(account.id, Date.now());
      if (!bremse.ok) {
        rejections.set('TOO_FAST', (rejections.get('TOO_FAST') ?? 0) + 1);
        res.setHeader('retry-after', String(Math.ceil(bremse.warteMs / 1000)));
        return json(res, 429, { error: 'TOO_FAST', warteMs: bremse.warteMs });
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

      settle(account, game);
      if (parsed.neueZeitung) market.neueAusgabe(account.id);

      const gast = typeof parsed.besuch === 'string' ? sozial.perCode(parsed.besuch) : null;
      game.besuch = gast && gast.id !== account.id ? gast.id : null;

      const geraetVorher = game.activeDevice?.id ?? null;
      const alarmeVorher = game.divergenceAlerts.length;
      const wanderungVorher = game.migrationFailures.length;
      const result = game.sync(parsed, Date.now());
      if (result.ok) econstats.addDiscarded(game.lastSyncDiscarded);
      if (!result.ok) {
        notiere('abgelehnt', account.id, `${result.reason} · ${parsed.commands.length} Befehle vom Gerät ${parsed.deviceId ?? '?'}`);
      }
      if (game.divergenceAlerts.length > alarmeVorher) {
        const a = game.divergenceAlerts[game.divergenceAlerts.length - 1]!;
        notiere('divergenz', account.id, `Gerät und Server rechnen verschieden ab seq ${a.seq} (${a.clientHash} ≠ ${a.serverHash})`);
      }
      if (game.migrationFailures.length > wanderungVorher) {
        const m = game.migrationFailures[game.migrationFailures.length - 1]!;
        notiere('wanderung', account.id, `v${m.fromVersion} → v${m.toVersion} gescheitert: ${m.message}`);
      }
      const geraetNachher = game.activeDevice?.id ?? null;
      if (geraetVorher && geraetNachher && geraetVorher !== geraetNachher) {
        notiere('geraet', account.id, `Übernahme: ${geraetVorher} → ${geraetNachher}`);
      }

      publish(account.id, game);
      persist(account, game);

      Object.assign(result as object, { serverTime: Date.now() });

      noteTruncation(result, parsed.commands.length, account.id);

      const label = result.ok ? result.kind : `abgelehnt: ${result.reason}`;
      console.log(
        `[sync] ${account.id} ${parsed.commands.length} Commands → ${label}, seq=${game.snapshot.seq}`,
      );
      return json(res, 200, result);
    }

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

  let lastPlaintextHint = 0;
  https.on('clientError', (err, socket) => {
    if ((err as NodeJS.ErrnoException).code === 'ERR_SSL_HTTP_REQUEST') {
      const now = Date.now();

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
  console.log(`Admin:       …${TOKEN.slice(-4)}  (vollständig: cat ${TOKEN_PATH})`);
  console.log('');
});

const FLUSH_MS = Number(process.env.NEUES_SPIEL_FLUSH_MS ?? 2000);
const flushTimer = setInterval(() => {
  try {
    accounts.flush();
    market.flush();
  } catch (err) {
    console.error(`[speicher] Schreiben fehlgeschlagen: ${(err as Error).message}`);
  }
}, FLUSH_MS);
flushTimer.unref();

const nudgeTimer = setInterval(() => events.flush(), 250);
nudgeTimer.unref();
const heartbeatTimer = setInterval(() => events.heartbeat(), 25_000);
heartbeatTimer.unref();

const IDLE_MS = Number(process.env.NEUES_SPIEL_IDLE_MS ?? 15 * 60_000);
// — Meldungen bei fertiger Arbeit ————————————————————————————————————————
// Alle paar Minuten nachschauen, ob bei jemandem etwas wartet. Gemeldet wird
// nur, wer gerade NICHT spielt und länger nichts gehört hat — eine Farm-App,
// die im Minutentakt piept, wird deinstalliert.
const MELDE_TAKT_MS = Number(process.env.NEUES_SPIEL_MELDE_TAKT_MS ?? 5 * 60_000);
const MELDE_RUHE_MS = Number(process.env.NEUES_SPIEL_MELDE_RUHE_MS ?? 6 * 60 * 60_000);
const MELDE_ABWESEND_MS = Number(process.env.NEUES_SPIEL_MELDE_ABWESEND_MS ?? 20 * 60_000);

// Was wartet gerade auf den Spieler? Rein aus Zustand und Regelwerk gerechnet,
// ohne den Client-Blick zu bemühen.
function wasWartet(snap: { state: State; rulesetVersion: number; serverTs: number }, jetztMs: number) {
  const rules = getRuleset(snap.rulesetVersion);
  const st = snap.state;
  const tick = st.tick + Math.floor((jetztMs - snap.serverTs) / 1000);

  let reif = 0;
  for (const platz of st.plots) {
    for (const stelle of platz.slots) {
      if (stelle.recipe < 0) continue;
      const dauer = rules.recipes[stelle.recipe]?.durationTicks ?? 0;
      if (tick - stelle.startedAt >= dauer) reif++;
    }
  }

  const f = rules.fishing;
  let reusen = 0;
  let koeder = 0;
  if (f) {
    for (const gelegt of st.angelSpots ?? []) {
      if (gelegt >= 0 && tick - gelegt >= (f.soakTicks ?? 0)) reusen++;
    }
    for (const seit of st.angelKoeder ?? []) {
      if (seit >= 0 && tick - seit >= (f.craft?.durationTicks ?? 0)) koeder++;
    }
  }
  return { reif, reusen, koeder };
}

function meldeText(w: { reif: number; reusen: number; koeder: number }): string | null {
  const teile: string[] = [];
  if (w.reif > 0) teile.push(w.reif === 1 ? '1 Platz ist fertig' : `${w.reif} Plätze sind fertig`);
  if (w.reusen > 0) teile.push(w.reusen === 1 ? '1 Reuse ist voll' : `${w.reusen} Reusen sind voll`);
  if (w.koeder > 0) teile.push(w.koeder === 1 ? '1 Sud Köder wartet' : `${w.koeder} Sude Köder warten`);
  if (teile.length === 0) return null;
  return `${teile.join(', ')}. Schau mal vorbei.`;
}

const GESCHENK_MAX = 5;

function geschenktHeute(von: string, an: string, nowMs: number): boolean {
  return Number(accounts.storage.getMeta(`geschenk-${von}-${an}`) ?? '-1') === tagVon(nowMs);
}

function merkeGeschenk(von: string, an: string, nowMs: number): void {
  accounts.storage.setMeta(`geschenk-${von}-${an}`, String(tagVon(nowMs)));
}

type Geschenk = { von: string; code: string; item: number; amount: number; wann: number };

function geschenkAblegen(an: string, g: Geschenk): void {
  let liste: Geschenk[] = [];
  try { liste = JSON.parse(accounts.storage.getMeta(`geschenke-${an}`) ?? '[]') as Geschenk[]; } catch { liste = []; }
  liste.push(g);
  accounts.storage.setMeta(`geschenke-${an}`, JSON.stringify(liste.slice(-20)));
}

function geschenkeAbholen(an: string): Geschenk[] {
  let liste: Geschenk[] = [];
  try { liste = JSON.parse(accounts.storage.getMeta(`geschenke-${an}`) ?? '[]') as Geschenk[]; } catch { liste = []; }
  if (liste.length > 0) accounts.storage.setMeta(`geschenke-${an}`, '[]');
  return liste;
}

async function meldeRunde(): Promise<number> {
  const abos = accounts.storage.listPushAbos();
  if (abos.length === 0) return 0;

  const jetzt = Date.now();
  let gemeldet = 0;
  for (const id of new Set(abos.map((a) => a.konto))) {
    const konto = accounts.get(id);
    if (!konto) continue;
    // Wer gerade spielt, sieht es ohnehin selbst.
    if (jetzt - konto.lastSeenMs < MELDE_ABWESEND_MS) continue;
    const zuletzt = Number(accounts.storage.getMeta(`melde-${id}`) ?? '0');
    if (jetzt - zuletzt < MELDE_RUHE_MS) continue;

    const snap = live.get(id)?.snapshot ?? accounts.load(id)?.snapshot;
    if (!snap) continue;
    const text = meldeText(wasWartet(snap, jetzt));
    if (!text) continue;

    accounts.storage.setMeta(`melde-${id}`, String(jetzt));
    const r = await pushAn([id], 'Auf deinem Hof wartet was', text, 'fertig');
    if (r.gesendet > 0) gemeldet++;
  }
  if (gemeldet > 0) console.log(`[melden] ${gemeldet} Höfe benachrichtigt`);
  return gemeldet;
}

const meldeTimer = setInterval(() => {
  meldeRunde().catch((e) => console.error('[melden] Runde fehlgeschlagen:', e));
}, MELDE_TAKT_MS);
meldeTimer.unref();

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

// NPC-/Bot-Käufer: gelegentlicher, kontrollierter Economy-Sink. Zentral über
// Umgebungsvariablen konfigurierbar. Standard: alle 5 Minuten eine Runde, in der
// mit 15 % Wahrscheinlichkeit höchstens ein Angebot gekauft wird — und nur, wenn
// der Markt gut gefüllt ist und der betroffene Stand danach noch Ware hat.
// Offline-Verkäufer bekommen ihr Gold über die bestehende Abrechnung: der Kauf
// legt eine Settlement an (persistiert), die beim nächsten /state oder /sync des
// Verkäufers gutgeschrieben wird. Wer gerade online ist, wird sofort abgerechnet.
const NPC_KAUF = {
  everyMs: Number(process.env.NEUES_SPIEL_NPC_EVERY_MS ?? 5 * 60_000),
  chance: Number(process.env.NEUES_SPIEL_NPC_CHANCE ?? 0.15),
  maxProRunde: Number(process.env.NEUES_SPIEL_NPC_MAX ?? 1),
  minBuch: Number(process.env.NEUES_SPIEL_NPC_MIN_BOOK ?? 8),
  minAlterMs: Number(process.env.NEUES_SPIEL_NPC_MIN_AGE_MS ?? 10 * 60_000),
  behaltenProStand: Number(process.env.NEUES_SPIEL_NPC_KEEP ?? 1),
};
if (NPC_KAUF.everyMs > 0 && NPC_KAUF.chance > 0) {
  const npcTimer = setInterval(() => {
    let betroffen: string[] = [];
    try {
      betroffen = market.npcKauf(NPC_KAUF, Date.now());
    } catch (err) {
      console.error(`[markt] NPC-Kauf fehlgeschlagen: ${(err as Error).message}`);
      return;
    }
    for (const sellerId of betroffen) {
      const g = live.get(sellerId);
      if (g) {
        settleSales(market, sellerId, g);
        events.nudge(sellerId, 'farm');
      }
      events.broadcast('market', sellerId);
      console.log(`[markt] NPC kauft ein Angebot bei ${sellerId}`);
    }
    if (betroffen.length > 0) market.flush();
  }, NPC_KAUF.everyMs);
  npcTimer.unref();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} — speichere und beende.`);

    events.closeAll();
    for (const [id, g] of live) {
      const account = accounts.get(id);
      if (account) persist(account, g);
    }
    market.flush();
    accounts.close();

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

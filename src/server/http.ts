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
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Server } from './server.ts';
import type { SyncRequest } from './server.ts';
import { load, save } from './store.ts';
import { initialState, normalizeState } from '../sim/state.ts';
import type { State } from '../sim/state.ts';
import { LATEST_RULESET_VERSION, RULESETS, getRuleset, levelOf } from '../sim/rules.ts';
import { ConfigError, describeConfig, isLoopback, isSecureTransport, resolveConfig } from './config.ts';
import { AccountStore, CreateLimiter, keyHashOf } from './accounts.ts';
import type { AccountRecord } from './accounts.ts';
import { SqliteStorage } from './storage.ts';
import { NAME_MAX, Sozial } from './sozial.ts';
import type { HofKarte } from './sozial.ts';
import { Tagesbonus } from './tagesbonus.ts';
import { Market, connectMarket, publishOrders, settleSales } from './market.ts';
import { EventHub } from './events.ts';
import { ladeVapid, sendePush } from './push.ts';
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

// Schickt eine Nachricht an alle Geräte eines Kontos. Tote Abos fliegen raus.
async function pushAn(kontoIds: readonly string[], nutzlast: unknown): Promise<{ gesendet: number; entfernt: number }> {
  let gesendet = 0;
  let entfernt = 0;
  for (const id of kontoIds) {
    for (const abo of accounts.storage.listPushAbos(id)) {
      const r = await sendePush(VAPID, abo, nutzlast);
      if (r.ok) {
        gesendet++;
        accounts.storage.putPushAbo({ ...abo, zuletztMs: Date.now() });
      } else if (r.weg) {
        accounts.storage.dropPushAbo(abo.endpoint);
        entfernt++;
      }
    }
  }
  return { gesendet, entfernt };
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

function besuchsBild(karte: HofKarte, wer: string) {
  const spiel = gameFor(zielKonto(karte.id));
  spiel.receiveExternal();
  const rules = getRuleset(spiel.snapshot.rulesetVersion);

  return {
    ...hofZeile(karte, wer),
    rulesetVersion: spiel.snapshot.rulesetVersion,
    tick: spiel.snapshot.state.tick,
    serverTs: spiel.snapshot.serverTs,
    xp: spiel.snapshot.state.xp,
    plots: spiel.snapshot.state.plots.map((p) => ({
      level: p.level,
      gx: p.gx,
      gy: p.gy,
      tiere: p.tiere.length,
      slots: p.slots.map((x) => ({ recipe: x.recipe, startedAt: x.startedAt })),
    })),
    clearedObstacles: spiel.snapshot.state.clearedObstacles,
    expandiert: spiel.snapshot.state.expandiert ?? [],
    stand: spiel.snapshot.state.orders.map((o) => ({
      id: o.id,
      item: o.item,
      amount: o.amount,
      price: o.price,
      verkauft: o.verkauft,
    })),
    grid: rules.grid ? { w: rules.grid.w, h: rules.grid.h } : null,
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
const page = loadPage('field-test.html');
const adminPage = loadPage('admin.html');

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

function handleAdmin(url: URL, req: IncomingMessage, res: ServerResponse) {
  if (url.pathname === '/api/admin/accounts') {
    return json(res, 200, {
      count: accounts.count,
      accounts: accounts.list().map((a) => {
        const karte = sozial.karte(a.id);
        return {
          id: a.id,
          name: karte?.name ?? null,
          code: karte?.code ?? null,
          createdAt: a.createdAt,
          lastSeenMs: a.lastSeenMs,
          seq: live.get(a.id)?.snapshot.seq ?? null,
        };
      }),
    });
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
    return pushAn(ziele, { titel, text, art: 'admin' }).then((r) => {
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

  if (req.method !== 'POST') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });

  if (url.pathname === '/api/admin/time') {
    const seconds = Number(url.searchParams.get('seconds') ?? '0');
    if (!Number.isInteger(seconds) || seconds <= 0 || seconds > 90 * 86_400) {
      return json(res, 400, { error: 'BAD_SECONDS' });
    }
    game.grantTime(seconds);
    persist(target, game);
    events.nudge(target.id, 'farm');
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
    console.log(`[admin] ${target.id}: ${amount} ${name} ins Postfach`);
    return json(res, 200, { ok: true, queued: game.pendingDeliveries.length });
  }

  if (url.pathname === '/api/admin/xp') {
    const amount = Number(url.searchParams.get('amount') ?? '0');
    if (!Number.isInteger(amount) || amount <= 0) return json(res, 400, { error: 'BAD_XP' });
    game.grantXp(amount);
    persist(target, game);
    events.nudge(target.id, 'farm');
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
    console.log(`[admin] ${target.id}: Zielversion v${version} — greift beim nächsten Sync`);
    return json(res, 200, { ok: true, targetRulesetVersion: version });
  }

  if (url.pathname === '/api/admin/reset') {
    game.reset(initialState(getRuleset(TARGET_RULESET)), Date.now(), TARGET_RULESET);

    market.forget(target.id);
    game.stockRequests();
    game.stockOffers();
    persist(target, game);
    console.log(`[admin] ${target.id}: Spielstand zurückgesetzt`);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'NOT_FOUND' });
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (CONFIG.tls) {
    res.setHeader('strict-transport-security', 'max-age=31536000');
  }

  if (url.pathname === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }

  if (url.pathname === '/health') {
    return json(res, 200, {
      ok: true,
      env: CONFIG.env,
      version: CONFIG.version,
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

    const account = accounts.resolve(bearer(req));
    if (!account) return json(res, 401, { error: 'UNAUTHORIZED' });
    const game = gameFor(account);

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
      let abo: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
      try {
        abo = JSON.parse(await readBody(req, 8 * 1024));
      } catch {
        return json(res, 400, { error: 'BAD_JSON' });
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
        p256dh,
        auth,
        seitMs: Date.now(),
        zuletztMs: 0,
      });
      return json(res, 200, { ok: true });
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
        freunde: sozial.freunde(account.id).map((f) => hofZeile(f, account.id)),
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
      return json(res, 200, besuchsBild(ziel, account.id));
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
        besuch: besuchsBild(ziel, account.id),
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

      const result = game.sync(parsed, Date.now());
      if (result.ok) econstats.addDiscarded(game.lastSyncDiscarded);

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
  console.log(`Feldtest:    ${page ? '/feldtest' : 'FEHLT (npm run build)'}`);
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
    const r = await pushAn([id], { titel: 'Auf deinem Hof wartet was', text, art: 'fertig' });
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

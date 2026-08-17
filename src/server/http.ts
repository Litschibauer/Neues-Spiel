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

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Server } from './server.ts';
import type { SyncRequest } from './server.ts';
import { load, save } from './store.ts';
import { initialState } from '../sim/state.ts';
import { RULESETS, getRuleset } from '../sim/rules.ts';
import { ConfigError, describeConfig, resolveConfig } from './config.ts';

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
 * Token besorgen: Umgebungsvariable, sonst Datei, sonst neu erzeugen.
 *
 * Die Datei ist der bequeme Normalfall. Ein Token, das nur in der
 * Umgebungsvariable steht, landet in der Shell-History und ist nach dem
 * nächsten Neustart schlicht weg — dann steht man vor „wie finde ich das
 * eigentlich wieder heraus".
 *
 * Erreichbar, aber nicht offen: Ohne Token läuft der Server nie. Wenn keines da
 * ist, erzeugt er eines statt sich zu verweigern — das ist ebenso sicher und
 * erspart den Umweg über ein Kommando, das man erst noch finden muss.
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
  console.log('  Neues Zugangs-Token erzeugt:\n');
  console.log(`  ${generated}\n`);
  console.log(`  Liegt in ${TOKEN_PATH} — jederzeit wieder abrufbar mit:`);
  console.log(`  cat ${TOKEN_PATH}`);
  console.log('─'.repeat(52) + '\n');
  return generated;
}

const TOKEN = resolveToken();

// ── Zustand laden oder neu anlegen ─────────────────────────────────────
const persisted = load(SAVE_PATH);
const game = new Server(
  initialState(getRuleset(TARGET_RULESET)),
  Date.now(),
  persisted ? persisted.snapshot.rulesetVersion : TARGET_RULESET,
  TARGET_RULESET,
);

if (persisted) {
  game.snapshot = persisted.snapshot;
  game.appliedLog = persisted.appliedLog;
  game.pendingDeliveries = persisted.pendingDeliveries;
  game.targetRulesetVersion = TARGET_RULESET;
  game.nextRequestId = persisted.nextRequestId ?? 1;
  console.log(`Spielstand geladen: seq=${game.snapshot.seq}, tick=${game.snapshot.state.tick}`);
} else {
  console.log('Kein Spielstand gefunden — neuer Hof.');
}

// Kundenaufträge sofort auffüllen: Wer die App startet, soll nicht erst eine
// Verbindung brauchen, um ein Ziel zu haben (Architektur §6).
game.stockRequests();

function persist(): void {
  save(SAVE_PATH, {
    version: 1,
    snapshot: game.snapshot,
    appliedLog: game.appliedLog,
    pendingDeliveries: game.pendingDeliveries,
    targetRulesetVersion: game.targetRulesetVersion,
    nextRequestId: game.nextRequestId,
  });
}

// ── Hilfen ─────────────────────────────────────────────────────────────
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN as string);
  // Längen zuerst prüfen: timingSafeEqual wirft bei ungleicher Länge.
  return a.length === b.length && timingSafeEqual(a, b);
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
function resolveItem(name: string): number | null {
  const rules = getRuleset(game.snapshot.rulesetVersion);
  const index = rules.items.findIndex((i) => i.id === name);
  return index >= 0 ? index : null;
}

function loadPage(name: string): string | null {
  const path = join(ROOT, 'dist', name);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

const page = loadPage('field-test.html');
const adminPage = loadPage('admin.html');

/**
 * Das Admin-Panel ist ein Testwerkzeug: In Dev an, in Produktion aus.
 * Es kann Gegenstände verschenken und Zeit gutschreiben — siehe config.ts.
 */
const ADMIN_ENABLED = CONFIG.adminEnabled;

// ── Routen ─────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // Browser fragen das ungefragt an; ein 404 im Log wäre nur Rauschen.
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }

  if (url.pathname === '/health') {
    // Umgebung und Stand gehören hier hinein: Nur so sieht man von außen,
    // WELCHE Version gerade läuft — die Frage, die man beim Deployen hat.
    return json(res, 200, {
      ok: true,
      env: CONFIG.env,
      version: CONFIG.version,
      rulesetVersion: game.snapshot.rulesetVersion,
      seq: game.snapshot.seq,
      tick: game.snapshot.state.tick,
    });
  }

  if (url.pathname === '/admin' && req.method === 'GET') {
    if (!ADMIN_ENABLED) return json(res, 403, { error: 'ADMIN_DISABLED' });
    if (!adminPage) return json(res, 500, { error: 'Seite fehlt — `npm run build`.' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(adminPage);
  }

  if (url.pathname === '/' && req.method === 'GET') {
    if (!page) return json(res, 500, { error: 'Seite fehlt — bitte `npm run build` ausführen.' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(page);
  }

  if (url.pathname.startsWith('/api/')) {
    if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' });

    if (url.pathname === '/api/state' && req.method === 'GET') {
      const deviceId = url.searchParams.get('deviceId') ?? undefined;
      return json(res, 200, {
        snapshot: game.snapshot,
        serverTime: Date.now(),
        // Damit ein zweites Gerät es erfährt, BEVOR es losspielt (R3).
        isActiveDevice: game.isActiveDevice(deviceId),
        activeSince: game.activeDevice?.lastSyncMs ?? null,
      });
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

      // Zeitautorität: der Server misst selbst (§4).
      const result = game.sync(parsed, Date.now());
      persist();

      // `serverTime` mitgeben, damit der Client seine Uhr gegen die des Servers
      // ausrichten kann. Ohne das müsste er seiner eigenen vertrauen — und die
      // ist genau das, was der Server nicht akzeptiert (§4).
      Object.assign(result as object, { serverTime: Date.now() });

      const label = result.ok ? result.kind : `abgelehnt: ${result.reason}`;
      console.log(`[sync] ${parsed.commands.length} Commands → ${label}, seq=${game.snapshot.seq}`);
      return json(res, 200, result);
    }

    // ── Admin-Werkzeuge ──────────────────────────────────────────────
    //
    // Alle Eingriffe laufen über Mechanismen, die es ohnehin gibt:
    // Zustellungen ins Postfach (§7) und das Zeitbudget (§4). Kein direkter
    // Griff in Felder oder Bestände — der würde beim nächsten Sync einen
    // Divergenz-Alarm auslösen, obwohl gar kein Bug vorliegt.
    if (url.pathname.startsWith('/api/admin/')) {
      if (!ADMIN_ENABLED) return json(res, 403, { error: 'ADMIN_DISABLED' });

      if (url.pathname === '/api/admin/status') {
        return json(res, 200, {
          // Der Katalog gehört mit in die Antwort: Der Zustand hält nur
          // Zahlen in Katalogreihenfolge, und welche Reihenfolge das ist,
          // hängt an der Regelversion.
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
        persist();
        console.log(`[admin] ${seconds}s Zeit gutgeschrieben`);
        return json(res, 200, { ok: true, serverTs: game.snapshot.serverTs });
      }

      if (url.pathname === '/api/admin/grant') {
        const name = url.searchParams.get('item') ?? 'eggs';
        const amount = Number(url.searchParams.get('amount') ?? '10');
        const item = resolveItem(name);
        if (item === null || !Number.isInteger(amount) || amount <= 0) {
          return json(res, 400, { error: 'BAD_GRANT' });
        }
        game.deliver({ item, amount, arrivedAt: Date.now() });
        persist();
        console.log(`[admin] ${amount} ${name} ins Postfach`);
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
        persist();
        console.log(`[admin] Zielversion v${version} — greift beim nächsten Sync`);
        return json(res, 200, { ok: true, targetRulesetVersion: version });
      }

      if (url.pathname === '/api/admin/reset') {
        game.reset(initialState(getRuleset(TARGET_RULESET)), Date.now(), TARGET_RULESET);
        game.stockRequests();
        persist();
        console.log('[admin] Spielstand zurückgesetzt');
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: 'NOT_FOUND' });
    }

    // Alter Pfad, bleibt für Skripte erhalten.
    if (url.pathname === '/api/deliver' && req.method === 'POST') {
      const name = url.searchParams.get('item') ?? 'eggs';
      const amount = Number(url.searchParams.get('amount') ?? '5');
      const item = resolveItem(name);
      if (item === null || !Number.isInteger(amount) || amount <= 0) {
        return json(res, 400, { error: 'BAD_DELIVERY' });
      }
      game.deliver({ item, amount, arrivedAt: Date.now() });
      persist();
      return json(res, 200, { queued: game.pendingDeliveries.length });
    }

    return json(res, 404, { error: 'NOT_FOUND' });
  }

  return json(res, 404, { error: 'NOT_FOUND' });
});

server.listen(PORT, () => {
  console.log('');
  for (const line of describeConfig(CONFIG)) console.log(line);
  console.log(`Snapshot:   v${game.snapshot.rulesetVersion} → Ziel v${TARGET_RULESET}`);
  console.log(`Seite:      ${page ? 'eingebunden' : 'FEHLT (npm run build)'}`);
  console.log(`Token:      …${TOKEN.slice(-4)}  (vollständig: cat ${TOKEN_PATH})`);
  console.log('');
});

// Sauber beenden, damit der letzte Sync sicher auf der Platte liegt.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} — speichere und beende.`);
    persist();
    server.close(() => process.exit(0));
  });
}

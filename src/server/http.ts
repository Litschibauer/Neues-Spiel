/**
 * Feldtest-Server (Architektur §10).
 *
 *   NEUES_SPIEL_TOKEN=… node --experimental-strip-types src/server/http.ts
 *
 * Zweck: Das Verbindungsmodell über ein ECHTES Netzwerk prüfen statt über
 * Testattrappen. Echte Latenz, echte Abbrüche, echtes Verhalten, wenn das Handy
 * in den Aufzug fährt.
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
import { CURRENT_RULESET_VERSION } from '../sim/rules.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const PORT = Number(process.env.PORT ?? 8787);
const SAVE_PATH = process.env.NEUES_SPIEL_SAVE ?? join(ROOT, 'data', 'save.json');
const FIELD_COUNT = 6;

const TOKEN_PATH = process.env.NEUES_SPIEL_TOKEN_FILE ?? join(ROOT, 'data', 'token');

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
const game = new Server(initialState(FIELD_COUNT), Date.now(), CURRENT_RULESET_VERSION);

if (persisted) {
  game.snapshot = persisted.snapshot;
  game.appliedLog = persisted.appliedLog;
  game.pendingDeliveries = persisted.pendingDeliveries;
  game.targetRulesetVersion = persisted.targetRulesetVersion;
  console.log(`Spielstand geladen: seq=${game.snapshot.seq}, tick=${game.snapshot.state.tick}`);
} else {
  console.log('Kein Spielstand gefunden — neuer Hof.');
}

function persist(): void {
  save(SAVE_PATH, {
    version: 1,
    snapshot: game.snapshot,
    appliedLog: game.appliedLog,
    pendingDeliveries: game.pendingDeliveries,
    targetRulesetVersion: game.targetRulesetVersion,
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

const PAGE_PATH = join(ROOT, 'dist', 'field-test.html');
let page: string | null = existsSync(PAGE_PATH) ? readFileSync(PAGE_PATH, 'utf8') : null;

// ── Routen ─────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // Browser fragen das ungefragt an; ein 404 im Log wäre nur Rauschen.
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }

  if (url.pathname === '/health') {
    return json(res, 200, { ok: true, seq: game.snapshot.seq, tick: game.snapshot.state.tick });
  }

  if (url.pathname === '/' && req.method === 'GET') {
    if (!page) return json(res, 500, { error: 'Seite fehlt — bitte `npm run web` ausführen.' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(page);
  }

  if (url.pathname.startsWith('/api/')) {
    if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' });

    if (url.pathname === '/api/state' && req.method === 'GET') {
      return json(res, 200, { snapshot: game.snapshot, serverTime: Date.now() });
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

    // Geschenk von außen — zum Testen des Postfachs (§7).
    if (url.pathname === '/api/deliver' && req.method === 'POST') {
      const item = url.searchParams.get('item') ?? 'eggs';
      const amount = Number(url.searchParams.get('amount') ?? '5');
      if (!['wheat', 'eggs', 'gold'].includes(item) || !Number.isInteger(amount) || amount <= 0) {
        return json(res, 400, { error: 'BAD_DELIVERY' });
      }
      game.deliver({ item: item as 'wheat' | 'eggs' | 'gold', amount, arrivedAt: Date.now() });
      persist();
      return json(res, 200, { queued: game.pendingDeliveries.length });
    }

    return json(res, 404, { error: 'NOT_FOUND' });
  }

  return json(res, 404, { error: 'NOT_FOUND' });
});

server.listen(PORT, () => {
  console.log(`Feldtest-Server auf Port ${PORT}`);
  console.log(`Spielstand: ${SAVE_PATH}`);
  console.log(`Seite: ${page ? 'eingebunden' : 'FEHLT (npm run conformance)'}`);
  console.log(`Token: …${TOKEN.slice(-4)}  (vollständig: cat ${TOKEN_PATH})`);
});

// Sauber beenden, damit der letzte Sync sicher auf der Platte liegt.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} — speichere und beende.`);
    persist();
    server.close(() => process.exit(0));
  });
}

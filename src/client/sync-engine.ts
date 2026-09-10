import type { SyncRequest, SyncResult, Snapshot } from '../server/server.ts';
import type { Client } from './client.ts';

export type Transport = (req: SyncRequest, signal?: AbortSignal) => Promise<SyncResult>;

export type ConnectionView = 'live' | 'catching-up' | 'offline';

export type SyncOutcome =
  | { kind: 'nothing-to-do' }
  | { kind: 'backing-off'; retryInMs: number }
  | { kind: 'in-flight' }
  | { kind: 'synced'; result: SyncResult }
  | { kind: 'dropped'; rejectedFrom: number; reason: string; snapshot: Snapshot }
  | { kind: 'failed'; retryInMs: number; timedOut: boolean };

export type SyncEngineOptions = {
  baseDelayMs: number;
  maxDelayMs: number;
  pendingMaxDelayMs: number;
  timeoutMs: number;
  rnd: () => number;
};

const DEFAULTS: SyncEngineOptions = {
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
  pendingMaxDelayMs: 5_000,
  timeoutMs: 15_000,
  rnd: Math.random,
};

export class SyncEngine {
  client: Client;
  transport: Transport;
  opts: SyncEngineOptions;
  view: ConnectionView = 'live';
  consecutiveFailures = 0;
  nextAttemptAt = 0;
  inFlight = false;

  resumes = 0;
  // Wie oft eine vorgehende Geraeteuhr auf die Serverzeit zurueckdatiert wurde.
  umdatiert = 0;

  timeouts = 0;

  constructor(client: Client, transport: Transport, opts: Partial<SyncEngineOptions> = {}) {
    this.client = client;
    this.transport = transport;
    this.opts = { ...DEFAULTS, ...opts };
  }

  private backoffMs(): number {
    const deckel =
      this.client.queue.length > 0
        ? Math.min(this.opts.maxDelayMs, this.opts.pendingMaxDelayMs)
        : this.opts.maxDelayMs;
    const exp = Math.min(
      this.opts.baseDelayMs * 2 ** Math.max(0, this.consecutiveFailures - 1),
      deckel,
    );
    return Math.round(exp / 2 + this.opts.rnd() * (exp / 2));
  }

  revive(): void {
    this.consecutiveFailures = 0;
    this.nextAttemptAt = 0;
  }

  hurry(nowMs: number): void {
    const frueh = nowMs + this.opts.baseDelayMs;
    if (this.nextAttemptAt > frueh) this.nextAttemptAt = frueh;
  }

  async attempt(nowMs: number, force = false): Promise<SyncOutcome> {
    if (this.inFlight) return { kind: 'in-flight' };

    if (this.client.queue.length === 0 && !force) {
      return { kind: 'nothing-to-do' };
    }

    if (!force && nowMs < this.nextAttemptAt) {
      return { kind: 'backing-off', retryInMs: this.nextAttemptAt - nowMs };
    }

    const req = this.client.buildSyncRequest();

    const sentThrough =
      req.commands.length > 0 ? req.commands[req.commands.length - 1]!.seq : req.baseSeq;
    this.inFlight = true;

    let result: SyncResult;
    let timedOut = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.opts.timeoutMs);

    try {
      result = await Promise.race([
        this.transport(req, controller.signal),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('TIMEOUT')), {
            once: true,
          });
        }),
      ]);
    } catch {
      clearTimeout(timer);
      this.inFlight = false;
      this.consecutiveFailures++;
      this.view = 'offline';
      this.timeouts += timedOut ? 1 : 0;
      const retryInMs = this.backoffMs();
      this.nextAttemptAt = nowMs + retryInMs;
      return { kind: 'failed', retryInMs, timedOut };
    }
    clearTimeout(timer);

    this.inFlight = false;

    if (!result.ok) {
      // Geht die Geraeteuhr vor, ist das fast immer Drift und kein Betrug: Die
      // Uhr wird erst bei jedem Sync neu am Server ausgerichtet, und wer lange
      // ohne Netz war, laeuft davon. Statt die Arbeit zu verwerfen, datieren
      // wir sie auf die Serveruhr zurueck und rechnen sie neu. Der ehrliche
      // Spieler verliert dadurch nichts; beim Schummler war zur echten Zeit
      // nichts reif, seine Befehle fallen beim Nachspielen einzeln heraus —
      // aus dem richtigen Grund, naemlich der Spielregel statt der Uhr.
      if (result.reason === 'CLOCK_AHEAD_OF_SERVER') {
        const snap = result.snapshot;
        const deckel =
          snap.state.tick + Math.floor((result.serverTime - snap.serverTs) / 1000);
        this.umdatiert++;
        this.client.adopt(snap, snap.seq, Math.max(snap.state.tick, deckel));
        this.consecutiveFailures = 0;
        this.nextAttemptAt = 0;
        this.view = 'live';
        return { kind: 'synced', result };
      }

      this.client.adopt(result.snapshot, sentThrough);
      this.consecutiveFailures = 0;
      this.nextAttemptAt = 0;
      this.view = 'live';
      return { kind: 'synced', result };
    }

    if (result.kind === 'duplicate') {
      this.resumes++;
    }

    this.client.adopt(result.snapshot, sentThrough);
    this.consecutiveFailures = 0;
    this.nextAttemptAt = 0;
    this.view = 'live';

    if (result.kind === 'partial') {
      return {
        kind: 'dropped',
        rejectedFrom: result.rejectedFrom!,
        reason: result.reason ?? 'unknown',
        snapshot: result.snapshot,
      };
    }

    return { kind: 'synced', result };
  }
}

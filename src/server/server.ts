/**
 * Server-Seite: Zeitautorität + Re-Simulation + Snapshot (Architektur §3, §4, §9).
 *
 * Der Server ist die einzige Quelle der Wahrheit. Er übernimmt nie einen Zustand
 * vom Client, sondern leitet jeden neuen Zustand selbst aus dem geprüften
 * Command-Log ab — mit demselben Sim-Kern, den der Client benutzt.
 */

import type { Command } from '../sim/commands.ts';
import { SimError } from '../sim/commands.ts';
import type { State } from '../sim/state.ts';
import { getRuleset } from '../sim/rules.ts';
import { advanceTo, simulate } from '../sim/sim.ts';
import { canonicalizeCommand, hashState } from '../sim/hash.ts';

/** 1 Tick = 1 Sekunde Echtzeit. */
export const TICK_MS = 1000;

export type Snapshot = {
  state: State;
  /** seq des zuletzt angewandten Commands. */
  seq: number;
  /** Echtzeit-Zeitpunkt dieses Syncs, vom SERVER gemessen (§4). */
  serverTs: number;
  rulesetVersion: number;
};

export type SyncRequest = {
  baseSeq: number;
  rulesetVersion: number;
  commands: Command[];
  /** Hash des Client-Zustands nach dem letzten Command (Kanarienvogel, R1). */
  clientHash?: string;
};

export type SyncResult =
  | {
      ok: true;
      /**
       * applied   = alles übernommen
       * duplicate = war schon drin (verlorene Antwort), No-op
       * partial   = gültiges Präfix übernommen, ab `rejectedFrom` verworfen
       */
      kind: 'applied' | 'duplicate' | 'partial';
      snapshot: Snapshot;
      /** null = nicht prüfbar (kein Hash, keine Commands, oder nur Präfix übernommen). */
      divergence: boolean | null;
      /** Nur bei `partial`: seq des ersten abgelehnten Commands. */
      rejectedFrom?: number;
      reason?: string;
    }
  | { ok: false; kind: 'rejected'; reason: string; snapshot: Snapshot };

export class Server {
  snapshot: Snapshot;
  /** Determinismus-Alarme (R1) — gehören ins Monitoring, nicht in eine Sanktion. */
  divergenceAlerts: Array<{ seq: number; clientHash: string; serverHash: string }> = [];
  /**
   * Alle bisher angewandten Commands, nach seq.
   *
   * Braucht man ohnehin für Audit und Nachstellen von Fehlern — und er macht die
   * Präfix-Prüfung beim Wiederaufsetzen trivial und lückenlos korrekt. In
   * Produktion wird er hinter alten Snapshots abgeschnitten.
   */
  appliedLog: Command[] = [];

  constructor(initial: State, startTs: number, rulesetVersion: number) {
    this.snapshot = { state: initial, seq: 0, serverTs: startTs, rulesetVersion };
  }

  /**
   * Nimmt einen Offline-Log entgegen und rechnet ihn nach.
   *
   * Transaktional (§9, R8): Der Aufruf schreibt genau einmal — entweder das
   * geprüfte Präfix oder gar nichts. Ein abgebrochener Sync hinterlässt nie
   * einen halben Zustand.
   */
  sync(req: SyncRequest, nowMs: number): SyncResult {
    const snap = this.snapshot;

    let rules;
    try {
      rules = getRuleset(req.rulesetVersion);
    } catch {
      // R2: zu alte Client-Version → erzwungenes Update statt stiller Divergenz.
      return { ok: false, kind: 'rejected', reason: 'UNSUPPORTED_RULESET', snapshot: snap };
    }

    // ── Form des Batches ─────────────────────────────────────────────────
    for (let i = 0; i < req.commands.length; i++) {
      if (req.commands[i]!.seq !== req.baseSeq + i + 1) {
        return { ok: false, kind: 'rejected', reason: 'SEQ_GAP', snapshot: snap };
      }
    }

    if (req.baseSeq > snap.seq) {
      // Der Client behauptet, weiter zu sein als der Server. Kann nicht sein.
      return { ok: false, kind: 'rejected', reason: 'BASE_SEQ_AHEAD', snapshot: snap };
    }

    // ── Wiederaufsetzen nach verlorener Antwort ──────────────────────────
    //
    // Der Tunnel-Fall: Der Server hat den Batch angewandt, die Antwort ging
    // unterwegs verloren, der Spieler hat weitergespielt. Der Client schickt
    // jetzt erneut ab seinem alten `baseSeq` — inklusive der Commands, die
    // längst drin sind.
    //
    // Das ist KEIN Fork. Solange das überlappende Präfix Command für Command
    // identisch ist, wurde hier dieselbe Arbeit zweimal geschickt, und der
    // Server wendet einfach nur den Rest an.
    for (const cmd of req.commands) {
      if (cmd.seq > snap.seq) break;
      const applied = this.appliedLog[cmd.seq - 1];
      if (!applied || canonicalizeCommand(applied) !== canonicalizeCommand(cmd)) {
        // Gleiche Nummer, andere Aktion → zwei Geräte am selben Snapshot (R3).
        return { ok: false, kind: 'rejected', reason: 'FORK_DETECTED', snapshot: snap };
      }
    }

    const tail = req.commands.filter((c) => c.seq > snap.seq);
    if (tail.length === 0) {
      // Alles schon drin. Idempotent, also ein ruhiges No-op (§9).
      return { ok: true, kind: 'duplicate', snapshot: snap, divergence: null };
    }

    // ── Zeitautorität (§4) ───────────────────────────────────────────────
    // Der Server misst die real vergangene Zeit selbst. Die Geräteuhr des
    // Clients ist völlig irrelevant — sie kann keine Zeit erfinden.
    const elapsedMs = Math.max(0, nowMs - snap.serverTs);
    const maxTick = snap.state.tick + Math.floor(elapsedMs / TICK_MS);

    let prevTick = snap.state.tick;
    for (const cmd of tail) {
      if (cmd.tick < prevTick) {
        return { ok: false, kind: 'rejected', reason: 'TIME_WENT_BACKWARDS', snapshot: snap };
      }
      if (cmd.tick > maxTick) {
        return { ok: false, kind: 'rejected', reason: 'CLOCK_AHEAD_OF_SERVER', snapshot: snap };
      }
      prevTick = cmd.tick;
    }

    // ── Re-Simulation mit Präfix-Commit ──────────────────────────────────
    //
    // Bei einem illegalen Command wird NICHT der ganze Batch verworfen. Alles
    // davor war vom Server selbst als regelkonform bestätigt — es dafür
    // zurückzusetzen würde einen ehrlichen Spieler für einen einzigen Fehler
    // ganz hinten im Log bestrafen. Der Cheat landet trotzdem nicht.
    let state = snap.state;
    const accepted: Command[] = [];
    let rejectedFrom: number | undefined;
    let rejectReason: string | undefined;

    for (const cmd of tail) {
      try {
        state = simulate(state, cmd, rules);
        accepted.push(cmd);
      } catch (err) {
        rejectedFrom = cmd.seq;
        rejectReason = err instanceof SimError ? `ILLEGAL_COMMAND:${err.code}` : 'SIM_FAILURE';
        break;
      }
    }

    if (accepted.length === 0) {
      // Schon das erste neue Command ist illegal → es gibt nichts zu übernehmen.
      return { ok: false, kind: 'rejected', reason: rejectReason ?? 'SIM_FAILURE', snapshot: snap };
    }

    // ── Kanarienvogel (R1) ───────────────────────────────────────────────
    // Vergleichspunkt ist der Zustand NACH dem letzten Command — den können
    // beide Seiten unabhängig und exakt berechnen. „Jetzt" können sie nicht.
    // Bei einem gekürzten Batch ist ein Unterschied dagegen erwartbar und
    // sagt nichts über Determinismus aus.
    const fullyApplied = rejectedFrom === undefined;
    let divergence: boolean | null = null;
    if (fullyApplied && req.clientHash !== undefined) {
      const serverHash = hashState(state);
      divergence = serverHash !== req.clientHash;
      if (divergence) {
        this.divergenceAlerts.push({
          seq: accepted[accepted.length - 1]!.seq,
          clientHash: req.clientHash,
          serverHash,
        });
      }
    }

    // Passive Produktion bis zur echten Serverzeit fortschreiben.
    state = advanceTo(state, maxTick, rules);

    this.appliedLog.push(...accepted);
    this.snapshot = {
      state,
      seq: accepted[accepted.length - 1]!.seq,
      serverTs: nowMs,
      rulesetVersion: req.rulesetVersion,
    };

    if (!fullyApplied) {
      return {
        ok: true,
        kind: 'partial',
        snapshot: this.snapshot,
        divergence: null,
        rejectedFrom,
        reason: rejectReason,
      };
    }

    return { ok: true, kind: 'applied', snapshot: this.snapshot, divergence };
  }
}

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
import { hashCommands, hashState } from '../sim/hash.ts';

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
      kind: 'applied' | 'duplicate';
      snapshot: Snapshot;
      /** null = nicht prüfbar (kein Hash mitgeschickt oder keine Commands). */
      divergence: boolean | null;
    }
  | { ok: false; kind: 'rejected'; reason: string; snapshot: Snapshot };

export class Server {
  snapshot: Snapshot;
  /** Determinismus-Alarme (R1) — gehören ins Monitoring, nicht in eine Sanktion. */
  divergenceAlerts: Array<{ seq: number; clientHash: string; serverHash: string }> = [];
  /** Fingerabdruck des zuletzt angewandten Batches — für die Idempotenz-Prüfung. */
  private lastAppliedBaseSeq = -1;
  private lastAppliedHash: string | null = null;

  constructor(initial: State, startTs: number, rulesetVersion: number) {
    this.snapshot = { state: initial, seq: 0, serverTs: startTs, rulesetVersion };
  }

  /**
   * Nimmt einen Offline-Log entgegen und rechnet ihn nach.
   *
   * Atomar (§9): Entweder werden alle Commands angewandt oder keines. Ein
   * abgebrochener Sync hinterlässt damit nie einen halben Zustand.
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

    const lastSeq = req.commands.length ? req.commands[req.commands.length - 1]!.seq : req.baseSeq;
    const batchHash = req.commands.length > 0 ? hashCommands(req.commands) : null;

    // Idempotenz: ein wiederholt geschickter Log ist ein No-op, kein Fehler (§9).
    //
    // Die Prüfung MUSS am Inhalt hängen, nicht nur an der `seq`. Zwei Geräte, die
    // vom selben Snapshot aus offline gehen, vergeben dieselben Sequenznummern für
    // verschiedene Aktionen — eine reine seq-Prüfung würde einen Fork (R3) still
    // als „schon erledigt" durchwinken und die Arbeit des zweiten Geräts spurlos
    // verschlucken.
    if (
      batchHash !== null &&
      req.baseSeq === this.lastAppliedBaseSeq &&
      batchHash === this.lastAppliedHash
    ) {
      return { ok: true, kind: 'duplicate', snapshot: snap, divergence: null };
    }

    if (req.baseSeq !== snap.seq) {
      // Typischerweise ein Multi-Device-Fork (R3): zwei Geräte, ein Snapshot.
      return { ok: false, kind: 'rejected', reason: 'BASE_SEQ_MISMATCH', snapshot: snap };
    }

    // Lückenlose, aufsteigende Sequenz.
    for (let i = 0; i < req.commands.length; i++) {
      if (req.commands[i]!.seq !== snap.seq + i + 1) {
        return { ok: false, kind: 'rejected', reason: 'SEQ_GAP', snapshot: snap };
      }
    }

    // ── Zeitautorität (§4) ───────────────────────────────────────────────
    // Der Server misst die real vergangene Zeit selbst. Die Geräteuhr des
    // Clients ist völlig irrelevant — sie kann keine Zeit erfinden.
    const elapsedMs = Math.max(0, nowMs - snap.serverTs);
    const maxTick = snap.state.tick + Math.floor(elapsedMs / TICK_MS);

    let prevTick = snap.state.tick;
    for (const cmd of req.commands) {
      if (cmd.tick < prevTick) {
        return { ok: false, kind: 'rejected', reason: 'TIME_WENT_BACKWARDS', snapshot: snap };
      }
      if (cmd.tick > maxTick) {
        return { ok: false, kind: 'rejected', reason: 'CLOCK_AHEAD_OF_SERVER', snapshot: snap };
      }
      prevTick = cmd.tick;
    }

    // ── Re-Simulation ────────────────────────────────────────────────────
    let state = snap.state;
    try {
      for (const cmd of req.commands) state = simulate(state, cmd, rules);
    } catch (err) {
      const reason = err instanceof SimError ? `ILLEGAL_COMMAND:${err.code}` : 'SIM_FAILURE';
      return { ok: false, kind: 'rejected', reason, snapshot: snap };
    }

    // ── Kanarienvogel (R1) ───────────────────────────────────────────────
    // Vergleichspunkt ist der Zustand NACH dem letzten Command — den können
    // beide Seiten unabhängig und exakt berechnen. „Jetzt" können sie nicht.
    let divergence: boolean | null = null;
    if (req.clientHash !== undefined && req.commands.length > 0) {
      const serverHash = hashState(state);
      divergence = serverHash !== req.clientHash;
      if (divergence) {
        this.divergenceAlerts.push({ seq: lastSeq, clientHash: req.clientHash, serverHash });
      }
    }

    // Passive Produktion bis zur echten Serverzeit fortschreiben.
    state = advanceTo(state, maxTick, rules);

    this.snapshot = {
      state,
      seq: lastSeq,
      serverTs: nowMs,
      rulesetVersion: req.rulesetVersion,
    };

    if (batchHash !== null) {
      this.lastAppliedBaseSeq = req.baseSeq;
      this.lastAppliedHash = batchHash;
    }

    return { ok: true, kind: 'applied', snapshot: this.snapshot, divergence };
  }
}

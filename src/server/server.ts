import type { Command } from '../sim/commands.ts';
import { SimError } from '../sim/commands.ts';
import type { MailItem, Offer, State } from '../sim/state.ts';
import { cloneState } from '../sim/state.ts';
import { getRuleset } from '../sim/rules.ts';
import type { Ruleset } from '../sim/rules.ts';
import { simulate } from '../sim/sim.ts';
import { migrateState, MigrationError } from '../sim/migrate.ts';
import { canonicalizeCommand, hashState } from '../sim/hash.ts';
import { topUpRequests } from './requests.ts';
import { rollChest, topUpChests } from './chests.ts';

export const TICK_MS = 1000;

export const LOG_WINDOW = 200;

export type Snapshot = {
  state: State;
  seq: number;
  serverTs: number;
  rulesetVersion: number;
};

export type SyncRequest = {
  baseSeq: number;
  rulesetVersion: number;
  commands: Command[];
  clientHash?: string;
  deviceId?: string;
  takeover?: boolean;
  neueZeitung?: boolean;
};

export type SyncResult =
  | {
      ok: true;
      kind: 'applied' | 'duplicate' | 'partial';
      snapshot: Snapshot;
      divergence: boolean | null;
      rejectedFrom?: number;
      reason?: string;
    }
  | { ok: false; kind: 'rejected'; reason: string; snapshot: Snapshot };

export class Server {
  snapshot: Snapshot;
  divergenceAlerts: Array<{ seq: number; clientHash: string; serverHash: string }> = [];
  appliedLog: Command[] = [];

  logStartSeq = 1;

  targetRulesetVersion: number;
  migrationFailures: Array<{ fromVersion: number; toVersion: number; message: string }> = [];
  pendingDeliveries: MailItem[] = [];
  undeliverable: MailItem[] = [];
  activeDevice: { id: string; lastSyncMs: number } | null = null;

  nextRequestId = 1;

  rollRequest: () => number = Math.random;
  rollChest: () => number = Math.random;
  offerSource: (limit: number) => Offer[] = () => [];
  claimOffer: (offerId: number) => boolean = () => true;

  private soldSinceLastSync = false;

  isActiveDevice(deviceId: string | undefined): boolean {
    if (deviceId === undefined) return true;
    return this.activeDevice === null || this.activeDevice.id === deviceId;
  }

  deliver(item: MailItem): void {
    this.pendingDeliveries.push(item);
  }

  applySale(orderId: number, gold: number, nowMs: number, currency: number): void {
    const rules = getRuleset(this.snapshot.rulesetVersion);
    const state = cloneState(this.snapshot.state);

    if (rules.saleGoldInSlot) {
      state.orders = state.orders.map((o) =>
        o.id === orderId ? { ...o, verkauft: o.verkauft + gold } : o,
      );
    } else {
      state.orders = state.orders.filter((o) => o.id !== orderId);
      if (gold > 0) this.pendingDeliveries.push({ item: currency, amount: gold, arrivedAt: nowMs });
    }

    this.snapshot = { ...this.snapshot, state };
    this.soldSinceLastSync = true;
  }

  grantTime(seconds: number): void {
    if (!Number.isInteger(seconds) || seconds <= 0) return;
    this.snapshot = { ...this.snapshot, serverTs: this.snapshot.serverTs - seconds * TICK_MS };
  }

  trimLog(): void {
    const excess = this.appliedLog.length - LOG_WINDOW;
    if (excess <= 0) return;
    this.appliedLog = this.appliedLog.slice(excess);
    this.logStartSeq += excess;
  }

  reset(fresh: State, nowMs: number, rulesetVersion: number): void {
    this.snapshot = { state: fresh, seq: 0, serverTs: nowMs, rulesetVersion };
    this.appliedLog = [];
    this.logStartSeq = 1;
    this.pendingDeliveries = [];
    this.activeDevice = null;
    this.divergenceAlerts = [];
    this.migrationFailures = [];
    this.nextRequestId = 1;
    this.soldSinceLastSync = false;
  }

  stockRequests(): void {
    const rules = getRuleset(this.snapshot.rulesetVersion);
    const topped = topUpRequests(this.snapshot.state, rules, this.nextRequestId, this.rollRequest);
    if (topped.requests.length === this.snapshot.state.requests.length) return;

    const state = cloneState(this.snapshot.state);
    state.requests = topped.requests;
    this.snapshot = { ...this.snapshot, state };
    this.nextRequestId = topped.nextId;
  }

  stockOffers(): void {
    const rules = getRuleset(this.snapshot.rulesetVersion);
    const shelf = this.offerSource(rules.offerSlots);
    if (shelf.length === 0 && this.snapshot.state.offers.length === 0) return;

    const state = cloneState(this.snapshot.state);
    state.offers = shelf;
    this.snapshot = { ...this.snapshot, state };
  }

  constructor(initial: State, startTs: number, rulesetVersion: number, targetVersion?: number) {
    this.snapshot = { state: initial, seq: 0, serverTs: startTs, rulesetVersion };
    this.targetRulesetVersion = targetVersion ?? rulesetVersion;
  }

  receiveExternal(): void {
    const rules = getRuleset(this.snapshot.rulesetVersion);
    const state = this.applyExternal(this.snapshot.state, rules);
    if (state !== this.snapshot.state) this.snapshot = { ...this.snapshot, state };
  }

  private applyExternal(input: State, rules: Ruleset): State {
    let state = input;

    if (state.pendingBoxes.length > 0) {
      const geoeffnet = cloneState(state);
      for (const art of state.pendingBoxes) {
        for (const beute of rollChest(art, rules, this.rollChest)) {
          this.pendingDeliveries.push({ ...beute, arrivedAt: Date.now() });
        }
      }
      geoeffnet.pendingBoxes = [];
      state = geoeffnet;
    }

    const kisten = topUpChests(state, rules, this.rollChest);
    if (kisten.chests.length !== state.chests.length) {
      const withChests = cloneState(state);
      withChests.chests = kisten.chests;
      withChests.nextChestId = kisten.nextChestId;
      state = withChests;
    }

    const topped = topUpRequests(state, rules, this.nextRequestId, this.rollRequest);
    if (topped.requests.length !== state.requests.length) {
      const withRequests = cloneState(state);
      withRequests.requests = topped.requests;
      state = withRequests;
      this.nextRequestId = topped.nextId;
    }

    const shelf = this.offerSource(rules.offerSlots);
    if (shelf.length > 0 || state.offers.length > 0) {
      const withOffers = cloneState(state);
      withOffers.offers = shelf;
      state = withOffers;
    }

    if (this.pendingDeliveries.length > 0) {
      const withMail = cloneState(state);
      const stillPending: MailItem[] = [];
      for (const item of this.pendingDeliveries) {
        if (withMail.mail.length < rules.mailCapacity) {
          withMail.mail = withMail.mail.concat(item);
        } else {
          stillPending.push(item);
        }
      }
      state = withMail;
      this.pendingDeliveries = stillPending;
    }

    return state;
  }

  sync(req: SyncRequest, nowMs: number): SyncResult {
    const snap = this.snapshot;

    let rules;
    try {
      rules = getRuleset(req.rulesetVersion);
    } catch {
      return { ok: false, kind: 'rejected', reason: 'UNSUPPORTED_RULESET', snapshot: snap };
    }

    if (req.rulesetVersion !== snap.rulesetVersion) {
      return { ok: false, kind: 'rejected', reason: 'RULESET_MISMATCH', snapshot: snap };
    }

    if (req.deviceId !== undefined && !this.isActiveDevice(req.deviceId)) {
      if (!req.takeover) {
        return { ok: false, kind: 'rejected', reason: 'NOT_ACTIVE_DEVICE', snapshot: snap };
      }
    }

    for (let i = 0; i < req.commands.length; i++) {
      if (req.commands[i]!.seq !== req.baseSeq + i + 1) {
        return { ok: false, kind: 'rejected', reason: 'SEQ_GAP', snapshot: snap };
      }
    }

    if (req.baseSeq > snap.seq) {
      return { ok: false, kind: 'rejected', reason: 'BASE_SEQ_AHEAD', snapshot: snap };
    }

    for (const cmd of req.commands) {
      if (cmd.seq > snap.seq) break;
      if (cmd.seq < this.logStartSeq) {
        return { ok: false, kind: 'rejected', reason: 'LOG_TRUNCATED', snapshot: snap };
      }
      const applied = this.appliedLog[cmd.seq - this.logStartSeq];
      if (!applied || canonicalizeCommand(applied) !== canonicalizeCommand(cmd)) {
        return { ok: false, kind: 'rejected', reason: 'FORK_DETECTED', snapshot: snap };
      }
    }

    const tail = req.commands.filter((c) => c.seq > snap.seq);
    if (tail.length === 0) {
      const delivered = this.applyExternal(snap.state, rules);
      if (delivered !== snap.state) this.snapshot = { ...snap, state: delivered };
      return { ok: true, kind: 'duplicate', snapshot: this.snapshot, divergence: null };
    }

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

    let state = snap.state;
    const accepted: Command[] = [];
    let rejectedFrom: number | undefined;
    let rejectReason: string | undefined;

    for (const cmd of tail) {
      try {
        const after = simulate(state, cmd, rules);

        if (cmd.type === 'BUY_OFFER' && !this.claimOffer(cmd.offerId)) {
          rejectedFrom = cmd.seq;
          rejectReason = 'ILLEGAL_COMMAND:OFFER_GONE';
          break;
        }

        state = after;
        accepted.push(cmd);
      } catch (err) {
        rejectedFrom = cmd.seq;
        rejectReason = err instanceof SimError ? `ILLEGAL_COMMAND:${err.code}` : 'SIM_FAILURE';
        break;
      }
    }

    if (accepted.length === 0) {
      return { ok: false, kind: 'rejected', reason: rejectReason ?? 'SIM_FAILURE', snapshot: snap };
    }

    const fullyApplied = rejectedFrom === undefined;
    let divergence: boolean | null = null;

    if (fullyApplied && !this.soldSinceLastSync && req.clientHash !== undefined) {
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

    state = this.applyExternal(state, rules);

    const consumedTicks = state.tick - snap.state.tick;
    const alignedServerTs = snap.serverTs + consumedTicks * TICK_MS;

    let newVersion = snap.rulesetVersion;
    if (this.targetRulesetVersion !== snap.rulesetVersion) {
      try {
        state = migrateState(state, snap.rulesetVersion, this.targetRulesetVersion);
        newVersion = this.targetRulesetVersion;
      } catch (err) {
        if (!(err instanceof MigrationError)) throw err;
        this.migrationFailures.push({
          fromVersion: snap.rulesetVersion,
          toVersion: this.targetRulesetVersion,
          message: err.message,
        });
      }
    }

    if (req.deviceId !== undefined) {
      this.activeDevice = { id: req.deviceId, lastSyncMs: nowMs };
    }

    this.appliedLog.push(...accepted);
    this.trimLog();
    this.snapshot = {
      state,
      seq: accepted[accepted.length - 1]!.seq,
      serverTs: alignedServerTs,
      rulesetVersion: newVersion,
    };

    this.soldSinceLastSync = false;

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

import type { Command } from '../sim/commands.ts';
import { SimError } from '../sim/commands.ts';
import type { State } from '../sim/state.ts';
import type { Ruleset } from '../sim/rules.ts';
import { getRuleset } from '../sim/rules.ts';
import { advanceTo, simulate } from '../sim/sim.ts';
import { hashState } from '../sim/hash.ts';
import type { Snapshot, SyncRequest } from '../server/server.ts';

export type ActionResult = { ok: true } | { ok: false; code: string };

export const DISCARD_QUEUE = Infinity;

export class Client {
  state: State;
  baseSnapshot: Snapshot;
  baseSeq: number;
  rulesetVersion: number;
  queue: Command[] = [];
  localTick: number;
  deviceId: string | undefined;

  takeover = false;

  constructor(snapshot: Snapshot, deviceId?: string) {
    this.deviceId = deviceId;
    this.baseSnapshot = snapshot;
    this.state = snapshot.state;
    this.baseSeq = snapshot.seq;
    this.rulesetVersion = snapshot.rulesetVersion;
    this.localTick = snapshot.state.tick;
  }

  advanceClock(ticks: number): void {
    this.localTick += ticks;
  }

  preview(): State {
    return advanceTo(this.state, this.localTick, getRuleset(this.rulesetVersion));
  }

  private apply(partial: Omit<Command, 'seq' | 'tick'>): ActionResult {
    const cmd = {
      ...partial,
      seq: this.baseSeq + this.queue.length + 1,
      tick: this.localTick,
    } as Command;

    try {
      this.state = simulate(this.state, cmd, getRuleset(this.rulesetVersion));
    } catch (err) {
      if (err instanceof SimError) return { ok: false, code: err.code };
      throw err;
    }

    this.queue.push(cmd);
    return { ok: true };
  }

  rules(): Ruleset {
    return getRuleset(this.rulesetVersion);
  }

  start(plot: number, recipe: number, slot = 0): ActionResult {
    return this.apply({ type: 'START', plot, slot, recipe } as Omit<Command, 'seq' | 'tick'>);
  }

  collect(plot: number, slot = 0): ActionResult {
    return this.apply({ type: 'COLLECT', plot, slot } as Omit<Command, 'seq' | 'tick'>);
  }

  loadTruck(stack: number, amount: number): ActionResult {
    return this.apply({ type: 'LOAD_TRUCK', stack, amount } as Omit<Command, 'seq' | 'tick'>);
  }

  sendSlip(slot: number): ActionResult {
    return this.apply({ type: 'SEND_SLIP', slot } as Omit<Command, 'seq' | 'tick'>);
  }

  sendTruck(): ActionResult {
    return this.apply({ type: 'SEND_TRUCK' } as Omit<Command, 'seq' | 'tick'>);
  }

  openChest(chestId: number): ActionResult {
    return this.apply({ type: 'OPEN_CHEST', chestId } as Omit<Command, 'seq' | 'tick'>);
  }

  upgradeSilo(): ActionResult {
    return this.apply({ type: 'UPGRADE_SILO' } as Omit<Command, 'seq' | 'tick'>);
  }

  place(plot: number, gx: number, gy: number): ActionResult {
    return this.apply({ type: 'PLACE', plot, gx, gy } as Omit<Command, 'seq' | 'tick'>);
  }

  clearObstacle(index: number): ActionResult {
    return this.apply({ type: 'CLEAR_OBSTACLE', index } as Omit<Command, 'seq' | 'tick'>);
  }

  buy(plot: number): ActionResult {
    return this.apply({ type: 'BUY', plot } as Omit<Command, 'seq' | 'tick'>);
  }

  buyAnimal(plot: number): ActionResult {
    return this.apply({ type: 'BUY_ANIMAL', plot } as Omit<Command, 'seq' | 'tick'>);
  }

  sellNpc(item: number, amount: number): ActionResult {
    return this.apply({ type: 'SELL_NPC', item, amount } as Omit<Command, 'seq' | 'tick'>);
  }

  buyNpc(item: number, amount: number): ActionResult {
    return this.apply({ type: 'BUY_NPC', item, amount } as Omit<Command, 'seq' | 'tick'>);
  }

  listOrder(item: number, amount: number, price: number): ActionResult {
    return this.apply({ type: 'LIST_ORDER', item, amount, price } as Omit<Command, 'seq' | 'tick'>);
  }

  cancelOrder(orderId: number): ActionResult {
    return this.apply({ type: 'CANCEL_ORDER', orderId } as Omit<Command, 'seq' | 'tick'>);
  }

  buyOffer(offerId: number): ActionResult {
    return this.apply({ type: 'BUY_OFFER', offerId } as Omit<Command, 'seq' | 'tick'>);
  }

  collectMail(): ActionResult {
    return this.apply({ type: 'COLLECT_MAIL' } as Omit<Command, 'seq' | 'tick'>);
  }

  fillRequest(requestId: number): ActionResult {
    return this.apply({ type: 'FILL_REQUEST', requestId } as Omit<Command, 'seq' | 'tick'>);
  }

  skipRequest(requestId: number): ActionResult {
    return this.apply({ type: 'SKIP_REQUEST', requestId } as Omit<Command, 'seq' | 'tick'>);
  }

  neueZeitung = false;

  buildSyncRequest(): SyncRequest {
    return {
      baseSeq: this.baseSeq,
      rulesetVersion: this.rulesetVersion,
      commands: [...this.queue],
      clientHash: this.queue.length > 0 ? hashState(this.state) : undefined,
      deviceId: this.deviceId,
      takeover: this.takeover || undefined,
      neueZeitung: this.neueZeitung || undefined,
    };
  }

  adopt(snapshot: Snapshot, keepAfterSeq?: number): { kept: number; dropped: number } {
    if (keepAfterSeq === undefined && this.queue.length > 0) {
      throw new Error(
        `adopt() würde ${this.queue.length} nicht gesendete Aktion(en) verwerfen. ` +
          'Nach einem Sync übernimmt die Sync-Maschine bereits — hier ist nichts mehr zu tun. ' +
          'Soll wirklich verworfen werden, ausdrücklich adopt(snapshot, Infinity) aufrufen.',
      );
    }
    const boundary = keepAfterSeq ?? Infinity;
    const pending = this.queue.filter((c) => c.seq > boundary);

    this.baseSnapshot = snapshot;
    this.neueZeitung = false;
    this.state = snapshot.state;
    this.baseSeq = snapshot.seq;
    this.rulesetVersion = snapshot.rulesetVersion;
    this.localTick = snapshot.state.tick;
    this.queue = [];

    if (pending.length === 0) return { kept: 0, dropped: 0 };

    const rules = getRuleset(this.rulesetVersion);
    let dropped = 0;
    for (const cmd of pending) {
      const moved = {
        ...cmd,
        seq: this.baseSeq + this.queue.length + 1,
        tick: Math.max(cmd.tick, this.state.tick),
      } as Command;
      try {
        this.state = simulate(this.state, moved, rules);
        this.queue.push(moved);
        this.localTick = moved.tick;
      } catch {
        dropped++;
      }
    }
    return { kept: this.queue.length, dropped };
  }
}

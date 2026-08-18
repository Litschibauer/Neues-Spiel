export type NudgeKind =
  | 'market'
  | 'farm';

export type Sink = {
  write: (chunk: string) => boolean;
  close?: () => void;
};

type Subscriber = {
  accountId: string;
  sink: Sink;
  pending: Set<NudgeKind>;
  lastSentMs: number;
};

export type HubOptions = {
  minIntervalMs?: number;
  maxSubscribers?: number;
  now?: () => number;
};

export class EventHub {
  private subs = new Map<number, Subscriber>();
  private byAccount = new Map<string, Set<number>>();
  private nextId = 1;
  private readonly minIntervalMs: number;
  private readonly maxSubscribers: number;
  private readonly now: () => number;

  constructor(opts: HubOptions = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? 1000;
    this.maxSubscribers = opts.maxSubscribers ?? 2000;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.subs.size;
  }

  countFor(accountId: string): number {
    return this.byAccount.get(accountId)?.size ?? 0;
  }

  subscribe(accountId: string, sink: Sink): (() => void) | null {
    if (this.subs.size >= this.maxSubscribers) return null;

    const id = this.nextId++;
    this.subs.set(id, {
      accountId,
      sink,
      pending: new Set(),
      lastSentMs: this.now() - this.minIntervalMs,
    });
    let ids = this.byAccount.get(accountId);
    if (!ids) {
      ids = new Set();
      this.byAccount.set(accountId, ids);
    }
    ids.add(id);

    return () => this.drop(id);
  }

  nudge(accountId: string, kind: NudgeKind = 'farm'): void {
    for (const id of this.byAccount.get(accountId) ?? []) this.queue(id, kind);
  }

  broadcast(kind: NudgeKind, exceptAccountId?: string): void {
    for (const [id, sub] of this.subs) {
      if (exceptAccountId !== undefined && sub.accountId === exceptAccountId) continue;
      this.queue(id, kind);
    }
  }

  flush(): void {
    const now = this.now();
    for (const [id, sub] of this.subs) {
      if (sub.pending.size === 0) continue;
      if (now - sub.lastSentMs < this.minIntervalMs) continue;

      const kinds = [...sub.pending].sort().join(',');
      sub.pending.clear();
      sub.lastSentMs = now;
      if (!this.send(sub, 'nudge', kinds)) this.drop(id);
    }
  }

  heartbeat(): void {
    for (const [id, sub] of this.subs) {
      if (!sub.sink.write(': ping\n\n')) this.drop(id);
    }
  }

  closeAll(): void {
    for (const id of [...this.subs.keys()]) this.drop(id);
  }

  private queue(id: number, kind: NudgeKind): void {
    this.subs.get(id)?.pending.add(kind);
  }

  private send(sub: Subscriber, event: string, data: string): boolean {
    return sub.sink.write(`event: ${event}\ndata: ${data}\n\n`);
  }

  private drop(id: number): void {
    const sub = this.subs.get(id);
    if (!sub) return;
    this.subs.delete(id);
    const ids = this.byAccount.get(sub.accountId);
    if (ids) {
      ids.delete(id);
      if (ids.size === 0) this.byAccount.delete(sub.accountId);
    }
    sub.sink.close?.();
  }
}

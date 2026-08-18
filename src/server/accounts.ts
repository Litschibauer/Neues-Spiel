import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteStorage } from './storage.ts';
import type { AccountRecord, GameBlob, Storage } from './storage.ts';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const KEY_PREFIX = 'hof_';

export function generateKey(): string {
  const bytes = randomBytes(15);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];

  const groups: string[] = [];
  for (let i = 0; i < out.length; i += 6) groups.push(out.slice(i, i + 6));
  return KEY_PREFIX + groups.join('-');
}

export function normalizeKey(input: string): string {
  const body = input
    .trim()
    .replace(/^hof_/i, '')
    .replace(/[\s-]/g, '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return KEY_PREFIX + body;
}

function hashKey(key: string): string {
  return createHash('sha256').update(normalizeKey(key), 'utf8').digest('hex');
}

export type { AccountRecord, GameBlob } from './storage.ts';

export type AccountFile = GameBlob & { version: 1; account: AccountRecord };

export class AccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountError';
  }
}

export class AccountStore {
  private readonly store: Storage;
  private readonly byId = new Map<string, AccountRecord>();
  private readonly byKeyHash = new Map<string, string>();

  private readonly dirty = new Map<string, GameBlob>();

  constructor(where: Storage | string, legacyDir?: string) {
    this.store = typeof where === 'string' ? new SqliteStorage(where) : where;
    if (legacyDir && existsSync(legacyDir)) this.importLegacy(legacyDir);

    for (const account of this.store.listAccounts()) {
      this.byId.set(account.id, account);
      this.byKeyHash.set(account.keyHash, account.id);
    }
  }

  private importLegacy(dir: string): void {
    const files = readdirSync(dir).filter((n) => n.endsWith('.json'));
    if (files.length === 0) return;

    const batch: Array<{ account: AccountRecord; game: GameBlob }> = [];
    for (const name of files) {
      try {
        const file = JSON.parse(readFileSync(join(dir, name), 'utf8')) as AccountFile;
        if (file.version !== 1 || !file.account) continue;
        const { version, account, ...game } = file;
        batch.push({ account, game });
      } catch {
        console.error(`Account-Datei unlesbar, übersprungen: ${name}`);
      }
    }
    this.store.putFarms(batch);

    try {
      renameSync(dir, `${dir}.uebernommen`);
    } catch {
    }
    console.log(`${batch.length} Höfe aus Einzeldateien übernommen → Datenbank.`);
  }

  get count(): number {
    return this.byId.size;
  }

  get pendingWrites(): number {
    return this.dirty.size;
  }

  get storage(): Storage {
    return this.store;
  }

  list(): AccountRecord[] {
    return [...this.byId.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): AccountRecord | null {
    return this.byId.get(id) ?? null;
  }

  resolve(key: string): AccountRecord | null {
    if (!key) return null;
    const hash = hashKey(key);
    const id = this.byKeyHash.get(hash);
    if (!id) return null;
    const account = this.byId.get(id);
    if (!account) return null;

    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(account.keyHash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return account;
  }

  create(now: number, initial: GameBlob): { account: AccountRecord; key: string } {
    let key = generateKey();

    while (this.byKeyHash.has(hashKey(key))) key = generateKey();

    const account: AccountRecord = {
      id: `a${randomBytes(8).toString('hex')}`,
      keyHash: hashKey(key),
      createdAt: now,
      lastSeenMs: now,
    };

    this.byId.set(account.id, account);
    this.byKeyHash.set(account.keyHash, account.id);
    this.store.putFarms([{ account, game: initial }]);
    return { account, key };
  }

  load(id: string): AccountFile | null {
    const account = this.byId.get(id);
    if (!account) return null;

    const pending = this.dirty.get(id);
    if (pending) return { version: 1, account, ...pending };

    const game = this.store.loadFarm(id);
    return game ? { version: 1, account, ...game } : null;
  }

  save(account: AccountRecord, game: GameBlob): void {
    this.byId.set(account.id, account);
    this.byKeyHash.set(account.keyHash, account.id);
    this.dirty.set(account.id, game);
  }

  flush(): number {
    if (this.dirty.size === 0) return 0;
    const batch: Array<{ account: AccountRecord; game: GameBlob }> = [];
    for (const [id, game] of this.dirty) {
      const account = this.byId.get(id);
      if (account) batch.push({ account, game });
    }
    this.store.putFarms(batch);
    this.dirty.clear();
    return batch.length;
  }

  adopt(account: AccountRecord, game: GameBlob): void {
    this.byId.set(account.id, account);
    this.byKeyHash.set(account.keyHash, account.id);
    this.store.putFarms([{ account, game }]);
  }

  close(): void {
    this.flush();
    this.store.close();
  }
}

export function keyHashOf(key: string): string {
  return hashKey(key);
}

export class CreateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly perHour: number;
  private readonly totalCap: number;

  constructor(perHour: number, totalCap: number) {
    this.perHour = perHour;
    this.totalCap = totalCap;
  }

  allow(origin: string, nowMs: number, existing: number): { ok: true } | { ok: false; reason: string } {
    if (existing >= this.totalCap) return { ok: false, reason: 'SERVER_FULL' };

    const hourAgo = nowMs - 3_600_000;
    const recent = (this.hits.get(origin) ?? []).filter((t) => t > hourAgo);
    if (recent.length >= this.perHour) return { ok: false, reason: 'TOO_MANY_NEW_FARMS' };

    recent.push(nowMs);
    this.hits.set(origin, recent);
    return { ok: true };
  }
}

/**
 * Accounts — bewusst so einfach wie möglich.
 *
 * Ein Account ist **ein langer Zufallsschlüssel**, den der Server einmal
 * ausgibt. Kein Benutzername, kein Passwort, keine E-Mail.
 *
 *     hof_7K2M9-QXP4T-RB6NH-2WFDG-8YSVC
 *
 * ── Warum nicht Benutzername und Passwort ───────────────────────────────────
 *
 * Weil daran ein ganzer Rattenschwanz hängt, der mit dem Spiel nichts zu tun
 * hat: Passwörter richtig hashen, Registrierung, „Passwort vergessen", also
 * E-Mail-Versand, also Bounce-Handling, also Missbrauchsschutz. Jedes Stück
 * davon ist eine eigene Baustelle mit eigenen Sicherheitsfehlern.
 *
 * Ein 128-Bit-Zufallsschlüssel erledigt dieselbe Aufgabe — „bist du derselbe
 * wie beim letzten Mal" — ohne davon irgendetwas zu brauchen. Er lässt sich
 * nicht erraten, er lässt sich nicht wiederverwenden, und er kann nirgendwo
 * schwach gewählt werden.
 *
 * ── Der Preis, klar gesagt ──────────────────────────────────────────────────
 *
 * **Schlüssel weg heißt Hof weg.** Es gibt keine Wiederherstellung, weil es
 * nichts gibt, worüber man wiederherstellen könnte. Das ist für den Anfang
 * vertretbar und muss vor der ersten echten Spielerschaft gelöst werden — dann
 * aber bewusst, mit einem zweiten Faktor, nicht nebenbei.
 *
 * ── Speicherform ────────────────────────────────────────────────────────────
 *
 * Eine Datei pro Account. Nicht eine große: Sonst schriebe jeder Sync
 * irgendeines Spielers die Datei aller anderen neu — und ein abgebrochener
 * Schreibvorgang beträfe alle statt einen. Beim Start liest der Server das
 * Verzeichnis einmal ein und baut den Index im Speicher auf.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from '../sim/commands.ts';
import type { MailItem } from '../sim/state.ts';
import type { Snapshot } from './server.ts';

/**
 * Crockford-Base32: ohne I, L, O und U.
 *
 * Der Schlüssel wird abgeschrieben und abgetippt — von Zetteln, aus
 * Screenshots. Buchstaben, die wie Ziffern aussehen, sind dabei die häufigste
 * Fehlerquelle, und `U` fliegt raus, damit versehentlich keine Wörter entstehen.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const KEY_PREFIX = 'hof_';

/**
 * Ein neuer Schlüssel: 120 Bit, in vier Sechsergruppen zum Abschreiben.
 *
 * 15 Bytes ergeben genau 24 Base32-Zeichen — vier saubere Gruppen ohne
 * Restsilbe. Vom Erraten sind 120 Bit genauso weit entfernt wie 128.
 */
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

/**
 * Schreibfehler ausbügeln, bevor verglichen wird.
 *
 * Wer den Schlüssel von einem Zettel abtippt, macht genau diese Fehler:
 * Kleinbuchstaben, fehlende Bindestriche, O statt 0, I oder l statt 1.
 * Ein Account, den man wegen eines O nicht mehr aufmacht, wäre eine
 * vermeidbare Grausamkeit.
 */
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

export type AccountRecord = {
  id: string;
  /**
   * Nur der Hash liegt auf der Platte.
   *
   * Ein Backup, ein versehentlich geteiltes Verzeichnis, ein neugieriger
   * Blick in die Dateien — nichts davon soll fremde Höfe aufmachen können.
   */
  keyHash: string;
  createdAt: number;
  lastSeenMs: number;
};

/** Was von einem Account auf der Platte liegt: Kennung plus Spielstand. */
export type AccountFile = {
  version: 1;
  account: AccountRecord;
  snapshot: Snapshot;
  appliedLog: Command[];
  pendingDeliveries: MailItem[];
  targetRulesetVersion: number;
  nextRequestId: number;
};

export class AccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountError';
  }
}

function writeAtomic(path: string, data: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, path);
}

/**
 * Der Index über alle Accounts.
 *
 * Hält nur Kennungen im Speicher, keine Spielstände — die lädt der Aufrufer
 * bei Bedarf. Bei ein paar hundert Höfen ist das gemütlich; bei
 * Zehntausenden gehört an diese Stelle eine Datenbank, und das steht in der
 * Roadmap.
 */
export class AccountStore {
  private readonly dir: string;
  private readonly byId = new Map<string, AccountRecord>();
  private readonly byKeyHash = new Map<string, string>();

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const file = JSON.parse(readFileSync(join(dir, name), 'utf8')) as AccountFile;
        if (file.version !== 1 || !file.account) continue;
        this.byId.set(file.account.id, file.account);
        this.byKeyHash.set(file.account.keyHash, file.account.id);
      } catch {
        // Eine kaputte Datei darf nicht den ganzen Server am Start hindern —
        // sie kostet einen Hof, nicht alle.
        console.error(`Account-Datei unlesbar, übersprungen: ${name}`);
      }
    }
  }

  get count(): number {
    return this.byId.size;
  }

  list(): AccountRecord[] {
    return [...this.byId.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): AccountRecord | null {
    return this.byId.get(id) ?? null;
  }

  /**
   * Schlüssel zu Account auflösen.
   *
   * Der Vergleich läuft über den Hash und eine Map — es gibt also keinen
   * Zeichen-für-Zeichen-Vergleich, aus dessen Laufzeit sich etwas ablesen
   * ließe. Der abschließende `timingSafeEqual` ist trotzdem drin: Er kostet
   * nichts und macht die Absicht explizit.
   */
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

  /**
   * Neuen Hof anlegen. Der Schlüssel wird **genau einmal** zurückgegeben —
   * danach kennt der Server nur noch seinen Hash.
   */
  create(now: number, initial: Omit<AccountFile, 'version' | 'account'>): {
    account: AccountRecord;
    key: string;
  } {
    let key = generateKey();
    // Praktisch unmöglich bei 128 Bit, aber eine Kollision würde zwei Spieler
    // in denselben Hof setzen — das ist die Zeile wert.
    while (this.byKeyHash.has(hashKey(key))) key = generateKey();

    const account: AccountRecord = {
      id: `a${randomBytes(8).toString('hex')}`,
      keyHash: hashKey(key),
      createdAt: now,
      lastSeenMs: now,
    };

    this.byId.set(account.id, account);
    this.byKeyHash.set(account.keyHash, account.id);
    this.save(account, initial);
    return { account, key };
  }

  /** Spielstand eines Accounts laden. */
  load(id: string): AccountFile | null {
    const path = this.pathFor(id);
    if (!existsSync(path)) return null;
    const file = JSON.parse(readFileSync(path, 'utf8')) as AccountFile;
    if (file.version !== 1) throw new AccountError(`unbekannte Account-Version: ${file.version}`);
    return file;
  }

  /** Spielstand schreiben — atomar, wie überall (siehe store.ts). */
  save(account: AccountRecord, game: Omit<AccountFile, 'version' | 'account'>): void {
    this.byId.set(account.id, account);
    this.byKeyHash.set(account.keyHash, account.id);
    writeAtomic(this.pathFor(account.id), { version: 1, account, ...game } satisfies AccountFile);
  }

  /** Übernimmt einen Account samt Schlüssel-Hash — für den Import alter Stände. */
  adopt(account: AccountRecord, game: Omit<AccountFile, 'version' | 'account'>): void {
    this.save(account, game);
  }
}

/** Hash zu einem bekannten Schlüssel — nur für Import und Tests. */
export function keyHashOf(key: string): string {
  return hashKey(key);
}

/**
 * Ganz einfache Missbrauchsbremse fürs Anlegen (R4).
 *
 * Ohne sie kann jemand in einer Minute zehntausend Höfe erzeugen und die
 * Platte füllen. Der Zähler steht im Speicher: Ein Neustart setzt ihn zurück,
 * was für den Anfang reicht — es geht um Versehen und Skriptkiddies, nicht um
 * einen entschlossenen Angreifer.
 */
export class CreateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly perHour: number;
  private readonly totalCap: number;

  constructor(perHour: number, totalCap: number) {
    this.perHour = perHour;
    this.totalCap = totalCap;
  }

  /** Darf von dieser Herkunft gerade ein Hof angelegt werden? */
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

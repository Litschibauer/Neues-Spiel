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
 * Eine SQLite-Datei (siehe `db.ts`), eine Zeile je Hof. Vorher war es eine
 * JSON-Datei je Hof — lesbar und ohne Installation, aber nicht tragfähig:
 * Jeder Sync schrieb eine ganze Datei, und bei ein paar tausend gleichzeitigen
 * Spielern sind das Tausende kleiner Schreibvorgänge in Sekunden.
 *
 * Alte Verzeichnisse werden beim Start einmalig übernommen. Niemand soll seinen
 * Hof verlieren, weil sich der Speicher darunter geändert hat.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, transaction } from './db.ts';
import type { Db } from './db.ts';
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
  /**
   * seq des ersten Eintrags in `appliedLog`.
   *
   * Fehlt sie, stammt der Stand aus der Zeit vor dem Log-Fenster: Dann steht
   * der ganze Log in der Datei und beginnt folglich bei 1.
   */
  logStartSeq?: number;
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

/** Der Spielstand, wie er in der Zeile steht. */
type GameBlob = Omit<AccountFile, 'version' | 'account'>;

/**
 * Der Index über alle Accounts.
 *
 * Hält Kennungen im Speicher (ein paar hundert Byte je Hof) und die
 * Spielstände in der Datenbank. Bei zehntausend Höfen sind das wenige Megabyte
 * Index — das trägt ein Blech.
 *
 * ── Gesammelt schreiben ─────────────────────────────────────────────────────
 *
 * `save` schreibt NICHT sofort, sondern merkt sich den Hof als geändert.
 * `flush` schreibt dann alle gemerkten in EINER Transaktion. Das ist der
 * eigentliche Gewinn gegenüber Dateien: Zweitausend geänderte Spielstände
 * kosten einen Schreibvorgang statt zweitausend.
 *
 * Der Preis ist ein Zeitfenster, in dem eine Änderung nur im Speicher steht.
 * Deshalb ruft der Server `flush` in kurzem Takt und beim Beenden auf — und
 * deshalb ist das Fenster in Sekunden gemessen und nicht in Minuten.
 */
export class AccountStore {
  private readonly db: Db;
  private readonly byId = new Map<string, AccountRecord>();
  private readonly byKeyHash = new Map<string, string>();
  /** Geänderte Höfe samt ihrem Stand, bis zum nächsten `flush`. */
  private readonly dirty = new Map<string, GameBlob>();

  /**
   * `dirOrDbPath` ist der Pfad zur Datenbank. Zeigt daneben noch ein altes
   * Account-Verzeichnis, wird es einmalig übernommen.
   */
  constructor(dbPath: string, legacyDir?: string) {
    this.db = openDb(dbPath);
    if (legacyDir && existsSync(legacyDir)) this.importLegacy(legacyDir);

    for (const row of this.db.prepare('select id, key_hash, created_at, last_seen_ms from accounts').all() as Array<{
      id: string;
      key_hash: string;
      created_at: number;
      last_seen_ms: number;
    }>) {
      const account: AccountRecord = {
        id: row.id,
        keyHash: row.key_hash,
        createdAt: row.created_at,
        lastSeenMs: row.last_seen_ms,
      };
      this.byId.set(account.id, account);
      this.byKeyHash.set(account.keyHash, account.id);
    }
  }

  /**
   * Alte Ein-Datei-je-Hof-Stände übernehmen. Läuft genau einmal.
   *
   * Das Verzeichnis wird danach umbenannt, nicht gelöscht: Falls beim Umzug
   * etwas schiefgeht, ist der alte Stand noch da. Löschen darf der Betreiber.
   */
  private importLegacy(dir: string): void {
    const files = readdirSync(dir).filter((n) => n.endsWith('.json'));
    if (files.length === 0) return;

    let imported = 0;
    transaction(this.db, () => {
      for (const name of files) {
        try {
          const file = JSON.parse(readFileSync(join(dir, name), 'utf8')) as AccountFile;
          if (file.version !== 1 || !file.account) continue;
          const { version, account, ...game } = file;
          this.writeRow(account, game);
          imported++;
        } catch {
          // Eine kaputte Datei kostet einen Hof, nicht den Umzug.
          console.error(`Account-Datei unlesbar, übersprungen: ${name}`);
        }
      }
    });

    try {
      renameSync(dir, `${dir}.uebernommen`);
    } catch {
      /* Umbenennen ist Komfort, kein Muss. */
    }
    console.log(`${imported} Höfe aus Einzeldateien übernommen → Datenbank.`);
  }

  private writeRow(account: AccountRecord, game: GameBlob): void {
    this.db
      .prepare(
        `insert into accounts (id, key_hash, created_at, last_seen_ms, game)
         values (?, ?, ?, ?, ?)
         on conflict(id) do update set
           key_hash = excluded.key_hash,
           last_seen_ms = excluded.last_seen_ms,
           game = excluded.game`,
      )
      .run(account.id, account.keyHash, account.createdAt, account.lastSeenMs, JSON.stringify(game));
  }

  get count(): number {
    return this.byId.size;
  }

  /** Wie viele Höfe gerade auf das Schreiben warten — Kennzahl fürs Monitoring. */
  get pendingWrites(): number {
    return this.dirty.size;
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
   *
   * Wird sofort geschrieben, nicht gesammelt: Ein Hof, den es nach einem
   * Neustart nicht mehr gibt, wäre ein verlorener Schlüssel.
   */
  create(now: number, initial: GameBlob): { account: AccountRecord; key: string } {
    let key = generateKey();
    // Praktisch unmöglich bei 120 Bit, aber eine Kollision würde zwei Spieler
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
    transaction(this.db, () => this.writeRow(account, initial));
    return { account, key };
  }

  /** Spielstand laden. Ungeschriebene Änderungen gewinnen — sie sind neuer. */
  load(id: string): AccountFile | null {
    const account = this.byId.get(id);
    if (!account) return null;

    const pending = this.dirty.get(id);
    if (pending) return { version: 1, account, ...pending };

    const row = this.db.prepare('select game from accounts where id = ?').get(id) as
      | { game?: string }
      | undefined;
    if (!row?.game) return null;
    return { version: 1, account, ...(JSON.parse(row.game) as GameBlob) };
  }

  /** Merken, nicht schreiben. Geschrieben wird gesammelt in `flush`. */
  save(account: AccountRecord, game: GameBlob): void {
    this.byId.set(account.id, account);
    this.byKeyHash.set(account.keyHash, account.id);
    this.dirty.set(account.id, game);
  }

  /**
   * Alles Gemerkte in einer Transaktion schreiben. Gibt zurück, wie viele.
   *
   * Schlägt das Schreiben fehl, bleiben die Änderungen gemerkt: Beim nächsten
   * Versuch geht es weiter, statt sie zu verlieren.
   */
  flush(): number {
    if (this.dirty.size === 0) return 0;
    const batch = [...this.dirty.entries()];
    transaction(this.db, () => {
      for (const [id, game] of batch) {
        const account = this.byId.get(id);
        if (account) this.writeRow(account, game);
      }
    });
    for (const [id] of batch) this.dirty.delete(id);
    return batch.length;
  }

  /** Übernimmt einen Account samt Schlüssel-Hash — für den Import alter Stände. */
  adopt(account: AccountRecord, game: GameBlob): void {
    this.byId.set(account.id, account);
    this.byKeyHash.set(account.keyHash, account.id);
    transaction(this.db, () => this.writeRow(account, game));
  }

  /** Zugriff auf die Datenbank, damit der Markt dieselbe Datei benutzt. */
  get database(): Db {
    return this.db;
  }

  close(): void {
    this.flush();
    this.db.close();
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

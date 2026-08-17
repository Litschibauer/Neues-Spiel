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
import { SqliteStorage } from './storage.ts';
import type { AccountRecord, GameBlob, Storage } from './storage.ts';

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

export type { AccountRecord, GameBlob } from './storage.ts';

/** Was von einem Account auf der Platte liegt: Kennung plus Spielstand. */
export type AccountFile = GameBlob & { version: 1; account: AccountRecord };

export class AccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountError';
  }
}

/**
 * Der Index über alle Accounts.
 *
 * Hält Kennungen im Speicher (ein paar hundert Byte je Hof) und die
 * Spielstände im `Storage`. Welcher Speicher das ist — SQLite, später etwas
 * anderes — weiß diese Klasse nicht und soll es nicht wissen; sie redet
 * ausschließlich über die Schnittstelle aus `storage.ts`.
 *
 * ── Gesammelt schreiben ─────────────────────────────────────────────────────
 *
 * `save` schreibt NICHT sofort, sondern merkt sich den Hof als geändert.
 * `flush` gibt dann alle gemerkten in EINEM Aufruf an den Speicher. Das ist
 * der eigentliche Gewinn: Zweitausend geänderte Spielstände kosten einen
 * Schreibvorgang statt zweitausend.
 *
 * Der Preis ist ein Zeitfenster, in dem eine Änderung nur im Speicher steht.
 * Deshalb ruft der Server `flush` in kurzem Takt und beim Beenden auf — und
 * deshalb ist das Fenster in Sekunden gemessen und nicht in Minuten.
 */
export class AccountStore {
  private readonly store: Storage;
  private readonly byId = new Map<string, AccountRecord>();
  private readonly byKeyHash = new Map<string, string>();
  /** Geänderte Höfe samt ihrem Stand, bis zum nächsten `flush`. */
  private readonly dirty = new Map<string, GameBlob>();

  /**
   * `where` ist entweder ein fertiger Speicher oder ein Pfad (dann SQLite).
   * Zeigt daneben noch ein altes Account-Verzeichnis, wird es einmalig
   * übernommen.
   */
  constructor(where: Storage | string, legacyDir?: string) {
    this.store = typeof where === 'string' ? new SqliteStorage(where) : where;
    if (legacyDir && existsSync(legacyDir)) this.importLegacy(legacyDir);

    for (const account of this.store.listAccounts()) {
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

    const batch: Array<{ account: AccountRecord; game: GameBlob }> = [];
    for (const name of files) {
      try {
        const file = JSON.parse(readFileSync(join(dir, name), 'utf8')) as AccountFile;
        if (file.version !== 1 || !file.account) continue;
        const { version, account, ...game } = file;
        batch.push({ account, game });
      } catch {
        // Eine kaputte Datei kostet einen Hof, nicht den Umzug.
        console.error(`Account-Datei unlesbar, übersprungen: ${name}`);
      }
    }
    this.store.putFarms(batch);

    try {
      renameSync(dir, `${dir}.uebernommen`);
    } catch {
      /* Umbenennen ist Komfort, kein Muss. */
    }
    console.log(`${batch.length} Höfe aus Einzeldateien übernommen → Datenbank.`);
  }

  get count(): number {
    return this.byId.size;
  }

  /** Wie viele Höfe gerade auf das Schreiben warten — Kennzahl fürs Monitoring. */
  get pendingWrites(): number {
    return this.dirty.size;
  }

  /** Der Speicher darunter — der Markt benutzt denselben. */
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
    this.store.putFarms([{ account, game: initial }]);
    return { account, key };
  }

  /** Spielstand laden. Ungeschriebene Änderungen gewinnen — sie sind neuer. */
  load(id: string): AccountFile | null {
    const account = this.byId.get(id);
    if (!account) return null;

    const pending = this.dirty.get(id);
    if (pending) return { version: 1, account, ...pending };

    const game = this.store.loadFarm(id);
    return game ? { version: 1, account, ...game } : null;
  }

  /** Merken, nicht schreiben. Geschrieben wird gesammelt in `flush`. */
  save(account: AccountRecord, game: GameBlob): void {
    this.byId.set(account.id, account);
    this.byKeyHash.set(account.keyHash, account.id);
    this.dirty.set(account.id, game);
  }

  /**
   * Alles Gemerkte in einem Aufruf schreiben. Gibt zurück, wie viele.
   *
   * Schlägt das Schreiben fehl, bleiben die Änderungen gemerkt: Beim nächsten
   * Versuch geht es weiter, statt sie zu verlieren.
   */
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

  /** Übernimmt einen Account samt Schlüssel-Hash — für den Import alter Stände. */
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

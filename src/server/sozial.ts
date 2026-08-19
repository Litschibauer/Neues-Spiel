import type { Db } from './db.ts';

export const CODE_ALPHABET = 'ACDEFGHJKLMNPQRSTUVWXY3456789';
export const CODE_LENGTH = 6;

const ERST = [
  'Sonnen', 'Linden', 'Birken', 'Eichen', 'Rosen', 'Auen', 'Berg', 'Tal',
  'Wiesen', 'Bach', 'Stein', 'Hasel', 'Kirsch', 'Ahorn', 'Weiden', 'Erlen',
];
const ZWEIT = ['hof', 'gut', 'feld', 'garten', 'wiese', 'kamp', 'acker', 'weide'];

export const NAME_MAX = 24;

export function nameAusCode(code: string): string {
  let h = 2166136261;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const n = h >>> 0;
  return ERST[n % ERST.length]! + ZWEIT[Math.floor(n / ERST.length) % ZWEIT.length]!;
}

export function saubererName(roh: string): string | null {
  const name = roh.replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > NAME_MAX) return null;
  if (!/^[\p{L}\p{N} .'’-]+$/u.test(name)) return null;
  return name;
}

export function tagVon(nowMs: number): number {
  return Math.floor(nowMs / 86_400_000);
}

export type HofKarte = {
  id: string;
  code: string;
  name: string;
};

export class Sozial {
  private readonly db: Db;
  private readonly rnd: () => number;

  constructor(db: Db, rnd: () => number = Math.random) {
    this.db = db;
    this.rnd = rnd;
  }

  private wuerfelCode(): string {
    let out = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      out += CODE_ALPHABET[Math.floor(this.rnd() * CODE_ALPHABET.length)];
    }
    return out;
  }

  karte(id: string): HofKarte | null {
    const row = this.db.prepare('select id, code, hofname from accounts where id = ?').get(id) as
      | { id: string; code: string | null; hofname: string | null }
      | undefined;
    if (!row) return null;

    let code = row.code;
    if (!code) {
      for (let versuch = 0; versuch < 40 && !code; versuch++) {
        const kandidat = this.wuerfelCode();
        const belegt = this.db
          .prepare('select 1 from accounts where code = ?')
          .get(kandidat) as unknown;
        if (belegt) continue;
        this.db.prepare('update accounts set code = ? where id = ?').run(kandidat, id);
        code = kandidat;
      }
      if (!code) throw new Error('kein freier Hofcode zu finden');
    }

    return { id, code, name: row.hofname ?? nameAusCode(code) };
  }

  perCode(code: string): HofKarte | null {
    const row = this.db
      .prepare('select id, code, hofname from accounts where code = ?')
      .get(code.toUpperCase()) as
      | { id: string; code: string; hofname: string | null }
      | undefined;
    if (!row) return null;
    return { id: row.id, code: row.code, name: row.hofname ?? nameAusCode(row.code) };
  }

  benenne(id: string, name: string): boolean {
    const sauber = saubererName(name);
    if (!sauber) return false;
    this.db.prepare('update accounts set hofname = ? where id = ?').run(sauber, id);
    return true;
  }

  freunde(wer: string): HofKarte[] {
    const rows = this.db
      .prepare("select freund from freunde where wer = ? and stand = 'ok' order by seit_ms")
      .all(wer) as Array<{ freund: string }>;
    return rows.flatMap((r) => {
      const karte = this.karte(r.freund);
      return karte ? [karte] : [];
    });
  }

  anfragenAn(wer: string): HofKarte[] {
    const rows = this.db
      .prepare("select wer from freunde where freund = ? and stand = 'offen' order by seit_ms")
      .all(wer) as Array<{ wer: string }>;
    return rows.flatMap((r) => {
      const karte = this.karte(r.wer);
      return karte ? [karte] : [];
    });
  }

  anfragenVon(wer: string): HofKarte[] {
    const rows = this.db
      .prepare("select freund from freunde where wer = ? and stand = 'offen' order by seit_ms")
      .all(wer) as Array<{ freund: string }>;
    return rows.flatMap((r) => {
      const karte = this.karte(r.freund);
      return karte ? [karte] : [];
    });
  }

  beziehung(wer: string, andere: string): 'keine' | 'gefragt' | 'wartet' | 'freund' {
    const hin = this.db
      .prepare('select stand from freunde where wer = ? and freund = ?')
      .get(wer, andere) as { stand: string } | undefined;
    if (hin?.stand === 'ok') return 'freund';
    if (hin?.stand === 'offen') return 'gefragt';

    const her = this.db
      .prepare('select stand from freunde where wer = ? and freund = ?')
      .get(andere, wer) as { stand: string } | undefined;
    if (her?.stand === 'offen') return 'wartet';
    return 'keine';
  }

  istFreund(wer: string, freund: string): boolean {
    return this.beziehung(wer, freund) === 'freund';
  }

  frage(wer: string, andere: string, nowMs: number): 'gefragt' | 'freund' | 'nein' {
    if (wer === andere) return 'nein';
    const stand = this.beziehung(wer, andere);
    if (stand === 'freund') return 'freund';

    if (stand === 'wartet') {
      this.db
        .prepare("update freunde set stand = 'ok' where wer = ? and freund = ?")
        .run(andere, wer);
      this.db
        .prepare(
          "insert into freunde (wer, freund, seit_ms, stand) values (?, ?, ?, 'ok') " +
            "on conflict (wer, freund) do update set stand = 'ok'",
        )
        .run(wer, andere, nowMs);
      return 'freund';
    }

    this.db
      .prepare(
        "insert into freunde (wer, freund, seit_ms, stand) values (?, ?, ?, 'offen') " +
          'on conflict (wer, freund) do nothing',
      )
      .run(wer, andere, nowMs);
    return 'gefragt';
  }

  vergiss(wer: string, andere: string): void {
    this.db.prepare('delete from freunde where wer = ? and freund = ?').run(wer, andere);
    this.db.prepare('delete from freunde where wer = ? and freund = ?').run(andere, wer);
  }

  hilfenHeute(helfer: string, hof: string, nowMs: number): number {
    const row = this.db
      .prepare('select wie from hilfen where helfer = ? and hof = ? and tag = ?')
      .get(helfer, hof, tagVon(nowMs)) as { wie: number } | undefined;
    return row ? row.wie : 0;
  }

  zaehleHilfe(helfer: string, hof: string, nowMs: number): number {
    const tag = tagVon(nowMs);
    this.db
      .prepare(
        'insert into hilfen (helfer, hof, tag, wie) values (?, ?, ?, 1) ' +
          'on conflict (helfer, hof, tag) do update set wie = wie + 1',
      )
      .run(helfer, hof, tag);
    return this.hilfenHeute(helfer, hof, nowMs);
  }

  raeumeAuf(nowMs: number): number {
    const alt = tagVon(nowMs) - 2;
    const res = this.db.prepare('delete from hilfen where tag < ?').run(alt);
    return Number(res.changes ?? 0);
  }

  vergissHof(id: string): void {
    this.db.prepare('delete from freunde where wer = ? or freund = ?').run(id, id);
    this.db.prepare('delete from hilfen where helfer = ? or hof = ?').run(id, id);
  }
}

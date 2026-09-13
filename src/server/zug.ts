import type { Db } from './db.ts';
import { mengeFuer, type Bedarf, type Helfer, type Messung } from './dorf.ts';
import { wocheVonTag } from '../sim/state.ts';
import { tagVon } from './sozial.ts';

// Der Zug: Steht der Bahnhof, kommt jede Serverwoche ein Zug mit einer
// Bestellung aus anderen Dörfern — vier Waren, die der ganze Server zusammen
// einlädt. Ist alles drin, fährt er ab, und jeder Helfer bekommt Dank als
// Post. Sonntag um Mitternacht fährt er so oder so; was fehlt, fehlt.
//
// Wie das Dorf: Sache des Servers, Abzug als äußere Änderung, Dank als Post.
// Die Bestellung kommt aus der Wochennummer (gleiche Woche, gleiche Waren),
// die Mengen aus der Messung beim ersten Blick in der Woche.

export const ZUG_WAREN: readonly Bedarf[] = [
  { item: 'bread', menge: 12 }, { item: 'cheese', menge: 8 }, { item: 'butter', menge: 8 },
  { item: 'apple-pie', menge: 5 }, { item: 'smoked-fish', menge: 6 }, { item: 'sweater', menge: 3 },
  { item: 'carrot-cake', menge: 5 }, { item: 'cream-cake', menge: 4 }, { item: 'apple-juice', menge: 8 },
  { item: 'carrot-juice', menge: 8 }, { item: 'syrup', menge: 6 }, { item: 'farm-platter', menge: 4 },
  { item: 'iron-bar', menge: 6 }, { item: 'gold-bar', menge: 2 }, { item: 'yarn', menge: 6 },
  { item: 'eggs', menge: 20 }, { item: 'milk', menge: 16 }, { item: 'flour', menge: 16 },
  { item: 'sugar', menge: 10 }, { item: 'wool', menge: 10 },
];
export const ZUG_WAREN_JE_FAHRT = 4;
export const ZUG_DANK: readonly Bedarf[] = [
  { item: 'map', menge: 1 },
  { item: 'booster-wuchs', menge: 1 },
  { item: 'gold', menge: 300 },
];

export function zugWoche(nowMs: number): number {
  return wocheVonTag(tagVon(nowMs));
}

// Die Woche w umfasst die Tage 7w−3 … 7w+3 (Montag bis Sonntag). Abfahrt ist
// der Beginn des nächsten Montags.
export function zugAbfahrtMs(woche: number): number {
  return (7 * woche + 4) * 86_400_000;
}

// Vier Waren je Woche, aus der Wochennummer gezogen — überall dieselben.
export function zugBestellung(woche: number, vorrat: (item: string) => number): Bedarf[] {
  const rest = ZUG_WAREN.slice();
  const wahl: Bedarf[] = [];
  let h = (woche * 2654435761 + 12345) >>> 0;
  for (let k = 0; k < ZUG_WAREN_JE_FAHRT && rest.length > 0; k++) {
    h = (Math.imul(h ^ (h >>> 15), 2246822519) + k) >>> 0;
    const i = h % rest.length;
    const w = rest.splice(i, 1)[0]!;
    wahl.push({ item: w.item, menge: mengeFuer(w.menge, vorrat(w.item)) });
  }
  return wahl;
}

type Zeile = { nr: number; woche: number; plan: Bedarf[]; fertigMs: number };

export type ZugStand = {
  woche: number;
  abfahrtMs: number;
  bestellung: Array<{ item: string; menge: number; geliefert: number }>;
  fertig: boolean;
  fertigMs: number;
  dank: readonly Bedarf[];
  helfer: Helfer[];
  mein: number;
};

export type ZugBeitrag =
  | { ok: false; grund: 'NOT_NEEDED' }
  | { ok: true; nr: number; angenommen: number; fertig: boolean };

type Zwischen = { nr: number; version: number; geliefert: Map<string, number>; helfer: Helfer[] };

export class Zug {
  private readonly db: Db;
  private readonly messen: (nowMs: number) => Messung;
  private readonly bahnhofSteht: () => boolean;
  private version = 0;
  private zwischen: Zwischen | null = null;

  constructor(db: Db, messen: (nowMs: number) => Messung, bahnhofSteht: () => boolean) {
    this.db = db;
    this.messen = messen;
    this.bahnhofSteht = bahnhofSteht;
  }

  aktiv(): boolean {
    return this.bahnhofSteht();
  }

  private zeile(woche: number): Zeile | null {
    const row = this.db
      .prepare('select nr, woche, plan_json as roh, fertig_ms as fertigMs from zug_fahrten where woche = ?')
      .get(woche) as { nr: number; woche: number; roh: string; fertigMs: number } | undefined;
    if (!row) return null;
    let plan: Bedarf[] = [];
    try { plan = JSON.parse(row.roh) as Bedarf[]; } catch { plan = []; }
    return { nr: row.nr, woche: row.woche, plan, fertigMs: row.fertigMs };
  }

  // Der Zug dieser Woche — beim ersten Blick in der Woche wird die Bestellung
  // festgelegt, danach steht sie.
  laufend(nowMs: number): Zeile | null {
    if (!this.aktiv()) return null;
    const woche = zugWoche(nowMs);
    const da = this.zeile(woche);
    if (da) return da;
    const plan = zugBestellung(woche, this.messen(nowMs).vorrat);
    const res = this.db
      .prepare('insert into zug_fahrten (woche, plan_json, begonnen_ms, fertig_ms) values (?, ?, ?, 0)')
      .run(woche, JSON.stringify(plan), nowMs);
    this.version++;
    return { nr: Number(res.lastInsertRowid), woche, plan, fertigMs: 0 };
  }

  private gemerkt(nr: number): Zwischen {
    if (this.zwischen && this.zwischen.nr === nr && this.zwischen.version === this.version) return this.zwischen;
    const rows = this.db
      .prepare('select item, sum(menge) as menge from zug_beitraege where fahrt_nr = ? group by item')
      .all(nr) as Array<{ item: string; menge: number }>;
    const helfer = (this.db
      .prepare('select konto, sum(menge) as menge from zug_beitraege where fahrt_nr = ? group by konto order by menge desc, min(zeit_ms) asc')
      .all(nr) as Array<{ konto: string; menge: number }>).map((r) => ({ konto: r.konto, menge: Number(r.menge) }));
    this.zwischen = { nr, version: this.version, geliefert: new Map(rows.map((r) => [r.item, Number(r.menge)])), helfer };
    return this.zwischen;
  }

  helfer(nr: number): Helfer[] {
    return this.gemerkt(nr).helfer;
  }

  offen(item: string, nowMs: number): number {
    const z = this.laufend(nowMs);
    if (!z || z.fertigMs > 0) return 0;
    const b = z.plan.find((x) => x.item === item);
    if (!b) return 0;
    return Math.max(0, b.menge - (this.gemerkt(z.nr).geliefert.get(item) ?? 0));
  }

  beitrag(konto: string, item: string, menge: number, nowMs: number): ZugBeitrag {
    const angenommen = Math.min(this.offen(item, nowMs), Math.max(0, Math.floor(menge)));
    if (angenommen <= 0) return { ok: false, grund: 'NOT_NEEDED' };
    const z = this.laufend(nowMs)!;
    this.db
      .prepare('insert into zug_beitraege (fahrt_nr, konto, item, menge, zeit_ms) values (?, ?, ?, ?, ?)')
      .run(z.nr, konto, item, angenommen, nowMs);
    this.version++;
    const da = this.gemerkt(z.nr).geliefert;
    const fertig = z.plan.every((b) => (da.get(b.item) ?? 0) >= b.menge);
    if (fertig) {
      this.db.prepare('update zug_fahrten set fertig_ms = ? where nr = ?').run(nowMs, z.nr);
    }
    return { ok: true, nr: z.nr, angenommen, fertig };
  }

  fuelle(konto: string, nowMs: number): ZugBeitrag {
    const z = this.laufend(nowMs);
    if (!z || z.fertigMs > 0) return { ok: false, grund: 'NOT_NEEDED' };
    let letzte: ZugBeitrag = { ok: false, grund: 'NOT_NEEDED' };
    for (const b of z.plan) {
      const offen = this.offen(b.item, nowMs);
      if (offen > 0) letzte = this.beitrag(konto, b.item, offen, nowMs);
    }
    return letzte;
  }

  stand(nowMs: number, konto?: string): ZugStand | null {
    const z = this.laufend(nowMs);
    if (!z) return null;
    const da = this.gemerkt(z.nr).geliefert;
    const helfer = this.helfer(z.nr);
    return {
      woche: z.woche,
      abfahrtMs: zugAbfahrtMs(z.woche),
      bestellung: z.plan.map((b) => ({ item: b.item, menge: b.menge, geliefert: Math.min(b.menge, da.get(b.item) ?? 0) })),
      fertig: z.fertigMs > 0,
      fertigMs: z.fertigMs,
      dank: ZUG_DANK,
      helfer: helfer.slice(0, 10),
      mein: konto ? (helfer.find((h) => h.konto === konto)?.menge ?? 0) : 0,
    };
  }

  vergissHof(konto: string): void {
    this.db.prepare('delete from zug_beitraege where konto = ?').run(konto);
    this.version++;
  }
}

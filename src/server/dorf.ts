import type { Db } from './db.ts';

// Das Dorfprojekt: Alle Höfe eines Servers bauen zusammen an einem Bauwerk.
// Waren gehen an die Baustelle statt an den Händler — und wenn es steht, hat
// jeder etwas davon. Der Bedarf skaliert mit der Zahl der aktiven Höfe, damit
// vier Spieler nicht an einem Bahnhof für vierhundert verzweifeln.
//
// Das Dorf ist Sache des Servers, nicht der Simulation: Der Abzug vom Hof
// läuft als äußere Änderung (wie ein Geschenk), der Dank als Post. Beides
// sind Wege, die es schon gibt — die Sim bleibt rein.

export type Bedarf = { item: string; menge: number };
export type EtappeDef = { name: string; bedarf: readonly Bedarf[] };
export type ProjektDef = {
  id: string;
  name: string;
  text: string;
  etappen: readonly EtappeDef[];
  // Was jeder Helfer bekommt, wenn es steht — als Post.
  dank: readonly Bedarf[];
};

export const DANKESWOCHE_MS = 7 * 86_400_000;
// Ist das letzte Projekt gebaut, bleibt es stehen — dann kommt der Zug (zug.ts).
// Neue Projekte hinten anhängen; das Dorf baut sie der Reihe nach.
export const AKTIV_FENSTER_MS = 7 * 86_400_000;
// Der Bedarf wird gemessen, nicht geraten: Beim Start eines Projekts zählt
// der Server, was die in der letzten Woche aktiven Höfe von jeder Ware gerade
// haben. Eine Etappe verlangt einen Anteil davon — so bleibt sie für die
// Gemeinschaft erreichbar, ob vier Höfe spielen oder tausend. Was noch niemand
// herstellt, bleibt bei der Grundmenge; nach oben ist bei dem Zweihundertfachen
// Schluss.
export const ANTEIL_VORRAT = 0.3;
export const FAKTOR_MAX = 200;

export type Messung = { aktive: number; vorrat: (item: string) => number };

export function mengeFuer(grund: number, vorrat: number): number {
  return Math.min(grund * FAKTOR_MAX, Math.max(grund, Math.round(vorrat * ANTEIL_VORRAT)));
}

export const PROJEKTE: readonly ProjektDef[] = [
  {
    id: 'brunnen',
    name: 'Dorfbrunnen',
    text: 'Ein Brunnen mitten im Dorf — Wasser für alle und ein Platz zum Plaudern.',
    etappen: [
      { name: 'Schacht', bedarf: [{ item: 'plank', menge: 32 }, { item: 'iron-bar', menge: 6 }] },
      { name: 'Brunnenrand', bedarf: [{ item: 'nail', menge: 40 }, { item: 'bread', menge: 20 }, { item: 'cheese', menge: 12 }] },
      { name: 'Dach und Winde', bedarf: [{ item: 'wood', menge: 24 }, { item: 'apple-pie', menge: 10 }, { item: 'yarn', menge: 8 }] },
    ],
    dank: [{ item: 'map', menge: 4 }, { item: 'gold', menge: 800 }],
  },
  {
    id: 'bruecke',
    name: 'Holzbrücke',
    text: 'Über den Bach, damit der Wagen nicht mehr den Umweg fahren muss.',
    etappen: [
      { name: 'Pfeiler', bedarf: [{ item: 'stake', menge: 40 }, { item: 'iron-bar', menge: 10 }] },
      { name: 'Fahrbahn', bedarf: [{ item: 'plank', menge: 60 }, { item: 'nail', menge: 48 }, { item: 'smoked-fish', menge: 16 }] },
      { name: 'Geländer', bedarf: [{ item: 'wood', menge: 32 }, { item: 'sweater', menge: 6 }, { item: 'carrot-cake', menge: 10 }] },
    ],
    dank: [{ item: 'map', menge: 6 }, { item: 'iron-bar', menge: 8 }, { item: 'gold', menge: 1600 }],
  },
  {
    id: 'bahnhof',
    name: 'Kleiner Bahnhof',
    text: 'Ein Bahnsteig am Dorfrand — dann kommen Gäste, und der Handel wird größer.',
    etappen: [
      { name: 'Gleisbett', bedarf: [{ item: 'stake', menge: 48 }, { item: 'coal', menge: 32 }] },
      { name: 'Bahnsteig', bedarf: [{ item: 'plank', menge: 80 }, { item: 'iron-bar', menge: 16 }, { item: 'farm-platter', menge: 10 }] },
      { name: 'Wartehäuschen', bedarf: [{ item: 'nail', menge: 64 }, { item: 'gold-bar', menge: 4 }, { item: 'cream-cake', menge: 10 }, { item: 'apple-juice', menge: 16 }] },
    ],
    dank: [{ item: 'map', menge: 8 }, { item: 'gold-bar', menge: 2 }, { item: 'gold', menge: 3000 }],
  },
];

export function projektDef(id: string): ProjektDef | null {
  return PROJEKTE.find((p) => p.id === id) ?? null;
}

// Je Etappe die verlangten Mengen, festgelegt beim Start des Projekts.
type BedarfPlan = Array<Array<{ item: string; menge: number }>>;

type Zeile = { nr: number; projekt: string; faktor: number; etappe: number; begonnenMs: number; fertigMs: number; plan: BedarfPlan };

export type Helfer = { konto: string; menge: number };

export type DorfStand = {
  nr: number;
  projekt: { id: string; name: string; text: string };
  // Zahl der aktiven Höfe beim Start — daran wurde gemessen.
  faktor: number;
  etappe: number;
  etappen: Array<{ name: string; fertig: boolean; bedarf: Array<{ item: string; menge: number; geliefert: number }> }>;
  fertig: boolean;
  fertigMs: number;
  dankeswoche: boolean;
  dankeswocheBis: number;
  naechstesMs: number;
  // Das letzte Projekt steht: kein nächstes mehr, der Zug übernimmt.
  alleGebaut: boolean;
  dank: readonly Bedarf[];
  helfer: Helfer[];
  mein: number;
};

export type Beitrag =
  | { ok: false; grund: 'NOT_NEEDED' }
  | { ok: true; nr: number; angenommen: number; etappeFertig: boolean; projektFertig: boolean };

type Zwischen = { nr: number; version: number; geliefert: Map<number, Map<string, number>>; helfer: Helfer[] };

export class Dorf {
  private readonly db: Db;
  private readonly messen: (nowMs: number) => Messung;
  // Tausend Höfe fragen nach jeder Etappe gleichzeitig nach dem Stand. Die
  // Lieferungen und die Helferliste ändern sich nur durch Beiträge — also
  // einmal rechnen, bis der nächste Beitrag kommt.
  private version = 0;
  private zwischen: Zwischen | null = null;

  private readonly dankeswocheMs: number;

  constructor(db: Db, messen: (nowMs: number) => Messung, dankeswocheMs: number = DANKESWOCHE_MS) {
    this.db = db;
    this.messen = messen;
    this.dankeswocheMs = dankeswocheMs;
  }

  // Alles gebaut? Dann gibt es kein nächstes Projekt mehr.
  alleGebaut(): boolean {
    return this.anzahlFertig() >= PROJEKTE.length;
  }

  // Steht der Bahnhof? Daran hängt der Zug.
  bahnhofSteht(): boolean {
    const row = this.db.prepare("select count(*) as n from dorf_projekte where projekt = 'bahnhof' and fertig_ms > 0").get() as { n: number };
    return Number(row.n) > 0;
  }

  // Ältere Zeilen (vor der Messung) tragen keinen Plan: dann gilt Grundmenge
  // mal Faktor, wie es damals festgelegt wurde.
  private planVon(projekt: string, faktor: number, roh: string | null): BedarfPlan {
    const def = projektDef(projekt);
    if (!def) return [];
    if (roh) {
      try { return JSON.parse(roh) as BedarfPlan; } catch { /* dann rechnen */ }
    }
    return def.etappen.map((e) => e.bedarf.map((b) => ({ item: b.item, menge: b.menge * Math.max(1, faktor) })));
  }

  private mengeIn(z: Zeile, etappe: number, item: string): number {
    const b = z.plan[etappe]?.find((x) => x.item === item);
    return b ? b.menge : 0;
  }

  private geaendert(): void {
    this.version++;
  }

  private gemerkt(nr: number): Zwischen {
    if (this.zwischen && this.zwischen.nr === nr && this.zwischen.version === this.version) return this.zwischen;
    const rows = this.db
      .prepare('select etappe, item, sum(menge) as menge from dorf_beitraege where projekt_nr = ? group by etappe, item')
      .all(nr) as Array<{ etappe: number; item: string; menge: number }>;
    const geliefert = new Map<number, Map<string, number>>();
    for (const r of rows) {
      if (!geliefert.has(r.etappe)) geliefert.set(r.etappe, new Map());
      geliefert.get(r.etappe)!.set(r.item, Number(r.menge));
    }
    const helfer = (this.db
      .prepare('select konto, sum(menge) as menge from dorf_beitraege where projekt_nr = ? group by konto order by menge desc, min(zeit_ms) asc')
      .all(nr) as Array<{ konto: string; menge: number }>).map((r) => ({ konto: r.konto, menge: Number(r.menge) }));
    this.zwischen = { nr, version: this.version, geliefert, helfer };
    return this.zwischen;
  }

  private neueste(): Zeile | null {
    const row = this.db
      .prepare('select nr, projekt, faktor, etappe, begonnen_ms as begonnenMs, fertig_ms as fertigMs, bedarf_json as roh from dorf_projekte order by nr desc limit 1')
      .get() as (Omit<Zeile, 'plan'> & { roh: string | null }) | undefined;
    if (!row) return null;
    return { ...row, plan: this.planVon(row.projekt, row.faktor, row.roh) };
  }

  private anzahlFertig(): number {
    const row = this.db.prepare('select count(*) as n from dorf_projekte where fertig_ms > 0').get() as { n: number };
    return Number(row.n);
  }

  private starte(nowMs: number): Zeile {
    const def = PROJEKTE[this.anzahlFertig() % PROJEKTE.length]!;
    const m = this.messen(nowMs);
    const plan: BedarfPlan = def.etappen.map((e) => e.bedarf.map((b) => ({ item: b.item, menge: mengeFuer(b.menge, m.vorrat(b.item)) })));
    // `faktor` trägt die Zahl der aktiven Höfe — zur Anzeige, nicht zum Rechnen.
    const res = this.db
      .prepare('insert into dorf_projekte (projekt, faktor, etappe, begonnen_ms, fertig_ms, bedarf_json) values (?, ?, 0, ?, 0, ?)')
      .run(def.id, m.aktive, nowMs, JSON.stringify(plan));
    this.geaendert();
    return { nr: Number(res.lastInsertRowid), projekt: def.id, faktor: m.aktive, etappe: 0, begonnenMs: nowMs, fertigMs: 0, plan };
  }

  // Das laufende Projekt — und wenn keines läuft oder die Dankeswoche des
  // letzten vorbei ist, fängt das nächste an.
  laufend(nowMs: number): Zeile {
    const z = this.neueste();
    if (!z) return this.starte(nowMs);
    if (z.fertigMs > 0 && nowMs >= z.fertigMs + this.dankeswocheMs && !this.alleGebaut()) return this.starte(nowMs);
    return z;
  }

  private geliefert(nr: number, etappe: number): Map<string, number> {
    return this.gemerkt(nr).geliefert.get(etappe) ?? new Map();
  }

  helfer(nr: number): Helfer[] {
    return this.gemerkt(nr).helfer;
  }

  // Was von einer Ware in der laufenden Etappe noch fehlt. 0 heißt: nicht
  // gebraucht, schon voll, oder das Projekt ist fertig.
  offen(item: string, nowMs: number): number {
    const z = this.laufend(nowMs);
    if (z.fertigMs > 0) return 0;
    const def = projektDef(z.projekt);
    const etappe = def?.etappen[z.etappe];
    if (!etappe) return 0;
    const soll = this.mengeIn(z, z.etappe, item);
    if (soll <= 0) return 0;
    const da = this.geliefert(z.nr, z.etappe).get(item) ?? 0;
    return Math.max(0, soll - da);
  }

  // Trägt einen Beitrag ein. Der Aufrufer hat die Ware schon abgebucht; hier
  // wird nur noch gebucht, gekappt auf das, was fehlt, und weitergeschaltet.
  beitrag(konto: string, item: string, menge: number, nowMs: number): Beitrag {
    const offen = this.offen(item, nowMs);
    const angenommen = Math.min(offen, Math.max(0, Math.floor(menge)));
    if (angenommen <= 0) return { ok: false, grund: 'NOT_NEEDED' };
    const z = this.laufend(nowMs);
    this.db
      .prepare('insert into dorf_beitraege (projekt_nr, etappe, konto, item, menge, zeit_ms) values (?, ?, ?, ?, ?, ?)')
      .run(z.nr, z.etappe, konto, item, angenommen, nowMs);
    this.geaendert();

    const def = projektDef(z.projekt)!;
    const da = this.geliefert(z.nr, z.etappe);
    const etappeFertig = def.etappen[z.etappe]!.bedarf.every((b) => (da.get(b.item) ?? 0) >= this.mengeIn(z, z.etappe, b.item));
    let projektFertig = false;
    if (etappeFertig) {
      const naechste = z.etappe + 1;
      projektFertig = naechste >= def.etappen.length;
      this.db
        .prepare('update dorf_projekte set etappe = ?, fertig_ms = ? where nr = ?')
        .run(projektFertig ? z.etappe : naechste, projektFertig ? nowMs : 0, z.nr);
    }
    return { ok: true, nr: z.nr, angenommen, etappeFertig, projektFertig };
  }

  // Werkbank: die laufende Etappe auf einen Schlag füllen, gutgeschrieben
  // einem Konto (oder niemandem). Zum Ausprobieren der Zustände.
  fuelle(konto: string, nowMs: number): Beitrag {
    const z = this.laufend(nowMs);
    if (z.fertigMs > 0) return { ok: false, grund: 'NOT_NEEDED' };
    const def = projektDef(z.projekt)!;
    let letzte: Beitrag = { ok: false, grund: 'NOT_NEEDED' };
    for (const b of def.etappen[z.etappe]!.bedarf) {
      const offen = this.offen(b.item, nowMs);
      if (offen > 0) letzte = this.beitrag(konto, b.item, offen, nowMs);
    }
    return letzte;
  }

  dankeswoche(nowMs: number): boolean {
    const z = this.laufend(nowMs);
    return z.fertigMs > 0 && nowMs < z.fertigMs + this.dankeswocheMs;
  }

  stand(nowMs: number, konto?: string): DorfStand {
    const z = this.laufend(nowMs);
    const def = projektDef(z.projekt)!;
    const fertig = z.fertigMs > 0;
    const helfer = this.helfer(z.nr);
    const etappen = def.etappen.map((e, i) => {
      const da = i <= z.etappe || fertig ? this.geliefert(z.nr, i) : new Map<string, number>();
      const erledigt = fertig || i < z.etappe;
      return {
        name: e.name,
        fertig: erledigt,
        bedarf: e.bedarf.map((b) => {
          const soll = this.mengeIn(z, i, b.item);
          return { item: b.item, menge: soll, geliefert: erledigt ? soll : Math.min(soll, da.get(b.item) ?? 0) };
        }),
      };
    });
    return {
      nr: z.nr,
      projekt: { id: def.id, name: def.name, text: def.text },
      faktor: z.faktor,
      etappe: z.etappe,
      etappen,
      fertig,
      fertigMs: z.fertigMs,
      dankeswoche: fertig && nowMs < z.fertigMs + this.dankeswocheMs,
      dankeswocheBis: fertig ? z.fertigMs + this.dankeswocheMs : 0,
      naechstesMs: fertig && !this.alleGebaut() ? z.fertigMs + this.dankeswocheMs : 0,
      alleGebaut: fertig && this.alleGebaut(),
      dank: def.dank,
      helfer: helfer.slice(0, 10),
      mein: konto ? (helfer.find((h) => h.konto === konto)?.menge ?? 0) : 0,
    };
  }

  vergissHof(konto: string): void {
    this.db.prepare('delete from dorf_beitraege where konto = ?').run(konto);
    this.geaendert();
  }
}

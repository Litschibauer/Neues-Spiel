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
export const AKTIV_FENSTER_MS = 7 * 86_400_000;
export const HOEFE_JE_FAKTOR = 8;
export const FAKTOR_MAX = 25;

export const PROJEKTE: readonly ProjektDef[] = [
  {
    id: 'brunnen',
    name: 'Dorfbrunnen',
    text: 'Ein Brunnen mitten im Dorf — Wasser für alle und ein Platz zum Plaudern.',
    etappen: [
      { name: 'Schacht', bedarf: [{ item: 'plank', menge: 16 }, { item: 'iron-bar', menge: 3 }] },
      { name: 'Brunnenrand', bedarf: [{ item: 'nail', menge: 20 }, { item: 'bread', menge: 10 }, { item: 'cheese', menge: 6 }] },
      { name: 'Dach und Winde', bedarf: [{ item: 'wood', menge: 12 }, { item: 'apple-pie', menge: 5 }, { item: 'yarn', menge: 4 }] },
    ],
    dank: [{ item: 'map', menge: 2 }, { item: 'gold', menge: 400 }],
  },
  {
    id: 'bruecke',
    name: 'Holzbrücke',
    text: 'Über den Bach, damit der Wagen nicht mehr den Umweg fahren muss.',
    etappen: [
      { name: 'Pfeiler', bedarf: [{ item: 'stake', menge: 20 }, { item: 'iron-bar', menge: 5 }] },
      { name: 'Fahrbahn', bedarf: [{ item: 'plank', menge: 30 }, { item: 'nail', menge: 24 }, { item: 'smoked-fish', menge: 8 }] },
      { name: 'Geländer', bedarf: [{ item: 'wood', menge: 16 }, { item: 'sweater', menge: 3 }, { item: 'carrot-cake', menge: 5 }] },
    ],
    dank: [{ item: 'map', menge: 3 }, { item: 'iron-bar', menge: 4 }, { item: 'gold', menge: 800 }],
  },
  {
    id: 'bahnhof',
    name: 'Kleiner Bahnhof',
    text: 'Ein Bahnsteig am Dorfrand — dann kommen Gäste, und der Handel wird größer.',
    etappen: [
      { name: 'Gleisbett', bedarf: [{ item: 'stake', menge: 24 }, { item: 'coal', menge: 16 }] },
      { name: 'Bahnsteig', bedarf: [{ item: 'plank', menge: 40 }, { item: 'iron-bar', menge: 8 }, { item: 'farm-platter', menge: 5 }] },
      { name: 'Wartehäuschen', bedarf: [{ item: 'nail', menge: 32 }, { item: 'gold-bar', menge: 2 }, { item: 'cream-cake', menge: 5 }, { item: 'apple-juice', menge: 8 }] },
    ],
    dank: [{ item: 'map', menge: 4 }, { item: 'gold-bar', menge: 1 }, { item: 'gold', menge: 1500 }],
  },
];

export function projektDef(id: string): ProjektDef | null {
  return PROJEKTE.find((p) => p.id === id) ?? null;
}

export function faktorFuer(aktiveHoefe: number): number {
  return Math.min(FAKTOR_MAX, Math.max(1, Math.ceil(aktiveHoefe / HOEFE_JE_FAKTOR)));
}

type Zeile = { nr: number; projekt: string; faktor: number; etappe: number; begonnenMs: number; fertigMs: number };

export type Helfer = { konto: string; menge: number };

export type DorfStand = {
  nr: number;
  projekt: { id: string; name: string; text: string };
  faktor: number;
  etappe: number;
  etappen: Array<{ name: string; fertig: boolean; bedarf: Array<{ item: string; menge: number; geliefert: number }> }>;
  fertig: boolean;
  fertigMs: number;
  dankeswoche: boolean;
  dankeswocheBis: number;
  naechstesMs: number;
  dank: readonly Bedarf[];
  helfer: Helfer[];
  mein: number;
};

export type Beitrag =
  | { ok: false; grund: 'NOT_NEEDED' }
  | { ok: true; nr: number; angenommen: number; etappeFertig: boolean; projektFertig: boolean };

export class Dorf {
  private readonly db: Db;
  private readonly aktiveHoefe: (nowMs: number) => number;

  constructor(db: Db, aktiveHoefe: (nowMs: number) => number) {
    this.db = db;
    this.aktiveHoefe = aktiveHoefe;
  }

  private neueste(): Zeile | null {
    const row = this.db
      .prepare('select nr, projekt, faktor, etappe, begonnen_ms as begonnenMs, fertig_ms as fertigMs from dorf_projekte order by nr desc limit 1')
      .get() as Zeile | undefined;
    return row ?? null;
  }

  private anzahlFertig(): number {
    const row = this.db.prepare('select count(*) as n from dorf_projekte where fertig_ms > 0').get() as { n: number };
    return Number(row.n);
  }

  private starte(nowMs: number): Zeile {
    const def = PROJEKTE[this.anzahlFertig() % PROJEKTE.length]!;
    const faktor = faktorFuer(this.aktiveHoefe(nowMs));
    const res = this.db
      .prepare('insert into dorf_projekte (projekt, faktor, etappe, begonnen_ms, fertig_ms) values (?, ?, 0, ?, 0)')
      .run(def.id, faktor, nowMs);
    return { nr: Number(res.lastInsertRowid), projekt: def.id, faktor, etappe: 0, begonnenMs: nowMs, fertigMs: 0 };
  }

  // Das laufende Projekt — und wenn keines läuft oder die Dankeswoche des
  // letzten vorbei ist, fängt das nächste an.
  laufend(nowMs: number): Zeile {
    const z = this.neueste();
    if (!z) return this.starte(nowMs);
    if (z.fertigMs > 0 && nowMs >= z.fertigMs + DANKESWOCHE_MS) return this.starte(nowMs);
    return z;
  }

  private geliefert(nr: number, etappe: number): Map<string, number> {
    const rows = this.db
      .prepare('select item, sum(menge) as menge from dorf_beitraege where projekt_nr = ? and etappe = ? group by item')
      .all(nr, etappe) as Array<{ item: string; menge: number }>;
    return new Map(rows.map((r) => [r.item, Number(r.menge)]));
  }

  helfer(nr: number): Helfer[] {
    const rows = this.db
      .prepare('select konto, sum(menge) as menge from dorf_beitraege where projekt_nr = ? group by konto order by menge desc, min(zeit_ms) asc')
      .all(nr) as Array<{ konto: string; menge: number }>;
    return rows.map((r) => ({ konto: r.konto, menge: Number(r.menge) }));
  }

  // Was von einer Ware in der laufenden Etappe noch fehlt. 0 heißt: nicht
  // gebraucht, schon voll, oder das Projekt ist fertig.
  offen(item: string, nowMs: number): number {
    const z = this.laufend(nowMs);
    if (z.fertigMs > 0) return 0;
    const def = projektDef(z.projekt);
    const etappe = def?.etappen[z.etappe];
    if (!etappe) return 0;
    const b = etappe.bedarf.find((x) => x.item === item);
    if (!b) return 0;
    const da = this.geliefert(z.nr, z.etappe).get(item) ?? 0;
    return Math.max(0, b.menge * z.faktor - da);
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

    const def = projektDef(z.projekt)!;
    const da = this.geliefert(z.nr, z.etappe);
    const etappeFertig = def.etappen[z.etappe]!.bedarf.every((b) => (da.get(b.item) ?? 0) >= b.menge * z.faktor);
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
    return z.fertigMs > 0 && nowMs < z.fertigMs + DANKESWOCHE_MS;
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
        bedarf: e.bedarf.map((b) => ({
          item: b.item,
          menge: b.menge * z.faktor,
          geliefert: erledigt ? b.menge * z.faktor : Math.min(b.menge * z.faktor, da.get(b.item) ?? 0),
        })),
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
      dankeswoche: fertig && nowMs < z.fertigMs + DANKESWOCHE_MS,
      dankeswocheBis: fertig ? z.fertigMs + DANKESWOCHE_MS : 0,
      naechstesMs: fertig ? z.fertigMs + DANKESWOCHE_MS : 0,
      dank: def.dank,
      helfer: helfer.slice(0, 10),
      mein: konto ? (helfer.find((h) => h.konto === konto)?.menge ?? 0) : 0,
    };
  }

  vergissHof(konto: string): void {
    this.db.prepare('delete from dorf_beitraege where konto = ?').run(konto);
  }
}

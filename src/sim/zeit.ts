// Die Hofzeit: der Kalender des Spiels, nach dem Vorbild von SkyBlock, in
// unserem Tempo. Drei Zeitquellen, sauber getrennt:
//
//   1. Echtzeit (Unix-Sekunden, UTC) — der Tick der Simulation. Alles, was den
//      Alltag der Spieler taktet, hängt daran: Servertag (`tagVon` in
//      sozial.ts), Serverwoche (`wocheVonTag` in state.ts), Tagesbonus,
//      Tageszettel, Wochenzettel, Zug-Abfahrt. Unsere „Serverzeit" IST UTC —
//      bewusst ohne Zeitzone und Sommerzeit, damit Gerät und Server ohne
//      Bibliothek und ohne Kalenderregeln dasselbe rechnen.
//   2. Hofzeit — der Spielkalender: 12 Monate zu 31 Tagen, vier Jahreszeiten
//      zu drei Monaten (früh, mitte, spät), Tag von 6 bis 19 Uhr, sonst Nacht.
//      Sie ist eine reine Funktion des Ticks: gleiche Uhr für alle, offline
//      nachrechenbar, nicht zu verstellen. Ein Hoftag dauert eine echte Stunde.
//   3. Geräteuhr — nur für Stimmung, wo ein Regelwerk keine Hofzeit kennt.
//
// Alles ganzzahlig. Ein Zeitpunkt ist ein Tick (Sekunden seit Epoche); eine
// Dauer ist eine Zahl Sekunden. Kalenderwerte werden immer aus dem Tick
// gerechnet, nie durch Aufaddieren — es gibt keine Rundungsdrift.

// — Konstanten —————————————————————————————————————————————————————————

// Frühfrühling, Jahr 1, 00:00 Hofzeit = Montag, 14. September 2026, 00:00 UTC.
export const HOFZEIT_EPOCHE = 1_789_344_000;

// Tempo: eine Hofstunde sind 150 echte Sekunden, ein Hoftag eine echte Stunde.
export const HOFSTUNDE_S = 150;
export const HOFMINUTE_S = 150; // in Hofminuten gerechnet: 60 je Stunde, 2,5 s echt — siehe hofminuten()
export const STUNDEN_JE_TAG = 24;
export const HOFTAG_S = HOFSTUNDE_S * STUNDEN_JE_TAG; // 3600
export const TAGE_JE_MONAT = 31;
export const MONATE_JE_JAHRESZEIT = 3;
export const MONATE_JE_JAHR = 12;
export const TAGE_JE_JAHR = TAGE_JE_MONAT * MONATE_JE_JAHR; // 372
export const HOFMONAT_S = HOFTAG_S * TAGE_JE_MONAT;
export const HOFJAHRESZEIT_S = HOFMONAT_S * MONATE_JE_JAHRESZEIT;
export const HOFJAHR_S = HOFTAG_S * TAGE_JE_JAHR;

export const JAHRESZEITEN: readonly string[] = ['Frühling', 'Sommer', 'Herbst', 'Winter'];
export const ABSCHNITTE: readonly string[] = ['früh', 'mitte', 'spät'];
export const MONATE: readonly string[] = [
  'Frühfrühling', 'Frühling', 'Spätfrühling',
  'Frühsommer', 'Sommer', 'Spätsommer',
  'Frühherbst', 'Herbst', 'Spätherbst',
  'Frühwinter', 'Winter', 'Spätwinter',
];

// Tag von 6 bis 19 Uhr Hofzeit, Nacht von 19 bis 6 — in Minuten des Tages.
export const TAG_VON = 6 * 60;
export const TAG_BIS = 19 * 60;

// Zeitfenster, zentral. Wer ein Fenster braucht, holt es hier — nicht als
// Zahl im Code. `von`/`bis` in Minuten des Hoftages; geht ein Fenster über
// Mitternacht (von > bis), ist das gewollt.
export type Zeitfenster = { von: number; bis: number };
export const ZEITFENSTER: Readonly<Record<string, Zeitfenster>> = {
  tag: { von: TAG_VON, bis: TAG_BIS },
  nacht: { von: TAG_BIS, bis: TAG_VON },
  // Tiefe Nacht — für Dinge, die es nur dann geben soll (noch ohne Wirkung).
  tiefeNacht: { von: 21 * 60, bis: 5 * 60 },
};

// — Ganzzahlige Hilfen —————————————————————————————————————————————————

function teile(a: number, b: number): number {
  return Math.floor(a / b);
}
function rest(a: number, b: number): number {
  return ((a % b) + b) % b;
}

// — Dauer ————————————————————————————————————————————————————————————————

// Eine Dauer in Hofeinheiten, ausgedrückt in echten Sekunden.
export function dauer(teil: { jahre?: number; monate?: number; tage?: number; stunden?: number; minuten?: number }): number {
  return (
    (teil.jahre ?? 0) * HOFJAHR_S +
    (teil.monate ?? 0) * HOFMONAT_S +
    (teil.tage ?? 0) * HOFTAG_S +
    (teil.stunden ?? 0) * HOFSTUNDE_S +
    hofminuten(teil.minuten ?? 0)
  );
}

// Hofminuten in echte Sekunden — 60 Minuten je Hofstunde. Eine Hofminute sind
// 2,5 s; gerundet auf die nächste ganze Sekunde, damit Kalender → Tick →
// Kalender dieselbe Minute ergibt.
export function hofminuten(minuten: number): number {
  return teile(minuten * HOFSTUNDE_S + 30, 60);
}

// Eine Dauer zerlegt in Hofeinheiten (Tage, Stunden, Minuten), für die Anzeige.
export function dauerInHofzeit(sekunden: number): { tage: number; stunden: number; minuten: number } {
  const s = Math.max(0, sekunden);
  const tage = teile(s, HOFTAG_S);
  const stunden = teile(rest(s, HOFTAG_S), HOFSTUNDE_S);
  const minuten = teile(rest(s, HOFSTUNDE_S) * 60, HOFSTUNDE_S);
  return { tage, stunden, minuten };
}

// — Zeitpunkt ————————————————————————————————————————————————————————————

export type Hofzeit = {
  tick: number;
  // Hoftage seit der Epoche (kann vor der Epoche negativ sein).
  tagIndex: number;
  jahr: number; // 1-basiert; vor der Epoche 0, −1, …
  monat: number; // 0..11
  monatName: string;
  tag: number; // 1..31
  stunde: number; // 0..23
  minute: number; // 0..59
  jahreszeit: number; // 0..3
  jahreszeitName: string;
  abschnitt: number; // 0 früh, 1 mitte, 2 spät
  abschnittName: string;
  tagesphase: 'tag' | 'nacht';
  minuteImTag: number; // 0..1439
};

export function hofzeit(tick: number): Hofzeit {
  const seit = tick - HOFZEIT_EPOCHE;
  const tagIndex = teile(seit, HOFTAG_S);
  const imTag = rest(seit, HOFTAG_S);
  const tagImJahr = rest(tagIndex, TAGE_JE_JAHR);
  const jahrIndex = teile(tagIndex, TAGE_JE_JAHR);
  const monat = teile(tagImJahr, TAGE_JE_MONAT);
  const tag = rest(tagImJahr, TAGE_JE_MONAT) + 1;
  const stunde = teile(imTag, HOFSTUNDE_S);
  const minute = teile(rest(imTag, HOFSTUNDE_S) * 60, HOFSTUNDE_S);
  const minuteImTag = stunde * 60 + minute;
  const jahreszeit = teile(monat, MONATE_JE_JAHRESZEIT);
  const abschnitt = rest(monat, MONATE_JE_JAHRESZEIT);
  return {
    tick,
    tagIndex,
    jahr: jahrIndex + 1,
    monat,
    monatName: MONATE[monat]!,
    tag,
    stunde,
    minute,
    jahreszeit,
    jahreszeitName: JAHRESZEITEN[jahreszeit]!,
    abschnitt,
    abschnittName: ABSCHNITTE[abschnitt]!,
    tagesphase: imFenster(minuteImTag, ZEITFENSTER.tag!) ? 'tag' : 'nacht',
    minuteImTag,
  };
}

// Aus einem Kalenderdatum der Tick — die Umkehr von hofzeit(). Monat 0..11,
// Tag 1..31, Stunde 0..23, Minute 0..59.
export function tickVon(datum: { jahr: number; monat: number; tag: number; stunde?: number; minute?: number }): number {
  const tagIndex = (datum.jahr - 1) * TAGE_JE_JAHR + datum.monat * TAGE_JE_MONAT + (datum.tag - 1);
  return HOFZEIT_EPOCHE + tagIndex * HOFTAG_S + (datum.stunde ?? 0) * HOFSTUNDE_S + hofminuten(datum.minute ?? 0);
}

// Grenzen: Beginn (einschließlich) und Ende (ausschließlich) der Einheit, in
// der der Tick liegt. Das Ende ist der Beginn der nächsten.
function grenzen(tick: number, laenge: number): { beginn: number; ende: number } {
  const beginn = HOFZEIT_EPOCHE + teile(tick - HOFZEIT_EPOCHE, laenge) * laenge;
  return { beginn, ende: beginn + laenge };
}
export function hoftagGrenzen(tick: number): { beginn: number; ende: number } { return grenzen(tick, HOFTAG_S); }
export function hofmonatGrenzen(tick: number): { beginn: number; ende: number } { return grenzen(tick, HOFMONAT_S); }
export function jahreszeitGrenzen(tick: number): { beginn: number; ende: number } { return grenzen(tick, HOFJAHRESZEIT_S); }
export function hofjahrGrenzen(tick: number): { beginn: number; ende: number } { return grenzen(tick, HOFJAHR_S); }

// Liegt eine Tagesminute im Fenster? Fenster über Mitternacht (von > bis)
// sind erlaubt: 21:00–05:00 heißt ab 21 Uhr oder vor 5 Uhr.
export function imFenster(minuteImTag: number, f: Zeitfenster): boolean {
  const m = rest(minuteImTag, STUNDEN_JE_TAG * 60);
  if (f.von === f.bis) return true;
  if (f.von < f.bis) return m >= f.von && m < f.bis;
  return m >= f.von || m < f.bis;
}

// Wann beginnt das Fenster das nächste Mal (ab jetzt, einschließlich jetzt,
// wenn es gerade läuft: dann der laufende Beginn)?
export function fensterBeginn(tick: number, f: Zeitfenster): number {
  const tagBeginn = hoftagGrenzen(tick).beginn;
  const heute = tagBeginn + hofminuten(f.von);
  const z = hofzeit(tick);
  if (imFenster(z.minuteImTag, f)) {
    // Läuft — der Beginn war heute, oder gestern, wenn das Fenster über Mitternacht geht.
    return z.minuteImTag >= f.von ? heute : heute - HOFTAG_S;
  }
  return tick < heute ? heute : heute + HOFTAG_S;
}

// — Ereignisse ————————————————————————————————————————————————————————————

// Ein Ereignis nennt seine Zeitquelle und rechnet sein nächstes Auftreten aus
// einem Tick. Kalender-Ereignisse laufen nach Hofzeit; Echtzeit-Ereignisse
// nach Unix-Sekunden (UTC), wie Servertag und Serverwoche.
export type Zeitquelle = 'hofzeit' | 'echtzeit';
export type Auftreten = { beginn: number; ende: number };
export type Ereignis = {
  id: string;
  name: string;
  quelle: Zeitquelle;
  // Das nächste Auftreten ab `tick`: das laufende, wenn gerade eines läuft.
  naechstes: (tick: number) => Auftreten;
};

export function laeuft(e: Ereignis, tick: number): boolean {
  const a = e.naechstes(tick);
  return tick >= a.beginn && tick < a.ende;
}

export function verbleibendBisBeginn(e: Ereignis, tick: number): number {
  return Math.max(0, e.naechstes(tick).beginn - tick);
}

export function verbleibendBisEnde(e: Ereignis, tick: number): number {
  return Math.max(0, e.naechstes(tick).ende - tick);
}

// Ein Wechsel ist ein Augenblick: Beginn und Ende fallen zusammen, und das
// nächste Auftreten ist der nächste Wechsel NACH dem Tick.
function wechsel(id: string, name: string, laenge: number): Ereignis {
  return { id, name, quelle: 'hofzeit', naechstes: (tick) => { const e = grenzen(tick, laenge).ende; return { beginn: e, ende: e }; } };
}

// Echtzeit: Tage und Wochen in UTC, wie überall im Server. Tag 0 der Epoche
// war ein Donnerstag; die Woche beginnt am Montag (dieselbe Verschiebung wie
// `wocheVonTag`).
const ECHT_TAG_S = 86_400;
const ECHT_WOCHE_S = 7 * ECHT_TAG_S;
const WOCHEN_VERSATZ_S = 4 * ECHT_TAG_S; // Montag, 5. Januar 1970 ist Tag 4

export const EREIGNISSE: readonly Ereignis[] = [
  // Hofzeit
  { id: 'nacht', name: 'Nacht', quelle: 'hofzeit', naechstes: (tick) => {
    const b = fensterBeginn(tick, ZEITFENSTER.nacht!);
    return { beginn: b, ende: b + hofminuten(rest(TAG_VON - TAG_BIS, STUNDEN_JE_TAG * 60)) };
  } },
  wechsel('hoftag', 'Neuer Hoftag', HOFTAG_S),
  wechsel('hofmonat', 'Neuer Monat', HOFMONAT_S),
  wechsel('jahreszeit', 'Neue Jahreszeit', HOFJAHRESZEIT_S),
  wechsel('hofjahr', 'Neues Jahr', HOFJAHR_S),
  // Echtzeit (UTC): der nächste Servertag und die nächste Serverwoche —
  // Tagesbonus, Tageszettel, Wochenzettel und die Abfahrt des Zugs hängen daran.
  { id: 'servertag', name: 'Neuer Tag (Tagesbonus, Tageszettel)', quelle: 'echtzeit', naechstes: (tick) => {
    const e = (teile(tick, ECHT_TAG_S) + 1) * ECHT_TAG_S;
    return { beginn: e, ende: e };
  } },
  { id: 'serverwoche', name: 'Neue Woche (Wochenzettel, Zug)', quelle: 'echtzeit', naechstes: (tick) => {
    const e = (teile(tick - WOCHEN_VERSATZ_S, ECHT_WOCHE_S) + 1) * ECHT_WOCHE_S + WOCHEN_VERSATZ_S;
    return { beginn: e, ende: e };
  } },
];

export function ereignis(id: string): Ereignis | null {
  return EREIGNISSE.find((e) => e.id === id) ?? null;
}

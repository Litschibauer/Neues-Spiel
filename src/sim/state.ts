import type { Ruleset } from './rules.ts';
import { derivedTables, slotsAt } from './rules.ts';

export type Slot = {
  recipe: number;
  startedAt: number;
};

// Apfelbaum-Zustand: reifSeit = Tick, ab dem die aktuelle Apfelrunde zählt
// (beim Pflanzen auf Pflanztick + Setzlingszeit gesetzt); geerntet = Anzahl
// bisheriger Ernten. Nur Baum-Plätze tragen dieses Feld.
export type Baum = {
  reifSeit: number;
  geerntet: number;
};

export type Plot = {
  level: number;
  slots: readonly Slot[];
  gx: number;
  gy: number;
  tiere: readonly number[];
  baum?: Baum;
  // Meisterschaft: Abholungen an diesem Platz. Fehlt, solange es keine gab —
  // so bleibt der Zustand alter Fassungen Byte für Byte, wie er war.
  meister?: number;
};

export const EMPTY_SLOT: Slot = { recipe: -1, startedAt: 0 };

export function emptySlots(n: number): Slot[] {
  const out: Slot[] = [];
  for (let i = 0; i < n; i++) out.push({ recipe: EMPTY_PLOT, startedAt: 0 });
  return out;
}

export const EMPTY_PLOT = -1;

export type Order = {
  id: number;
  item: number;
  amount: number;
  price: number;
  listedAt: number;
  verkauft: number;
};

export type Offer = {
  id: number;
  item: number;
  amount: number;
  price: number;
  seller: string;
  hof: string;
  headline: boolean;
};

export type MailItem = {
  item: number;
  amount: number;
  arrivedAt: number;
};

export type Request = {
  id: number;
  wants: readonly { item: number; amount: number }[];
  reward: readonly { item: number; amount: number }[];
  xp: number;
  dest: number;
};

export type Chest = {
  id: number;
  kind: number;
  readyAt: number;
  gx: number;
  gy: number;
};

export type Truck = {
  loaded: readonly number[];
  awayUntil: number;
};

export type State = {
  tick: number;
  xp: number;
  items: readonly number[];
  plots: readonly Plot[];
  passives: readonly number[];
  orders: readonly Order[];
  offers: readonly Offer[];
  mail: readonly MailItem[];
  nextOrderId: number;
  requests: readonly Request[];
  skipReadyAt: number;
  truck: Truck;
  siloLevel: number;
  chests: readonly Chest[];
  nextChestId: number;
  pendingBoxes: readonly number[];
  clearedObstacles: readonly number[];
  expandiert: readonly string[];
  chestReadyAt: number;
  // Bereits eingelöste Erfolge (Achievement-IDs).
  claimed: readonly string[];
  // Eingepackte Dekoration: Platz-Indizes, die man besitzt, aber gerade nicht
  // aufgestellt hat. Wieder-Aufstellen ist kostenlos.
  eingepackt: readonly number[];
  // Angelsee: Anzahl bisher gefangener Fische. Dient als Fortschritt UND als
  // Zähler für den deterministischen Fang.
  angelFang: number;
  // Angelsee: Ist das Boot am Hof repariert? Erst dann ist der See offen.
  bootRepariert: boolean;
  // Angelsee: je Angelstelle der Tick, an dem Köder gelegt wurde; -1 heißt leer.
  // Kürzere Listen gelten als leer, darum braucht ein alter Stand keine Wanderung.
  angelSpots: readonly number[];
  // Angelsee: je Werkbank-Platz im Strandhaus der Startzeit-Tick; -1 heißt frei.
  angelKoeder: readonly number[];
  // Lebenszeit-Zähler, Index siehe ZAEHLER. Anhängend erweitern, nie umsortieren
  // — die Indizes stecken in jedem gespeicherten Stand.
  zaehler: readonly number[];
  // Kalendertag des Servers (Tage seit Epoche). Nur der Server schreibt ihn,
  // und zwar außerhalb des Befehls-Nachspielens; die Sim liest ihn bloß. Ein
  // Stand ohne Kontakt behält den zuletzt bekannten Tag — deshalb rollen
  // Tagesaufgaben offline nicht weiter, während der Fortschritt trotzdem zählt.
  serverTag: number;
  // Fuer welchen Tag tagStart/tagGeholt gelten. Wechselt der Server-Tag, setzt
  // der Server beides zurueck — an derselben Stelle, an der er den Tag stempelt.
  tagNummer: number;
  // Zaehlerstaende bei Tagesbeginn. Der Fortschritt einer Aufgabe ist die
  // Differenz dazu, so braucht es keinen zweiten Satz Zaehler.
  tagStart: readonly number[];
  // Heute schon abgeholte Aufgaben.
  tagGeholt: readonly string[];
  // Dasselbe fuer die Woche (Montag bis Sonntag, UTC): Nummer der Serverwoche,
  // Zaehlerstaende bei Wochenbeginn, diese Woche abgeholte Wochenaufgaben.
  // Die Woche selbst leitet sich aus dem Server-Tag ab — kein zweiter Stempel.
  wochenNummer: number;
  wochenStart: readonly number[];
  wochenGeholt: readonly string[];
  // Bis zu welchem Tick der XP-Verdoppler laeuft; 0 heisst keiner.
  xpDoppeltBis: number;
};

// Reihenfolge ist Vertrag: Diese Indizes liegen in jedem Spielstand.
export const ZAEHLER = {
  ERNTEN: 0,
  STARTEN: 1,
  ZETTEL: 2,
  ANFRAGEN: 3,
  VERKAUFT: 4,
  GOLD: 5,
  FISCHE: 6,
  GERAEUMT: 7,
  GEBAUT: 8,
} as const;

export const ZAEHLER_ANZAHL = 9;

// Der Tagesabschluss liegt in derselben Liste wie die abgeholten Aufgaben —
// dann raeumt der Tageswechsel ihn ohne Zutun mit weg. Der Name kann mit keiner
// Aufgabe kollidieren; ein Test im Regelwerk haelt das fest.
export const TAG_ABSCHLUSS = 'tagesabschluss';

// Wie viele Aufgaben heute schon abgenommen wurden (der Abschluss zaehlt nicht
// mit). Gezaehlt statt verglichen: Steigt jemand mitten am Tag eine Stufe auf,
// wechselt sein Aufgabensatz — abgearbeitet hat er sie trotzdem.
export function tagesAbgenommen(s: State): number {
  const geholt = s.tagGeholt ?? [];
  let n = 0;
  for (const id of geholt) if (id !== TAG_ABSCHLUSS) n++;
  return n;
}

// Die Woche haengt am Server-Tag: Tag 0 der Epoche war ein Donnerstag, darum
// die Verschiebung um drei — so beginnt jede Woche am Montag (UTC).
export function wocheVonTag(tag: number): number {
  return Math.floor((tag + 3) / 7);
}

export const WOCHE_ABSCHLUSS = 'wochenabschluss';

export function wochenFortschritt(s: State, art: number): number {
  const tag = s.serverTag ?? 0;
  if (tag <= 0) return 0;
  if ((s.wochenNummer ?? 0) !== wocheVonTag(tag)) return 0;
  return Math.max(0, zaehlerStand(s, art) - (s.wochenStart?.[art] ?? 0));
}

export function wochenAbgenommen(s: State): number {
  const geholt = s.wochenGeholt ?? [];
  let n = 0;
  for (const id of geholt) if (id !== WOCHE_ABSCHLUSS) n++;
  return n;
}

// Fortschritt seit Tagesbeginn. Vor dem ersten Serverkontakt gibt es noch
// keinen Tag, dann zaehlt nichts.
export function tagesFortschritt(s: State, art: number): number {
  const tag = s.serverTag ?? 0;
  if (tag <= 0) return 0;
  // Gehoert der Nullpunkt nicht zu diesem Tag, gibt es noch keinen Fortschritt.
  // Ohne diese Wache zaehlte bei einem gerade gewanderten Stand die gesamte
  // Lebensleistung als heute geleistet.
  if ((s.tagNummer ?? 0) !== tag) return 0;
  return Math.max(0, zaehlerStand(s, art) - (s.tagStart?.[art] ?? 0));
}

export function zaehlerStand(s: State, art: number): number {
  return s.zaehler?.[art] ?? 0;
}

// Zähler hochsetzen, ohne den alten Zustand anzufassen. Fehlende Plätze werden
// aufgefüllt, damit ein Stand aus einer älteren Fassung nicht stolpert.
export function zaehle(zaehler: readonly number[], art: number, n: number): readonly number[] {
  const raus = [];
  for (let i = 0; i < ZAEHLER_ANZAHL; i++) raus.push(zaehler?.[i] ?? 0);
  raus[art] = (raus[art] ?? 0) + n;
  return raus;
}

export function count(s: State, item: number): number {
  return s.items[item] ?? 0;
}

export function capacityOf(s: State, rules: Ruleset): number {
  const stufen = rules.siloLevels;
  if (!stufen || stufen.length === 0) return rules.siloCapacity;
  const stufe = stufen[Math.min(s.siloLevel, stufen.length - 1)];
  return stufe ? stufe.capacity : rules.siloCapacity;
}

export function stored(s: State, rules: Ruleset): number {
  return storedIn(s.items, rules);
}

export function storedIn(items: readonly number[], rules: Ruleset): number {
  const { storable } = derivedTables(rules);
  let total = 0;
  for (const i of storable) total += items[i] ?? 0;
  return total;
}

export function spaceLeft(s: State, rules: Ruleset): number {
  return capacityOf(s, rules) - stored(s, rules);
}

export function totalGoods(s: State, rules: Ruleset): number {
  let total = stored(s, rules);
  for (const o of s.orders) total += o.amount;
  for (const m of s.mail) {
    if (rules.items[m.item]?.storable) total += m.amount;
  }
  return total;
}

export function initialState(rules: Ruleset): State {
  const items: number[] = [];
  for (let i = 0; i < rules.items.length; i++) items.push(0);

  for (const stack of rules.startingItems) {
    items[stack.item] = (items[stack.item] ?? 0) + stack.amount;
  }

  const plots: Plot[] = [];
  for (const def of rules.plots) {
    const i = plots.length;
    const start = startPlatz(rules, i);
    plots.push({
      level: def.startLevel,
      slots: emptySlots(slotsAt(rules, i, def.startLevel)),
      gx: def.startLevel > 0 || def.fixed ? start.gx : -1,
      gy: def.startLevel > 0 || def.fixed ? start.gy : -1,
      tiere: [],
    });
  }

  const passives: number[] = [];
  for (let i = 0; i < rules.passives.length; i++) passives.push(0);

  const zaehler: number[] = [];
  for (let i = 0; i < ZAEHLER_ANZAHL; i++) zaehler.push(0);

  return {
    tick: 0,
    xp: 0,
    items,
    plots,
    passives,
    orders: [],
    offers: [],
    mail: [],
    nextOrderId: 1,
    requests: [],
    truck: { loaded: [], awayUntil: 0 },
    siloLevel: 0,
    chests: [],
    nextChestId: 1,
    pendingBoxes: [],
    clearedObstacles: [],
    expandiert: [],
    chestReadyAt: 0,
    skipReadyAt: 0,
    claimed: [],
    eingepackt: [],
    angelFang: 0,
    bootRepariert: false,
    angelSpots: [],
    angelKoeder: [],
    zaehler: zaehler,
    serverTag: 0,
    tagNummer: 0,
    tagStart: [],
    tagGeholt: [],
    wochenNummer: 0,
    wochenStart: [],
    wochenGeholt: [],
    xpDoppeltBis: 0,
  };
}

export function startPlatz(rules: Ruleset, plot: number): { gx: number; gy: number } {
  const raster = rules.grid;
  if (!raster) return { gx: -1, gy: -1 };

  const groesse = rules.plots[plot]?.size ?? { w: 1, h: 1 };
  // Direkter Zell-Startplatz hat Vorrang (nötig, sobald das Raster breiter als
  // 100 Spalten ist — dann trifft die Prozent-Angabe nicht mehr jede Zelle).
  const zelle = rules.plots[plot]?.startCell;
  if (zelle) {
    const gx = Math.min(raster.w - groesse.w, zelle.gx);
    const gy = Math.min(raster.h - groesse.h, zelle.gy);
    return { gx: Math.max(0, gx), gy: Math.max(0, gy) };
  }

  const ort = rules.plots[plot]?.place;
  if (!ort) return { gx: -1, gy: -1 };
  const gx = Math.min(raster.w - groesse.w, Math.floor((ort.x * raster.w) / 100));
  const gy = Math.min(raster.h - groesse.h, Math.floor((ort.y * raster.h) / 100));
  return { gx: Math.max(0, gx), gy: Math.max(0, gy) };
}

export function normalizeState(s: State): State {
  const plots = s.plots.map((p) => {
    const mitRaster = (x: Plot): Plot => ({
      ...x,
      gx: x.gx === undefined ? -1 : x.gx,
      gy: x.gy === undefined ? -1 : x.gy,
      tiere: x.tiere ?? [],
    });
    if (Array.isArray((p as { slots?: unknown }).slots)) return mitRaster(p);
    const alt = p as unknown as { level: number; recipe?: number; startedAt?: number };
    if (alt.level <= 0) return { level: alt.level, slots: [], gx: -1, gy: -1, tiere: [] };
    return mitRaster({
      level: alt.level,
      slots: [{ recipe: alt.recipe ?? EMPTY_PLOT, startedAt: alt.startedAt ?? 0 }],
      gx: -1,
      gy: -1,
      tiere: [],
    });
  });

  return {
    ...s,
    plots,
    xp: s.xp ?? 0,
    orders: (s.orders ?? []).map((o) => ({ ...o, verkauft: o.verkauft ?? 0 })),
    offers: (s.offers ?? []).map((o) => ({
      ...o,
      seller: o.seller ?? '',
      hof: o.hof ?? '',
      headline: o.headline ?? false,
    })),
    mail: s.mail ?? [],
    requests: (s.requests ?? []).map((r) => (r.dest === undefined ? { ...r, dest: 0 } : r)),
    skipReadyAt: s.skipReadyAt ?? 0,
    truck: s.truck ?? { loaded: [], awayUntil: 0 },
    siloLevel: s.siloLevel ?? 0,
    chests: (s.chests ?? []).map((k) => ({ ...k, gx: k.gx ?? -1, gy: k.gy ?? -1 })),
    nextChestId: s.nextChestId ?? 1,
    pendingBoxes: s.pendingBoxes ?? [],
    clearedObstacles: s.clearedObstacles ?? [],
    expandiert: s.expandiert ?? [],
    chestReadyAt: s.chestReadyAt ?? 0,
    claimed: s.claimed ?? [],
    eingepackt: s.eingepackt ?? [],
    angelFang: s.angelFang ?? 0,
    bootRepariert: s.bootRepariert ?? false,
    angelSpots: s.angelSpots ?? [],
    angelKoeder: s.angelKoeder ?? [],
    zaehler: s.zaehler ?? [],
    serverTag: s.serverTag ?? 0,
    tagNummer: s.tagNummer ?? 0,
    tagStart: s.tagStart ?? [],
    tagGeholt: s.tagGeholt ?? [],
    wochenNummer: s.wochenNummer ?? 0,
    wochenStart: s.wochenStart ?? [],
    wochenGeholt: s.wochenGeholt ?? [],
    xpDoppeltBis: s.xpDoppeltBis ?? 0,
  };
}

export function cloneState(s: State): State {
  return {
    tick: s.tick,
    xp: s.xp,
    items: s.items,
    plots: s.plots,
    passives: s.passives,
    orders: s.orders,
    offers: s.offers,
    mail: s.mail,
    nextOrderId: s.nextOrderId,
    requests: s.requests,
    truck: s.truck,
    siloLevel: s.siloLevel,
    chests: s.chests,
    nextChestId: s.nextChestId,
    pendingBoxes: s.pendingBoxes,
    clearedObstacles: s.clearedObstacles,
    expandiert: s.expandiert ?? [],
    chestReadyAt: s.chestReadyAt,
    skipReadyAt: s.skipReadyAt,
    claimed: s.claimed ?? [],
    eingepackt: s.eingepackt ?? [],
    angelFang: s.angelFang ?? 0,
    bootRepariert: s.bootRepariert ?? false,
    angelSpots: s.angelSpots ?? [],
    angelKoeder: s.angelKoeder ?? [],
    zaehler: s.zaehler ?? [],
    serverTag: s.serverTag ?? 0,
    tagNummer: s.tagNummer ?? 0,
    tagStart: s.tagStart ?? [],
    tagGeholt: s.tagGeholt ?? [],
    wochenNummer: s.wochenNummer ?? 0,
    wochenStart: s.wochenStart ?? [],
    wochenGeholt: s.wochenGeholt ?? [],
    xpDoppeltBis: s.xpDoppeltBis ?? 0,
  };
}

export function replaceAt<T>(list: readonly T[], index: number, value: T): T[] {
  const next = list.slice();
  next[index] = value;
  return next;
}

export function addItem(items: readonly number[], item: number, delta: number): number[] {
  const next = items.slice();
  next[item] = (next[item] ?? 0) + delta;
  return next;
}

export function addItems(items: readonly number[], changes: readonly [number, number][]): number[] {
  const next = items.slice();
  for (const [item, delta] of changes) next[item] = (next[item] ?? 0) + delta;
  return next;
}

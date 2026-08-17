/**
 * Der Spielzustand. Ausschließlich Integer — keine Floats, keine Systemzeit,
 * keine Plattform-APIs (Architektur §2.2). Nur so rechnen Handy und Server
 * bit-für-bit dasselbe.
 *
 * Der Zustand kennt keine Gegenstandsnamen. Er speichert **Indizes in den
 * Katalog** des Regelwerks: Das Inventar ist ein Zahlenarray in
 * Katalogreihenfolge, ein Platz merkt sich eine Rezeptnummer.
 *
 * Zwei Gründe dafür, und beide sind hart:
 *
 *  1. **Deterministisch serialisierbar ohne Sortierfrage.** Eine Map von Namen
 *     auf Mengen müsste erst in eine kanonische Reihenfolge gebracht werden —
 *     eine zusätzliche Stelle, an der zwei Plattformen abweichen können (R1).
 *  2. **Inhalt bleibt billig.** Ein neuer Gegenstand hängt eine Zeile an den
 *     Katalog und einen Eintrag ans Inventar. Kein Code, kein neues Feld.
 *
 * Der Preis steht in `rules.ts`: Kataloge sind append-only.
 */

import type { Ruleset } from './rules.ts';
import { derivedTables } from './rules.ts';

/**
 * Ein Produktionsplatz im Zustand.
 *
 * `level === 0` heißt: gehört dem Spieler noch nicht — hier lässt sich nichts
 * starten, bis er ihn kauft. Höhere Stufen schalten Rezepte frei (ein leeres
 * Gehege ist Stufe 1, mit Hühnern Stufe 2).
 *
 * `recipe === EMPTY_PLOT` heißt: nichts läuft gerade; dann ist `startedAt`
 * bedeutungslos und per Konvention 0, damit der kanonische String eindeutig
 * bleibt.
 */
export type Plot = {
  level: number;
  recipe: number;
  startedAt: number;
};

export const EMPTY_PLOT = -1;

/**
 * Ein offener Verkaufsauftrag. Die Ware liegt hier — nicht mehr im Lager,
 * aber auch noch nicht verkauft (§8).
 */
export type Order = {
  id: number;
  /** Katalogindex. */
  item: number;
  amount: number;
  price: number;
  listedAt: number;
};

/**
 * Ein Eintrag im Postfach.
 *
 * Auch Münzen sind ein Katalog-Gegenstand — sie sind nur nicht lagerpflichtig.
 * Damit braucht das Postfach keinen Sonderfall für Geld, und die Regel „was
 * nicht ins Lager passt, bleibt liegen" gilt uniform (§7).
 */
export type MailItem = {
  item: number;
  amount: number;
  arrivedAt: number;
};

export type State = {
  /** Spielzeit in Ticks. NIE die Geräteuhr (§4). */
  tick: number;
  /** Bestände in Katalogreihenfolge. Länge == `rules.items.length`. */
  items: readonly number[];
  /** Produktionsplätze in Ruleset-Reihenfolge. Länge == `rules.plots.length`. */
  plots: readonly Plot[];
  /**
   * Angesparte Ticks je passivem Produzenten. Immer < Taktung.
   *
   * Muss Teil des Zustands sein, sonst ist die Produktion über Segmentgrenzen
   * hinweg nicht reproduzierbar (§7).
   */
  passives: readonly number[];
  /** Offene Verkaufsaufträge (Escrow). Durch `orderSlots` hart begrenzt (§8). */
  orders: readonly Order[];
  /** Postfach: was von außen kam oder aus verfallenen Aufträgen zurückfiel (§7). */
  mail: readonly MailItem[];
  nextOrderId: number;
};

/** Bestand eines Gegenstands. Unbekannter Index → 0, nie `undefined`. */
export function count(s: State, item: number): number {
  return s.items[item] ?? 0;
}

/** Belegter Lagerplatz. Das Limit gilt über alle lagerpflichtigen Waren zusammen (§7). */
export function stored(s: State, rules: Ruleset): number {
  return storedIn(s.items, rules);
}

/**
 * Dasselbe für ein Inventar, das noch nicht in einem Zustand steckt.
 *
 * Wird beim Postfach-Abholen gebraucht: Dort wächst das Inventar Eintrag für
 * Eintrag, und jeder muss gegen den freien Platz geprüft werden.
 */
export function storedIn(items: readonly number[], rules: Ruleset): number {
  const { storable } = derivedTables(rules);
  let total = 0;
  for (const i of storable) total += items[i] ?? 0;
  return total;
}

export function spaceLeft(s: State, rules: Ruleset): number {
  return rules.siloCapacity - stored(s, rules);
}

/**
 * Alle lagerpflichtigen Waren, die dem Spieler gehören — über ALLE Behälter.
 *
 * Die Invariante aus §7 lautet: Jeder Ort, an dem ein Gut liegen kann, ist
 * begrenzt. Damit ist auch diese Summe beschränkt, und das Lagerlimit bleibt
 * als Inflationsbremse wirksam.
 */
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

  const plots: Plot[] = [];
  for (const def of rules.plots) {
    plots.push({ level: def.startLevel, recipe: EMPTY_PLOT, startedAt: 0 });
  }

  const passives: number[] = [];
  for (let i = 0; i < rules.passives.length; i++) passives.push(0);

  return { tick: 0, items, plots, passives, orders: [], mail: [], nextOrderId: 1 };
}

/**
 * Flache Kopie — die Arrays werden GETEILT, nicht kopiert.
 *
 * Der Grund ist Skalierung: Bei einer Tiefkopie kostet jedes einzelne Command
 * den gesamten Zustand. Bei sechs Feldern fällt das nicht auf, bei einem Spiel
 * mit tausenden Objekten wird der Sync dadurch teuer — obwohl ein Command
 * fast immer nur ein einziges Ding anfasst.
 *
 * Preis dieser Entscheidung: **Arrays dürfen nie an Ort und Stelle verändert
 * werden.** Wer etwas ändert, ersetzt das Array (siehe `replaceAt`). Sonst
 * schlüge die Änderung auf ältere Zustände durch — und die Sim wäre keine
 * reine Funktion mehr. Der Session-Fuzz und die Golden Vectors fangen solche
 * Fehler zuverlässig, weil sie Zustände über viele Schritte vergleichen.
 */
export function cloneState(s: State): State {
  return {
    tick: s.tick,
    items: s.items,
    plots: s.plots,
    passives: s.passives,
    orders: s.orders,
    mail: s.mail,
    nextOrderId: s.nextOrderId,
  };
}

/** Ein Element ersetzen, ohne das Original anzufassen. Eine Kopie statt N. */
export function replaceAt<T>(list: readonly T[], index: number, value: T): T[] {
  const next = list.slice();
  next[index] = value;
  return next;
}

/**
 * Bestand ändern und das neue Inventar zurückgeben.
 *
 * Gibt bewusst ein Array zurück statt den Zustand zu verändern — dieselbe
 * Copy-on-Write-Disziplin wie überall sonst.
 */
export function addItem(items: readonly number[], item: number, delta: number): number[] {
  const next = items.slice();
  next[item] = (next[item] ?? 0) + delta;
  return next;
}

/** Mehrere Bestände auf einmal ändern — eine Kopie statt einer pro Zutat. */
export function addItems(items: readonly number[], changes: readonly [number, number][]): number[] {
  const next = items.slice();
  for (const [item, delta] of changes) next[item] = (next[item] ?? 0) + delta;
  return next;
}

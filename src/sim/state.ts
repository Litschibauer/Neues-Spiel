/**
 * Der Spielzustand. Ausschließlich Integer — keine Floats, keine Systemzeit,
 * keine Plattform-APIs (Architektur §2.2). Nur so rechnen Handy und Server
 * bit-für-bit dasselbe.
 */

export type Crop = 'wheat';

export type Field = {
  /** null = leer */
  crop: Crop | null;
  /** Tick, zu dem gepflanzt wurde. Nur gültig wenn crop != null. */
  plantedAt: number;
};

export type Good = 'wheat' | 'eggs';

/**
 * Ein offener Verkaufsauftrag. Die Ware liegt hier — nicht mehr im Lager,
 * aber auch noch nicht verkauft (§8).
 */
export type Order = {
  id: number;
  item: Good;
  amount: number;
  price: number;
  listedAt: number;
};

/** Ein Eintrag im Postfach. Gold zählt nicht gegen das Lagerlimit. */
export type MailItem = {
  item: Good | 'gold';
  amount: number;
  arrivedAt: number;
};

export type State = {
  /** Spielzeit in Ticks. NIE die Geräteuhr (§4). */
  tick: number;
  fields: Field[];
  wheat: number;
  eggs: number;
  gold: number;
  /**
   * Zum nächsten Ei angesparte Ticks. Immer < coopTicksPerEgg.
   * Muss Teil des Zustands sein, sonst ist die Produktion über
   * Segmentgrenzen hinweg nicht reproduzierbar (§7).
   */
  coopProgress: number;
  /** Offene Verkaufsaufträge (Escrow). Durch `orderSlots` hart begrenzt (§8). */
  orders: Order[];
  /** Postfach: was von außen kam oder aus verfallenen Aufträgen zurückfiel (§7). */
  mail: MailItem[];
  nextOrderId: number;
};

/** Belegter Lagerplatz. Das Limit gilt über alle Warenarten zusammen (§7). */
export function stored(s: State): number {
  return s.wheat + s.eggs;
}

/**
 * Alle Waren, die dem Spieler gehören — über ALLE Behälter hinweg.
 *
 * Die Invariante aus §7 lautet: Jeder Ort, an dem ein Gut liegen kann, ist
 * begrenzt. Damit ist auch diese Summe beschränkt, und das Lagerlimit bleibt
 * als Inflationsbremse wirksam.
 */
export function totalGoods(s: State): number {
  let total = s.wheat + s.eggs;
  for (const o of s.orders) total += o.amount;
  for (const m of s.mail) if (m.item !== 'gold') total += m.amount;
  return total;
}

export function spaceLeft(s: State, capacity: number): number {
  return capacity - stored(s);
}

export function initialState(fieldCount: number): State {
  const fields: Field[] = [];
  for (let i = 0; i < fieldCount; i++) fields.push({ crop: null, plantedAt: 0 });
  return {
    tick: 0,
    fields,
    wheat: 0,
    eggs: 0,
    gold: 0,
    coopProgress: 0,
    orders: [],
    mail: [],
    nextOrderId: 1,
  };
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
    fields: s.fields,
    wheat: s.wheat,
    eggs: s.eggs,
    gold: s.gold,
    coopProgress: s.coopProgress,
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

/** Tiefkopie — nur dort, wo wirklich alles unabhängig sein muss (Tests, Migration). */
export function deepCloneState(s: State): State {
  return {
    ...cloneState(s),
    fields: s.fields.map((f) => ({ crop: f.crop, plantedAt: f.plantedAt })),
    orders: s.orders.map((o) => ({ ...o })),
    mail: s.mail.map((m) => ({ ...m })),
  };
}

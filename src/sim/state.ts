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
};

/** Belegter Lagerplatz. Das Limit gilt über alle Warenarten zusammen (§7). */
export function stored(s: State): number {
  return s.wheat + s.eggs;
}

export function spaceLeft(s: State, capacity: number): number {
  return capacity - stored(s);
}

export function initialState(fieldCount: number): State {
  const fields: Field[] = [];
  for (let i = 0; i < fieldCount; i++) fields.push({ crop: null, plantedAt: 0 });
  return { tick: 0, fields, wheat: 0, eggs: 0, gold: 0, coopProgress: 0 };
}

export function cloneState(s: State): State {
  return {
    tick: s.tick,
    fields: s.fields.map((f) => ({ crop: f.crop, plantedAt: f.plantedAt })),
    wheat: s.wheat,
    eggs: s.eggs,
    gold: s.gold,
    coopProgress: s.coopProgress,
  };
}

/**
 * Ruleset-Migration (Risiko R2, Architektur §9).
 *
 * Das Grundproblem: Live-Service heißt ständige Balance-Patches, aber jede
 * Regeländerung ändert das deterministische Ergebnis. Ein Spieler, der offline
 * unter alten Regeln gespielt hat, darf NICHT unter neuen nachgerechnet werden —
 * sonst weicht der Server garantiert von seinem Client ab (R1).
 *
 * Die Auflösung besteht aus drei Teilen:
 *
 *  1. Der Log wird immer unter der Version validiert, unter der er entstanden ist.
 *  2. ERST DANACH wird der Zustand auf die neue Version gehoben — an einer
 *     definierten Grenze, nämlich am Sync.
 *  3. Migration passiert ausschließlich SERVERSEITIG. Der Client bekommt das
 *     Ergebnis fertig im Snapshot und rechnet nie selbst um. Damit kann die
 *     Migration gar nicht erst zwischen Client und Server divergieren.
 *
 * Leitprinzip für jede Migration: **Nie schlechter als ein Neuanfang unter den
 * neuen Regeln, nie besser als das, was der Spieler schon hatte.**
 */

import type { Ruleset } from './rules.ts';
import { getRuleset } from './rules.ts';
import type { State } from './state.ts';
import { cloneState, stored } from './state.ts';

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export type MigrationStep = (state: State, from: Ruleset, to: Ruleset) => State;

/**
 * Rechnet laufende Wachstumszeiten um, wenn sich die Wachstumsdauer ändert.
 *
 * Regel: Die verbleibende Zeit bleibt erhalten — gedeckelt auf die neue
 * Gesamtdauer. Konkret:
 *
 *   - halb gewachsen  → behält seine Restzeit
 *   - frisch gepflanzt → startet neu mit der (kürzeren) neuen Dauer, profitiert
 *                        also vom Buff statt darauf sitzen zu bleiben
 *   - reif             → bleibt reif
 *
 * So verliert niemand Fortschritt, und niemand bekommt etwas geschenkt, das
 * über einen frischen Start hinausgeht.
 */
function rescaleGrowth(state: State, from: Ruleset, to: Ruleset): State {
  if (from.wheatGrowTicks === to.wheatGrowTicks) return state;

  const next = cloneState(state);
  next.fields = state.fields.map((f) => {
    if (f.crop === null) return { crop: null, plantedAt: 0 };

    const elapsed = state.tick - f.plantedAt;
    const remaining = Math.max(0, from.wheatGrowTicks - elapsed);
    const newRemaining = Math.min(remaining, to.wheatGrowTicks);
    return { crop: f.crop, plantedAt: state.tick - (to.wheatGrowTicks - newRemaining) };
  });
  return next;
}

/** Hält den Stall-Fortschritt im gültigen Bereich, wenn sich das Intervall ändert. */
function clampCoopProgress(state: State, _from: Ruleset, to: Ruleset): State {
  if (state.coopProgress < to.coopTicksPerEgg) return state;
  const next = cloneState(state);
  next.coopProgress = to.coopTicksPerEgg - 1;
  return next;
}

const V1_TO_V2: MigrationStep = (state, from, to) =>
  clampCoopProgress(rescaleGrowth(state, from, to), from, to);

/** Ein Schritt pro Versionssprung. Migrationen werden der Reihe nach angewandt. */
export const MIGRATIONS: ReadonlyMap<string, MigrationStep> = new Map([['1->2', V1_TO_V2]]);

/**
 * Prüft, dass ein Zustand nach den gegebenen Regeln überhaupt gültig ist.
 *
 * Eine Migration, die einen ungültigen Zustand erzeugt, ist schlimmer als gar
 * keine: Sie bringt Spieler in Situationen, die die Sim nie herstellen könnte,
 * und lässt danach Aktionen scheitern, die eigentlich erlaubt sein müssten.
 */
export function assertInvariants(state: State, rules: Ruleset): void {
  const problems: string[] = [];

  if (stored(state) > rules.siloCapacity) {
    problems.push(`Lager über Limit: ${stored(state)} > ${rules.siloCapacity}`);
  }

  // Die Behälter-Invariante aus §7: JEDER Ort, an dem Ware liegen kann, ist
  // begrenzt. Ein einziger ungedeckelter Behälter macht das Lagerlimit — und
  // damit die Inflationsbremse — wertlos.
  if (state.orders.length > rules.orderSlots) {
    problems.push(`zu viele Aufträge: ${state.orders.length} > ${rules.orderSlots}`);
  }
  if (state.mail.length > rules.mailCapacity) {
    problems.push(`Postfach über Limit: ${state.mail.length} > ${rules.mailCapacity}`);
  }
  for (const o of state.orders) {
    if (o.amount <= 0) problems.push(`Auftrag ${o.id} ohne Ware`);
    if (o.listedAt > state.tick) problems.push(`Auftrag ${o.id} aus der Zukunft`);
    if (o.id >= state.nextOrderId) problems.push(`Auftrags-ID ${o.id} nicht vergeben`);
  }
  for (const m of state.mail) {
    if (m.amount <= 0) problems.push('Postfach-Eintrag ohne Inhalt');
  }
  if (state.coopProgress < 0 || state.coopProgress >= rules.coopTicksPerEgg) {
    problems.push(`coopProgress außerhalb [0, ${rules.coopTicksPerEgg}): ${state.coopProgress}`);
  }
  if (state.wheat < 0 || state.eggs < 0 || state.gold < 0) {
    problems.push('negative Bestände');
  }

  for (const [i, f] of state.fields.entries()) {
    if (f.crop !== null && f.plantedAt > state.tick) {
      problems.push(`Feld ${i} in der Zukunft gepflanzt: ${f.plantedAt} > ${state.tick}`);
    }
  }

  const numbers = [state.tick, state.wheat, state.eggs, state.gold, state.coopProgress];
  for (const n of numbers) {
    if (!Number.isSafeInteger(n)) problems.push(`kein sicherer Integer: ${n}`);
  }
  for (const f of state.fields) {
    if (!Number.isSafeInteger(f.plantedAt)) problems.push(`plantedAt kein Integer: ${f.plantedAt}`);
  }

  if (problems.length > 0) {
    throw new MigrationError(`ungültiger Zustand: ${problems.join('; ')}`);
  }
}

/**
 * Hebt einen Zustand von `fromVersion` auf `toVersion`, Sprung für Sprung.
 *
 * Bewusst kein Sprung über mehrere Versionen auf einmal: Jeder Schritt ist für
 * sich testbar, und ein Spieler, der drei Patches verschlafen hat, läuft durch
 * dieselben Schritte wie alle anderen — nur hintereinander.
 */
export function migrateState(state: State, fromVersion: number, toVersion: number): State {
  if (toVersion === fromVersion) return state;
  if (toVersion < fromVersion) {
    // Downgrades gibt es nicht. Ein Rollback des Servers auf eine ältere
    // Version braucht einen bewussten Plan, keine automatische Umrechnung.
    throw new MigrationError(`Downgrade ${fromVersion} → ${toVersion} wird nicht unterstützt`);
  }

  let current = state;
  for (let v = fromVersion; v < toVersion; v++) {
    const step = MIGRATIONS.get(`${v}->${v + 1}`);
    if (!step) throw new MigrationError(`keine Migration für ${v} → ${v + 1}`);

    const from = getRuleset(v);
    const to = getRuleset(v + 1);
    current = step(current, from, to);
    assertInvariants(current, to);
  }

  return current;
}

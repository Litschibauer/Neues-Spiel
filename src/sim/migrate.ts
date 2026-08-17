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
import { getRuleset, levelRecipes } from './rules.ts';
import type { State } from './state.ts';
import { EMPTY_PLOT, cloneState, stored } from './state.ts';

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export type MigrationStep = (state: State, from: Ruleset, to: Ruleset) => State;

/**
 * Rechnet laufende Produktionszeiten um, wenn sich eine Rezeptdauer ändert.
 *
 * Regel: Die verbleibende Zeit bleibt erhalten — gedeckelt auf die neue
 * Gesamtdauer. Konkret:
 *
 *   - halb fertig     → behält seine Restzeit
 *   - frisch gestartet → startet neu mit der (kürzeren) neuen Dauer, profitiert
 *                        also vom Buff statt darauf sitzen zu bleiben
 *   - fertig           → bleibt fertig
 *
 * So verliert niemand Fortschritt, und niemand bekommt etwas geschenkt, das
 * über einen frischen Start hinausgeht. Gilt für Felder, Mühlen und Backöfen
 * gleichermaßen — es ist derselbe Platz mit demselben Timer.
 */
function rescaleDurations(state: State, from: Ruleset, to: Ruleset): State {
  let changed = false;
  const plots = state.plots.map((p) => {
    if (p.recipe === EMPTY_PLOT) return p;

    const before = from.recipes[p.recipe]?.durationTicks;
    const after = to.recipes[p.recipe]?.durationTicks;
    if (before === undefined || after === undefined || before === after) return p;

    changed = true;
    const elapsed = state.tick - p.startedAt;
    const remaining = Math.max(0, before - elapsed);
    const newRemaining = Math.min(remaining, after);
    return { level: p.level, recipe: p.recipe, startedAt: state.tick - (after - newRemaining) };
  });

  if (!changed) return state;
  const next = cloneState(state);
  next.plots = plots;
  return next;
}

/** Hält den Fortschritt passiver Plätze im gültigen Bereich, wenn sich die Taktung ändert. */
function clampPassives(state: State, _from: Ruleset, to: Ruleset): State {
  let changed = false;
  const passives = state.passives.map((progress, i) => {
    const passive = to.passives[i];
    if (!passive) return progress;
    const interval = to.recipes[passive.recipe]!.durationTicks;
    if (progress < interval) return progress;
    changed = true;
    return interval - 1;
  });

  if (!changed) return state;
  const next = cloneState(state);
  next.passives = passives;
  return next;
}

/**
 * Der reine Zahlen-Patch: Zeiten ändern sich, die Form des Zustands nicht.
 */
export const RETIME: MigrationStep = (state, from, to) =>
  clampPassives(rescaleDurations(state, from, to), from, to);

/**
 * Der Inhalts-Patch: Der Zustand WÄCHST.
 *
 * Ein neuer Gegenstand verlängert das Inventar, ein neues Feld die Platzliste,
 * eine neue Weide die Fortschrittsliste. Weil Kataloge append-only sind
 * (`rules.ts`), genügt Auffüllen mit Nullen: Bestehende Indizes behalten ihre
 * Bedeutung, alles Neue startet leer.
 *
 * Das ist der ehrlichere Test für R2 als jeder Zahlen-Patch — hier ändert sich
 * die *Form* des Zustands, nicht nur sein Inhalt.
 */
export const GROW: MigrationStep = (state, from, to) => {
  if (
    to.items.length === state.items.length &&
    to.plots.length === state.plots.length &&
    to.passives.length === state.passives.length
  ) {
    return state;
  }
  if (
    to.items.length < state.items.length ||
    to.plots.length < state.plots.length ||
    to.passives.length < state.passives.length
  ) {
    // Schrumpfen ist keine Auffüll-Migration: Wohin mit den Beständen, wohin
    // mit der laufenden Produktion? Das braucht einen bewussten Plan.
    throw new MigrationError(`v${from.version} → v${to.version}: Katalog schrumpft`);
  }

  const next = cloneState(state);

  const items = state.items.slice();
  while (items.length < to.items.length) items.push(0);
  next.items = items;

  const plots = state.plots.slice();
  // Neue Plätze kommen mit ihrer Startstufe dazu — ein Patch, der ein Feld
  // geschenkt hinzufügt, tut das damit auch für bestehende Höfe.
  while (plots.length < to.plots.length) {
    plots.push({ level: to.plots[plots.length]!.startLevel, recipe: EMPTY_PLOT, startedAt: 0 });
  }
  next.plots = plots;

  const passives = state.passives.slice();
  while (passives.length < to.passives.length) passives.push(0);
  next.passives = passives;

  return next;
};

/** Inhalt dazu UND Zeiten anpassen — die beiden Bausteine hintereinander. */
export const GROW_AND_RETIME: MigrationStep = (state, from, to) =>
  RETIME(GROW(state, from, to), from, to);

/** Ein Schritt pro Versionssprung. Migrationen werden der Reihe nach angewandt. */
export const MIGRATIONS: ReadonlyMap<string, MigrationStep> = new Map([
  // Der Basis-Kreislauf hat bisher genau einen Patch: einen reinen Zahlen-Patch.
  // `GROW_AND_RETIME` steht bereit, sobald der erste Inhalts-Patch kommt — und
  // ist über synthetische Kataloge in `migration.test.ts` geprüft, damit der
  // Pfad nicht ungetestet verrottet.
  ['1->2', RETIME],
]);

/**
 * Prüft, dass ein Zustand nach den gegebenen Regeln überhaupt gültig ist.
 *
 * Eine Migration, die einen ungültigen Zustand erzeugt, ist schlimmer als gar
 * keine: Sie bringt Spieler in Situationen, die die Sim nie herstellen könnte,
 * und lässt danach Aktionen scheitern, die eigentlich erlaubt sein müssten.
 */
export function assertInvariants(state: State, rules: Ruleset): void {
  const problems: string[] = [];

  // ── Form: Zustand und Katalog müssen zusammenpassen ──────────────────
  //
  // Seit Inhalt Daten ist, ist DAS die erste Bruchstelle: Ein Inventar mit
  // fünf Einträgen unter einem Katalog mit sechs bedeutet, dass ein Index
  // stillschweigend fehlt — und dann wandert die Bedeutung aller Zahlen.
  if (state.items.length !== rules.items.length) {
    problems.push(`Inventar ${state.items.length} != Katalog ${rules.items.length}`);
  }
  if (state.plots.length !== rules.plots.length) {
    problems.push(`Plätze ${state.plots.length} != Regelwerk ${rules.plots.length}`);
  }
  if (state.passives.length !== rules.passives.length) {
    problems.push(`Passive ${state.passives.length} != Regelwerk ${rules.passives.length}`);
  }

  if (stored(state, rules) > rules.siloCapacity) {
    problems.push(`Lager über Limit: ${stored(state, rules)} > ${rules.siloCapacity}`);
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
    if (!rules.items[o.item]) problems.push(`Auftrag ${o.id}: Gegenstand ${o.item} unbekannt`);
  }
  for (const m of state.mail) {
    if (m.amount <= 0) problems.push('Postfach-Eintrag ohne Inhalt');
    if (!rules.items[m.item]) problems.push(`Postfach: Gegenstand ${m.item} unbekannt`);
  }

  for (const [i, progress] of state.passives.entries()) {
    const passive = rules.passives[i];
    if (!passive) continue;
    const interval = rules.recipes[passive.recipe]!.durationTicks;
    if (progress < 0 || progress >= interval) {
      problems.push(`Fortschritt ${passive.id} außerhalb [0, ${interval}): ${progress}`);
    }
  }

  for (const [i, value] of state.items.entries()) {
    if (value < 0) problems.push(`negativer Bestand bei ${rules.items[i]?.id ?? i}`);
    if (!Number.isSafeInteger(value)) problems.push(`kein sicherer Integer: ${value}`);
  }
  if (!Number.isSafeInteger(state.tick)) problems.push(`tick kein sicherer Integer: ${state.tick}`);

  for (const [i, p] of state.plots.entries()) {
    const def = rules.plots[i];
    if (!def) continue;
    if (!Number.isInteger(p.level) || p.level < 0 || p.level > def.levels.length) {
      problems.push(`Platz ${i}: Stufe ${p.level} außerhalb von [0, ${def.levels.length}]`);
    }

    if (p.recipe === EMPTY_PLOT) continue;
    if (!rules.recipes[p.recipe]) {
      problems.push(`Platz ${i}: Rezept ${p.recipe} gibt es nicht`);
    } else if (!levelRecipes(rules, i, p.level).includes(p.recipe)) {
      problems.push(`Platz ${i}: Rezept ${p.recipe} ist auf Stufe ${p.level} nicht erlaubt`);
    }
    if (p.startedAt > state.tick) {
      problems.push(`Platz ${i} in der Zukunft gestartet: ${p.startedAt} > ${state.tick}`);
    }
    if (!Number.isSafeInteger(p.startedAt)) problems.push(`startedAt kein Integer: ${p.startedAt}`);
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

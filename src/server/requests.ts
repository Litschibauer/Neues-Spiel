/**
 * Kundenaufträge nachfüllen — die Serverseite von M6.
 *
 * Diese Datei liegt bewusst **außerhalb des Sim-Kerns**. Hier wird gewürfelt,
 * und Würfeln gehört dem Server (§5). Der Sim-Kern liest fertige Aufträge aus
 * dem Zustand und verbraucht sie; er erzeugt nie welche.
 *
 * Damit ist beides gleichzeitig wahr:
 *
 *  - **Aufträge sind zufällig** — sonst wären es immer dieselben.
 *  - **Aufträge sind offline erfüllbar** — sie liegen schon im Snapshot.
 *
 * Das ist genau das Muster „Vorrat statt Verbindung" aus Architektur §6: Der
 * Server gibt einen Stapel mit, der Client arbeitet ihn im Funkloch ab, beim
 * nächsten Sync wird aufgefüllt. Offline gehen die Aufträge nie aus.
 */

import type { Ruleset } from '../sim/rules.ts';
import { levelRecipes } from '../sim/rules.ts';
import type { Request, State } from '../sim/state.ts';

/**
 * Welche Gegenstände dieser Hof überhaupt herstellen kann.
 *
 * Ohne diese Prüfung bekäme ein frischer Hof Aufträge über Eier, obwohl er
 * noch kein Gehege hat — drei blockierte Slots und nichts zu tun. Genau der
 * Leerlauf, den die Regel aus §6 verbietet.
 *
 * Geschlossene Hülle: Was man herstellen kann, ermöglicht weitere Rezepte.
 */
export function reachableItems(state: State, rules: Ruleset): Set<number> {
  const reachable = new Set<number>();

  /**
   * Der Anfang der Kette: was man hat oder kaufen kann.
   *
   * Vorher begann die Hülle bei den Rezepten ohne Zutaten — solange Weizen aus
   * dem Nichts kam, ging das auf. Seit Säen ein Korn kostet, verbraucht das
   * Weizenrezept sein eigenes Erzeugnis, und die Hülle blieb schlicht leer: Ein
   * frischer Hof bekam gar keine Aufträge mehr.
   *
   * Richtig ist die weitere Frage — nicht „was entsteht aus dem Nichts",
   * sondern „woran kommt dieser Hof heran": an alles im Lager, und an alles,
   * was der Händler führt.
   */
  rules.items.forEach((item, i) => {
    if (item.npcBuyPrice > 0) reachable.add(i);
    else if ((state.items[i] ?? 0) > 0) reachable.add(i);
  });

  // Rezepte, die auf einem freigeschalteten Platz laufen dürfen.
  const available: number[] = [];
  state.plots.forEach((plot, i) => {
    for (const recipe of levelRecipes(rules, i, plot.level)) {
      if (!available.includes(recipe)) available.push(recipe);
    }
  });
  for (const passive of rules.passives) {
    if (!available.includes(passive.recipe)) available.push(passive.recipe);
  }

  // Solange sich etwas ändert: Rezepte anwenden, deren Zutaten erreichbar sind.
  let grew = true;
  while (grew) {
    grew = false;
    for (const index of available) {
      const recipe = rules.recipes[index]!;
      if (reachable.has(recipe.output.item)) continue;
      if (recipe.inputs.every((input) => reachable.has(input.item))) {
        reachable.add(recipe.output.item);
        grew = true;
      }
    }
  }

  return reachable;
}

/**
 * Füllt die Auftragsschlange auf, ohne bestehende Aufträge anzufassen.
 *
 * Die Reihenfolge bleibt erhalten: Neues wird hinten angehängt. Vorne stehen
 * also weiter die Aufträge, die der Spieler schon gesehen hat — sonst würde
 * ihm ein Sync die Auswahl unter den Fingern wegziehen.
 *
 * `rnd` ist einspeisbar, damit Tests reproduzierbar sind.
 */
export function topUpRequests(
  state: State,
  rules: Ruleset,
  nextId: number,
  rnd: () => number = Math.random,
): { requests: Request[]; nextId: number } {
  const requests = [...state.requests];
  if (requests.length >= rules.requestQueueMax) return { requests, nextId };

  const reachable = reachableItems(state, rules);
  const usable = rules.requestTemplates.filter((t) =>
    t.wants.every((w) => reachable.has(w.item)),
  );
  // Kann der Hof noch gar nichts, gibt es auch nichts zu liefern.
  if (usable.length === 0) return { requests, nextId };

  let id = nextId;
  while (requests.length < rules.requestQueueMax) {
    const template = usable[Math.floor(rnd() * usable.length)]!;
    requests.push({
      id,
      wants: template.wants.map((w) => ({ item: w.item, amount: w.amount })),
      reward: template.reward.map((r) => ({ item: r.item, amount: r.amount })),
      xp: template.xp,
    });
    id++;
  }

  return { requests, nextId: id };
}

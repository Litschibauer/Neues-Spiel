/**
 * Gedeckelte passive Produktion (Architektur §7).
 *
 * Das ist die gefährlichste Stelle des ganzen Konzepts: Wenn Client und Server
 * die Akkumulation über eine lange Offline-Phase auch nur minimal unterschiedlich
 * rechnen, divergieren sie — und ein *ehrlicher* Spieler bekommt einen Rollback (R1).
 *
 * Deshalb gibt es hier genau EINE produktive Implementierung (`advancePassives`),
 * die auf Client und Server identisch läuft. Die beiden anderen Funktionen sind
 * ausschließlich Testwerkzeug:
 *   - `advancePassivesReference` = Tick-für-Tick-Grundwahrheit, gegen die wir fuzzen
 *   - `advancePassivesNaive`     = der realistische Bug, den wir vermeiden wollen
 *
 * ── Warum mehrere Produzenten die Sache härter machen ───────────────────────
 *
 * Ein Hühnerstall allein ist einfach. Sobald Stall und Weide sich EINEN Lager-
 * deckel teilen, hängt das Ergebnis daran, wessen Einheit zuerst fertig wird —
 * und das ist eine Frage der Zeitachse, nicht der Reihenfolge in einer Liste.
 *
 * Semantik (identisch zur Tick-für-Tick-Wahrheit):
 *
 *   1. Alle Produzenten laufen unabhängig, jeder mit seiner eigenen Taktung.
 *   2. Einheiten entstehen in ZEITLICHER Reihenfolge; fallen zwei auf denselben
 *      Tick, entscheidet die Reihenfolge im Regelwerk.
 *   3. Sobald das Lager voll ist, **friert alles ein** — es wird auch kein
 *      Fortschritt mehr angespart. Sonst gäbe es beim Freiräumen einen Schwall
 *      gebunkerter Ware aus dem Nichts.
 *
 * Genau dafür sind passive Rezepte auf „keine Eingaben, Ausgabemenge 1"
 * beschränkt (siehe `PassiveDef`): Damit ist „Lager voll" gleichbedeutend mit
 * „N Einheiten produziert", und der Zeitpunkt des Volllaufens lässt sich in
 * O(log Zeit) finden statt Tick für Tick zu suchen.
 */

export type PassiveResult = {
  /** Produzierte Einheiten je Produzent, in Ruleset-Reihenfolge. */
  produced: number[];
  /** Verbleibender Fortschritt je Produzent. Immer < Taktung. */
  progress: number[];
};

/**
 * Geschlossene Form — O(Produzenten × log Zeit) statt O(vergangene Zeit).
 *
 * Genau das macht den Server-Re-Sim bezahlbar (R4): Zwischen zwei Commands
 * passiert nichts Spielerseitiges, also genügt eine Auswertung pro Segment.
 * Ein Sync kostet damit O(Commands), nicht O(Offline-Dauer).
 *
 * Vorbedingung: `progress[i] < intervals[i]` (Invariante des Zustands).
 */
export function advancePassives(
  elapsed: number,
  progress: readonly number[],
  space: number,
  intervals: readonly number[],
): PassiveResult {
  const n = intervals.length;
  const produced: number[] = [];
  const nextProgress: number[] = [];
  for (let i = 0; i < n; i++) {
    produced.push(0);
    nextProgress.push(progress[i] ?? 0);
  }

  if (n === 0 || elapsed <= 0 || space <= 0) return { produced, progress: nextProgress };

  /** Wie viele Einheiten sind nach `tau` Ticks insgesamt fertig — ohne Deckel. */
  const unitsBy = (tau: number): number => {
    let total = 0;
    for (let i = 0; i < n; i++) {
      total += Math.floor(((progress[i] ?? 0) + tau) / intervals[i]!);
    }
    return total;
  };

  /** Produzent `i` läuft ungestört `tau` Ticks weiter. */
  const settle = (i: number, tau: number): void => {
    const accumulated = (progress[i] ?? 0) + tau;
    const interval = intervals[i]!;
    const units = Math.floor(accumulated / interval);
    produced[i] = units;
    nextProgress[i] = accumulated - units * interval;
  };

  // Die Grenze ist bewusst `<` und nicht `<=`.
  //
  // Bei Gleichstand belegt die letzte Einheit den letzten Platz — ab da ist das
  // Lager voll und alles friert ein, obwohl noch Zeit übrig ist. Diese Zeit darf
  // NICHT angespart werden. Genau dieser Off-by-one war der erste echte Bug im
  // Prototyp; der Fuzz hat ihn bei `elapsed=7604, progress=313, space=8,
  // interval=932` gefunden (461 Ticks aus dem Nichts).
  if (unitsBy(elapsed) < space) {
    for (let i = 0; i < n; i++) settle(i, elapsed);
    return { produced, progress: nextProgress };
  }

  // ── Das Lager läuft voll ────────────────────────────────────────────────
  //
  // Gesucht ist der früheste Tick `full`, an dem die Kapazität erreicht ist.
  // `unitsBy` ist monoton, also per Binärsuche statt Tick für Tick.
  let lo = 1;
  let hi = elapsed;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (unitsBy(mid) >= space) hi = mid;
    else lo = mid + 1;
  }
  const full = lo;

  // Am Tick `full` können mehrere Produzenten gleichzeitig fertig werden, aber
  // nicht alle bekommen noch einen Platz. Sie werden in Ruleset-Reihenfolge
  // bedient; wer den letzten Platz nimmt, ist die Grenze.
  let free = space - unitsBy(full - 1);
  let last = n - 1;
  for (let i = 0; i < n; i++) {
    if (((progress[i] ?? 0) + full) % intervals[i]! === 0) {
      free--;
      if (free === 0) {
        last = i;
        break;
      }
    }
  }

  // Bis einschließlich `last` lief der Tick noch normal durch. Alle danach
  // fanden das Lager bereits voll vor und haben nicht einmal Fortschritt
  // gesammelt — für sie endet die Zeit einen Tick früher.
  for (let i = 0; i < n; i++) settle(i, i <= last ? full : full - 1);
  return { produced, progress: nextProgress };
}

/**
 * NUR FÜR TESTS: Tick-für-Tick-Grundwahrheit.
 *
 * Langsam, aber offensichtlich korrekt. `advancePassives` muss dagegen für jede
 * zufällige Eingabe exakt gleich sein — das ist der eigentliche Beweis.
 */
export function advancePassivesReference(
  elapsed: number,
  progress: readonly number[],
  space: number,
  intervals: readonly number[],
): PassiveResult {
  const n = intervals.length;
  const produced: number[] = [];
  const nextProgress: number[] = [];
  for (let i = 0; i < n; i++) {
    produced.push(0);
    nextProgress.push(progress[i] ?? 0);
  }

  let free = space;
  for (let tick = 0; tick < elapsed; tick++) {
    for (let i = 0; i < n; i++) {
      if (free <= 0) continue; // blockiert — friert ein, sammelt keinen Fortschritt
      nextProgress[i]!++;
      if (nextProgress[i]! >= intervals[i]!) {
        produced[i]!++;
        nextProgress[i] = 0;
        free--;
      }
    }
  }

  return { produced, progress: nextProgress };
}

/**
 * NUR FÜR TESTS: der Bug, den man in der Praxis tatsächlich baut.
 *
 * Deckelt zwar die Ausgabe, sammelt aber weiter Fortschritt an, während das
 * Lager voll ist. Wirkt harmlos — führt aber dazu, dass nach dem Freiräumen
 * Ware aus gebunkerter Zeit erscheint. Wenn Client und Server sich hier
 * unterscheiden, ist das exakt der Rollback-für-ehrliche-Spieler aus R1.
 */
export function advancePassivesNaive(
  elapsed: number,
  progress: readonly number[],
  space: number,
  intervals: readonly number[],
): PassiveResult {
  const n = intervals.length;
  const produced: number[] = [];
  const nextProgress: number[] = [];
  let free = space;

  for (let i = 0; i < n; i++) {
    const accumulated = (progress[i] ?? 0) + Math.max(0, elapsed);
    const interval = intervals[i]!;
    const units = Math.min(Math.floor(accumulated / interval), Math.max(0, free));
    produced.push(units);
    nextProgress.push(accumulated - Math.floor(accumulated / interval) * interval);
    free -= units;
  }

  return { produced, progress: nextProgress };
}

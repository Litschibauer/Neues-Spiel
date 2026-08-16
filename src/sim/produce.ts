/**
 * Gedeckelte passive Produktion (Architektur §7).
 *
 * Das ist die gefährlichste Stelle des ganzen Konzepts: Wenn Client und Server
 * die Akkumulation über eine lange Offline-Phase auch nur minimal unterschiedlich
 * rechnen, divergieren sie — und ein *ehrlicher* Spieler bekommt einen Rollback (R1).
 *
 * Deshalb gibt es hier genau EINE produktive Implementierung (`advanceCoop`),
 * die auf Client und Server identisch läuft. Die beiden anderen Funktionen sind
 * ausschließlich Testwerkzeug:
 *   - `advanceCoopReference`  = Tick-für-Tick-Grundwahrheit, gegen die wir fuzzen
 *   - `advanceCoopNaive`      = der realistische Bug, den wir vermeiden wollen
 */

export type CoopResult = {
  /** In diesem Segment produzierte Eier. */
  eggs: number;
  /** Verbleibender Fortschritt zum nächsten Ei. Immer < ticksPerEgg. */
  coopProgress: number;
};

/**
 * Geschlossene Form — O(1) statt O(vergangene Zeit).
 *
 * Genau das macht den Server-Re-Sim bezahlbar (R4): Zwischen zwei Commands
 * passiert nichts Spielerseitiges, also genügt eine Auswertung pro Segment.
 * Ein Sync kostet damit O(Commands), nicht O(Offline-Dauer).
 *
 * Semantik am Limit: Läuft das Lager voll, **stallt** der Stall vollständig —
 * es wird auch kein Fortschritt mehr angespart. Sonst gäbe es beim Freiräumen
 * einen Schwall gebunkerter Eier aus dem Nichts.
 */
export function advanceCoop(
  elapsed: number,
  coopProgress: number,
  space: number,
  ticksPerEgg: number,
): CoopResult {
  if (elapsed <= 0 || space <= 0) return { eggs: 0, coopProgress };

  const available = coopProgress + elapsed;
  const wanted = Math.floor(available / ticksPerEgg);

  if (wanted < space) {
    // Lager reicht mit Luft: normaler Rest bleibt stehen.
    return { eggs: wanted, coopProgress: available - wanted * ticksPerEgg };
  }

  // Lager läuft voll — auch im Gleichstand `wanted === space`! Das letzte Ei
  // setzt den Fortschritt auf 0 und belegt den letzten Platz; ab da ist der
  // Stall blockiert und friert genau dort ein. Die restliche Zeit verfällt.
  //
  // Die Grenze ist bewusst `<` und nicht `<=`: Bei `wanted === space` bleibt
  // nach dem letzten Ei noch Zeit übrig, die NICHT angespart werden darf.
  return { eggs: space, coopProgress: 0 };
}

/**
 * NUR FÜR TESTS: Tick-für-Tick-Grundwahrheit.
 *
 * Langsam, aber offensichtlich korrekt. `advanceCoop` muss dagegen für jede
 * zufällige Eingabe exakt gleich sein — das ist der eigentliche Beweis.
 */
export function advanceCoopReference(
  elapsed: number,
  coopProgress: number,
  space: number,
  ticksPerEgg: number,
): CoopResult {
  let eggs = 0;
  let progress = coopProgress;
  let free = space;

  for (let i = 0; i < elapsed; i++) {
    if (free <= 0) break; // blockiert — friert ein, sammelt keinen Fortschritt
    progress++;
    if (progress >= ticksPerEgg) {
      eggs++;
      progress = 0;
      free--;
    }
  }

  return { eggs, coopProgress: progress };
}

/**
 * NUR FÜR TESTS: der Bug, den man in der Praxis tatsächlich baut.
 *
 * Deckelt zwar die Eier, sammelt aber weiter Fortschritt an, während das Lager
 * voll ist. Wirkt harmlos — führt aber dazu, dass nach dem Freiräumen Eier aus
 * gebunkerter Zeit erscheinen. Wenn Client und Server sich hier unterscheiden,
 * ist das exakt der Rollback-für-ehrliche-Spieler aus R1.
 */
export function advanceCoopNaive(
  elapsed: number,
  coopProgress: number,
  space: number,
  ticksPerEgg: number,
): CoopResult {
  if (elapsed <= 0 || space <= 0) return { eggs: 0, coopProgress };
  const available = coopProgress + elapsed;
  const eggs = Math.min(Math.floor(available / ticksPerEgg), space);
  return { eggs, coopProgress: available % ticksPerEgg };
}

/**
 * Den Spielstand auf dem GERÄT sichern — damit ein Neuladen nichts kostet.
 *
 * Das ist die unauffälligere Hälfte von „offline spielbar", und die
 * wichtigere. Ohne sie liegt die gesamte Offline-Sitzung ausschließlich im
 * Arbeitsspeicher der Seite: Ein versehentlicher Neustart, ein Tab, den iOS
 * unter Speicherdruck wegwirft, ein Absturz — und alles seit dem letzten Sync
 * ist weg. Ausgerechnet im Funkloch, wo man am längsten nicht syncen kann.
 *
 * Gesichert wird deshalb **Snapshot UND Warteschlange zusammen**. Einzeln wären
 * sie gefährlich: Eine Warteschlange, die auf einem anderen Snapshot aufsetzt
 * als dem gespeicherten, erzeugt beim Sync einen Fork (R3) — also entweder
 * beides oder keins.
 *
 * Diese Datei hat bewusst **keinen Zugriff auf `localStorage`**. Sie wandelt
 * nur um; wohin es geht, entscheidet die Oberfläche. So bleibt sie in Node
 * testbar, ohne einen Browser vorzutäuschen.
 */

import { Client } from './client.ts';
import type { Command } from '../sim/commands.ts';
import { getRuleset } from '../sim/rules.ts';
import { simulateAll } from '../sim/sim.ts';
import { normalizeState } from '../sim/state.ts';
import type { Snapshot } from '../server/server.ts';

/** Was ein Neustart überleben muss. */
export type PersistedClient = {
  version: 1;
  snapshot: Snapshot;
  queue: Command[];
  deviceId?: string;
  /**
   * Abstand zwischen Geräteuhr und Serverzeit.
   *
   * Muss mit: Ohne ihn würde die Seite nach dem Neustart wieder der eigenen
   * Uhr vertrauen, und der Server lehnt Commands ab, die auch nur eine Sekunde
   * vor seinem Zeitbudget liegen (§4).
   */
  clockOffsetMs: number;
};

export function serializeClient(client: Client, clockOffsetMs: number): PersistedClient {
  return {
    version: 1,
    snapshot: client.baseSnapshot,
    queue: [...client.queue],
    deviceId: client.deviceId,
    clockOffsetMs,
  };
}

export type RestoreResult = {
  client: Client;
  clockOffsetMs: number;
  /**
   * Wurde die Warteschlange verworfen, weil sie sich nicht nachrechnen ließ?
   *
   * Sollte nie vorkommen — der Log war schon einmal gültig. Falls doch, ist ein
   * Snapshot ohne die letzten Aktionen immer noch weit besser als eine Seite,
   * die gar nicht mehr startet. Der Aufrufer soll es sichtbar machen.
   */
  queueDropped: boolean;
};

/**
 * Aus dem Gespeicherten wieder einen spielbaren Client machen.
 *
 * Die Warteschlange wird **nachgerechnet**, nicht nur angehängt: Der Zustand
 * nach dem letzten Command ist der Vergleichspunkt beim Sync (§9), und er muss
 * exakt derselbe sein wie vor dem Neustart. Ihn mitzuspeichern wäre eine
 * zweite Wahrheit — und damit eine Gelegenheit, dass beide auseinanderlaufen.
 */
export function restoreClient(data: PersistedClient): RestoreResult {
  if (data.version !== 1) throw new Error(`unbekannter Client-Speicherstand: ${data.version}`);

  // Derselbe Grund wie auf dem Server: Der Stand im Gerät kann aus einer Zeit
  // stammen, in der es ein Feld noch nicht gab.
  const snapshot = { ...data.snapshot, state: normalizeState(data.snapshot.state) };
  const client = new Client(snapshot, data.deviceId);
  const rules = getRuleset(snapshot.rulesetVersion);

  let queueDropped = false;
  if (data.queue.length > 0) {
    try {
      client.state = simulateAll(snapshot.state, data.queue, rules);
      client.queue = [...data.queue];
      client.localTick = data.queue[data.queue.length - 1]!.tick;
    } catch {
      queueDropped = true;
    }
  }

  return { client, clockOffsetMs: data.clockOffsetMs, queueDropped };
}

/**
 * Gehört dieser Speicherstand zu diesem Server?
 *
 * Ein Spielstand vom Dev-Server auf dem Produktions-Server wäre ein Fork mit
 * Ansage: gleiche Sequenznummern, völlig andere Geschichte. Deshalb merkt sich
 * die Oberfläche, woher der Stand kam, und wirft ihn weg, wenn es nicht passt.
 */
export function storageKeyFor(origin: string): string {
  return `ns-save:${origin}`;
}

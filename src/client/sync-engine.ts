/**
 * Verbindungsmodell (Architektur §10).
 *
 * DIE ZENTRALE ENTSCHEIDUNG: Es gibt keinen Offline-Modus.
 *
 * Das Spiel läuft immer im selben Modus — immer lokal simuliert, immer Commands
 * in die Queue. Die Verbindung entscheidet ausschließlich darüber, ob der
 * Hintergrund-Sync gerade durchkommt. Es gibt also nichts umzuschalten, nichts
 * neu zu laden und keinen Übergang, der schiefgehen könnte.
 *
 * Der Tunnel ist damit kein Ereignis, auf das das Spiel reagieren müsste,
 * sondern nur ein fehlgeschlagener Hintergrund-Request.
 *
 * Wichtig: Diese Datei ist KEINE Sim-Logik. Sie darf Zeitgeber, Zufall und
 * Floats benutzen — nichts davon fließt je in den Spielzustand ein.
 */

import type { SyncRequest, SyncResult, Snapshot } from '../server/server.ts';
import type { Client } from './client.ts';

/**
 * Wirft bei Netzwerkfehlern — genau das passiert im Tunnel.
 *
 * `signal` bricht die Anfrage ab, wenn sie zu lange braucht. Der Transport
 * sollte ihn durchreichen (bei `fetch` einfach mitgeben); tut er es nicht,
 * greift trotzdem der Timeout in der Engine — nur bleibt die Verbindung dann
 * unnötig offen.
 */
export type Transport = (req: SyncRequest, signal?: AbortSignal) => Promise<SyncResult>;

/**
 * Nur eine Anzeige für die UI, KEIN Spielmodus. Das Gameplay verhält sich in
 * allen drei Zuständen identisch.
 */
export type ConnectionView = 'live' | 'catching-up' | 'offline';

export type SyncOutcome =
  | { kind: 'nothing-to-do' }
  | { kind: 'backing-off'; retryInMs: number }
  | { kind: 'in-flight' }
  | { kind: 'synced'; result: SyncResult }
  | { kind: 'dropped'; rejectedFrom: number; reason: string; snapshot: Snapshot }
  /**
   * `timedOut` unterscheidet „kein Netz" von „hängender Leitung". Fürs
   * Gameplay ist beides gleich; für die Anzeige nicht, und fürs Nachsehen im
   * Feld schon gar nicht.
   */
  | { kind: 'failed'; retryInMs: number; timedOut: boolean };

export type SyncEngineOptions = {
  baseDelayMs: number;
  maxDelayMs: number;
  /**
   * Wann eine Anfrage als gescheitert gilt, auch wenn sie noch „läuft".
   *
   * Der wichtigste Wert für schwaches Netz — und der, der lange gefehlt hat.
   * **Kein Netz ist harmlos**: Der Aufruf scheitert sofort, das Backoff greift,
   * das Spiel läuft weiter. **Schwaches Netz ist schlimmer**: Die Anfrage
   * scheitert nicht, sie hängt. Ohne Frist bliebe `inFlight` gesetzt, jeder
   * weitere Versuch prallte daran ab, und der Client synchronisierte nie
   * wieder — ohne dass irgendwo ein Fehler aufträte. Ein hängender Client
   * sieht für den Spieler aus wie ein verbundener.
   *
   * Abbrechen ist unbedenklich: Der Sync ist idempotent (§9). Ob der Server
   * den Batch schon angewandt hatte, muss uns nicht interessieren — beim
   * nächsten Versuch erkennt er das überlappende Präfix und wendet nur den
   * Rest an.
   */
  timeoutMs: number;
  /** Zufall für den Jitter. Injizierbar, damit Tests reproduzierbar bleiben. */
  rnd: () => number;
};

const DEFAULTS: SyncEngineOptions = {
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
  // Großzügig: Auf einer schlechten Mobilverbindung sind fünf Sekunden für
  // eine Rundreise normal. Es geht hier um hängende Verbindungen, nicht um
  // langsame — eine zu kurze Frist macht ein schwaches Netz zu gar keinem.
  timeoutMs: 15_000,
  rnd: Math.random,
};

export class SyncEngine {
  client: Client;
  transport: Transport;
  opts: SyncEngineOptions;

  view: ConnectionView = 'live';
  consecutiveFailures = 0;
  nextAttemptAt = 0;
  inFlight = false;
  /** Zähler fürs Monitoring — wie oft musste nach verlorener Antwort aufgesetzt werden. */
  resumes = 0;
  /** Wie oft eine Anfrage in die Frist gelaufen ist — das Maß für schwaches Netz. */
  timeouts = 0;

  constructor(client: Client, transport: Transport, opts: Partial<SyncEngineOptions> = {}) {
    this.client = client;
    this.transport = transport;
    this.opts = { ...DEFAULTS, ...opts };
  }

  /**
   * Exponentielles Backoff MIT Jitter.
   *
   * Der Jitter ist nicht kosmetisch: Wenn ein ICE aus dem Tunnel fährt, wollen
   * mehrere hundert Clients gleichzeitig syncen. Ohne Streuung schlagen sie im
   * selben Millisekundenfenster auf und bauen sich ihre eigene Lastspitze.
   */
  private backoffMs(): number {
    // 2^(n-1), damit `baseDelayMs` der Abstand des ERSTEN Neuversuchs ist.
    const exp = Math.min(
      this.opts.baseDelayMs * 2 ** Math.max(0, this.consecutiveFailures - 1),
      this.opts.maxDelayMs,
    );
    return Math.round(exp / 2 + this.opts.rnd() * (exp / 2));
  }

  /**
   * Ein Versuch. Wird regelmäßig aufgerufen (Timer, App-Resume,
   * Netzwerk-Callback) — und tut nichts Schädliches, wenn es nichts zu tun gibt.
   *
   * Blockiert NIEMALS das Gameplay: Der Aufrufer wartet nicht auf das Ergebnis,
   * bevor der Spieler weiterspielen darf.
   */
  async attempt(nowMs: number, force = false): Promise<SyncOutcome> {
    if (this.inFlight) return { kind: 'in-flight' };

    if (this.client.queue.length === 0 && !force) {
      // Nichts zu senden. Wir gelten trotzdem als verbunden, sobald es
      // beim letzten Versuch geklappt hat.
      //
      // Bei `force` wird trotzdem gesendet, und das ist kein Detail: Ein Sync
      // holt genauso viel, wie er bringt — Postfach, Kundenaufträge, die
      // Auslage des Marktes. Wer auf „jetzt syncen" tippt oder gerade wieder
      // Netz bekommen hat, will genau das sehen. Ohne diese Ausnahme bliebe
      // ein Spieler, der nichts tut, ewig auf einem alten Markt sitzen —
      // und sein Verkaufserlös käme nie an.
      return { kind: 'nothing-to-do' };
    }

    // `force` überspringt das Backoff — für Auslöser, die neue Information
    // tragen: Der Spieler tippt auf „jetzt syncen", oder das Betriebssystem
    // meldet, dass das Netz zurück ist. Das Backoff soll automatische
    // Wiederholungen bremsen, nicht eine ausdrückliche Handlung ignorieren.
    if (!force && nowMs < this.nextAttemptAt) {
      return { kind: 'backing-off', retryInMs: this.nextAttemptAt - nowMs };
    }

    const req = this.client.buildSyncRequest();
    /**
     * Bis hierher ist gesendet. Alles mit höherer Nummer entsteht erst
     * WÄHREND der Rundreise und kann unmöglich in der Antwort stecken —
     * es muss die Antwort also überleben (siehe `Client.adopt`).
     */
    const sentThrough =
      req.commands.length > 0 ? req.commands[req.commands.length - 1]!.seq : req.baseSeq;
    this.inFlight = true;

    let result: SyncResult;
    let timedOut = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.opts.timeoutMs);

    try {
      // Die Frist gilt AUCH, wenn der Transport den Abbruch ignoriert: Das
      // Rennen entscheidet, nicht der Transport. Sonst hinge die Engine an
      // einem Versprechen, das nie eingelöst wird.
      result = await Promise.race([
        this.transport(req, controller.signal),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('TIMEOUT')), {
            once: true,
          });
        }),
      ]);
    } catch {
      // Tunnel oder hängende Leitung. Kein Fehler fürs Gameplay — nur ein
      // späterer neuer Versuch.
      //
      // Die Commands bleiben unangetastet in der Queue. Ob der Server sie
      // vielleicht doch schon angewandt hat, muss uns nicht interessieren:
      // Der Sync ist idempotent, ein erneutes Senden ist immer sicher.
      clearTimeout(timer);
      this.inFlight = false;
      this.consecutiveFailures++;
      this.view = 'offline';
      this.timeouts += timedOut ? 1 : 0;
      const retryInMs = this.backoffMs();
      this.nextAttemptAt = nowMs + retryInMs;
      return { kind: 'failed', retryInMs, timedOut };
    }
    clearTimeout(timer);

    this.inFlight = false;

    if (!result.ok) {
      // Der Server hat inhaltlich abgelehnt (Fork, Uhr, veraltete Version).
      // Server gewinnt: lokalen Stand übernehmen (§9). Der abgelehnte Batch
      // ist verloren — was danach getippt wurde, nicht.
      this.client.adopt(result.snapshot, sentThrough);
      this.consecutiveFailures = 0;
      this.nextAttemptAt = 0;
      this.view = 'live';
      return { kind: 'synced', result };
    }

    if (result.kind === 'duplicate') {
      // Der Server hatte den Batch längst — die Antwort war unterwegs verloren
      // gegangen. Genau der Fall, für den Idempotenz existiert.
      this.resumes++;
    }

    /**
     * Auch bei `partial` gilt dieselbe Grenze, und das ist wichtig: Der vom
     * Server abgelehnte Rest des Batches darf NICHT erneut in die
     * Warteschlange. Sonst schickte der Client ihn endlos weiter — beim Markt
     * etwa ein Kauf auf ein vergriffenes Angebot, den der lokale Sim-Kern für
     * völlig regelkonform hält, weil er die geteilte Welt nicht sieht.
     */
    this.client.adopt(result.snapshot, sentThrough);
    this.consecutiveFailures = 0;
    this.nextAttemptAt = 0;
    this.view = 'live';

    if (result.kind === 'partial') {
      return {
        kind: 'dropped',
        rejectedFrom: result.rejectedFrom!,
        reason: result.reason ?? 'unknown',
        snapshot: result.snapshot,
      };
    }

    return { kind: 'synced', result };
  }
}

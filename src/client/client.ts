/**
 * Client-Seite: optimistisches Offline-Spiel (Architektur §1, §3).
 *
 * Der Client rechnet mit DEMSELBEN Sim-Kern wie der Server. Zwei Konsequenzen:
 *
 *  1. Illegale Aktionen (Lager voll, Feld nicht reif, Escrow-Limit) werden schon
 *     offline abgelehnt — sie landen gar nicht erst im Log. Kein Rollback nötig.
 *  2. Der lokal berechnete Zustand ist bis zur Bestätigung Wegwerf-Ware.
 */

import type { Command } from '../sim/commands.ts';
import { SimError } from '../sim/commands.ts';
import type { State } from '../sim/state.ts';
import type { Ruleset } from '../sim/rules.ts';
import { getRuleset } from '../sim/rules.ts';
import { advanceTo, simulate } from '../sim/sim.ts';
import { hashState } from '../sim/hash.ts';
import type { Snapshot, SyncRequest } from '../server/server.ts';

export type ActionResult = { ok: true } | { ok: false; code: string };

/**
 * „Warteschlange bewusst wegwerfen" für `adopt`.
 *
 * Als Zahl ist das `Infinity` — nichts hat eine höhere seq, also überlebt
 * nichts. Der Name steht trotzdem hier, weil `adopt(snap, Infinity)` an der
 * Aufrufstelle wie ein Tippfehler aussieht und `adopt(snap, DISCARD_QUEUE)`
 * wie eine Entscheidung.
 */
export const DISCARD_QUEUE = Infinity;

export class Client {
  /** Zustand nach dem zuletzt angewandten Command — der Vergleichspunkt beim Sync. */
  state: State;
  /**
   * Der letzte vom Server bestätigte Snapshot.
   *
   * Wird aufgehoben, weil er die einzige Grundlage ist, auf der sich die
   * Warteschlange nachrechnen lässt — nach einem Neuladen genauso wie beim
   * Sync (siehe `persist.ts`).
   */
  baseSnapshot: Snapshot;
  baseSeq: number;
  rulesetVersion: number;
  queue: Command[] = [];
  /**
   * Lokale Spielzeit, abgeleitet aus der GERÄTEUHR. Also potenziell manipuliert —
   * genau deshalb prüft der Server sie gegen sein eigenes Zeitbudget (§4).
   */
  localTick: number;
  /**
   * Kennung dieses Geräts (R3). Ohne sie nimmt der Client nicht am
   * Aktiv-Gerät-Verfahren teil — dann bleibt es beim späten FORK_DETECTED.
   */
  deviceId: string | undefined;
  /** Nächster Sync soll die Schreibrechte ausdrücklich übernehmen. */
  takeover = false;

  constructor(snapshot: Snapshot, deviceId?: string) {
    this.deviceId = deviceId;
    this.baseSnapshot = snapshot;
    this.state = snapshot.state;
    this.baseSeq = snapshot.seq;
    this.rulesetVersion = snapshot.rulesetVersion;
    this.localTick = snapshot.state.tick;
  }

  /** Simuliert vergehende Zeit auf dem Gerät. */
  advanceClock(ticks: number): void {
    this.localTick += ticks;
  }

  /** Was der Spieler gerade sähe — inkl. passiver Produktion bis jetzt. */
  preview(): State {
    return advanceTo(this.state, this.localTick, getRuleset(this.rulesetVersion));
  }

  private apply(partial: Omit<Command, 'seq' | 'tick'>): ActionResult {
    const cmd = {
      ...partial,
      seq: this.baseSeq + this.queue.length + 1,
      tick: this.localTick,
    } as Command;

    try {
      // Exakt dieselbe Funktion, die auch der Server gleich aufrufen wird.
      this.state = simulate(this.state, cmd, getRuleset(this.rulesetVersion));
    } catch (err) {
      if (err instanceof SimError) return { ok: false, code: err.code };
      throw err;
    }

    this.queue.push(cmd);
    return { ok: true };
  }

  /** Das Regelwerk, unter dem dieser Client gerade rechnet. */
  rules(): Ruleset {
    return getRuleset(this.rulesetVersion);
  }

  /** Produktion starten — Feld bestellen, Mühle beschicken, Teig ansetzen. */
  start(plot: number, recipe: number): ActionResult {
    return this.apply({ type: 'START', plot, recipe } as Omit<Command, 'seq' | 'tick'>);
  }

  /** Fertige Ausgabe abholen. */
  collect(plot: number): ActionResult {
    return this.apply({ type: 'COLLECT', plot } as Omit<Command, 'seq' | 'tick'>);
  }

  /** Platz eine Stufe ausbauen: Gehege kaufen, Hühner kaufen, Feld freischalten. */
  buy(plot: number): ActionResult {
    return this.apply({ type: 'BUY', plot } as Omit<Command, 'seq' | 'tick'>);
  }

  sellNpc(item: number, amount: number): ActionResult {
    return this.apply({ type: 'SELL_NPC', item, amount } as Omit<Command, 'seq' | 'tick'>);
  }

  /** Auftrag einstellen — offline gültig, weil einseitig (§8). */
  listOrder(item: number, amount: number, price: number): ActionResult {
    return this.apply({ type: 'LIST_ORDER', item, amount, price } as Omit<Command, 'seq' | 'tick'>);
  }

  cancelOrder(orderId: number): ActionResult {
    return this.apply({ type: 'CANCEL_ORDER', orderId } as Omit<Command, 'seq' | 'tick'>);
  }

  /**
   * Ein fremdes Angebot kaufen (M5) — **braucht Verbindung.**
   *
   * Der Client rechnet es lokal nach wie jede andere Aktion, aber ob das
   * Angebot noch existiert, weiß nur der Server. Die Oberfläche graut den Knopf
   * ohne Netz aus (§6) und synct direkt danach, damit das Zeitfenster, in dem
   * jemand schneller sein kann, eine Rundreise bleibt und keine Sitzung.
   */
  buyOffer(offerId: number): ActionResult {
    return this.apply({ type: 'BUY_OFFER', offerId } as Omit<Command, 'seq' | 'tick'>);
  }

  collectMail(): ActionResult {
    return this.apply({ type: 'COLLECT_MAIL' } as Omit<Command, 'seq' | 'tick'>);
  }

  /** Kundenauftrag beliefern — offline gültig, weil vorgewürfelt (§5). */
  fillRequest(requestId: number): ActionResult {
    return this.apply({ type: 'FILL_REQUEST', requestId } as Omit<Command, 'seq' | 'tick'>);
  }

  /** Beim Reconnect: nur der Log geht hoch, nie der Zustand. Winzige Payload. */
  buildSyncRequest(): SyncRequest {
    return {
      baseSeq: this.baseSeq,
      rulesetVersion: this.rulesetVersion,
      commands: [...this.queue],
      clientHash: this.queue.length > 0 ? hashState(this.state) : undefined,
      deviceId: this.deviceId,
      takeover: this.takeover || undefined,
    };
  }

  /**
   * Server gewinnt immer (§9). Lokale Vorhersage wird verworfen.
   *
   * `keepAfterSeq` rettet die Aktionen, die der Server noch gar nicht gesehen
   * hat — und das ist kein Randfall, sondern der Normalfall auf einem Handy.
   * Ein Sync dauert auf schlechter Verbindung leicht eine Sekunde, und in
   * dieser Sekunde tippt jemand weiter. Vorher hat die eintreffende Antwort
   * diese Tipps stillschweigend mitgelöscht: Das Feld war wieder voll, die
   * Ernte weg, und nichts sagte warum.
   *
   * Der Aufrufer gibt an, bis zu welcher Nummer er gesendet hat. Alles
   * darüber wurde danach eingereiht, kann also unmöglich in der Antwort
   * stecken. Ohne Angabe wird wie bisher alles verworfen — richtig für einen
   * frischen Verbindungsaufbau, wo es nichts zu retten gibt.
   *
   * Gerettete Commands werden **neu nummeriert und nachgerechnet**: Ihre alten
   * Nummern gehören zu einem Snapshot, den es nicht mehr gibt. Was unter dem
   * neuen Stand nicht mehr erlaubt ist, fällt dabei heraus — besser hier, wo
   * der Client es sofort anzeigen kann, als beim Server.
   */
  adopt(snapshot: Snapshot, keepAfterSeq?: number): { kept: number; dropped: number } {
    /**
     * Ohne Angabe wird die Warteschlange verworfen — richtig beim
     * Verbindungsaufbau, wo es keine gibt. Ist doch etwas drin, ist es fast
     * sicher ein Fehler, und zwar einer der unangenehmen Sorte.
     *
     * Genau der ist passiert: Die Oberfläche rief nach jedem Sync noch einmal
     * `adopt(snapshot)` auf, nachdem die Sync-Maschine bereits mit Grenze
     * übernommen hatte. Damit war jede Aktion weg, die während der Rundreise
     * entstanden war. Sichtbar war das als Ernte, die kurz aufblitzt und dann
     * wieder verschwindet — ohne Fehlermeldung, ohne Spur.
     *
     * Deshalb hier ein Abbruch statt eines stillen Verlusts.
     */
    if (keepAfterSeq === undefined && this.queue.length > 0) {
      throw new Error(
        `adopt() würde ${this.queue.length} nicht gesendete Aktion(en) verwerfen. ` +
          'Nach einem Sync übernimmt die Sync-Maschine bereits — hier ist nichts mehr zu tun. ' +
          'Soll wirklich verworfen werden, ausdrücklich adopt(snapshot, Infinity) aufrufen.',
      );
    }
    const boundary = keepAfterSeq ?? Infinity;
    const pending = this.queue.filter((c) => c.seq > boundary);

    this.baseSnapshot = snapshot;
    this.state = snapshot.state;
    this.baseSeq = snapshot.seq;
    this.rulesetVersion = snapshot.rulesetVersion;
    this.localTick = snapshot.state.tick;
    this.queue = [];

    if (pending.length === 0) return { kept: 0, dropped: 0 };

    const rules = getRuleset(this.rulesetVersion);
    let dropped = 0;
    for (const cmd of pending) {
      const moved = {
        ...cmd,
        seq: this.baseSeq + this.queue.length + 1,
        // Der neue Snapshot kann zeitlich weiter sein als der alte. Ein Command
        // in die Vergangenheit zu datieren wäre eine Zeitreise (§4) — also auf
        // den neuen Stand vorziehen statt verwerfen.
        tick: Math.max(cmd.tick, this.state.tick),
      } as Command;
      try {
        this.state = simulate(this.state, moved, rules);
        this.queue.push(moved);
        this.localTick = moved.tick;
      } catch {
        dropped++;
      }
    }
    return { kept: this.queue.length, dropped };
  }
}

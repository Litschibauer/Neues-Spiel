/**
 * Server-Seite: Zeitautorität + Re-Simulation + Snapshot (Architektur §3, §4, §9).
 *
 * Der Server ist die einzige Quelle der Wahrheit. Er übernimmt nie einen Zustand
 * vom Client, sondern leitet jeden neuen Zustand selbst aus dem geprüften
 * Command-Log ab — mit demselben Sim-Kern, den der Client benutzt.
 */

import type { Command } from '../sim/commands.ts';
import { SimError } from '../sim/commands.ts';
import type { MailItem, State } from '../sim/state.ts';
import { cloneState } from '../sim/state.ts';
import { getRuleset } from '../sim/rules.ts';
import { simulate } from '../sim/sim.ts';
import { migrateState, MigrationError } from '../sim/migrate.ts';
import { canonicalizeCommand, hashState } from '../sim/hash.ts';

/** 1 Tick = 1 Sekunde Echtzeit. */
export const TICK_MS = 1000;

export type Snapshot = {
  state: State;
  /** seq des zuletzt angewandten Commands. */
  seq: number;
  /** Echtzeit-Zeitpunkt dieses Syncs, vom SERVER gemessen (§4). */
  serverTs: number;
  rulesetVersion: number;
};

export type SyncRequest = {
  baseSeq: number;
  rulesetVersion: number;
  commands: Command[];
  /** Hash des Client-Zustands nach dem letzten Command (Kanarienvogel, R1). */
  clientHash?: string;
  /**
   * Wer schickt. Ohne Angabe nimmt das Gerät nicht am Aktiv-Gerät-Verfahren
   * teil (R3) — nützlich für Skripte und Tests.
   */
  deviceId?: string;
  /** Ausdrückliche Übernahme, obwohl ein anderes Gerät aktiv ist. */
  takeover?: boolean;
};

export type SyncResult =
  | {
      ok: true;
      /**
       * applied   = alles übernommen
       * duplicate = war schon drin (verlorene Antwort), No-op
       * partial   = gültiges Präfix übernommen, ab `rejectedFrom` verworfen
       */
      kind: 'applied' | 'duplicate' | 'partial';
      snapshot: Snapshot;
      /** null = nicht prüfbar (kein Hash, keine Commands, oder nur Präfix übernommen). */
      divergence: boolean | null;
      /** Nur bei `partial`: seq des ersten abgelehnten Commands. */
      rejectedFrom?: number;
      reason?: string;
    }
  | { ok: false; kind: 'rejected'; reason: string; snapshot: Snapshot };

export class Server {
  snapshot: Snapshot;
  /** Determinismus-Alarme (R1) — gehören ins Monitoring, nicht in eine Sanktion. */
  divergenceAlerts: Array<{ seq: number; clientHash: string; serverHash: string }> = [];
  /**
   * Alle bisher angewandten Commands, nach seq.
   *
   * Braucht man ohnehin für Audit und Nachstellen von Fehlern — und er macht die
   * Präfix-Prüfung beim Wiederaufsetzen trivial und lückenlos korrekt. In
   * Produktion wird er hinter alten Snapshots abgeschnitten.
   */
  appliedLog: Command[] = [];
  /**
   * Version, auf die neue Snapshots gehoben werden (R2).
   *
   * Ein Balance-Patch besteht serverseitig genau darin, diesen Wert
   * hochzusetzen. Spieler wandern dann bei ihrem nächsten Sync mit — nicht
   * mittendrin, während sie offline sind.
   */
  targetRulesetVersion: number;
  /** Fehlgeschlagene Migrationen — Alarm fürs Monitoring, wie die Divergenzen. */
  migrationFailures: Array<{ fromVersion: number; toVersion: number; message: string }> = [];
  /**
   * Was die Außenwelt zugestellt hat, während der Spieler offline war:
   * Geschenke, Erlöse aus gefüllten Aufträgen, Event-Belohnungen (§7, §8).
   *
   * Der Client konnte davon unmöglich wissen — deshalb landet es im Postfach
   * und nie direkt im Lager.
   */
  pendingDeliveries: MailItem[] = [];
  /** Zustellungen, die nicht mehr ins Postfach passten. */
  undeliverable: MailItem[] = [];
  /**
   * Das Gerät mit den Offline-Schreibrechten (R3).
   *
   * Ein Fork entsteht dadurch, dass zwei Geräte vom selben Snapshot aus offline
   * weiterspielen. Erkennen kann man ihn erst beim Sync — dann ist die Arbeit
   * des zweiten Geräts schon getan und geht verloren. Die Warnung kommt also
   * grundsätzlich zu spät.
   *
   * Das Aktiv-Gerät dreht die Reihenfolge um: Ein zweites Gerät erfährt
   * *bevor* es losspielt, dass es nicht dran ist, und kann bewusst übernehmen.
   */
  activeDevice: { id: string; lastSyncMs: number } | null = null;

  /** Darf dieses Gerät gerade schreiben? */
  isActiveDevice(deviceId: string | undefined): boolean {
    if (deviceId === undefined) return true; // nimmt nicht teil
    return this.activeDevice === null || this.activeDevice.id === deviceId;
  }

  /** Externes Ereignis: Geschenk, Auftrag gefüllt, Event-Belohnung. */
  deliver(item: MailItem): void {
    this.pendingDeliveries.push(item);
  }

  /**
   * Zeit gutschreiben, ohne sie abzuwarten (Werkzeug für den Feldtest).
   *
   * Bewusst KEIN Eingriff in den Zustand: Es wird nur `serverTs` zurückgestellt,
   * also die Uhr, gegen die das Zeitbudget aus §4 gemessen wird. Der Server
   * glaubt danach, es sei mehr Realzeit vergangen — mehr nicht.
   *
   * Damit bleibt alles konsistent: Client und Server leiten ihre Spielzeit aus
   * demselben `serverTs` ab, rechnen also weiterhin dasselbe. Ein direkter
   * Griff in Felder oder Bestände würde dagegen sofort den Kanarienvogel
   * auslösen — der Client hätte ja anders gerechnet.
   */
  grantTime(seconds: number): void {
    if (!Number.isInteger(seconds) || seconds <= 0) return;
    this.snapshot = { ...this.snapshot, serverTs: this.snapshot.serverTs - seconds * TICK_MS };
  }

  /** Von vorn anfangen. Der Client muss danach neu übernehmen. */
  reset(fresh: State, nowMs: number, rulesetVersion: number): void {
    this.snapshot = { state: fresh, seq: 0, serverTs: nowMs, rulesetVersion };
    this.appliedLog = [];
    this.pendingDeliveries = [];
    this.activeDevice = null;
    this.divergenceAlerts = [];
    this.migrationFailures = [];
  }

  constructor(initial: State, startTs: number, rulesetVersion: number, targetVersion?: number) {
    this.snapshot = { state: initial, seq: 0, serverTs: startTs, rulesetVersion };
    this.targetRulesetVersion = targetVersion ?? rulesetVersion;
  }

  /**
   * Nimmt einen Offline-Log entgegen und rechnet ihn nach.
   *
   * Transaktional (§9, R8): Der Aufruf schreibt genau einmal — entweder das
   * geprüfte Präfix oder gar nichts. Ein abgebrochener Sync hinterlässt nie
   * einen halben Zustand.
   */
  sync(req: SyncRequest, nowMs: number): SyncResult {
    const snap = this.snapshot;

    let rules;
    try {
      rules = getRuleset(req.rulesetVersion);
    } catch {
      // R2: zu alte Client-Version → erzwungenes Update statt stiller Divergenz.
      return { ok: false, kind: 'rejected', reason: 'UNSUPPORTED_RULESET', snapshot: snap };
    }

    // Der Client darf sich seine Regelversion NICHT aussuchen.
    //
    // Ohne diese Prüfung könnte jemand dauerhaft eine alte Version deklarieren
    // und sich die jeweils günstigsten Regeln behalten — etwa alte Preise nach
    // einem Nerf. Maßgeblich ist allein die Version, die der Server auf den
    // Snapshot gestempelt hat.
    if (req.rulesetVersion !== snap.rulesetVersion) {
      return { ok: false, kind: 'rejected', reason: 'RULESET_MISMATCH', snapshot: snap };
    }

    // ── Aktiv-Gerät (R3) ─────────────────────────────────────────────────
    //
    // Vor der Re-Simulation, damit ein zweites Gerät gar nicht erst Arbeit
    // bestätigt bekommt. Das ist absichtlich eine eigene Ablehnung und kein
    // FORK_DETECTED: Der Client kann daraus eine Frage machen („hier
    // übernehmen?") statt einer Fehlermeldung nach dem Verlust.
    if (req.deviceId !== undefined && !this.isActiveDevice(req.deviceId)) {
      if (!req.takeover) {
        return { ok: false, kind: 'rejected', reason: 'NOT_ACTIVE_DEVICE', snapshot: snap };
      }
    }

    // ── Form des Batches ─────────────────────────────────────────────────
    for (let i = 0; i < req.commands.length; i++) {
      if (req.commands[i]!.seq !== req.baseSeq + i + 1) {
        return { ok: false, kind: 'rejected', reason: 'SEQ_GAP', snapshot: snap };
      }
    }

    if (req.baseSeq > snap.seq) {
      // Der Client behauptet, weiter zu sein als der Server. Kann nicht sein.
      return { ok: false, kind: 'rejected', reason: 'BASE_SEQ_AHEAD', snapshot: snap };
    }

    // ── Wiederaufsetzen nach verlorener Antwort ──────────────────────────
    //
    // Der Tunnel-Fall: Der Server hat den Batch angewandt, die Antwort ging
    // unterwegs verloren, der Spieler hat weitergespielt. Der Client schickt
    // jetzt erneut ab seinem alten `baseSeq` — inklusive der Commands, die
    // längst drin sind.
    //
    // Das ist KEIN Fork. Solange das überlappende Präfix Command für Command
    // identisch ist, wurde hier dieselbe Arbeit zweimal geschickt, und der
    // Server wendet einfach nur den Rest an.
    for (const cmd of req.commands) {
      if (cmd.seq > snap.seq) break;
      const applied = this.appliedLog[cmd.seq - 1];
      if (!applied || canonicalizeCommand(applied) !== canonicalizeCommand(cmd)) {
        // Gleiche Nummer, andere Aktion → zwei Geräte am selben Snapshot (R3).
        return { ok: false, kind: 'rejected', reason: 'FORK_DETECTED', snapshot: snap };
      }
    }

    const tail = req.commands.filter((c) => c.seq > snap.seq);
    if (tail.length === 0) {
      // Alles schon drin. Idempotent, also ein ruhiges No-op (§9).
      return { ok: true, kind: 'duplicate', snapshot: snap, divergence: null };
    }

    // ── Zeitautorität (§4) ───────────────────────────────────────────────
    // Der Server misst die real vergangene Zeit selbst. Die Geräteuhr des
    // Clients ist völlig irrelevant — sie kann keine Zeit erfinden.
    const elapsedMs = Math.max(0, nowMs - snap.serverTs);
    const maxTick = snap.state.tick + Math.floor(elapsedMs / TICK_MS);

    let prevTick = snap.state.tick;
    for (const cmd of tail) {
      if (cmd.tick < prevTick) {
        return { ok: false, kind: 'rejected', reason: 'TIME_WENT_BACKWARDS', snapshot: snap };
      }
      if (cmd.tick > maxTick) {
        return { ok: false, kind: 'rejected', reason: 'CLOCK_AHEAD_OF_SERVER', snapshot: snap };
      }
      prevTick = cmd.tick;
    }

    // ── Re-Simulation mit Präfix-Commit ──────────────────────────────────
    //
    // Bei einem illegalen Command wird NICHT der ganze Batch verworfen. Alles
    // davor war vom Server selbst als regelkonform bestätigt — es dafür
    // zurückzusetzen würde einen ehrlichen Spieler für einen einzigen Fehler
    // ganz hinten im Log bestrafen. Der Cheat landet trotzdem nicht.
    let state = snap.state;
    const accepted: Command[] = [];
    let rejectedFrom: number | undefined;
    let rejectReason: string | undefined;

    for (const cmd of tail) {
      try {
        state = simulate(state, cmd, rules);
        accepted.push(cmd);
      } catch (err) {
        rejectedFrom = cmd.seq;
        rejectReason = err instanceof SimError ? `ILLEGAL_COMMAND:${err.code}` : 'SIM_FAILURE';
        break;
      }
    }

    if (accepted.length === 0) {
      // Schon das erste neue Command ist illegal → es gibt nichts zu übernehmen.
      return { ok: false, kind: 'rejected', reason: rejectReason ?? 'SIM_FAILURE', snapshot: snap };
    }

    // ── Kanarienvogel (R1) ───────────────────────────────────────────────
    // Vergleichspunkt ist der Zustand NACH dem letzten Command — den können
    // beide Seiten unabhängig und exakt berechnen. „Jetzt" können sie nicht.
    // Bei einem gekürzten Batch ist ein Unterschied dagegen erwartbar und
    // sagt nichts über Determinismus aus.
    const fullyApplied = rejectedFrom === undefined;
    let divergence: boolean | null = null;
    if (fullyApplied && req.clientHash !== undefined) {
      const serverHash = hashState(state);
      divergence = serverHash !== req.clientHash;
      if (divergence) {
        this.divergenceAlerts.push({
          seq: accepted[accepted.length - 1]!.seq,
          clientHash: req.clientHash,
          serverHash,
        });
      }
    }

    // ── Externe Zustellungen (§7) ────────────────────────────────────────
    //
    // ERST NACH dem Kanarienvogel-Vergleich. Der Client konnte von diesen
    // Ereignissen unmöglich wissen — würden sie vor dem Vergleich einfließen,
    // meldete der Hash bei jedem Geschenk einen Determinismus-Bug, den es
    // gar nicht gibt. Der Kanarienvogel prüft die Kausalkette des SPIELERS.
    //
    // Und sie landen im Postfach, nie direkt im Lager: Nichts vernichten,
    // wovon der Spieler nichts wissen konnte.
    if (this.pendingDeliveries.length > 0) {
      const withMail = cloneState(state);
      const stillPending: MailItem[] = [];
      for (const item of this.pendingDeliveries) {
        if (withMail.mail.length < rules.mailCapacity) {
          withMail.mail.push(item);
        } else {
          // Postfach voll — liegen lassen, nicht verwerfen. Der Spieler räumt
          // auf, dann kommt es beim nächsten Sync an.
          stillPending.push(item);
        }
      }
      state = withMail;
      this.pendingDeliveries = stillPending;
    }

    // ── Der Zustand bleibt beim letzten Command stehen ───────────────────
    //
    // Früher wurde hier bis `maxTick` fortgeschrieben („Produktion bis jetzt").
    // Das war ein Modellfehler: Passive Produktion ist eine ABGELEITETE Größe,
    // die sich jederzeit aus (tick, verstrichene Zeit) neu ergibt. Sie eifrig
    // festzuschreiben bringt den Server der Zeitachse des Clients voraus.
    //
    // Und genau daran zerbricht das Wiederaufsetzen: Nach einer verlorenen
    // Antwort spielt der Client ahnungslos weiter und datiert seine nächsten
    // Commands auf Ticks, die der Server längst hinter sich hat — er würde sie
    // als Zeitreise ablehnen und einem ehrlichen Spieler die Sitzung kosten.
    //
    // `serverTs` wird deshalb exakt um die VERBRAUCHTEN Ticks weitergestellt,
    // nicht auf die Wanduhr. Die noch nicht verbrauchte Realzeit bleibt dem
    // Spieler erhalten und wird beim nächsten Sync gewährt — kein Verlust,
    // kein Geschenk.
    const consumedTicks = state.tick - snap.state.tick;
    const alignedServerTs = snap.serverTs + consumedTicks * TICK_MS;

    // ── Ruleset-Migration (R2) ───────────────────────────────────────────
    // Erst jetzt, nachdem alles unter der alten Version nachgerechnet ist,
    // wird der Zustand auf die aktuelle Version gehoben. Das ist die einzige
    // Stelle, an der ein Versionswechsel passiert — eine klare Grenze statt
    // eines schleichenden Übergangs.
    let newVersion = snap.rulesetVersion;
    if (this.targetRulesetVersion !== snap.rulesetVersion) {
      try {
        state = migrateState(state, snap.rulesetVersion, this.targetRulesetVersion);
        newVersion = this.targetRulesetVersion;
      } catch (err) {
        // Eine kaputte Migration darf keinen Spielstand beschädigen: Wir
        // übernehmen den Log trotzdem, bleiben aber auf der alten Version.
        // Der Spieler wandert beim nächsten Versuch mit, sobald der Fix da ist.
        if (!(err instanceof MigrationError)) throw err;
        this.migrationFailures.push({
          fromVersion: snap.rulesetVersion,
          toVersion: this.targetRulesetVersion,
          message: err.message,
        });
      }
    }

    if (req.deviceId !== undefined) {
      this.activeDevice = { id: req.deviceId, lastSyncMs: nowMs };
    }

    this.appliedLog.push(...accepted);
    this.snapshot = {
      state,
      seq: accepted[accepted.length - 1]!.seq,
      serverTs: alignedServerTs,
      rulesetVersion: newVersion,
    };

    if (!fullyApplied) {
      return {
        ok: true,
        kind: 'partial',
        snapshot: this.snapshot,
        divergence: null,
        rejectedFrom,
        reason: rejectReason,
      };
    }

    return { ok: true, kind: 'applied', snapshot: this.snapshot, divergence };
  }
}

/**
 * Live-Anstöße: „Es hat sich was getan, sync mal."
 *
 * Bis hierhin fragte der Client alle vier Sekunden nach. Das reicht für den
 * eigenen Hof — der ändert sich ja nur, wenn man selbst etwas tut — aber nicht
 * für den Markt: Wer ein neues Angebot einstellt, sieht es sofort, alle anderen
 * erst beim nächsten Timer. Für einen Kauf, bei dem der Schnellere gewinnt, ist
 * das der Unterschied zwischen „geht" und „ist immer schon weg".
 *
 * ## Warum ein Anstoß und keine Daten
 *
 * Die naheliegende Lösung wäre, den neuen Zustand gleich mitzuschicken. Genau
 * das passiert hier NICHT, und das ist die wichtigste Entscheidung in dieser
 * Datei.
 *
 * Ein Zustand, der über einen zweiten Kanal ankommt, ist ein zweiter Weg in den
 * Client hinein — mit eigener Reihenfolge, eigenem Fehlerfall und eigener
 * Vertrauensfrage. Der Sync ist sorgfältig gebaut: lückenlose `seq`,
 * Präfix-Commit, Kanarienvogel. Ein Nebeneingang, der Zustand hineinreicht,
 * umginge das alles.
 *
 * Deshalb überträgt dieser Kanal genau ein Wort: **„sync jetzt".** Der Client
 * macht daraufhin, was er ohnehin kann — einen ganz normalen erzwungenen Sync.
 * Ein Angreifer, der sich hier einklinkt, kann einen Hof zu einem Sync
 * überreden, den er sowieso alle vier Sekunden macht. Mehr nicht.
 *
 * Fällt der Kanal aus, bleibt der Timer. Das ist die zweite Eigenschaft, die
 * zählt: Es gibt keinen Zustand, in dem das Spiel auf einen Anstoß *wartet*.
 *
 * ## Warum SSE und nicht WebSocket
 *
 * Der Kanal geht nur in eine Richtung — der Client hat nichts zu sagen, was
 * nicht schon über `/api/sync` liefe. Server-Sent Events sind dafür genau
 * groß genug: gewöhnliches HTTP, kein Upgrade-Handschlag, Reconnect ist im
 * Browser eingebaut. Ein WebSocket wäre ein zweites Protokoll für dieselbe
 * Wirkung.
 */

/** Was sich geändert hat. Der Client entscheidet, ob es ihn interessiert. */
export type NudgeKind =
  /** Das Orderbuch: neues Angebot, oder eines ist weg. Betrifft alle. */
  | 'market'
  /** Dieser eine Hof: Verkauf abgerechnet, Post da. Betrifft genau einen. */
  | 'farm';

/** Wohin ein Anstoß geht. Absichtlich kein `ServerResponse` — das ist testbar. */
export type Sink = {
  /** Eine Zeile rausschreiben. Gibt `false` zurück, wenn die Leitung tot ist. */
  write: (chunk: string) => boolean;
  /**
   * Leitung zumachen. Wird beim Abmelden gerufen, auch wenn die Gegenstelle
   * schon weg ist — die Umsetzung muss den zweiten Aufruf aushalten.
   */
  close?: () => void;
};

type Subscriber = {
  accountId: string;
  sink: Sink;
  /** Was seit dem letzten Flush aufgelaufen ist. Doppelte fallen weg. */
  pending: Set<NudgeKind>;
  /**
   * Wann zuletzt wirklich geschrieben wurde — für die Zusammenfassung.
   *
   * Beim Anmelden bewusst so gesetzt, dass der Mindestabstand schon abgelaufen
   * ist: Der ERSTE Anstoß soll sofort rausgehen. Stünde hier 0, wäre eine
   * frische Leitung für eine Sekunde taub, und genau in dieser Sekunde ist der
   * Spieler gerade angekommen und schaut hin.
   */
  lastSentMs: number;
};

export type HubOptions = {
  /**
   * Mindestabstand zwischen zwei Anstößen an denselben Hof.
   *
   * Der Grund ist nicht Sparsamkeit, sondern eine Rückkopplung: Jeder Kauf
   * ändert das Buch, jede Buchänderung stößt alle an, jeder Anstoß ist ein
   * Sync, und jeder Sync kann ein Kauf sein. Ohne Mindestabstand baut sich das
   * bei ein paar hundert aktiven Spielern zu einem Dauerfeuer auf, das nichts
   * mehr mit dem zu tun hat, was jemand tatsächlich getan hat.
   */
  minIntervalMs?: number;
  /**
   * Wie viele Leitungen der Server gleichzeitig offenhält.
   *
   * Eine offene Verbindung kostet Speicher, auch wenn nichts passiert. Auf
   * einem Server mit 1 GB ist das die Zahl, an der er kippt — deshalb steht sie
   * hier und nicht im Zufall. Wer nicht mehr reinpasst, spielt weiter; er
   * bekommt seine Änderungen über den Timer, ein paar Sekunden später.
   */
  maxSubscribers?: number;
  /** Testbare Uhr. Im Betrieb `Date.now`. */
  now?: () => number;
};

/**
 * Die Verteilstelle. Kennt Höfe, keine Spieler, und hält keinen Zustand,
 * dessen Verlust wehtäte — ein Neustart kostet höchstens ein paar Sekunden
 * Aktualität.
 */
export class EventHub {
  private subs = new Map<number, Subscriber>();
  private byAccount = new Map<string, Set<number>>();
  private nextId = 1;
  private readonly minIntervalMs: number;
  private readonly maxSubscribers: number;
  private readonly now: () => number;

  constructor(opts: HubOptions = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? 1000;
    this.maxSubscribers = opts.maxSubscribers ?? 2000;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.subs.size;
  }

  /** Wie viele Leitungen dieser eine Hof offen hat (mehrere Geräte, mehrere Tabs). */
  countFor(accountId: string): number {
    return this.byAccount.get(accountId)?.size ?? 0;
  }

  /**
   * Anmelden. Gibt eine Abmeldefunktion zurück, oder `null`, wenn kein Platz
   * mehr ist — der Aufrufer soll dann eine ehrliche Absage schicken und nicht
   * eine Leitung offenhalten, die nie etwas liefert.
   */
  subscribe(accountId: string, sink: Sink): (() => void) | null {
    if (this.subs.size >= this.maxSubscribers) return null;

    const id = this.nextId++;
    this.subs.set(id, {
      accountId,
      sink,
      pending: new Set(),
      lastSentMs: this.now() - this.minIntervalMs,
    });
    let ids = this.byAccount.get(accountId);
    if (!ids) {
      ids = new Set();
      this.byAccount.set(accountId, ids);
    }
    ids.add(id);

    return () => this.drop(id);
  }

  /** Einen bestimmten Hof anstoßen — Verkauf abgerechnet, Post da. */
  nudge(accountId: string, kind: NudgeKind = 'farm'): void {
    for (const id of this.byAccount.get(accountId) ?? []) this.queue(id, kind);
  }

  /**
   * Alle anstoßen, außer dem Auslöser.
   *
   * Der Auslöser weiß es schon: Er hat die Antwort auf seinen eigenen Sync in
   * der Hand, bevor dieser Anstoß überhaupt losgeht. Ihn mitzubenachrichtigen
   * hieße, jeden Kauf mit einem überflüssigen zweiten Sync zu bezahlen.
   */
  broadcast(kind: NudgeKind, exceptAccountId?: string): void {
    for (const [id, sub] of this.subs) {
      if (exceptAccountId !== undefined && sub.accountId === exceptAccountId) continue;
      this.queue(id, kind);
    }
  }

  /**
   * Aufgelaufene Anstöße rausschreiben. Wird vom Server getaktet aufgerufen.
   *
   * Getaktet statt sofort, weil zwanzig Änderungen in derselben Sekunde für den
   * Client dieselbe Nachricht sind: „sync mal". Zwanzigmal dasselbe zu schicken
   * hieße, zwanzig Syncs auszulösen.
   */
  flush(): void {
    const now = this.now();
    for (const [id, sub] of this.subs) {
      if (sub.pending.size === 0) continue;
      if (now - sub.lastSentMs < this.minIntervalMs) continue;

      const kinds = [...sub.pending].sort().join(',');
      sub.pending.clear();
      sub.lastSentMs = now;
      if (!this.send(sub, 'nudge', kinds)) this.drop(id);
    }
  }

  /**
   * Lebenszeichen auf allen Leitungen.
   *
   * Ein SSE-Strom, auf dem stundenlang nichts passiert, wird von Proxys,
   * Mobilfunknetzen und Handy-Betriebssystemen irgendwann leise zugemacht.
   * Ohne Herzschlag merkt das niemand — der Server hält eine tote Leitung für
   * offen, und der Client wartet auf Anstöße, die nie ankommen. Ein Kommentar
   * alle paar Sekunden hält sie wach und deckt gleichzeitig auf, welche
   * Leitungen längst weg sind.
   */
  heartbeat(): void {
    for (const [id, sub] of this.subs) {
      if (!sub.sink.write(': ping\n\n')) this.drop(id);
    }
  }

  /** Alle Leitungen schließen — beim Herunterfahren. */
  closeAll(): void {
    for (const id of [...this.subs.keys()]) this.drop(id);
  }

  private queue(id: number, kind: NudgeKind): void {
    this.subs.get(id)?.pending.add(kind);
  }

  private send(sub: Subscriber, event: string, data: string): boolean {
    return sub.sink.write(`event: ${event}\ndata: ${data}\n\n`);
  }

  private drop(id: number): void {
    const sub = this.subs.get(id);
    if (!sub) return;
    this.subs.delete(id);
    const ids = this.byAccount.get(sub.accountId);
    if (ids) {
      ids.delete(id);
      if (ids.size === 0) this.byAccount.delete(sub.accountId);
    }
    sub.sink.close?.();
  }
}

/**
 * Regelwerk als *versionierte Daten* (Architektur §2, Risiko R2).
 *
 * Balance-Änderungen sind Datenänderungen, kein Code. Jeder Command-Log deklariert
 * seine `rulesetVersion`, und der Server validiert ihn unter genau dieser Version —
 * sonst rechnet er nach einem Patch anders als der Client offline gerechnet hat und
 * bestraft ehrliche Spieler mit einem Rollback (R1).
 *
 * ── Inhalt ist eine Tabelle, keine Codezeile ────────────────────────────────
 *
 * Hier steht der gesamte Spielinhalt: Gegenstände, Rezepte, Produktionsplätze.
 * Eine neue Feldfrucht ist eine Zeile in `items` plus eine in `recipes` — der
 * Sim-Kern kennt keinen Weizen und keine Hühner, nur Katalogindizes.
 *
 * ── Die eine Regel, die man nicht brechen darf ──────────────────────────────
 *
 * **Kataloge sind APPEND-ONLY.** Zustände speichern Indizes, keine Namen: Ein
 * Inventar ist ein Zahlenarray in Katalogreihenfolge, ein Platz merkt sich eine
 * Rezeptnummer. Wer einen Eintrag einschiebt oder entfernt, verschiebt die
 * Bedeutung *aller* gespeicherten Spielstände — aus Weizen wird stillschweigend
 * Futter. Anhängen ist gratis (die Migration füllt mit Nullen auf); Umsortieren
 * braucht eine echte Umschlüsselungs-Migration.
 *
 * `test/rules.test.ts` prüft das über alle Versionen hinweg.
 */

/** Menge eines Katalog-Gegenstands. `item` ist ein Index in `Ruleset.items`. */
export type ItemStack = {
  item: number;
  amount: number;
};

export type ItemDef = {
  /** Nur für Menschen und Oberflächen. Der Zustand kennt nur den Index. */
  id: string;
  /** Zählt gegen das Lagerlimit? Münzen nicht (§7). */
  storable: boolean;
  /** NPC-Ankaufpreis. 0 = wird nicht angekauft (und ist damit auch nicht handelbar). */
  npcPrice: number;
  /**
   * Was der NPC dafür VERLANGT. 0 = verkauft er nicht.
   *
   * Muss über `npcPrice` liegen, sonst wäre der Händler eine Geldpresse:
   * billig kaufen, teuer an ihn zurückverkaufen, beliebig oft.
   * `validateRuleset` erzwingt das.
   *
   * Gebraucht wird das seit Saatgut verbraucht wird: Wer seinen letzten Weizen
   * verkauft, käme sonst nie wieder an einen — ein Sackgassen-Zustand, den §6
   * ausdrücklich verbietet.
   */
  npcBuyPrice: number;
};

/**
 * Eingaben verbrauchen → Zeit vergeht → Ausgabe liegt bereit.
 *
 * Dieselbe Struktur trägt Feldfrucht, Tierprodukt und Werkstatt-Rezept — das ist
 * die Verdichtung aus der Konzept-Map (M1). Produktionsketten muss niemand extra
 * bauen: Sie entstehen, sobald die Ausgabe des einen die Eingabe des anderen ist.
 *
 * Der Kernkreislauf des Spiels ist genau das, dreimal hintereinander:
 * Feld → Weizen, Mühle → Futter, Gehege → Eier.
 */
export type RecipeDef = {
  id: string;
  /** Leer = wächst aus dem Nichts (Saatgut ist gratis). */
  inputs: readonly ItemStack[];
  output: ItemStack;
  durationTicks: number;
  /** Erfahrung fürs Abholen. Der Balken bewegt sich bei jeder Ernte (M8). */
  xp: number;
};

/**
 * Eine Ausbaustufe eines Platzes.
 *
 * Damit sind „Gehege kaufen" und „Hühner kaufen" **dieselbe** Mechanik: einmal
 * Kosten zahlen, dauerhaft eine Stufe höher. Ein leeres Gehege ist Stufe 1
 * (kann noch nichts), mit Hühnern Stufe 2 (kann Eier).
 *
 * Dieselbe Mechanik trägt später Felder freischalten, Ställe vergrößern und
 * Maschinen beschleunigen (Konzept-Map, M7) — alles Tabellenzeilen.
 */
export type LevelDef = {
  /** Anzeigename dieser Stufe. */
  label: string;
  /** Was der Aufstieg auf diese Stufe kostet. */
  cost: readonly ItemStack[];
  /** Welche Rezepte auf dieser Stufe laufen dürfen. Darf leer sein. */
  recipes: readonly number[];
  /**
   * Ab welchem Spielerlevel kaufbar (M8). Fehlt = sofort.
   *
   * Das ist die ganze Wirkung von Leveln: eine Schwelle, hinter der etwas
   * auftaucht, das es vorher nicht gab. Sie braucht keine neue Mechanik —
   * nur eine Zahl neben dem Preis.
   */
  minPlayerLevel?: number;
};

/**
 * Ein Produktionsplatz: Feld, Mühle, Gehege.
 *
 * Die Liste im Regelwerk ist die WELT, nicht der Typ — jeder Eintrag ist ein
 * Platz, den es geben kann. Ob er dem Spieler schon gehört, sagt seine Stufe im
 * Zustand.
 */
export type PlotDef = {
  id: string;
  /** Stufe, mit der ein frischer Hof startet. 0 = muss erst gekauft werden. */
  startLevel: number;
  /** Stufen 1..n — `levels[i]` beschreibt Stufe i+1. Append-only. */
  levels: readonly LevelDef[];
};

/**
 * Eine Auftragsvorlage: „Liefere das, bekomm das."
 *
 * Der Kern von M6 — und die Mechanik, aus der die meisten Inhalte als reine
 * Daten herausfallen. LKW, Kunden, Boote, Sonderaufträge und Eventaufgaben sind
 * alle dieselbe Regel mit anderen Zahlen und einem anderen Bild daneben.
 *
 * Gewürfelt wird auf dem SERVER (§5). Der Sim-Kern liest fertige Aufträge aus
 * dem Zustand und verbraucht sie — er erzeugt nie welche. Deshalb bleibt das
 * Ganze offline berechenbar, obwohl Zufall im Spiel ist.
 */
export type RequestTemplate = {
  id: string;
  /** Was geliefert werden muss. */
  wants: readonly ItemStack[];
  /** Was es dafür gibt. */
  reward: readonly ItemStack[];
  /** Erfahrung fürs Liefern — die Hauptquelle für Fortschritt (M8). */
  xp: number;
};

/**
 * Ein Platz, der von allein produziert: Bienenstock, Brunnen, Kompost.
 *
 * Taktung ist die Dauer des Rezepts. Einschränkung (bewusst): Passive Rezepte
 * haben keine Eingaben und geben genau eine Einheit aus. Der Grund steht in
 * `produce.ts` — nur so bleibt die geschlossene Form bei geteiltem Lagerplatz
 * beweisbar. Tiere, die Futter brauchen, sind ein Platz mit Eingaben.
 *
 * **Der Basis-Kreislauf nutzt das nicht.** Die Mechanik bleibt trotzdem im Kern:
 * Sie ist der Beweis, dass gedeckelte Akkumulation über beliebig lange
 * Offline-Phasen in geschlossener Form geht (§7) — und der einzige Kandidat für
 * „es passiert etwas, während man weg ist, ohne dass man es angestoßen hat".
 */
export type PassiveDef = {
  id: string;
  recipe: number;
};

export type Ruleset = {
  version: number;

  /** Der Gegenstandskatalog. Indizes sind der Schlüssel im Zustand — append-only. */
  items: readonly ItemDef[];
  /** Katalogindex der Währung. Nicht lagerpflichtig, nicht handelbar. */
  currency: number;
  recipes: readonly RecipeDef[];
  /** Alle Produktionsplätze der Welt, in fester Reihenfolge. */
  plots: readonly PlotDef[];
  /** Alle passiven Produzenten, in fester Reihenfolge. */
  passives: readonly PassiveDef[];

  /** Lagerkapazität gesamt, über alle lagerpflichtigen Waren (§7). */
  siloCapacity: number;

  /**
   * Wie viele Verkaufsaufträge gleichzeitig offen sein dürfen.
   *
   * DAS ist der strukturelle Riegel gegen „Escrow als unendliches Lager" (§8).
   */
  orderSlots: number;
  /** Nach dieser Zeit verfällt ein Auftrag und die Ware geht ins Postfach. **0 = nie.** */
  orderTtlTicks: number;
  /** Einstellgebühr in Prozent vom Warenwert (NPC-Preis × Menge). */
  listingFeePct: number;
  /**
   * Was ein frischer Hof mitbekommt.
   *
   * Seit Saatgut verbraucht wird, ist das keine Freundlichkeit mehr, sondern
   * Voraussetzung: Ohne ein einziges Korn ließe sich kein Feld bestellen, und
   * das Spiel begänne in der Sackgasse, die §6 verbietet.
   */
  startingItems: readonly ItemStack[];
  /** Preisband um den Referenzwert, in Prozent — verhindert Parkpreise (§8). */
  priceBandMinPct: number;
  priceBandMaxPct: number;
  /** Auch das Postfach ist ein Behälter und braucht daher ein Limit (§7). */
  mailCapacity: number;

  /**
   * Wie viele fremde Angebote der Server in den Snapshot legt (M5).
   *
   * Eine Auslage, kein Katalog. Der ganze Markt in jedem Sync wäre bei tausend
   * Höfen ein Megabyte pro Anfrage — und beim Spielen sieht man ohnehin ein
   * Regal an, keine Datenbank. Gleichzeitig ist es der Deckel, der auch diesen
   * Behälter begrenzt (§7).
   */
  offerSlots: number;

  /**
   * Erfahrungsschwellen. `levelThresholds[i]` ist die XP-Grenze für Stufe i+2 —
   * Stufe 1 beginnt bei null.
   *
   * Das Level steht bewusst NICHT im Zustand, sondern wird aus der Erfahrung
   * abgeleitet. Zwei Zahlen, die dasselbe bedeuten, laufen sonst irgendwann
   * auseinander, und dann ist unklar, welche stimmt.
   *
   * Preis dieser Entscheidung: Eine Kurve, die in einem Patch STEIGT, würde
   * Spieler zurückstufen. Deshalb dürfen Schwellen über Versionen hinweg nur
   * sinken — `rules.test.ts` erzwingt das.
   */
  levelThresholds: readonly number[];

  /** Auftragsvorlagen, aus denen der Server auswählt. */
  requestTemplates: readonly RequestTemplate[];
  /** Wie viele Kundenaufträge gleichzeitig annehmbar sind. */
  requestSlots: number;
  /**
   * Wie viele Aufträge der Server auf Vorrat mitgibt.
   *
   * DAS ist die Umsetzung von „Vorrat statt Verbindung" (Architektur §6):
   * Offline gehen die Aufträge nicht aus, weil sie schon im Snapshot liegen.
   * Ist ein Auftrag erledigt, rückt der nächste aus der Schlange nach — ohne
   * Netz, ohne Würfel, rein deterministisch.
   *
   * Ehrlich zur Grenze: Ein endlicher Vorrat kann leerlaufen, und im ersten
   * Feldtest tat er das nach zwölf Lieferungen. Zwei Dinge halten dagegen —
   * eine großzügige Zahl hier, und die Tatsache, dass der NPC-Verkauf immer
   * offen bleibt (§6, „kein Sackgassen-Zustand"). Wer den Vorrat aufbraucht,
   * verliert den Bonus, nicht das Spiel.
   */
  requestQueueMax: number;
};

// ── Katalog-Indizes ────────────────────────────────────────────────────────
//
// Nur zur Lesbarkeit dieser Datei. Der Sim-Kern benutzt sie NICHT.

const GOLD = 0;
const WHEAT = 1;
const FEED = 2;
const EGGS = 3;

const R_WHEAT = 0;
const R_FEED = 1;
const R_EGGS = 2;

const gold = (amount: number): ItemStack[] => [{ item: GOLD, amount }];
const want = (item: number, amount: number): ItemStack => ({ item, amount });

/**
 * Aufträge lohnen sich mehr als der NPC-Verkauf — sonst wären sie Zierde.
 *
 * Zum Vergleich die Ankaufpreise: Weizen 3, Futter 8, Eier 25. Ein Auftrag
 * bringt grob das Anderthalbfache. Genau das gibt dem Kreislauf ein Ziel:
 * Man produziert nicht mehr ins Leere, sondern auf etwas hin.
 */
const REQUESTS: readonly RequestTemplate[] = [
  { id: 'wheat-small', wants: [want(WHEAT, 5)], reward: gold(25), xp: 6 },
  { id: 'wheat-big', wants: [want(WHEAT, 15)], reward: gold(80), xp: 18 },
  { id: 'feed-small', wants: [want(FEED, 2)], reward: gold(25), xp: 10 },
  { id: 'feed-big', wants: [want(FEED, 6)], reward: gold(85), xp: 30 },
  { id: 'eggs-small', wants: [want(EGGS, 3)], reward: gold(110), xp: 35 },
  { id: 'eggs-big', wants: [want(EGGS, 9)], reward: gold(350), xp: 100 },
  { id: 'mixed-farm', wants: [want(WHEAT, 8), want(FEED, 2)], reward: gold(60), xp: 22 },
  { id: 'mixed-market', wants: [want(EGGS, 3), want(WHEAT, 10)], reward: gold(160), xp: 50 },
];

/**
 * Die Levelkurve.
 *
 * Bewusst früh dicht und später weiter: Die ersten Stufen sollen in Minuten
 * kommen, damit man merkt, dass etwas passiert. Danach zieht es an.
 */
const LEVELS: readonly number[] = [40, 120, 280, 560, 1000, 1700, 2800, 4400];

/**
 * Der Basis-Kreislauf, Stand jetzt:
 *
 *   Feld → Weizen → Mühle → Hühnerfutter → Gehege → Eier → Gold → mehr Plätze
 *
 * Bewusst nicht mehr. Jede weitere Mechanik ist neue Fläche, auf der Client und
 * Server auseinanderlaufen können (Roadmap). Inhalt darf später beliebig wachsen
 * — er ist ja nur noch Tabelle.
 */
const V1: Ruleset = {
  version: 1,

  items: [
    { id: 'gold', storable: false, npcPrice: 0, npcBuyPrice: 0 },
    // Weizen ist Saatgut UND Ware. Deshalb als einziges Gut beim Händler
    // erhältlich — zum doppelten Verkaufspreis, damit daraus kein Kreisgeschäft
    // wird.
    { id: 'wheat', storable: true, npcPrice: 3, npcBuyPrice: 6 },
    { id: 'feed', storable: true, npcPrice: 8, npcBuyPrice: 0 },
    { id: 'eggs', storable: true, npcPrice: 25, npcBuyPrice: 0 },
  ],
  currency: GOLD,

  recipes: [
    /**
     * Säen kostet ein Korn, Ernten bringt drei.
     *
     * Vorher kam Weizen aus dem Nichts, und damit war die ganze Wirtschaft eine
     * Einbahnstraße: Zeit rein, Ware raus, ohne Einsatz. Mit Saatgut ist jedes
     * Feld eine Entscheidung — und Weizen bekommt einen echten Preis, weil man
     * ihn auch verbrauchen kann, statt ihn nur zu verkaufen.
     */
    {
      id: 'wheat',
      inputs: [{ item: WHEAT, amount: 1 }],
      output: { item: WHEAT, amount: 3 },
      durationTicks: 120,
      xp: 2,
    },
    {
      id: 'feed',
      inputs: [{ item: WHEAT, amount: 3 }],
      output: { item: FEED, amount: 2 },
      durationTicks: 300,
      xp: 5,
    },
    {
      id: 'eggs',
      inputs: [{ item: FEED, amount: 1 }],
      output: { item: EGGS, amount: 3 },
      durationTicks: 900,
      xp: 14,
    },
  ],

  plots: [
    // Drei Felder gehören dem Spieler von Anfang an — ohne sie gäbe es keinen
    // Einstieg in den Kreislauf.
    { id: 'field-1', startLevel: 1, levels: [{ label: 'Feld', cost: [], recipes: [R_WHEAT] }] },
    { id: 'field-2', startLevel: 1, levels: [{ label: 'Feld', cost: [], recipes: [R_WHEAT] }] },
    { id: 'field-3', startLevel: 1, levels: [{ label: 'Feld', cost: [], recipes: [R_WHEAT] }] },

    // Drei weitere sind das erste, was man sich leisten kann.
    {
      id: 'field-4',
      startLevel: 0,
      levels: [{ label: 'Feld', cost: gold(100), recipes: [R_WHEAT], minPlayerLevel: 2 }],
    },
    {
      id: 'field-5',
      startLevel: 0,
      levels: [{ label: 'Feld', cost: gold(250), recipes: [R_WHEAT], minPlayerLevel: 4 }],
    },
    {
      id: 'field-6',
      startLevel: 0,
      levels: [{ label: 'Feld', cost: gold(500), recipes: [R_WHEAT], minPlayerLevel: 6 }],
    },

    {
      id: 'mill',
      startLevel: 0,
      levels: [{ label: 'Mühle', cost: gold(150), recipes: [R_FEED], minPlayerLevel: 2 }],
    },

    // Zwei Stufen, und genau das sind deine zwei Kaufschritte: erst steht das
    // Gehege leer, dann sind Hühner drin. Ohne Hühner läuft kein Rezept.
    {
      id: 'coop-1',
      startLevel: 0,
      levels: [
        { label: 'Gehege', cost: gold(300), recipes: [], minPlayerLevel: 3 },
        { label: 'Hühner', cost: gold(200), recipes: [R_EGGS] },
      ],
    },
    {
      id: 'coop-2',
      startLevel: 0,
      levels: [
        { label: 'Gehege', cost: gold(800), recipes: [], minPlayerLevel: 5 },
        { label: 'Hühner', cost: gold(400), recipes: [R_EGGS] },
      ],
    },
  ],

  passives: [],

  siloCapacity: 100,
  orderSlots: 4,
  /**
   * 0 = Angebote verfallen nicht.
   *
   * Vorher fielen sie nach einem Tag ins Postfach zurück. Das klang fair und
   * machte den Escrow zum **kostenlosen Zwischenlager**: einstellen, verfallen
   * lassen, neu einstellen — Ware parken, ohne je etwas dafür zu zahlen.
   *
   * Jetzt bleibt liegen, was eingestellt wurde, bis es verkauft oder
   * zurückgeholt wird. Begrenzt ist es durch die Zahl der Plätze, und teuer
   * durch die Einstellgebühr darunter. Die Mechanik selbst steht weiter im
   * Kern; ein Regelwerk kann sie mit einem Wert > 0 jederzeit wieder
   * einschalten.
   */
  orderTtlTicks: 0,
  /**
   * Einstellgebühr in Prozent vom **Warenwert** (NPC-Preis × Menge), fällig
   * beim Einstellen.
   *
   * Der Riegel gegen „Escrow als Lager": Parken kostet jetzt etwas, und zwar
   * sofort und unabhängig davon, ob je jemand kauft. Nebenbei ist es die erste
   * echte Geldsenke im Spiel — ohne eine solche wächst die Geldmenge nur.
   *
   * Bewusst vom NPC-Preis und nicht vom Wunschpreis: Sonst wäre die Gebühr
   * eine Strafe aufs Hochpreisen, und alle böten am unteren Bandrand an.
   */
  listingFeePct: 5,
  // Sechs Körner: zwei je Startfeld. Reicht für den ersten Umlauf, ohne den
  // Anfang zu verschenken.
  startingItems: [{ item: WHEAT, amount: 6 }],
  priceBandMinPct: 25,
  priceBandMaxPct: 150,
  mailCapacity: 20,
  offerSlots: 12,

  levelThresholds: LEVELS,
  requestTemplates: REQUESTS,
  requestSlots: 3,
  // Zwanzig auf Vorrat. Bei Produktionszeiten sind das mehrere Stunden
  // Offline-Spiel — im ersten Feldtest waren zwölf nach einer Sitzung leer.
  requestQueueMax: 20,
};

/**
 * Ein Balance-Patch, wie er im Live-Betrieb wöchentlich vorkommt: andere Zeiten,
 * andere Preise, größeres Lager. Die Form des Zustands bleibt gleich.
 *
 * Er steht hier nicht als Inhalt, sondern als **arbeitendes Beispiel**: Ohne
 * mindestens zwei Versionen wäre die ganze Migrationsmaschinerie aus R2 nur
 * Theorie — und sie ist genau das, was ein Live-Service-Spiel am Laufen hält.
 * Der erste echte Patch ersetzt diese Zahlen.
 */
const V2: Ruleset = {
  ...V1,
  version: 2,
  items: [
    { id: 'gold', storable: false, npcPrice: 0, npcBuyPrice: 0 },
    { id: 'wheat', storable: true, npcPrice: 4, npcBuyPrice: 8 },
    { id: 'feed', storable: true, npcPrice: 9, npcBuyPrice: 0 },
    { id: 'eggs', storable: true, npcPrice: 28, npcBuyPrice: 0 },
  ],
  recipes: [
    {
      id: 'wheat',
      inputs: [{ item: WHEAT, amount: 1 }],
      output: { item: WHEAT, amount: 3 },
      durationTicks: 100,
      xp: 2,
    },
    {
      id: 'feed',
      inputs: [{ item: WHEAT, amount: 3 }],
      output: { item: FEED, amount: 2 },
      durationTicks: 240,
      xp: 5,
    },
    {
      id: 'eggs',
      inputs: [{ item: FEED, amount: 1 }],
      output: { item: EGGS, amount: 3 },
      durationTicks: 720,
      xp: 14,
    },
  ],
  siloCapacity: 120,
  // Mehr Slots als Progressions-Buff. Achtung: WENIGER Slots wären ein
  // Migrationsproblem — bestehende Aufträge würden die Invariante verletzen.
  orderSlots: 6,
};

/**
 * Entwicklungs-Tempo: derselbe Inhalt wie V1, Uhren zehnmal schneller.
 *
 * Die Versionsnummer liegt bewusst WEIT außerhalb der Produktionsreihe. Ein
 * Dev-Regelwerk darf nie versehentlich Ziel einer Migration werden — sonst
 * bekäme irgendwann ein echter Spielstand Sekundenzeiten. Es gibt keinen Pfad
 * hinein und keinen hinaus; ein Dev-Spielstand ist Wegwerfware.
 */
const DEV: Ruleset = {
  ...V1,
  version: 1001,
  recipes: [
    {
      id: 'wheat',
      inputs: [{ item: WHEAT, amount: 1 }],
      output: { item: WHEAT, amount: 3 },
      durationTicks: 12,
      xp: 2,
    },
    {
      id: 'feed',
      inputs: [{ item: WHEAT, amount: 3 }],
      output: { item: FEED, amount: 2 },
      durationTicks: 30,
      xp: 5,
    },
    {
      id: 'eggs',
      inputs: [{ item: FEED, amount: 1 }],
      output: { item: EGGS, amount: 3 },
      durationTicks: 90,
      xp: 14,
    },
  ],
};

/**
 * Der Server hält bewusst mehrere Versionen vor (R2). Ein Client, dessen Version
 * hier nicht mehr steht, muss vor dem Sync updaten — sauberer, angekündigter
 * Bruch statt stiller Divergenz.
 */
export const RULESETS: ReadonlyMap<number, Ruleset> = new Map([
  [1, V1],
  [2, V2],
  [1001, DEV],
]);

/**
 * Die Produktionsreihe, in Migrationsreihenfolge.
 *
 * Nur entlang dieser Kette wird migriert. Das Dev-Regelwerk steht bewusst nicht
 * drin — siehe `DEV`.
 */
export const PRODUCTION_VERSIONS: readonly number[] = [1, 2];

/** Womit ein frischer Hof in Produktion startet. */
export const CURRENT_RULESET_VERSION = 1;

/** Die Version, auf die der Server neue Snapshots hebt. */
export const LATEST_RULESET_VERSION = 2;

/** Schnelle Uhren fürs Entwickeln und für Feldtests von Hand. */
export const DEV_RULESET_VERSION = 1001;

export function getRuleset(version: number): Ruleset {
  const r = RULESETS.get(version);
  if (!r) throw new Error(`unsupported ruleset version: ${version}`);
  return r;
}

// ── Abfragen auf dem Katalog ───────────────────────────────────────────────

/** Welche Rezepte auf diesem Platz laufen, wenn er auf `level` ausgebaut ist. */
export function levelRecipes(rules: Ruleset, plot: number, level: number): readonly number[] {
  if (level <= 0) return [];
  return rules.plots[plot]?.levels[level - 1]?.recipes ?? [];
}

/**
 * Spielerlevel aus Erfahrung ableiten (M8).
 *
 * Abgeleitet statt gespeichert: Zwei Zahlen, die dasselbe bedeuten, laufen
 * irgendwann auseinander — und dann ist unklar, welche gilt. Stufe 1 beginnt
 * bei null Erfahrung.
 */
export function levelOf(rules: Ruleset, xp: number): number {
  let level = 1;
  for (const threshold of rules.levelThresholds) {
    if (xp < threshold) break;
    level++;
  }
  return level;
}

/** Erfahrung, ab der die nächste Stufe beginnt — `null` beim Maximum. */
export function nextLevelAt(rules: Ruleset, xp: number): number | null {
  for (const threshold of rules.levelThresholds) {
    if (xp < threshold) return threshold;
  }
  return null;
}

/** Erfahrung, bei der die aktuelle Stufe begonnen hat — für den Fortschrittsbalken. */
export function levelStartedAt(rules: Ruleset, xp: number): number {
  let start = 0;
  for (const threshold of rules.levelThresholds) {
    if (xp < threshold) break;
    start = threshold;
  }
  return start;
}

/** Kosten für die nächste Stufe — `null`, wenn schon voll ausgebaut. */
export function nextLevel(rules: Ruleset, plot: number, level: number): LevelDef | null {
  return rules.plots[plot]?.levels[level] ?? null;
}

/**
 * Tabellen, die sich aus dem Katalog ergeben — einmal je Regelwerk berechnet.
 *
 * Reiner Zwischenspeicher: dieselbe Eingabe liefert immer dasselbe Ergebnis, er
 * ist für den Determinismus also unsichtbar. Er ist trotzdem nötig. Seit der
 * Zustand ein Inventar-Array ist, muss „wie voll ist das Lager" über den
 * Katalog laufen — und diese Frage stellt der Sim-Kern mehrfach *pro Command*.
 */
export type DerivedTables = {
  /** Indizes der lagerpflichtigen Gegenstände. */
  storable: number[];
  /** Taktung je passivem Produzenten. */
  passiveIntervals: number[];
  /** Ausgabe-Gegenstand je passivem Produzenten. */
  passiveOutputs: number[];
};

const derived = new Map<Ruleset, DerivedTables>();

export function derivedTables(rules: Ruleset): DerivedTables {
  const cached = derived.get(rules);
  if (cached) return cached;

  const storable: number[] = [];
  for (let i = 0; i < rules.items.length; i++) {
    if (rules.items[i]!.storable) storable.push(i);
  }

  const passiveIntervals: number[] = [];
  const passiveOutputs: number[] = [];
  for (const passive of rules.passives) {
    const recipe = rules.recipes[passive.recipe]!;
    passiveIntervals.push(recipe.durationTicks);
    passiveOutputs.push(recipe.output.item);
  }

  const tables = { storable, passiveIntervals, passiveOutputs };
  derived.set(rules, tables);
  return tables;
}

/** Taktung eines passiven Produzenten = Dauer seines Rezepts. Eine Zahl, eine Wahrheit. */
export function passiveInterval(rules: Ruleset, passive: number): number {
  return rules.recipes[rules.passives[passive]!.recipe]!.durationTicks;
}

/**
 * Darf dieser Gegenstand auf dem Spielermarkt eingestellt werden?
 *
 * Abgeleitet statt eigenes Flag: Handelbar ist, was lagerfähig ist und einen
 * Referenzpreis hat — ohne Referenz gäbe es kein Preisband (§8), und ohne
 * Preisband wäre der Auftrag ein Parkplatz für Ware.
 */
export function isTradable(rules: Ruleset, item: number): boolean {
  const def = rules.items[item];
  return def !== undefined && def.storable && def.npcPrice > 0;
}

/**
 * Was das Einstellen kostet — die eine Rechnung, an zwei Stellen gebraucht.
 *
 * Die Sim zieht sie ab, die Oberfläche zeigt sie vorher an. Stünde sie zweimal
 * da, wäre der angezeigte Preis irgendwann ein anderer als der bezahlte — und
 * ein Spieler, der auf „Einstellen" tippt und plötzlich weniger Gold hat als
 * angekündigt, glaubt dem Spiel nichts mehr.
 *
 * Bemessen am NPC-Wert, nicht am Wunschpreis: Sonst wäre die Gebühr eine Strafe
 * aufs Hochpreisen, und alle böten am unteren Bandrand an.
 *
 * Aufgerundet mit `Math.floor`, nicht mit `Math.ceil`: Der Purity-Wächter lässt
 * im Kern nur `Math.floor` durch, weil jede andere Math-Funktion Floats
 * einschleppen kann (§2.2). `(x + 99) / 100` abgerundet ist dasselbe wie
 * `x / 100` aufgerundet — für positive ganze Zahlen exakt.
 */
export function listingFee(rules: Ruleset, item: number, amount: number): number {
  const def = rules.items[item];
  if (!def) return 0;
  return Math.floor((def.npcPrice * amount * rules.listingFeePct + 99) / 100);
}

/**
 * Prüft ein Regelwerk auf Widersprüche.
 *
 * Kataloge sind Daten, und Daten haben keinen Compiler. Ein Rezept, das auf
 * einen Gegenstand zeigt, den es nicht gibt, wäre sonst erst im Spiel
 * aufgefallen — bei einem Spieler, offline, ohne Netz für einen Hotfix.
 */
export function validateRuleset(rules: Ruleset): string[] {
  const problems: string[] = [];
  const itemOk = (i: number) => Number.isInteger(i) && i >= 0 && i < rules.items.length;

  if (!itemOk(rules.currency)) problems.push(`Währung ${rules.currency} steht nicht im Katalog`);
  else if (rules.items[rules.currency]!.storable) {
    problems.push('Währung darf nicht lagerpflichtig sein');
  }

  for (const [i, item] of rules.items.entries()) {
    if (item.npcPrice < 0 || !Number.isInteger(item.npcPrice)) {
      problems.push(`Gegenstand ${i} (${item.id}): ungültiger Preis ${item.npcPrice}`);
    }
  }

  for (const [i, r] of rules.recipes.entries()) {
    if (!Number.isInteger(r.durationTicks) || r.durationTicks < 1) {
      problems.push(`Rezept ${i} (${r.id}): Dauer ${r.durationTicks} < 1`);
    }
    if (!Number.isInteger(r.xp) || r.xp < 0) problems.push(`Rezept ${i} (${r.id}): XP ungültig`);
    if (!itemOk(r.output.item)) problems.push(`Rezept ${i} (${r.id}): Ausgabe unbekannt`);
    if (!Number.isInteger(r.output.amount) || r.output.amount < 1) {
      problems.push(`Rezept ${i} (${r.id}): Ausgabemenge ${r.output.amount} < 1`);
    }
    const seen = new Set<number>();
    for (const input of r.inputs) {
      if (!itemOk(input.item)) problems.push(`Rezept ${i} (${r.id}): Eingabe unbekannt`);
      if (!Number.isInteger(input.amount) || input.amount < 1) {
        problems.push(`Rezept ${i} (${r.id}): Eingabemenge ${input.amount} < 1`);
      }
      // Doppelte Zutat: Die Bestandsprüfung im Sim-Kern geht Zutat für Zutat
      // vor und würde denselben Vorrat zweimal zählen.
      if (seen.has(input.item)) problems.push(`Rezept ${i} (${r.id}): Zutat doppelt`);
      seen.add(input.item);
    }
  }

  for (const [i, p] of rules.plots.entries()) {
    if (p.levels.length === 0) problems.push(`Platz ${i} (${p.id}): keine Stufen`);
    if (!Number.isInteger(p.startLevel) || p.startLevel < 0 || p.startLevel > p.levels.length) {
      problems.push(`Platz ${i} (${p.id}): Startstufe ${p.startLevel} außerhalb der Stufen`);
    }
    for (const [l, level] of p.levels.entries()) {
      for (const r of level.recipes) {
        if (!Number.isInteger(r) || r < 0 || r >= rules.recipes.length) {
          problems.push(`Platz ${i} (${p.id}) Stufe ${l + 1}: Rezept ${r} gibt es nicht`);
        }
      }
      for (const c of level.cost) {
        if (!itemOk(c.item)) problems.push(`Platz ${i} (${p.id}) Stufe ${l + 1}: Preis unbekannt`);
        if (!Number.isInteger(c.amount) || c.amount < 1) {
          problems.push(`Platz ${i} (${p.id}) Stufe ${l + 1}: Preis ${c.amount} < 1`);
        }
      }
      // Eine Startstufe, die etwas kostet oder ein Level verlangt, wäre ein
      // Widerspruch: Sie ist ja schon da, bezahlt hat sie nie jemand.
      if (l < p.startLevel && level.cost.length > 0) {
        problems.push(`Platz ${i} (${p.id}) Stufe ${l + 1}: Startstufe mit Preis`);
      }
      if (l < p.startLevel && level.minPlayerLevel !== undefined) {
        problems.push(`Platz ${i} (${p.id}) Stufe ${l + 1}: Startstufe mit Levelsperre`);
      }
      if (
        level.minPlayerLevel !== undefined &&
        (!Number.isInteger(level.minPlayerLevel) || level.minPlayerLevel < 1)
      ) {
        problems.push(`Platz ${i} (${p.id}) Stufe ${l + 1}: Levelsperre < 1`);
      }
      if ((level.minPlayerLevel ?? 1) > rules.levelThresholds.length + 1) {
        problems.push(
          `Platz ${i} (${p.id}) Stufe ${l + 1}: Levelsperre über dem Maximum — nie erreichbar`,
        );
      }
    }
  }

  for (const [i, p] of rules.passives.entries()) {
    if (!Number.isInteger(p.recipe) || p.recipe < 0 || p.recipe >= rules.recipes.length) {
      problems.push(`Passive ${i} (${p.id}): Rezept ${p.recipe} gibt es nicht`);
      continue;
    }
    const recipe = rules.recipes[p.recipe]!;
    // Siehe PassiveDef: Diese drei Einschränkungen tragen die geschlossene Form.
    if (recipe.inputs.length > 0) problems.push(`Passive ${i} (${p.id}): Rezept braucht Eingaben`);
    if (recipe.output.amount !== 1) problems.push(`Passive ${i} (${p.id}): Ausgabemenge != 1`);
    if (!rules.items[recipe.output.item]?.storable) {
      problems.push(`Passive ${i} (${p.id}): Ausgabe ist nicht lagerpflichtig`);
    }
  }

  let previous = 0;
  for (const [i, threshold] of rules.levelThresholds.entries()) {
    if (!Number.isInteger(threshold) || threshold <= previous) {
      problems.push(`Levelschwelle ${i}: ${threshold} nicht größer als ${previous}`);
    }
    previous = threshold;
  }

  for (const [i, t] of rules.requestTemplates.entries()) {
    if (!Number.isInteger(t.xp) || t.xp < 0) problems.push(`Auftrag ${i} (${t.id}): XP ungültig`);
    if (t.wants.length === 0) problems.push(`Auftrag ${i} (${t.id}): verlangt nichts`);
    if (t.reward.length === 0) problems.push(`Auftrag ${i} (${t.id}): gibt nichts`);
    for (const stack of [...t.wants, ...t.reward]) {
      if (!itemOk(stack.item)) problems.push(`Auftrag ${i} (${t.id}): Gegenstand unbekannt`);
      if (!Number.isInteger(stack.amount) || stack.amount < 1) {
        problems.push(`Auftrag ${i} (${t.id}): Menge ${stack.amount} < 1`);
      }
    }
    // Doppelte Posten: Der Sim-Kern prüft Posten für Posten und zählt sonst
    // denselben Vorrat zweimal — derselbe Fallstrick wie bei Rezept-Zutaten.
    const seen = new Set<number>();
    for (const stack of t.wants) {
      if (seen.has(stack.item)) problems.push(`Auftrag ${i} (${t.id}): Posten doppelt`);
      seen.add(stack.item);
    }
  }
  if (rules.requestSlots < 1) problems.push('Auftrags-Slots < 1');
  if (rules.requestQueueMax < rules.requestSlots) {
    problems.push('Auftragsvorrat kleiner als die Zahl der Slots');
  }

  if (rules.siloCapacity < 1) problems.push('Lagerkapazität < 1');
  if (rules.mailCapacity < 1) problems.push('Postfachkapazität < 1');
  if (rules.priceBandMinPct > rules.priceBandMaxPct) problems.push('Preisband verkehrt herum');
  if (rules.offerSlots < 0) problems.push('Angebots-Slots negativ');
  if (rules.listingFeePct < 0 || rules.listingFeePct > 100) {
    problems.push(`Einstellgebühr außerhalb 0…100: ${rules.listingFeePct}`);
  }
  rules.items.forEach((item, i) => {
    // Der Händler darf nie billiger verkaufen, als er ankauft — das wäre eine
    // Geldpresse, und zwar eine, die ein Skript in Sekunden leerräumt.
    if (item.npcBuyPrice > 0 && item.npcBuyPrice <= item.npcPrice) {
      problems.push(
        `Gegenstand ${i} (${item.id}): Ankauf ${item.npcBuyPrice} <= Verkauf ${item.npcPrice} — Geldpresse`,
      );
    }
  });

  return problems;
}

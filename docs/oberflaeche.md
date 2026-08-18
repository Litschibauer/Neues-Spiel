# Eigene Designs einsetzen — und der Weg zur eigenen App

Zwei Fragen, eine Antwort: **Die Oberfläche ist die Wegwerfschicht.** Alles
darunter — Regeln, Zustand, Zeitautorität, Sync, Markt — ist von ihr getrennt
und weiß nichts von Farben, Kacheln oder HTML. Ein neues Design tauscht die
oberste Schicht aus, eine native App ersetzt sie durch eine andere. Beides
lässt den Rest unberührt.

```
    ┌─────────────────────────────────────────────┐
    │  Darstellung  — HTML/CSS heute, später was  │   austauschbar
    │                 auch immer                  │
    ├─────────────────────────────────────────────┤
    │  view.ts      — „ist reif", „bezahlbar",    │   wiederverwendbar
    │                 „passt ins Lager"           │
    ├─────────────────────────────────────────────┤
    │  client.ts / sync-engine.ts                 │   wiederverwendbar
    ├─────────────────────────────────────────────┤
    │  sim/*        — der Kern, bit-genau          │   unantastbar
    └─────────────────────────────────────────────┘
```

---

## Wo was liegt

Die Spielseite ist in Teile zerlegt, die der Build wieder zu **einer** Datei
zusammensetzt (`<!--INCLUDE:…-->`). Der Offline-Start bleibt damit unverändert
— im Cache liegt weiterhin eine einzige Datei —, aber wer die Gestaltung
anfasst, öffnet eine CSS-Datei statt zweitausend Zeilen HTML.

| Datei | Was drinsteht | Zeilen |
| --- | --- | --- |
| `web/farm/style.css` | **Farben, Maße, alles Optische** | 328 |
| `web/farm/page.html` | Das Gerüst und die Include-Liste | 171 |
| `web/farm/bilder.js` | Die SVG-Zeichnungen der Plätze | 154 |
| `web/farm/texte.js` | Jedes deutsche Wort | 30 |
| `web/farm/anzeige.js` | Zeichnen aus dem Anzeigemodell | 527 |
| `web/farm/tippen.js` | Was ein Tipp auslöst | 97 |
| `web/farm/verbindung.js` | Speichern, API, Live-Leitung | 142 |
| `web/farm/start.js` | Startreihenfolge, Lease, Sync | 207 |

Für eigene Gestaltung reichen die ersten drei.

## Die drei Stellen, an denen Design stattfindet

### 1. Die Farben und Maße — `web/farm/style.css`

Ganz oben in der Datei stehen die Gestaltungswerte, und **nur dort**. Kein
Farbwert steht sonst irgendwo; ein `grep` nach `#` in `web/farm/` zeigt es.

```css
:root {
  --ground: …; --surface: …; --line: …;   /* Flächen */
  --ink: …; --muted: …;                   /* Schrift */
  --accent: …; --gold: …; --ripe: …;      /* Bedeutung */
  --soil: …; --leaf: …; --sky: …;         /* die Zeichnungen */
  --on-accent: …; --egg: …;               /* Kontrastpartner */
}
```

Drei Blöcke, und alle drei müssen mit: `:root` (hell), der
`prefers-color-scheme: dark`-Block, und `:root[data-theme="dark"]`. Der dritte
ist kein Duplikat — er lässt eine spätere Umschaltung im Spiel gewinnen,
unabhängig von der Systemeinstellung.

### 2. Die Zeichnungen — die Tabelle `ART` in `web/farm/bilder.js`

```js
var ART = {
  'field-': function (p) { … },   // Muster: greift für field-1, field-2, …
  'mill':   function (p) { … },   // exakte Katalog-Kennung
  'coop-':  function (p) { … },
  fallback: function () { … },
};
```

Jeder Eintrag bekommt eine **Platz-Ansicht** (siehe unten) und gibt SVG-Inhalt
zurück. Was darin steht, ist frei: gezeichnete Pfade wie heute, ein `<image>`
mit eingebettetem PNG, ein `<use>` auf ein Sprite.

Was die Funktion an Information hat, reicht für jede Darstellung:

| Feld | Bedeutung |
| --- | --- |
| `p.id` | Katalog-Kennung des Platzes |
| `p.level` | Ausbaustufe — bei Ställen zugleich die Zahl der Tiere |
| `rules.plots[i].place` | wo der Platz auf dem Hof steht: `x, y, w, h` in Prozent |
| `p.capacity` / `p.free` | wie viele Tiere darin Platz haben, wie viele davon hungrig sind |
| `p.busy` / `p.done` | läuft gerade / kann abgeholt werden |
| `p.progress` | 0…1, für Wachstumsstufen oder einen Ring |
| `p.producing` | Katalog-Kennung dessen, was gerade entsteht |

Trägt man nichts ein, geht nichts kaputt: Eine unbekannte Kennung bekommt
`fallback`. **Ein neues Gebäude ist sofort spielbar** und sieht nur eine
Version lang generisch aus.

### Der Hof ist eine Fläche, kein Raster

Die Plätze liegen nicht in einem CSS-Grid, sondern an festen Stellen: `place`
im Katalog, vier Zahlen in Prozent. Dahinter liegt **eine** gezeichnete
Landschaft (`artScene()` — Himmel, Hügel, Wiese, Weg, Hofhaus, Bäume), darüber
dieselben `<button>` wie vorher, nur absolut positioniert und nach `y`
sortiert, damit Vordergrund Hintergrund überdeckt.

Warum die Knöpfe HTML bleiben und nicht in die SVG wandern: Antippen, Fokus,
Sperr-Zustände und der Ausbau-Knopf funktionieren so von allein. Ein `<g>`
könnte das auch — bezahlt mit handgeschriebener Tastatur- und Fokuslogik, für
genau null Gewinn.

Zwei Dinge macht `validateRuleset` unmöglich: zwei Plätze am selben Ort und ein
Platz, der aus dem Bild fällt. Dieselbe Sorte Riegel wie „kein Gebäude, das
man kaufen und nicht benutzen kann".

**Der Ort ist Katalogdaten, nicht Spielzustand.** Der Sim-Kern weiß nichts
davon, es gibt kein Command dafür und keine Migration. Erst wenn Spieler ihren
Hof *umbauen* dürfen, wird daraus Zustand — dann aber bewusst, mit `MOVE` als
Command und allem, was daran hängt.

> Warum eingebettet und nicht als Bilddatei: Die Seite muss im Funkloch
> vollständig sein. Ein nachzuladendes PNG wäre genau die Lücke, die den
> Offline-Start wieder kaputt macht. Als Data-URI in der Vorlage ist es Teil
> der Datei — und der Service Worker hat es damit automatisch mit.

### 3. Die Texte — `web/farm/texte.js` und die Renderer

Anzeigenamen stehen in `NAMES`, alles andere direkt in der jeweiligen
`render…`-Funktion; `plotStatus()` etwa erzeugt jeden Statussatz einer Kachel.
Das ist bewusst nicht zentralisiert: Solange es eine Sprache gibt, ist eine
Textdatei mehr Buchhaltung als Nutzen. Sobald es zwei werden, wird daraus eine
Tabelle — und weil im Anzeigemodell **kein einziges deutsches Wort** steht,
ist das dann eine reine Oberflächenarbeit.

---

## Das Anzeigemodell — warum ein eigenes Design billig ist

`src/client/view.ts` beantwortet die Fragen, die **jede** Oberfläche stellt:

```js
var v = NS.farmView(client.preview(), rules, navigator.onLine);
```

```
v.level, v.xp {into, span, atMax}   v.currency {item, amount}
v.silo {used, capacity, full, free}
v.plots[]      {id, level, idle, busy, done, progress, remaining,
                producing, output, tap, blocked, upgrade,
                capacity, free, slots[]}
v.plots[].slots[] {index, busy, done, progress, remaining,
                producing, output, next, tap}
v.requests[]   {wants, reward, xp, waiting, deliverable}
v.offers[]     {item, amount, price, total, affordable, fits}
v.orders[]     {item, amount, price, expiresIn}
v.stock[]      {id, amount, sellable, npcPrice, bandMax}
v.buyable
```

Zwei Eigenschaften machen den Unterschied:

**Es enthält keinen Anzeigetext.** Nur Zahlen, Flags und Katalog-Kennungen —
ein Test erzwingt das. Ein Statussatz an dieser Stelle wäre bequem und würde
genau verhindern, worum es geht: dass eine zweite Oberfläche, ein anderes
Design oder eine andere Sprache billig bleibt.

**Ein Platz kann mehrere Produktionen gleichzeitig haben.** `p.slots[]` ist die
Liste — jedes Tier eines Stalls steht dort mit eigener Uhr. Die Felder auf `p`
selbst beschreiben weiterhin die Kachel: `p.done`, sobald *irgendein* Tier
fertig ist, `p.remaining` die kürzeste laufende Uhr. Ein Platz mit genau einem
Platz verhält sich damit exakt wie vorher.

**Es beantwortet jede Frage genau einmal.** `p.tap` sagt, was ein Tipp auslöst
— dieselbe Antwort, die auch die Kachel beschriftet. Vorher stand diese
Reihenfolge zweimal da, einmal beim Zeichnen und einmal beim Antippen. Zwei
Stellen, die dasselbe wissen müssen, laufen irgendwann auseinander.

`p.blocked` sagt **warum** etwas nicht geht: `level`, `cost`, `inputs`,
`space`, `slots`, `offline`. Der Unterschied zwischen „zu teuer" und „Stufe
fehlt" ist der zwischen „gleich" und „später" — den muss eine Oberfläche
zeigen können, und sie soll ihn nicht selbst herleiten müssen.

Das Modell ist in Node prüfbar, ohne Browser: `test/view.test.ts`. Damit hat
die Oberflächenlogik zum ersten Mal überhaupt eine Absicherung.

---

## Der Weg zur eigenständigen App

Ehrlich der Reihe nach, vom billigsten zum teuersten.

### Heute schon: installierbar

Die Seite ist eine PWA — Manifest, Service Worker, Start ohne Netz. Auf iOS und
Android landet sie über „Zum Home-Bildschirm" als eigenes Symbol ohne
Browserleiste. **Kein App Store, keine Signierung, kein Review.** Für einen
Feldtest mit echten Leuten reicht das vollständig.

Grenzen, klar gesagt: kein Eintrag im Store, keine Push-Nachrichten auf iOS
ohne Zusatzarbeit, und iOS räumt den Speicher einer selten benutzten PWA
irgendwann auf — der Hof ist dann weg, wenn der Schlüssel nicht notiert ist.

### Der nächste Schritt: dieselbe Seite in einer nativen Hülle

Capacitor oder Tauri packen genau diese Dateien in eine echte App: Store-Eintrag,
Symbol, Push, dauerhafter Speicher. Der Spielcode bleibt Zeile für Zeile
derselbe. Das ist der Weg, den ich empfehlen würde, wenn „richtige App" das
Ziel ist — er kostet Tage, nicht Monate.

### Der teure Weg: native Oberfläche, portierter Kern

Eine Oberfläche in Swift oder Kotlin bedeutet, dass der **Sim-Kern zweimal
existiert**. Und zwei Implementierungen müssen bit-für-bit dasselbe rechnen,
sonst wirft der Server die Arbeit des Spielers weg (R1).

Dafür ist im Projekt schon alles vorbereitet, und das war kein Zufall:

- **`sim/*` benutzt keine Plattform-API.** Nur Integer, keine Floats, keine
  Systemzeit, keine Locale-abhängige Formatierung (§2.2).
- **Die Golden Vectors** (`test/vectors/golden.json`) sind 243 komplette
  Sitzungen mit erwartetem Endzustand. Eine Portierung ist genau dann fertig,
  wenn sie alle reproduziert.
- **Der Prüfstand** (`dist/conformance.html`) lässt sie in einer fremden
  Laufzeit durchlaufen und zeigt die erste Abweichung.
- **Die kanonische Serialisierung** (`sim/canonical.ts`) ist reines
  String-Bauen aus Zahlen — bewusst ohne Krypto und ohne Bibliothek, damit sie
  sich in jeder Sprache in einer Stunde nachbauen lässt.

Der Server bleibt unverändert: HTTP und JSON, nichts Browserspezifisches.

**Empfehlung:** PWA für den Feldtest, native Hülle für den Store. Den
portierten Kern erst, wenn es einen Grund gibt, der über „nativ klingt besser"
hinausgeht — die Prüfmaschinerie dafür steht, aber sie kostet dauerhaft Pflege.

---

## Schwaches Netz

Der unangenehmste Netzzustand ist nicht „kein Netz", sondern „ein Balken".

**Kein Netz ist harmlos.** Der Aufruf scheitert sofort, das Backoff greift, die
Warteschlange bleibt, das Spiel läuft weiter. Es gibt keinen Offline-Modus, in
den umgeschaltet werden müsste (§10).

**Schwaches Netz hängt.** Die Anfrage scheitert nicht — sie kommt nur nie
zurück. Genau daran fehlte lange eine Frist: `inFlight` blieb gesetzt, jeder
weitere Versuch prallte daran ab, und der Client synchronisierte nie wieder,
ohne dass irgendwo ein Fehler auftrat. Ein hängender Client sieht für den
Spieler aus wie ein verbundener.

Was jetzt passiert:

| Lage | Verhalten |
| --- | --- |
| Anfrage hängt > 15 s | wird abgebrochen, gilt als Fehlversuch, Backoff greift |
| Langsam, aber trägt | wird abgewartet — langsam ist nicht kaputt |
| Server hatte den Batch schon | beim nächsten Versuch als Präfix erkannt, nichts doppelt (§9) |
| Anzeige | „Netz zu schwach — läuft weiter", getrennt von „ohne Netz" |

Abbrechen ist unbedenklich, weil der Sync idempotent ist: Ob der Server den
Batch angewandt hatte, muss den Client nicht interessieren.

`engine.timeouts` zählt die Fristüberschreitungen — das Maß dafür, wie schlecht
die Verbindung eines Spielers wirklich ist.

Die Frist steht auf 15 Sekunden. Bewusst großzügig: Es geht um hängende
Verbindungen, nicht um langsame. Eine zu kurze Frist macht aus schwachem Netz
gar keines.

## Live-Anstöße — der Markt aktualisiert sich von selbst

Bis vor Kurzem fragte die Seite alle vier Sekunden nach. Für den eigenen Hof
reicht das: Der ändert sich nur, wenn man selbst etwas tut. Für den Markt nicht.
Wer ein neues Angebot einstellte, sah es sofort — alle anderen erst beim
nächsten Timer.

Und tatsächlich nicht einmal dann. Die Sync-Maschine schickt ohne `force`
nichts, wenn die Warteschlange leer ist (`nothing-to-do`); wer also nur zuschaut,
saß auf einem Markt, der sich nie bewegte, bis er irgendwo hintippte.

### Was über die Leitung geht

**Ein Wort: „nudge".** Keine Spieldaten, keine Zustände, keine Preise.

Das ist die wichtigste Entscheidung an dieser Stelle, und sie ist bewusst
unbequem: Den neuen Zustand gleich mitzuschicken wäre naheliegend und wäre ein
zweiter Weg in den Client hinein — mit eigener Reihenfolge, eigenem Fehlerfall
und eigener Vertrauensfrage. Der Sync ist sorgfältig gebaut: lückenlose `seq`,
Präfix-Commit, Kanarienvogel. Ein Nebeneingang, der Zustand hineinreicht, umginge
das alles.

Also stößt der Server nur an, und die Seite macht daraufhin, was sie ohnehin
kann: einen ganz normalen erzwungenen Sync. **Ein Codeweg, kein zweiter
Zustandspfad.** Wer sich in diesen Kanal einklinkt, kann einen Hof zu einem Sync
überreden. Mehr nicht.

### Wann angestoßen wird

| Auslöser | Wer bekommt ihn |
| --- | --- |
| Angebot eingestellt oder zurückgezogen | alle **außer** dem Auslöser — der hält die Antwort schon in der Hand |
| Angebot gekauft | der Verkäufer (`farm`) und alle anderen (`market`) |
| Sonstiger Sync | niemand — ein Erntetipp geht keinen etwas an |

Die letzte Zeile ist die wichtige: `publishOrders` meldet zurück, ob sich am Buch
wirklich etwas geändert hat, und nur dann geht ein Anstoß raus.

### Die drei Stellen, an denen so etwas kaputtgeht

1. **Rückkopplung.** Kauf → Buchänderung → Anstoß an alle → Sync → Kauf. Ohne
   Bremse baut sich das bei ein paar hundert Aktiven zu Dauerfeuer auf. Der Hub
   bündelt deshalb: Was in derselben Sekunde auflief, ist **ein** Anstoß
   (`minIntervalMs`, Standard 1 s).
2. **Gleichzeitigkeit.** Ein Anstoß geht an alle zur selben Millisekunde. Ohne
   Streuung antworten tausend Geräte gleichzeitig, und ein Server, der einen
   Verkauf verkraftet, geht an dessen Benachrichtigung kaputt. Die Seite wartet
   deshalb 0–500 ms zufällig, bevor sie synct.
3. **Tote Leitungen.** Ein stiller SSE-Strom wird von Proxys, Mobilfunknetzen und
   Handy-Betriebssystemen irgendwann leise zugemacht. Ohne Herzschlag hält der
   Server ihn für offen und der Client wartet auf Anstöße, die nie kommen. Alle
   25 Sekunden geht deshalb ein Kommentar raus; wessen Schreibversuch scheitert,
   fliegt aus der Liste.

### Warum `fetch` und nicht `EventSource`

`EventSource` kann keine Header setzen — der Hof-Schlüssel müsste in die URL, und
dort landet er im Serverprotokoll und in jedem Proxy dazwischen. Ein Lesestrom
über `fetch` behält ihn im Header, wie bei jedem anderen Aufruf. Der Preis sind
etwa fünfzehn Zeilen selbstgebauter Reconnect; das ist es wert.

### Was passiert, wenn es nicht geht

Nichts Schlimmes, und das ist Absicht. Der Timer läuft weiter, `visibilitychange`
und `online` erzwingen ohnehin einen Sync, und der Server weist überzählige
Leitungen ehrlich ab (`503 TOO_MANY_STREAMS`) statt eine offenzuhalten, die nie
etwas liefert. **Es gibt keinen Zustand, in dem das Spiel auf einen Anstoß
wartet.**

Auf dem Server steht dafür eine Obergrenze (`NEUES_SPIEL_MAX_EVENT_STREAMS`,
Standard 2000): Jede offene Verbindung kostet Speicher, auch wenn stundenlang
nichts passiert, und auf einer Kiste mit 1 GB ist das die Zahl, an der sie kippt.
`/health` gibt sie als `streams` aus.


## Menge und Preis — warum das mehr Arbeit war als es aussieht

Lange verkaufte ein Tipp **alles** und bot **alles zum Höchstpreis** an. Das war
kein Design, sondern eine Abkürzung: Die Sim konnte Mengen und Preise von Anfang
an, nur die Oberfläche fragte nicht danach.

Jetzt gibt es Zahlenwähler — beim Händler nur die Menge (der Preis steht fest),
am Markt Menge **und** Preis. Drei Dinge daran sind nicht offensichtlich:

**1. Die Auswahl darf nicht im Zeichnen leben.** `render()` läuft jede Sekunde.
Läge die gewählte Menge im DOM, spränge sie jede Sekunde auf den Vorschlag
zurück. Sie liegt deshalb in `picks`, außerhalb — das Zeichnen liest sie nur.

**2. Während jemand tippt, wird nicht neu gezeichnet.** Ein Neuaufbau nähme dem
Zahlenfeld den Fokus, und man käme über die erste Ziffer nicht hinaus. Solange
ein `<input>` im Lagerbereich den Fokus hat, bleibt der Bereich stehen; beim
Verlassen des Feldes zieht die Anzeige nach.

**3. Jeder Knopf rechnet mit dem JETZIGEN Wert, nicht mit dem von eben.** Klingt
nach Kleinigkeit, ist der Unterschied zwischen „drei Tipps auf Plus erhöhen um
drei" und „um eins": Jede Änderung zeichnet neu, und ein Tipp, der noch auf dem
alten Knopf landet, würde sonst denselben Schritt wiederholen. Dasselbe gilt für
den Aktionsknopf — er liest Menge und Preis frisch aus `picks`, sonst verkaufte
er die Zahl, die beim letzten Zeichnen dastand.

Die Grenzen kommen aus dem Anzeigemodell, nicht aus der Seite: `amount` als
Obergrenze, `bandMin`/`bandMax` fürs Preisband. Was der Wähler zulässt, muss die
Sim annehmen — deshalb rechnet `priceBand()` beide Grenzen an genau einer Stelle
für Sim und Oberfläche.

Dabei fiel eine Unstimmigkeit auf: Bei billiger Ware rundete das Prozentband
nach unten auf **0** ab (3 × 25 % = 0,75 → 0). Verkaufen konnte man zu 0 nie —
die Sim lehnt jeden Preis ≤ 0 ohnehin ab. Aber der Preiswähler hätte 0 angeboten
und die Sim hätte mit „Ungültige Menge" geantwortet: ein Wert, den die
Oberfläche erlaubt und die Regel verbietet, plus eine Fehlermeldung über die
falsche Sache. `priceBand()` zieht deshalb eine Untergrenze von 1 — was der
Wähler zulässt, muss die Sim annehmen.

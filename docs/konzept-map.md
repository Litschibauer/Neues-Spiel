# Konzept-Map

> Gemeinsames Arbeitsdokument. Ideen kommen rein, werden verdichtet und markiert.

## Wie hier markiert wird

| Marke | Bedeutung | Prüffrage |
| --- | --- | --- |
| 🟢 | offline-fähig | Braucht weder anderen Spieler noch Zufall |
| 🔴 | online-only | Braucht geteilten knappen Zustand |
| 🟡 | offline mit Aufschub | Braucht Zufall → Ergebnis erst beim Sync (§5) |

**Verbindlich (Architektur §6):** Alles, was offline gehen kann, geht offline.
**D** = reine Daten · **M** = neue Mechanik (Regel + Referenzimplementierung + Golden Vectors)

---

## Die Verdichtung

Rund hundert Ideen aus der Sammlung — und darunter liegen **neun Mechaniken**. Der Rest
sind Tabellenzeilen.

### M1 · Produktionsplatz mit Rezept und Wartezeit 🟢 ✅ gebaut

**Das ist die große Erkenntnis: Feld, Tier und Maschine sind dieselbe Mechanik.**

```
Eingaben verbrauchen  →  Zeit vergeht  →  Ausgabe liegt bereit  →  abholen
```

| Was in der Liste stand | Ist in Wahrheit |
| --- | --- |
| Pflanzen säen und ernten | Platz, dessen Eingabe seine eigene Ausgabe ist |
| Obstbäume, Sträucher, Nachwachsen | Platz, der sich selbst neu bestellt |
| Mehrstufige Pflanzen | ein Timer, mehrere Anzeigestufen |
| Kuh → Milch, Huhn → Ei, Biene → Honig | Platz mit Futter als Eingabe |
| Mühle, Bäckerei, Molkerei, Grill, Weberei … | Platz mit mehreren Eingaben |
| Produktionsketten (Weizen → Mehl → Brot) | mehrere Plätze hintereinander — **entsteht von allein** |

Zehn Feldfrüchte, sechs Tierarten und zwölf Maschinen sind damit **28 Tabellenzeilen**,
nicht 28 Mechaniken. Und die Ketten muss niemand bauen: Sie entstehen, sobald die Ausgabe
des einen die Eingabe des anderen ist.

Parameter statt neuer Mechaniken: Warteschlangenplätze, Kapazität, Geschwindigkeit.

**Saatgut ist endlich, und es ist kein eigener Gegenstand.** Gesät wird die
Frucht selbst: Ein Feld frisst einen Weizen und gibt zwei zurück — der Gewinn
ist der eine, nicht die zwei. Ein zweiter Katalogeintrag „Weizensamen" wäre
doppelte Buchführung für dieselbe Sache. Das klingt nach einer Kleinigkeit und ist
die Stelle, an der die Wirtschaft überhaupt erst eine wird: Vorher entstand
Weizen aus dem Nichts, und jede Zahl weiter oben in der Kette hing an einer
Quelle ohne Boden.

Drei Dinge hängen zwingend daran, und alle drei stehen in `rules.ts`, nicht im
Code:

| Regel | Warum sie nicht optional ist |
| --- | --- |
| `startingItems` | Ohne ein einziges Korn beginnt ein frischer Hof in der Sackgasse, die §6 verbietet |
| `npcBuyPrice` | Wer seinen letzten Weizen verkauft, muss nachkaufen können — sonst ist der Hof endgültig tot |
| `npcBuyPrice > npcPrice` | Sonst wäre der Händler eine Geldpresse. `validateRuleset` erzwingt es, damit es kein Balancing-Versehen werden kann |

Die Gegenprobe steht als Test da (`rules.test.ts`): Für jedes ausgelieferte
Regelwerk muss jede verbrauchte Zutat eines Startplatzes nachkaufbar sein **und**
der Ertrag den Einkauf überzahlen. Ein Katalog, der das verletzt, kommt gar
nicht erst durch.

### M2 · Lagerlimit über alle Waren 🟢 ✅ gebaut
Scheune, Silo, Stapel, Engpässe zwischen Rohstoff und Produkt — alles dieselbe Grenze (§7).

### M3 · Zeit als Kostenfaktor 🟢 ✅ gebaut
Servergemessen, damit fälschungssicher (§4).

### M4 · Verkauf zu Festpreis 🟢 ✅ gebaut
Münzen, NPC-Preise, Produktionskosten, Verkaufspreise — eine Regel, viele Zahlen.

### M5 · Verkaufsauftrag mit Escrow 🟢 einstellen / 🔴 kaufen ✅ gebaut
Preisband, Einstellgebühr, Postfach — und seit dem Orderbuch auch die andere Seite:
**zwei Höfe handeln wirklich miteinander.**

Die Grenze zwischen offline und online läuft hier mitten durch eine Mechanik
hindurch, und sie liegt nicht dort, wo man sie zuerst vermutet:

| | geht offline | warum |
| --- | --- | --- |
| **Einstellen** | ✅ | Einseitig. Der Spieler committet Ware, die er nachweislich hat; sie verlässt sofort sein Lager. |
| **Zurückziehen** | ✅ | Ebenfalls einseitig — solange niemand gekauft hat. |
| **Kaufen** | ❌ | Zwei Leute können dieselbe Kiste wollen. Wer sie bekommt, entscheidet sich nicht auf einem Gerät. |

Drei Entscheidungen, die dabei nicht offensichtlich waren:

1. **Die Auslage liegt im Zustand, nicht im Kaufbefehl.** Ein Preis, den der
   Client mitschickt, ist ein Preis, den der Client wählt. Also legt der Server
   eine Handvoll fremder Angebote in den Snapshot (`state.offers`), und der
   Sim-Kern rechnet den Kauf ganz normal nach. Was er nicht wissen kann, ist, ob
   das Angebot noch da ist — das entscheidet der Markt beim Sync.
2. **Ein verlorenes Rennen ist kein Regelverstoß.** Der Server schneidet den
   Batch an dieser Stelle ab (`OFFER_GONE`); alles davor bleibt bestehen.
   Dieselbe Präfix-Mechanik wie überall — nur diesmal für Pech statt für Cheats.
3. **Der Kauf gewinnt gegen ein späteres Zurückziehen.** Der unangenehmste Fall:
   Der Verkäufer zieht im Funkloch zurück, während längst jemand gekauft hat. Nur
   eine Seite kann gewinnen, und es muss die sein, auf der jemand bezahlt hat.
   Deshalb wirkt ein Verkauf **sofort** auf den Snapshot des Verkäufers; sein
   `CANCEL_ORDER` läuft danach ins Leere.

Der Erlös kommt durchs Postfach, wie jedes Ereignis, von dem der Spieler nichts
wissen konnte (§7). Und weil ein Verkauf den Zustand ändert, ohne dass der
Spieler etwas getan hat, schweigt der Kanarienvogel in genau diesem Sync — sonst
meldete er einen Determinismus-Bug, den es nicht gibt.

### Was mit Ware passiert, die niemand kauft

Die Frage, an der sich entscheidet, ob eine Spielwirtschaft ehrlich ist:
**Nichts wird vernichtet.**

Ware in der Auslage **bleibt stehen**, bis jemand sie kauft oder der Verkäufer
sie zurückholt (`orderTtlTicks: 0` — Frist aus). Es gab einmal eine Frist, nach
der alles ins Postfach zurückfiel; sie ist weg, weil sie das falsche Problem
löste. Der Spieler, der drei Tage nicht spielt, verlor damit seine
Verkaufschance, ohne die Ware früher wiederzubekommen.

| Fall | Was passiert |
| --- | --- |
| Niemand kauft | Der Auftrag steht weiter — unbegrenzt |
| Zurückgezogen | Ware geht ins Lager, wenn Platz ist; sonst bleibt der Auftrag stehen |
| Verkauft | Erlös ins **Postfach** des Verkäufers, Ware zum Käufer |
| Abgeholt bei vollem Lager | Was passt, kommt ins Lager; der Rest bleibt liegen |

**Und was hindert einen daran, die Auslage als Zweitlager zu benutzen?** Zwei
Dinge, und das erste allein reichte nicht:

1. **Die Slots.** `orderSlots` begrenzt, wie viele Aufträge gleichzeitig
   offenstehen. Ein harter Riegel, aber ein grober — mit ein paar Slots lässt
   sich trotzdem dauerhaft Ware parken.
2. **Die Einstellgebühr** (`listingFeePct`, aktuell 5 %). Sie fällt **beim
   Einstellen** an, sofort, aufgerundet und unabhängig davon, ob je jemand
   kauft. Damit kostet schon das Hinlegen etwas, und Parken ist kein Gratis-Trick
   mehr, sondern eine Rechnung.

Bemessen wird sie am **NPC-Wert**, nicht am Wunschpreis. Sonst wäre sie eine
Strafe aufs Hochpreisen, und alle böten am unteren Bandrand an. Gerechnet wird
sie in `listingFee()` — einmal, für Sim und Oberfläche gemeinsam: Der angezeigte
Preis und der bezahlte müssen dieselbe Zahl sein, sonst glaubt ein Spieler dem
Spiel nichts mehr.

Nebenwirkung, die man kennen muss: Ein Hof mit **null Gold kann nichts
einstellen.** Das ist keine Sackgasse — der NPC-Händler kauft immer, und drei
Münzen für ein Korn reichen für die erste Gebühr. Aber der Markt ist damit
nicht mehr der allererste Schritt eines neuen Spielers, sondern der zweite.

### M6 · Auftrag erfüllen 🟢 ✅ gebaut
„Liefere N×A und M×B, bekomme Münzen." LKW, Kunden, Boote, Sonderaufträge,
Eventaufgaben — **eine** Mechanik, der Rest sind Auftragsvorlagen als Daten.

Und sie ist der erste Ort, an dem **Zufall und Offline zusammenkommen**: Der Server
würfelt die Aufträge im Voraus und gibt einen Stapel mit dem Snapshot mit. Der
Client verbraucht ihn, ohne je selbst zu würfeln — Falle 3 unten, in Code gegossen.

### M7 · Ausbauen und Freischalten 🟢 ✅ gebaut
„Zahle Kosten, ändere dauerhaft einen Parameter." Steht als `BUY` samt Ausbaustufen
je Platz. Trägt heute schon „Gehege kaufen" und „Hühner kaufen" — zwei Dinge, die
sich im Spiel völlig verschieden anfühlen und dieselbe Regel sind. Deckt später ab:
Felder erweitern, Ställe ausbauen, Lager vergrößern, Slots und Geschwindigkeit
upgraden, Gebäude bauen.

### M8 · Level und Freischaltungen 🟢 ✅ gebaut
Erfahrung sammeln, Schwelle überschreiten, Tabelle sagt was neu ist. Der
Technologie-/Forschungsbaum ist dieselbe Mechanik mit Vorbedingungen statt Levelzahl.

**Die kleinste Mechanik im Projekt — und die einzige ohne eigenes Command.**
Erfahrung fällt beim Abholen und Liefern nebenbei an; das Level wird daraus
abgeleitet (nicht gespeichert, sonst laufen zwei Zahlen auseinander); und seine
ganze Wirkung ist eine Zahl neben dem Preis eines Platzes.

Ein Haken, der nicht offensichtlich war: Weil das Level *abgeleitet* ist, würde
eine Levelkurve, die in einem Patch **steigt**, Spieler zurückstufen — und ihnen
Plätze wieder zusperren, die sie längst gekauft haben. Deshalb dürfen Schwellen
über Versionen hinweg nur sinken. `levels.test.ts` erzwingt das.

### M9 · Aufgeschobener Zufall 🟡 **M**
Eine Regel für alle Würfel (§5) — siehe die Zufalls-Regel unten.

---

## Was NICHT in die Sim gehört

**Dekoration, Wege, Zäune, Teiche, optische Upgrades, saisonale Deko.**

Solange das keinerlei Spielwirkung hat, gehört es **nicht in den deterministischen
Zustand**. Der Server speichert es als undurchsichtigen Datenblock, der Client zeichnet es.
Kein Determinismus-Risiko, keine Golden Vectors, keine Migration.

⚠️ Sobald Deko einen Bonus gibt, wandert sie in die Sim und kostet den vollen Preis. Das
ist eine bewusste Entscheidung wert, keine beiläufige.

---

## Vier Fallen in der Liste

### 1. Zeit darf offline nie Fortschritt zerstören 🚨

„Tiere brauchen Futter" und „Bäume müssen nachwachsen" sind harmlos — solange Abwesenheit
nichts *kaputt* macht. Würden Tiere verhungern oder Ernten verfaulen, wäre Offline-Spielen
bestraft, und das Versprechen wäre eine Falle statt eines Features.

> **Regel: Zeit pausiert Fortschritt, sie vernichtet ihn nie.**
> Ein ungefüttertes Tier produziert nicht weiter. Es stirbt nicht.

(Hay Day macht das genau so — und das ist kein Zufall.)

### 2. Wetter kann den Kern vergiften 🚨

Von allen 🟡 ist **Wetter** das einzige, das gefährlich ist: Wenn Regen das Wachstum
beeinflusst und Regen zufällig ist, kann der Client offline nicht mehr ausrechnen, wann ein
Feld reif ist. Damit wäre der **Kernkreislauf** nicht mehr offline-fähig — der teuerste
Fehler, den diese Liste hergibt.

Zwei saubere Auswege:

- **Wetter im Voraus geplant.** Der Server schickt den Wetterplan der nächsten Tage mit dem
  Snapshot. Für den Client ist er dann schlicht bekannt → 🟢, voll deterministisch.
- **Wetter nur additiv.** Es gibt Boni, verändert aber nie die Grunddauer → der Kern bleibt
  berechenbar.

Was nicht geht: Wetter, das während der Offline-Phase entsteht und rückwirkend die
Wachstumszeit ändert.

### 3. Zufall vorwürfeln statt nachwürfeln

Nicht jeder Würfel muss auf den Sync warten. Entscheidend ist eine Frage:

> **Wäre es ein Vorteil, das Ergebnis vorher zu kennen?**

| | Verfahren | Ergebnis |
| --- | --- | --- |
| **Nein** — der Spieler wählt nicht | Server würfelt **vorher** und schickt es versiegelt mit | effektiv 🟢 |
| **Ja** — der Spieler wählt | Server würfelt **beim Sync** | 🟡 |

Damit werden aus deinen 🟡 die meisten grün: *zufällige Kunden*, *Sonderaufträge*,
*Eventaufgaben*, *besondere Ernte*, *zufällige Händler* — das sind Inhalte, die einem
zugeteilt werden. Der Server kann einen Vorrat mitgeben, und offline gehen die Aufträge nie
aus.

**Steht inzwischen als Code** (M6): Zwanzig Aufträge liegen im Snapshot, drei davon
sind annehmbar, der Rest rückt nach. Nachgefüllt wird beim Sync — hinten, damit ein
Sync dem Spieler nicht die Auswahl unter den Fingern wegzieht.

Ehrlich zur Grenze: Ein endlicher Vorrat *kann* leerlaufen, und im ersten Lauf tat er
das nach zwölf Lieferungen (daher jetzt zwanzig). Das ist keine Sackgasse — der
NPC-Verkauf bleibt offen. Wer den Vorrat aufbraucht, verliert den Bonus, nicht das Spiel.

Echt 🟡 bleiben nur: **Mystery-Kisten** und alles, wo man aus mehreren wählt. Da wäre
Vorwissen ein Cheat (R5).

### 4. Geschenke sind halb grün

Senden ist einseitig, braucht also niemanden: offline in die Warteschlange, Zustellung beim
Sync. Empfangen landet im Postfach (§7). Nur das *Sehen*, wer online ist, braucht Netz.

---

## Der soziale Rand — dein Aufbau stimmt

Deine 🔴-Liste ist vollständig **am Rand**: Farmen besuchen, Freunde, Nachbarschaften,
gemeinsamer Markt, Ranglisten, Community-Events. **Nichts davon liegt im Kernkreislauf.**

Das ist genau die Struktur, die die Regel aus §6 verlangt: Wer nie online geht, verliert
Extras — nie den täglichen Fortschritt. Die Gefahrenstelle wäre, den Fortschritt später an
Nachbarschafts-Aufgaben zu koppeln. Nicht tun.

---

## Mechanik-Zähler

| | |
| --- | --- |
| **Gebaut** | M1, M2, M3, M4, M5 (beide Seiten), M6, M7, M8 |
| **Fehlt** | M9 Zufall (nur noch der Fall, wo Vorwissen ein Cheat wäre) — plus Warteschlangenplätze als Parameter von M1 |
| **Gesamt** | **9 Mechaniken** |

Neun ist ein Projekt, das man bauen kann. Hundert Features wären es nicht — und die
hundert Features bekommt man trotzdem, weil sie aus diesen neun als Daten herausfallen.

### Was davon heute spielbar ist

```
Feld → Weizen → Mühle → Hühnerfutter → Gehege → Eier
                          ↓
                  Kundenauftrag → Gold + Erfahrung
                          ↓
                  Stufe erreicht → neuer Platz kaufbar

                  Markt: einstellen ← → kaufen (mit Netz)
```

Bewusst genau so viel. Der Kreislauf schließt sich, hat mit den Kundenaufträgen
ein Ziel, mit den Stufen eine Richtung, läuft vollständig offline und ist über
echtes HTTP geprüft.

Gemessen am Dev-Server: Stufe 2 nach zwei Erntezyklen (Mühle geht auf), Stufe 3
nach vieren (Gehege geht auf). In Produktionszeiten sind das rund vier und acht
Minuten — die ersten Freischaltungen kommen also im ersten Sitzen.

---

## Produktversprechen

Drei Sätze, die ab jetzt Entscheidungen gewinnen. Alle drei sind in der Architektur
verankert, damit sie nicht nur Stimmung bleiben.

### 1. Offline lebendig, nicht tot 🚨 → Architektur §6

Nicht „offline ist erlaubt", sondern **offline ist bespielbar**. Der Feldtest zeigte den
Fehlerfall in einer Minute: alles bepflanzt, Inventar leer — jeder Tap korrekt abgelehnt,
nichts zu tun. Nicht kaputt, nur leer.

Dagegen wirken drei Dinge, die alle schon in dieser Map angelegt sind:

| Mittel | Woher es kommt |
| --- | --- |
| **Vorrat statt Verbindung** — Aufträge und Kunden werden vorgewürfelt mitgeliefert und gehen offline nie aus | Falle 3, „Zufall vorwürfeln" |
| **Kein Sackgassen-Zustand** — NPC-Verkauf ist das Ventil, das immer offen ist | M4 ✅ gebaut |
| **Kurze Timer neben langen** — eine Produktionsstufe im Sekundenbereich, sonst ist offline ein Wartezimmer | M1, Parameterfrage |

> **Leerlauf-Test:** Netz aus, beliebiger Spielstand. Gibt es in 60 Sekunden etwas Sinnvolles
> zu tun? Wenn nein, fehlt Inhalt oder ein Ventil.

### 2. Schnell, einfach, modern, clean

Der interessante Teil: „schnell" ist hier keine Optimierungsaufgabe, sondern fällt aus der
Architektur heraus. Weil der Client die Sim selbst rechnet, ist **jeder** Tap sofort
wirksam — es gibt keine Aktion, die auf eine Antwort wartet. Die Konkurrenz kann das nicht,
weil sie für jede Aktion zum Server muss.

> **Kein Ladebalken zwischen Tap und Wirkung. Nie.** Ein Spinner in der Oberfläche heißt,
> dass jemand am Sim-Kern vorbeigebaut hat.

Was dafür noch fehlt: **Die App muss ohne Netz *starten*.** Heute wird die Feldtest-Seite
über das Netz geladen — ein Neuladen im Funkloch scheitert. Eine installierte App bringt
das mit (Roadmap Phase 5); das ist die letzte Lücke im Versprechen.

„Clean" heißt auch, was *nicht* da ist: kein Popup-Spießrutenlauf beim Start, keine
Werbeunterbrechung, kein Ressourcen-Nagging. Genau der Unterschied zu den Alten.

Und „einfach" meint die Oberfläche, nicht die Simulation: Neun Mechaniken tragen beliebig
viel Inhalt — Tiefe kommt aus Tabellen, nicht aus Bedienkomplexität.

### 3. Erstmal ganz ohne Monetarisierung → Architektur §12

**Wir bauen ohne Shop, ohne Premium-Währung, ohne Kaufpfad — auch ohne vorbereiteten.**

Das ist keine Verschiebung auf später, sondern eine Balancing-Entscheidung mit sofortiger
Wirkung:

> **Warten darf nie so wehtun, dass man es wegkaufen wollen würde.**

Im Genre entstehen lange Timer, Lagerengpässe und Energiesysteme nicht aus Spielgefühl,
sondern weil sie freikaufbar sein sollen. Ohne Kaufpfad fällt sofort auf, wenn eine Zahl
nur frustriert, *weil* sie frustrieren soll. Mit Shop fällt es nie auf.

Drei konkrete Verbote für die nächsten Phasen: keine zweite Währung im Zustand (ändert die
kanonische Form für ein Feature, das es nicht gibt), keine Boost-Hooks auf Vorrat (die
Ruleset-Maschinerie steht ohnehin), keine Timer, die sich nur mit „kann man später
abkürzen" rechtfertigen lassen.

**Falls es irgendwann doch kommt, dann so** — festgehalten, damit wir uns den Weg nicht
versehentlich verbauen: *Echtgeld kauft nie einen Vorteil für einen selbst. Wenn Vorteil,
dann für alle.*

| Was man dann verkaufen könnte | Technische Kosten |
| --- | --- |
| **Kosmetik** (Deko, Skins, Saison-Optik) | **null** — liegt ohnehin außerhalb der Sim |
| **Globaler Boost** („alle Farmen 24 h schneller") | ein Ruleset-Wechsel — die R2-Maschinerie steht |
| **Persönlicher Zeitraffer** | fällt weg |

Die gute Nachricht daran: **Beide erlaubten Wege brauchen heute keine Vorarbeit.** Kosmetik
liegt außerhalb der Sim, globale Boosts sind Regelversionen — beides existiert schon oder
kostet nichts. Es gibt also nichts zu „bauen für später".

Drei Dinge, die dabei zusammenpassen und einer, der wehtut:

- Der Kosmetik-Shop ist genau die Fläche, die wir sowieso aus dem deterministischen Zustand
  heraushalten — die Einnahmequelle mit **null** Determinismus-Risiko.
- Ein globaler Boost ist technisch dasselbe wie ein Balance-Patch, und den haben wir schon
  live durch ein Offline-Fenster migriert. Aber: **wirkt ab dem Sync, nie rückwirkend** —
  sonst ist es per Definition Divergenz. Sauberer als ein Zeitfenster ist deshalb ein
  **Boost-Guthaben**, das beim Sync gutgeschrieben und offline verbraucht wird (neue
  Mechanik, kein Freebie).
- Der Zeitraffer passte ohnehin nicht: Ein Kauf braucht den Server, also wäre er
  ausgerechnet im Funkloch nicht verfügbar — dort, wo Wartezeit am meisten stört.
- **Der Preis:** Zeitraffer sind der größte Umsatzhebel des Genres. Ihn zu streichen ist
  eine Wette auf Reichweite statt auf Wale. Bewusst getroffen, nicht übersehen.

---

## Noch offen

1. **Setting.** Klassischer Bauernhof, oder etwas, wo „ohne Netz" thematisch mitspielt?
2. **Der Haken.** Was macht *dieses* Farmspiel anders als die zwanzig anderen — außer der
   Offline-Fähigkeit? (Kandidat aus dem Obigen: die *Geschwindigkeit*. Ein Farmgame ohne
   einen einzigen Ladebalken ist spürbar, bevor jemand das Wort „offline" gehört hat.)
3. ~~**Monetarisierung.**~~ **Entschieden:** erstmal gar keine. Falls später, dann kein
   Pay2Win und Vorteile nur global — siehe oben.

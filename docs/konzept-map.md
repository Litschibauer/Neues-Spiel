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

### M1 · Produktionsplatz mit Rezept und Wartezeit 🟢

**Das ist die große Erkenntnis: Feld, Tier und Maschine sind dieselbe Mechanik.**

```
Eingaben verbrauchen  →  Zeit vergeht  →  Ausgabe liegt bereit  →  abholen
```

| Was in der Liste stand | Ist in Wahrheit |
| --- | --- |
| Pflanzen säen und ernten | Platz ohne Eingabe, eine Ausgabe |
| Obstbäume, Sträucher, Nachwachsen | Platz, der sich selbst neu bestellt |
| Mehrstufige Pflanzen | ein Timer, mehrere Anzeigestufen |
| Kuh → Milch, Huhn → Ei, Biene → Honig | Platz mit Futter als Eingabe |
| Mühle, Bäckerei, Molkerei, Grill, Weberei … | Platz mit mehreren Eingaben |
| Produktionsketten (Weizen → Mehl → Brot) | mehrere Plätze hintereinander — **entsteht von allein** |

Zehn Feldfrüchte, sechs Tierarten und zwölf Maschinen sind damit **28 Tabellenzeilen**,
nicht 28 Mechaniken. Und die Ketten muss niemand bauen: Sie entstehen, sobald die Ausgabe
des einen die Eingabe des anderen ist.

Parameter statt neuer Mechaniken: Warteschlangenplätze, Kapazität, Geschwindigkeit.

### M2 · Lagerlimit über alle Waren 🟢 ✅ gebaut
Scheune, Silo, Stapel, Engpässe zwischen Rohstoff und Produkt — alles dieselbe Grenze (§7).

### M3 · Zeit als Kostenfaktor 🟢 ✅ gebaut
Servergemessen, damit fälschungssicher (§4).

### M4 · Verkauf zu Festpreis 🟢 ✅ gebaut
Münzen, NPC-Preise, Produktionskosten, Verkaufspreise — eine Regel, viele Zahlen.

### M5 · Verkaufsauftrag mit Escrow 🟢 einstellen / 🔴 füllen ✅ gebaut
Steht bereits inklusive Preisband, Ablauffrist und Postfach (§8).

### M6 · Auftrag erfüllen 🟢 **M**
„Liefere N×A und M×B, bekomme Münzen und Erfahrung." LKW, Kunden, Boote, Sonderaufträge,
Eventaufgaben — **eine** Mechanik, der Rest sind Auftragsvorlagen als Daten.

### M7 · Ausbauen und Freischalten 🟢 **M**
„Zahle Kosten, ändere dauerhaft einen Parameter." Deckt ab: Felder erweitern, Ställe
ausbauen, Lager vergrößern, Slots und Geschwindigkeit upgraden, Farmfläche erweitern,
Gebäude bauen, Erträge verbessern.

### M8 · Level und Freischaltungen 🟢 **M**
Erfahrung sammeln, Schwelle überschreiten, Tabelle sagt was neu ist. Der
Technologie-/Forschungsbaum ist dieselbe Mechanik mit Vorbedingungen statt Levelzahl.

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
| **Gebaut** | M1 (teilweise), M2, M3, M4, M5 |
| **Fehlt** | M1 vollständig (Rezepte, Warteschlangen), M6 Aufträge, M7 Ausbau, M8 Level, M9 Zufall |
| **Gesamt** | **9 Mechaniken** |

Neun ist ein Projekt, das man bauen kann. Hundert Features wären es nicht — und die
hundert Features bekommt man trotzdem, weil sie aus diesen neun als Daten herausfallen.

---

## Noch offen

1. **Setting.** Klassischer Bauernhof, oder etwas, wo „ohne Netz" thematisch mitspielt?
2. **Der Haken.** Was macht *dieses* Farmspiel anders als die zwanzig anderen — außer der
   Offline-Fähigkeit?
3. **Monetarisierung.** Beeinflusst das Design mehr, als einem lieb ist: Wartezeit-Abkürzer
   sind der Standard und stehen in direkter Spannung zum Offline-Versprechen.

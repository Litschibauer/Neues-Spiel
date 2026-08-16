# Konzept-Map

> Gemeinsames Arbeitsdokument. Ideen kommen rein, werden einsortiert und markiert.
> Kein fertiges Design — ein Ort, an dem sich eins herausbildet.

## Wie hier markiert wird

Jede Idee bekommt eine Marke. Die Zuordnung ist keine Meinung, sondern folgt aus §8:

| Marke | Bedeutung | Prüffrage |
| --- | --- | --- |
| 🟢 | offline-fähig | Braucht weder anderen Spieler noch Zufall |
| 🔴 | online-only | Braucht geteilten knappen Zustand |
| 🟡 | offline mit Aufschub | Braucht Zufall → Ergebnis erst beim Sync (§5) |

**Verbindlich (Architektur §6):** Alles, was offline gehen kann, geht offline. 🔴 ist die
begründungspflichtige Ausnahme, nicht die bequeme Voreinstellung.

Zweite Marke für den Aufwand:

| | |
| --- | --- |
| **D** | reine Daten — eine Tabellenzeile, kein neues Risiko |
| **M** | neue Mechanik — Regel, Referenzimplementierung, Golden Vectors |

Ziel: möglichst viel **D**, möglichst wenig **M**.

---

## 1. Kern — was man alle dreißig Sekunden tut

*Der Kreislauf, der das Spiel ist. Alles andere ist Gerüst darum herum.*

- _(offen)_

## 2. Ketten — was in was fließt

*Produktionsketten. Hier entsteht Tiefe aus wenigen Regeln.*

- _(offen)_

## 3. Druck — was Spannung erzeugt

*Grenzen, Timer, Knappheit. Ohne Druck ist ein Kreislauf nur Beschäftigung.*

- 🟢 **M** Lagerlimit über alle Waren — steht bereits (§7)
- 🟢 **M** Wachstumszeit als Hauptkosten — steht bereits (§4)

## 4. Fortschritt — warum man morgen wieder aufmacht

*Was wächst, was schaltet frei, was verändert sich dauerhaft.*

- _(offen)_

## 5. Zufall — wo überhaupt

*Jeder Würfel kostet offline etwas: Das Ergebnis kommt erst beim nächsten Sync (§5).*

- _(offen)_

## 6. Sozialer Rand — bewusst am Rand

*🔴 per Definition. Muss additiv bleiben: Wer nie online geht, verliert Extras — nie den
Kernkreislauf. Sobald der tägliche Fortschritt daran hängt, ist das Versprechen weg.*

- 🔴 **M** Spielermarkt: einstellen 🟢 offline, füllen 🔴 online (§8) — Escrow steht bereits
- _(offen)_

---

## Offene Entscheidungen

1. **Setting und Fantasie.** Bauernhof? Oder etwas, wo „ohne Netz" thematisch mitspielt?
2. **Der Kernkreislauf.** Was tut man, und was macht es befriedigend?
3. **Der Grund für morgen.** Was zieht zurück — und funktioniert der Grund auch offline?

---

## Mechanik-Zähler

Ehrlich mitzählen, das ist die eigentliche Projektgröße.

**Aktuell umgesetzt (4):** Feldwachstum · gedeckelte Fließproduktion · Lagerlimit ·
Verkaufsaufträge mit Escrow und Postfach

**Geplant:** _(offen)_

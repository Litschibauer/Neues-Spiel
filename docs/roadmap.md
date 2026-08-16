# Vom Prototyp zum Spiel

> Der Mechanismus ist belegt (siehe [prototype.md](prototype.md)). Was jetzt kommt, ist
> eine andere Art Arbeit: nicht mehr „geht das überhaupt", sondern „was genau bauen wir".
> Dieses Dokument ordnet die Schritte — und sagt bei jedem, was er absichert und was er kostet.

---

## Der Hebel, den man verstehen muss

Ein Hay-Day-großes Spiel hat **hunderte Gegenstände**, aber nur etwa **zwanzig Mechaniken**.
Timer, Produktionswarteschlangen, gedeckelte Lager, Währungen, Aufträge, Tiere mit Zyklen.

> **Inhalt skaliert als Daten. Risiko skaliert mit Mechaniken.**

Eine neue Feldfrucht ist eine Zeile in einer Tabelle — null neues Determinismus-Risiko. Eine
neue *Mechanik* ist echtes Risiko: neue Fläche, auf der Client und Server auseinanderlaufen
können, und jedes Mal Fuzz-Tests plus Golden Vectors dazu.

Daraus folgt die Reihenfolge unten: **erst die Mechaniken festlegen und datengetrieben
machen, dann Inhalt schaufeln.** Wer es andersherum macht, baut jede Mechanik doppelt.

---

## Phase 0 — Entscheidungen vor der ersten Zeile Code

Kein Code, aber die teuersten Fehler entstehen hier.

1. **Was ist das Spiel genau?** Hay-Day-Klon oder eigener Dreh? Der Kernkreislauf entscheidet
   über das Command-Set, und das Command-Set ist das Regelwerk.
2. **Was ist das Offline-Versprechen?** „Alles außer Handel" ist etwas anderes als „nur der
   Kernkreislauf". Diese Zusage bestimmt, welche Features überhaupt gebaut werden dürfen —
   nachträglich ein soziales Feature einzuziehen, das offline nicht geht, bricht das
   Versprechen.
3. **Wie viele Mechaniken?** Eine Liste von zwanzig ist ein Projekt. Eine von sechzig ist
   ein anderes. Ehrlich zählen, bevor geplant wird.

Ergebnis: eine Liste der Mechaniken und ein Satz, der das Offline-Versprechen festhält.

---

## Phase 1 — Inhalt als Daten

**Der wichtigste technische Schritt.** Aktuell sind `wheat` und `eggs` fest im Code. Solange
das so ist, ist „Inhalt skaliert als Daten" eine Behauptung, kein Zustand.

Umbau:

- **Gegenstands-Katalog** im Regelwerk statt fester Felder. Zustand hält ein Inventar in
  fester Katalogreihenfolge — deterministisch serialisierbar, ohne Sortierfragen.
- **Rezepte als Daten:** Eingaben, Ausgabe, Dauer.
- **Gebäude als Daten:** welche Rezepte, wie viele Warteschlangenplätze.

Nebeneffekt: Ein wachsender Katalog ist eine **strukturelle** Migration (neuer Gegenstand →
Inventar wächst um einen Eintrag). Bisher ändern die Migrationen nur Zeiten. Das ist der
ehrlichere Test für R2.

Aufwand: spürbar. Es fasst Zustand, kanonische Form, Sim, Migration und alle Tests an, und
die Golden Vectors müssen bewusst neu erzeugt werden.

Sichert ab: dass Inhalt später wirklich billig ist.

---

## Phase 2 — Das echte Command-Set

Die Mechaniken aus Phase 0, jede mit:

- Regel in `simulate()`
- Referenzimplementierung für den Fuzz („offensichtlich korrekt, aber langsam")
- Abdeckung im Golden-Vector-Korpus

Realistischer Kern eines Farmgames: Produktion starten/abholen, bauen, ausbauen,
Auftrags-Systeme (LKW, Boot), Tiere füttern, Bäume ernten, Flächen freischalten.

**Faustregel pro Mechanik:** Wenn du keine langsame, offensichtlich korrekte Variante
danebenschreiben kannst, hast du sie noch nicht verstanden.

---

## Phase 3 — Die geteilte Welt

Bisher nur auf Papier (§5, §8):

- **Orderbuch** für den Spielermarkt. Aufträge *einstellen* geht offline (Escrow steht
  bereits), das *Füllen* ist online-only und braucht einen echten Abgleich zwischen Spielern.
- **Zufall.** Muster 1 aus §5: Ergebnis erst beim Sync serverseitig würfeln. Der Client darf
  nichts wissen, was er nicht wissen soll.
- **Nachbarn, Events, Ranglisten.** Alle online-only — hier entscheidet sich, wie groß der
  Offline-Anteil des Spiels am Ende wirklich ist.

Sichert ab: dass das Offline-Versprechen aus Phase 0 auch mit sozialen Features hält.

---

## Phase 4 — Aus dem Feldtest wird Betrieb

Der jetzige Server ist ein Werkzeug, kein Produkt:

- **Accounts** statt ein Spielstand, ein Token.
- **Datenbank** statt JSON-Datei; Command-Log hinter alten Snapshots abschneiden.
- **TLS** und Rate-Limits pro Konto (R4).
- **Snapshot-Signatur** (§9).
- **Monitoring**, das Divergenz-Alarme sichtbar macht — sie sind das Frühwarnsystem für R1,
  und ohne Auswertung nutzlos.

Kein Forschungsrisiko, aber echte Arbeit.

---

## Phase 5 — Der richtige Client

Erst wenn die Mechaniken stehen, sonst baut man die Oberfläche zweimal.

- **Engine wählen** (Unity, Godot, oder eigener Renderer). Kriterium: Der Sim-Kern muss
  unverändert daneben laufen — nie nachbauen.
- **Sim-Kern portieren.** Der Golden-Vector-Korpus ist die Abnahme: Läuft er durch, rechnet
  die neue Plattform bit-für-bit gleich. Dank der Vektoren ein Nachmittag, kein Projekt.
- **App-Hülle lokal.** „Offline-fähig" heißt auch: Die App startet ohne Netz. Eine
  installierte App bringt das mit; im Browser bräuchte es Service Worker und HTTPS.

---

## Quer durch alle Phasen

**Die Determinismus-Steuer fällt pro Mechanik an, dauerhaft.** Fünf Bugs steckten in einem
winzigen Prototyp — alle hätten *ehrliche* Spieler getroffen. Die Werkzeuge dagegen stehen
und skalieren mit, aber sie wollen bedient werden:

- CI-Wächter läuft von allein.
- Jede neue Mechanik braucht ihre Referenzimplementierung für den Fuzz.
- Der Golden-Korpus wächst mit dem Command-Set — sonst prüft der Plattform-Beweis irgendwann
  nur noch die Hälfte des Spiels.

---

## Was man jetzt NICHT tun sollte

- **Oberfläche vor Mechanik.** Man baut sie zweimal.
- **Skalierung vor Spielern.** Ein Kern schafft ~220.000 Syncs pro Sekunde. Das reicht
  erstmal.
- **Features, die offline nicht gehen, ohne bewusste Entscheidung.** Jedes davon verkleinert
  das Versprechen, mit dem das Spiel antritt.
- **Determinismus für „nur dieses eine Feature" aufweichen.** Es gibt kein bisschen
  deterministisch.

---

## Wenn nur eine Sache als Nächstes passiert

**Phase 1.** Ohne datengetriebenen Inhalt kostet jeder neue Gegenstand Code, und die ganze
Rechnung aus dem Hebel oben geht nicht auf. Alles andere baut darauf auf.

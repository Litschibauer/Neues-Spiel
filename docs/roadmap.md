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
   über das Command-Set, und das Command-Set ist das Regelwerk. Offen bleiben nur noch
   Setting und der Haken — beides blockiert den Bau nicht.
2. ~~**Was ist das Offline-Versprechen?**~~ **Entschieden:** Alles, was offline gehen kann,
   geht offline. Soziale Features sind online-only und werden ausgegraut — bei geteiltem
   knappem Zustand ist das Physik, kein Aufwand (§8).

   Die Voreinstellung dreht sich damit um: Jedes Feature ist offline-fähig, bis bewiesen
   ist, dass es das nicht sein kann. Festgehalten in Architektur §6.
3. ~~**Wie viele Mechaniken?**~~ **Gezählt: neun.** Rund hundert Ideen verdichtet zu neun
   Mechaniken, alles andere sind Tabellenzeilen — siehe
   [konzept-map.md](konzept-map.md). Fünf davon stehen bereits.
4. ~~**Monetarisierung?**~~ **Entschieden: erstmal keine.** Kein Shop, keine Premium-Währung,
   kein vorbereiteter Kaufpfad. Wirkt trotzdem sofort — als Balancing-Leitplanke: *Warten
   darf nie so wehtun, dass man es wegkaufen wollen würde.* Falls später doch, dann kein
   Pay2Win (Architektur §12); beide erlaubten Wege brauchen heute keine Vorarbeit.
5. ~~**Reicht „offline erlaubt"?**~~ **Nein — entschieden:** Es darf keinen Zustand geben, in
   dem offline nichts zu tun ist. Der Leerlauf-Test gehört in jeden Feldtest (Architektur §6).

Ergebnis: eine Liste der Mechaniken und ein Satz, der das Offline-Versprechen festhält.

---

## Phase 1 — Inhalt als Daten ✅ erledigt

**Der wichtigste technische Schritt war das hier.** Vorher standen `wheat` und `eggs`
fest im Code — „Inhalt skaliert als Daten" war damit eine Behauptung, kein Zustand.

Umgebaut:

- **Gegenstands-Katalog** im Regelwerk statt fester Felder. Der Zustand hält ein
  Inventar als Zahlenarray in Katalogreihenfolge — deterministisch serialisierbar,
  ohne Sortierfragen. Auch Münzen sind ein Katalogeintrag, nur ohne Lagerpflicht.
- **Rezepte als Daten:** Eingaben, Ausgabe, Dauer.
- **Plätze als Daten:** welche Rezepte, wie viele — die Weltkarte ist eine Tabelle.
- **Ein Commandpaar für alles:** `START` / `COLLECT` statt `PLANT` / `HARVEST`.
  Feld, Werkstatt und Tier sind derselbe Platz mit demselben Timer.

Was das gebracht hat, zeigte sich direkt danach: Beim Bau des Basis-Kreislaufs
kosteten **Mühle und Gehege null Zeilen Sim-Code**. Eine Werkstatt ist ein Platz
mit Eingaben, ein Tier ist ein Platz mit Futter als Eingabe; die Kette entsteht
daraus, dass die Ausgabe des einen die Eingabe des anderen ist.

Zwei Dinge waren dabei teurer als geplant:

- **Mehrere passive Produzenten teilen sich einen Lagerdeckel.** Wer den letzten
  Platz bekommt, entscheidet die Zeitachse, nicht die Reihenfolge in der Liste. Die
  geschlossene Form dafür braucht eine Binärsuche auf den Zeitpunkt des Volllaufens
  — und traf dabei denselben Off-by-one wie beim ersten Mal.
- **Der Sync wurde langsamer**, von ~4 µs auf ~6 µs (Katalogschleifen statt zweier
  Additionen). Gemessen, nicht geschätzt — siehe prototype.md.

Der Preis, den man dauerhaft zahlt: **Kataloge sind append-only.** Zustände speichern
Indizes. `test/rules.test.ts` erzwingt das über alle Versionen hinweg.

> **Die eine Freiheit, die es nur einmal gab:** Solange kein echter Spielstand
> existiert, darf man den Katalog noch umbauen. Genau das ist beim Zuschnitt auf
> den Basis-Kreislauf passiert — die Prototyp-Inhalte sind ersatzlos gewichen.
> Ab dem ersten echten Spieler bindet die Append-only-Regel für immer.

---

## Phase 2 — Das echte Command-Set

Die Mechaniken aus Phase 0, jede mit:

- Regel in `simulate()`
- Referenzimplementierung für den Fuzz („offensichtlich korrekt, aber langsam")
- Abdeckung im Golden-Vector-Korpus

**Der Basis-Kreislauf steht** — und er brauchte weniger, als die Liste vermuten ließ:

```
Feld → Weizen → Mühle → Hühnerfutter → Gehege → Eier → Gold → mehr Plätze
```

Dafür kamen genau **zwei** Mechaniken zusammen. `START`/`COLLECT` trägt Feld,
Werkstatt und Tier gemeinsam (M1); `BUY` trägt „Gehege kaufen", „Hühner kaufen"
und später jede Freischaltung und jedes Upgrade (M7). Tiere füttern brauchte
dabei gar keine eigene Mechanik: Ein Tier ist ein Platz mit Eingaben.

Was noch fehlt:

- **M6 Aufträge erfüllen** — „liefere N×A und M×B". LKW, Kunden, Boote,
  Sonderaufträge und Eventaufgaben fallen daraus als Daten heraus.
- **M8 Level und Freischaltungen** — Erfahrung, Schwelle, Tabelle.
- **M9 Aufgeschobener Zufall** — eine Regel für alle Würfel (§5).

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

- [x] ~~**Dev und Produktion trennen.**~~ Erledigt: zwei Umgebungen, die sich nichts
      teilen (Port, Spielstand, Token, Regelwerk), plus drei Riegel gegen die teuren
      Betriebsfehler — kein Start ohne genannte Umgebung, kein Dev-Regelwerk in
      Produktion, keine Werkbank in Produktion. Siehe `src/server/config.ts`.
      Vorgezogen, weil sich sonst jede weitere Änderung am echten Spielstand testet.

Der Rest des jetzigen Servers ist ein Werkzeug, kein Produkt:

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
- **Skalierung vor Spielern.** Ein Kern schafft Zehntausende Syncs pro Sekunde. Das
  reicht erstmal.
- **Features, die offline nicht gehen, ohne bewusste Entscheidung.** Jedes davon verkleinert
  das Versprechen, mit dem das Spiel antritt.
- **Determinismus für „nur dieses eine Feature" aufweichen.** Es gibt kein bisschen
  deterministisch.

---

## Wenn nur eine Sache als Nächstes passiert

**M6: Aufträge erfüllen.**

Zwei Gründe. Erstens ist es die Mechanik, aus der die meisten Inhalte als Daten
herausfallen: LKW, Kunden, Boote, Sonderaufträge und Eventaufgaben sind alle
„liefere N×A und M×B" mit anderen Zahlen. Zweitens ist sie der Träger für die
Leerlauf-Regel aus Architektur §6 — ein vorgewürfelter Auftragsvorrat ist genau
das, was offline nie ausgeht.

Und sie gibt dem Kreislauf ein Ziel. Im Moment endet er beim NPC-Verkauf: Eier
werden zu Gold, Gold zu Plätzen, Plätze zu mehr Eiern. Das trägt eine Testrunde,
aber keine Woche.

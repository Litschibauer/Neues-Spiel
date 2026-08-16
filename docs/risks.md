# Risiko- & Schwachstellen-Analyse

> Ehrlicher Stresstest des Konzepts aus [architecture.md](architecture.md). Ziel: die Stellen
> finden, an denen die Idee bricht — *bevor* Code entsteht. Kein Schönreden.

## Fazit vorweg

Das Konzept ist **machbar, aber teuer** — und der Preis steckt nicht in der Idee, sondern in
**Ingenieurs-Disziplin**. Konkret: Determinismus über Zeit und Plattformen sauber zu halten,
und die Sim-Version live-service-tauglich zu machen. Genau das ist auch der Grund, warum es so
kaum jemand gebaut hat: nicht weil es unmöglich ist, sondern weil der Disziplin-Aufwand hoch
und unglamourös ist.

Wichtigste Umdeutung: **Determinismus ist nicht nur ein Security-Feature, sondern ein
Spieler-Vertrauens-Feature.** Die Latte liegt nicht bei „Cheater kriegen Rollback", sondern
bei „*ehrliche* Spieler kriegen **niemals** Rollback". Das ist deutlich höher.

---

## Risiko-Register (nach Schärfe sortiert)

### 🔴 R1 — Determinismus-Bugs bestrafen ehrliche Spieler

**Was:** Wenn die lokale Client-Sim jemals vom Server abweicht — durch einen *Bug*, nicht durch
Cheating — bekommt der ehrliche Spieler einen Rollback und verliert legitimen Fortschritt.

**Warum gefährlich:** Ein einziger solcher Vorfall zerstört Vertrauen nachhaltiger als 100
gebannte Cheater es aufbauen. Der Sync ist nur „nahtlos", solange Client und Server *bit-für-
bit* dasselbe rechnen. Jede Lücke trifft die Falschen.

**Schärfe:** Sehr hoch. Das ist das zentrale Risiko des ganzen Ansatzes.

**Status: empirisch bestätigt.** Der Prototyp hat in bewusst sorgfältig geschriebenem Code
**drei Fehler** produziert, die alle *ehrliche* Spieler getroffen hätten: einen Off-by-one in
der gedeckelten Produktion, eine Idempotenz-Prüfung, die einen Multi-Device-Fork als „schon
erledigt" durchwinkte, und eine Sync-Prüfung, die eine verlorene Antwort von einem Fork nicht
unterscheiden konnte. Keiner war beim Lesen sichtbar; zwei fand der Fuzz, einen das
Durchspielen eines realen Szenarios. Details in [prototype.md](prototype.md). R1 ist damit
keine Sorge mehr, sondern eine Beobachtung.

**Gegenmaßnahmen** — fünf Schichten, weil kein einzelner Mechanismus reicht
(Details in Architektur §9, umgesetzt im [Prototyp](prototype.md)):

1. **Ein einziges Sim-Artefakt**, identisch auf Client und Server — nie zwei
   Implementierungen, die auseinanderlaufen können.
2. **Statischer CI-Wächter:** Floats, Systemzeit, Locale, `for…in` und ungeschützte Division
   werden im Sim-Kern maschinell blockiert. Verlässt sich nicht auf Review-Disziplin.
3. **Fuzz gegen eine Grundwahrheit:** Jede Optimierung (z.B. die geschlossene Produktionsformel)
   tritt gegen eine langsame, offensichtlich korrekte Tick-für-Tick-Variante an — auf Funktions-
   *und* auf Sitzungsebene.
4. **Golden Vectors:** festgeschriebener Korpus expliziter Command-Logs mit erwarteten
   Endzuständen, den jede Plattform abspielen muss. **Eingelöst:** V8 (Node, Chromium) und
   JavaScriptCore (WKWebView auf iPadOS) liefern für alle 30 Vektoren identische Endzustände —
   zwei unabhängige Engine-Familien, siehe [prototype.md](prototype.md).
5. **Kanarienvogel + Quarantäne:** Client schickt seinen Zustands-Hash mit. Mismatch ⇒ Alarm,
   nie Sanktion — und bei erhöhter Divergenzrate wird die betroffene Client-Version
   eingeschränkt, statt eine ganze Kohorte kaputte Spielstände sammeln zu lassen.

**Die entscheidende Weiche:** *illegaler Log* → Rollback (Cheat-Pfad). *Legaler Log mit
abweichendem Hash* → **kein** Rollback, der Spieler behält seinen Fortschritt. Der Server hat
den Log gerade selbst als regelkonform bestätigt — ihn dafür zurückzusetzen wäre exakt das
Vertrauensproblem, das dieses Risiko beschreibt.

---

### 🔴 R2 — Sim-Versionierung vs. Live-Service-Updates

**Was:** Live-Service heißt ständige Balance-Patches (Wachstumszeiten, Preise, neue Inhalte).
Aber jede Änderung an der Sim-Logik ändert das deterministische Ergebnis. Ein Spieler, der
offline unter *alten* Regeln gehandelt hat, synct nach einem Patch — welche Regeln nimmt der
Server zum Nachrechnen?

**Warum gefährlich:** Nimmt der Server die *neuen* Regeln, weicht er garantiert vom Client ab
(→ R1, Rollback für Ehrliche). Nimmt er die *alten*, muss er alte Sim-Versionen vorhalten und
wissen, welche der Client benutzt hat.

**Schärfe:** Sehr hoch. Das ist der Punkt, an dem „deterministisch" und „live-service" sich
gegenseitig ins Knie schießen.

**Status: im Prototyp gelöst und getestet.** Es gibt jetzt ein zweites Ruleset (V2) und einen
durchgespielten Balance-Patch: Spieler geht offline → Patch wird geshippt → Sync rechnet den
Log weiterhin unter V1 nach und hebt den Zustand *danach* auf V2. Laufendes Wachstum überlebt
das fair, Invarianten werden nach jedem Schritt geprüft, und eine kaputte Migration
beschädigt keinen Spielstand (der Log wird übernommen, die Version bleibt stehen).
Dabei fiel eine Lücke auf, die im Konzept nicht stand: Der Client konnte sich seine
Regelversion **selbst aussuchen** und sich so dauerhaft günstige alte Preise sichern.
Maßgeblich ist jetzt allein die Version, die der Server auf den Snapshot gestempelt hat.

**Gegenmaßnahmen:**
- **Regeln/Balance als versionierte Daten**, nicht als Code. Jeder Command-Log deklariert seine
  `rulesetVersion`. Der Server validiert den Log unter *genau dieser* Version.
- Der Server hält die **letzten N Ruleset-Versionen** vor (alte Versionen deprecaten).
- **Erzwungenes Update vor Sync**, wenn die Client-Version zu alt ist. Offline-Arbeit unter
  einer nicht mehr unterstützten Version → sauberer, angekündigter Verlust statt stiller
  Divergenz.
- Balance-Patches idealerweise **nur zukunftswirksam** (neue Pflanzung nach Patch nutzt neue
  Zeiten; bereits laufende Pflanzung behält alte). Vermeidet die meisten Konflikte.
- **Migration nur serverseitig**, das Ergebnis kommt fertig im Snapshot. Der Client rechnet nie
  selbst um — damit kann die Migration gar nicht erst zwischen Client und Server divergieren.
- **Ein Schritt pro Versionssprung**, nacheinander. Wer drei Patches verschlafen hat, läuft
  durch dieselben getesteten Schritte wie alle anderen.
- **Leitregel für jede Migration:** nie schlechter als ein Neuanfang unter den neuen Regeln,
  nie besser als das, was der Spieler schon hatte.
- **Invariantenprüfung nach jedem Schritt.** Eine Migration, die einen ungültigen Zustand
  erzeugt, ist schlimmer als gar keine — sie lässt danach Aktionen scheitern, die erlaubt
  sein müssten.

---

### 🟠 R3 — Multi-Device-Fork

**Was:** Multiplattform + gleicher Account. Spieler spielt offline auf dem Handy *und* offline
auf dem Tablet, beide vom selben letzten Snapshot aus. Beim Sync existieren **zwei divergente
Command-Logs** — ein echter Fork.

**Warum gefährlich:** Der Server kann nur einen akzeptieren. Der andere wird verworfen → das
zweite Gerät verliert seine gesamte Offline-Arbeit. Übler UX-Bruch, und er passiert *ehrlichen*
Spielern.

**Schärfe:** Hoch. Bei „mobile-first, aber multiplattform" ein realistisches Alltagsszenario.

**Gegenmaßnahmen:**
- **Aktiv-Gerät-Token:** Nur ein Gerät hält die „Offline-Schreibrechte". Andere Geräte sind
  offline read-only, bis sie das Token übernehmen (mit Warnung).
- Alternativ: **Sync-Zwang beim App-Start**, sodass ein Gerät nie lange von einem veralteten
  Snapshot aus offline weiterläuft.
- Klare UI-Kommunikation *bevor* der Verlust passiert, nie danach.
- **Nicht mit einer verlorenen Antwort verwechseln.** Beide sehen zunächst gleich aus: ein
  Client meldet sich mit Sequenznummern, die der Server schon vergeben hat. Der Unterschied
  liegt im Inhalt — identisches Präfix ⇒ Wiederaufsetzen, abweichendes ⇒ Fork (Architektur §10).

---

### 🟠 R4 — Server-Kosten der Re-Simulation (DoS & Skalierung)

**Was:** Der Server rechnet für *jeden* Spieler bei *jedem* Sync den kompletten Offline-Log
nach. Ein Angreifer kann bewusst riesige Logs hochladen, um teure Server-Rechnung zu erzwingen.
Und selbst ehrlich: bei Millionen Spielern ist Re-Sim ein echter CPU-Kostenblock.

**Warum gefährlich:** Versteckte Betriebskosten und ein DoS-Vektor, den das simple „einfach
nachrechnen" verschleiert.

**Schärfe:** Mittel–hoch (Skalierungs-/Kostenrisiko, kein Korrektheitsrisiko).

**Status: gemessen, entschärft.** `npm run bench` zeigt: Ein Sync kostet ~0,14 µs pro Command
und ist **unabhängig von der Offline-Dauer** — eine Stunde und ein Jahr Abwesenheit kosten
dasselbe. Ein typischer Sync liegt bei ~8 µs, ein Kern schafft ~120.000 davon pro Sekunde.
Die Re-Simulation ist damit nicht der Engpass; Netzwerk und Persistenz dominieren. Die
Obergrenzen unten bleiben trotzdem nötig, weil ein Angreifer die Log-Länge frei wählt.

**Gegenmaßnahmen:**
- **Harte Caps:** max. Log-Länge, max. Sync-Frequenz, Rate-Limiting pro Account.
- **Zeitbudget deckelt implizit:** da `command.tick ≤ T0 + Δreal` gilt, ist die Menge sinnvoller
  Aktionen an die real vergangene Zeit gekoppelt — begrenzt die Log-Größe natürlich.
- Sim billig halten (Integer, keine schweren Strukturen), häufig snapshotten, Validierung
  batchen. Kostenbudget pro Sync-Request.

---

### 🟠 R5 — „Nicht cheatbar" ist zu absolut formuliert

**Was:** Der Ansatz macht *Zustand und Ökonomie* fälschungssicher. Er stoppt aber **nicht**:
- **Bots/Automation:** vollautomatisches, aber *regelkonformes* Spielen. Alle Aktionen sind
  legal — der Server kann Bot nicht von Mensch unterscheiden.
- **Informations-Cheats:** wenn der Client RNG-Seeds kennt (Muster 2 in §5 der Architektur),
  kann er die Zukunft sehen und selektiv handeln.
- **Client-Speicher-Manipulation** für versteckte Infos, die der Client gar nicht halten sollte.

**Warum gefährlich:** Falsche Sicherheit. „Nichts cheatbar" verspricht mehr, als die
Architektur einlöst.

**Schärfe:** Mittel (Erwartungsmanagement + konkrete Design-Konsequenz).

**Gegenmaßnahmen / Präzisierung:**
- Scope ehrlich benennen: **Zustand & Ökonomie sind fälschungssicher; Automation und Social
  Engineering sind separate Kämpfe** (Verhaltenserkennung, Server-Telemetrie).
- **Deferred Resolution (Muster 1) klar bevorzugen** vor Seed-Ableitung (Muster 2): Der Client
  darf nichts wissen, was er nicht wissen soll. Kein ungeöffnetes Loot, keine verdeckten
  Ergebnisse im Client-Speicher.

---

### 🟡 R6 — Ökonomie verstärkt jede Validierungs-Lücke

**Was:** Offline (legal) produzierte Ressourcen fließen beim Sync in den *geteilten* Markt.
Lässt ein Determinismus-Bug oder Edge-Case jemanden überproduzieren, inflationiert das die
Ökonomie **für alle**.

**Warum gefährlich:** Ein lokaler Fehler wird zum globalen Wirtschaftsschaden. Genau die
Dinge, die handelbar sind, brauchen die schärfste Validierung.

**Schärfe:** Mittel (steigt mit der wirtschaftlichen Tiefe des Spiels).

**Gegenmaßnahmen:**
- Alles Handelbare bekommt **strengste, doppelte Validierung** (Server-Re-Sim *und*
  Plausibilitäts-/Ratenobergrenzen: „so viel Weizen kann in X Zeit gar nicht entstehen").
- Ökonomie-Telemetrie mit Anomalie-Erkennung als zweites Netz unter der Sim-Validierung.
- **Alle Behälter deckeln.** Lagerlimits bremsen die Inflation nur, wenn *jeder* Ort begrenzt
  ist, an dem Güter liegen können — Lager, Postfach, Handels-Escrow, ausstehende Belohnungen.
  Ein ungedeckelter Behälter (z.B. Escrow als Dauerparkplatz) hebelt die Bremse komplett aus.
  Siehe Architektur §7 (Invariante) und §8 (Auftrags-Slots, Preisbänder, Ablauffristen).
  **Status: im Prototyp umgesetzt und als Sättigungstest abgesichert** — der Stash-Angriff
  läuft gegen eine feste Obergrenze und wächst auch nach 2000 Runden nicht weiter. Dabei
  zeigte sich, dass die effektive Haltemenge die *Summe* aller Behälter ist (im Prototyp
  fast das Sechsfache des Lagerlimits) und deshalb bewusst gewählt werden muss.

---

### 🟡 R7 — Anti-Cheat vs. Game-Feel bei Belohnungen

**Was:** Deferred Resolution heißt: Spieler öffnet offline eine Kiste und sieht „wird beim
nächsten Online-Sync aufgelöst". Das fühlt sich schlechter an als sofortige Belohnung.

**Warum gefährlich:** Spannung zwischen Sicherheit und Dopamin/Spielgefühl — bei einem
Live-Service-Game ist Feel umsatzrelevant.

**Schärfe:** Niedrig–mittel (Design-Hebel, kein Sicherheitsrisiko).

**Gegenmaßnahmen:**
- **Die meisten Belohnungen deterministisch** gestalten → lösen offline *sofort* auf (kein
  echter Zufall nötig, also kein Deferral).
- Nur *seltene/wertvolle* Zufallsbelohnungen deferren. Das Deferral zur *Vorfreude* inszenieren
  („beim nächsten Online-Besuch wartet eine Überraschung") statt als Wartestrafe.

---

### 🟢 R8 — Atomarer Sync bei Verbindungsabbruch

**Was:** Verbindung bricht mitten im Sync ab — wird der Log teilweise angewandt?

**Warum (nicht) gefährlich:** Grundsätzlich lösbar, aber muss von Anfang an richtig gebaut sein.

**Schärfe:** Niedrig (Standard-Transaktionsproblem).

**Gegenmaßnahmen:**
- Sync als **atomare Transaktion**: der Server wendet exakt `seq = base+1 … N` ganz oder gar
  nicht an. Lückenlose `seq`-Nummern machen das idempotent — ein wiederholter Sync mit
  denselben seqs ist ein No-op.

---

## Was das fürs Konzept ändert

Drei Präzisierungen, die in die Architektur zurückfließen sollten:

1. **Sim-Versionierung ist ein First-Class-Thema** (R2), nicht ein Detail. Regeln als
   versionierte Daten, Server hält mehrere Versionen, erzwungenes Update als Fallback.
2. **Determinismus braucht eine Test- und Alarm-Infrastruktur** (R1): Replay-Tests in CI +
   Zustands-Hash-Kanarienvögel beim Sync, die Bugs von Cheats trennen.
3. **Der Sicherheits-Claim wird ehrlich scoped** (R5): „Zustand & Ökonomie fälschungssicher" —
   Bots/Automation sind ein getrennter, zusätzlicher Kampf.

Keiner dieser Punkte kippt die Idee. Aber R1 und R2 zusammen sind der Grund, warum das ein
*ernsthaftes* Projekt ist und kein Wochenend-Prototyp — und warum der erste echte Meilenstein
ein Determinismus-Beweis sein muss, kein Feature.

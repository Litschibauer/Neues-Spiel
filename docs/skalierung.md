# Skalierung: 1000–4000 gleichzeitig, auf einem Server

Die Frage war: Trägt das? Und: Sind wir eingesperrt, wenn nicht?

**Antwort auf beides, gemessen statt behauptet:** Ja, es trägt. Und nein, wir
sind nicht eingesperrt — aber der Ausweg ist ein anderer, als er intuitiv
aussieht.

---

## Was gemessen wurde

`npm run bench:scale -- 4000 30` — echter Sim-Kern, echter Speicher, keine
Attrappe. Dazu der Offline-Sturm: viele Spieler kommen gleichzeitig aus dem
Funkloch zurück und müssen validiert werden.

| Verdächtiger | gemessen | Engpass? |
| --- | --- | --- |
| Durchsatz | ~7.300 Syncs/s bei 4000 Höfen | **nein** |
| Validierung, 5000 Offline-Aktionen | 4,6 ms | **nein** |
| Offline-Sturm, 4000 × 200 Aktionen | 0,2 s für 800.000 Aktionen | **nein** |
| Arbeitsspeicher | 73 MB bei 4000 geladenen Höfen | **nein** |
| Platte | 8,2 kB je Hof | **nein** |

Zur Einordnung: 4000 gleichzeitig **aktive** Spieler erzeugen etwa 1000 Syncs/s.
Das ist rund ein Siebtel dessen, was die Maschine hergibt.

⚠️ Gemessen auf einer Entwicklungsmaschine. Ein 1-GB-Mini-VPS ist langsamer —
`npm run bench:scale` gehört **dort** ausgeführt. Die Größenordnung stimmt aber:
Es geht um Tausende Syncs pro Sekunde, nicht um Dutzende.

Warum die Validierung so billig ist: Der Sim-Kern ist reine Integer-Arithmetik
und schreibt Zeit in **geschlossener Form** fort (§7) statt Tick für Tick. Ein
Spieler, der acht Stunden weg war, kostet nicht achtmal so viel wie einer, der
eine Stunde weg war — er kostet, was seine Aktionen kosten.

---

## Warum keine „richtige" Datenbank

Der naheliegende Reflex bei „muss skalieren" ist Postgres, MariaDB oder Mongo.
Hier wäre das heute ein Rückschritt, und zwar aus drei nachprüfbaren Gründen:

1. **Langsamer.** Jeder Zugriff wäre eine Netzwerk-Rundreise statt eines
   Speicherzugriffs in derselben Datei. Bei einem Sync alle paar Millisekunden
   ist das keine Kleinigkeit.
2. **Ein zweiter Dienst zum Betreiben.** Aktualisieren, sichern, überwachen,
   nachts reparieren. Auf einem Mini-Server ist das mehr Risiko als Gewinn.
3. **Es löst das Falsche.** Die Datenbank ist nicht der Engpass — siehe oben.

SQLite ist für genau diese Form gebaut: **ein** Server, kein Loadbalancer,
keine Regionen. Und `node:sqlite` liegt Node 22 bei, kostet also nicht einmal
eine Abhängigkeit.

**Das heißt nicht „nie".** Es heißt: nicht, weil es sich groß anfühlt, sondern
wenn eine Messung es verlangt.

---

## Der echte Engpass

Er ist nicht die Datenbank. Er ist, dass **ein Hof im Arbeitsspeicher genau
eines Prozesses lebt**.

```
    Prozess A                    Prozess B
    ┌──────────────┐             ┌──────────────┐
    │ Hof #17      │             │ Hof #17      │   ← zwei Kopien
    │ seq 412      │             │ seq 409      │   ← zwei Wahrheiten
    └──────────────┘             └──────────────┘
              ↘                 ↙
               ┌──────────────────┐
               │   Datenbank      │   ← egal welche
               └──────────────────┘
```

Zwei Prozesse mit demselben Hof im Speicher sind ein Fork (R3) — dieselbe
Sequenznummer, zwei verschiedene Geschichten. **Daran ändert keine Datenbank
etwas.** Wer Postgres einbaut und zwei Serverprozesse startet, hat genau dieses
Problem, nur teurer.

Dasselbe gilt für den Markt: Zwei Prozesse, die beide entscheiden, wer ein
Angebot bekommt, verkaufen es zweimal.

---

## Was gebaut wurde, damit der Ausweg offen bleibt

### 1. Eine echte Grenze: `src/server/storage.ts`

Der Rest des Servers redet ausschließlich hierüber mit der Platte. Eine andere
Datenbank ist damit **eine neue Klasse, die `Storage` erfüllt** — kein Umbau am
Spiel.

Jede Methode ist so geschnitten, dass eine echte Datenbank sie in **einer**
Anweisung erfüllen kann. `claimOffer` etwa ist nicht „lies, prüfe, lösche",
sondern ein einziger atomarer Griff:

```sql
delete from market_offers where id = ? and seller <> ? returning *
```

Das ist der Unterschied zwischen einer Schnittstelle, die zufällig auf einem
einfädigen Prozess funktioniert, und einer, die auch mit mehreren trägt.

### 2. Ein Vertrag, der ausgeführt wird: `test/storage-contract.test.ts`

Dieselbe Testreihe läuft gegen **jede** Implementierung. Heute sind es zwei
(SQLite und nur-im-Speicher); wer Postgres ergänzt, hängt sie in `BACKENDS` ein
und macht die Tests grün.

Warum zwei: **Eine Schnittstelle mit nur einer Implementierung ist meistens nur
die Form dieser einen Implementierung.** Erst die zweite zeigt, ob wirklich
nichts durchgesickert ist. Dieselbe Disziplin wie die Golden Vectors für den
Sim-Kern.

Geprüft wird nicht „speichert und liest", sondern das, woran ein Speicher im
Betrieb scheitert: Atomarität unter Gleichzeitigkeit, Isolation zwischen Höfen,
und dass nichts verlorengeht, was Geld ist.

### 3. Der Besitz eines Hofes: `claimFarm`

```ts
storage.claimFarm(farmId, prozessId, bisWann)   // true = gehört jetzt uns
```

Noch ohne Wirkung, solange ein Prozess läuft — aber er ist der Baustein, der
mehrere Prozesse überhaupt erst zulässt. Zwei Eigenschaften stecken drin, und
beide sind vom Vertrag geprüft:

- **Genau einer gewinnt.** Ein zweiter Prozess bekommt `false` und darf den Hof
  nicht laden.
- **Ein abgestürzter Prozess blockiert nicht für immer.** Der Besitz läuft ab.
  Freigeben kann nur, wer noch läuft; ohne Ablauf wäre ein Absturz das
  dauerhafte Ende dieses Hofes.

---

## Was noch fehlt, wenn wirklich zwei Server laufen sollen

Ehrlich und vollständig, damit es nicht überrascht:

| Was | Warum es fehlt | Aufwand |
| --- | --- | --- |
| **Anfragen zum Besitzer lenken** | Ein Spieler muss immer auf dem Prozess landen, der seinen Hof hält — sonst nützt der Besitz nichts. Ein Reverse Proxy, der nach Hof-ID verteilt, reicht. | überschaubar |
| **`Storage` asynchron** | Über Netz geht kein synchroner Aufruf. Zieht sich bis in `Server.sync` durch und erzwingt eine Sperre je Hof, damit zwei Anfragen nicht ineinanderlaufen. | der größte Posten |
| **Markt-Auslage teilen** | Jeder Prozess hält heute eine eigene Kopie des Buches. Die *Entscheidung* liegt schon im Speicher und ist damit sicher, aber die Anzeige kann veralten. | klein |
| **Besitz auch wirklich nutzen** | `claimFarm` wird vom Server noch nicht aufgerufen — es gibt ja nur einen. | klein |

Reihenfolge, falls es je soweit kommt: erst die Anfragen lenken, dann `Storage`
asynchron. Die Datenbank zu tauschen ist der **letzte** Schritt, nicht der
erste.

---

## Und vorher: wo es wirklich zuerst weh tut

Nicht bei 4000 Spielern. Sondern hier:

- ~~**Backups.**~~ Erledigt: `npm run backup -- --env=prod` schreibt bei
  laufendem Server eine geprüfte Kopie, der Zeitgeber in `deploy/` macht es
  täglich. Was noch fehlt, ist der Weg **nach außen** — die Sicherungen liegen
  auf derselben Platte und helfen gegen Bedienfehler, nicht gegen einen
  kaputten Server.
- **Kein Rate-Limit auf `/api/sync`.** Ein entschlossener Angreifer kann fluten;
  die Anlege-Bremse deckt nur `/api/account` ab.
- **Keine Account-Wiederherstellung.** Schlüssel weg heißt Hof weg.
- **Bandbreite.** 4000 aktive Spieler bei ~1000 Syncs/s à wenige Kilobyte sind
  einige MB/s. Das ist eher die Grenze eines Mini-VPS als seine CPU.

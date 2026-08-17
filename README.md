# Neues Spiel

Ein Live-Service-Farmgame (Hay-Day-mäßig), **mobile-first & multiplattform**, mit einem
ungewöhnlichen Kern-Feature:

> **Cheat-sicher *und* offline spielbar.** Alles läuft server-authoritativ, aber man kann
> offline weiterspielen — und sobald wieder Internet da ist, validiert der Server jede
> Aktion rückwirkend. Für ehrliche Spieler nahtlos, für Cheater ein stiller Rollback.

Wie das technisch funktioniert (deterministische Simulation, Command-Log, Sync-Flow,
Zeit-Autorität) steht in **[docs/architecture.md](docs/architecture.md)**.

Ein ehrlicher Stresstest — wo das Konzept brechen kann und wie man das abfängt — steht in
**[docs/risks.md](docs/risks.md)**.

## In fünf Minuten selbst ausprobieren

Keine Abhängigkeiten, kein `npm install`, kein Build-Werkzeug — nur Node ≥ 22.6.

```bash
git clone https://github.com/Litschibauer/Neues-Spiel.git
cd Neues-Spiel
git checkout claude/live-service-game-concept-m4ymol

npm test        # 207 Tests, sollte grün sein
npm run dev     # Spiel auf http://localhost:8788
```

Im Browser öffnen, **Neuen Hof anlegen**, Schlüssel notieren, losspielen.
In der Entwicklungsumgebung laufen die Uhren zehnmal schneller: Weizen 12 s,
Futter 30 s, Eier 90 s — ein kompletter Durchlauf dauert Minuten statt einen
Nachmittag.

| Adresse | Was |
| --- | --- |
| `/` | Das Spiel |
| `/feldtest` | Dasselbe mit Messinstrumenten: `seq`, Tick, Warteschlange, Protokoll |
| `/admin` | Werkbank: Zeit vorspulen, Ware schenken, zurücksetzen |
| `/health` | Lebenszeichen |

**Den Offline-Fall wirklich sehen:** Zwei Browser-Tabs auf `/` und `/feldtest`,
im Entwicklerwerkzeug das Netz auf „offline" stellen, weiterspielen, Seite neu
laden — der Hof ist da, samt unbestätigter Aktionen. Netz wieder an, alles
läuft nach.

**Handel zu zweit:** Zweiten Hof in einem privaten Fenster anlegen, dort unter
*Lager* etwas anbieten, im ersten Hof unter *Markt* kaufen.

Automatisiert prüft beides `npm run offlinetest` (echter Chromium, 31 Prüfungen).
Ob die Maschine die Spielerzahl trägt: `npm run bench:scale -- 4000 30`.

Auf einem Server statt lokal — TLS, systemd-Units, Sicherungen, Umgebungen:
**[docs/deploy.md](docs/deploy.md)**. Fertige Unit-Dateien liegen in
**`deploy/`**.

## Prototyp

Der Sim-Kern existiert und die riskanteste Annahme ist geprüft: Client und Server rechnen
bit-für-bit dasselbe — abgesichert durch fünf gestapelte Verteidigungsschichten, von einem
statischen CI-Wächter über Fuzzing gegen eine Grundwahrheit bis zu Golden Vectors für den
Plattform-Beweis. Dazu ein Verbindungsmodell ohne Offline-Modus, das den
klassischen Zug-im-Tunnel-Fall nachweislich nahtlos übersteht.

```bash
npm test    # 207 Tests, keine Dependencies, kein Build (Node >= 22.6)
```

Was bewiesen ist, was nicht, die gemessenen Lastzahlen und die vier echten Bugs, die dabei
ans Licht kamen: **[docs/prototype.md](docs/prototype.md)**.

## Feldtest auf eigener Hardware

Ein abhängigkeitsfreier Server (nur `node:http`) mit Handy-Client, um das
Verbindungsmodell über ein echtes Netzwerk zu prüfen statt über Testattrappen —
Anleitung in **[docs/deploy.md](docs/deploy.md)**.

Den entscheidenden Fall fährt inzwischen ein Skript: `npm run offlinetest`
startet einen echten Chromium, spielt, **kappt das Netz, lädt neu** — und prüft,
dass der Hof mit allen unbestätigten Aktionen wieder da ist.

## Der Kernkreislauf

```
Feld -> Weizen -> Mühle -> Hühnerfutter -> Gehege -> Eier
                             |
                     Kundenauftrag -> Gold + Erfahrung
                             |
                     Stufe erreicht -> neuer Platz kaufbar
```

Bewusst nicht mehr. Das ganze Spiel läuft auf **vier Commands**:

- `START` / `COLLECT` — Feld bestellen, Mühle beschicken, Hühner füttern sind derselbe
  Platz mit demselben Timer. Der Unterschied steckt im Rezept, und Rezepte sind Daten.
- `BUY` — „Gehege kaufen" und „Hühner kaufen" sind zwei Ausbaustufen desselben Platzes.
- `FILL_REQUEST` — „liefere 5 Weizen, bekomm 25 Gold". Gibt dem Kreislauf sein Ziel.

Der letzte ist der interessante: Aufträge sind **zufällig und trotzdem offline
erfüllbar**. Der Server würfelt sie im Voraus und schickt einen Vorrat mit dem
Snapshot; der Sim-Kern verbraucht ihn und würfelt nie selbst.

Erfahrung und Stufen brauchen **gar kein Command** — XP fällt beim Abholen und
Liefern nebenbei an, das Level wird daraus abgeleitet, und seine Wirkung ist eine
Zahl neben dem Preis eines Platzes.

Der Sim-Kern kennt keinen Weizen und keine Hühner, nur Katalogindizes. Eine neue
Feldfrucht ist deshalb eine Tabellenzeile, kein Code. Wohin das führen soll, steht in
**[docs/konzept-map.md](docs/konzept-map.md)** — rund hundert Ideen, verdichtet auf neun
Mechaniken.

## Entwicklung und Produktion

```bash
npm run dev     # schnelle Uhren, Werkbank an, Port 8788
npm run prod    # echte Zeiten,   Werkbank aus, Port 8787
```

Beide laufen gleichzeitig und teilen sich nichts — eigener Port, eigener Spielstand,
eigenes Token, eigenes Regelwerk. Damit lässt sich an einer Version herumprobieren,
während die echten Spielstände nebenan weiterlaufen. Details und die eingebauten
Riegel: **[docs/deploy.md](docs/deploy.md)**.

## Status

**Acht der neun Mechaniken stehen.** Der Kreislauf ist spielbar und über echtes HTTP
geprüft: vom leeren Hof über gelieferte Aufträge zu Stufe 3, mit dem Server, der jeden
Schritt unabhängig nachrechnet. Determinismus über zwei Engine-Familien belegt, Handel
und Postfach implementiert, Inhalt vollständig datengetrieben, Dev und Produktion
getrennt.

**Das Offline-Versprechen ist vollständig:** Der Spielstand liegt auf dem Gerät,
die App startet ohne Netz, und ein Neuladen im Funkloch kostet nichts.

**Und es gibt Accounts** — bewusst so einfach wie möglich: ein Hof ist ein
120-Bit-Schlüssel, den der Server einmal ausgibt. Kein Passwort, keine E-Mail. Der
Preis steht offen dabei: Schlüssel weg heißt Hof weg.

Noch kein fertiges Spiel: kein Orderbuch, keine Nachbarn, kein TLS, keine richtige
Oberfläche.

## Nächster Schritt

Der Weg zum Spiel steht in **[docs/roadmap.md](docs/roadmap.md)** — in Phasen, mit dem,
was jede absichert und kostet. Als Nächstes: TLS (der Hof-Schlüssel reist in jedem
Aufruf mit), und danach das Orderbuch — das Erste, was zwei Spieler wirklich verbindet.

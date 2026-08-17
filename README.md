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

## Prototyp

Der Sim-Kern existiert und die riskanteste Annahme ist geprüft: Client und Server rechnen
bit-für-bit dasselbe — abgesichert durch fünf gestapelte Verteidigungsschichten, von einem
statischen CI-Wächter über Fuzzing gegen eine Grundwahrheit bis zu Golden Vectors für den
Plattform-Beweis. Dazu ein Verbindungsmodell ohne Offline-Modus, das den
klassischen Zug-im-Tunnel-Fall nachweislich nahtlos übersteht.

```bash
npm test    # 96 Tests, keine Dependencies, kein Build (Node >= 22.6)
```

Was bewiesen ist, was nicht, die gemessenen Lastzahlen und die vier echten Bugs, die dabei
ans Licht kamen: **[docs/prototype.md](docs/prototype.md)**.

## Feldtest auf eigener Hardware

Ein abhängigkeitsfreier Server (nur `node:http`) mit Handy-Client, um das
Verbindungsmodell über ein echtes Netzwerk zu prüfen statt über Testattrappen —
Anleitung in **[docs/deploy.md](docs/deploy.md)**.

## Inhalt ist eine Tabelle

Der Sim-Kern kennt keinen Weizen und keine Eier — nur Katalogindizes, Rezepte und
Produktionsplätze aus dem Regelwerk. Feld, Werkstatt und Tier sind **derselbe** Platz mit
demselben Timer:

```
Eingaben verbrauchen  ->  Zeit vergeht  ->  Ausgabe liegt bereit  ->  abholen
```

Deshalb kostete die Kette Weizen -> Mehl -> Brot null Zeilen Sim-Code: Mühle und Bäckerei
sind Tabellenzeilen. Was das Spiel ausmacht, steht in
**[docs/konzept-map.md](docs/konzept-map.md)** — rund hundert Ideen, verdichtet auf neun
Mechaniken.

## Status

Konzept steht, Kern-Mechanik ist am lauffähigen Prototyp validiert — Determinismus über zwei
Engine-Familien belegt, Handel und Postfach implementiert, Verbindungsmodell über echtes HTTP
geprüft, Inhalt vollständig datengetrieben. Noch kein Spiel: kein Orderbuch, kein Zufall,
keine Spiel-UI, keine Accounts.

## Nächster Schritt

Der Weg vom belegten Mechanismus zum Spiel steht in **[docs/roadmap.md](docs/roadmap.md)** —
in Phasen, mit dem, was jede absichert und kostet. Phase 1 (Inhalt als Daten) ist erledigt;
als Nächstes das echte Command-Set, beginnend mit dem Erfüllen von Aufträgen.

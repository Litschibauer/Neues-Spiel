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
npm test    # 68 Tests, keine Dependencies, kein Build (Node >= 22.6)
```

Was bewiesen ist, was nicht, die gemessenen Lastzahlen und die vier echten Bugs, die dabei
ans Licht kamen: **[docs/prototype.md](docs/prototype.md)**.

## Feldtest auf eigener Hardware

Ein abhängigkeitsfreier Server (nur `node:http`) mit Handy-Client, um das
Verbindungsmodell über ein echtes Netzwerk zu prüfen statt über Testattrappen —
Anleitung in **[docs/deploy.md](docs/deploy.md)**.

## Status

Konzept steht, Kern-Mechanik ist am lauffähigen Prototyp validiert — Determinismus über zwei
Engine-Familien belegt, Handel und Postfach implementiert, Verbindungsmodell über echtes HTTP
geprüft. Noch kein Spiel: kein Orderbuch, kein Zufall, keine Spiel-UI, keine Accounts.

## Nächster Schritt

Aktiv-Gerät-Token gegen den Multi-Device-Fork (R3) — der letzte Punkt, an dem ehrliche
Spieler noch Arbeit verlieren können.

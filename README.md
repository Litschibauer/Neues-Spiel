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
npm test    # 48 Tests, keine Dependencies, kein Build (Node >= 22.6)
```

Was bewiesen ist, was nicht, die gemessenen Lastzahlen und die drei echten Bugs, die dabei
ans Licht kamen: **[docs/prototype.md](docs/prototype.md)**.

## Status

Konzept steht, Kern-Mechanik ist am lauffähigen Prototyp validiert. Noch kein Spiel —
kein Markt, kein Zufall, keine UI, keine Persistenz.

## Nächster Schritt

Denselben Sim-Kern auf einer echten Mobile-Runtime laufen lassen und die Fuzz-Tests dort
wiederholen — das ist der Plattform-Determinismus-Beweis, den der Node-Prototyp offenlässt.

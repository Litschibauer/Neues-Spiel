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

## Status

Frühe Konzeptphase. Aktuell nur das Architektur-Konzept — noch kein Code.

## Nächster Schritt

Ein Minimal-Prototyp „Feld pflanzen → wachsen → ernten" end-to-end mit vollem Sync-Zyklus,
um Determinismus und Zeit-Handling früh zu beweisen (siehe offene Punkte in der Architektur).

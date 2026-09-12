#!/usr/bin/env python3
"""Mischt die Klänge des Spiels aus CC0-Quellen zusammen.

Einmalige Werkzeugkette, kein Teil des npm-Ablaufs. Braucht `pip install
soundfile` (bringt numpy und libsndfile mit) und die entpackten Pakete:

  kenney_interface-sounds/  kenney_impact-sounds/  kenney_rpg-audio/
    https://kenney.nl/assets/interface-sounds  (CC0)
    https://kenney.nl/assets/impact-sounds     (CC0)
    https://kenney.nl/assets/rpg-audio         (CC0)

Aufruf: python3 scripts/klaenge-mischen.py <ordner-mit-den-paketen>

Jeder Klang ist eine Liste von Schichten (Datei, Einsatz in Sekunden,
Lautstärke, Tonhöhe als Faktor). Ergebnis: mono, 22050 Hz, 16 Bit, Spitze
bei -5 dB, kurzes Ein- und Ausblenden — klein genug, um als Data-URI in die
Seite zu wandern und offline sofort da zu sein.
"""
import os
import sys

import numpy as np
import soundfile as sf

QUELLE = sys.argv[1] if len(sys.argv) > 1 else '.'
ZIEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'web', 'farm', 'klaenge')
SR = 22050
RETRO = 'retro512/The Essential Retro Video Game Sound Effects Collection [512 sounds] By Juhani Junkala/General Sounds/'

# Kurznamen für die Quellen, damit die Rezepte lesbar bleiben.
Q = {
    'if': 'kenney_interface-sounds/Audio/',
    'im': 'kenney_impact-sounds/Audio/',
    'rpg': 'kenney_rpg-audio/Audio/',
    'retro': RETRO,
}

# name: [(quelle, datei, einsatz_s, laut, tonhoehe, hoechstens_s)]
REZEPTE = {
    # Das Spiel ist ruhig — die Klänge auch: Holz, Stoff, Gras, Glas, Münzen.
    # Keine 8-Bit-Töne, keine Fanfaren. Was feiert, tut es mit Glöckchen.
    # Ein leiser Holzklick fürs Antippen.
    'tipp': [('if', 'click_002.ogg', 0, 0.5, 0.9, None)],
    # Etwas ist bestätigt: warm, kurz, nicht triumphierend.
    'bestaetigt': [('if', 'confirmation_001.ogg', 0, 0.7, 1.0, None)],
    # Geht nicht: ein dumpfes, tiefes Klopfen — kein Alarm.
    'fehler': [('if', 'bong_001.ogg', 0, 0.8, 0.85, None), ('if', 'bong_001.ogg', 0.11, 0.6, 0.8, None)],
    # Säen: zweimal ins Gras greifen.
    'saat': [('im', 'footstep_grass_001.ogg', 0, 0.6, 0.9, None), ('im', 'footstep_grass_002.ogg', 0.09, 0.5, 0.85, None)],
    # Ernten: Blätterrascheln mit einem weichen Zupfen darunter.
    'ernte': [('rpg', 'cloth2.ogg', 0, 0.8, 1.0, 0.25), ('if', 'pluck_002.ogg', 0.02, 0.35, 0.75, None)],
    # Münzen: echte Münzen in der Hand, kurz.
    'muenzen': [('rpg', 'handleCoins2.ogg', 0, 0.9, 1.0, None)],
    # Kaufen: der volle Griff in den Beutel.
    'kauf': [('rpg', 'handleCoins.ogg', 0, 0.8, 1.0, 0.45)],
    # Eine Kiste taucht auf: zwei weiche Glasklänge.
    'kiste': [('if', 'glass_003.ogg', 0, 0.6, 0.9, None), ('if', 'glass_001.ogg', 0.10, 0.5, 1.0, None)],
    # Die Truhe geht auf: Riegel, Knarzen des Deckels, dann leise Münzen.
    'truhe': [('rpg', 'metalLatch.ogg', 0, 0.6, 0.9, None), ('rpg', 'creak3.ogg', 0.08, 0.55, 1.0, None), ('rpg', 'handleCoins2.ogg', 0.34, 0.5, 1.0, None)],
    # Der Wagen: eine Tür fällt zu, darunter ein tiefer Schlag.
    'wagen': [('im', 'impactSoft_heavy_001.ogg', 0, 0.7, 0.9, None), ('rpg', 'doorClose_4.ogg', 0.02, 0.6, 1.0, 0.45)],
    # Ein Tier kommt: etwas Weiches landet im Stroh.
    'tier': [('rpg', 'dropLeather.ogg', 0, 0.8, 1.0, None), ('rpg', 'cloth3.ogg', 0.05, 0.35, 1.0, 0.3)],
    # Stufenaufstieg: drei Glöckchen aufwärts — ein Dreiklang, kein Trompetenstoß.
    'stufe': [('if', 'glass_001.ogg', 0, 0.7, 1.0, None), ('if', 'glass_001.ogg', 0.16, 0.7, 1.26, None), ('if', 'glass_001.ogg', 0.32, 0.8, 1.5, None), ('if', 'glass_004.ogg', 0.34, 0.35, 1.0, 0.5)],
    # Erfolg: zwei Glöckchen, die Quinte hinauf.
    'erfolg': [('if', 'glass_001.ogg', 0, 0.7, 1.0, None), ('if', 'glass_001.ogg', 0.18, 0.75, 1.5, None)],
    # Zettel geschafft: ein helles, warmes Bestätigen.
    'zettel': [('if', 'confirmation_001.ogg', 0, 0.7, 1.2, None)],
    # Fundstück: ein Glöckchen mit leisen Münzen.
    'fund': [('if', 'glass_001.ogg', 0, 0.7, 1.19, None), ('rpg', 'handleCoins2.ogg', 0.06, 0.4, 1.0, 0.25)],
    # Bauen: drei Hammerschläge auf Bretter, gedämpft.
    'bau': [('im', 'impactPlank_medium_001.ogg', 0, 0.7, 0.95, None), ('im', 'impactPlank_medium_002.ogg', 0.16, 0.65, 1.0, None), ('im', 'impactPlank_medium_003.ogg', 0.32, 0.75, 0.9, None)],
}


def lade(quelle, datei):
    daten, sr = sf.read(os.path.join(QUELLE, Q[quelle], datei), always_2d=True)
    x = daten.mean(axis=1).astype(np.float64)
    return x, sr


def umtasten(x, sr, faktor):
    # Wiedergabe mit `faktor` (Tonhöhe) und aufs Zielraster: lineare
    # Interpolation reicht für kurze Effekte.
    n_alt = len(x)
    n_neu = int(n_alt * SR / (sr * faktor))
    if n_neu < 2:
        return np.zeros(2)
    stellen = np.linspace(0, n_alt - 1, n_neu)
    return np.interp(stellen, np.arange(n_alt), x)


def beschneide(x, hoechstens):
    spitze = np.abs(x).max() or 1.0
    ueber = np.where(np.abs(x) > spitze * 0.01)[0]
    if len(ueber):
        x = x[max(0, ueber[0] - int(SR * 0.005)):ueber[-1] + 1]
    if hoechstens is not None:
        x = x[:int(SR * hoechstens)]
    return x


def blende(x, ein=0.003, aus=0.03):
    n_ein = min(len(x) // 2, int(SR * ein))
    n_aus = min(len(x) // 2, int(SR * aus))
    if n_ein > 0:
        x[:n_ein] *= np.linspace(0, 1, n_ein)
    if n_aus > 0:
        x[-n_aus:] *= np.linspace(1, 0, n_aus)
    return x


def mische(schichten):
    spuren = []
    for quelle, datei, einsatz, laut, tonhoehe, hoechstens in schichten:
        x, sr = lade(quelle, datei)
        x = umtasten(x, sr, tonhoehe)
        x = beschneide(x, hoechstens)
        x = x / (np.abs(x).max() or 1.0) * laut
        x = blende(x)
        versatz = int(SR * einsatz)
        spuren.append((versatz, x))
    laenge = max(v + len(x) for v, x in spuren)
    summe = np.zeros(laenge)
    for v, x in spuren:
        summe[v:v + len(x)] += x
    summe = summe / (np.abs(summe).max() or 1.0) * 0.56  # -5 dB, das Spiel ist ruhig
    return blende(summe, 0.002, 0.02)


def main():
    os.makedirs(ZIEL, exist_ok=True)
    for name, schichten in REZEPTE.items():
        x = mische(schichten)
        pfad = os.path.join(ZIEL, name + '.wav')
        sf.write(pfad, (x * 32767).astype(np.int16), SR, subtype='PCM_16')
        print(f'{name:12s} {len(x) / SR:5.2f} s  {os.path.getsize(pfad) / 1024:5.1f} kB')


if __name__ == '__main__':
    main()

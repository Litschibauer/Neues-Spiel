#!/usr/bin/env python3
"""Wandelt die freie Hintergrundmusik in einheitliche MP3s um.

Einmalige Werkzeugkette, kein Teil des npm-Ablaufs. Braucht
`pip install soundfile lameenc` und die heruntergeladenen Originale (siehe
LISTE unten, alle CC0 von opengameart.org).

Aufruf: python3 scripts/musik-umwandeln.py <ordner-mit-den-originalen>

Was passiert: stereo, 44,1 kHz, Lautheit auf -20 dBFS RMS angeglichen (Spitze
höchstens -1 dB), zwei Sekunden Ein- und Ausblenden, 128 kBit/s. Dazu schreibt
das Skript web/musik/LIZENZ.txt und web/farm/musik-namen.js.
"""
import os
import sys

import lameenc
import numpy as np
import soundfile as sf

QUELLE = sys.argv[1] if len(sys.argv) > 1 else '.'
HIER = os.path.dirname(os.path.abspath(__file__))
ZIEL = os.path.join(HIER, '..', 'web', 'musik')
NAMEN = os.path.join(HIER, '..', 'web', 'farm', 'musik-namen.js')
SR = 44100
RMS_ZIEL_DB = -20.0

# (Originaldatei, Zieldatei, Titel, Autor, Seite)
LISTE = [
    ('013_Another_August_0.mp3', 'another-august', 'Another August', 'cynicmusic', 'https://opengameart.org/content/another-august'),
    ('003_Vaporware_2.mp3', 'calm-piano', 'Calm Piano', 'cynicmusic', 'https://opengameart.org/content/calm-piano-1-vaporware'),
    ('Contemplation.mp3', 'contemplation', 'Contemplation', 'Joth', 'https://opengameart.org/content/contemplation-0'),
    ('restfulmeadow.ogg', 'restful-meadow', 'Restful Meadow', 'Tozn', 'https://opengameart.org/content/restful-meadow'),
    ('first_light_particles_0.wav', 'first-light', 'First Light Particles', 'Yoiymi', 'https://opengameart.org/content/first-light-particles-%E2%80%93-cc0-atmospheric-pianoambient-track'),
    ('fields_of_cabbage.ogg', 'fields-of-cabbage', 'Fields of Cabbage', 'ARochIFoundOnMyPillow', 'https://opengameart.org/content/fields-of-cabbage'),
    ('Meadow Thoughts.ogg', 'meadow-thoughts', 'Meadow Thoughts', 'Écrivin', 'https://opengameart.org/content/meadow-thoughts'),
    ('jrpg/Calm2 - Childhood Friends.ogg', 'childhood-friends', 'Childhood Friends', 'Juhani Junkala', 'https://opengameart.org/content/jrpg-pack-4-calm'),
    ('jrpg/Calm3 - Peaceful Days.ogg', 'peaceful-days', 'Peaceful Days', 'Juhani Junkala', 'https://opengameart.org/content/jrpg-pack-4-calm'),
    ('jrpg/Calm4 - Sand Castles.ogg', 'sand-castles', 'Sand Castles', 'Juhani Junkala', 'https://opengameart.org/content/jrpg-pack-4-calm'),
    ('jrpg/Calm5 - Summer Memories.ogg', 'summer-memories', 'Summer Memories', 'Juhani Junkala', 'https://opengameart.org/content/jrpg-pack-4-calm'),
    ('lofi/Lo-Fi And Chill (Lofi Collection)/02 HoliznaCC0 - Snow Drift.ogg', 'snow-drift', 'Snow Drift', 'HoliznaCC0', 'https://opengameart.org/content/lo-fi-and-chill-collection'),
    ('lofi/Lo-Fi And Chill (Lofi Collection)/01 HoliznaCC0 - First Snow.mp3.ogg', 'first-snow', 'First Snow', 'HoliznaCC0', 'https://opengameart.org/content/lo-fi-and-chill-collection'),
    ('lofi/Lo-Fi And Chill (Lofi Collection)/02 HoliznaCC0 - Everything You Ever Dreamed.ogg', 'everything-you-ever-dreamed', 'Everything You Ever Dreamed', 'HoliznaCC0', 'https://opengameart.org/content/lo-fi-and-chill-collection'),
    ('a_small_fire_will_do.wav', 'a-small-fire', 'A Small Fire Will Do', 'Trex0n', 'https://opengameart.org/content/a-small-fire-will-do-calming-loop'),
    ('shepherd_dog.wav', 'shepherd-dog', 'Shepherd Dog', 'Zne Little Music', 'https://opengameart.org/content/shepherd-dog-day-13'),
]


def umtasten(x, sr):
    if sr == SR:
        return x
    n_neu = int(len(x) * SR / sr)
    stellen = np.linspace(0, len(x) - 1, n_neu)
    return np.stack([np.interp(stellen, np.arange(len(x)), x[:, k]) for k in range(x.shape[1])], axis=1)


def bearbeite(pfad):
    d, sr = sf.read(pfad, always_2d=True, dtype='float64')
    if d.shape[1] == 1:
        d = np.repeat(d, 2, axis=1)
    d = umtasten(d[:, :2], sr)
    # Stille vorn und hinten weg.
    laut = np.abs(d).max(axis=1)
    ueber = np.where(laut > 0.002)[0]
    if len(ueber):
        d = d[ueber[0]:ueber[-1] + 1]
    # Lautheit angleichen, dann die Spitze deckeln.
    rms = np.sqrt(np.mean(d ** 2)) or 1e-9
    d = d * (10 ** (RMS_ZIEL_DB / 20) / rms)
    spitze = np.abs(d).max()
    if spitze > 0.89:
        d = d * (0.89 / spitze)
    n = int(SR * 2)
    d[:n] *= np.linspace(0, 1, n)[:, None]
    d[-n:] *= np.linspace(1, 0, n)[:, None]
    return d


def mp3(d):
    enc = lameenc.Encoder()
    enc.set_bit_rate(128)
    enc.set_in_sample_rate(SR)
    enc.set_channels(2)
    enc.set_quality(2)
    pcm = (np.clip(d, -1, 1) * 32767).astype(np.int16).tobytes()
    return bytes(enc.encode(pcm)) + bytes(enc.flush())


def main():
    os.makedirs(ZIEL, exist_ok=True)
    lizenz = ['Hintergrundmusik — Herkunft und Lizenz', '',
              'Alle Stücke sind CC0 (gemeinfrei) von opengameart.org. Umgewandelt mit',
              'scripts/musik-umwandeln.py: stereo, 44,1 kHz, 128 kBit/s, Lautheit angeglichen.', '']
    namen = ['// Anzeigename je Track (Dateiname → Titel). Quelle und Lizenz: web/musik/LIZENZ.txt.',
             'var MUSIK_NAMEN = {']
    for original, ziel, titel, autor, seite in LISTE:
        d = bearbeite(os.path.join(QUELLE, original))
        daten = mp3(d)
        with open(os.path.join(ZIEL, ziel + '.mp3'), 'wb') as f:
            f.write(daten)
        print(f'{ziel + ".mp3":34s} {len(d) / SR:5.0f} s  {len(daten) / 1024 / 1024:4.1f} MB  {titel} — {autor}')
        lizenz.append(f'{ziel + ".mp3":34s} „{titel}“ von {autor} — {seite}')
        namen.append(f'  {ziel + ".mp3"!r}: {titel!r},'.replace("'", '"'))
    namen.append('};')
    with open(os.path.join(ZIEL, 'LIZENZ.txt'), 'w') as f:
        f.write('\n'.join(lizenz) + '\n')
    with open(NAMEN, 'w') as f:
        f.write('\n'.join(namen) + '\n')


if __name__ == '__main__':
    main()

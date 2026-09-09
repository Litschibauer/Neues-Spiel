# Pixelify Sans

Die Pixelschrift für Namen und Überschriften. Zahlen und Fließtext bleiben
bewusst in der Systemschrift — in Pixelify Sans ist die `5` kaum von einem `S`
zu unterscheiden, und im Spiel ist fast jede Zahl Geld oder Menge.

- Quelle: https://github.com/eifetx/Pixelify-Sans (über Google Fonts)
- Lizenz: SIL Open Font License 1.1 — siehe `OFL.txt`, die mit ausgeliefert
  werden muss.
- `pixelify-sans.woff2` ist ein Ausschnitt der variablen Schrift (Gewicht
  400–700), zugeschnitten auf ASCII, Latin-1 und die Satzzeichen, die die
  Oberfläche benutzt (· × — „ " …). 199 Zeichen, 7,7 kB.

Der Build bettet die Datei als Data-URI ins Stylesheet der Seite ein
(`buildSchrift()` in `scripts/build-conformance.ts`). Es gibt also keine
zweite Anfrage, kein CDN und kein Umspringen der Schrift beim ersten Bild —
sie ist offline genauso da wie die Icons.

Neu zuschneiden, wenn Zeichen fehlen:

    pip install fonttools brotli
    python3 -m fontTools.subset PixelifySans[wght].ttf \
      --unicodes="U+0020-007E,U+00A0-00FF,U+2013,U+2014,U+2018,U+2019,U+201A,U+201C,U+201D,U+201E,U+2026,U+00B7,U+00D7,U+20AC" \
      --layout-features="" --no-hinting --desubroutinize \
      --flavor=woff2 --output-file=pixelify-sans.woff2

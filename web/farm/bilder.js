// Alle Bilder der Welt: Pixelkacheln aus den „Tiny"-Paketen von Kenney (CC0,
// siehe sprites/LIZENZ.txt) plus ein paar selbst gezeichnete Pixelmotive im
// selben Stil (Boot, Muehlenfluegel, Teich, Wasser, Feuer, Rauch).
//
// Jedes Objekt malt in eine SVG-Zeichenflaeche, deren Seitenverhaeltnis genau
// zu seinem Kasten passt (koerperMasse in raster.js). INNERHALB der Flaeche
// rechnen wir in Pixeln: eine Kachel ist 16 Pixel breit, k.e ist die Groesse
// eines Pixels in viewBox-Einheiten, k.ph die Hoehe des Kastens in Pixeln.
// Der Standplatz (die Zellen, die das Objekt belegt) liegt unten im Kasten,
// von k.pb bis k.ph; darueber ist Luft, in die das Objekt aufragt.

var KACHEL = 16;

// Hoehe in Zellen, um die ein Objekt ueber seinen Standplatz hinausragt.
var KOERPER = {
  'field-': 0.6, 'coop-': 3.1, mill: 3.1, dairy: 3.1, 'pasture-': 1.3, mine: 1.5,
  forge: 1.6, oven: 1.6, grill: 1.0, 'apple-tree': 1.3,
  woodlot: 1.4, workshop: 3.1, smokehouse: 4.4, kitchen: 3.1, 'sheep-': 1.3, weberei: 3.1,
  'deco-fence': 0.7, 'deco-flowers': 0.7, 'deco-bench': 0.7,
  'deco-erntekranz': 0.7, 'deco-boje': 0.9, 'deco-marktfahne': 0.9, 'deco-laterne': 0.7,
};
var KOERPER_HINDERNIS = { tree: 1.0, rock: 0.7, pond: 0 };
var KOERPER_MOEBEL = {
  brett: 1.3, lagerhaus: 1.3, stand: 1.3, nachbarn: 1.3, wagen: 1.3, kiste: 1.3,
  abenteuer: 1.6,
  boot: 0.6, schatz: 0.8,
};
var KOERPER_SEE = { haus: 1.85, dock: 0.4, spot: 0.9 };

function hoeheAus(tabelle, id, standard) {
  if (tabelle[id] !== undefined) return tabelle[id];
  for (var prefix in tabelle) {
    if (id.indexOf(prefix) === 0) return tabelle[prefix];
  }
  return standard;
}

function koerperMit(zellenB, zellenH, hoch) {
  var m = koerperMasse(zellenB, zellenH, hoch);
  m.e = 100 / (KACHEL * zellenB);
  m.ph = m.vh / m.e;
  m.pb = m.boden / m.e;
  return m;
}

function koerperFuer(id, zellenB, zellenH) { return koerperMit(zellenB, zellenH, hoeheAus(KOERPER, id, 1)); }
function koerperHindernis(kind, zellenB, zellenH) { return koerperMit(zellenB, zellenH, hoeheAus(KOERPER_HINDERNIS, kind, 0.7)); }
function koerperMoebel(id, zellenB, zellenH) { return koerperMit(zellenB, zellenH, hoeheAus(KOERPER_MOEBEL, id, 1)); }
function koerperSee(art, zellenB, zellenH) { return koerperMit(zellenB, zellenH, hoeheAus(KOERPER_SEE, art, 1)); }

// ---- Malwerkzeug -----------------------------------------------------------

// Eine Kachel (oder ein Ausschnitt in anderer Groesse) an Pixelposition.
function bild(k, name, px, py, b, h) {
  var q = typeof SPRITES === 'object' && SPRITES[name];
  if (!q) return '';
  b = b || KACHEL; h = h || KACHEL;
  return '<image href="' + q + '" x="' + (px * k.e) + '" y="' + (py * k.e) +
    '" width="' + (b * k.e + 0.05) + '" height="' + (h * k.e + 0.05) + '" preserveAspectRatio="none"/>';
}

// Selbst gezeichnetes Pixelmotiv: Zeilen aus Zeichen, jedes Zeichen ein Pixel,
// Farben ueber die Tabelle. Gleiche Nachbarpixel werden zu einem Rechteck.
function pix(k, zeilen, farben, px, py, skala) {
  var u = k.e * (skala || 1);
  var out = '';
  for (var y = 0; y < zeilen.length; y++) {
    var z = zeilen[y];
    for (var x = 0; x < z.length; x++) {
      var c = farben[z[x]];
      if (!c) continue;
      var x2 = x;
      while (x2 + 1 < z.length && z[x2 + 1] === z[x]) x2++;
      out += '<rect x="' + (px * k.e + x * u) + '" y="' + (py * k.e + y * u) +
        '" width="' + ((x2 - x + 1) * u + 0.03) + '" height="' + (u + 0.03) + '" fill="' + c + '"/>';
      x = x2;
    }
  }
  return out;
}

function schatten(k, mx, my, b) {
  return '<ellipse cx="' + (mx * k.e) + '" cy="' + (my * k.e) + '" rx="' + (b / 2 * k.e) +
    '" ry="' + (b / 6 * k.e) + '" fill="#2a1c26" opacity=".22"/>';
}

var FARBEN = {
  o: '#3b2b3c', w: '#c98a52', d: '#8d5a35', s: '#f4ecd8', b: '#4fa4d8', B: '#8fd3f4',
  n: '#2f6f9e', g: '#e6d19c', G: '#c9ad72', r: '#e8553c', y: '#f6c35a', q: '#cfd3d6',
  k: '#6b6b70', f: '#5aa04f', F: '#8bd06a',
};

// Das Abenteuerbrett: zwei Pfosten, ein Dach, zwei angepinnte Zettel und unten
// eine Leiste, die sich einfaerbt, wenn etwas abzuholen ist.
var ABENTEUER = [
  'oooooooooooooooooooo',
  'oddddddddddddddddddo',
  'oddddddddddddddddddo',
  'oooooooooooooooooooo',
  '.oooooooooooooooooo.',
  '.owwwwwwwwwwwwwwwwo.',
  '.owssrssswwssrssswo.',
  '.owskkkkswwskkkkswo.',
  '.owskkksswwskkksswo.',
  '.owsssssswwsssssswo.',
  '.owwwwwwwwwwwwwwwwo.',
  '.owwyyyywwwwyyyywwo.',
  '.owwwwwwwwwwwwwwwwo.',
  '.oooooooooooooooooo.',
  '....oo........oo....',
  '....od........do....',
  '....od........do....',
  '....oo........oo....',
];

// Wartet nichts, bleibt die Leiste holzfarben statt zu leuchten.
var ABENTEUER_RUHIG = ABENTEUER.map(function (z) { return z.split('y').join('G'); });

var BOOT_HEIL = [
  '.......o........',
  '.......os.......',
  '.......osss.....',
  '.......ossss....',
  '.......osssss...',
  '.......o........',
  '..oooooooooooo..',
  '.owwwwwwwwwwwwo.',
  '.oddddddddddddo.',
  '..oooooooooooo..',
];
var BOOT_KAPUTT = [
  '................',
  '................',
  '.........o......',
  '........oo......',
  '.......oo.......',
  '..oooooooooooo..',
  '.owwwwwwbbwwwwo.',
  '.odddddobbodddo.',
  '..ooooo.oo.ooo..',
  '................',
];
var TEICH = [
  '....oooooooo....',
  '..oonnnnnnnnoo..',
  '.obbbBBBbbbbbbo.',
  '.obbBBBBBBBbbbo.',
  '.obbBBbbbbBBbbo.',
  '.obbbbbbbbbbbbo.',
  '..oobbbbbbbboo..',
  '....oooooooo....',
];
var FEUER = [
  '..r...',
  '.rrr..',
  '.ryr.r',
  'ryyrrr',
  'ryyyyr',
  '.ryyr.',
];
var RAUCH = [
  '.qq.',
  'qqqq',
  '.qq.',
];
var INSEL = [
  '........oooooooooooooooo........',
  '....ooooggggggggggggggggoooo....',
  '..ooggggggggggggggggggggggggoo..',
  '.ogggggggggggggggggggggggggggggo',
  '.oggggGGggggggggggggggGGgggggggo',
  '.oGGGGGGGGGGGGGGGGGGGGGGGGGGGGGo',
  '..ooGGGGGGGGGGGGGGGGGGGGGGGGoo..',
  '....oooooooooooooooooooooooo....',
];

// ---- Plaetze -----------------------------------------------------------------

function artRaumFor(p, k) {
  var id = p.id;
  if (id.indexOf('field-') === 0) {
    var stufe = !p.busy && !p.done ? 0 : p.done ? 3 : p.progress < 0.4 ? 1 : 2;
    return artFeld(k, stufe, p.producing);
  }
  var tiere = p.stall ? p.stall.animals : 0;
  if (id.indexOf('coop-') === 0) return artStall(k, tiere, p.done);
  if (id.indexOf('pasture-') === 0) return artWeide(k, tiere, p.done);
  if (id.indexOf('sheep-') === 0) return artSchafweide(k, tiere, p.done);
  if (id === 'weberei') return artWeberei(k, p.busy);
  if (id === 'mill') return artMuehle(k, p.busy);
  if (id === 'dairy') return artMolkerei(k, p.busy);
  if (id === 'mine') return artMine(k, p.busy);
  if (id === 'forge') return artSchmiede(k, p.busy);
  if (id === 'oven') return artOfen(k, p.busy);
  if (id === 'grill') return artGrill(k, p.busy);
  if (id === 'apple-tree') return artApfelbaum(k, p.baum ? p.baum.stufe : 'wachsen');
  if (id === 'woodlot') return artWaldstueck(k, p.busy);
  if (id === 'workshop') return artWerkstatt(k, p.busy);
  if (id === 'smokehouse') return artRaeucherei(k, p.busy);
  if (id === 'kitchen') return artHofkueche(k, p.busy);
  if (id === 'deco-fence') return bild(k, 'zaun-m', 0, k.ph - 16);
  if (id === 'deco-flowers') return bild(k, 'gras-blumen', 0, k.ph - 16);
  if (id === 'deco-bench') return bild(k, 'tisch', 0, k.ph - 16);
  if (id === 'deco-erntekranz') return bild(k, 'kranz', 0, k.ph - 16);
  if (id === 'deco-boje') return bild(k, 'boje', 0, k.ph - 16);
  if (id === 'deco-marktfahne') return bild(k, 'fahne', 0, k.ph - 16);
  if (id === 'deco-laterne') return bild(k, 'lampe', 0, k.ph - 16);
  return artFeld(k, 0, null);
}

// Zwei Beete uebereinander, je 12 Pixel hoch; darauf je drei Pflanzen.
function artFeld(k, stufe, crop) {
  var beet = 12;
  var oben = [k.ph - 2 * beet - 1, k.ph - beet - 1];
  var out = '', r, i;
  for (r = 0; r < 2; r++) {
    out += bild(k, 'acker-l', 0, oben[r], 16, beet) + bild(k, 'acker-r', 16, oben[r], 16, beet);
  }
  if (stufe <= 0) return out;
  var art = crop === 'corn' ? 'mais' : crop === 'wheat' ? 'weizen' : 'moehre';
  var name = art + '-' + Math.min(3, Math.max(1, stufe));
  // Die Halme wiegen sich im Wind. Eine Gruppe je Reihe, nicht je Pflanze —
  // Felder gibt es nur eine Handvoll, das kostet nichts.
  for (r = 0; r < 2; r++) {
    out += '<g class="halme" style="animation-delay:' + (r * 700) + 'ms">';
    for (i = 0; i < 3; i++) out += bild(k, name, 1 + i * 10.5, oben[r] - 3, 10, 10);
    out += '</g>';
  }
  return out;
}

// Kleine Scheune: gruenes Dach, Wand mit Fenstern, Torreihe. Huehner davor.
function artStall(k, tiere, fertig) {
  var u = k.ph - 1;
  var out = schatten(k, 16, u, 34) +
    bild(k, 'dach-4', 0, u - 48) + bild(k, 'dach-6', 16, u - 48) +
    bild(k, 'wand-1', 0, u - 32) + bild(k, 'wand-3', 16, u - 32) +
    bild(k, 'tor-2', 0, u - 16) + bild(k, 'tor-3', 16, u - 16);
  var plaetze = [[-2, u - 11], [22, u - 10], [9, u - 7]];
  for (var t = 0; t < Math.min(3, tiere); t++) {
    out += '<g class="tier" style="animation-delay:' + (t * 900) + 'ms">' +
      bild(k, 'huhn', plaetze[t][0], plaetze[t][1], 11, 11) + '</g>';
  }
  if (fertig) out += bild(k, 'ei-korb', 23, u - 8, 9, 9);
  return out;
}

// Zaun um eine Wiese, Kuehe darin.
function artWeide(k, tiere, fertig) {
  var u = k.ph - 1;
  var out =
    bild(k, 'zaun-ecke-lo', 0, u - 32) + bild(k, 'zaun-m', 16, u - 32) + bild(k, 'zaun-ecke-ro', 32, u - 32);
  var plaetze = [[6, u - 25, 'kuh-1'], [27, u - 22, 'kuh-2'], [16, u - 18, 'kuh-1']];
  for (var t = 0; t < Math.min(3, tiere); t++) {
    out += '<g class="tier langsam" style="animation-delay:' + (t * 1300) + 'ms">' +
      bild(k, plaetze[t][2], plaetze[t][0], plaetze[t][1], 14, 14) + '</g>';
  }
  out += bild(k, 'zaun-ecke-lu', 0, u - 16) + bild(k, 'zaun-m', 16, u - 16) + bild(k, 'zaun-ecke-ru', 32, u - 16);
  if (fertig) out += bild(k, 'milch', 35, u - 12, 10, 10);
  return out;
}

// Zaun um eine Wiese, Schafe darin — wie die Kuhweide, mit Wollkorb.
function artSchafweide(k, tiere, fertig) {
  // Zwei Kacheln breit wie der Huehnerstall — so findet die Weide auch auf
  // einem vollen Hof noch Platz.
  var u = k.ph - 1;
  var out = bild(k, 'zaun-ecke-lo', 0, u - 32) + bild(k, 'zaun-ecke-ro', 16, u - 32);
  var plaetze = [[2, u - 25], [17, u - 22], [9, u - 18]];
  for (var t = 0; t < Math.min(3, tiere); t++) {
    out += '<g class="tier langsam" style="animation-delay:' + (t * 1100) + 'ms">' +
      bild(k, 'schaf', plaetze[t][0], plaetze[t][1], 12, 12) + '</g>';
  }
  out += bild(k, 'zaun-ecke-lu', 0, u - 16) + bild(k, 'zaun-ecke-ru', 16, u - 16);
  if (fertig) out += bild(k, 'wolle-korb', 21, u - 11, 10, 10);
  return out;
}

// Die Weberei: Holzhaus mit Webstuhl-Schild an der Wand.
function artWeberei(k, laeuft) {
  var u = k.ph - 1;
  var out = schatten(k, 16, u, 34) +
    bild(k, 'dach-blau-l', 0, u - 48) + bild(k, 'dach-blau-r', 16, u - 48) +
    bild(k, 'holz-wand', 0, u - 32) + bild(k, 'holz-wand', 16, u - 32) +
    bild(k, 'tor-holz', 0, u - 16) + bild(k, 'holz-wand', 16, u - 16);
  out += '<g class="' + (laeuft ? 'tier' : '') + '">' + bild(k, 'webstuhl', 17, u - 31, 14, 14) + '</g>';
  return out;
}

// Steinturm mit spitzem Dach; die Fluegel sind selbst gezeichnet und drehen
// sich, solange gemahlen wird.
function artMuehle(k, laeuft) {
  var u = k.ph - 1;
  var cx = 16, cy = u - 40;
  var out = schatten(k, 16, u, 22) +
    bild(k, 'stein-tuer', 8, u - 16) + bild(k, 'stein-wand', 8, u - 32) + bild(k, 'dach-rot-spitze', 8, u - 48);
  var fluegel = '';
  function balken(x, y, b, h) {
    return '<rect x="' + (x * k.e) + '" y="' + (y * k.e) + '" width="' + (b * k.e) + '" height="' + (h * k.e) + '" fill="' + FARBEN.o + '"/>' +
      '<rect x="' + ((x + 1) * k.e) + '" y="' + ((y + 1) * k.e) + '" width="' + ((b - 2) * k.e) + '" height="' + ((h - 2) * k.e) + '" fill="' + FARBEN.w + '"/>';
  }
  fluegel += balken(cx - 13, cy - 2, 26, 4) + balken(cx - 2, cy - 13, 4, 26);
  fluegel += '<rect x="' + ((cx - 2) * k.e) + '" y="' + ((cy - 2) * k.e) + '" width="' + (4 * k.e) + '" height="' + (4 * k.e) + '" fill="' + FARBEN.o + '"/>';
  var dreh = laeuft
    ? '<animateTransform attributeName="transform" type="rotate" from="0 ' + (cx * k.e) + ' ' + (cy * k.e) +
      '" to="360 ' + (cx * k.e) + ' ' + (cy * k.e) + '" dur="9s" repeatCount="indefinite"/>'
    : '';
  return out + '<g>' + dreh + fluegel + '</g>';
}

function artMolkerei(k, laeuft) {
  var u = k.ph - 1;
  return schatten(k, 16, u, 34) +
    bild(k, 'dach-blau-spitze', 8, u - 48) +
    bild(k, 'dach-blau-l', 0, u - 32) + bild(k, 'dach-blau-r', 16, u - 32) +
    bild(k, 'stein-fenster', 0, u - 16) + bild(k, 'stein-tuer', 16, u - 16) +
    bild(k, 'milch', 23, u - 9, 10, 10) + (laeuft ? bild(k, 'eimer', 1, u - 9, 9, 9) : '');
}

function artMine(k, laeuft) {
  var u = k.ph - 1;
  return schatten(k, 16, u, 34) +
    bild(k, 'stein', 0, u - 30) + bild(k, 'stein', 16, u - 31) +
    bild(k, 'bogen-l', 0, u - 16) + bild(k, 'bogen-r', 16, u - 16) +
    (laeuft ? bild(k, 'lampe', 12, u - 26, 8, 8) : '');
}

function artSchmiede(k, laeuft) {
  var u = k.ph - 1;
  var glut = laeuft
    ? '<g>' + pix(k, FEUER, FARBEN, 21, u - 13) +
      '<animate attributeName="opacity" values="1;.55;1" dur=".7s" repeatCount="indefinite"/></g>'
    : '';
  return schatten(k, 16, u, 34) +
    bild(k, 'schlot', 16, u - 32) +
    bild(k, 'ziegel', 0, u - 16) + bild(k, 'ofen-mund', 16, u - 16) + glut +
    bild(k, 'amboss', 2, u - 28, 12, 12);
}

function artOfen(k, laeuft) {
  var u = k.ph - 1;
  var rauch = laeuft
    ? '<g>' + pix(k, RAUCH, FARBEN, 6, u - 38) +
      '<animateTransform attributeName="transform" type="translate" values="0 0;0 ' + (-6 * k.e) + ';0 0" dur="2.4s" repeatCount="indefinite"/>' +
      '<animate attributeName="opacity" values=".9;.2;.9" dur="2.4s" repeatCount="indefinite"/></g>'
    : '';
  var glut = laeuft
    ? '<g>' + pix(k, FEUER, FARBEN, 21, u - 12) +
      '<animate attributeName="opacity" values="1;.5;1" dur=".9s" repeatCount="indefinite"/></g>'
    : '';
  return schatten(k, 16, u, 34) +
    bild(k, 'schlot', 0, u - 32) + rauch +
    bild(k, 'ziegel', 0, u - 16) + bild(k, 'ofen-mund-2', 16, u - 16) + glut;
}

function artGrill(k, laeuft) {
  var u = k.ph - 1;
  var feuer = laeuft
    ? '<g>' + pix(k, FEUER, FARBEN, 13, u - 24) +
      '<animate attributeName="opacity" values="1;.5;1" dur=".6s" repeatCount="indefinite"/></g>'
    : '';
  return schatten(k, 16, u, 22) +
    bild(k, 'fass-rot', 8, u - 16) + feuer + bild(k, 'foerderband', 8, u - 21, 16, 6);
}

// Zwei Tannen auf einem Stück Wald, dazwischen ein frischer Stumpf; solange
// geschlagen wird, liegt ein Stamm daneben.
function artWaldstueck(k, laeuft) {
  var u = k.ph - 1;
  return schatten(k, 16, u, 30) +
    bild(k, 'baum-tanne', -1, u - 30) + bild(k, 'baum-tanne', 16, u - 27) +
    bild(k, 'stumpf', 8, u - 14, 12, 12) +
    (laeuft ? bild(k, 'brett-wand', 20, u - 9, 12, 8) : '');
}

// Offener Schuppen: Holzwand mit Tor, davor die Werkbank. Beim Arbeiten
// blitzt der Amboss.
function artWerkstatt(k, laeuft) {
  var u = k.ph - 1;
  var funke = laeuft
    ? '<g>' + pix(k, ['.y.', 'yyy', '.y.'], FARBEN, 4, u - 26, 1.2) +
      '<animate attributeName="opacity" values="1;.2;1" dur=".5s" repeatCount="indefinite"/></g>'
    : '';
  return schatten(k, 16, u, 34) +
    bild(k, 'dach-rot-l', 0, u - 48) + bild(k, 'dach-rot-r', 16, u - 48) +
    bild(k, 'holz-wand', 0, u - 32) + bild(k, 'holz-fenster', 16, u - 32) +
    bild(k, 'tor-holz', 0, u - 16) + bild(k, 'holz-tuer', 16, u - 16) +
    bild(k, 'amboss', 1, u - 27, 12, 12) + funke +
    bild(k, 'kiste-holz', 20, u - 11, 11, 11);
}

// Steinkate mit Schlot; beim Räuchern steigt Rauch auf.
function artRaeucherei(k, laeuft) {
  var u = k.ph - 1;
  var rauch = laeuft
    ? '<g>' + pix(k, RAUCH, FARBEN, 24, u - 60) +
      '<animateTransform attributeName="transform" type="translate" values="0 0;0 ' + (-4 * k.e) + ';0 0" dur="2.8s" repeatCount="indefinite"/>' +
      '<animate attributeName="opacity" values=".9;.15;.9" dur="2.8s" repeatCount="indefinite"/></g>'
    : '';
  var glut = laeuft
    ? '<g>' + pix(k, FEUER, FARBEN, 4, u - 12) +
      '<animate attributeName="opacity" values="1;.5;1" dur=".8s" repeatCount="indefinite"/></g>'
    : '';
  // Schlot zuerst, Dach darüber — so schaut er oben heraus statt davor zu kleben.
  return schatten(k, 16, u, 34) +
    rauch + bild(k, 'schlot', 18, u - 56) +
    bild(k, 'dach-blau-l', 0, u - 48) + bild(k, 'dach-blau-r', 16, u - 48) +
    bild(k, 'stein-wand', 0, u - 32) + bild(k, 'stein-fenster', 16, u - 32) +
    bild(k, 'ofen-mund', 0, u - 16) + glut + bild(k, 'stein-tuer', 16, u - 16);
}

// Helles Haus mit Markise und Herdfeuer; beim Kochen steigt Dampf auf.
function artHofkueche(k, laeuft) {
  var u = k.ph - 1;
  var dampf = laeuft
    ? '<g>' + pix(k, RAUCH, FARBEN, 5, u - 42) +
      '<animateTransform attributeName="transform" type="translate" values="0 0;0 ' + (-5 * k.e) + ';0 0" dur="2.2s" repeatCount="indefinite"/>' +
      '<animate attributeName="opacity" values=".85;.15;.85" dur="2.2s" repeatCount="indefinite"/></g>'
    : '';
  var herd = laeuft
    ? '<g>' + pix(k, FEUER, FARBEN, 21, u - 12) +
      '<animate attributeName="opacity" values="1;.5;1" dur=".7s" repeatCount="indefinite"/></g>'
    : '';
  return schatten(k, 16, u, 34) + dampf +
    bild(k, 'dach-blau-l', 0, u - 48) + bild(k, 'dach-blau-r', 16, u - 48) +
    bild(k, 'markise', 0, u - 32) + bild(k, 'holz-fenster', 16, u - 32) +
    bild(k, 'holz-tuer', 0, u - 16) + bild(k, 'ofen-mund-2', 16, u - 16) + herd +
    bild(k, 'kiste-tomate', 21, u - 11, 11, 11);
}

function artApfelbaum(k, stufe) {
  var u = k.ph - 1;
  if (stufe === 'setzling') return schatten(k, 16, u, 14) + bild(k, 'setzling', 8, u - 16);
  if (stufe === 'verwelkt') return schatten(k, 16, u, 26) + bild(k, 'stumpf', 0, u - 32, 32, 32);
  return schatten(k, 16, u, 30) + bild(k, stufe === 'reif' ? 'apfelbaum' : 'baum-rund', 0, u - 32, 32, 32);
}

// ---- Hindernisse -------------------------------------------------------------

function artHindernisRaum(kind, k, saat) {
  var s = (saat || 0) % 3;
  if (kind === 'tree') return bild(k, ['baum', 'baum-tanne', 'baum-rund'][s], 0, k.ph - 16);
  if (kind === 'rock') return bild(k, s === 1 ? 'stein-klein' : 'stein', 0, k.ph - 16);
  return pix(k, TEICH, FARBEN, 0, k.ph - 8.5);
}

// ---- Hof-Moebel ----------------------------------------------------------------

function artMoebelRaum(id, k, z) {
  var u = k.ph - 1;
  z = z || {};
  if (id === 'brett') return schatten(k, 24, u, 26) + bild(k, 'schild', 8, u - 32, 32, 32);
  if (id === 'lagerhaus') {
    return schatten(k, 24, u, 46) + bild(k, 'heu', 10, u - 30) +
      bild(k, 'kiste-holz', 2, u - 16) + bild(k, 'kiste-holz-2', 18, u - 16) + bild(k, 'sack', 34, u - 16) +
      (z.voll ? bild(k, 'sack', 26, u - 28, 12, 12) : '');
  }
  if (id === 'stand') {
    return schatten(k, 24, u, 44) + bild(k, 'markise', 8, u - 32, 32, 32) +
      bild(k, 'kiste-voll', 2, u - 12, 12, 12) + bild(k, 'kiste-mais', 34, u - 12, 12, 12);
  }
  if (id === 'nachbarn') return schatten(k, 24, u, 34) + bild(k, 'bauer', 8, u - 17) + bild(k, 'baeuerin', 24, u - 17);
  if (id === 'wagen') {
    return '<g opacity="' + (z.unterwegs ? 0.45 : 1) + '">' + schatten(k, 32, u, 40) +
      bild(k, 'lkw', 16, u - 32, 32, 32) + '</g>';
  }
  if (id === 'abenteuer') {
    return schatten(k, 24, u, 30) +
      pix(k, z.wartet ? ABENTEUER : ABENTEUER_RUHIG, FARBEN, 4, u - 35, 2);
  }
  if (id === 'kiste') return schatten(k, 16, u, 30) + bild(k, 'truhe', 0, u - 32, 32, 32);
  if (id === 'schatz') return bild(k, 'truhe-blau', 0, u - 15);
  if (id === 'boot') {
    return schatten(k, 48, u - 1, 52) + pix(k, z.heil ? BOOT_HEIL : BOOT_KAPUTT, FARBEN, 24, u - 31, 3);
  }
  return '';
}

// ---- Angelsee --------------------------------------------------------------------

function artSeeRaum(art, k) {
  var u = k.ph - 1;
  if (art === 'haus') {
    // Drei Kachelreihen hoch — höher passt nicht mehr über den Sandstreifen.
    var out = '';
    var reihen = [['dach-4', 'dach-5', 'dach-6'], ['wand-1', 'wand-2', 'wand-3'], ['tor-1', 'tor-2', 'tor-3']];
    for (var r = 0; r < 3; r++) {
      for (var x = 0; x < 3; x++) out += bild(k, reihen[r][x], 16 + x * 16, u - 48 + r * 16);
    }
    return out;
  }
  if (art === 'dock') {
    var planken = '';
    for (var i = 0; i < 4; i++) {
      planken += '<rect x="' + ((8 + i * 16) * k.e) + '" y="' + ((u - 14) * k.e) + '" width="' + (16 * k.e + 0.05) +
        '" height="' + (10 * k.e) + '" fill="' + (i % 2 ? FARBEN.d : FARBEN.w) + '"/>';
    }
    return '<rect x="' + (7 * k.e) + '" y="' + ((u - 15) * k.e) + '" width="' + (66 * k.e) + '" height="' + (12 * k.e) + '" fill="' + FARBEN.o + '"/>' +
      planken + bild(k, 'zaun-pfosten', 4, u - 24, 10, 16) + bild(k, 'zaun-pfosten', 66, u - 24, 10, 16);
  }
  // Angelstelle: kleine Insel mit Tanne und Pose.
  // Insel mit Tanne, davor die Pose im Wasser.
  return pix(k, INSEL, FARBEN, 16, u - 8) + bild(k, 'baum-tanne', 30, u - 22) +
    '<g class="pose">' +
    pix(k, ['.rr.', 'rssr', 'rssr', '.rr.'], { r: FARBEN.r, s: FARBEN.s }, 6, u - 6, 1.4) +
    '</g>';
}

// ---- Boden -------------------------------------------------------------------------

// Wiese aus Graskacheln, dazu ein grobes Blumenmuster; oben der Weg. Kacheln
// sind quadratisch, die Zelle ist gestaucht, darum zeigt jede Zelle nur die
// oberen 62 Prozent ihrer Kachel. Gras vertraegt das, man sieht keine Naht.
function artBodenPixel(zeigeRaster) {
  if (!hatRaster()) return '';
  var g = raster();
  var zb = zellB(), zh = zellH();
  var bandOben = projiziere(0, -BAND).y;
  var ackerOben = projiziere(0, 0).y;
  function muster(id, name, breite, hoehe, inhalt) {
    return '<pattern id="' + id + '" patternUnits="userSpaceOnUse" x="0" y="' + ackerOben + '" width="' + breite + '" height="' + hoehe + '">' +
      (inhalt || '<image href="' + (SPRITES[name] || '') + '" width="' + zb + '" height="' + (zh / ZELL_HOEHE) + '" preserveAspectRatio="none"/>') +
      '</pattern>';
  }
  // Sparsam: je 9 x 7 Zellen eine Blumen- und zwei Tupfenkacheln, versetzt.
  var blumen = '';
  var orte = [[2, 1, 'gras-blumen'], [6, 4, 'gras-2'], [0, 5, 'gras-2']];
  for (var i = 0; i < orte.length; i++) {
    blumen += '<image href="' + (SPRITES[orte[i][2]] || '') + '" x="' + (orte[i][0] * zb) +
      '" y="' + (orte[i][1] * zh) + '" width="' + zb + '" height="' + (zh / ZELL_HOEHE) + '" preserveAspectRatio="none"/>';
  }
  var out = '<defs>' + muster('m-gras', 'gras-1', zb, zh) + muster('m-weg', 'weg', zb, zh) +
    muster('m-blumen', null, zb * 9, zh * 7, blumen) + '</defs>';
  out += '<rect x="0" y="' + bandOben + '" width="100" height="' + (ackerOben - bandOben) + '" fill="url(#m-weg)"/>';
  out += '<rect x="0" y="' + ackerOben + '" width="100" height="' + (100 - ackerOben) + '" fill="url(#m-gras)"/>';
  out += '<rect x="0" y="' + ackerOben + '" width="100" height="' + (100 - ackerOben) + '" fill="url(#m-blumen)"/>';

  if (zeigeRaster) {
    for (var gy = 0; gy <= g.h; gy++) {
      out += '<path d="M0 ' + projiziere(0, gy).y + 'H100" stroke="var(--raster)" stroke-width=".3"/>';
    }
    for (var gx = 0; gx <= g.w; gx++) {
      out += '<path d="M' + projiziere(gx, 0).x + ' ' + ackerOben + 'V100" stroke="var(--raster)" stroke-width=".3"/>';
    }
  }
  return out;
}

function artScene() {
  if (typeof seeAktiv !== 'undefined' && seeAktiv) return artSeeScene();
  if (!hatRaster()) return '<rect x="0" y="0" width="100" height="130" fill="var(--meadow)"/>';
  return '<rect x="0" y="0" width="100" height="100" fill="var(--meadow)"/>' + artBodenPixel(bauModus);
}

// Wasser als Pixelmuster, oben ein Sandstreifen. Wie beim Gras: die Kachel des
// Musters ist eine Zelle, gezeichnet wird in Pixeln dieser Zelle.
function artSeeScene() {
  var zb = zellB(), zh = zellH();
  var ufer = projiziere(0, 0).y;
  var e = zb / KACHEL;
  var k = { e: e };
  var wasser = [
    '................', '..BB............', '................', '.........BBB....',
    '................', '................', 'BB..............', '................',
    '.....BB.........', '................', '............BB..', '................',
  ];
  var welle = pix(k, wasser, { B: FARBEN.B }, 0, 0);
  // Das Wellenmuster wandert langsam quer — ein einziges Element für den
  // ganzen See, darum kostet die Bewegung praktisch nichts.
  var drift = '<animateTransform attributeName="patternTransform" type="translate" ' +
    'values="0 0;' + zb + ' ' + (zh * 0.35) + ';0 0" dur="14s" repeatCount="indefinite"/>';
  return '<defs><pattern id="m-wasser" patternUnits="userSpaceOnUse" x="0" y="' + ufer + '" width="' + zb + '" height="' + zh + '">' +
    '<rect width="' + zb + '" height="' + zh + '" fill="' + FARBEN.b + '"/>' + welle + drift + '</pattern></defs>' +
    '<rect x="0" y="0" width="100" height="100" fill="' + FARBEN.b + '"/>' +
    '<rect x="0" y="' + ufer + '" width="100" height="' + (100 - ufer) + '" fill="url(#m-wasser)"/>' +
    '<rect x="0" y="0" width="100" height="' + ufer + '" fill="' + FARBEN.g + '"/>' +
    '<rect x="0" y="' + (ufer - zh * 0.35) + '" width="100" height="' + (zh * 0.35) + '" fill="' + FARBEN.G + '"/>';
}

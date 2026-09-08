function artBaum() {
  return '<g><ellipse cx="50" cy="88" rx="26" ry="6" fill="var(--ink)" opacity=".18"/>' +
    '<rect x="44" y="52" width="12" height="36" rx="3" fill="var(--wood-dark)"/>' +
    '<circle cx="50" cy="42" r="30" fill="var(--leaf-dark)"/>' +
    '<circle cx="32" cy="50" r="20" fill="var(--leaf)"/>' +
    '<circle cx="68" cy="50" r="18" fill="var(--leaf)"/>' +
    '<circle cx="50" cy="28" r="18" fill="var(--leaf)"/></g>';
}

function artStein() {
  return '<g><ellipse cx="50" cy="86" rx="30" ry="7" fill="var(--ink)" opacity=".18"/>' +
    '<path d="M18 86c-4-16 4-30 16-36 12-6 28-4 36 6 8 10 10 22 6 30z" fill="#9aa1a6"/>' +
    '<path d="M50 50c8-4 18-2 24 6 6 8 8 18 4 30H50z" fill="#7e858a"/>' +
    '<path d="M30 60c4-6 10-8 14-6" stroke="#b7bec3" stroke-width="4" stroke-linecap="round" fill="none"/></g>';
}

function artTuempel() {
  return '<g><ellipse cx="50" cy="60" rx="44" ry="26" fill="#6f9a5e"/>' +
    '<ellipse cx="50" cy="58" rx="38" ry="21" fill="#4d86a8"/>' +
    '<ellipse cx="50" cy="55" rx="30" ry="15" fill="#63a3c4"/>' +
    '<path d="M28 50c8-4 16-4 24 0" stroke="#a7d3e6" stroke-width="3" stroke-linecap="round" fill="none" opacity=".8"/>' +
    '<ellipse cx="66" cy="63" rx="7" ry="4" fill="#4f8f4a"/>' +
    '<ellipse cx="36" cy="66" rx="5" ry="3" fill="#4f8f4a"/></g>';
}

function artScene() {
  if (typeof seeAktiv !== 'undefined' && seeAktiv) return artSeeScene();
  if (!hatRaster()) {
    return '<rect x="0" y="0" width="100" height="130" fill="var(--meadow)"/>' + artBoden(bauModus);
  }
  return '<rect x="0" y="0" width="100" height="100" fill="var(--meadow)"/>' + artBoden(bauModus);
}

// Der Wasser-Hintergrund der Angel-Dimension: Sandstrand-Streifen oben, Wasser
// darunter. Die Inseln sind jetzt die Angelstellen selbst (artSeeObj 'spot'),
// darum keine losen Deko-Inseln mehr — jede Insel lässt sich befischen.
function artSeeScene() {
  var ufer = projiziere(0, 0).y;
  var out = '<rect x="0" y="0" width="100" height="100" fill="#2b6f92"/>';
  out += '<rect x="0" y="0" width="100" height="' + ufer + '" fill="#e6d6a8"/>';
  out += '<rect x="0" y="' + ufer + '" width="100" height="2.2" fill="#dcc796"/>';
  for (var i = 1; i < 9; i++) {
    var y = ufer + ((100 - ufer) * i) / 9;
    out += '<path d="M0 ' + y + 'H100" stroke="#ffffff" stroke-width=".4" opacity=".15"/>';
  }
  return out;
}

// Objekte auf dem See-Raster (in 0..100/0..80 gezeichnet, wie die Plätze).
function artSeeObj(art) {
  if (art === 'haus') {
    return (
      '<rect x="8" y="70" width="84" height="8" rx="2" fill="#caa46a"/>' +
      '<rect x="20" y="34" width="60" height="34" rx="2" fill="#c58a52"/>' +
      '<path d="M14 36 50 10 86 36z" fill="#9c4f36"/>' +
      '<rect x="40" y="46" width="20" height="22" rx="1" fill="#6f4326"/>' +
      '<rect x="26" y="42" width="12" height="12" rx="1" fill="#7fc2dd"/>' +
      '<rect x="62" y="42" width="12" height="12" rx="1" fill="#7fc2dd"/>'
    );
  }
  if (art === 'dock') {
    return (
      '<rect x="6" y="30" width="60" height="10" rx="2" fill="#8a5a2b"/>' +
      '<rect x="14" y="40" width="5" height="26" fill="#6f4720"/>' +
      '<rect x="50" y="40" width="5" height="26" fill="#6f4720"/>' +
      '<path d="M60 44h30l-6 12H66z" fill="#c0692e"/>' +
      '<rect x="74" y="18" width="2" height="26" fill="#7a5230"/>' +
      '<path d="M76 20l14 8-14 5z" fill="#f2f2f2"/>'
    );
  }
  // Angelstelle = kleine Insel mit Angelloch. Sand + Gras + dunkles Wasserloch
  // mit Schwimmer und Ringen. So sitzt jeder Schwimmer sichtbar an einer Insel.
  return (
    '<ellipse cx="50" cy="52" rx="42" ry="24" fill="#1f5875" opacity=".35"/>' +
    '<ellipse cx="50" cy="46" rx="40" ry="24" fill="#e6d6a8"/>' +
    '<ellipse cx="50" cy="42" rx="30" ry="17" fill="#4f9a58"/>' +
    '<ellipse cx="62" cy="46" rx="13" ry="9" fill="#2b6f92"/>' +
    '<ellipse cx="62" cy="46" rx="9" ry="6" fill="none" stroke="#ffffff" stroke-width="1.6" opacity=".5"/>' +
    '<ellipse cx="62" cy="46" rx="4.5" ry="3" fill="none" stroke="#ffffff" stroke-width="1.6" opacity=".6"/>' +
    '<circle cx="62" cy="46" r="3.4" fill="#e5473b"/>' +
    '<rect x="60.7" y="39" width="2.6" height="7" fill="#ffffff"/>'
  );
}

// Das Boot am Hof — der Zugang zur Angel-Dimension. Steht immer da: kaputt (grau,
// Loch im Rumpf, kein Segel) bis man es repariert, danach heil mit Segel auf
// einem kleinen Wassersteg.
function artHofBoot(repariert) {
  var wasser = repariert ? '#3f86ab' : '#5a6b74';
  var out =
    '<ellipse cx="50" cy="50" rx="46" ry="15" fill="' + wasser + '"/>' +
    '<ellipse cx="50" cy="50" rx="46" ry="15" fill="none" stroke="#ffffff" stroke-width=".8" opacity=".18"/>' +
    // Steg
    '<rect x="4" y="20" width="30" height="7" rx="1.5" fill="#8a5a2b"/>' +
    '<rect x="10" y="27" width="4" height="20" fill="#6f4720"/>' +
    '<rect x="26" y="27" width="4" height="20" fill="#6f4720"/>';
  if (repariert) {
    out +=
      '<path d="M30 40h46l-8 16H38z" fill="#c0692e"/>' +
      '<path d="M30 40h46l-2 4H32z" fill="#a9551f"/>' +
      '<rect x="51" y="10" width="2.5" height="30" fill="#7a5230"/>' +
      '<path d="M54 12l18 9-18 6z" fill="#f2f2f2"/>';
  } else {
    // Kaputt: schief liegender, grauer Rumpf mit Loch und losem Brett.
    out +=
      '<path d="M30 42h46l-8 15H38z" fill="#8f7a62"/>' +
      '<path d="M52 44l7 12h-11z" fill="' + wasser + '"/>' + // Loch im Rumpf
      '<path d="M34 46h16" stroke="#5f4d38" stroke-width="1.6" stroke-linecap="round"/>' +
      '<rect x="60" y="34" width="20" height="3.4" rx="1" fill="#8f7a62" transform="rotate(-18 70 36)"/>';
    // Den Hinweis „reparieren" gibt die Werkzeug-Blase über dem Boot (anzeige.js).
  }
  return out;
}

function artTruck(unterwegs, voll) {
  var ladung = voll
    ? '<rect x="12" y="2" width="44" height="6" rx="2" fill="var(--corn)"/>'
    : '';

  return '<ellipse cx="50" cy="36" rx="46" ry="3.5" fill="var(--ink)" opacity=".18"/>' +
    ladung +
    '<rect x="6" y="7" width="52" height="22" rx="3" fill="var(--truck)"/>' +
    '<rect x="6" y="15" width="52" height="3" fill="var(--ink)" opacity=".1"/>' +
    '<path d="M58 29V12h13l10 9v8z" fill="var(--truck-cab)"/>' +
    '<rect x="63" y="14" width="10" height="7" rx="1.5" fill="var(--sky)" opacity=".9"/>' +
    '<circle cx="22" cy="30" r="6" fill="var(--ink)"/>' +
    '<circle cx="22" cy="30" r="2.6" fill="var(--muted)"/>' +
    '<circle cx="72" cy="30" r="6" fill="var(--ink)"/>' +
    '<circle cx="72" cy="30" r="2.6" fill="var(--muted)"/>' +
    (unterwegs
      ? '<g opacity=".5"><circle cx="2" cy="24" r="4" fill="var(--surface)">' +
        '<animate attributeName="r" values="1.5;6" dur="1.6s" repeatCount="indefinite"/>' +
        '<animate attributeName="opacity" values=".6;0" dur="1.6s" repeatCount="indefinite"/>' +
        '</circle></g>'
      : '');
}

function artBrett(zettel) {
  var out = '<rect x="16" y="52" width="6" height="24" fill="var(--wood-dark)"/>' +
    '<rect x="78" y="52" width="6" height="24" fill="var(--wood-dark)"/>' +
    '<rect x="8" y="10" width="84" height="46" rx="4" fill="var(--wood)"/>' +
    '<rect x="12" y="14" width="76" height="38" rx="3" fill="var(--wood-dark)" opacity=".35"/>';

  var stellen = [[17, 16], [53, 16], [17, 35], [53, 35]];
  for (var i = 0; i < Math.min(zettel, 4); i++) {
    out += '<rect x="' + stellen[i][0] + '" y="' + stellen[i][1] +
      '" width="30" height="15" rx="1.5" fill="var(--surface)"/>' +
      '<path d="M' + (stellen[i][0] + 4) + ' ' + (stellen[i][1] + 5) + 'h20M' +
      (stellen[i][0] + 4) + ' ' + (stellen[i][1] + 10) + 'h13" ' +
      'stroke="var(--muted)" stroke-width="1.6" stroke-linecap="round"/>';
  }
  return out;
}

function artLager(voll) {
  return '<ellipse cx="50" cy="72" rx="42" ry="6" fill="var(--ink)" opacity=".18"/>' +
    '<path d="M14 72V34h72v38z" fill="var(--roof)"/>' +
    '<path d="M50 12 6 38h88z" fill="var(--wood-dark)"/>' +
    '<rect x="38" y="46" width="24" height="26" rx="2" fill="var(--wood)"/>' +
    '<path d="M50 46v26" stroke="var(--wood-dark)" stroke-width="2"/>' +
    '<rect x="44" y="24" width="12" height="10" rx="2" fill="var(--sky)" opacity=".8"/>' +
    (voll
      ? '<circle cx="80" cy="26" r="8" fill="var(--warn)"/>' +
        '<path d="M80 21v6M80 30v1.5" stroke="var(--surface)" stroke-width="2.4" stroke-linecap="round"/>'
      : '');
}

function artStand() {
  return '<ellipse cx="50" cy="72" rx="40" ry="6" fill="var(--ink)" opacity=".18"/>' +
    '<rect x="18" y="40" width="64" height="8" fill="var(--wood-dark)"/>' +
    '<rect x="22" y="48" width="56" height="24" rx="2" fill="var(--wood)"/>' +
    '<path d="M10 40h80l-8-18H18z" fill="var(--truck-cab)"/>' +
    '<path d="M18 22h14l-4 18H10zM46 22h14l-2 18H44zM74 22h8l6 18H72z" fill="var(--surface)" opacity=".55"/>' +
    '<circle cx="36" cy="58" r="5" fill="var(--ripe)"/>' +
    '<circle cx="50" cy="58" r="5" fill="var(--leaf)"/>' +
    '<circle cx="64" cy="58" r="5" fill="var(--corn)"/>';
}

function artNachbarn() {
  return '<ellipse cx="50" cy="72" rx="40" ry="6" fill="var(--ink)" opacity=".18"/>' +
    '<path d="M14 66V46h26v20z" fill="var(--wood)"/>' +
    '<path d="M27 34 8 48h38z" fill="var(--wood-dark)"/>' +
    '<path d="M52 66V50h30v16z" fill="var(--wood)"/>' +
    '<path d="M67 38 46 52h42z" fill="var(--wood-dark)"/>' +
    '<rect x="23" y="54" width="8" height="12" fill="var(--soil-dark)" opacity=".5"/>' +
    '<rect x="63" y="56" width="8" height="10" fill="var(--soil-dark)" opacity=".5"/>';
}

function artKiste() {
  return '<ellipse cx="50" cy="74" rx="34" ry="5" fill="var(--ink)" opacity=".2"/>' +
    '<rect x="16" y="34" width="68" height="38" rx="4" fill="var(--wood)"/>' +
    '<path d="M16 40a34 14 0 0168 0z" fill="var(--wood-dark)"/>' +
    '<rect x="16" y="38" width="68" height="6" fill="var(--wood-dark)"/>' +
    '<rect x="42" y="30" width="16" height="20" rx="2" fill="var(--gold)"/>' +
    '<circle cx="50" cy="42" r="3.5" fill="var(--soil-dark)"/>' +
    '<path d="M24 48v18M76 48v18" stroke="var(--wood-dark)" stroke-width="3"/>' +
    '<g opacity=".9">' +
    '<path d="M50 18l2.5 6 6 2.5-6 2.5L50 35l-2.5-6-6-2.5 6-2.5z" fill="var(--ripe)"/>' +
    '</g>';
}

function artField(stage, crop) {
  var soil = '<rect x="2" y="6" width="96" height="70" rx="7" fill="var(--soil)"/>' +
    '<path d="M6 16h88v4H6zM6 30h88v3H6zM6 44h88v3H6zM6 58h88v3H6z" fill="var(--soil-dark)" opacity=".4"/>';
  if (stage <= 0) return soil;

  var out = soil, x, i;
  var isCorn = crop === 'corn';

  var count = isCorn ? 4 : 5;
  var gap = isCorn ? 22 : 18;
  var left = isCorn ? 18 : 14;

  for (i = 0; i < count; i++) {
    x = left + i * gap;
    if (stage === 1) {
      out += '<path d="M' + x + ' 62v-7" stroke="var(--leaf)" stroke-width="2.5" stroke-linecap="round"/>' +
        '<path d="M' + x + ' 57c-3-2-4-5-4-5s4 0 4 3" fill="var(--leaf)"/>';
    } else if (stage === 2) {
      out += isCorn
        ? '<path d="M' + x + ' 66V38" stroke="var(--corn-leaf)" stroke-width="3" stroke-linecap="round"/>' +
          '<path d="M' + x + ' 50c-7-3-8-9-8-9s8 1 8 6zM' + x + ' 43c7-3 8-9 8-9s-8 1-8 6z" fill="var(--corn-leaf)"/>'
        : '<path d="M' + x + ' 66V42" stroke="var(--leaf)" stroke-width="2.5" stroke-linecap="round"/>' +
          '<path d="M' + x + ' 52c-5-2-6-7-6-7s6 1 6 5zM' + x + ' 46c5-2 6-7 6-7s-6 1-6 5z" fill="var(--leaf-dark)"/>';
    } else if (isCorn) {
      out += '<path d="M' + x + ' 70V26" stroke="var(--corn-leaf)" stroke-width="3" stroke-linecap="round"/>' +
        '<path d="M' + x + ' 44c-9-3-10-10-10-10s10 1 10 7zM' + x + ' 36c9-3 10-10 10-10s-10 1-10 7z" fill="var(--corn-leaf)"/>' +
        '<ellipse cx="' + (x + 5) + '" cy="48" rx="4" ry="8" fill="var(--corn)"/>' +
        '<path d="M' + (x + 5) + ' 41v14" stroke="var(--soil-dark)" stroke-width="1" opacity=".35"/>' +
        '<path d="M' + x + ' 26l-3-6M' + x + ' 26l3-6" stroke="var(--ripe)" stroke-width="1.6" stroke-linecap="round"/>';
    } else {
      out += '<path d="M' + x + ' 68V44" stroke="var(--leaf-dark)" stroke-width="2.5" stroke-linecap="round"/>' +
        '<ellipse cx="' + x + '" cy="36" rx="5" ry="10" fill="var(--ripe)"/>' +
        '<path d="M' + x + ' 27v18" stroke="var(--soil-dark)" stroke-width="1.2" opacity=".5"/>';
    }
  }
  return out;
}

function cow(x, y, scale) {
  return '<g transform="translate(' + x + ' ' + y + ') scale(' + scale + ')">' +
    '<ellipse cx="0" cy="0" rx="18" ry="11" fill="var(--hide)"/>' +
    '<ellipse cx="-7" cy="-3" rx="6" ry="4" fill="var(--hide-spot)" opacity=".8"/>' +
    '<ellipse cx="8" cy="3" rx="4.5" ry="3" fill="var(--hide-spot)" opacity=".8"/>' +
    '<path d="M-14 9v6M-5 10v5M5 10v5M14 9v6" stroke="var(--hide-spot)" stroke-width="2.5" stroke-linecap="round"/>' +
    '<circle cx="19" cy="-7" r="7" fill="var(--hide)"/>' +
    '<path d="M13 -12c-3-3-2-6-2-6s4 1 5 4z" fill="var(--hide-spot)"/>' +
    '<circle cx="21" cy="-9" r="1" fill="var(--ink)"/>' +
    '<ellipse cx="24" cy="-4" rx="3.5" ry="2.5" fill="var(--corn)" opacity=".55"/>' +
    '</g>';
}

function artPasture(animals, ready) {
  var out = '<rect x="2" y="40" width="96" height="34" rx="6" fill="var(--leaf)" opacity=".35"/>' +
    '<path d="M6 44v22M28 44v22M72 44v22M94 44v22" stroke="var(--wood)" stroke-width="3" stroke-linecap="round"/>' +
    '<path d="M2 50h96M2 60h96" stroke="var(--wood)" stroke-width="2.5" stroke-linecap="round"/>';

  if (animals === 1) out += cow(50, 58, 1);
  if (animals === 2) out += cow(30, 54, .7) + cow(62, 64, .7);
  if (animals >= 3) out += cow(24, 52, .58) + cow(56, 60, .58) + cow(34, 70, .58);

  if (ready) {
    out += '<g transform="translate(20 66)">' +
      '<path d="M-6 -7h12l-2 9h-8z" fill="var(--milk)" stroke="var(--soil-dark)" stroke-width="1"/>' +
      '<path d="M-6 -7h12" stroke="var(--soil-dark)" stroke-width="1.4"/>' +
      '</g>';
  }
  return out;
}

function artDairy(working) {
  var steam = working
    ? '<g opacity=".7"><circle cx="70" cy="26" r="3" fill="var(--milk)">' +
      '<animate attributeName="cy" values="26;14" dur="2.4s" repeatCount="indefinite"/>' +
      '<animate attributeName="opacity" values=".7;0" dur="2.4s" repeatCount="indefinite"/>' +
      '</circle></g>'
    : '';
  return '<ellipse cx="48" cy="66" rx="42" ry="8" fill="var(--soil)" opacity=".25"/>' +
    '<path d="M22 62V38h50v24z" fill="var(--milk)"/>' +
    '<path d="M47 26 16 40h62z" fill="var(--wood-dark)"/>' +
    '<rect x="64" y="30" width="8" height="12" fill="var(--wood)"/>' +
    steam +
    '<rect x="30" y="48" width="12" height="14" rx="1" fill="var(--soil-dark)" opacity=".5"/>' +

    '<g transform="translate(84 56)">' +
    '<path d="M-6 6h12l-1-12h-10z" fill="var(--feather-2)" stroke="var(--soil-dark)" stroke-width="1"/>' +
    '<rect x="-3" y="-9" width="6" height="4" rx="1" fill="var(--soil-dark)" opacity=".7"/>' +
    '</g>';
}

function artMill(working) {
  var spin = working
    ? '<animateTransform attributeName="transform" type="rotate" from="0" to="360"' +
      ' dur="7s" repeatCount="indefinite"/>'
    : '';
  return '<ellipse cx="50" cy="66" rx="40" ry="8" fill="var(--soil)" opacity=".25"/>' +
    '<path d="M36 62V36h28v26z" fill="var(--wood)"/>' +
    '<path d="M50 24 32 38h36z" fill="var(--wood-dark)"/>' +
    '<rect x="45" y="50" width="10" height="12" rx="1" fill="var(--soil-dark)" opacity=".55"/>' +
    '<g transform="translate(50 40)"><g>' + spin +
    '<path d="M0-20V20M-20 0H20" stroke="var(--wood-dark)" stroke-width="3" stroke-linecap="round"/>' +
    '<circle r="3" fill="var(--wood-dark)"/>' +
    '</g></g>';
}

function chicken(x, y, flip, tone) {
  return '<g transform="translate(' + x + ' ' + y + ')' + (flip ? ' scale(-1 1)' : '') + '">' +
    '<ellipse cx="0" cy="0" rx="7" ry="5.5" fill="var(' + tone + ')"/>' +
    '<circle cx="5" cy="-5" r="3.6" fill="var(' + tone + ')"/>' +
    '<path d="M8 -5l3 1-3 1z" fill="var(--ripe)"/>' +
    '<circle cx="6" cy="-6" r=".8" fill="var(--ink)"/>' +
    '<path d="M4-8c1-2 3-1 2 1" fill="var(--bad)"/>' +
    '</g>';
}

function artCoop(animals, ready) {
  var out = '<ellipse cx="50" cy="68" rx="46" ry="9" fill="var(--soil)" opacity=".25"/>' +
    '<path d="M28 62V40h44v22z" fill="var(--wood)"/>' +
    '<path d="M50 28 22 42h56z" fill="var(--wood-dark)"/>' +
    '<rect x="44" y="50" width="12" height="12" rx="1" fill="var(--soil-dark)" opacity=".55"/>';

  if (animals >= 1) out += chicken(16, 56, false, '--feather');
  if (animals >= 2) out += chicken(84, 58, true, '--feather-2');
  if (animals >= 3) out += chicken(64, 70, true, '--feather');

  if (ready) {
    out += '<g transform="translate(50 70)">' +
      '<ellipse cx="-8" cy="0" rx="4" ry="5" fill="var(--egg)"/>' +
      '<ellipse cx="0" cy="1" rx="4" ry="5" fill="var(--egg)"/>' +
      '<ellipse cx="8" cy="0" rx="4" ry="5" fill="var(--egg)"/>' +
      '</g>';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Schraegsicht: Objekte mit Koerper
//
// Wer hier eingetragen ist, wird raeumlich gezeichnet. Der Wert sagt, um wie
// viele Zellen das Objekt ueber seinen Standplatz hinaus in die Luft ragt.
// Die Kunst bekommt dazu k.boden (Oberkante des Standplatzes) und k.vh
// (Unterkante) und baut von der Bodenlinie aus nach oben auf. Objekte ohne
// Eintrag bleiben vorerst flach — das hier ist das Muster, nicht der ganze Hof.
// ---------------------------------------------------------------------------
// Probe: Pixelgrafik
//
// Umschaltbar in den Einstellungen. Statt der im Code gezeichneten Formen
// werden fertige Pixelkacheln gemalt (Kenney „Tiny Farm", CC0, siehe
// web/farm/sprites/LIZENZ.txt). Nur Acker, Huehnerstall, Baum und Stein sind
// umgestellt — genug, um den Stil zu vergleichen.
var pixelAn = (function () {
  try { return localStorage.getItem('ns-pixel') === 'an'; } catch (e) { return false; }
})();

function pixelSetzen(an) {
  pixelAn = !!an;
  try { localStorage.setItem('ns-pixel', pixelAn ? 'an' : 'aus'); } catch (e) {}
  hindernisStand = null; // Hindernisse neu malen, die sind sonst gemerkt
  if (typeof render === 'function') render();
}

// Pixelobjekte brauchen andere Hoehen als die Vektorzeichnungen.
var KOERPER_PIXEL = { 'field-': 0.35, 'coop-': 2.0 };

function sprite(name, x, y, w, h) {
  var q = typeof SPRITES === 'object' && SPRITES[name];
  if (!q) return '';
  return '<image href="' + q + '" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h +
    '" preserveAspectRatio="none"/>';
}

// Zwei lange Beete uebereinander, je eine Zellreihe, aus Endstueck, zwei
// Mittelstuecken und Endstueck. Darauf die Pflanzen in zwei Reihen zu je vier.
function artFeldPixel(k, stage, crop) {
  var o = k.boden;
  var out = '';
  var reihen = [o + 1, o + 32];
  var teile = ['acker-l', 'acker-m1', 'acker-m2', 'acker-r'];
  var i, r;
  for (r = 0; r < 2; r++) {
    for (i = 0; i < 4; i++) out += sprite(teile[i], i * 25, reihen[r], 25.4, 29);
  }
  if (stage <= 0) return out;
  var art = crop === 'corn' ? 'mais' : crop === 'wheat' ? 'weizen' : 'moehre';
  var bild = art + '-' + Math.min(3, Math.max(1, stage));
  for (r = 0; r < 2; r++) {
    for (i = 0; i < 4; i++) {
      out += sprite(bild, 3 + i * 24.5, reihen[r] - 1, 22, 22);
    }
  }
  return out;
}

// Scheune aus dem Bausatz: zwei Dachreihen, Wand mit Fenstern, Torreihe.
// Drei Kacheln breit, auf die Kastenbreite gestreckt.
function artStallPixel(k, animals) {
  var zeilen = [['dach-1', 'dach-2', 'dach-3'], ['dach-4', 'dach-5', 'dach-6'],
    ['wand-1', 'wand-2', 'wand-3'], ['tor-1', 'tor-2', 'tor-3']];
  var b = 100 / 3, h = 28;
  var oben = k.vh - 3 - zeilen.length * h;
  var out = '<ellipse cx="50" cy="' + (k.vh - 4) + '" rx="46" ry="6" fill="var(--ink)" opacity=".18"/>';
  for (var z = 0; z < zeilen.length; z++) {
    for (var x = 0; x < 3; x++) out += sprite(zeilen[z][x], x * b, oben + z * h, b + 0.4, h + 0.4);
  }
  var plaetze = [[4, -14], [72, -10], [40, -6]];
  for (var t = 0; t < Math.min(3, animals); t++) {
    out += sprite('huhn', plaetze[t][0], k.vh + plaetze[t][1] - 22, 24, 24);
  }
  return out;
}

function artBaumPixel(k) {
  return '<ellipse cx="50" cy="' + (k.vh - 8) + '" rx="30" ry="9" fill="var(--ink)" opacity=".2"/>' +
    sprite('baum', 0, k.vh - 108, 100, 100);
}

function artSteinPixel(k) {
  return '<ellipse cx="50" cy="' + (k.vh - 10) + '" rx="28" ry="8" fill="var(--ink)" opacity=".2"/>' +
    sprite('stein', 14, k.vh - 80, 72, 72);
}

// Von Hand raeumlich neu gezeichnet, mit eigener Zeichenflaeche. Der Wert ist
// die Hoehe in Zellen, um die das Objekt ueber seinen Standplatz hinausragt.
var KOERPER = { 'field-': 0.3, 'coop-': 1.4 };
var KOERPER_HINDERNIS = { tree: 1.6, rock: 0.6, pond: 0 };

function handHoehe(id) {
  var tabelle = pixelAn ? KOERPER_PIXEL : KOERPER;
  if (tabelle[id] !== undefined) return tabelle[id];
  for (var p1 in tabelle) {
    if (id.indexOf(p1) === 0) return tabelle[p1];
  }
  return null;
}

// Alles andere behaelt vorerst seine alte, flache Zeichnung. Sie wird aber
// nicht in die gestauchte Zelle gequetscht, sondern AUFGESTELLT: Der Kasten
// waechst so weit nach oben, dass das Objekt wieder genau so hoch aussieht wie
// vor der Neigung. Es steht dann wieder, statt zu liegen.
function stehHoehe(zellenH) {
  return (zellenH * (1 - ZELL_HOEHE)) / ZELL_HOEHE;
}

// Wie ein Objekt gezeichnet wird. `flach` ist die Hoehe seiner bisherigen
// Zeichenflaeche, die bei aufgestellten Objekten unveraendert weiterlebt.
function koerperFuer(id, zellenB, zellenH, flach) {
  var hand = handHoehe(id);
  if (hand === null) return { hoch: stehHoehe(zellenH), vh: flach, boden: 0, eigen: false };
  var m = koerperMasse(zellenB, zellenH, hand);
  return { hoch: hand, vh: m.vh, boden: m.boden, eigen: true };
}

// Dort beruehrt das Objekt die Erde: die Mitte seines Standplatzes.
function bodenLinie(k) { return (k.boden + k.vh) / 2; }

function artRaumFor(p, k) {
  var feld = p.id.indexOf('field-') === 0;
  var stufe = feld ? (!p.busy && !p.done ? 0 : p.done ? 3 : p.progress < 0.4 ? 1 : 2) : 0;
  if (feld) return pixelAn ? artFeldPixel(k, stufe, p.producing) : artFeldRaum(k, stufe, p.producing);
  if (p.id.indexOf('coop-') === 0) {
    var tiere = p.stall ? p.stall.animals : p.capacity;
    return pixelAn ? artStallPixel(k, tiere) : artStallRaum(k, tiere, p.done);
  }
  return artFor(p);
}

function artHindernisRaum(kind, k) {
  if (kind === 'tree') return pixelAn ? artBaumPixel(k) : artBaumRaum(k);
  if (kind === 'rock') return pixelAn ? artSteinPixel(k) : artSteinRaum(k);
  return artTeichRaum(k);
}

// Beet mit sichtbarer Erddicke: dunkle Platte, hellere Oberflaeche knapp
// darueber. Die Pflanzen stehen in drei Reihen, hintere zuerst gemalt.
function artFeldRaum(k, stage, crop) {
  var o = k.boden, u = k.vh;
  var lippe = (u - o) * 0.13;
  var flaeche = u - o - lippe;
  var reihen = 6;
  var band = flaeche / reihen;
  // Aussen die dunkle Erdkante, innen etwas eingerueckt die offene Krume. So
  // hat das Beet an allen vier Seiten einen Rand und sitzt im Gras statt darauf.
  var out =
    '<rect x="2" y="' + (o + lippe) + '" width="96" height="' + flaeche + '" rx="6" fill="var(--soil-dark)"/>' +
    '<rect x="2" y="' + (o + lippe * 0.45) + '" width="96" height="' + flaeche + '" rx="6" fill="#4b6b3c"/>' +
    '<rect x="6" y="' + o + '" width="88" height="' + flaeche + '" rx="4" fill="var(--soil)"/>';

  // Die Furchen laufen VOM Betrachter WEG, also senkrecht ueber das Beet.
  // Quer laufende Baender lassen den Acker wie ein Holzbrett aussehen.
  var spalten = 5;
  var r, x;
  for (r = 0; r < spalten; r++) {
    x = 6 + (88 * (r + 0.5)) / spalten;
    out += '<rect x="' + (x - 1.7) + '" y="' + (o + 2) + '" width="3.4" height="' + (flaeche - 4) +
      '" rx="1.7" fill="var(--soil-dark)" opacity=".5"/>';
  }
  out += '<rect x="6" y="' + o + '" width="88" height="' + (band * 0.4) +
    '" rx="4" fill="#fff" opacity=".1"/>';
  if (stage <= 0) return out;

  var reif = stage === 3;
  var hoch = stage === 1 ? 4 : stage === 2 ? 9 : 14;
  var frucht = crop === 'corn' ? 'var(--corn)' : 'var(--ripe)';
  for (r = 0; r < 3; r++) {
    var basis = o + band * (1.5 + r * 1.8);
    for (var i = 0; i < spalten; i++) {
      x = 6 + (88 * (i + 0.5)) / spalten;
      out += '<path d="M' + x + ' ' + basis + 'v-' + hoch +
        '" stroke="var(--leaf-dark)" stroke-width="2.2" stroke-linecap="round"/>';
      if (stage >= 2) {
        out += '<circle cx="' + x + '" cy="' + (basis - hoch) + '" r="' + (reif ? 3.6 : 2.3) +
          '" fill="' + (reif ? frucht : 'var(--leaf)') + '"/>';
      }
    }
  }
  return out;
}

function artBaumRaum(k) {
  var g = bodenLinie(k);
  return '<ellipse cx="50" cy="' + (g + 5) + '" rx="29" ry="10" fill="var(--ink)" opacity=".2"/>' +
    '<path d="M45 ' + (g + 4) + 'c-1-17 0-33 2-45h6c2 12 3 28 2 45z" fill="var(--wood-dark)"/>' +
    '<circle cx="50" cy="' + (g - 72) + '" r="35" fill="var(--leaf-dark)"/>' +
    '<circle cx="34" cy="' + (g - 62) + '" r="23" fill="var(--leaf)"/>' +
    '<circle cx="67" cy="' + (g - 66) + '" r="20" fill="var(--leaf)"/>' +
    '<circle cx="52" cy="' + (g - 93) + '" r="21" fill="var(--leaf)"/>' +
    '<circle cx="38" cy="' + (g - 86) + '" r="14" fill="var(--leaf)" opacity=".85"/>';
}

function artSteinRaum(k) {
  var g = bodenLinie(k);
  return '<ellipse cx="50" cy="' + (g + 4) + '" rx="27" ry="9" fill="var(--ink)" opacity=".2"/>' +
    '<path d="M23 ' + (g + 4) + 'c-3-14 2-25 12-30 10-5 21-3 27 6 6 8 7 17 4 24z" fill="#9aa1a6"/>' +
    '<path d="M50 ' + (g - 26) + 'c7-3 14-1 19 5 5 6 6 14 4 25H50z" fill="#7e858a"/>' +
    '<path d="M33 ' + (g - 14) + 'c3-6 8-8 12-6" stroke="#b7bec3" stroke-width="3.4" stroke-linecap="round" fill="none"/>';
}

// Wasser liegt flach in der Ebene: Ein Kreis auf dem Boden erscheint in der
// geneigten Sicht als Ellipse, darum wird jeder Radius mit ZELL_HOEHE gestaucht.
function artTeichRaum(k) {
  var g = bodenLinie(k);
  function ring(r, farbe, dy) {
    return '<ellipse cx="50" cy="' + (g + dy) + '" rx="' + r + '" ry="' + (r * ZELL_HOEHE) +
      '" fill="' + farbe + '"/>';
  }
  return ring(45, '#6f9a5e', 0) + ring(38, '#4d86a8', 1) + ring(30, '#63a3c4', 1) +
    '<path d="M32 ' + (g - 2) + 'c8-4 16-4 24 0" stroke="#a7d3e6" stroke-width="2.6" ' +
    'stroke-linecap="round" fill="none" opacity=".8"/>';
}

// Kleiner Stall in Dreiviertelsicht: Front, dunklere Seitenwand nach rechts,
// Satteldach mit sichtbarer zweiter Dachflaeche.
function artStallRaum(k, animals, ready) {
  var g = bodenLinie(k);
  var out =
    '<ellipse cx="50" cy="' + (g + 18) + '" rx="44" ry="11" fill="var(--ink)" opacity=".18"/>' +
    '<path d="M70 ' + (g + 19) + 'L90 ' + (g + 9) + 'V' + (g - 21) + 'L70 ' + (g - 11) + 'z" fill="var(--wood-dark)"/>' +
    '<rect x="12" y="' + (g - 12) + '" width="58" height="31" fill="var(--wood)"/>' +
    '<path d="M12 ' + (g + 19) + 'h58v3H12z" fill="var(--wood-dark)" opacity=".5"/>' +
    '<path d="M41 ' + (g - 37) + 'L60 ' + (g - 47) + 'L94 ' + (g - 20) + 'L74 ' + (g - 10) + 'z" fill="var(--roof)" opacity=".72"/>' +
    '<path d="M6 ' + (g - 10) + 'L41 ' + (g - 37) + 'L76 ' + (g - 10) + 'z" fill="var(--roof)"/>' +
    '<rect x="31" y="' + (g - 1) + '" width="18" height="20" rx="2" fill="var(--soil-dark)" opacity=".62"/>' +
    '<rect x="54" y="' + (g - 6) + '" width="11" height="10" rx="1.5" fill="var(--corn)" opacity=".75"/>';

  if (animals >= 1) out += chicken(18, g + 13, false, '--feather');
  if (animals >= 2) out += chicken(84, g + 8, true, '--feather-2');
  if (animals >= 3) out += chicken(64, g + 17, true, '--feather');
  if (ready) {
    out += '<g transform="translate(50 ' + (g + 15) + ')">' +
      '<ellipse cx="-7" cy="0" rx="3.6" ry="4.6" fill="var(--egg)"/>' +
      '<ellipse cx="0" cy="1" rx="3.6" ry="4.6" fill="var(--egg)"/>' +
      '<ellipse cx="7" cy="0" rx="3.6" ry="4.6" fill="var(--egg)"/></g>';
  }
  return out;
}

var ART = {
  'field-': function (p) {
    if (!p.busy && !p.done) return artField(0, null);
    return artField(p.done ? 3 : p.progress < .4 ? 1 : 2, p.producing);
  },
  'mill': function (p) { return artMill(p.busy); },
  'coop-': function (p) { return artCoop(p.stall ? p.stall.animals : p.capacity, p.done); },
  'pasture-': function (p) { return artPasture(p.stall ? p.stall.animals : p.capacity, p.done); },
  'dairy': function (p) { return artDairy(p.busy); },
  'mine': function (p) { return artMine(p.busy); },
  'forge': function (p) { return artForge(p.busy); },
  'apple-tree': function (p) { return artAppleTree(p.baum ? p.baum.stufe : 'wachsen'); },
  'oven': function (p) { return artOven(p.busy); },
  'grill': function (p) { return artGrill(p.busy); },
  'deco-fence': function () { return artFence(); },
  'deco-flowers': function () { return artFlowers(); },
  'deco-bench': function () { return artBench(); },
  fallback: function () { return artField(0, null); },
};

function artFence() {
  return '<ellipse cx="50" cy="66" rx="40" ry="6" fill="var(--soil)" opacity=".2"/>' +
    '<g fill="#b98a4e" stroke="#8a6535" stroke-width="1.5">' +
    '<rect x="18" y="30" width="8" height="34" rx="1"/><rect x="46" y="30" width="8" height="34" rx="1"/>' +
    '<rect x="74" y="30" width="8" height="34" rx="1"/></g>' +
    '<g fill="#c99a5e" stroke="#8a6535" stroke-width="1.2">' +
    '<rect x="12" y="38" width="76" height="6" rx="2"/><rect x="12" y="52" width="76" height="6" rx="2"/></g>';
}

function artFlowers() {
  return '<ellipse cx="50" cy="66" rx="34" ry="6" fill="var(--soil)" opacity=".2"/>' +
    '<path d="M20 64h60l-4-14H24z" fill="#6b4a2b"/>' +
    '<g stroke="#4f8f4a" stroke-width="2">' +
    '<line x1="34" y1="52" x2="34" y2="40"/><line x1="50" y1="52" x2="50" y2="34"/><line x1="66" y1="52" x2="66" y2="42"/></g>' +
    '<circle cx="34" cy="38" r="6" fill="#e05a7a"/><circle cx="34" cy="38" r="2.4" fill="#ffe08a"/>' +
    '<circle cx="50" cy="32" r="7" fill="#f0a63c"/><circle cx="50" cy="32" r="2.8" fill="#fff2c8"/>' +
    '<circle cx="66" cy="40" r="6" fill="#8a6cd8"/><circle cx="66" cy="40" r="2.4" fill="#ffe08a"/>';
}

function artBench() {
  return '<ellipse cx="50" cy="66" rx="36" ry="6" fill="var(--soil)" opacity=".2"/>' +
    '<g fill="#9a6b3d" stroke="#6e4a29" stroke-width="1.4">' +
    '<rect x="22" y="44" width="56" height="8" rx="2"/><rect x="22" y="30" width="56" height="7" rx="2"/>' +
    '<rect x="26" y="52" width="6" height="12"/><rect x="68" y="52" width="6" height="12"/>' +
    '<rect x="26" y="30" width="5" height="22"/><rect x="69" y="30" width="5" height="22"/></g>';
}

function artOven(working) {
  var glut = working
    ? '<rect x="40" y="46" width="20" height="10" rx="2" fill="var(--ripe)">' +
      '<animate attributeName="opacity" values="1;.55;1" dur=".8s" repeatCount="indefinite"/></rect>'
    : '<rect x="40" y="46" width="20" height="10" rx="2" fill="#2a2118"/>';
  var rauch = working
    ? '<circle cx="70" cy="24" r="3" fill="#cfd3d6" opacity=".7"><animate attributeName="cy" values="24;16;24" dur="2s" repeatCount="indefinite"/></circle>'
    : '';
  return '<ellipse cx="50" cy="70" rx="42" ry="8" fill="var(--soil)" opacity=".25"/>' +
    '<path d="M22 66V38a28 20 0 0 1 56 0v28z" fill="#8a6a44"/>' +
    '<path d="M22 40h56v-3a28 20 0 0 0-56 0z" fill="#6f5335"/>' +
    '<rect x="34" y="42" width="32" height="18" rx="4" fill="#3a2c1d"/>' + glut +
    '<rect x="66" y="20" width="8" height="20" rx="2" fill="#5b4632"/>' + rauch +
    '<rect x="26" y="60" width="48" height="6" rx="2" fill="#6f5335"/>';
}

function artGrill(working) {
  var flammen = working
    ? '<path d="M40 42c0-5 5-5 5-10 3 3 7 5 7 10a6 6 0 0 1-12 0z" fill="var(--ripe)">' +
      '<animate attributeName="opacity" values="1;.5;1" dur=".6s" repeatCount="indefinite"/></path>'
    : '';
  return '<ellipse cx="50" cy="72" rx="38" ry="7" fill="var(--soil)" opacity=".25"/>' +
    '<rect x="30" y="60" width="6" height="12" fill="#3a3a3e"/>' +
    '<rect x="64" y="60" width="6" height="12" fill="#3a3a3e"/>' +
    '<path d="M26 46h48l-4 16H30z" fill="#4a4a4f"/>' +
    '<ellipse cx="50" cy="46" rx="24" ry="6" fill="#2c2c30"/>' + flammen +
    '<g stroke="#8a8a90" stroke-width="1.6">' +
    '<line x1="34" y1="44" x2="66" y2="44"/><line x1="36" y1="48" x2="64" y2="48"/></g>';
}

function artAppleTree(stufe) {
  var schatten = '<ellipse cx="50" cy="90" rx="26" ry="6" fill="var(--ink)" opacity=".18"/>';

  if (stufe === 'setzling') {
    return '<g>' + schatten +
      '<rect x="47" y="66" width="6" height="22" rx="2" fill="var(--wood-dark)"/>' +
      '<circle cx="50" cy="58" r="12" fill="var(--leaf)"/>' +
      '<circle cx="42" cy="62" r="7" fill="var(--leaf-dark)"/>' +
      '<circle cx="58" cy="62" r="7" fill="var(--leaf-dark)"/></g>';
  }

  if (stufe === 'verwelkt') {
    return '<g>' + schatten +
      '<rect x="44" y="50" width="12" height="38" rx="3" fill="#6b5a45"/>' +
      '<path d="M50 54L30 36M50 60L70 40M50 50L50 30" stroke="#6b5a45" stroke-width="5" stroke-linecap="round" fill="none"/>' +
      '<path d="M34 40l-8-6M66 44l8-6" stroke="#6b5a45" stroke-width="4" stroke-linecap="round" fill="none"/></g>';
  }

  // wachsen und reif: großer Baum, reif zusätzlich mit roten Äpfeln.
  var aepfel = stufe === 'reif'
    ? '<circle cx="38" cy="44" r="5" fill="var(--ripe)"/>' +
      '<circle cx="62" cy="42" r="5" fill="var(--ripe)"/>' +
      '<circle cx="50" cy="30" r="5" fill="var(--ripe)"/>' +
      '<circle cx="54" cy="54" r="5" fill="var(--ripe)"/>' +
      '<circle cx="30" cy="52" r="4.5" fill="var(--ripe)"/>'
    : '';
  return '<g>' + schatten +
    '<rect x="44" y="52" width="12" height="36" rx="3" fill="var(--wood-dark)"/>' +
    '<circle cx="50" cy="42" r="30" fill="var(--leaf-dark)"/>' +
    '<circle cx="32" cy="50" r="20" fill="var(--leaf)"/>' +
    '<circle cx="68" cy="50" r="18" fill="var(--leaf)"/>' +
    '<circle cx="50" cy="28" r="18" fill="var(--leaf)"/>' + aepfel + '</g>';
}

function artMine(working) {
  var loren = working ? '<circle cx="52" cy="60" r="1.4" fill="var(--roof)"><animate attributeName="cy" values="60;54;60" dur="1.6s" repeatCount="indefinite"/></circle>' : '';
  return '<ellipse cx="50" cy="68" rx="44" ry="8" fill="var(--soil)" opacity=".25"/>' +
    '<path d="M12 64L34 26l20 12 18-20 20 46z" fill="#7d858b"/>' +
    '<path d="M34 26l20 12-8 26H24z" fill="#5f676d"/>' +
    '<path d="M38 64V48a12 12 0 0 1 24 0v16z" fill="#2b2420"/>' +
    '<path d="M40 64V49a10 10 0 0 1 20 0v15z" fill="#1a1512"/>' +
    '<rect x="46" y="56" width="8" height="8" fill="var(--wood-dark)"/>' + loren +
    '<circle cx="78" cy="30" r="4" fill="#c9d0d5"/><circle cx="20" cy="40" r="3" fill="#c9d0d5"/>';
}

function artForge(working) {
  var feuer = working
    ? '<path d="M44 40c0-6 6-6 6-12 4 4 8 6 8 12a7 7 0 0 1-14 0z" fill="var(--ripe)">' +
      '<animate attributeName="opacity" values="1;.6;1" dur=".7s" repeatCount="indefinite"/></path>'
    : '';
  return '<ellipse cx="50" cy="68" rx="44" ry="8" fill="var(--soil)" opacity=".25"/>' +
    '<path d="M24 64V34h40v30z" fill="#4a4038"/>' +
    '<path d="M24 34h40l-6-8H30z" fill="#332c26"/>' +
    '<rect x="40" y="44" width="20" height="14" rx="2" fill="#1a1512"/>' + feuer +
    '<rect x="66" y="30" width="8" height="34" fill="#3a322c"/>' +
    '<path d="M14 60h24l-4 6H16z" fill="#6b6a6e"/>' +
    '<rect x="22" y="52" width="10" height="4" rx="2" fill="#8a8a90"/>';
}

function artFor(p) {
  if (ART[p.id]) return ART[p.id](p);
  for (var prefix in ART) {
    if (prefix !== 'fallback' && p.id.indexOf(prefix) === 0) return ART[prefix](p);
  }
  return ART.fallback(p);
}

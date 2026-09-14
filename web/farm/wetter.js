// Tag/Nacht-Stimmung und Wetter — rein kosmetisch, nach der lokalen Uhrzeit des
// Geräts. Kein Spielzustand, nichts Serverrelevantes; färbt nur das Feld.

// Farbstützpunkte über den Tag (Stunde → Tönung r,g,b + Deckkraft a).
// Bewusst zart: Die Nacht soll eine Stimmung sein, kein Grauschleier, unter
// dem man den Hof nicht mehr erkennt.
var HIMMEL_STOPS = [
  { h: 0, r: 18, g: 28, b: 66, a: 0.22 },
  { h: 5, r: 20, g: 30, b: 68, a: 0.20 },
  { h: 6.5, r: 255, g: 150, b: 95, a: 0.14 },
  { h: 8, r: 255, g: 240, b: 210, a: 0.04 },
  { h: 12, r: 255, g: 255, b: 255, a: 0.00 },
  { h: 17, r: 255, g: 242, b: 205, a: 0.05 },
  { h: 19, r: 255, g: 125, b: 70, a: 0.14 },
  { h: 20.5, r: 92, g: 66, b: 120, a: 0.18 },
  { h: 22, r: 18, g: 28, b: 66, a: 0.21 },
  { h: 24, r: 18, g: 28, b: 66, a: 0.22 },
];

function himmelBei(stunde) {
  var s = HIMMEL_STOPS;
  for (var i = 0; i < s.length - 1; i++) {
    if (stunde >= s[i].h && stunde <= s[i + 1].h) {
      var k = (stunde - s[i].h) / (s[i + 1].h - s[i].h || 1);
      var misch = function (x, y) { return Math.round(x + (y - x) * k); };
      return {
        r: misch(s[i].r, s[i + 1].r),
        g: misch(s[i].g, s[i + 1].g),
        b: misch(s[i].b, s[i + 1].b),
        a: (s[i].a + (s[i + 1].a - s[i].a) * k).toFixed(3),
      };
    }
  }
  return s[0];
}

// Wetter wechselt in ~20-Minuten-Fenstern; innerhalb eines Fensters stabil.
function wetterFuer(fenster) {
  var h = (fenster * 2654435761) % 100;
  if (h < 0) h += 100;
  if (h < 62) return 'klar';
  if (h < 85) return 'wolkig';
  return 'regen';
}

// Die Nacht liegt als Multiplikation über der Welt: Weiß lässt alles wie es
// ist, ein dunkles Blau macht Nacht — und was darüber leuchtet (Laternen,
// Glühwürmchen), leuchtet wirklich. Stützpunkte: Stunde → Farbe.
var NACHT_STOPS = [
  { h: 0, r: 104, g: 118, b: 178 },
  { h: 5, r: 108, g: 122, b: 182 },
  { h: 6.5, r: 238, g: 188, b: 150 },
  { h: 8, r: 255, g: 250, b: 240 },
  { h: 12, r: 255, g: 255, b: 255 },
  { h: 17, r: 255, g: 246, b: 224 },
  { h: 19, r: 250, g: 196, b: 146 },
  { h: 20.5, r: 160, g: 150, b: 205 },
  { h: 22, r: 108, g: 122, b: 182 },
  { h: 24, r: 104, g: 118, b: 178 },
];

function nachtBei(stunde) {
  var s = NACHT_STOPS;
  for (var i = 0; i < s.length - 1; i++) {
    if (stunde >= s[i].h && stunde <= s[i + 1].h) {
      var k = (stunde - s[i].h) / (s[i + 1].h - s[i].h || 1);
      var misch = function (x, y) { return Math.round(x + (y - x) * k); };
      return { r: misch(s[i].r, s[i + 1].r), g: misch(s[i].g, s[i + 1].g), b: misch(s[i].b, s[i + 1].b) };
    }
  }
  return s[0];
}

// Tagesphase nach der Uhr des Geräts: Die Nacht ist Stimmung, kein Spielstand.
function tagesphase(stunde) {
  if (stunde < 5 || stunde >= 21.5) return 'nacht';
  if (stunde < 7.5 || stunde >= 19.5) return 'daemmerung';
  return 'tag';
}

// Die Stunde: nach Hofzeit, wenn das Regelwerk sie kennt (dann ist es für
// alle gleichzeitig Nacht, und die Sim weiß es auch) — sonst nach der Uhr
// des Geräts, als Stimmung.
function himmelStunde() {
  if (typeof hofzeitJetzt === 'function') {
    var z = hofzeitJetzt();
    if (z) return z.stunde + z.minute / 60;
  }
  var d = new Date();
  return d.getHours() + d.getMinutes() / 60;
}

function himmelMalen() {
  var el = $('himmel');
  if (!el) return;
  var stunde = himmelStunde();
  var c = himmelBei(stunde);
  el.style.background = 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + c.a + ')';
  var decke = $('nachtdecke');
  if (decke) {
    var f = nachtBei(stunde);
    decke.style.background = 'rgb(' + f.r + ',' + f.g + ',' + f.b + ')';
  }
  var hof = $('hof');
  if (hof) {
    var phase = tagesphase(stunde);
    if (hof.dataset.phase !== phase) {
      hof.dataset.phase = phase;
      lichterSetzen();
    }
  }

  var w = $('wetter');
  if (w) {
    // Kennt die Sim das Wetter, gilt ihres — dann ist der Regen, den man
    // sieht, auch der, der wirkt. Sonst wie bisher nur Stimmung.
    var art = wetterDerSim || wetterFuer(Math.floor(Date.now() / (20 * 60 * 1000)));
    w.className = 'wetter' + (art !== 'klar' ? ' ' + art : '');
  }
}

// Lichter in der Nacht: Laternen leuchten, über Teichen tanzen Glühwürmchen.
// Liegen als eigene Schicht über der Nachtdecke, mit dem Hof verschoben.
function lichterSetzen() {
  var box = $('lichter');
  var hof = $('hof');
  if (!box || !hof) return;
  box.textContent = '';
  if (hof.dataset.phase !== 'nacht' && hof.dataset.phase !== 'daemmerung') return;
  var kopiere = function (von, klasse) {
    var el = document.createElement('span');
    el.className = klasse;
    el.style.left = von.style.left; el.style.top = von.style.top;
    el.style.width = von.style.width; el.style.height = von.style.height;
    return el;
  };
  var laternen = document.querySelectorAll('#plots .plot[data-art="deco-laterne"]');
  for (var i = 0; i < laternen.length; i++) box.appendChild(kopiere(laternen[i], 'laternenschein'));
  if (hof.dataset.phase !== 'nacht' || magerModus()) return;
  var teiche = document.querySelectorAll('#hindernisse .hindernis[data-art="pond"]');
  for (var t = 0; t < teiche.length && t < 6; t++) {
    for (var k = 0; k < 3; k++) {
      var g = kopiere(teiche[t], 'gluehwuermchen');
      g.style.setProperty('--dx', (Math.round(Math.random() * 120) - 60) + '%');
      g.style.setProperty('--dy', (Math.round(Math.random() * 80) - 60) + '%');
      g.style.animationDelay = (Math.random() * 4).toFixed(2) + 's';
      g.style.animationDuration = (3 + Math.random() * 3).toFixed(2) + 's';
      box.appendChild(g);
    }
  }
}

// Vom Neuaufbau gesetzt: das Wetter aus der Sicht der Sim — und die Jahreszeit.
var wetterDerSim = null;
var saisonDerSim = -1;
var SAISON_FARBEN = ['#4d8a3f', '#b8811f', '#b5473a', '#4f7cc4'];
function wetterUebernehmen(v) {
  var neu = v && v.wetter ? v.wetter.art : null;
  var saison = v && v.saison ? v.saison : null;
  var zeile = $('wetterzeile');
  if (zeile) {
    var regen = !!(v && v.wetter && v.wetter.wirkt);
    zeile.hidden = !regen && !saison;
    if (regen) {
      zeile.style.color = '';
      zeile.textContent = '🌧 Regen · Saat wächst ' + v.wetter.regenSchubProzent + ' % schneller · noch ' + timeText(v.wetter.wechselIn);
    } else if (saison) {
      zeile.style.color = SAISON_FARBEN[saison.index] || '';
      var hz = v && v.hofzeit;
      zeile.textContent = (hz ? hz.monatName + ', Tag ' + hz.tag : saison.name) + ' · ' + itemName(saison.bonusItem) + ' bringt eine mehr';
    }
  }
  var hof = $('hof');
  var idx = saison ? saison.index : -1;
  if (hof && idx !== saisonDerSim) {
    saisonDerSim = idx;
    hof.classList.remove('saison-0', 'saison-1', 'saison-2', 'saison-3');
    if (idx >= 0) hof.classList.add('saison-' + idx);
  }
  if (neu === wetterDerSim) return;
  wetterDerSim = neu;
  himmelMalen();
}

himmelMalen();
// Ein Hoftag ist eine Stunde: alle paar Sekunden nachfärben, sonst springt der Abend.
setInterval(himmelMalen, 5000);

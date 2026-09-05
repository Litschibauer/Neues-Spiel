// Tag/Nacht-Stimmung und Wetter — rein kosmetisch, nach der lokalen Uhrzeit des
// Geräts. Kein Spielzustand, nichts Serverrelevantes; färbt nur das Feld.

// Farbstützpunkte über den Tag (Stunde → Tönung r,g,b + Deckkraft a).
var HIMMEL_STOPS = [
  { h: 0, r: 18, g: 28, b: 66, a: 0.50 },
  { h: 5, r: 20, g: 30, b: 68, a: 0.44 },
  { h: 6.5, r: 255, g: 150, b: 95, a: 0.30 },
  { h: 8, r: 255, g: 240, b: 210, a: 0.06 },
  { h: 12, r: 255, g: 255, b: 255, a: 0.00 },
  { h: 17, r: 255, g: 242, b: 205, a: 0.08 },
  { h: 19, r: 255, g: 125, b: 70, a: 0.30 },
  { h: 20.5, r: 92, g: 66, b: 120, a: 0.40 },
  { h: 22, r: 18, g: 28, b: 66, a: 0.48 },
  { h: 24, r: 18, g: 28, b: 66, a: 0.50 },
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

function himmelMalen() {
  var el = $('himmel');
  if (!el) return;
  var d = new Date();
  var c = himmelBei(d.getHours() + d.getMinutes() / 60);
  el.style.background = 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + c.a + ')';

  var w = $('wetter');
  if (w) {
    var art = wetterFuer(Math.floor(Date.now() / (20 * 60 * 1000)));
    w.className = 'wetter' + (art !== 'klar' ? ' ' + art : '');
  }
}

himmelMalen();
setInterval(himmelMalen, 30000);

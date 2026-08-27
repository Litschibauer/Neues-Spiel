var HORIZONT = 30;
var BODEN = 127;
var TIEFE_HINTEN = 0.66;
var HOCH = 1.55;

function hatRaster() {
  return !!rules.grid;
}

function raster() {
  return rules.grid || { w: 1, h: 1 };
}

function altePlatzierung(i) {
  var ort = rules.plots[i] && rules.plots[i].place;
  if (!ort) return { left: 2 + ((i % 3) * 32), width: 30, top: 4 + Math.floor(i / 3) * 24,
    height: 20, tiefe: i };
  return { left: ort.x, width: ort.w, top: ort.y, height: ort.h, tiefe: ort.y };
}

function reiheBreite(t) {
  return TIEFE_HINTEN + (1 - TIEFE_HINTEN) * t;
}

var RAND = 2;

function zoomFaktor() {
  var g = raster();
  return (g.w + 2 * RAND) / g.w;
}

function projiziere(gx, gy) {
  var g = raster();
  var W = g.w + 2 * RAND;
  var H = g.h + 2 * RAND;
  var t = (gy + RAND) / H;
  var breite = reiheBreite(t);
  return {
    x: 50 + ((gx + RAND) / W - 0.5) * 100 * breite,
    y: HORIZONT + t * (BODEN - HORIZONT),
    breite: breite,
  };
}

function feldKasten(gx, gy, w, h) {
  var g = raster();
  var oben = projiziere(gx, gy);
  var unten = projiziere(gx, gy + h);
  var links = Math.min(oben.x, unten.x + ((gx / g.w - 0.5) * 0 || 0));
  var untenLinks = projiziere(gx, gy + h);
  var untenRechts = projiziere(gx + w, gy + h);

  return {
    left: Math.min(oben.x, untenLinks.x),
    breite: untenRechts.x - untenLinks.x,
    oben: oben.y,
    unten: unten.y,
    skala: unten.breite,
    linksOben: links,
  };
}

function prozent(wert, gesamt) {
  return (wert * 100) / gesamt;
}

function plotKasten(i, plot) {
  if (i >= 0 && !hatRaster()) return altePlatzierung(i);
  var g = raster();
  var def = i >= 0 ? rules.plots[i] : null;
  var groesse = (def && def.size) || { w: 1, h: 1 };
  var k = feldKasten(plot.gx, plot.gy, groesse.w, groesse.h);

  var hoch = def && def.flat ? 1 : HOCH;
  var hoehe = (k.unten - k.oben) * hoch;
  var top = k.unten - hoehe;

  return {
    left: k.left,
    width: k.breite,
    top: prozent(top, BODEN + 3),
    height: prozent(hoehe, BODEN + 3),
    tiefe: plot.gy + groesse.h,
  };
}

function artBoden(zeigeRaster) {
  if (!hatRaster()) return '';
  var g = raster();
  var out = '';

  var w1 = projiziere(-RAND, -RAND);
  var w2 = projiziere(g.w + RAND, -RAND);
  var w3 = projiziere(g.w + RAND, g.h + RAND);
  var w4 = projiziere(-RAND, g.h + RAND);
  out += '<path d="M' + w1.x + ' ' + w1.y + 'L' + w2.x + ' ' + w2.y +
    'L' + w3.x + ' ' + w3.y + 'L' + w4.x + ' ' + w4.y + 'z" fill="var(--wiese, var(--meadow))"/>';

  var e1 = projiziere(0, 0);
  var e2 = projiziere(g.w, 0);
  var e3 = projiziere(g.w, g.h);
  var e4 = projiziere(0, g.h);
  out += '<path d="M' + e1.x + ' ' + e1.y + 'L' + e2.x + ' ' + e2.y +
    'L' + e3.x + ' ' + e3.y + 'L' + e4.x + ' ' + e4.y + 'z" fill="var(--acker)"/>';

  for (var y = 0; y < g.h; y++) {
    for (var x = 0; x < g.w; x++) {
      if ((x + y) % 2 === 1) continue;
      var a = projiziere(x, y);
      var b = projiziere(x + 1, y);
      var c = projiziere(x + 1, y + 1);
      var d = projiziere(x, y + 1);
      out += '<path d="M' + a.x + ' ' + a.y + 'L' + b.x + ' ' + b.y +
        'L' + c.x + ' ' + c.y + 'L' + d.x + ' ' + d.y + 'z" fill="var(--acker-hell)"/>';
    }
  }

  if (zeigeRaster) {
    for (var gy = 0; gy <= g.h; gy++) {
      var l = projiziere(0, gy);
      var r = projiziere(g.w, gy);
      out += '<path d="M' + l.x + ' ' + l.y + 'L' + r.x + ' ' + r.y +
        '" stroke="var(--raster)" stroke-width=".4"/>';
    }
    for (var gx2 = 0; gx2 <= g.w; gx2++) {
      var o = projiziere(gx2, 0);
      var u = projiziere(gx2, g.h);
      out += '<path d="M' + o.x + ' ' + o.y + 'L' + u.x + ' ' + u.y +
        '" stroke="var(--raster)" stroke-width=".4"/>';
    }
  }

  return out;
}

function passtHin(plot, gx, gy) {
  var g = rules.grid;
  if (!g) return false;
  var groesse = rules.plots[plot].size || { w: 1, h: 1 };
  if (gx < 0 || gy < 0 || gx + groesse.w > g.w || gy + groesse.h > g.h) return false;

  var hindernisse = rules.obstacles || [];
  for (var h = 0; h < hindernisse.length; h++) {
    var hi = hindernisse[h];
    var offen =
      gx + groesse.w <= hi.gx ||
      hi.gx + hi.w <= gx ||
      gy + groesse.h <= hi.gy ||
      hi.gy + hi.h <= gy;
    if (!offen) return false;
  }

  var andere = client.preview().plots;
  for (var i = 0; i < andere.length; i++) {
    if (i === plot || andere[i].gx < 0) continue;
    var s2 = rules.plots[i].size || { w: 1, h: 1 };
    var frei =
      gx + groesse.w <= andere[i].gx ||
      andere[i].gx + s2.w <= gx ||
      gy + groesse.h <= andere[i].gy ||
      andere[i].gy + s2.h <= gy;
    if (!frei) return false;
  }
  return true;
}

function moebelKasten(gx, gy, w, h, flach) {
  var k = feldKasten(gx, gy, w, h);
  var hoch = flach ? 1 : HOCH;
  var hoehe = (k.unten - k.oben) * hoch;
  var top = k.unten - hoehe;
  return {
    left: k.left,
    width: k.breite,
    top: prozent(top, BODEN + 3),
    height: prozent(hoehe, BODEN + 3),
    tiefe: gy + h,
  };
}

function hindernisKasten(h) {
  var kasten = feldKasten(h.gx, h.gy, h.w, h.h);
  var hoehe = (kasten.unten - kasten.oben) * (h.kind === 'pond' ? 1 : 1.7);
  return {
    left: kasten.left,
    width: kasten.breite,
    top: prozent(kasten.unten - hoehe, BODEN + 3),
    height: prozent(hoehe, BODEN + 3),
    tiefe: h.gy + h.h,
  };
}

function feldFuer(plot, feld) {
  var g = rules.grid;
  var groesse = rules.plots[plot].size || { w: 1, h: 1 };
  return {
    gx: Math.max(0, Math.min(g.w - groesse.w, feld.gx - (groesse.w >> 1))),
    gy: Math.max(0, Math.min(g.h - groesse.h, feld.gy - (groesse.h >> 1))),
  };
}

var kamera = { x: 0, y: 0, z: 1, gesetzt: false };

function effZoom() {
  return zoomFaktor() * kamera.z;
}

function kameraGrenzen() {
  var k = $('hof').getBoundingClientRect();
  var z = effZoom();
  return { minX: k.width * (1 - z), minY: k.height * (1 - z), w: k.width, h: k.height };
}

function kameraKlemmen() {
  var g = kameraGrenzen();
  kamera.x = Math.max(g.minX, Math.min(0, kamera.x));
  kamera.y = Math.max(g.minY, Math.min(0, kamera.y));
}

function kameraMitte() {
  var g = kameraGrenzen();
  var raster0 = raster();
  var mitte = projiziere(raster0.w / 2, raster0.h / 2);
  var mx = (mitte.x / 100) * g.w;
  var my = (mitte.y / (BODEN + 3)) * g.h;
  var z = effZoom();
  kamera.x = g.w / 2 - z * mx;
  kamera.y = g.h / 2 - z * my;
  kamera.gesetzt = true;
  kameraAnwenden();
}

function kameraAnwenden() {
  var w = $('welt');
  if (!w) return;
  if (!kamera.gesetzt) return;
  kameraKlemmen();
  w.style.transform = 'translate(' + kamera.x + 'px,' + kamera.y + 'px) scale(' + effZoom() + ')';
}

function kameraZoomen(faktor, mx, my) {
  var alt = effZoom();
  kamera.z = Math.max(0.75, Math.min(1.8, kamera.z * faktor));
  var neu = effZoom();
  var k = $('hof').getBoundingClientRect();
  var px = mx - k.left, py = my - k.top;
  kamera.x = px - (px - kamera.x) * (neu / alt);
  kamera.y = py - (py - kamera.y) * (neu / alt);
  kameraAnwenden();
}

function zeigerAufFeld(e) {
  var kasten = $('hof').getBoundingClientRect();
  var z = effZoom();
  var lx = (e.clientX - kasten.left - kamera.x) / z;
  var ly = (e.clientY - kasten.top - kamera.y) / z;
  var px = (lx / kasten.width) * 100;
  var py = (ly / kasten.height) * (BODEN + 3);
  return feldUnterMaus(px, py);
}

function feldUnterMaus(px, py) {
  var g = raster();
  for (var gy = g.h - 1; gy >= 0; gy--) {
    for (var gx = 0; gx < g.w; gx++) {
      var a = projiziere(gx, gy);
      var b = projiziere(gx + 1, gy);
      var c = projiziere(gx + 1, gy + 1);
      var d = projiziere(gx, gy + 1);
      if (imViereck(px, py, a, b, c, d)) return { gx: gx, gy: gy };
    }
  }
  return null;
}

function imViereck(px, py, a, b, c, d) {
  return dreieck(px, py, a, b, c) || dreieck(px, py, a, c, d);
}

function dreieck(px, py, a, b, c) {
  var v0x = c.x - a.x, v0y = c.y - a.y;
  var v1x = b.x - a.x, v1y = b.y - a.y;
  var v2x = px - a.x, v2y = py - a.y;
  var nenner = v0x * v1y - v1x * v0y;
  if (nenner === 0) return false;
  var u = (v2x * v1y - v1x * v2y) / nenner;
  var v = (v0x * v2y - v2x * v0y) / nenner;
  return u >= 0 && v >= 0 && u + v <= 1;
}

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

function projiziere(gx, gy) {
  var g = raster();
  var t = gy / g.h;
  var breite = reiheBreite(t);
  return {
    x: 50 + (gx / g.w - 0.5) * 100 * breite,
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
  if (!hatRaster()) return altePlatzierung(i);
  var g = raster();
  var def = rules.plots[i];
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

function feldFuer(plot, feld) {
  var g = rules.grid;
  var groesse = rules.plots[plot].size || { w: 1, h: 1 };
  return {
    gx: Math.max(0, Math.min(g.w - groesse.w, feld.gx - (groesse.w >> 1))),
    gy: Math.max(0, Math.min(g.h - groesse.h, feld.gy - (groesse.h >> 1))),
  };
}

function zeigerAufFeld(e) {
  var kasten = $('hof').getBoundingClientRect();
  var px = ((e.clientX - kasten.left) / kasten.width) * 100;
  var py = ((e.clientY - kasten.top) / kasten.height) * (BODEN + 3);
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

var BAND = 3;

function hatRaster() {
  return !!rules.grid;
}

function raster() {
  return rules.grid || { w: 1, h: 1 };
}

function gesamtReihen() {
  return raster().h + BAND;
}

function altePlatzierung(i) {
  var ort = rules.plots[i] && rules.plots[i].place;
  if (!ort) return { left: 2 + ((i % 3) * 32), width: 30, top: 4 + Math.floor(i / 3) * 24,
    height: 20, tiefe: i };
  return { left: ort.x, width: ort.w, top: ort.y, height: ort.h, tiefe: ort.y };
}

function projiziere(gx, gy) {
  return {
    x: (gx / raster().w) * 100,
    y: ((gy + BAND) / gesamtReihen()) * 100,
  };
}

function zellB() { return 100 / raster().w; }
function zellH() { return 100 / gesamtReihen(); }

function feldKasten(gx, gy, w, h) {
  var p = projiziere(gx, gy);
  return {
    left: p.x,
    top: p.y,
    breite: w * zellB(),
    hoehe: h * zellH(),
    tiefe: gy + h,
  };
}

function plotKasten(i, plot) {
  if (i >= 0 && !hatRaster()) return altePlatzierung(i);
  var def = i >= 0 ? rules.plots[i] : null;
  var groesse = (def && def.size) || { w: 1, h: 1 };
  var k = feldKasten(plot.gx, plot.gy, groesse.w, groesse.h);
  return {
    left: k.left,
    width: k.breite,
    top: k.top,
    height: k.hoehe,
    tiefe: plot.gy + groesse.h,
  };
}

function moebelKasten(gx, gy, w, h) {
  var k = feldKasten(gx, gy, w, h);
  return { left: k.left, width: k.breite, top: k.top, height: k.hoehe, tiefe: gy + h };
}

function hindernisKasten(h) {
  var k = feldKasten(h.gx, h.gy, h.w, h.h);
  return { left: k.left, width: k.breite, top: k.top, height: k.hoehe, tiefe: h.gy + h.h };
}

function artBoden(zeigeRaster) {
  if (!hatRaster()) return '';
  var g = raster();
  var out = '';

  var bandOben = projiziere(0, -BAND).y;
  var ackerOben = projiziere(0, 0).y;
  out += '<rect x="0" y="' + bandOben + '" width="100" height="' + (ackerOben - bandOben) +
    '" fill="var(--path)"/>';
  out += '<rect x="0" y="' + ackerOben + '" width="100" height="' + (100 - ackerOben) +
    '" fill="var(--acker)"/>';

  for (var y = 0; y < g.h; y++) {
    for (var x = 0; x < g.w; x++) {
      if ((x + y) % 2 === 1) continue;
      var a = projiziere(x, y);
      var b = projiziere(x + 1, y + 1);
      out += '<rect x="' + a.x + '" y="' + a.y + '" width="' + (b.x - a.x) +
        '" height="' + (b.y - a.y) + '" fill="var(--acker-hell)"/>';
    }
  }

  if (zeigeRaster) {
    for (var gy = 0; gy <= g.h; gy++) {
      var ly = projiziere(0, gy).y;
      out += '<path d="M0 ' + ly + 'H100" stroke="var(--raster)" stroke-width=".3"/>';
    }
    for (var gx = 0; gx <= g.w; gx++) {
      var lx = projiziere(gx, 0).x;
      out += '<path d="M' + lx + ' ' + ackerOben + 'V100" stroke="var(--raster)" stroke-width=".3"/>';
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

  var felder = rules.expansions || [];
  var frei2 = (client.preview().expandiert) || [];
  for (var e = 0; e < felder.length; e++) {
    var ex = felder[e];
    if (frei2.indexOf(ex.id) >= 0) continue;
    var raus =
      gx + groesse.w <= ex.gx ||
      ex.gx + ex.w <= gx ||
      gy + groesse.h <= ex.gy ||
      ex.gy + ex.h <= gy;
    if (!raus) return false;
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
  return kamera.z;
}

function weltMasse() {
  var k = $('hof').getBoundingClientRect();
  var z = effZoom();
  var hoehe = k.height * z;
  var breite = k.height * (raster().w / gesamtReihen()) * z;
  return { hofW: k.width, hofH: k.height, w: breite, h: hoehe };
}

function weltFormat() {
  var w = $('welt');
  if (!w) return;
  w.style.height = '100%';
  w.style.width = 'auto';
  w.style.aspectRatio = raster().w + ' / ' + gesamtReihen();
}

function zoomMin() {
  var k = $('hof').getBoundingClientRect();
  if (k.height <= 0) return 1;
  var baseW = k.height * (raster().w / gesamtReihen());
  return Math.min(1, k.width / baseW);
}

function kameraKlemmen() {
  var m = weltMasse();
  if (m.w <= m.hofW) kamera.x = (m.hofW - m.w) / 2;
  else kamera.x = Math.max(m.hofW - m.w, Math.min(0, kamera.x));
  if (m.h <= m.hofH) kamera.y = (m.hofH - m.h) / 2;
  else kamera.y = Math.max(m.hofH - m.h, Math.min(0, kamera.y));
}

function kameraAnwenden() {
  var w = $('welt');
  if (!w) return;
  if (!kamera.gesetzt) return;
  kamera.z = Math.max(zoomMin(), Math.min(4.5, kamera.z));
  kameraKlemmen();
  w.style.transform = 'translate(' + kamera.x + 'px,' + kamera.y + 'px) scale(' + effZoom() + ')';
}

function kameraMitte() {
  weltFormat();
  kamera.z = zoomMin();
  kamera.x = 0;
  kamera.y = 0;
  kamera.gesetzt = true;
  kameraAnwenden();
}

function kameraStart() {
  weltFormat();
  var k = $('hof').getBoundingClientRect();
  if (k.width <= 0) return;
  var ziel = Math.min(raster().w, 15);
  var z = (k.width * gesamtReihen()) / (k.height * ziel);
  kamera.z = Math.max(zoomMin(), Math.min(4.5, z));
  kamera.x = 0;
  kamera.y = 0;
  kamera.gesetzt = true;
  kameraAnwenden();
}

function kameraZoomen(faktor, mx, my) {
  var alt = effZoom();
  kamera.z = Math.max(zoomMin(), Math.min(4.5, kamera.z * faktor));
  var neu = effZoom();
  var k = $('hof').getBoundingClientRect();
  var px = mx - k.left, py = my - k.top;
  kamera.x = px - (px - kamera.x) * (neu / alt);
  kamera.y = py - (py - kamera.y) * (neu / alt);
  kameraAnwenden();
}

function zeigerAufFeld(e) {
  var k = $('hof').getBoundingClientRect();
  var m = weltMasse();
  var lx = e.clientX - k.left - kamera.x;
  var ly = e.clientY - k.top - kamera.y;
  var gx = Math.floor((lx / m.w) * raster().w);
  var gy = Math.floor((ly / m.h) * gesamtReihen()) - BAND;
  if (gx < 0 || gx >= raster().w || gy < 0 || gy >= raster().h) return null;
  return { gx: gx, gy: gy };
}

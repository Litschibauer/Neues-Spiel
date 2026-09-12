// Das Band ueber dem Raster: Weg und Moebel. Vier Zeilen, damit die Koerper
// der Moebel (bis 1,6 Zellen ueber ihrem Standplatz) auch dann ganz im Bild
// sind, wenn die Kamera oben anschlaegt — am breiten Bildschirm ist das der
// Normalfall.
var BAND = 4;

// Zweite Dimension: der Angelsee hat ein EIGENES Raster. Umschalten über das
// Boot. Rein clientseitig — der Sim kennt nur den einen Hof-Zustand.
var seeAktiv = false;
var SEE_GRID = { w: 24, h: 13 };

function hatRaster() {
  return seeAktiv ? true : !!rules.grid;
}

function raster() {
  if (seeAktiv) return SEE_GRID;
  return rules.grid || { w: 1, h: 1 };
}

function wechselZone(zuSee) {
  if (seeAktiv === !!zuSee) return;
  seeAktiv = !!zuSee;
  // Beim ersten Besuch erklärt sich der See selbst.
  if (seeAktiv && typeof featureTutorial === 'function' && !(typeof besuchAktiv === 'function' && besuchAktiv())) featureTutorial('see');
  kamera.gesetzt = false; // Kamera neu aufs andere Raster einpassen
  var sc = $('scene');
  if (sc) sc.dataset.stand = ''; // Szene wird beim nächsten render() neu gemalt
  render();
}

function gesamtReihen() {
  return raster().h + BAND;
}

// Kameraneigung. Der Hof wird nicht mehr senkrecht von oben gezeigt, sondern
// leicht schraeg von vorne. Eine Zelle ist auf dem Schirm darum breiter als
// hoch. Alle Kaesten rechnen in Prozent des Weltkastens, also folgt der Rest
// von allein — auch Treffer und Ziehen.
var ZELL_HOEHE = 0.62;

function weltVerhaeltnis() {
  return raster().w / (gesamtReihen() * ZELL_HOEHE);
}

// Ein Objekt steht auf seinem Standplatz und ragt darueber hinaus. Sein Kasten
// waechst also nach oben, um `hoch` Zellen. Die viewBox bekommt genau das
// Seitenverhaeltnis dieses Kastens, damit Kreise Kreise bleiben. `boden` sagt
// der Kunst, ab welcher Hoehe der Standplatz anfaengt: darunter liegt Erde,
// darueber ist Luft.
function koerperMasse(zellenB, zellenH, hoch) {
  return {
    vh: (100 * (zellenH + hoch) * ZELL_HOEHE) / zellenB,
    boden: (100 * hoch * ZELL_HOEHE) / zellenB,
    hoch: hoch,
  };
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


// Sperrzonen des Regelwerks (Wegrand, Ufer): Dort steht nichts, dort wird
// nichts geraeumt — und Hindernisse darin bleiben unsichtbar.
function inSperre(gx, gy, w, h) {
  var zonen = (rules.grid && rules.grid.sperren) || [];
  for (var i = 0; i < zonen.length; i++) {
    var z = zonen[i];
    if (gx < z.gx + z.w && z.gx < gx + w && gy < z.gy + z.h && z.gy < gy + h) return true;
  }
  return false;
}
function wegZeilen() {
  var zonen = (rules.grid && rules.grid.sperren) || [];
  for (var i = 0; i < zonen.length; i++) if (zonen[i].id === 'weg') return zonen[i].h;
  return 0;
}

function passtHin(plot, gx, gy) {
  var g = rules.grid;
  if (!g) return false;
  var groesse = rules.plots[plot].size || { w: 1, h: 1 };
  if (gx < 0 || gy < 0 || gx + groesse.w > g.w || gy + groesse.h > g.h) return false;
  if (inSperre(gx, gy, groesse.w, groesse.h)) return false;

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
  var breite = k.height * weltVerhaeltnis() * z;
  return { hofW: k.width, hofH: k.height, w: breite, h: hoehe };
}

function weltFormat() {
  var w = $('welt');
  if (!w) return;
  w.style.height = '100%';
  w.style.width = 'auto';
  w.style.aspectRatio = String(weltVerhaeltnis());
}

// Kacheln sollen IMMER gleich gross aussehen — egal wie gross das Raster ist.
// Darum wird der Zoom aus einer Ziel-Kachelgroesse abgeleitet (kurze
// Bildschirmseite geteilt durch ZIEL_ZELLE) statt aus „ganzer Hof ins Bild".
// Sonst schrumpft alles, sobald der Hof waechst.
var ZIEL_ZELLE = 8;
var WEITEST_ZELLE = 18;
var MAX_ZOOM = 6;

// Zoom, bei dem eine Zelle genau `px` BREIT ist. Die Breite ist seit der
// Neigung das ehrliche Mass — die Hoehe ist ja bewusst gestaucht.
function zoomFuerZellbreite(px) {
  var k = $('hof').getBoundingClientRect();
  if (k.height <= 0) return 1;
  return (px * gesamtReihen() * ZELL_HOEHE) / k.height;
}

function zoomFuerZellen(teiler) {
  var k = $('hof').getBoundingClientRect();
  if (k.height <= 0) return 1;
  return zoomFuerZellbreite(Math.min(k.width, k.height) / teiler);
}

function zoomMin() {
  var k = $('hof').getBoundingClientRect();
  if (k.height <= 0) return 1;
  var baseW = k.height * weltVerhaeltnis();
  var passt = Math.min(1, k.width / baseW);
  if (seeAktiv) return passt;
  // Nicht beliebig weit heraus: sonst wird der Hof zu Pixelbrei.
  return Math.max(passt, zoomFuerZellen(WEITEST_ZELLE));
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
  kamera.z = Math.max(zoomMin(), Math.min(MAX_ZOOM, kamera.z));
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

function istQuer() {
  var k = $('hof').getBoundingClientRect();
  return k.width > k.height * 1.4;
}

// Mitte des eigenen Hofs: Dort soll die Kamera starten, nicht in der Ecke des
// riesigen Rasters, von dem das meiste gesperrt ist.
function hofGebiet() {
  // Der Hof, der gerade gezeigt wird — zu Besuch der fremde.
  var plots = (typeof hofSicht !== 'undefined' && hofSicht)
    ? hofSicht.plots
    : (typeof client !== 'undefined' && client && client.preview) ? client.preview().plots : [];
  var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9, n = 0;
  for (var i = 0; i < plots.length; i++) {
    var p = plots[i];
    // Nur GEBAUTES zaehlt. Die feste Mine steht schon platziert im fernen
    // Sperrland — sie wuerde das Gebiet sonst ueber den halben Hof aufziehen.
    if (!p || p.gx < 0 || p.level <= 0) continue;
    var idx = p.index !== undefined ? p.index : i;
    var g = p.size || (rules.plots[idx] && rules.plots[idx].size) || { w: 1, h: 1 };
    if (p.gx < minX) minX = p.gx;
    if (p.gy < minY) minY = p.gy;
    if (p.gx + g.w > maxX) maxX = p.gx + g.w;
    if (p.gy + g.h > maxY) maxY = p.gy + g.h;
    n++;
  }
  if (n === 0) {
    return { gx: raster().w / 2, gy: raster().h / 2, w: raster().w, h: raster().h };
  }
  return {
    gx: (minX + maxX) / 2,
    gy: (minY + maxY) / 2,
    w: maxX - minX,
    h: maxY - minY,
  };
}

function hofMitte() {
  var g = hofGebiet();
  return { gx: g.gx, gy: g.gy };
}

// Zoom, bei dem ein Gebiet von w x h Zellen (plus etwas Luft) gerade ins Bild passt.
function zoomFuerGebiet(w, h) {
  var k = $('hof').getBoundingClientRect();
  if (k.height <= 0) return 1;
  var nachBreite = zoomFuerZellbreite(k.width / (w + 2));
  var nachHoehe = gesamtReihen() / (h + 2);
  return Math.min(nachBreite, nachHoehe);
}

function zentriere(gx, gy) {
  var k = $('hof').getBoundingClientRect();
  var m = weltMasse();
  kamera.x = k.width / 2 - (gx / raster().w) * m.w;
  kamera.y = k.height / 2 - ((gy + BAND) / gesamtReihen()) * m.h;
}

function kameraStart() {
  weltFormat();
  var k = $('hof').getBoundingClientRect();
  if (k.width <= 0) return;

  kamera.gesetzt = true;
  if (seeAktiv) {
    // Der See ist eine kleine, gebaute Szene — die zeigt man ganz.
    kamera.z = Math.max(zoomMin(), Math.min(MAX_ZOOM, 1));
    kamera.x = 0;
    kamera.y = 0;
    kameraAnwenden();
    return;
  }

  // Feste Kachelgroesse — aber nie so nah, dass der eigene Hof nicht mehr ins
  // Bild passt. Der kleinere der beiden Werte gewinnt.
  var gebiet = hofGebiet();
  var z = Math.min(zoomFuerZellen(ZIEL_ZELLE), zoomFuerGebiet(gebiet.w, gebiet.h));
  kamera.z = Math.max(zoomMin(), Math.min(MAX_ZOOM, z));
  zentriere(gebiet.gx, gebiet.gy);
  kameraAnwenden();
}

function kameraZoomen(faktor, mx, my) {
  var alt = effZoom();
  kamera.z = Math.max(zoomMin(), Math.min(MAX_ZOOM, kamera.z * faktor));
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

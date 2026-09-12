// Lautstärke der Klick-/Spiel-Soundeffekte als Prozent (0–100), getrennt von
// der Musik (die regelt musik.js). Merker: ns-sfx.
function ladeProzent(key, standard) {
  var v = parseInt(localStorage.getItem(key), 10);
  return isNaN(v) ? standard : Math.max(0, Math.min(100, v));
}
var sfxProz = ladeProzent('ns-sfx', 70);
var SFX_BASIS = 0.9; // 100 % ⇒ Master-Gain 0.9 (klar hörbar über der Musik)
function sfxFaktor() { return (sfxProz / 100) * SFX_BASIS; }

var audio = null;
var meister = null;

function tonBereit() {
  if (sfxProz <= 0) return null;
  if (audio) {
    if (audio.state === 'suspended') audio.resume();
    return audio;
  }
  var Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  try {
    audio = new Ctx();
  } catch (e) {
    return null;
  }
  meister = audio.createGain();
  meister.gain.value = sfxFaktor();
  meister.connect(audio.destination);
  klaengeEntpacken();
  return audio;
}

function sfxSetzen(p) {
  sfxProz = Math.max(0, Math.min(100, p | 0));
  try { localStorage.setItem('ns-sfx', String(sfxProz)); } catch (e) {}
  tonBereit(); // Kontext sicher anlegen/aufwecken, damit die Vorschau klingt.
  if (meister) meister.gain.value = sfxFaktor();
  if (sfxProz > 0) klang('tipp');
}

// — Die Klänge selbst ——————————————————————————————————————————————————
// Keine Oszillatoren mehr: Die Klänge sind aufgenommene, gemeinfreie Geräusche
// (Münzen in der Hand, Bretter, Gras, ein Riegel) und ein paar 8-Bit-Jingles —
// siehe klaenge/LIZENZ.txt. Sie stecken als WAV-Data-URIs in der Seite
// (KLAENGE_DATEN) und werden beim ersten Antippen entpackt, damit auch der
// erste Ton ohne Netz kommt.
var klangPuffer = {};
var klangEntpackt = false;

function bytesAus(dataUri) {
  var b64 = dataUri.slice(dataUri.indexOf(',') + 1);
  var bin = atob(b64);
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function klaengeEntpacken() {
  if (klangEntpackt || !audio || typeof KLAENGE_DATEN !== 'object') return;
  klangEntpackt = true;
  Object.keys(KLAENGE_DATEN).forEach(function (name) {
    try {
      // Die Rückruf-Form, weil Safari die Promise-Form lange nicht kannte.
      audio.decodeAudioData(bytesAus(KLAENGE_DATEN[name]), function (buf) {
        klangPuffer[name] = buf;
      }, function () {});
    } catch (e) {}
  });
}

// Spielt einen entpackten Klang: `rate` verschiebt die Tonhöhe (1 = wie
// aufgenommen), `laut` skaliert, `ab` verzögert in Sekunden.
function spiele(name, rate, laut, ab) {
  var buf = klangPuffer[name];
  if (!buf) return false;
  var q = audio.createBufferSource();
  q.buffer = buf;
  q.playbackRate.value = rate || 1;
  var g = audio.createGain();
  g.gain.value = laut == null ? 1 : laut;
  q.connect(g);
  g.connect(meister);
  q.start(audio.currentTime + (ab || 0));
  return true;
}

// Welche Lautstärke ein Klang im Verhältnis zu den anderen hat. Wer hier
// fehlt, spielt mit 1 — und wer keinen Klang hat, bekommt den Tipp.
var KLAENGE = {
  tipp: 0.7,
  bestaetigt: 0.9,
  fehler: 0.8,
  saat: 0.8,
  ernte: 0.9,
  muenzen: 1,
  kauf: 0.9,
  kiste: 0.9,
  truhe: 1,
  wagen: 0.9,
  tier: 0.9,
  stufe: 1,
  erfolg: 1,
  zettel: 0.9,
  fund: 1,
  bau: 0.9,
};

// XP: die Zahl steigt am Ort auf, und ein Funke fliegt zum Ring oben, der
// sich fuellt und bei Ankunft huepft. Damit fliegt alles, was man bekommt.
function xpAuf(wo, dazu) {
  if (!wo || dazu <= 0) return;
  zahlAuf(hoch(wo), '+' + dazu + ' XP', 'xp');
  flugZu(wo, document.querySelector('.ring'), '<b>\u2726</b>', 'xp', 1);
}

// Sieben Tage in Folge: die hoechste Bonusstufe — das ist eine Karte wert,
// nicht nur eine Zeile.
function feiereSerie(tage, gold) {
  $('stufe-zahl').textContent = '\ud83d\udd25';
  $('stufe-titel').textContent = tage + ' Tage in Folge!';
  $('stufe-neu').innerHTML =
    '<div class="zeile"><span class="mark">\ud83c\udf81</span><span>Höchste Bonusstufe</span>' +
    '<span class="was">' + gold + ' Gold</span></div>' +
    '<div class="zeile"><span class="mark">\u2600\ufe0f</span><span>Jeden Tag vorbeischauen zahlt sich aus</span>' +
    '<span class="was">weiter so</span></div>';
  $('stufe-feier').hidden = false;
  klang('stufe');
  konfetti();
  if (navigator.vibrate) { try { navigator.vibrate([0, 40, 40, 60]); } catch (e) {} }
  if (feierTimer) clearTimeout(feierTimer);
  feierTimer = setTimeout(feierZu, 6000);
}

// Der Geldbeutel oben huepft, wenn Muenzen ankommen — damit man sieht, wo das
// Gold hingeht, ohne hinzuschauen.
function geldbeutelHuepft() {
  zielHuepft(document.querySelector('.coins'));
}

function zielHuepft(el) {
  if (!el || !el.classList || magerModus()) return;
  el.classList.remove('huepft');
  void el.offsetWidth;
  el.classList.add('huepft');
}

function rechteck(x) {
  return x && typeof x.getBoundingClientRect === 'function' ? x.getBoundingClientRect() : x;
}

// Etwas fliegt von A nach B — als Bild, nicht als Zahl: der Weizen ins Lager,
// die Muenzen in den Geldbeutel, die Saat aufs Feld. Am Ziel hüpft, was es
// aufnimmt. `danach` laeuft, wenn der letzte Flieger angekommen ist — damit
// die Zahl oben erst dann springt, wenn das Gold wirklich da ist.
var fliegerZahl = 0;
function flugZu(von, ziel, html, art, anzahl, danach) {
  var v = rechteck(von);
  var z = rechteck(ziel);
  var zielEl = ziel && ziel.classList ? ziel : null;
  var fertig = function () { zielHuepft(zielEl); if (danach) danach(); };
  if (!v || !z || !v.width || !z.width || !html || magerModus() || fliegerZahl > 30) { fertig(); return; }

  var n = Math.max(1, Math.min(anzahl || 1, 5));
  var tx = z.left + z.width / 2;
  var ty = z.top + z.height / 2;
  for (var i = 0; i < n; i++) {
    (function (k) {
      var el = document.createElement('span');
      el.className = 'flieger' + (art ? ' ' + art : '');
      el.innerHTML = '<i>' + html + '</i>';
      var sx = v.left + v.width / 2 + (Math.random() - 0.5) * v.width * 0.5;
      var sy = v.top + v.height / 2 + (Math.random() - 0.5) * v.height * 0.4;
      el.style.left = Math.round(sx) + 'px';
      el.style.top = Math.round(sy) + 'px';
      el.style.setProperty('--dx', Math.round(tx - sx) + 'px');
      el.style.setProperty('--dy', Math.round(ty - sy) + 'px');
      el.style.animationDelay = (k * 70) + 'ms';
      el.firstChild.style.animationDelay = (k * 70) + 'ms';
      document.body.appendChild(el);
      fliegerZahl++;
      setTimeout(function () {
        el.remove();
        fliegerZahl--;
        if (k === n - 1) fertig();
      }, 640 + k * 70);
    })(i);
  }
}

// Die drei Wege, die es im Spiel gibt.
function warenFliegen(von, item, amount, deckel) {
  var n = Math.min(deckel || 4, Math.max(1, amount || 1));
  flugZu(von, $('silo'), itemIcon(item), 'ware', n);
}
function muenzenFliegen(von, gold, danach) {
  var n = gold >= 500 ? 5 : gold >= 100 ? 4 : gold >= 30 ? 3 : 2;
  flugZu(von, document.querySelector('.coins'), itemIcon(rules.currency), 'muenzen', n, danach);
}
function saatFliegt(plot, inputs) {
  if (!inputs || inputs.length === 0) return;
  var kachel = document.querySelector('#plots .plot[data-platz="' + plot + '"]');
  flugZu($('silo'), kachel || platzKasten(plot), itemIcon(inputs[0].item), 'saat', 1);
}

function klang(name) {
  if (sfxProz <= 0 || document.hidden) return;
  var ctx = tonBereit();
  if (!ctx || ctx.state !== 'running') return;
  klaengeEntpacken();
  var wahl = klangPuffer[name] ? name : 'tipp';
  try { spiele(wahl, 1, KLAENGE[wahl] == null ? 1 : KLAENGE[wahl]); } catch (e) {}
}

// Ernten im Zug: Mit jedem Platz steigt der Ton eine Halbtonstufe, gedeckelt,
// damit es am Ende nicht schrill wird. Dadurch klingt ein Zug wie eine Kette
// und nicht wie acht einzelne Ernten.
function ernteKlang(stufe) {
  if (sfxProz <= 0 || document.hidden) return;
  var ctx = tonBereit();
  if (!ctx || ctx.state !== 'running') return;
  klaengeEntpacken();
  var f = Math.pow(1.0595, Math.min(stufe, 12));
  try { spiele('ernte', f, KLAENGE.ernte); } catch (e) {}
}

document.addEventListener('pointerdown', function weck() {
  if (tonBereit()) klaengeEntpacken();
  document.removeEventListener('pointerdown', weck);
}, { once: true });

var flieger = 0;

function magerModus() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function zahlAuf(kasten, text, art) {
  // Ein Fund geht auch dann raus, wenn ueber dem Hof schon viele Zahlen
  // schweben — er ist der seltene Fall, den man nicht verpassen soll.
  if (!kasten || (flieger > 6 && art !== 'fund')) return;
  if (magerModus()) return;
  if (!kasten.width) return;

  var el = document.createElement('span');
  el.className = 'flug' + (art ? ' ' + art : '');
  el.textContent = text;
  el.style.left = Math.round(kasten.left + kasten.width / 2) + 'px';
  el.style.top = Math.round(kasten.top + kasten.height / 3) + 'px';
  document.body.appendChild(el);

  // Kleiner Funkenstoß beim Ernten und bei Münzen — macht Aktionen saftiger.
  if (art === 'ware' || art === 'muenzen' || art === 'fund') funken(kasten, art);

  flieger++;
  setTimeout(function () {
    el.remove();
    flieger--;
  }, 900);
}

function funken(kasten, art) {
  if (!kasten || !kasten.width || magerModus()) return;
  var farbe = art === 'muenzen' || art === 'fund' ? '#f4c430' : art === 'staub' ? '#c9b899' : '#7bbf5a';
  var cx = kasten.left + kasten.width / 2;
  var cy = kasten.top + kasten.height / 3;
  var n = art === 'fund' ? 12 : art === 'staub' ? 10 : 6;
  for (var i = 0; i < n; i++) {
    var f = document.createElement('span');
    f.className = 'funke';
    var winkel = (Math.PI * 2 * i) / n + Math.random() * 0.7;
    var weite = 20 + Math.random() * 22;
    f.style.left = Math.round(cx) + 'px';
    f.style.top = Math.round(cy) + 'px';
    f.style.setProperty('--dx', Math.round(Math.cos(winkel) * weite) + 'px');
    f.style.setProperty('--dy', Math.round(Math.sin(winkel) * weite - 8) + 'px');
    f.style.background = farbe;
    document.body.appendChild(f);
    (function (el) { setTimeout(function () { el.remove(); }, 660); })(f);
  }
}

function konfetti() {
  if (magerModus()) return;
  var farben = ['#f4c430', '#7bbf5a', '#e8734a', '#5aa9e6', '#c86bd6'];
  for (var i = 0; i < 26; i++) {
    var k = document.createElement('span');
    k.className = 'konfetti';
    k.style.left = Math.round(Math.random() * 100) + 'vw';
    k.style.background = farben[i % farben.length];
    k.style.animationDelay = (Math.random() * 0.25).toFixed(2) + 's';
    k.style.animationDuration = (1.1 + Math.random() * 0.9).toFixed(2) + 's';
    document.body.appendChild(k);
    (function (el) { setTimeout(function () { el.remove(); }, 2400); })(k);
  }
}

var stufeGesehen = -1;

function stufePruefen(v) {
  var jetzt = v.level;
  if (stufeGesehen < 0) { stufeGesehen = jetzt; return; }
  if (jetzt <= stufeGesehen) { stufeGesehen = jetzt; return; }
  var von = stufeGesehen;
  stufeGesehen = jetzt;
  for (var l = von + 1; l <= jetzt; l++) feiereStufe(l);
}

function plotIdName(id) {
  if (id.indexOf('field-') === 0) return { name: 'Feld ' + id.slice(6), art: 'Neues Feld' };
  if (id.indexOf('coop-') === 0) return { name: 'Hühnerstall', art: 'Neuer Stall' };
  if (id.indexOf('pasture-') === 0) return { name: 'Kuhweide', art: 'Neue Weide' };
  if (id.indexOf('sheep-') === 0) return { name: 'Schafweide', art: 'Neue Weide' };
  if (id === 'mill') return { name: 'Mühle', art: 'Neues Gebäude' };
  if (id === 'dairy') return { name: 'Molkerei', art: 'Neues Gebäude' };
  if (id === 'saftpresse') return { name: 'Saftpresse', art: 'Neues Gebäude' };
  return { name: nameOf(id), art: 'Neu' };
}

function feiereStufe(level) {
  var karte = NS.freischaltungenAb(rules, level);
  var zeilen = [];

  (karte.plots || []).forEach(function (id) {
    var pn = plotIdName(id);
    zeilen.push('<div class="zeile"><span class="mark">🔨</span><span>' + pn.name +
      '</span><span class="was">' + pn.art + '</span></div>');
  });
  (karte.recipes || []).forEach(function (i) {
    var r = rules.recipes[i];
    var id = r.output.item;
    zeilen.push('<div class="zeile">' + itemIcon(id) + '<span>' + itemName(id) +
      zutatenHtml(r.inputs, null, { klasse: 'klein' }) +
      '</span><span class="was">jetzt herstellbar</span></div>');
  });

  $('stufe-zahl').textContent = level;
  $('stufe-titel').textContent = 'Stufe erreicht!';
  $('stufe-neu').innerHTML = zeilen.slice(0, 4).join('');
  $('stufe-feier').hidden = false;

  klang('stufe');
  konfetti();
  if (navigator.vibrate) { try { navigator.vibrate([0, 40, 40, 60]); } catch (e) {} }

  if (feierTimer) clearTimeout(feierTimer);
  feierTimer = setTimeout(feierZu, 6000);
}

var feierTimer = null;
function feierZu() {
  if (feierTimer) { clearTimeout(feierTimer); feierTimer = null; }
  $('stufe-feier').hidden = true;
}

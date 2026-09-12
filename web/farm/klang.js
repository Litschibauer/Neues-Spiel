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
  return audio;
}

function sfxSetzen(p) {
  sfxProz = Math.max(0, Math.min(100, p | 0));
  try { localStorage.setItem('ns-sfx', String(sfxProz)); } catch (e) {}
  tonBereit(); // Kontext sicher anlegen/aufwecken, damit die Vorschau klingt.
  if (meister) meister.gain.value = sfxFaktor();
  if (sfxProz > 0) klang('tipp');
}

function stimme(form, von, nach, dauer, laut, ab) {
  var o = audio.createOscillator();
  var g = audio.createGain();
  var t = audio.currentTime + (ab || 0);

  o.type = form;
  o.frequency.setValueAtTime(von, t);
  if (nach !== von) o.frequency.exponentialRampToValueAtTime(nach, t + dauer);

  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(laut, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dauer);

  o.connect(g);
  g.connect(meister);
  o.start(t);
  o.stop(t + dauer + 0.02);
}

function rauschen(dauer, laut, farbe) {
  var rahmen = Math.floor(audio.sampleRate * dauer);
  var puffer = audio.createBuffer(1, rahmen, audio.sampleRate);
  var daten = puffer.getChannelData(0);
  for (var i = 0; i < rahmen; i++) {
    daten[i] = (Math.random() * 2 - 1) * (1 - i / rahmen);
  }
  var quelle = audio.createBufferSource();
  quelle.buffer = puffer;

  var filter = audio.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = farbe;
  filter.Q.value = 0.8;

  var g = audio.createGain();
  g.gain.value = laut;

  quelle.connect(filter);
  filter.connect(g);
  g.connect(meister);
  quelle.start(audio.currentTime);
}

var KLAENGE = {
  tipp: function () { stimme('sine', 620, 700, 0.06, 0.18); },

  saat: function () {
    rauschen(0.16, 0.5, 900);
    stimme('sine', 300, 480, 0.12, 0.16);
  },

  ernte: function () {
    stimme('triangle', 520, 780, 0.1, 0.3);
    stimme('triangle', 780, 1040, 0.12, 0.22, 0.07);
  },

  muenzen: function () {
    stimme('square', 1180, 1180, 0.05, 0.12);
    stimme('square', 1560, 1560, 0.06, 0.12, 0.05);
    stimme('square', 1980, 1980, 0.09, 0.1, 0.1);
  },

  kauf: function () {
    stimme('sine', 880, 660, 0.09, 0.24);
    stimme('sine', 440, 330, 0.14, 0.16, 0.05);
  },

  kiste: function () {
    rauschen(0.22, 0.35, 1600);
    stimme('triangle', 400, 900, 0.18, 0.24, 0.04);
    stimme('triangle', 900, 1400, 0.22, 0.2, 0.14);
  },

  wagen: function () {
    stimme('sawtooth', 160, 90, 0.5, 0.14);
    rauschen(0.4, 0.18, 420);
  },

  tier: function () {
    stimme('triangle', 700, 900, 0.08, 0.2);
    stimme('triangle', 900, 640, 0.12, 0.18, 0.08);
  },

  stufe: function () {
    stimme('triangle', 523, 523, 0.12, 0.26);
    stimme('triangle', 659, 659, 0.12, 0.26, 0.1);
    stimme('triangle', 784, 784, 0.22, 0.3, 0.2);
  },

  fehler: function () { stimme('sawtooth', 220, 150, 0.16, 0.16); },

  // Fundstueck: eine kleine Fanfare, heller als die Ernte und kuerzer als der
  // Stufenaufstieg. Sie soll den Kopf heben, ohne den Zug zu unterbrechen.
  fund: function () {
    stimme('triangle', 784, 784, 0.09, 0.24);
    stimme('triangle', 1046, 1046, 0.09, 0.26, 0.07);
    stimme('triangle', 1318, 1568, 0.2, 0.3, 0.14);
  },

  // Die Kiste geht auf: erst das Knarzen des Deckels, dann Glitzer.
  truhe: function () {
    stimme('sawtooth', 120, 95, 0.2, 0.12);
    rauschen(0.12, 0.08, 900);
    stimme('triangle', 880, 880, 0.08, 0.2, 0.24);
    stimme('triangle', 1108, 1108, 0.08, 0.22, 0.32);
    stimme('triangle', 1318, 1760, 0.28, 0.28, 0.4);
  },

  // Ein Erfolg wird faellig: drei steigende Toene, feierlich, aber kurz.
  erfolg: function () {
    stimme('triangle', 659, 659, 0.1, 0.24);
    stimme('triangle', 880, 880, 0.1, 0.24, 0.1);
    stimme('triangle', 1318, 1318, 0.28, 0.28, 0.2);
  },

  // Ein Zettel kippt ueber die Ziellinie: ein heller Doppelklang.
  zettel: function () {
    stimme('triangle', 988, 988, 0.07, 0.22);
    stimme('triangle', 1318, 1318, 0.16, 0.26, 0.09);
  },

  // Bauen: drei Hammerschlaege, Holz auf Holz, dann Staub.
  bau: function () {
    stimme('square', 190, 150, 0.05, 0.18);
    stimme('square', 200, 150, 0.05, 0.18, 0.14);
    stimme('square', 210, 160, 0.06, 0.2, 0.28);
    rauschen(0.22, 0.1, 700);
  },
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
  var mach = KLAENGE[name] || KLAENGE.tipp;
  try { mach(); } catch (e) {}
}

// Ernten im Zug: Mit jedem Platz steigt der Ton eine Halbtonstufe, gedeckelt,
// damit es am Ende nicht schrill wird. Dadurch klingt ein Zug wie eine Kette
// und nicht wie acht einzelne Ernten.
function ernteKlang(stufe) {
  if (sfxProz <= 0 || document.hidden) return;
  var ctx = tonBereit();
  if (!ctx || ctx.state !== 'running') return;
  var f = Math.pow(1.0595, Math.min(stufe, 12));
  try {
    stimme('triangle', 520 * f, 780 * f, 0.09, 0.26);
    stimme('triangle', 780 * f, 1040 * f, 0.1, 0.18, 0.06);
  } catch (e) {}
}

document.addEventListener('pointerdown', function weck() {
  tonBereit();
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

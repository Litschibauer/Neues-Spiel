var tonAn = localStorage.getItem('ns-ton') !== 'aus';
var audio = null;
var meister = null;

function tonBereit() {
  if (!tonAn) return null;
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
  meister.gain.value = 0.22;
  meister.connect(audio.destination);
  return audio;
}

function tonSchalten(an) {
  tonAn = an;
  localStorage.setItem('ns-ton', an ? 'an' : 'aus');
  if (an) { tonBereit(); klang('tipp'); }
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
};

function klang(name) {
  if (!tonAn || document.hidden) return;
  var ctx = tonBereit();
  if (!ctx || ctx.state !== 'running') return;
  var mach = KLAENGE[name] || KLAENGE.tipp;
  try { mach(); } catch (e) {}
}

document.addEventListener('pointerdown', function weck() {
  tonBereit();
  document.removeEventListener('pointerdown', weck);
}, { once: true });

var flieger = 0;

function zahlAuf(kasten, text, art) {
  if (!kasten || flieger > 6) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!kasten.width) return;

  var el = document.createElement('span');
  el.className = 'flug' + (art ? ' ' + art : '');
  el.textContent = text;
  el.style.left = Math.round(kasten.left + kasten.width / 2) + 'px';
  el.style.top = Math.round(kasten.top + kasten.height / 3) + 'px';
  document.body.appendChild(el);

  flieger++;
  setTimeout(function () {
    el.remove();
    flieger--;
  }, 900);
}

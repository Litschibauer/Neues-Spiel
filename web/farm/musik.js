// Sanfte Hintergrundmusik als Playlist, komplett getrennt von den Soundeffekten.
// Eigene Lautstärke in Prozent (Merker ns-musik-vol); der Server liefert die
// Titelliste über /musik/ und jeden Track unter /musik/<datei>.
var musikVol = (function () {
  var v = parseInt(localStorage.getItem('ns-musik-vol'), 10);
  if (!isNaN(v)) return Math.max(0, Math.min(100, v));
  return localStorage.getItem('ns-musik') === 'aus' ? 0 : 60; // Migration alter Schalter
})();
var MUSIK_BASIS = 0.55; // 100 % ⇒ Element-Volume 0.55
function musikLaut() { return (musikVol / 100) * MUSIK_BASIS; }
function musikAktiv() { return musikVol > 0; }
var ostEl = null;
var ostGestartet = false;
var ostKaputt = false;
var liste = [];
var listeGeladen = false;
var pos = 0;

function mische(a) {
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function musikEl() {
  if (ostEl) return ostEl;
  ostEl = new Audio();
  ostEl.preload = 'none';
  ostEl.volume = 0;
  ostEl.addEventListener('ended', naechster);
  // Ein kaputter Track soll die Playlist nicht stoppen — einfach weiter.
  ostEl.addEventListener('error', function () { if (musikAktiv() && ostGestartet) naechster(); });
  return ostEl;
}

function trackName(datei) {
  return (typeof MUSIK_NAMEN === 'object' && MUSIK_NAMEN[datei]) || 'Musik';
}

function spiele(index) {
  if (!liste.length) return;
  pos = ((index % liste.length) + liste.length) % liste.length;
  var el = musikEl();
  el.src = '/musik/' + encodeURIComponent(liste[pos]);
  el.volume = 0;
  var p = el.play();
  if (p && p.catch) p.catch(function () {});
  musikFade(musikLaut(), 1400);
  barMalen();
}

function naechster() { spiele(pos + 1); }

// Kleine, dezente Musikleiste: Titel + Zurück/Pause/Weiter.
function barMalen() {
  var bar = document.getElementById('musikbar');
  if (!bar) return;
  var zeig = musikAktiv() && ostGestartet && !ostKaputt && liste.length > 0;
  bar.hidden = !zeig;
  if (!zeig) return;
  var name = document.getElementById('musik-name');
  if (name) name.textContent = trackName(liste[pos]);
  var play = document.getElementById('musik-play');
  if (play) {
    var pausiert = !ostEl || ostEl.paused;
    play.textContent = pausiert ? '▶' : '⏸';
    play.setAttribute('aria-label', pausiert ? 'Weiter' : 'Pause');
  }
}

function musikPlayPause() {
  if (!ostGestartet) { musikStart(); return; }
  if (!ostEl) return;
  if (ostEl.paused) { ostEl.play().catch(function () {}); musikFade(musikLaut(), 400); }
  else { ostEl.pause(); }
  barMalen();
}

function musikVor() { if (liste.length) spiele(pos - 1); }
function musikNext() { if (liste.length) naechster(); }

function musikFade(ziel, dauer) {
  if (!ostEl) return;
  var start = ostEl.volume;
  var t0 = performance.now();
  (function tick(t) {
    var k = dauer > 0 ? Math.min(1, (t - t0) / dauer) : 1;
    try { ostEl.volume = Math.max(0, Math.min(1, start + (ziel - start) * k)); } catch (e) {}
    if (k < 1) requestAnimationFrame(tick);
  })(performance.now());
}

function musikStart() {
  if (!musikAktiv() || ostGestartet || ostKaputt) return;
  ostGestartet = true;
  if (listeGeladen) { if (liste.length) spiele(0); return; }
  fetch(serverPfad('/musik/')).then(function (r) { return r.ok ? r.json() : { tracks: [] }; })
    .then(function (d) {
      listeGeladen = true;
      liste = mische((d && d.tracks) || []);
      if (liste.length) spiele(0); else ostKaputt = true;
    })
    .catch(function () { listeGeladen = true; ostKaputt = true; });
}

function musikLautSetzen(p) {
  musikVol = Math.max(0, Math.min(100, p | 0));
  try { localStorage.setItem('ns-musik-vol', String(musikVol)); } catch (e) {}
  if (musikVol > 0) {
    if (!ostGestartet) musikStart();
    else if (ostEl) {
      if (ostEl.paused) ostEl.play().catch(function () {});
      ostEl.volume = musikLaut(); // live, ohne Blende, damit man den Regler hört
    }
  } else if (ostEl) {
    ostEl.pause();
  }
  barMalen();
}

// Bei ausgeblendetem Tab pausieren, beim Zurückkommen weiterspielen (wenn an).
document.addEventListener('visibilitychange', function () {
  if (!ostEl || !musikAktiv() || ostKaputt) return;
  if (document.hidden) ostEl.pause();
  else ostEl.play().catch(function () {});
});

// Musik nach der ersten Geste anwerfen (Autoplay-Politik der Browser).
document.addEventListener('pointerdown', function weckMusik() {
  musikStart();
  document.removeEventListener('pointerdown', weckMusik);
}, { once: true });

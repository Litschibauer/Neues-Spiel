// Sanfte Hintergrundmusik als Playlist. Der Server liefert die Titelliste über
// /musik/ und jeden Track unter /musik/<datei>. Wir mischen die Liste und spielen
// Titel für Titel; getrennt vom Ton-Schalter, eigener Merker ns-musik.
var musikAn = localStorage.getItem('ns-musik') !== 'aus';
var ostEl = null;
var ostGestartet = false;
var ostKaputt = false;
var OST_LAUT = 0.32;
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
  ostEl.addEventListener('error', function () { if (musikAn && ostGestartet) naechster(); });
  return ostEl;
}

function spiele(index) {
  if (!liste.length) return;
  pos = ((index % liste.length) + liste.length) % liste.length;
  var el = musikEl();
  el.src = '/musik/' + encodeURIComponent(liste[pos]);
  el.volume = 0;
  var p = el.play();
  if (p && p.catch) p.catch(function () {});
  musikFade(OST_LAUT, 1400);
}

function naechster() { spiele(pos + 1); }

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
  if (!musikAn || ostGestartet || ostKaputt) return;
  ostGestartet = true;
  if (listeGeladen) { if (liste.length) spiele(0); return; }
  fetch('/musik/').then(function (r) { return r.ok ? r.json() : { tracks: [] }; })
    .then(function (d) {
      listeGeladen = true;
      liste = mische((d && d.tracks) || []);
      if (liste.length) spiele(0); else ostKaputt = true;
    })
    .catch(function () { listeGeladen = true; ostKaputt = true; });
}

function musikSchalten(an) {
  musikAn = an;
  try { localStorage.setItem('ns-musik', an ? 'an' : 'aus'); } catch (e) {}
  if (an) {
    if (!ostGestartet) musikStart();
    else if (ostEl) { ostEl.play().catch(function () {}); musikFade(OST_LAUT, 700); }
  } else if (ostEl) {
    musikFade(0, 450);
    setTimeout(function () { if (!musikAn && ostEl) ostEl.pause(); }, 480);
  }
}

// Bei ausgeblendetem Tab pausieren, beim Zurückkommen weiterspielen (wenn an).
document.addEventListener('visibilitychange', function () {
  if (!ostEl || !musikAn || ostKaputt) return;
  if (document.hidden) ostEl.pause();
  else ostEl.play().catch(function () {});
});

// Musik nach der ersten Geste anwerfen (Autoplay-Politik der Browser).
document.addEventListener('pointerdown', function weckMusik() {
  musikStart();
  document.removeEventListener('pointerdown', weckMusik);
}, { once: true });

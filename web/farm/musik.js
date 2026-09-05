// Sanfte Hintergrundmusik (optional). Spielt /OST.mp3, sobald der Server eine
// Datei web/OST.mp3 ausliefert — nach der ersten Nutzer-Geste (Autoplay-Regeln).
// Getrennt vom Ton-Schalter, eigener Merker ns-musik.
var musikAn = localStorage.getItem('ns-musik') !== 'aus';
var ostEl = null;
var ostGestartet = false;
var ostKaputt = false;
var OST_LAUT = 0.32;

function musikBereit() {
  if (ostEl || ostKaputt) return ostEl;
  ostEl = new Audio('/OST.mp3');
  ostEl.loop = true;
  ostEl.preload = 'none';
  ostEl.volume = 0;
  ostEl.addEventListener('error', function () { ostKaputt = true; });
  return ostEl;
}

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
  var el = musikBereit();
  if (!el) return;
  var p = el.play();
  if (p && p.catch) p.catch(function () {});
  ostGestartet = true;
  musikFade(OST_LAUT, 1400);
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

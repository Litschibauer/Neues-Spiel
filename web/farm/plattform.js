// EINE Codebasis, saubere Trennung.
//
// Dieselbe Web-App läuft überall: im Desktop-Browser, im Handy-Browser, als
// installierte PWA und später in der iOS-Hülle (Capacitor/WKWebView). Es gibt
// bewusst KEINE zwei Forks „Desktop" vs. „App" — die würden garantiert
// auseinanderlaufen. Stattdessen passt sich das Layout zur Laufzeit an
// (Hoch-/Querformat über die Kamera) und app-spezifisches Verhalten hängt an
// GENAU EINEM Schalter hier. So kann nichts aus der App in die Browser-Version
// lecken (oder umgekehrt).
//
// Nutzung:
//   • CSS:  [data-plattform="app"] .nurInApp { … }   /  [data-plattform="browser"] …
//   • JS:   if (istApp()) { … }
function istStandalone() {
  try {
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
    if (window.navigator && window.navigator.standalone === true) return true; // iOS-Safari-PWA
    if (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function') {
      return window.Capacitor.isNativePlatform();
    }
  } catch (e) { /* egal */ }
  return false;
}

// „App" = native Hülle oder installierte PWA im Vollbild. Alles andere ist die
// normale Browser-/Desktop-Version.
function istApp() { return istStandalone(); }

(function () {
  var el = document.documentElement;
  el.setAttribute('data-plattform', istApp() ? 'app' : 'browser');
})();

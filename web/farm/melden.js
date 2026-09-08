// Benachrichtigungen. Der Browser gibt uns ein Abo (Endpunkt + zwei Schlüssel),
// das schicken wir dem Server. Verschlüsselt wird serverseitig für genau dieses
// Gerät, der Push-Dienst sieht den Inhalt nie.
//
// Zwei Dinge sind wichtig: Um Erlaubnis wird erst gefragt, wenn der Spieler den
// Schalter umlegt (nie beim Start), und ein Abo wird bei jedem Start erneuert,
// weil der Browser es jederzeit austauschen darf.

// In der nativen App läuft der Weg über Apple, nicht über Web-Push: Apple
// unterstützt Web-Push nur für PWAs auf dem Startbildschirm, nicht in der
// WKWebView einer App. Capacitor liefert uns dort ein Geräte-Token.
function meldenNativ() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform &&
    window.Capacitor.isNativePlatform() &&
    window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications);
}

var meldenBereit = meldenNativ() ||
  ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window);

function meldenStand() {
  if (!meldenBereit) return 'geht-nicht';
  if (!meldenNativ() && Notification.permission === 'denied') return 'blockiert';
  try { return localStorage.getItem('ns-melden') === 'an' ? 'an' : 'aus'; } catch (e) { return 'aus'; }
}

function meldenMerken(an) {
  try { localStorage.setItem('ns-melden', an ? 'an' : 'aus'); } catch (e) {}
}

// base64url → Uint8Array, das erwartet applicationServerKey.
function schluesselBytes(text) {
  var roh = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  var bytes = new Uint8Array(roh.length);
  for (var i = 0; i < roh.length; i++) bytes[i] = roh.charCodeAt(i);
  return bytes;
}

function meldenAbo(reg) {
  return reg.pushManager.getSubscription().then(function (vorhanden) {
    if (vorhanden) return vorhanden;
    return fetch(serverPfad('/api/push/schluessel'))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        return reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: schluesselBytes(d.key),
        });
      });
  });
}

// Native App: um Erlaubnis fragen, registrieren, und das Token, das Apple uns
// über den 'registration'-Rückruf gibt, an den Server schicken.
function meldenAnmeldenNativ() {
  var Push = window.Capacitor.Plugins.PushNotifications;
  return Push.requestPermissions().then(function (erg) {
    if (!erg || erg.receive !== 'granted') return 'blockiert';
    return new Promise(function (fertig) {
      var erledigt = false;
      Push.addListener('registration', function (t) {
        if (erledigt) return;
        erledigt = true;
        fetch(serverPfad('/api/push/abo'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
          body: JSON.stringify({ art: 'ios', token: String(t && t.value ? t.value : '') }),
        })
          .then(function () { meldenMerken(true); fertig('an'); })
          .catch(function () { fertig('fehler'); });
      });
      Push.addListener('registrationError', function () {
        if (erledigt) return;
        erledigt = true;
        fertig('fehler');
      });
      Push.register();
      // Kommt binnen zehn Sekunden nichts, hat die App keine Push-Berechtigung
      // im Profil — dann lieber ehrlich scheitern als ewig warten.
      setTimeout(function () { if (!erledigt) { erledigt = true; fertig('fehler'); } }, 10000);
    });
  }).catch(function () { return 'fehler'; });
}

function meldenAnmelden() {
  if (!meldenBereit) return Promise.resolve('geht-nicht');
  if (meldenNativ()) return meldenAnmeldenNativ();
  return Notification.requestPermission()
    .then(function (erlaubnis) {
      if (erlaubnis !== 'granted') return 'blockiert';
      return navigator.serviceWorker.ready
        .then(meldenAbo)
        .then(function (abo) {
          return fetch(serverPfad('/api/push/abo'), {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
            body: JSON.stringify(abo),
          });
        })
        .then(function () { meldenMerken(true); return 'an'; });
    })
    .catch(function () { return 'fehler'; });
}

function meldenAbmelden() {
  meldenMerken(false);
  if (!meldenBereit) return Promise.resolve('aus');
  if (meldenNativ()) {
    // Auf dem Gerät bleibt die Registrierung; der Server hört einfach auf zu
    // senden, sobald das Abo weg ist. Genau dafür merkt sich der Schalter den
    // Stand lokal.
    return Promise.resolve('aus');
  }
  return navigator.serviceWorker.ready
    .then(function (reg) { return reg.pushManager.getSubscription(); })
    .then(function (abo) {
      if (!abo) return null;
      return fetch(serverPfad('/api/push/abo?endpoint=' + encodeURIComponent(abo.endpoint)), {
        method: 'DELETE',
        headers: { authorization: 'Bearer ' + token },
      }).then(function () { return abo.unsubscribe(); });
    })
    .then(function () { return 'aus'; })
    .catch(function () { return 'aus'; });
}

// Beim Start still auffrischen: Der Browser darf ein Abo jederzeit austauschen,
// dann kennt der Server den neuen Endpunkt noch nicht.
function meldenAuffrischen() {
  if (!meldenBereit || meldenStand() !== 'an' || !token) return;
  if (meldenNativ()) {
    // Apple darf das Token austauschen — einmal neu registrieren, der Server
    // legt es unter demselben Hof ab.
    meldenAnmeldenNativ();
    return;
  }
  if (Notification.permission !== 'granted') return;
  navigator.serviceWorker.ready
    .then(meldenAbo)
    .then(function (abo) {
      return fetch(serverPfad('/api/push/abo'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify(abo),
      });
    })
    .catch(function () {});
}

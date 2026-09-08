// Benachrichtigungen. Der Browser gibt uns ein Abo (Endpunkt + zwei Schlüssel),
// das schicken wir dem Server. Verschlüsselt wird serverseitig für genau dieses
// Gerät, der Push-Dienst sieht den Inhalt nie.
//
// Zwei Dinge sind wichtig: Um Erlaubnis wird erst gefragt, wenn der Spieler den
// Schalter umlegt (nie beim Start), und ein Abo wird bei jedem Start erneuert,
// weil der Browser es jederzeit austauschen darf.

var meldenBereit = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function meldenStand() {
  if (!meldenBereit) return 'geht-nicht';
  if (Notification.permission === 'denied') return 'blockiert';
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
    return fetch('/api/push/schluessel')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        return reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: schluesselBytes(d.key),
        });
      });
  });
}

function meldenAnmelden() {
  if (!meldenBereit) return Promise.resolve('geht-nicht');
  return Notification.requestPermission()
    .then(function (erlaubnis) {
      if (erlaubnis !== 'granted') return 'blockiert';
      return navigator.serviceWorker.ready
        .then(meldenAbo)
        .then(function (abo) {
          return fetch('/api/push/abo', {
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
  return navigator.serviceWorker.ready
    .then(function (reg) { return reg.pushManager.getSubscription(); })
    .then(function (abo) {
      if (!abo) return null;
      return fetch('/api/push/abo?endpoint=' + encodeURIComponent(abo.endpoint), {
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
  if (!meldenBereit || meldenStand() !== 'an' || Notification.permission !== 'granted') return;
  if (!token) return;
  navigator.serviceWorker.ready
    .then(meldenAbo)
    .then(function (abo) {
      return fetch('/api/push/abo', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify(abo),
      });
    })
    .catch(function () {});
}

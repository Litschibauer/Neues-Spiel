var NS = globalThis.NeuesSpiel;
var $ = function (id) { return document.getElementById(id); };

var CLOCK_SAFETY_TICKS = 2;

var token = localStorage.getItem('ns-token') || '';
var deviceId = localStorage.getItem('ns-device');
if (!deviceId) {
  deviceId = 'd-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  localStorage.setItem('ns-device', deviceId);
}

var isActive = true;
var client = null, engine = null, rules = null, accountId = null;
var clockOffsetMs = 0;
var view = 'farm';
var bauModus = false;
// Normalerweise liegt die Oberfläche auf demselben Server wie die API, dann
// bleibt die Basis leer. In einer gebündelten App (App Store) liegt sie lokal
// auf dem Gerät und der Server steht woanders; dann setzt die Hülle vor dem
// Laden window.NEUES_SPIEL_SERVER.
var NS_BASIS = (function () {
  var s = window.NEUES_SPIEL_SERVER;
  return s ? String(s).replace(/\/+$/, '') : '';
})();

// Adresse einer Server-Ressource.
function serverPfad(pfad) {
  return NS_BASIS + pfad;
}

// Der Spielstand hängt am Server, nicht am Ort der Oberfläche — sonst hätte
// dieselbe Farm in App und Browser zwei getrennte Sicherungen.
var SAVE_KEY = NS.storageKeyFor(NS_BASIS || location.origin);

function save() {
  if (!client) return;
  // Jeder Spielzug ist zugleich ein Lebenszeichen: Daran misst der Empfang,
  // wie lange der Hof allein gearbeitet hat.
  merkeDa();
  try {
    localStorage.setItem(
      SAVE_KEY,
      JSON.stringify(NS.serializeClient(client, clockOffsetMs, accountId)),
    );
  } catch (e) {
    toast('Konnte nicht sichern: ' + e.message, true);
  }
}

function loadSaved() {
  var raw = null;
  try { raw = localStorage.getItem(SAVE_KEY); } catch (e) { return null; }
  if (!raw) return null;
  try { return NS.restoreClient(JSON.parse(raw)); } catch (e) { return null; }
}

var toastTimer = null;
// Eine Meldung kann einen Weg anbieten: Mit `weiter` wird sie antippbar und
// bleibt dafuer etwas laenger stehen. Ohne bleibt sie, was sie war.
var toastWeiter = null;
// Wann die letzte Meldung kam — Momente warten, statt eine frische zu
// ueberschreiben.
var toastSeit = 0;
function toast(message, bad, weiter) {
  var el = $('toast');
  toastSeit = Date.now();
  el.textContent = message;
  toastWeiter = typeof weiter === 'function' ? weiter : null;
  el.className = 'toast show' + (bad ? ' bad' : '') + (toastWeiter ? ' tippbar' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    el.className = 'toast';
    toastWeiter = null;
  }, toastWeiter ? 3400 : 2200);
}
$('toast').addEventListener('click', function () {
  if (!toastWeiter) return;
  var weiter = toastWeiter;
  toastWeiter = null;
  clearTimeout(toastTimer);
  $('toast').className = 'toast';
  weiter();
});

function api(path, options) {
  options = options || {};
  options.headers = Object.assign({ authorization: 'Bearer ' + token }, options.headers || {});
  return fetch(serverPfad(path), options).then(function (res) {
    if (res.status === 401) throw new Error('UNAUTHORIZED');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  });
}

var transport = function (request) {
  return api('/api/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
};

var liveAbort = null;
var liveRetryMs = 1000;

function stopLive() {
  if (liveAbort) { liveAbort.abort(); liveAbort = null; }
}

function startLive() {
  stopLive();
  if (!token || !navigator.onLine || typeof AbortController !== 'function') return;

  var ctl = new AbortController();
  liveAbort = ctl;

  fetch(serverPfad('/api/events'), {
    headers: { authorization: 'Bearer ' + token, accept: 'text/event-stream' },
    signal: ctl.signal,
    cache: 'no-store',
  }).then(function (res) {
    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
    liveRetryMs = 1000;
    if (engine) { engine.revive(); attempt(true); }

    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';

    function pump() {
      return reader.read().then(function (chunk) {
        if (chunk.done) throw new Error('stream ended');
        buffer += decoder.decode(chunk.value, { stream: true });

        var parts = buffer.split('\n\n');
        buffer = parts.pop();
        parts.forEach(function (block) {
          if (block.indexOf('event: nudge') !== 0) return;
          var arten = '';
          block.split('\n').forEach(function (zeile) {
            if (zeile.indexOf('data:') === 0) arten = zeile.slice(5).trim();
          });
          onNudge(arten);
        });
        return pump();
      });
    }
    return pump();
  }).catch(function () {
    if (ctl.signal.aborted) return;
    liveAbort = null;

    var wait = liveRetryMs * (0.5 + Math.random());
    setTimeout(startLive, wait);
    liveRetryMs = Math.min(liveRetryMs * 2, 8000);
  });
}

var nudgeTimer = null;
function onNudge(arten) {
  // Ein Geschenk kuendigt sich mit eigener Art an — dann holen wir nach, von wem.
  if (String(arten).indexOf('geschenk') >= 0 && typeof geschenkeHolen === 'function') geschenkeHolen();
  if ((arten || '').indexOf('sozial') >= 0) sozialFrisch();

  if (nudgeTimer) return;
  nudgeTimer = setTimeout(function () {
    nudgeTimer = null;
    attempt(true);
    sozialFrisch();
  }, 40);
}

function sozialFrisch() {
  if (typeof view === 'undefined') return;
  if (view === 'freunde') freundeLaden();
  else if (view === 'besuch' || view === 'fremdstand') besuchHolen();
}

function tickNow() {
  var snap = client.snapshotMeta;
  var serverNow = Date.now() + clockOffsetMs;
  var elapsed = Math.floor((serverNow - snap.serverTs) / 1000);
  return snap.tick + Math.max(0, elapsed - CLOCK_SAFETY_TICKS);
}

function adopt(snapshot, serverTime) {
  if (typeof serverTime === 'number') clockOffsetMs = serverTime - Date.now();
  client.adopt(snapshot);
  client.snapshotMeta = { tick: snapshot.state.tick, serverTs: snapshot.serverTs };
  save();
}

function afterSync(snapshot, serverTime) {
  if (typeof serverTime === 'number') clockOffsetMs = serverTime - Date.now();
  client.snapshotMeta = { tick: snapshot.state.tick, serverTs: snapshot.serverTs };
  save();
}

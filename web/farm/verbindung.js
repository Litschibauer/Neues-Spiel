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
var SAVE_KEY = NS.storageKeyFor(location.origin);

function save() {
  if (!client) return;
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
function toast(message, bad) {
  var el = $('toast');
  el.textContent = message;
  el.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.className = 'toast'; }, 2200);
}

function api(path, options) {
  options = options || {};
  options.headers = Object.assign({ authorization: 'Bearer ' + token }, options.headers || {});
  return fetch(path, options).then(function (res) {
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

  fetch('/api/events', {
    headers: { authorization: 'Bearer ' + token, accept: 'text/event-stream' },
    signal: ctl.signal,
    cache: 'no-store',
  }).then(function (res) {
    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
    liveRetryMs = 1000;

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
          if (block.indexOf('event: nudge') === 0) onNudge();
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
    liveRetryMs = Math.min(liveRetryMs * 2, 60000);
  });
}

var nudgeTimer = null;
function onNudge() {
  if (nudgeTimer) return;
  nudgeTimer = setTimeout(function () {
    nudgeTimer = null;
    attempt(true);
  }, Math.floor(Math.random() * 500));
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

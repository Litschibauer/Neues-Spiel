function setConn(state, weak) {
  var el = $('conn');
  if (state === 'live') { el.className = 'conn live'; $('conn-text').textContent = 'verbunden'; }
  else if (state === 'catching-up') { el.className = 'conn'; $('conn-text').textContent = 'synchronisiert…'; }
  else if (weak) { el.className = 'conn off'; $('conn-text').textContent = 'Netz zu schwach — läuft weiter'; }
  else { el.className = 'conn off'; $('conn-text').textContent = 'ohne Netz — läuft weiter'; }
}

function setLease(active, since) {
  isActive = active;
  $('lease').hidden = active;
  if (!active) {
    var ago = since ? Math.round((Date.now() - since) / 1000) : null;
    $('lease-text').textContent =
      'Ein anderes Gerät spielt gerade diesen Hof' +
      (ago !== null ? ' (zuletzt vor ' + ago + ' s)' : '') +
      '. Aktionen sind hier gesperrt, damit nichts entsteht, was später verworfen wird.';
  }
}

function refreshLease() {
  return api('/api/state?deviceId=' + encodeURIComponent(deviceId))
    .then(function (data) {
      var wasActive = isActive;
      setLease(data.isActiveDevice !== false, data.activeSince);
      if (wasActive && !isActive) toast('Anderes Gerät hat übernommen', true);
    })
    .catch(function () {  });
}

function attempt(force) {
  if (!engine) return;
  client.localTick = tickNow();
  engine.attempt(Date.now(), force === true).then(function (outcome) {
    setConn(engine.view);
    if (outcome.kind === 'synced') {
      var r = outcome.result;
      if (!r.ok && r.reason === 'NOT_ACTIVE_DEVICE') {
        setLease(false, null);
      } else if (!r.ok) {
        toast(r.reason === 'RULESET_MISMATCH' ? 'Bitte neu laden — neue Version' : 'Server hat abgelehnt', true);
      }
      if (r.ok || r.reason !== 'NOT_ACTIVE_DEVICE') afterSync(r.snapshot, r.serverTime);
      if (r.ok) { setLease(true, null); client.takeover = false; }
    } else if (outcome.kind === 'failed') {
      setConn('offline', outcome.timedOut);
      return;
    } else if (outcome.kind === 'dropped') {
      toast(/OFFER_GONE/.test(outcome.reason || '') ? 'Jemand war schneller' : 'Teil verworfen', true);
      afterSync(outcome.snapshot, outcome.serverTime);
    }
    render();
  }).catch(function () { setConn('offline'); });
}

function show(next) {
  view = next;
  ['brett', 'lager', 'stand', 'rest'].forEach(function (name) {
    $(name + '-bg').hidden = name !== next;
  });
  render();
}

['brett', 'lager', 'stand', 'rest'].forEach(function (name) {
  $(name + '-close').addEventListener('click', function () { show('farm'); });
  $(name + '-bg').addEventListener('click', function (e) {
    if (e.target === $(name + '-bg')) show('farm');
  });
});
$('brett').addEventListener('click', function () { show('brett'); });
$('lagerhaus').addEventListener('click', function () { show('lager'); });
$('stand').addEventListener('click', function () { show('stand'); });
$('zahnrad').addEventListener('click', function () { show('rest'); });

function begin(restored) {
  client = restored;
  rules = NS.getRuleset(client.rulesetVersion);
  engine = new NS.SyncEngine(client, transport, { baseDelayMs: 2000, maxDelayMs: 30000 });

  client.snapshotMeta = {
    tick: client.baseSnapshot.state.tick,
    serverTs: client.baseSnapshot.serverTs,
  };

  $('gate').hidden = true;
  $('keygate').hidden = true;
  $('shell').hidden = false;

  render();
  setInterval(render, 1000);
  setInterval(function () { attempt(false); }, 4000);
  setInterval(refreshLease, 15000);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stopLive();
    } else {
      attempt(true);
      refreshLease();
      startLive();
    }
  });
  window.addEventListener('online', function () { render(); attempt(true); startLive(); });
  window.addEventListener('offline', function () { setConn('offline'); stopLive(); render(); });
  window.addEventListener('pagehide', function () { save(); stopLive(); });
  startLive();
}

function start(snapshot, serverTime, id) {
  accountId = id || accountId;
  begin(new NS.Client(snapshot, deviceId));
  adopt(snapshot, serverTime);
  setConn('live');
  render();
}

function startOffline(saved) {
  clockOffsetMs = saved.clockOffsetMs;
  accountId = saved.accountId || null;
  begin(saved.client);
  setConn(navigator.onLine ? 'catching-up' : 'offline');
  render();
  attempt(true);
  refreshLease();
}

function connect() {
  token = $('key').value.trim();
  if (!token) return;
  $('connect').disabled = true;
  api('/api/state?deviceId=' + encodeURIComponent(deviceId)).then(function (data) {
    localStorage.setItem('ns-token', token);
    start(data.snapshot, data.serverTime, data.accountId);
    setLease(data.isActiveDevice !== false, data.activeSince);
  }).catch(function (e) {
    $('connect').disabled = false;
    toast(e.message === 'UNAUTHORIZED' ? 'Diesen Schlüssel kennt der Server nicht' : 'Server nicht erreichbar', true);
  });
}

var pendingStart = null;
$('create').addEventListener('click', function () {
  $('create').disabled = true;
  fetch('/api/account', { method: 'POST' })
    .then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body.error || 'HTTP ' + r.status);
        return body;
      });
    })
    .then(function (data) {
      token = data.key;
      localStorage.setItem('ns-token', token);
      pendingStart = data;
      $('keyvalue').textContent = data.key;
      $('gate').hidden = true;
      $('keygate').hidden = false;
    })
    .catch(function (e) {
      $('create').disabled = false;
      toast(e.message === 'TOO_MANY_NEW_FARMS' ? 'Zu viele neue Höfe von hier'
        : e.message === 'SERVER_FULL' ? 'Der Server ist voll'
        : 'Konnte keinen Hof anlegen', true);
    });
});
$('keycopy').addEventListener('click', function () {
  var text = $('keyvalue').textContent;
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { toast('Kopiert'); });
  else window.prompt('Schlüssel kopieren:', text);
});
$('keydone').addEventListener('click', function () {
  start(pendingStart.snapshot, pendingStart.serverTime, pendingStart.accountId);
  setLease(true, null);
});
$('connect').addEventListener('click', connect);
$('key').addEventListener('keydown', function (e) { if (e.key === 'Enter') connect(); });
$('takeover').addEventListener('click', function () {
  client.takeover = true;
  setLease(true, null);
  toast('Übernahme gilt ab der nächsten Aktion');
});
$('forget').addEventListener('click', function () {
  if (!confirm('Schlüssel und lokalen Stand von diesem Gerät löschen?\n\nOhne notierten Schlüssel ist der Hof damit weg.')) return;
  localStorage.removeItem('ns-token');
  try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
  location.reload();
});

var saved = token ? loadSaved() : null;
if (saved) startOffline(saved);
else if (token) { $('key').value = token; connect(); }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(function () {
  });

  var reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (reloading) return;
    reloading = true;

    var tryReload = function () {
      if (client && client.queue.length > 0) {
        setTimeout(tryReload, 1000);
        return;
      }
      save();
      location.reload();
    };
    tryReload();
  });
}

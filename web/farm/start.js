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

// Der Server weist den gespeicherten Schlüssel dauerhaft ab (401). Dann taugt
// der Token nicht (mehr) für diesen Hof — z. B. weil er überschrieben wurde.
// Statt still offline zu bleiben, das Anmeldefenster zeigen, damit man den
// richtigen Hof-Schlüssel neu eingeben kann.
function braucheAnmeldung() {
  stopLive();
  $('shell').hidden = true;
  $('keygate').hidden = true;
  $('gate').hidden = false;
  $('connect').disabled = false;
  $('key').value = '';
  toast('Bitte deinen Hof-Schlüssel eingeben', true);
}

function refreshLease() {
  return api('/api/state?deviceId=' + encodeURIComponent(deviceId))
    .then(function (data) {
      var wasActive = isActive;
      setLease(data.isActiveDevice !== false, data.activeSince);
      if (wasActive && !isActive) toast('Anderes Gerät hat übernommen', true);
    })
    .catch(function (e) {
      if (e && e.message === 'UNAUTHORIZED') braucheAnmeldung();
    });
}

var ONLINE_NUR = { freunde: 1, besuch: 1, fremdstand: 1, stand: 1, bonus: 1 };

function netzOk() {
  if (!navigator.onLine) return false;
  return !engine || engine.view !== 'offline';
}

function netzWache() {
  if (!ONLINE_NUR[view] || netzOk()) return false;
  toast('Ohne Verbindung geht das nicht — zurück auf deinen Hof', true);
  klang('fehler');
  show('farm');
  return true;
}

// Gibt die laufende Abgleich-Zusage zurueck, damit ein Aufrufer darauf warten
// kann — der Empfang etwa, der die Post erst leert, wenn der Tagesbonus da ist.
function attempt(force) {
  if (!engine) return Promise.resolve();
  client.localTick = tickNow();
  // Die Sicht von eben aufheben: Daran erkennen die Momente, was der Abgleich
  // gebracht hat — etwa die Beute einer Kiste.
  var vorher = NS.farmView(client.preview(), rules, navigator.onLine);
  return engine.attempt(Date.now(), force === true).then(function (outcome) {
    setConn(engine.view);
    if (outcome.kind === 'synced') {
      var r = outcome.result;
      if (!r.ok && r.reason === 'NOT_ACTIVE_DEVICE') {
        setLease(false, null);
      } else if (!r.ok) {
        if (r.reason === 'RULESET_MISMATCH') { neueVersionLaden(); return; }
        // Vorgehende Geräteuhr ist kein Fehler des Spielers: Die Sync-Maschine
        // hat die Arbeit schon auf die Serverzeit umdatiert, der nächste
        // Anlauf bringt sie durch. Kein Alarm, nur gleich nochmal versuchen.
        if (r.reason === 'CLOCK_AHEAD_OF_SERVER') {
          afterSync(r.snapshot, r.serverTime);
          render();
          setTimeout(function () { attempt(true); }, 60);
          return;
        }
        toast('Server hat abgelehnt', true);
      }
      if (r.ok || r.reason !== 'NOT_ACTIVE_DEVICE') afterSync(r.snapshot, r.serverTime);
      if (r.ok) { setLease(true, null); client.takeover = false; }
    } else if (outcome.kind === 'failed') {
      setConn('offline', outcome.timedOut);
      netzWache();
      return;
    } else if (outcome.kind === 'dropped') {
      toast(/OFFER_GONE/.test(outcome.reason || '') ? 'Jemand war schneller' : 'Teil verworfen', true);
      afterSync(outcome.snapshot, outcome.serverTime);
    }
    momenteNachAbgleich(vorher);
    render();
  }).catch(function () { setConn('offline'); netzWache(); });
}

function show(next) {
  // Wer das Lager zumacht, hat seine neuen Waren gesehen.
  if (view === 'lager' && next !== 'lager' && typeof lagerGesehenMerken === 'function') lagerGesehenMerken();
  view = next;
  if (typeof tippWeg === 'function') tippWeg();
  if (next !== 'stand') standZu();
  if (next !== 'besuch' && next !== 'fremdstand') besuchEnde();
  if (next !== 'freunde') freundeWachen(false);
  // „besuch" hat kein Blatt: Der fremde Hof steht im Hof selbst.
  ['brett', 'lager', 'stand', 'rest', 'bau', 'freunde', 'fremdstand', 'pfad', 'erweiterung', 'bonus', 'ziele', 'bestenliste', 'abenteuer', 'empfang', 'sicherung', 'rueckmeldung'].forEach(function (name) {
    $(name + '-bg').hidden = name !== next;
  });
  render();
  // Beim ersten Öffnen erklärt sich der Bildschirm selbst. Die Tabelle steht
  // weiter unten in der Datei, darum die Prüfung auf Vorhandensein.
  if (typeof BILDSCHIRM_TUT === 'object' && BILDSCHIRM_TUT[next]) {
    featureTutorial(BILDSCHIRM_TUT[next]);
  }
}

['brett', 'lager', 'stand', 'rest', 'bau', 'freunde', 'fremdstand', 'pfad', 'erweiterung', 'ziele', 'bestenliste', 'abenteuer', 'empfang', 'sicherung', 'rueckmeldung'].forEach(function (name) {
  var zurueck = name === 'fremdstand' ? 'besuch' : (name === 'ziele' || name === 'bestenliste' || name === 'sicherung' || name === 'rueckmeldung') ? 'rest' : 'farm';
  $(name + '-close').addEventListener('click', function () { show(zurueck); });
  $(name + '-bg').addEventListener('click', function (e) {
    if (e.target === $(name + '-bg')) show(zurueck);
  });
});
// Zum See geht es nur noch über das Boot am Hof. Der Rückweg ist der Steg im
// See selbst („Zum Hof"), Köder stellt man im Strandhaus her — keine HUD-Knöpfe.
$('boot').addEventListener('click', function () { bootTap(); });
$('naechstes').addEventListener('click', function () { naechstesHin(); });
// Benachrichtigungen an- und abschalten. Um Erlaubnis wird erst hier gefragt,
// nie beim Start — ein Dialog aus dem Nichts schreckt nur ab.
function meldenAnzeigen() {
  var stand = meldenStand();
  var text = {
    an: 'An', aus: 'Aus', blockiert: 'Blockiert',
    'geht-nicht': 'Geht hier nicht', 'zum-home': 'Fast',
  }[stand];
  $('melden-stand').textContent = text;
  $('melden-sub').textContent =
    stand === 'an' ? 'Du hörst von reifen Feldern, vollen Reusen und Neuigkeiten'
      : stand === 'blockiert' ? 'In den Einstellungen des Geräts wieder erlauben'
        : stand === 'zum-home' ? 'Auf dem iPhone: Teilen-Knopf, „Zum Home-Bildschirm", von dort starten'
          : stand === 'geht-nicht' ? 'Dieses Gerät kann keine Benachrichtigungen'
            : 'Sag Bescheid, wenn etwas fertig ist';
  $('melden-schalter').disabled =
    stand === 'geht-nicht' || stand === 'blockiert' || stand === 'zum-home';
}

$('melden-schalter').addEventListener('click', function () {
  var stand = meldenStand();
  $('melden-stand').textContent = '…';
  var fertig = function (neu) {
    meldenAnzeigen();
    if (neu === 'an') toast('Benachrichtigungen an');
    else if (neu === 'blockiert') toast('Das Gerät erlaubt keine Benachrichtigungen', true);
    else if (neu === 'aus') toast('Benachrichtigungen aus');
  };
  if (stand === 'an') meldenAbmelden().then(fertig);
  else meldenAnmelden().then(fertig);
});

$('abenteuer-auf').addEventListener('click', function () { show('abenteuer'); });
$('ziele-auf').addEventListener('click', function () { show('ziele'); });
$('bestenliste-auf').addEventListener('click', function () { show('bestenliste'); ladeBestenliste(); });
$('brett').addEventListener('click', function () { show('brett'); });
$('abenteuer').addEventListener('click', function () { show('abenteuer'); });
$('lagerhaus').addEventListener('click', function () { loeschZu(); show('lager'); });

$('loesch-minus').addEventListener('click', function () { loeschStellen(-1); });
$('loesch-plus').addEventListener('click', function () { loeschStellen(1); });
$('loesch-alle').addEventListener('click', function () { if (loeschState) { loeschState.menge = loeschState.max; loeschMengeAnzeigen(); } });
$('loesch-ab').addEventListener('click', loeschZu);
$('loesch-ok').addEventListener('click', loeschAusfuehren);
$('stand').addEventListener('click', function () {
  // Zu Besuch ist es sein Stand — dort wird gekauft, nicht verkauft.
  if (besuchAktiv()) { fremdenStandOeffnen(); return; }
  client.neueZeitung = true;
  show('stand');
  attempt(true);
});
$('besuch-zurueck').addEventListener('click', function () { show('farm'); });
$('besuch-nachbar').addEventListener('click', function () { besuchNachbarschaft(); });
$('zahnrad').addEventListener('click', function () { show('rest'); });
$('pfad-auf').addEventListener('click', function () { show('pfad'); });
$('bonus-auf').addEventListener('click', function () { oeffneBonus(); });
$('serie').addEventListener('click', function () { oeffneBonus(); });
$('stufe-weiter').addEventListener('click', feierZu);
$('kiste-weiter').addEventListener('click', function () { kisteEinpacken(); });
$('kiste-feier').addEventListener('click', function (e) {
  if (e.target === $('kiste-feier')) kisteZu();
});
$('stufe-feier').addEventListener('click', function (e) {
  if (e.target === $('stufe-feier')) feierZu();
});
$('nachbarn').addEventListener('click', function () {
  show('freunde');
  hofLaden();
  freundeLaden();
  freundeWachen(true);
});
$('freundadd').addEventListener('click', freundHinzu);
$('freundcode').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') freundHinzu();
});

// Der Server ist neuer als dieser Client (kennt ein höheres Regelwerk). Statt
// hart abzustürzen und „offline für immer" zu hängen, den neuesten Client holen.
var neuladeVersuch = false;
function neueVersionLaden() {
  if (neuladeVersuch) return;
  neuladeVersuch = true;
  try { $('conn-text').textContent = 'neue Version wird geladen…'; } catch (e) {}
  var fertig = function () { location.reload(); };
  if ('serviceWorker' in navigator && navigator.serviceWorker.getRegistrations) {
    navigator.serviceWorker.getRegistrations()
      .then(function (rs) { return Promise.all(rs.map(function (r) { return r.update(); })); })
      .then(fertig, fertig);
  } else {
    fertig();
  }
}

function begin(restored) {
  client = restored;
  try {
    rules = NS.getRuleset(client.rulesetVersion);
  } catch (e) {
    // Unbekanntes (neueres) Regelwerk → frischen Client nachladen statt abstürzen.
    neueVersionLaden();
    return false;
  }
  engine = new NS.SyncEngine(client, transport, {
    baseDelayMs: 2000,
    maxDelayMs: 30000,
    pendingMaxDelayMs: 5000,
  });

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
  setInterval(function () {
    if (document.hidden || !navigator.onLine) return;
    if (!liveAbort) startLive();
    attempt(true);
    bonusHolen();
  }, 20000 + Math.floor(Math.random() * 10000));
  setInterval(refreshLease, 15000);
  setTimeout(bonusHolen, 1500);
  // Geschenke, die waehrend der Abwesenheit kamen — als Momente, nicht stumm.
  setTimeout(geschenkeHolen, 2500);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      save();
      stopLive();
    } else {
      // Zuerst die Abwesenheit festhalten: Der Abgleich gleich danach schreibt
      // ein frisches Lebenszeichen. Wer aus der Tasche zurückkommt, kommt
      // zurück — nach einer längeren Pause empfängt der Hof ihn noch einmal.
      empfangAnmelden();
      if (engine) engine.revive();
      attempt(true);
      refreshLease();
      startLive();
      bonusHolen();
      empfangPruefen();
    }
  });
  window.addEventListener('online', function () {
    if (engine) engine.revive();
    render();
    attempt(true);
    startLive();
    bonusHolen();
  });
  window.addEventListener('offline', function () {
    setConn('offline');
    stopLive();
    netzWache();
    render();
  });
  window.addEventListener('pagehide', function () { save(); stopLive(); });
  // Beim Drehen (Hoch-/Querformat) die Kamera neu einpassen; sonst nur nachziehen.
  var warQuer = null;
  function aufGroesse() {
    if (!kamera.gesetzt) return;
    var jetzt = istQuer();
    if (warQuer === null) warQuer = jetzt;
    if (jetzt !== warQuer) { warQuer = jetzt; kameraStart(); }
    else kameraAnwenden();
  }
  window.addEventListener('resize', aufGroesse);
  window.addEventListener('orientationchange', function () { setTimeout(aufGroesse, 100); });
  startLive();
  return true;
}

function start(snapshot, serverTime, id) {
  accountId = id || accountId;
  ladeSaat();
  empfangAnmelden();
  if (!begin(new NS.Client(snapshot, deviceId))) return;
  adopt(snapshot, serverTime);
  setConn('live');
  render();
  tutorialStarten(false);
  empfangPruefen();
}

function startOffline(saved) {
  clockOffsetMs = saved.clockOffsetMs;
  accountId = saved.accountId || null;
  ladeSaat();
  empfangAnmelden();
  if (!begin(saved.client)) return;
  setConn(navigator.onLine ? 'catching-up' : 'offline');
  render();
  attempt(true);
  refreshLease();
  empfangPruefen();
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
  fetch(serverPfad('/api/account'), { method: 'POST' })
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
  inZwischenablage($('keyvalue').textContent, $('keyvalue'));
});
$('keydone').addEventListener('click', function () {
  start(pendingStart.snapshot, pendingStart.serverTime, pendingStart.accountId);
  setLease(true, null);
});
(function () {
  var mus = $('musik-regler');
  var sfx = $('sfx-regler');
  mus.value = musikVol;
  sfx.value = sfxProz;
  $('musik-wert').textContent = musikVol + '%';
  $('sfx-wert').textContent = sfxProz + '%';
  mus.addEventListener('input', function () {
    $('musik-wert').textContent = mus.value + '%';
    musikLautSetzen(parseInt(mus.value, 10));
  });
  sfx.addEventListener('input', function () {
    $('sfx-wert').textContent = sfx.value + '%';
    sfxSetzen(parseInt(sfx.value, 10));
  });
})();

$('musik-play').addEventListener('click', musikPlayPause);
$('musik-vor').addEventListener('click', musikVor);
$('musik-next').addEventListener('click', musikNext);

$('connect').addEventListener('click', connect);
$('key').addEventListener('keydown', function (e) { if (e.key === 'Enter') connect(); });
$('takeover').addEventListener('click', function () {
  client.takeover = true;
  setLease(true, null);
  toast('Übernahme gilt ab der nächsten Aktion');
});
// Abmelden in zwei Schritten — derselbe Griff wie beim Abreißen: Der Knopf
// fragt selbst nach, kein Systemfenster.
$('forget').addEventListener('click', function () {
  var karte = $('forget');
  if (!karte.dataset.sicher) {
    karte.dataset.sicher = '1';
    karte.classList.add('sicher');
    karte.querySelector('.top').textContent = 'Sicher? Nochmal tippen zum Abmelden';
    karte.querySelector('.sub').textContent = 'Ohne notierten Schlüssel oder Wiederherstellungswort ist der Hof danach weg';
    setTimeout(function () {
      karte.dataset.sicher = '';
      karte.classList.remove('sicher');
      karte.querySelector('.top').textContent = 'Von diesem Gerät abmelden';
      karte.querySelector('.sub').textContent = 'Schlüssel und lokaler Stand werden hier gelöscht';
    }, 4000);
    return;
  }
  vergissGeraet();
});

// — Einführung für neue Höfe (geführt, siehe fuehrung.js) ————————————————

// Pro Hof gemerkt: ein neuer Hof zeigt die Einführung, auch wenn auf demselben
// Gerät schon ein anderer Hof sie durchlaufen hat. Derselbe Hof sieht sie nie
// wieder — weder nach Neuladen noch bei späteren Logins.
function tutSchluessel() {
  return accountId ? 'ns-tut-' + accountId : 'ns-tutorial';
}
function tutorialFertig() {
  try { return localStorage.getItem(tutSchluessel()) === 'done'; } catch (e) { return false; }
}
function tutorialStarten(erzwingen) {
  if (erzwingen) {
    // „Einführung nochmal" zeigt alles noch einmal, auch die Zettel je Blatt.
    for (var id in FEATURE_TIPP) {
      try { localStorage.removeItem(featureSchluessel(id)); } catch (e) {}
    }
  }
  if (!erzwingen) {
    if (tutorialFertig()) return;
    // Nur für ganz frische Höfe automatisch — Veteranen (mit XP) verschonen.
    if (client && client.preview && client.preview().xp > 0) return;
  }
  // Die Einführung ist geführt: Der Hof selbst zeigt die ersten Schritte.
  fuehrungStarten();
}
// — Kurze Einführung je Funktion ————————————————————————————————————————
// Jedes größere Feature erklärt sich beim ersten Öffnen selbst. Pro Hof und
// Feature einmal gemerkt, danach nie wieder. Über „Anleitung" in den
// Einstellungen kann man sie zurücksetzen.
// Ein Satz je Blatt, beim ersten Oeffnen, als angepinnter Zettel. Nicht mehr.
var FEATURE_TIPP = {
  see: 'Im Strandhaus Köder sieden, an einer Insel auslegen, später den Fang holen.',
  mine: 'Mit der Spitzhacke gräbst du Erz — die Schmiede macht Barren daraus.',
  werkstatt: 'Hier machst du Werkzeug selbst: Bretter, Nägel, Säge, Schaufel, Karten.',
  waldstueck: 'Hier wächst Holz nach — ein Stück bleibt als Saat zurück.',
  hofkueche: 'Aus fertigen Waren wird ein Gericht — das bringt mehr als die Zutaten einzeln.',
  raeucherei: 'Aus deinem Fang wird Räucherfisch — deutlich wertvoller als roh.',
  wagen: 'Jeder Zettel will Waren und zahlt Gold und Erfahrung. Nichts dabei? Tauschen.',
  stand: 'Hier bietest du Waren anderen Höfen an — Menge und Preis bestimmst du.',
  nachbarn: 'Tausch deinen Hofcode, besuch Nachbarn und hilf ihnen — das bringt beiden Erfahrung.',
  land: 'Neues Land kostet Werkzeug statt Gold: Karten, Schlegel, Pflöcke.',
  lager: 'Alles, was du hast. Wird es eng, baust du das Lager aus.',
  bauen: 'Antippen, bauen, frei hinstellen — mit jeder Stufe kommt Neues dazu.',
  bonus: 'Jeden Tag ein Bonus — er wächst, wenn du dranbleibst.',
  liste: 'Alle Höfe nach Erfahrung. Deiner ist markiert.',
  abenteuer: 'Die Zettel von heute — sie zählen auch ohne Netz. Morgen hängen neue.',
  ziele: 'Erfolge in Gruppen. Was fertig ist, holst du hier ab.',
};

// Welcher Bildschirm welche Einführung zeigt. Neue Funktionen tragen sich hier
// mit einer Zeile ein.
var BILDSCHIRM_TUT = {
  brett: 'wagen',
  stand: 'stand',
  freunde: 'nachbarn',
  erweiterung: 'land',
  lager: 'lager',
  bau: 'bauen',
  bonus: 'bonus',
  bestenliste: 'liste',
  ziele: 'ziele',
  abenteuer: 'abenteuer',
};

function featureSchluessel(id) {
  return (accountId ? 'ns-tut-' + accountId : 'ns-tutorial') + '-' + id;
}

// Zeigt die Einführung, falls dieser Hof sie noch nicht gesehen hat.
var tippTimer = null;
function tippZeigen(satz) {
  $('tipp-text').textContent = satz;
  $('tipp').hidden = false;
  clearTimeout(tippTimer);
  // Wer nicht tippt, bekommt den Zettel nach einer Weile von selbst abgenommen.
  tippTimer = setTimeout(tippWeg, 9000);
}
function tippWeg() {
  clearTimeout(tippTimer);
  $('tipp').hidden = true;
}
function featureTutorial(id) {
  var satz = FEATURE_TIPP[id];
  if (!satz) return;
  // Waehrend der gefuehrten Einfuehrung redet nur die Einfuehrung.
  if (typeof fuehrungAktiv === 'function' && fuehrungAktiv()) return;
  try { if (localStorage.getItem(featureSchluessel(id)) === 'done') return; } catch (e) {}
  try { localStorage.setItem(featureSchluessel(id), 'done'); } catch (e) {}
  tippZeigen(satz);
}
$('tipp-ok').addEventListener('click', tippWeg);
$('anleitung').addEventListener('click', function () { show('farm'); tutorialStarten(true); });

// Die HUD-Knoepfe tragen Pixelkunst aus dem Spiel selbst: Schlegel, Truhe, Zahnrad.
(function () {
  var bild = function (id, quelle) {
    var el = $(id);
    if (!el || !quelle) return;
    var img = document.createElement('img');
    img.src = quelle; img.alt = ''; img.setAttribute('aria-hidden', 'true');
    el.insertBefore(img, el.firstChild);
  };
  bild('bauen', typeof ICONS === 'object' && ICONS.mallet);
  bild('bonus-auf', typeof SPRITES === 'object' && SPRITES.truhe);
  bild('zahnrad', typeof SPRITES === 'object' && SPRITES.zahnrad);
})();

meldenAnzeigen();
meldenAuffrischen();

var saved = token ? loadSaved() : null;
if (saved) { startOffline(saved); tutorialStarten(false); }
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

// Zuletzt: Die Seite meldet, dass alle Knöpfe verdrahtet sind. Die Seite ist
// groß; wer vorher tippt, tippt ins Leere. Der Browsertest wartet darauf.
document.documentElement.setAttribute('data-bereit', '1');

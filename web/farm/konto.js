// Konto: der Weg zurück in den Hof, das Sichern des Schlüssels, das Löschen,
// Rückmeldungen an den Betreiber und die Fehlerberichte der Geräte.
//
// Kein Systemfenster nirgends: Jede Nachfrage ist ein Knopf, der sich selbst
// erklärt und nach ein paar Sekunden wieder harmlos wird.

// — Womit sich jede Meldung ausweist ————————————————————————————————————
function standDerSeite() {
  var m = document.querySelector('meta[name="stand"]');
  var wert = m ? m.getAttribute('content') : '';
  return wert && wert.indexOf('<!--') < 0 ? wert : 'unbekannt';
}

function geraetKurz() {
  var ua = navigator.userAgent || '';
  var teile = [];
  if (/iPhone|iPad/.test(ua)) teile.push('iOS');
  else if (/Android/.test(ua)) teile.push('Android');
  else if (/Mac OS/.test(ua)) teile.push('macOS');
  else if (/Windows/.test(ua)) teile.push('Windows');
  else if (/Linux/.test(ua)) teile.push('Linux');
  if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) teile.push('App');
  else if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) teile.push('Startbildschirm');
  else teile.push('Browser');
  teile.push(Math.round(window.innerWidth) + '×' + Math.round(window.innerHeight));
  return teile.join(' · ');
}

function meldungsKopf() {
  return {
    version: standDerSeite(),
    huelle: (function () { try { return localStorage.getItem('ns-huelle') || ''; } catch (e) { return ''; } })(),
    regelwerk: client && client.baseSnapshot ? client.baseSnapshot.rulesetVersion : 0,
    geraet: geraetKurz(),
  };
}

// — Zwischenablage ohne Systemfenster ———————————————————————————————————
function inZwischenablage(text, knoten) {
  var fertig = function () { toast('Kopiert'); };
  var ersatz = function () {
    // Kein Zugriff auf die Zwischenablage: den Text markieren, dann kann der
    // Spieler selbst kopieren — statt eines Systemfensters.
    try {
      var bereich = document.createRange();
      bereich.selectNodeContents(knoten);
      var auswahl = window.getSelection();
      auswahl.removeAllRanges();
      auswahl.addRange(bereich);
      if (document.execCommand && document.execCommand('copy')) { fertig(); return; }
    } catch (e) {}
    toast('Markiert — jetzt selbst kopieren', true);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(fertig, ersatz);
  } else ersatz();
}

// — Dieses Gerät vergessen ——————————————————————————————————————————————
function vergissGeraet() {
  localStorage.removeItem('ns-token');
  try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
  location.reload();
}

// — Hof sichern ————————————————————————————————————————————————————————
var keySichtbar = false;

function keyAnzeigen(sichtbar) {
  keySichtbar = sichtbar;
  var k = $('sicherung-key');
  k.textContent = sichtbar ? token : '••••••••••••••••••••••••';
  k.classList.toggle('verdeckt', !sichtbar);
  $('key-zeigen').textContent = sichtbar ? 'Verbergen' : 'Anzeigen';
}

function wortStandZeigen(gesetzt) {
  $('wort-stand').textContent = gesetzt
    ? 'Ein Wort ist gesetzt. Ein neues ersetzt das alte.'
    : 'Noch keins gesetzt — ohne Wort gibt es keinen Weg zurück, wenn der Schlüssel fehlt.';
  $('wort-setzen').textContent = gesetzt ? 'Ändern' : 'Festlegen';
}

function sicherungOeffnen() {
  show('sicherung');
  keyAnzeigen(false);
  $('wort-neu').value = '';
  $('loeschen-code').value = '';
  var codeBox = $('sicherung-code');
  var zeichneCode = function () {
    codeBox.innerHTML = eigenerHof
      ? 'Dein Hofcode: <b>' + eigenerHof.code + '</b> — den brauchst du zum Zurückholen und zum Löschen.'
      : 'Dein Hofcode kommt mit der Verbindung.';
  };
  zeichneCode();
  if (!netzOk()) { $('wort-stand').textContent = 'Ohne Netz lässt sich hier nichts ändern.'; return; }
  hofLaden().then(zeichneCode);
  api('/api/wiederherstellung').then(function (d) { wortStandZeigen(!!d.gesetzt); }).catch(function () {});
}

function wortSetzen() {
  var wort = $('wort-neu').value.normalize ? $('wort-neu').value.normalize('NFC').trim() : $('wort-neu').value.trim();
  if (wort.length < 8) { toast('Mindestens 8 Zeichen', true); klang('fehler'); return; }
  if (wort.length > 64) { toast('Höchstens 64 Zeichen', true); klang('fehler'); return; }
  if (!netzOk()) { toast('Ohne Netz geht das nicht', true); return; }
  $('wort-setzen').disabled = true;
  api('/api/wiederherstellung', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wort: wort }),
  }).then(function () {
    $('wort-neu').value = '';
    wortStandZeigen(true);
    toast('Wiederherstellungswort gesetzt');
    klang('bestaetigt');
  }).catch(function () {
    toast('Konnte das Wort nicht setzen', true);
  }).then(function () { $('wort-setzen').disabled = false; });
}

function hofLoeschen() {
  var knopf = $('loeschen-los');
  var code = $('loeschen-code').value.trim().toUpperCase();
  if (!eigenerHof || !eigenerHof.code) { toast('Hofcode fehlt noch — bitte kurz warten', true); return; }
  if (code !== eigenerHof.code) { toast('Der Hofcode stimmt nicht', true); klang('fehler'); return; }
  if (!knopf.dataset.sicher) {
    knopf.dataset.sicher = '1';
    knopf.classList.add('sicher');
    knopf.textContent = 'Sicher? Alles weg';
    setTimeout(function () {
      knopf.dataset.sicher = '';
      knopf.classList.remove('sicher');
      knopf.textContent = 'Löschen';
    }, 4000);
    return;
  }
  if (!netzOk()) { toast('Ohne Netz geht das nicht', true); return; }
  knopf.disabled = true;
  api('/api/konto', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: code }),
  }).then(function () {
    toast('Dein Hof ist gelöscht');
    setTimeout(vergissGeraet, 900);
  }).catch(function (e) {
    knopf.disabled = false;
    toast(e.message === 'UNAUTHORIZED' ? 'Der Server kennt diesen Schlüssel nicht' : 'Löschen ist nicht gelungen', true);
  });
}

$('sicherung-auf').addEventListener('click', sicherungOeffnen);
$('key-zeigen').addEventListener('click', function () { keyAnzeigen(!keySichtbar); });
$('key-kopieren').addEventListener('click', function () {
  if (!keySichtbar) keyAnzeigen(true);
  inZwischenablage(token, $('sicherung-key'));
});
$('wort-setzen').addEventListener('click', wortSetzen);
$('wort-neu').addEventListener('keydown', function (e) { if (e.key === 'Enter') wortSetzen(); });
$('loeschen-los').addEventListener('click', hofLoeschen);

// — Der Weg zurück: am Tor, ohne Schlüssel —————————————————————————————
$('wieder-auf').addEventListener('click', function () {
  var box = $('wieder');
  box.hidden = !box.hidden;
  if (!box.hidden) $('wieder-code').focus();
});

function hofZurueckholen() {
  var code = $('wieder-code').value.trim().toUpperCase();
  var wort = $('wieder-wort').value.trim();
  if (code.length < 4 || wort.length < 8) { toast('Hofcode und Wort eingeben', true); return; }
  $('wieder-los').disabled = true;
  fetch(serverPfad('/api/wiederherstellen'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: code, wort: wort }),
  }).then(function (r) {
    return r.json().then(function (body) {
      if (!r.ok) throw new Error(body.error || 'HTTP ' + r.status);
      return body;
    });
  }).then(function (data) {
    // Wie beim Anlegen: den neuen Schlüssel einmal zeigen, dann geht es los.
    token = data.key;
    localStorage.setItem('ns-token', token);
    pendingStart = data;
    $('keyvalue').textContent = data.key;
    $('gate').hidden = true;
    $('keygate').hidden = false;
    $('wieder-wort').value = '';
    toast('Willkommen zurück — das ist dein neuer Schlüssel');
  }).catch(function (e) {
    toast(e.message === 'WRONG_WORD' ? 'Hofcode oder Wort stimmen nicht'
      : e.message === 'TOO_MANY_ATTEMPTS' ? 'Zu viele Versuche — später nochmal'
      : 'Server nicht erreichbar', true);
  }).then(function () { $('wieder-los').disabled = false; });
}
$('wieder-los').addEventListener('click', hofZurueckholen);
$('wieder-wort').addEventListener('keydown', function (e) { if (e.key === 'Enter') hofZurueckholen(); });

// — Rückmeldung an den Betreiber ————————————————————————————————————————
var rueckArt = 'fehler';
var RUECK_WARTE = 'ns-rueck-warte';

function rueckArtWaehlen(art) {
  rueckArt = art;
  document.querySelectorAll('#rueck-arten button').forEach(function (b) {
    b.classList.toggle('an', b.getAttribute('data-art') === art);
  });
}

function rueckmeldungOeffnen() {
  show('rueckmeldung');
  var kopf = meldungsKopf();
  $('rueck-meta').textContent = 'Mitgeschickt: Hofcode' + (eigenerHof ? ' ' + eigenerHof.code : '') +
    ', Stand ' + kopf.version + ', ' + kopf.geraet + ' — sonst nichts.';
  setTimeout(function () { $('rueck-text').focus(); }, 50);
}

function rueckmeldungSchicken(eintrag) {
  return api('/api/rueckmeldung', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(eintrag),
  });
}

// Was ohne Netz geschrieben wurde, wartet im Gerät und geht beim nächsten
// Netz von allein raus.
function rueckWarteschlangeLeeren() {
  var liste;
  try { liste = JSON.parse(localStorage.getItem(RUECK_WARTE) || '[]'); } catch (e) { liste = []; }
  if (!liste.length || !netzOk() || !token) return;
  var rest = liste.slice();
  var naechste = function () {
    if (!rest.length) { try { localStorage.removeItem(RUECK_WARTE); } catch (e) {} return; }
    var e = rest[0];
    rueckmeldungSchicken(e).then(function () {
      rest.shift();
      try { localStorage.setItem(RUECK_WARTE, JSON.stringify(rest)); } catch (x) {}
      naechste();
    }).catch(function () {});
  };
  naechste();
}

function rueckmeldungSenden() {
  var text = $('rueck-text').value.trim();
  if (text.length < 3) { toast('Schreib ein paar Worte dazu', true); klang('fehler'); return; }
  var eintrag = Object.assign({ art: rueckArt, text: text }, meldungsKopf());
  $('rueck-senden').disabled = true;
  var fertig = function (sofort) {
    $('rueck-text').value = '';
    $('rueck-senden').disabled = false;
    toast(sofort ? 'Danke — angekommen' : 'Danke — geht raus, sobald Netz da ist');
    klang('bestaetigt');
    show('rest');
  };
  if (!netzOk()) {
    try {
      var liste = JSON.parse(localStorage.getItem(RUECK_WARTE) || '[]');
      liste.push(eintrag);
      localStorage.setItem(RUECK_WARTE, JSON.stringify(liste));
    } catch (e) {}
    fertig(false);
    return;
  }
  rueckmeldungSchicken(eintrag).then(function () { fertig(true); }).catch(function (e) {
    $('rueck-senden').disabled = false;
    toast(e.message === 'HTTP 429' ? 'Das reicht für heute — danke!' : 'Konnte nicht senden', true);
  });
}

$('rueckmeldung-auf').addEventListener('click', rueckmeldungOeffnen);
document.querySelectorAll('#rueck-arten button').forEach(function (b) {
  b.addEventListener('click', function () { rueckArtWaehlen(b.getAttribute('data-art')); });
});
$('rueck-senden').addEventListener('click', rueckmeldungSenden);
window.addEventListener('online', function () { setTimeout(rueckWarteschlangeLeeren, 1500); });
setTimeout(rueckWarteschlangeLeeren, 4000);

// — Fehlerberichte —————————————————————————————————————————————————————
// Die Wache im Kopf der Seite sammelt; hier wird gebündelt verschickt.
// Netzfehler bleiben draußen: Ohne Netz zu sein ist kein Fehler des Spiels.
var FEHLER_WARTE = 'ns-fehler-warte';
var FEHLER_LAUT = /Failed to fetch|NetworkError|Load failed|AbortError|The operation was aborted|network error|^Script error\.?$/i;
var fehlerTimer = null;
var fehlerGesehen = {};

function fehlerBuendeln() {
  var puffer = window.__nsFehler || [];
  var neu = [];
  while (puffer.length) {
    var f = puffer.shift();
    if (FEHLER_LAUT.test(f.text)) continue;
    var schluessel = f.text + '|' + f.ort;
    if (fehlerGesehen[schluessel]) continue;
    fehlerGesehen[schluessel] = 1;
    neu.push({ text: f.text, ort: f.ort, stapel: f.stapel });
  }
  if (!neu.length) return;
  var liste;
  try { liste = JSON.parse(localStorage.getItem(FEHLER_WARTE) || '[]'); } catch (e) { liste = []; }
  liste = liste.concat(neu).slice(-10);
  try { localStorage.setItem(FEHLER_WARTE, JSON.stringify(liste)); } catch (e) {}
}

function fehlerSenden() {
  fehlerTimer = null;
  fehlerBuendeln();
  var liste;
  try { liste = JSON.parse(localStorage.getItem(FEHLER_WARTE) || '[]'); } catch (e) { liste = []; }
  if (!liste.length || !navigator.onLine) return;
  var kopf = Object.assign({ meldungen: liste }, meldungsKopf());
  var kopfzeilen = { 'content-type': 'application/json' };
  if (token) kopfzeilen.authorization = 'Bearer ' + token;
  fetch(serverPfad('/api/fehler'), { method: 'POST', headers: kopfzeilen, body: JSON.stringify(kopf) })
    .then(function (r) { if (r.ok) { try { localStorage.removeItem(FEHLER_WARTE); } catch (e) {} } })
    .catch(function () {});
}

function fehlerAnstossen() {
  if (fehlerTimer) return;
  fehlerTimer = setTimeout(fehlerSenden, 3000);
}
window.__nsFehlerNeu = fehlerAnstossen;
if ((window.__nsFehler || []).length) fehlerAnstossen();
window.addEventListener('online', function () { setTimeout(fehlerSenden, 2500); });
setTimeout(fehlerSenden, 6000);

// Der Stand der Seite steht klein in den Einstellungen — für Rückfragen.
(function () {
  var el = $('stand-anzeige');
  if (el) el.textContent = 'Stand ' + standDerSeite();
})();

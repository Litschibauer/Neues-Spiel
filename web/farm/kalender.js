// Der Kalender: die Hofzeit als Blatt an der Wand. Monat und Tag, die
// Jahreszeit mit ihrer Saisonware, und was als Nächstes kommt — nach Hofzeit
// (Nacht, Monat, Jahreszeit, Jahr) und nach echter Zeit (Tag, Woche). Alles
// aus dem Tick gerechnet, derselbe für alle.

var kalenderTimer = null;

// Die echte Sekunde des Hofs: Tick plus gestempeltem Versatz — null, solange
// der Server noch nicht gestempelt hat (erster Kontakt steht aus).
function hofUnix() {
  if (!client || !rules.jahreszeiten || rules.jahreszeiten.quelle !== 'hofzeit') return null;
  var v = client.preview().zeitVersatz || 0;
  if (!v) return null;
  try { return tickNow() + v; } catch (e) { return null; }
}

function hofzeitJetzt() {
  var u = hofUnix();
  return u === null ? null : NS.hofzeit(u);
}

// Kurz: „Spätsommer, Tag 12 · 14:30" — für die Karte in den Einstellungen.
function hofzeitKurz(z) {
  var mm = z.minute < 10 ? '0' + z.minute : String(z.minute);
  return z.monatName + ', Tag ' + z.tag + ' · ' + z.stunde + ':' + mm;
}

function kalenderAnzeigen() {
  var sub = $('kalender-sub');
  if (!sub) return;
  var z = hofzeitJetzt();
  sub.textContent = z ? hofzeitKurz(z) : 'Der Hof rechnet noch nach der Uhr des Geräts';
  kalenderblattZeigen(z);
  if (view === 'kalender') renderKalender();
}

// Das Kalenderblatt unten links auf dem Hof: Monat, Tag und Uhrzeit der
// Hofzeit, jede Sekunde nachgeführt. Antippen öffnet den Kalender. Ohne
// Stempel vom Server (erster Kontakt) bleibt es weg — dann gäbe es nur die
// Uhr des Geräts, und die ist nicht die des Hofs.
var kalenderblattStand = '';
function kalenderblattZeigen(z) {
  var el = $('kalenderblatt');
  if (!el) return;
  if (z === undefined) z = hofzeitJetzt();
  if (!z || (typeof besuchAktiv === 'function' && besuchAktiv())) { el.hidden = true; kalenderblattStand = ''; return; }
  var mm = z.minute < 10 ? '0' + z.minute : String(z.minute);
  var stand = z.monatName + '|' + z.tag + '|' + z.stunde + ':' + mm + '|' + z.tagesphase;
  el.hidden = false;
  if (stand === kalenderblattStand) return;
  kalenderblattStand = stand;
  $('kb-monat').textContent = z.monatName;
  $('kb-tag').textContent = 'Tag ' + z.tag;
  $('kb-uhr').textContent = z.stunde + ':' + mm + ' Uhr';
  el.classList.toggle('nacht', z.tagesphase !== 'tag');
  el.title = hofzeitKurz(z) + ' · ' + z.jahreszeitName;
}

function kalenderAuf() {
  show('kalender');
  renderKalender();
  clearInterval(kalenderTimer);
  kalenderTimer = setInterval(function () {
    if (view !== 'kalender') { clearInterval(kalenderTimer); kalenderTimer = null; return; }
    renderKalender();
  }, 1000);
}

function restText(sek) {
  // Echte Zeit, wie man sie wartet: Tage, Stunden, Minuten.
  var s = Math.max(0, Math.floor(sek));
  var t = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (t > 0) return t + (t === 1 ? ' Tag ' : ' Tage ') + h + ' Std';
  if (h > 0) return h + ' Std ' + m + ' Min';
  if (m > 0) return m + ' Min';
  return s + ' s';
}

function renderKalender() {
  var box = $('kalender-liste');
  if (!box) return;
  box.textContent = '';
  var z = hofzeitJetzt();
  if (!z) {
    box.innerHTML = '<p class="empty">Der Kalender hängt am Server. Sobald der Hof verbunden war, tickt er.</p>';
    return;
  }
  var tick = hofUnix();
  var saisons = rules.jahreszeiten.saisons;
  var saison = saisons[z.jahreszeit % saisons.length];

  // Kopf: Monat groß, Tag und Uhr, Jahreszeit mit Saisonware.
  var kopf = document.createElement('div');
  kopf.className = 'card kalender-kopf saison-' + z.jahreszeit;
  var mm = z.minute < 10 ? '0' + z.minute : String(z.minute);
  kopf.innerHTML =
    '<div class="kalender-jahr">Jahr ' + z.jahr + '</div>' +
    '<div class="kalender-monat">' + z.monatName + '</div>' +
    '<div class="kalender-tag">Tag ' + z.tag + ' von 31 · ' + z.stunde + ':' + mm + ' Uhr · ' + (z.tagesphase === 'tag' ? 'Tag' : 'Nacht') + '</div>' +
    '<div class="kalender-saison">' + (saison ? iconTag(rules.items[saison.bonusItem].id) + '<span>' + z.jahreszeitName + ' · ' + itemName(saison.bonusItem) + ' bringt eine mehr</span>' : z.jahreszeitName) + '</div>';
  box.appendChild(kopf);

  // Das Monatsblatt: 31 Tage, heute markiert, vergangene abgehakt.
  var blatt = document.createElement('div');
  blatt.className = 'card kalender-blatt';
  for (var d = 1; d <= 31; d++) {
    var zelle = document.createElement('span');
    zelle.className = 'kalender-zelle' + (d < z.tag ? ' vorbei' : d === z.tag ? ' heute' : '');
    zelle.textContent = String(d);
    blatt.appendChild(zelle);
  }
  box.appendChild(blatt);

  // Die Jahreszeiten des Jahres mit ihrer Saisonware — wo stehen wir?
  var jahr = document.createElement('div');
  jahr.className = 'card kalender-jahreszeiten';
  saisons.forEach(function (s, i) {
    var el = document.createElement('span');
    el.className = 'kalender-jz saison-' + i + (i === z.jahreszeit ? ' jetzt' : '');
    el.innerHTML = iconTag(rules.items[s.bonusItem].id) + '<b>' + s.name + '</b><i>' + itemName(s.bonusItem) + '</i>';
    jahr.appendChild(el);
  });
  box.appendChild(jahr);

  // Was kommt: nach Hofzeit und nach echter Zeit — beides in echter Wartezeit.
  var titel = document.createElement('div');
  titel.className = 'ziel-gruppe';
  titel.innerHTML = '<span>Als Nächstes</span>';
  box.appendChild(titel);
  var liste = document.createElement('div');
  liste.className = 'card kalender-ereignisse';
  var naechsteSaison = saisons[(z.jahreszeit + 1) % saisons.length];
  var naechsterMonat = NS.MONATE[(z.monat + 1) % 12];
  var namen = {
    nacht: z.tagesphase === 'nacht' ? 'Es wird Tag' : 'Es wird Nacht',
    hoftag: 'Neuer Hoftag',
    hofmonat: 'Neuer Monat: ' + naechsterMonat,
    jahreszeit: 'Neue Jahreszeit: ' + (naechsteSaison ? naechsteSaison.name : ''),
    hofjahr: 'Neues Jahr',
    servertag: 'Neuer Tag: Tagesbonus und Tageszettel',
    serverwoche: 'Neue Woche: Wochenzettel und Zug',
  };
  NS.EREIGNISSE.forEach(function (e) {
    var a = e.naechstes(tick);
    var bis;
    if (e.id === 'nacht') {
      // Läuft die Nacht, zählt die Zeit bis zum Morgen; sonst bis zur Nacht.
      var laeuft = tick >= a.beginn && tick < a.ende;
      bis = laeuft ? a.ende - tick : a.beginn - tick;
    } else {
      bis = a.beginn - tick;
    }
    var zeile = document.createElement('div');
    zeile.className = 'kalender-ereignis ' + e.quelle;
    zeile.innerHTML = '<span class="ke-name">' + (namen[e.id] || e.name) + '</span>' +
      '<span class="ke-quelle">' + (e.quelle === 'hofzeit' ? 'Hofzeit' : 'echte Zeit') + '</span>' +
      '<span class="ke-rest">in ' + restText(bis) + '</span>';
    liste.appendChild(zeile);
  });
  box.appendChild(liste);

  var tiny = document.createElement('p');
  tiny.className = 'tiny kalender-mein';
  tiny.textContent = 'Ein Hoftag ist eine Stunde, ein Monat 31 Tage, ein Jahr zwölf Monate. Die Uhr ist für alle dieselbe.';
  box.appendChild(tiny);
}

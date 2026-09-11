// — Der Empfang ————————————————————————————————————————————————————————
// Ein Hof arbeitet weiter, während man weg ist. Nur begegnet einem davon
// beim Start nichts: Man lädt die Seite und steht stumm auf dem Hof. Was
// fertig ist, muss man selbst suchen; der Tagesbonus wartet als kleiner
// Knopf zwischen den Zahnrädern; erfüllte Tagesaufgaben liegen ungeholt am
// Brett. Alles ist da, nur begegnet es einem nicht.
//
// Der Empfang stellt diesen Moment her. Er erfindet nichts dazu: Jede Zeile
// steht für etwas, das der Hof ohnehin schon kann. Er zählt auf, was wartet,
// gibt in einem Zug her, was ohne Zutun zusteht, und sagt zum Schluss, was
// als Nächstes fertig wird — damit man weiß, warum es sich lohnt zu bleiben.

var empfangGezeigt = false;
var empfangZeilen = [];
var empfangTimer = null;
// Wie lange der Hof beim Aufwachen alleine war. Das muss festgehalten werden,
// BEVOR der erste Abgleich läuft: Jeder Spielzug schreibt ein frisches
// Lebenszeichen, und der Empfang wartet vorher noch auf den Tagesbonus —
// bis dahin wäre die Abwesenheit sonst längst überschrieben.
var wegBeimStart = null;

function daSchluessel() { return accountId ? 'ns-da-' + accountId : 'ns-da'; }

// Wann war der Hof zuletzt in Betrieb? Nur für den Satz „Du warst … weg".
// Die Geräteuhr genügt dafür: Wer sie verstellt, belügt bloß sich selbst —
// am Spielstand ändert diese Zahl nichts.
function merkeDa() {
  try { localStorage.setItem(daSchluessel(), String(Date.now())); } catch (e) {}
}

function wegSekunden() {
  try {
    var roh = localStorage.getItem(daSchluessel());
    if (!roh) return 0;
    var ms = Date.now() - Number(roh);
    return ms > 0 && ms < 30 * TAG_MS ? Math.floor(ms / 1000) : 0;
  } catch (e) { return 0; }
}

// Beim Start und bei der Rückkehr aus dem Hintergrund aufrufen, vor dem ersten
// Spielzug: Hier wird die Abwesenheit eingefroren.
function empfangAnmelden() {
  wegBeimStart = wegSekunden();
  if (wegBeimStart >= 600) empfangGezeigt = false;
}

function empfangWeg() {
  return wegBeimStart === null ? wegSekunden() : wegBeimStart;
}

// Alles, was gerade wartet — in der Reihenfolge, in der man es auf dem Hof
// findet. `hof` heißt: liegt draußen und will angetippt werden. `lohn` heißt:
// steht zu und wird hier gleich mit ausgezahlt.
function empfangSammeln(v) {
  var zeilen = [];
  var felder = 0, baeume = 0, waren = 0;
  v.plots.forEach(function (p) {
    if (p.tap !== 'collect') return;
    if (p.baum) baeume++;
    else if (rules.plots[p.index].id.indexOf('field-') === 0) felder++;
    else waren++;
  });
  if (felder > 0) {
    zeilen.push({ art: 'hof', icon: '🌾',
      text: felder === 1 ? 'Ein Feld ist reif' : felder + ' Felder sind reif' });
  }
  if (baeume > 0) {
    zeilen.push({ art: 'hof', icon: '🍎',
      text: baeume === 1 ? 'Ein Baum trägt' : baeume + ' Bäume tragen' });
  }
  if (waren > 0) {
    zeilen.push({ art: 'hof', icon: '🧺',
      text: waren === 1 ? 'Eine Ware ist fertig' : waren + ' Waren sind fertig' });
  }

  var zettel = ((v.truck && v.truck.board) || []).filter(function (z) { return z.deliverable; }).length;
  if (zettel > 0) {
    zeilen.push({ art: 'hof', icon: '🚚',
      text: zettel === 1 ? 'Ein Zettel ist lieferbar' : zettel + ' Zettel sind lieferbar' });
  }

  var kiste = v.chests && v.chests[0];
  if (kiste && kiste.ready) zeilen.push({ art: 'hof', icon: '📦', text: 'Eine Kiste steht offen' });

  if (v.mail.entries.length > 0) {
    zeilen.push({ art: 'lohn', icon: '📬', text: 'Post ist da · ' + stacks(v.mail.entries), post: true });
  }

  // Über Nacht verkaufte Kästchen: reiner Lohn, der am Stand wartet.
  var verkauft = (v.orders || []).filter(function (o) { return o.sold > 0; });
  if (verkauft.length > 0) {
    var kasse = 0;
    verkauft.forEach(function (o) { kasse += o.sold; });
    zeilen.push({ art: 'lohn', icon: '💰',
      text: verkauft.length === 1 ? 'Ein Kästchen ist verkauft' : verkauft.length + ' Kästchen sind verkauft',
      gold: kasse, xp: 0, verkaeufe: verkauft.map(function (o) { return o.id; }) });
  }

  (v.erfolge || []).forEach(function (e) {
    if (!e.erfuellt || e.eingeloest) return;
    zeilen.push({ art: 'lohn', icon: '★', text: 'Erfolg · ' + e.label,
      gold: e.gold, xp: e.xp, erfolg: e.id });
  });

  ((v.aufgaben && v.aufgaben.liste) || []).forEach(function (a) {
    if (!a.erfuellt || a.eingeloest) return;
    zeilen.push({ art: 'lohn', icon: '⭐', text: 'Geschafft · ' + a.label,
      gold: a.gold, xp: a.xp, aufgabe: a.id });
  });

  var ab = v.aufgaben && v.aufgaben.abschluss;
  if (ab && ab.erfuellt && !ab.eingeloest) {
    zeilen.push({ art: 'lohn', icon: '🏁', text: 'Tagesabschluss steht bereit',
      gold: ab.gold, xp: ab.xp, abschluss: true });
  }

  ((v.wochenaufgaben && v.wochenaufgaben.liste) || []).forEach(function (a) {
    if (!a.erfuellt || a.eingeloest) return;
    zeilen.push({ art: 'lohn', icon: '📅', text: 'Wochenzettel · ' + a.label,
      gold: a.gold, xp: a.xp, wochenAufgabe: a.id });
  });
  var wab = v.wochenaufgaben && v.wochenaufgaben.abschluss;
  if (wab && wab.erfuellt && !wab.eingeloest) {
    zeilen.push({ art: 'lohn', icon: '🏆', text: 'Wochenabschluss steht bereit · Wochentruhe',
      gold: wab.gold, xp: wab.xp, wochenAbschluss: true });
  }

  // Der Tagesbonus kommt vom Server — ohne Verbindung steht er nicht zu.
  if (typeof bonusStatus === 'object' && bonusStatus && bonusStatus.verfuegbar && netzOk()) {
    zeilen.push({ art: 'lohn', icon: '🎁',
      text: 'Tagesbonus · Tag ' + bonusStatus.streak + ' in Folge',
      gold: bonusStatus.heute.gold, xp: bonusStatus.heute.xp, bonus: true });
  }
  return zeilen;
}

// Was wird als Nächstes fertig? Der eine Satz, der aus „ich schaue kurz rein"
// ein „ich warte die Minute noch ab" macht.
function empfangNaechstes(v) {
  var beste = null;
  v.plots.forEach(function (p) {
    if (p.tap === 'collect' || !p.busy || p.remaining <= 0) return;
    if (beste === null || p.remaining < beste.remaining) beste = p;
  });
  if (beste === null) return '';
  var was = beste.producing ? nameOf(beste.producing) : plotName(beste.index);
  return was + ' ist in ' + timeText(beste.remaining) + ' fertig.';
}

function empfangPruefen(sofortAuch) {
  if (empfangGezeigt || !client || !isActive) return;
  if (view !== 'farm') return;
  // Die Einführung hat Vorrang; danach ruft sie hier noch einmal an.
  if ($('tut-bg') && !$('tut-bg').hidden) return;
  // Steht der Tagesbonus noch aus, kurz auf ihn warten — sonst fehlte im
  // Empfang ausgerechnet die Zeile, wegen der man morgen wiederkommt. Der Hof
  // fragt ihn 1,5 s nach dem Start ab und meldet sich dann von selbst hier;
  // dieser Wecker ist nur die Rückfalllinie, wenn keine Antwort kommt.
  if (!sofortAuch && netzOk() && (typeof bonusStatus !== 'object' || bonusStatus === null)) {
    if (empfangTimer === null) {
      empfangTimer = setTimeout(function () { empfangTimer = null; empfangPruefen(true); }, 3500);
    }
    return;
  }
  if (empfangTimer !== null) { clearTimeout(empfangTimer); empfangTimer = null; }

  var v = NS.farmView(client.preview(), rules, navigator.onLine);
  var zeilen = empfangSammeln(v);
  if (zeilen.length === 0) return;
  // Nach einem kurzen Neuladen ist niemand „zurück", und ein eben angelegter
  // Hof erst recht nicht. Der Empfang ist das Wiedersehen — sonst wäre er
  // bloß ein Fenster, das man wegtippt.
  if (empfangWeg() < 600) return;

  empfangGezeigt = true;
  empfangZeilen = zeilen;
  show('empfang');
}

function renderEmpfang() {
  var box = $('empfang-inhalt');
  if (!box || $('empfang-bg').hidden) return;
  var v = NS.farmView(client.preview(), rules, navigator.onLine);
  var weg = empfangWeg();
  var muenze = iconTag(rules.items[rules.currency].id);

  var kopf = weg >= 600
    ? '<p class="lead">Du warst ' + timeText(weg) + ' weg. Der Hof hat weitergearbeitet.</p>'
    : '<p class="lead">Schön, dass du da bist. Das wartet auf dich:</p>';

  var liste = '<div class="empfang-liste">';
  empfangZeilen.forEach(function (z) {
    var lohn = z.art === 'lohn';
    var wert = lohn
      ? (z.gold > 0 ? z.gold + muenze : '') + (z.gold > 0 && z.xp > 0 ? ' ' : '') +
        (z.xp > 0 ? '<span class="x">+' + z.xp + ' XP</span>' : '')
      : '';
    liste += '<div class="empfang-zeile' + (lohn ? ' lohn' : '') + (z.geholt ? ' geholt' : '') + '">' +
      '<span class="e">' + (z.geholt ? '✓' : z.icon) + '</span>' +
      '<span class="t">' + z.text + '</span>' +
      '<span class="w">' + wert + '</span>' +
      '</div>';
  });
  liste += '</div>';

  var naechstes = empfangNaechstes(v);
  var fuss = naechstes === '' ? '' : '<p class="empfang-weiter">' + naechstes + '</p>';

  box.innerHTML = kopf + liste + fuss;

  var offen = empfangZeilen.filter(function (z) { return z.art === 'lohn' && !z.geholt; });
  var knopf = document.createElement('button');
  knopf.className = 'primär';
  knopf.id = 'empfang-los';
  knopf.textContent = offen.length > 0 ? 'Einsammeln' : 'Auf den Hof';
  knopf.addEventListener('click', function () {
    if (offen.length > 0) empfangEinsammeln();
    else show('farm');
  });
  box.appendChild(knopf);
}

// Einsammeln heißt: alles hergeben, was ohne Spielzug zusteht — erfüllte
// Tagesaufgaben, das Postfach, den Tagesbonus. Die reifen Felder bleiben
// ausdrücklich liegen: Sie abzuernten ist der Spaß, den niemand einem Knopf
// überlassen will.
//
// Gezählt wird nicht, was versprochen war, sondern was wirklich ankam —
// Geldbeutel und XP vorher und nachher. Der Tagesbonus geht den Umweg über
// den Server ins Postfach, deshalb wird nach ihm noch einmal abgeglichen und
// die Post ein zweites Mal geleert.
function empfangEinsammeln() {
  var knopf = $('empfang-los');
  if (knopf) knopf.disabled = true;

  var vorher = NS.farmView(client.preview(), rules, navigator.onLine);
  var goldVor = vorher.currency.amount;
  var xpVor = vorher.xp.total;
  var etwas = false;

  empfangZeilen.forEach(function (z) {
    if (z.art !== 'lohn' || z.geholt) return;
    if (z.verkaeufe) {
      var alle = true;
      z.verkaeufe.forEach(function (id) { if (!client.collectSale(id).ok) alle = false; });
      if (alle) { z.geholt = true; etwas = true; }
      return;
    }
    if (z.erfolg) {
      if (client.claimAchievement(z.erfolg).ok) { z.geholt = true; etwas = true; }
      return;
    }
    if (z.wochenAufgabe) {
      if (client.claimWeekTask(z.wochenAufgabe).ok) { z.geholt = true; etwas = true; }
      return;
    }
    if (!z.aufgabe) return;
    if (!client.claimTask(z.aufgabe).ok) return;
    z.geholt = true;
    etwas = true;
  });

  // Der Wochenabschluss nach den Wochenzetteln — auch er kann erst durch
  // diesen Griff faellig geworden sein.
  var wabZeile = null;
  empfangZeilen.forEach(function (z) { if (z.art === 'lohn' && z.wochenAbschluss && !z.geholt) wabZeile = z; });
  if (wabZeile === null) {
    var wabJetzt = NS.farmView(client.preview(), rules, navigator.onLine).wochenaufgaben.abschluss;
    if (wabJetzt && wabJetzt.erfuellt && !wabJetzt.eingeloest) {
      wabZeile = { art: 'lohn', icon: '🏆', text: 'Wochenabschluss steht bereit · Wochentruhe',
        gold: wabJetzt.gold, xp: wabJetzt.xp, wochenAbschluss: true };
      empfangZeilen.push(wabZeile);
    }
  }
  if (wabZeile !== null && client.claimWeek().ok) {
    wabZeile.geholt = true;
    etwas = true;
  }

  // Der Abschluss erst nach den Zetteln: Er verlangt, dass sie abgenommen sind.
  // Deshalb kann er auch erst durch diesen Griff fällig geworden sein — dann
  // kommt seine Zeile jetzt dazu, statt bis zum nächsten Mal zu warten.
  var abZeile = null;
  empfangZeilen.forEach(function (z) { if (z.art === 'lohn' && z.abschluss && !z.geholt) abZeile = z; });
  if (abZeile === null) {
    var ab = NS.farmView(client.preview(), rules, navigator.onLine).aufgaben.abschluss;
    if (ab && ab.erfuellt && !ab.eingeloest) {
      abZeile = { art: 'lohn', icon: '🏁', text: 'Tagesabschluss steht bereit',
        gold: ab.gold, xp: ab.xp, abschluss: true };
      empfangZeilen.push(abZeile);
    }
  }
  if (abZeile !== null && client.claimDay().ok) {
    abZeile.geholt = true;
    etwas = true;
  }

  var post = null;
  empfangZeilen.forEach(function (z) { if (z.art === 'lohn' && z.post && !z.geholt) post = z; });
  if (post && client.collectMail().ok) { post.geholt = true; etwas = true; }
  if (etwas) { save(); scheduleSync(); }

  var bonus = null;
  empfangZeilen.forEach(function (z) { if (z.art === 'lohn' && z.bonus && !z.geholt) bonus = z; });

  var abschluss = function () {
    var nachher = NS.farmView(client.preview(), rules, navigator.onLine);
    if (knopf) knopf.disabled = false;
    empfangFeiern(nachher.currency.amount - goldVor, nachher.xp.total - xpVor);
    renderEmpfang();
    render();
  };

  if (bonus === null || typeof bonusEinloesenRoh !== 'function') { abschluss(); return; }

  bonusEinloesenRoh().then(function (r) {
    if (!r) { abschluss(); return; }
    bonus.geholt = true;
    if (r.streak >= (r.status && r.status.laenge ? r.status.laenge : 7)) feiereSerie(r.streak, r.gold);
    // Der Bonus liegt jetzt beim Server im Postfach. Erst abgleichen, dann
    // leeren — sonst stünde die Belohnung im Fach statt im Geldbeutel.
    return attempt(true).then(function () {
      if (client.collectMail().ok) { save(); scheduleSync(); }
      abschluss();
    });
  }).catch(function () {
    toast('Der Tagesbonus ließ sich gerade nicht holen — das Geschenk oben hat ihn noch', true);
    abschluss();
  });
}

function empfangFeiern(gold, xp) {
  if (gold <= 0 && xp <= 0) return;
  klang('muenzen');
  var muenzen = document.querySelector('.coins');
  if (muenzen && gold > 0) {
    // Vom Knopf in den Geldbeutel; die Zahl oben springt erst bei Ankunft.
    muenzenFliegen($('empfang-los') || muenzen, gold, function () {
      zahlAuf(muenzen.getBoundingClientRect(), '+' + gold, 'muenzen');
    });
  }
  toast('Eingesammelt' + (gold > 0 ? ' · +' + gold + ' Gold' : '') +
    (xp > 0 ? (gold > 0 ? ' + ' : ' · +') + xp + ' XP' : ''));
}

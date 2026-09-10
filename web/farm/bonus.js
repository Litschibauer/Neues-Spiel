var bonusStatus = null;

function bonusKnopf() {
  var knopf = $('bonus-auf');
  if (!knopf) return;
  var frei = !!(bonusStatus && bonusStatus.verfuegbar) && netzOk();
  knopf.hidden = !frei;
  knopf.classList.toggle('winkt', frei);
  serieZeigen();
}

// Die Serie stand bisher nur im Bonusblatt — also dort, wo sie niemand sieht,
// der nicht ohnehin schon hinschaut. Sie gehoert in den Kopf: „Tag 4 in Folge"
// ist der Satz, der einen morgen wiederkommen laesst.
function serieZeigen() {
  var chip = $('serie');
  if (!chip) return;
  var tage = bonusStatus && bonusStatus.streak > 0 ? bonusStatus.streak : 0;
  chip.hidden = tage <= 0;
  if (tage <= 0) return;
  $('serie-tage').textContent = tage;
  // Wartet der heutige Bonus noch, brennt die Flamme heller.
  chip.classList.toggle('offen', !!(bonusStatus && bonusStatus.verfuegbar) && netzOk());
  chip.setAttribute('aria-label', 'Tag ' + tage + ' in Folge');
}

function bonusHolen() {
  if (!token || !netzOk()) return Promise.resolve();
  return api('/api/tagesbonus').then(function (s) {
    bonusStatus = s;
    bonusKnopf();
  }).catch(function () {}).then(function () {
    // Der Empfang wartet auf diese Antwort — mit ihr steht fest, ob der
    // Tagesbonus in der Liste steht.
    empfangPruefen();
  });
}

// Den Bonus abholen und nur die Zahlen zurückgeben. Was daraus wird — Meldung,
// Klang, Münzflug — entscheidet, wer ihn abholt: das Bonusblatt oder der
// Empfang.
function bonusEinloesenRoh() {
  if (!bonusStatus || !bonusStatus.verfuegbar || !netzOk()) return Promise.resolve(null);
  return api('/api/tagesbonus', { method: 'POST' }).then(function (r) {
    bonusStatus = r.status;
    bonusKnopf();
    return r;
  });
}

function oeffneBonus() {
  show('bonus');
  renderBonus();
}

function renderBonus() {
  var box = $('bonus-inhalt');
  if (!box || !bonusStatus) return;
  var s = bonusStatus;
  var muenze = iconTag(rules.items[rules.currency].id);

  var leiter = '<div class="bonus-leiter">';
  s.stufen.forEach(function (stufe, i) {
    var tag = i + 1;
    var erreicht = tag < s.streak || (!s.verfuegbar && tag <= s.streak);
    var heute = s.verfuegbar && tag === s.streak;
    leiter += '<div class="bonus-tag' + (erreicht ? ' erreicht' : '') + (heute ? ' heute' : '') + '">' +
      '<span class="d">Tag ' + tag + '</span>' +
      '<span class="g">' + stufe.gold + muenze + '</span>' +
      (stufe.xp > 0 ? '<span class="x">+' + stufe.xp + ' XP</span>' : '') +
      (erreicht ? '<span class="hk">✓</span>' : '') +
      '</div>';
  });
  leiter += '</div>';

  var kopf = s.verfuegbar
    ? '<p class="lead">Tag ' + s.streak + ' in Folge — hol dir deine Belohnung ab!</p>'
    : '<p class="lead">Heute schon abgeholt. Komm morgen wieder für Tag ' +
        Math.min(s.streak + 1, s.laenge) + '.</p>';

  box.innerHTML = kopf + leiter;

  var knopf = document.createElement('button');
  knopf.className = 'primär';
  knopf.disabled = !s.verfuegbar || !netzOk();
  knopf.textContent = s.verfuegbar
    ? 'Abholen · ' + s.heute.gold + ' Gold' + (s.heute.xp > 0 ? ' + ' + s.heute.xp + ' XP' : '')
    : 'Morgen wieder';
  knopf.addEventListener('click', bonusEinloesen);
  box.appendChild(knopf);
}

function bonusEinloesen() {
  if (!bonusStatus || !bonusStatus.verfuegbar || !netzOk()) return;
  bonusEinloesenRoh().then(function (r) {
    if (!r) return;
    klang('muenzen');
    var muenzen = document.querySelector('.coins');
    if (typeof zahlAuf === 'function' && muenzen) {
      zahlAuf(muenzen.getBoundingClientRect(), '+' + r.gold, 'muenzen');
    }
    toast('Tagesbonus · +' + r.gold + ' Gold' + (r.xp > 0 ? ' + ' + r.xp + ' XP' : '') +
      ' — im Postfach', false);
    bonusKnopf();
    renderBonus();
    attempt(true);
    setTimeout(function () { if (view === 'bonus') show('farm'); }, 900);
  }).catch(function (e) {
    toast('Bonus ging nicht: ' + (e.message || 'Fehler'), true);
    bonusHolen();
  });
}

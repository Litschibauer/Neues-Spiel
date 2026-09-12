// Die Einführung für einen neuen Hof: geführt, nicht erzählt. Der Hof ist
// abgedunkelt, genau ein Element leuchtet, und es geht erst weiter, wenn der
// Spieler es wirklich getan hat — gesät, geerntet, hineingeschaut. Alles
// andere ist so lange gesperrt. Jederzeit überspringbar, und wer sie einmal
// hinter sich hat, sieht sie nie wieder (ns-tut-<hof>).
//
// Kein Systemfenster, keine Kartenfolge: eine kleine Blase im Stil des Spiels,
// oben oder unten, je nachdem, wo das leuchtende Element liegt.

var FUEHRUNG_SCHRITTE = [
  {
    id: 'willkommen',
    titel: 'Willkommen auf deinem Hof',
    text: 'Hier wächst, was du säst — auch wenn du gerade nicht da bist. Ich zeige dir kurz die ersten Schritte.',
    knopf: 'Los geht’s',
  },
  {
    id: 'saeen',
    titel: 'Säen',
    text: 'Tippe auf das leuchtende Feld und wähle Weizen.',
    feld: function (p) { return !p.busy && !p.done && p.tap === 'start'; },
    imBlatt: { pick: 'Wähle Weizen — der wächst am schnellsten.' },
    fertig: function (v) { return v.plots.some(function (p) { return fuehrungIstFeld(p) && (p.busy || p.done); }); },
  },
  {
    id: 'ernten',
    titel: 'Ernten',
    text: 'Weizen braucht einen Moment. Sobald das Ausrufezeichen erscheint, tippe das Feld an.',
    feld: function (p) { return p.done; },
    feldSonst: function (p) { return p.busy; },
    beginn: function () { fuehrungErntenStart = fuehrungZaehler(0); },
    fertig: function () { return fuehrungZaehler(0) > fuehrungErntenStart; },
  },
  {
    id: 'lager',
    titel: 'Das Lager',
    text: 'Deine Ernte liegt im Lager. Tippe auf das Lagerhaus und schau hinein.',
    element: 'lagerhaus',
    markiere: 'lager',
    fertig: function () { return view === 'lager'; },
  },
  {
    id: 'brett',
    titel: 'Das Brett',
    text: 'Am Brett hängen Zettel: Was drauf steht, lieferst du für Gold und Erfahrung.',
    element: 'brett',
    markiere: 'wagen',
    fertig: function () { return view === 'brett'; },
  },
  {
    id: 'bauen',
    titel: 'Bauen',
    text: 'Mit dem Hammer baust du Ställe, Mühle und mehr. Mit jeder Stufe kommt Neues dazu.',
    element: 'bauen',
    markiere: 'bauen',
    fertig: function () { return view === 'bau'; },
  },
  {
    id: 'fertig',
    titel: 'Das war’s',
    text: 'Der Rest erklärt sich beim Spielen — und der Hof läuft weiter, auch ohne Netz. Viel Freude!',
    knopf: 'Fertig',
  },
];

var fuehrungSchritt = -1;
var fuehrungTimer = null;
var fuehrungErntenStart = 0;
var fuehrungZentriert = false;

function fuehrungAktiv() { return fuehrungSchritt >= 0; }

function fuehrungIstFeld(p) {
  var d = rules && rules.plots[p.index];
  return !!d && d.id.indexOf('field-') === 0 && p.level > 0;
}

function fuehrungZaehler(i) {
  if (!client) return 0;
  var z = client.preview().zaehler || [];
  return z[i] || 0;
}

function fuehrungSicht() {
  return NS.farmView(client.preview(), rules, navigator.onLine);
}

// Welches Blatt gerade offen ist (auch das Auswahlblatt, das kein „view" hat).
function fuehrungOffenesBlatt() {
  var offen = [].slice.call(document.querySelectorAll('.sheet-bg')).filter(function (b) { return !b.hidden; });
  return offen.length ? offen[0].id.replace(/-bg$/, '') : null;
}

// Das Element, das leuchten soll — und der Platz dazu, falls es ein Feld ist.
function fuehrungZiel(schritt, v) {
  if (schritt.element) return { el: $(schritt.element), platz: null };
  if (!schritt.feld) return null;
  var felder = v.plots.filter(fuehrungIstFeld);
  var p = felder.filter(schritt.feld)[0] || (schritt.feldSonst ? felder.filter(schritt.feldSonst)[0] : null);
  if (!p) return null;
  return { el: document.querySelector('#plots .plot[data-platz="' + p.index + '"]'), platz: p };
}

function fuehrungLoch(rect) {
  var s = $('fuehrung-schatten');
  var r = $('fuehrung-ring');
  if (!rect) {
    s.style.clipPath = '';
    r.hidden = true;
    return;
  }
  var pad = 6;
  var l = Math.max(0, rect.left - pad), t = Math.max(0, rect.top - pad);
  var rr = Math.min(window.innerWidth, rect.right + pad), b = Math.min(window.innerHeight, rect.bottom + pad);
  s.style.clipPath = 'polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ' +
    l + 'px ' + t + 'px, ' + l + 'px ' + b + 'px, ' + rr + 'px ' + b + 'px, ' + rr + 'px ' + t + 'px, ' + l + 'px ' + t + 'px)';
  r.hidden = false;
  r.style.left = l + 'px';
  r.style.top = t + 'px';
  r.style.width = (rr - l) + 'px';
  r.style.height = (b - t) + 'px';
}

function fuehrungTick() {
  if (!fuehrungAktiv() || !client || !rules) return;
  var schritt = FUEHRUNG_SCHRITTE[fuehrungSchritt];
  var v = fuehrungSicht();
  if (schritt.fertig && schritt.fertig(v)) { fuehrungWeiter(); return; }

  var blase = $('fuehrung-blase');
  var schatten = $('fuehrung-schatten');
  var blatt = fuehrungOffenesBlatt();

  if (blatt) {
    // Ein Blatt liegt über dem Hof: nichts sperren, nur leise mitreden.
    schatten.hidden = true;
    $('fuehrung-ring').hidden = true;
    var satz = schritt.imBlatt && schritt.imBlatt[blatt];
    blase.hidden = !satz;
    if (satz) {
      $('fuehrung-titel').textContent = schritt.titel;
      $('fuehrung-text').textContent = satz;
      $('fuehrung-weiter').hidden = true;
      // Oben, über dem abgedunkelten Hof — nicht über den Knöpfen des Blatts.
      blase.classList.remove('unten');
    }
    return;
  }

  blase.hidden = false;
  $('fuehrung-titel').textContent = schritt.titel;
  $('fuehrung-text').textContent = schritt.text;
  $('fuehrung-schritt').textContent = (fuehrungSchritt + 1) + ' / ' + FUEHRUNG_SCHRITTE.length;
  var knopf = $('fuehrung-weiter');
  knopf.hidden = !schritt.knopf;
  if (schritt.knopf) knopf.textContent = schritt.knopf;

  var ziel = fuehrungZiel(schritt, v);
  if (ziel && ziel.platz && !fuehrungZentriert && hatRaster() && ziel.platz.gx >= 0) {
    fuehrungZentriert = true;
    zentriere(ziel.platz.gx + ziel.platz.size.w / 2, ziel.platz.gy + ziel.platz.size.h / 2);
    kameraKlemmen();
    kameraAnwenden();
  }
  if (schritt.knopf) {
    // Ein Satz, ein Knopf: alles dahinter gedimmt, kein Loch.
    schatten.hidden = false;
    fuehrungLoch(null);
    blase.classList.remove('unten');
    return;
  }
  if (!ziel || !ziel.el) {
    // Nichts zu zeigen (etwa kein freies Feld): dann nichts sperren.
    schatten.hidden = true;
    fuehrungLoch(null);
    blase.classList.remove('unten');
    return;
  }
  var rect = ziel.el.getBoundingClientRect();
  schatten.hidden = false;
  fuehrungLoch(rect);
  // Die Blase weicht dem Ziel aus: liegt es oben, redet sie von unten.
  blase.classList.toggle('unten', (rect.top + rect.bottom) / 2 < window.innerHeight * 0.5);
}

function fuehrungZeige(schritt) {
  fuehrungZentriert = false;
  if (schritt.markiere) {
    // Das Blatt, das dieser Schritt öffnet, erklärt sich hier — seine eigene
    // Einführung braucht es danach nicht mehr.
    try { localStorage.setItem(featureSchluessel(schritt.markiere), 'done'); } catch (e) {}
  }
  if (schritt.beginn) schritt.beginn();
  fuehrungTick();
}

function fuehrungStarten() {
  if (fuehrungAktiv()) return;
  fuehrungSchritt = 0;
  $('fuehrung').hidden = false;
  if (typeof show === 'function' && view !== 'farm') show('farm');
  fuehrungZeige(FUEHRUNG_SCHRITTE[0]);
  fuehrungTimer = setInterval(fuehrungTick, 200);
}

function fuehrungWeiter() {
  fuehrungSchritt++;
  if (fuehrungSchritt >= FUEHRUNG_SCHRITTE.length) { fuehrungEnde(); return; }
  fuehrungZeige(FUEHRUNG_SCHRITTE[fuehrungSchritt]);
}

function fuehrungEnde() {
  if (!fuehrungAktiv()) return;
  clearInterval(fuehrungTimer);
  fuehrungTimer = null;
  fuehrungSchritt = -1;
  $('fuehrung').hidden = true;
  try { localStorage.setItem(tutSchluessel(), 'done'); } catch (e) {}
  // Die Einführung hatte Vorrang — jetzt darf der Empfang.
  if (typeof empfangPruefen === 'function') empfangPruefen();
}

$('fuehrung-weiter').addEventListener('click', function () {
  klang('tipp');
  fuehrungWeiter();
});
$('fuehrung-skip').addEventListener('click', fuehrungEnde);
window.addEventListener('resize', function () { if (fuehrungAktiv()) fuehrungTick(); });

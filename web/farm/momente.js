// — Momente ————————————————————————————————————————————————————————————
// Im Spiel passieren gute Dinge, die bisher stumm blieben: Ein Erfolg wird
// fällig, ein Zettel kippt über die Ziellinie, der Tagesabschluss wird frei,
// die Kiste gibt ihre Beute her. Dieses Modul erkennt die Übergänge — es
// vergleicht die Sicht von eben mit der von jetzt — und macht aus jedem einen
// Moment: Klang, Meldung zum Antippen, ein Wink am richtigen Möbel.
//
// Es erfindet nichts. Alles, was hier gefeiert wird, steht schon im Spielstand;
// hier bekommt es nur den Ton, den es verdient.

var momenteGesehen = null;
// Beim Start hat der Empfang Vorrang: Was er aufzählt, muss nicht auch noch
// als Meldung hereinschneien.
var momenteStummBis = 0;
var momenteSchlange = [];
var momenteLaeuft = false;
// Welche Möbel gerade winken (Id → bis wann). Der Neuaufbau der Möbel läuft
// jede Sekunde; die Klasse muss deshalb bei jedem Aufbau neu gesetzt werden.
var momenteWinkt = {};

function lohnText(e) {
  var teile = [];
  if (e.gold > 0) teile.push(e.gold + ' Gold');
  if (e.xp > 0) teile.push(e.xp + ' XP');
  return teile.join(' + ');
}

function momentePruefen(v) {
  var jetzt = { erfolge: {}, aufgaben: {}, abschluss: false };
  (v.erfolge || []).forEach(function (e) { if (e.erfuellt && !e.eingeloest) jetzt.erfolge[e.id] = e; });
  ((v.aufgaben && v.aufgaben.liste) || []).forEach(function (a) {
    if (a.erfuellt && !a.eingeloest) jetzt.aufgaben[a.id] = a;
  });
  var ab = v.aufgaben && v.aufgaben.abschluss;
  jetzt.abschluss = !!(ab && ab.erfuellt && !ab.eingeloest);

  if (momenteGesehen === null) {
    momenteGesehen = jetzt;
    momenteStummBis = Date.now() + 6000;
    return;
  }
  var alt = momenteGesehen;
  momenteGesehen = jetzt;
  if (Date.now() < momenteStummBis) return;

  Object.keys(jetzt.aufgaben).forEach(function (id) {
    if (alt.aufgaben[id]) return;
    var a = jetzt.aufgaben[id];
    moment({
      klang: 'zettel', winkt: 'abenteuer', hin: 'abenteuer',
      text: 'Zettel erfüllt · ' + a.label + ' — ' + lohnText(a) + ' am Brett',
    });
  });
  if (jetzt.abschluss && !alt.abschluss) {
    moment({
      klang: 'zettel', winkt: 'abenteuer', hin: 'abenteuer',
      text: 'Alle Zettel ab — der Tagesabschluss wartet am Brett',
    });
  }
  Object.keys(jetzt.erfolge).forEach(function (id) {
    if (alt.erfolge[id]) return;
    var e = jetzt.erfolge[id];
    moment({
      klang: 'erfolg', punkt: true, hin: 'ziele',
      text: '★ Erfolg · ' + e.label + ' — ' + lohnText(e) + ' warten',
    });
  });
}

// Eine Warteschlange, damit drei Momente auf einmal nicht drei Meldungen
// übereinander sind, sondern drei nacheinander.
function moment(m) {
  momenteSchlange.push(m);
  momenteWeiter();
}

function momenteWeiter() {
  if (momenteLaeuft || momenteSchlange.length === 0) return;
  var m = momenteSchlange.shift();
  momenteLaeuft = true;
  // Die Aktion, die den Moment ausgelöst hat, hat ihre eigene Meldung. Die
  // darf man erst lesen; der Moment kommt einen Atemzug später obendrauf.
  setTimeout(function () { momentZeigen(m); }, 1300);
}

function momentZeigen(m) {
  klang(m.klang);
  if (navigator.vibrate) navigator.vibrate(12);
  toast(m.text, false, m.hin ? function () { show(m.hin); } : null);
  if (m.winkt) winke(m.winkt);
  if (m.punkt) {
    var p = $('zahnrad-punkt');
    if (p) {
      p.hidden = false;
      p.classList.add('neu');
      setTimeout(function () { p.classList.remove('neu'); }, 2800);
    }
  }
  setTimeout(function () { momenteLaeuft = false; momenteWeiter(); }, 3600);
}

function winke(id) {
  momenteWinkt[id] = Date.now() + 3000;
  winkeAnwenden();
}

function winkeAnwenden() {
  var jetzt = Date.now();
  Object.keys(momenteWinkt).forEach(function (id) {
    var el = $(id);
    if (!el) return;
    if (momenteWinkt[id] > jetzt) el.classList.add('winkt');
    else { el.classList.remove('winkt'); delete momenteWinkt[id]; }
  });
}

// — Die Kiste ————————————————————————————————————————————————————————
// Öffnen heißt bisher: „der Inhalt kommt mit der Post". Der Server würfelt die
// Beute, und irgendwann liegt sie als Karte im Postfach — der Moment, was war
// drin, fand nie statt. Dabei ist er der ganze Witz einer Kiste.
//
// Der Client erkennt ihn am Abgleich: Fällt die Zahl der offenen Kisten und
// wächst zugleich die Post, sind die neuen Einträge die Beute. War die Post
// voll, kommt die Beute erst später — dann wird sie beim nächsten Wachsen
// enthüllt.
var kisteWartet = false;

function momenteNachAbgleich(vorher) {
  if (!vorher || !client) return;
  var nachher = NS.farmView(client.preview(), rules, navigator.onLine);
  var gefallen = nachher.openBoxes < vorher.openBoxes;
  var dazu = nachher.mail.entries.length - vorher.mail.entries.length;
  if ((gefallen || kisteWartet) && dazu > 0) {
    kisteWartet = false;
    kisteEnthuellen(nachher.mail.entries.slice(vorher.mail.entries.length));
  } else if (gefallen) {
    kisteWartet = true;
  }
}

function kisteEnthuellen(beute) {
  var box = $('kiste-beute');
  if (!box || beute.length === 0) return;
  box.innerHTML = beute.map(function (b, i) {
    var gold = b.item === rules.currency;
    return '<div class="zeile" style="animation-delay:' + (0.45 + i * 0.18) + 's">' +
      itemIcon(b.item) + '<span>' + b.amount + (gold ? ' ' : '× ') + stueckName(b.amount, b.item) + '</span></div>';
  }).join('');
  var bild = $('kiste-bild');
  if (bild) bild.innerHTML = moebelSvg('kiste', {});
  $('kiste-feier').hidden = false;
  klang('truhe');
  setTimeout(konfetti, 420);
  if (navigator.vibrate) { try { navigator.vibrate([0, 30, 60, 40]); } catch (e) {} }
}

function kisteEinpacken() {
  $('kiste-feier').hidden = true;
  if (!client) return;
  var vorher = NS.farmView(client.preview(), rules, navigator.onLine);
  var r = client.collectMail();
  if (!r.ok) {
    // Zum Beispiel: Lager voll. Die Beute bleibt im Postfach — sie ist nicht weg.
    toast('Passt gerade nicht ins Lager — die Beute bleibt im Postfach', true);
    render();
    return;
  }
  save();
  scheduleSync();
  var nachher = NS.farmView(client.preview(), rules, navigator.onLine);
  var dazu = nachher.currency.amount - vorher.currency.amount;
  klang('muenzen');
  var muenzen = document.querySelector('.coins');
  if (dazu > 0 && muenzen) zahlAuf(muenzen.getBoundingClientRect(), '+' + dazu, 'muenzen');
  geldbeutelHuepft();
  toast('Eingepackt');
  render();
}

function kisteZu() {
  $('kiste-feier').hidden = true;
}

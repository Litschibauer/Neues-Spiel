// Der Angelsee — eine eigene Dimension. Erreichbar über das Boot-Symbol, wenn
// der Hof die nötige Stufe hat. Köder kaufen, auswerfen, Fisch fangen (der Fang
// selbst ist deterministisch im Sim, hier nur Anzeige & Bedienung).

// Boot-Knopf auf dem Hof nur zeigen, wenn der See offen ist.
function seeKnopf(v) {
  var knopf = $('see-auf');
  if (!knopf) return;
  knopf.hidden = !(v.angeln && v.angeln.available);
}

function oeffneSee() {
  var v = NS.farmView(client.preview(), rules, navigator.onLine);
  if (!v.angeln) { toast('Hier gibt es keinen See', true); return; }
  if (!v.angeln.available) {
    toast('Der Angelsee öffnet ab Stufe ' + v.angeln.minLevel, true);
    return;
  }
  show('see');
}

var seeSzeneGemalt = false;

function renderSee(v) {
  var a = v.angeln;
  if (!a) return;

  var szene = $('see-szene');
  if (szene && !seeSzeneGemalt) {
    szene.innerHTML = artSee();
    seeSzeneGemalt = true;
  }

  var box = $('see-inhalt');
  if (!box) return;
  box.textContent = '';

  var kopf = document.createElement('div');
  kopf.className = 'see-kopf';
  kopf.innerHTML =
    '<span>' + iconTag('bait') + ' <b>' + a.bait + '</b> Köder</span>' +
    '<span>🎣 ' + a.gefangen + ' gefangen</span>';
  box.appendChild(kopf);

  var werfen = document.createElement('button');
  werfen.className = 'primär see-werfen';
  werfen.disabled = a.bait < 1 || !isActive;
  werfen.textContent = a.bait < 1 ? 'Kein Köder — erst kaufen' : 'Auswerfen · −1 Köder';
  werfen.addEventListener('click', angelWurf);
  box.appendChild(werfen);

  var kosten = a.baitPrice * 5;
  var kauf = document.createElement('button');
  kauf.className = 'see-koeder';
  kauf.disabled = v.currency.amount < kosten || !isActive;
  kauf.innerHTML = '5 Köder kaufen · ' + kosten + ' ' + itemName(rules.currency);
  kauf.addEventListener('click', function () {
    act('5 Köder gekauft', client.buyNpc(a.baitItem, 5), 'kauf');
  });
  box.appendChild(kauf);

  var liste = document.createElement('div');
  liste.className = 'see-fische';
  a.table.forEach(function (t) {
    var karte = document.createElement('div');
    karte.className = 'see-fisch';
    karte.innerHTML =
      iconTag(rules.items[t.item].id, 'gross') +
      '<span class="n">' + nameOf(rules.items[t.item].id) + '</span>' +
      '<span class="c">' + t.chance + '%</span>';
    liste.appendChild(karte);
  });
  box.appendChild(liste);
}

function angelWurf() {
  if (!isActive) return;
  var vorher = client.preview().items.slice();
  var res = client.castLine();
  if (!res.ok) {
    toast(CODES[res.code] || res.code, true);
    klang('fehler');
    return;
  }
  var nachher = client.preview().items;
  var fisch = -1;
  for (var i = 0; i < nachher.length; i++) {
    if ((nachher[i] || 0) > (vorher[i] || 0) && rules.items[i].id.indexOf('fish-') === 0) {
      fisch = i;
      break;
    }
  }
  klang('ernte');
  save();
  scheduleSync();
  render();
  if (fisch >= 0) {
    toast('Gefangen: ' + itemName(fisch) + '! 🐟', false);
    var knopf = document.querySelector('.see-werfen');
    if (knopf) zahlAuf(knopf.getBoundingClientRect(), '+1 ' + itemName(fisch), 'ware');
  }
}

// Wasser-Szene mit Steg und Boot (rein dekorativ).
function artSee() {
  return (
    '<svg viewBox="0 0 100 60" preserveAspectRatio="xMidYMid slice" aria-hidden="true">' +
    '<defs><linearGradient id="see-w" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#4aa3c7"/><stop offset="1" stop-color="#2b6f92"/>' +
    '</linearGradient></defs>' +
    '<rect width="100" height="60" fill="url(#see-w)"/>' +
    '<rect width="100" height="14" fill="#7fc2dd" opacity=".5"/>' +
    '<path d="M0 22h100M0 30h100M0 40h100M0 50h100" stroke="#ffffff" stroke-width=".5" opacity=".25"/>' +
    '<ellipse cx="50" cy="26" rx="30" ry="6" fill="#1f5875" opacity=".35"/>' +
    // Steg
    '<rect x="6" y="34" width="34" height="5" rx="1" fill="#8a5a2b"/>' +
    '<rect x="10" y="39" width="3" height="10" fill="#6f4720"/>' +
    '<rect x="33" y="39" width="3" height="10" fill="#6f4720"/>' +
    // kleines Boot
    '<path d="M60 30h22l-4 7H64z" fill="#c0692e"/>' +
    '<rect x="70" y="18" width="1.4" height="13" fill="#7a5230"/>' +
    '<path d="M71.4 19l8 5-8 3z" fill="#f2f2f2"/>' +
    '</svg>'
  );
}

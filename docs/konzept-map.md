# Konzept-Map

> Gemeinsames Arbeitsdokument. Ideen kommen rein, werden verdichtet und markiert.

## Wie hier markiert wird

| Marke | Bedeutung | Prüffrage |
| --- | --- | --- |
| 🟢 | offline-fähig | Braucht weder anderen Spieler noch Zufall |
| 🔴 | online-only | Braucht geteilten knappen Zustand |
| 🟡 | offline mit Aufschub | Braucht Zufall → Ergebnis erst beim Sync (§5) |

**Verbindlich (Architektur §6):** Alles, was offline gehen kann, geht offline.
**D** = reine Daten · **M** = neue Mechanik (Regel + Referenzimplementierung + Golden Vectors)

---

## Die Verdichtung

Rund hundert Ideen aus der Sammlung — und darunter liegen **neun Mechaniken**. Der Rest
sind Tabellenzeilen.

### M1 · Produktionsplatz mit Rezept und Wartezeit 🟢 ✅ gebaut

**Das ist die große Erkenntnis: Feld, Tier und Maschine sind dieselbe Mechanik.**

```
Eingaben verbrauchen  →  Zeit vergeht  →  Ausgabe liegt bereit  →  abholen
```

| Was in der Liste stand | Ist in Wahrheit |
| --- | --- |
| Pflanzen säen und ernten | Platz, dessen Eingabe seine eigene Ausgabe ist |
| Obstbäume, Sträucher, Nachwachsen | Platz, der sich selbst neu bestellt |
| Mehrstufige Pflanzen | ein Timer, mehrere Anzeigestufen |
| Kuh → Milch, Huhn → Ei, Biene → Honig | Platz mit Futter als Eingabe |
| Mühle, Bäckerei, Molkerei, Grill, Weberei … | Platz mit mehreren Eingaben |
| Produktionsketten (Weizen → Mehl → Brot) | mehrere Plätze hintereinander — **entsteht von allein** |

Zehn Feldfrüchte, sechs Tierarten und zwölf Maschinen sind damit **28 Tabellenzeilen**,
nicht 28 Mechaniken. Und die Ketten muss niemand bauen: Sie entstehen, sobald die Ausgabe
des einen die Eingabe des anderen ist.

Parameter statt neuer Mechaniken: Warteschlangenplätze, Kapazität, Geschwindigkeit.

**Saatgut ist endlich, und es ist kein eigener Gegenstand.** Gesät wird die
Frucht selbst: Ein Feld frisst einen Weizen und gibt zwei zurück — der Gewinn
ist der eine, nicht die zwei. Ein zweiter Katalogeintrag „Weizensamen" wäre
doppelte Buchführung für dieselbe Sache. Das klingt nach einer Kleinigkeit und ist
die Stelle, an der die Wirtschaft überhaupt erst eine wird: Vorher entstand
Weizen aus dem Nichts, und jede Zahl weiter oben in der Kette hing an einer
Quelle ohne Boden.

Drei Dinge hängen zwingend daran, und alle drei stehen in `rules.ts`, nicht im
Code:

| Regel | Warum sie nicht optional ist |
| --- | --- |
| `startingItems` | Ohne ein einziges Korn beginnt ein frischer Hof in der Sackgasse, die §6 verbietet |
| `npcBuyPrice` | Wer seinen letzten Weizen verkauft, muss nachkaufen können — sonst ist der Hof endgültig tot |
| `npcBuyPrice > npcPrice` | Sonst wäre der Händler eine Geldpresse. `validateRuleset` erzwingt es, damit es kein Balancing-Versehen werden kann |

Die Gegenprobe steht als Test da (`rules.test.ts`): Für jedes ausgelieferte
Regelwerk muss jede verbrauchte Zutat eines Startplatzes nachkaufbar sein **und**
der Ertrag den Einkauf überzahlen. Ein Katalog, der das verletzt, kommt gar
nicht erst durch.

#### v3: aus der Linie wird ein Netz

Der erste echte Inhalts-Patch — und der Beweis, dass „Inhalt ist eine Tabelle"
keine Behauptung ist. Dazugekommen sind Mais, Kühe und eine Molkerei; geändert
hat sich **eine** Zeile Code (der Golden-Generator, der vorher annahm, Futter
brauche nur Weizen).

```
Feld → Weizen ┐
              ├→ Mühle → Futter ┬→ Gehege     → Eier
Feld → Mais   ┘                 └→ Kuhgehege  → Milch → Molkerei → Sahne
                                                                 → Butter
```

Zwei Dinge daran sind mehr als Inhalt:

1. **Ein Platz kann jetzt mehreres.** Ein Feld trägt Weizen *oder* Mais, die
   Molkerei macht Sahne *oder* Butter. Vorher war „Feld bestellen" eine Geste
   ohne Entscheidung. Die Auswahl steht als `options` im Anzeigemodell — welche
   Rezepte eine Stufe erlaubt, ist eine Spielregel und gehört nicht in die
   Oberfläche.
2. **Futter braucht jetzt Mais UND Weizen** — eine Änderung an einem
   *bestehenden* Rezept. Genau deshalb ist v3 eine neue Version und keine
   Korrektur in v2: Wer offline unter v2 seine Mühle beschickt hat, hat dafür
   drei Weizen bezahlt. Unter den neuen Zutaten nachgerechnet käme
   `NOT_ENOUGH_ITEMS` heraus und sein Abend wäre abgeschnitten.

**Die Balance-Regel, die dabei fast schiefging:** Die Milchkette ist die
teuerste Freischaltung im Spiel — Kuhgehege 2100, Molkerei 2000. Beim ersten
Durchrechnen zahlte sie *schlechter* als das Hühnergehege für 500. Das wäre
eine Falle gewesen: einmal gebaut, nie wieder angefasst. Was jetzt gilt:

| Stufe | Gold je Minute | freigeschaltet ab |
| --- | --- | --- |
| Weizen | 2,4 | Anfang |
| Mais | 1,6 | Anfang |
| Futter | 1,8 | Stufe 2 |
| Milch | 3,4 | Stufe 6 |
| Sahne | 5,5 | Stufe 7 |
| Eier | 6,3 | Stufe 3 |
| **Butter** | **8,0** | Stufe 7 |

Tiefer heißt besser — aber Eier bleiben stark genug, dass die günstige Kette
nicht wertlos wird. Kundenaufträge zahlen durchweg das Anderthalbfache des
Händlerpreises, auch für die neuen Waren.

#### v4: Ketten schalten zusammen frei, Tiefe steckt in den Rezepten

In v3 lag das Kuhgehege auf Stufe 6 und die Molkerei auf 7. Nachgemessen war
das sinnlos: **Kein einziges Stufentor greift jemals bei einem normalen
Spieler.** Gold wird ausgegeben, XP nur gesammelt — nach jedem Kauf ist die
Kasse leer, die Stufe bleibt. Deshalb liegt die Stufe strukturell immer vorn.

| Platz | Stufe frei ab | tatsächlich gekauft | Differenz |
| --- | --- | --- | --- |
| Mühle | 25 min | 60 min | 35 min |
| Gehege 1 | 40 min | 130 min | 90 min |
| Kuhgehege | 185 min | 560 min | 375 min |
| Molkerei (v3) | 310 min | 960 min | **650 min** |

Ein Stufentor auf einem **Platz** kann nur bei einem Fall greifen: viel Geld,
wenig Spielzeit. Als Tempo-Regler taugt es nicht.

**Also andersherum.** Seit v4 schaltet eine Kette auf *einer* Stufe frei —
Kuhgehege und Molkerei beide auf 6 —, und die Tiefe steckt in den Rezepten:

| Rezept | ab Stufe | Gold/min |
| --- | --- | --- |
| Sahne | 6 | 5,5 |
| Butter | 8 | 8,0 |
| Käse | 10 | 11,0 |

Das ist der bessere Hebel, weil er **gestaffelt** wirkt statt binär: Wer reich
und neu ist, bekommt eine Molkerei, die Sahne macht — und muss trotzdem spielen,
bis sie Käse kann. `RecipeDef.minPlayerLevel` ist dafür eine Zeile im Katalog;
die Sim prüft sie in `START`, das Anzeigemodell reicht sie als
`options[].unlocked` durch.

Zwei Regeln kamen dazu, beide in `validateRuleset`:

- **Kein Gebäude, das man kaufen kann und nicht benutzen darf.** Auf jeder
  kaufbaren Stufe muss mindestens ein Rezept schon offen sein. Sonst zahlt
  jemand 2000 Gold für ein Haus, das erst vier Stufen später etwas tut.
- **Kein Rezept über dem Höchstlevel.** Eine Sperre bei Stufe 15 in einer Welt
  mit zwölf Stufen ist kein Tor, sondern ein Loch.

Die Leiter wurde dafür von neun auf zwölf Stufen verlängert. Anhängen ist
erlaubt — bestehende Schwellen dürfen nur *sinken*, und keine tut das.

**Und die gesperrten Rezepte bleiben sichtbar.** Im Wähler steht „Butter — ab
Stufe 8", ausgegraut. Dieselbe Regel wie beim fehlenden Maiskorn: Was man nicht
kann, ist eine Information; was fehlt, ist ein Rätsel.

#### v5: drei Tiere pro Stall, jedes mit eigener Uhr

Bis v4 war ein Gehege *ein* Produzent: ein Timer, ein Klick, fertig. Ein Stall
mit drei Hühnern, die man einzeln füttert und einzeln aberntet, passt da nicht
hinein — und ist genau das, was ein Hofspiel ausmacht.

**Die Zustandsform bekommt eine Ebene.** Aus

```
Plot { level, recipe, startedAt }
```

wird

```
Plot { level, slots: [{ recipe, startedAt }, …] }
```

Wie viele Plätze eine Stufe hat, steht als `LevelDef.slots` im Katalog und
fehlt überall dort, wo es eins ist: `slotsAt()` liefert `slots ?? (Rezepte
vorhanden ? 1 : 0)`. Alle vier alten Regelwerke bleiben damit unverändert
gültig. `START` und `COLLECT` tragen ein `slot`, das ohne Angabe 0 ist — ein
Kommandolog aus v1 spielt Zeichen für Zeichen wie vorher ab.

**Ein Tier ist eine Ausbaustufe.** Kein neuer Command, kein Tierinventar:
`BUY` kauft die nächste Stufe, und die nächste Stufe hat einen Platz mehr.
„Jedes Tier kostet gleich viel" ist damit eine Zeile im Katalog und ein Test,
der es festhält. Drei Stufen, drei Tiere — mehr fasst ein Stall nicht.

**`BUY` darf jetzt während laufender Produktion.** Vorher hätte das das erste
Huhn zurückgesetzt, deshalb war es gesperrt. Jetzt bleiben die belegten Plätze
stehen und der neue kommt hinten dran — aber nur, wenn jedes laufende Rezept
auf der neuen Stufe erlaubt bleibt. Sonst weiterhin `PLOT_BUSY`.

**Jede Tierart frisst ihr eigenes Futter.** Die Mühle mahlt beides:

```
3 Weizen            → 2 Hühnerfutter   → Huhn → 3 Eier
1 Mais + 2 Weizen   → 2 Kuhfutter      → Kuh  → 2 Milch
```

Ein Tier frisst eine Portion. Das Kuhfutter ist ab Stufe 6 freigeschaltet —
derselben Stufe, auf der Kuhweide und Molkerei aufgehen.

| Rezept | Gold/min | ab Stufe |
| --- | --- | --- |
| Hühnerfutter | 1,8 | 2 |
| Kuhfutter | 1,8 | 6 |
| Milch | 3,2 | 6 |

**Was der Patch mit alten Höfen macht:** `GROW` füllt fehlende Plätze auf.
Ein leeres Gehege aus v4 (Stufe 1 hatte dort noch kein Rezept) wird in v5 zu
einem Stall mit einem Huhn — der Hof bekommt das erste Tier geschenkt statt
einen Platz zu verlieren. Zwei Hühner bleiben zwei Hühner, laufende Produktion
läuft weiter. Kühe fressen ab dem Patch Kuhfutter; wer Hühnerfutter im Lager
hatte, behält es für die Hühner.

**Die Oberfläche:** Ein Stall mit mehr als einem Platz öffnet beim Antippen ein
Blatt mit einer Zeile pro Tier — eigener Status, eigene Uhr, eigener Knopf —
plus „Alle ernten" und „Alle füttern", solange sich das lohnt. Die Kachel
selbst fasst zusammen: „3 Hühner · 1 fertig · 2 hungrig".

#### v6: die Uhr wird dreimal schneller

Die erste Änderung, die aus dem Spielen kam statt aus dem Nachrechnen: **Zwei
Minuten auf den ersten Weizen sind zu lang.** Wer anfängt, hat nichts zu tun
und nichts zu entscheiden — er wartet. Genau da hören Leute auf.

v6 ändert deshalb genau eine Sache: die Dauern. Kein Preis, keine Kosten, kein
XP-Wert, keine Stufenschwelle.

| Rezept | v5 | v6 |
| --- | --- | --- |
| Weizen | 100 s | **30 s** |
| Mais | 260 s | **90 s** |
| Hühnerfutter | 200 s | 60 s |
| Kuhfutter | 300 s | 90 s |
| Eier | 720 s | 240 s |
| Milch | 900 s | 300 s |
| Sahne | 600 s | 180 s |
| Butter | 1500 s | 480 s |
| Käse | 1800 s | 600 s |

**Warum überall und nicht nur vorn.** Die naheliegende Fassung — nur die Feldfrüchte
beschleunigen — kippt die Leiter: Weizen käme auf 8,0 Gold je Minute und läge
damit über Milch (3,2) und Sahne (5,5). Die teuerste Freischaltung im Spiel
zahlte dann schlechter als das Feld, das man geschenkt bekommt. Weil jede Zahl
im Katalog denselben Faktor bekommt, bleibt die Reihenfolge exakt erhalten:

| Rezept | Gold/min v5 | Gold/min v6 |
| --- | --- | --- |
| Mais | 1,6 | 4,7 |
| Hühnerfutter | 1,8 | 6,0 |
| Weizen | 2,4 | 8,0 |
| Milch | 3,2 | 9,6 |
| Sahne | 5,5 | 18,3 |
| Eier | 6,3 | 18,8 |
| Butter | 8,0 | 25,0 |
| Käse | 11,0 | 33,0 |

Auch die Stufen kommen dreimal schneller, weil XP je Ernte gleich blieb und die
Ernten dichter liegen. Der Ausbau eines Hofs war damit nie eine Geldfrage
allein, sondern immer eine Zeitfrage — die Zeitfrage ist jetzt eine andere.

**Der Preis dafür, offen gesagt:** Das längste im Spiel dauert jetzt zehn
Minuten. Das „morgen wieder reinschauen", von dem ein Live-Service-Spiel lebt,
gibt es damit nicht mehr — es gibt nur noch „gleich weiter". Wenn sich der Hof
zu schnell leerspielt, ist die Antwort nicht, den Anfang wieder zäh zu machen,
sondern **oben etwas Langes anzubauen**: eine Kette hinter dem Käse, deren
Stufen in Stunden rechnen. Vorne schnell, hinten lang — nicht überall mittel.

Die Wartezeit fürs Wegschicken eines Kunden ist mitgewandert: 30 → 10 Minuten.

**Laufende Produktion überlebt den Patch fair.** `RETIME` rechnet jede
angefangene Uhr um: Wer 50 Sekunden Restzeit hatte, hat danach 30 — nie mehr
als eine frische Runde, nie mehr als vorher. Nachgemessen für jeden möglichen
Fortschritt in `migration.test.ts`.

#### v7: aus Kundschaft wird ein Lieferwagen

Die Kundentafel war eine Liste, die immer voll war. Drei Wünsche, sofort
nachgefüllt, ohne Rhythmus und ohne Ort — man hat sie abgearbeitet wie ein
Formular. Ein Lieferwagen macht daraus etwas, das **da ist oder nicht da ist**:
Er steht auf dem Weg, man belädt ihn Posten für Posten, er fährt ab, und für
eine Weile ist er weg.

**Die Mechanik hängt an einer Zeile Zustand.** Der Wagen ist nicht „unterwegs"
als Flagge, die jemand umlegen müsste — er ist unterwegs, solange
`tick < truck.awayUntil`. Damit gibt es nichts fortzuschreiben, keinen Timer,
der beim Nachrechnen anspringen könnte, und offline stimmt es von allein.

```
truck { loaded: [2, 0], awayUntil: 8400 }
```

**Der Frachtbrief ist der erste Eintrag der Auftrags-Warteschlange.** Die gab
es schon: Der Server würfelt vor und legt bis zu zwanzig Aufträge in den
Zustand, der Client verbraucht sie. Das war bisher der Offline-Vorrat für die
Kundentafel und ist jetzt der Vorrat an Fuhren — **null neue Zufallslogik**,
und offline lassen sich zwanzig Fuhren hintereinander fahren, bevor Nachschub
nötig wird. Der nächste Brief ist deshalb auch schon sichtbar („Als Nächstes").

Zwei neue Commands, mehr nicht:

| Command | Regel |
| --- | --- |
| `LOAD_TRUCK {stack, amount}` | Wagen da, Posten gibt es, nie mehr als verlangt, Ware im Lager |
| `SEND_TRUCK` | jeder Posten voll → Lohn und XP sofort, Wagen weg für `truckAwayTicks` |

**Eine Falle, die auffiel, bevor sie eine wurde:** Verschwindet der Frachtbrief
auf einem anderen Weg — abgelehnt oder über das alte `FILL_REQUEST` geliefert —,
dann würde die Ladung auf dem Wagen stehen bleiben und beim *nächsten* Brief
mitzählen. Das wäre Freifracht gewesen. Beide Wege erstatten deshalb die
Ladung ins Lager und leeren die Ladefläche; ein Test hält jeden fest.

Die Fuhren sind eigene Vorlagen, keine umbenannten Kundenwünsche: größer
(10–12 Einheiten statt 3–5), oft zweispaltig, und sie zahlen **1,9×** statt
1,5× Händlerpreis. Ein Wagen zu beladen soll sich lohnen.

Was noch fehlt und bewusst getrennt kommt: **Laufkundschaft**, die zufällig
auftaucht und wieder geht, und **Events**. Beide brauchen dieselbe Bauform —
vorgewürfelt im Zustand, damit sie offline gelten — aber jeweils eine eigene
Warteschlange.

#### v8: ein Brett mit vier Zetteln, und der Händler macht zu

Drei Änderungen, die zusammengehören, weil sie alle dasselbe wollen: **Der
Hof soll ein Ort sein, an dem Spieler miteinander handeln — nicht ein Formular
mit einem Automaten daneben.**

**1. Vier Zettel statt eines Frachtbriefs.** Am Brett hängen vier Lieferungen,
jede an einen anderen Ort. Wer die Ware hat, schickt sie los; wer sie nicht
mag, tauscht den Zettel gegen den nächsten aus dem Vorrat — mit kurzer
Wartezeit, damit Durchwürfeln nichts bringt. Das Brett sind schlicht die
ersten vier Einträge derselben vorgewürfelten Warteschlange wie vorher.

Das Beladen Posten für Posten aus v7 ist damit weg. Es klang gut und war in
der Hand zäh: vier Zettel × drei Posten wären zwölf Zustände gewesen, die
alle irgendwo hin müssen. Jetzt gilt **ganz oder gar nicht** — die Ware ist
da oder sie fehlt, und der Zettel sagt genau, wie viel.

**2. Der Wagen fährt wirklich.** `truckAwayTicks` ist von sieben Minuten auf
**neun Sekunden** gefallen. Er ist keine Wartezeit mehr, sondern eine
Bewegung: Er rollt links aus dem Bild, ist kurz weg, kommt zurück. Solange er
fährt, geht kein zweiter Zettel raus — das ist der ganze Takt, und er reicht.

**3. Kein Händler mehr.** Drei Riegel, alle als Daten im Regelwerk, keiner als
`if` im Kern:

| Flagge | Wirkung |
| --- | --- |
| `sellNpcDisabled` | `SELL_NPC` wird abgewiesen — Ware geht an Zettel oder an andere Höfe |
| `boardDeliveryOnly` | `FILL_REQUEST` wird abgewiesen — Lieferungen laufen über das Brett und damit über den Wagen |
| `emergencyBuyOnly` | `BUY_NPC` nur, wenn das Fach **leer** ist, und dann genau eins |

Ältere Regelwerke haben die Flaggen nicht und verhalten sich unverändert —
alte Kommandologs spielen Zeichen für Zeichen gleich ab.

**Die Sackgasse, die dadurch entsteht, und der Riegel dagegen.** Ohne Händler
kann ein Hof sich totspielen: letztes Korn gesät, Ernte verkauft, kein Gold für
Nachschub. Deshalb prüft `validateRuleset` jetzt, dass das **Startgold für
mindestens einen Notkauf jeder Startzutat reicht** — v8 gibt 60 Gold mit, ein
Korn kostet 6. Ein Test spielt den Weg zurück: leerer Hof → ein Korn kaufen →
viermal säen und ernten → Zettel abschicken.

**Und die Leiste unten ist weg.** Brett, Lager und Verkaufsstand stehen als
Gebäude am Weg. Antippen öffnet sie als Blatt über dem Hof. Es gibt nur noch
**eine** Ansicht, und das ist der Hof.

#### v9: Schatzkisten, Baumaterial, ein Lager das wächst

Das ist **M9 — aufgeschobener Zufall**, und es ist der erste Fall, in dem
Vorwissen ein Cheat wäre. Bei einem Kundenwunsch ist es egal, ob der Client
ihn vorher kennt; bei einer Mystery-Kiste ist genau das der ganze Reiz.

**Die Lösung teilt die Kiste in zwei Hälften.** *Wann* eine Kiste kommt, würfelt
der Server im Voraus und legt es in den Zustand — deshalb tauchen Kisten auch
im Funkloch auf. *Was* drin ist, würfelt er erst, wenn er die geöffnete Kiste
sieht.

```
Server plant vor:   chests [{id, kind, readyAt}, …]   ← im Zustand, offline sichtbar
Spieler öffnet:     OPEN_CHEST → pendingBoxes [kind]  ← kein Inhalt, nirgends
Server beim Sync:   würfelt die Tabelle → Postfach    ← erst hier entsteht die Beute
```

`OPEN_CHEST` schüttet **lokal nichts aus**. Ein Test prüft genau das: nach dem
Öffnen ist im kanonisierten Zustand kein Gramm Beute zu finden, nur die Art der
offenen Kiste. Ein manipulierter Client kann also nichts vorher sehen — es gibt
nichts zu sehen. Und der Weg ins Postfach ist derselbe, den Marktverkäufe schon
gehen: „etwas ist angekommen, während du nicht hingeschaut hast".

**Baumaterial ist nicht lagerpflichtig.** Bretter und Nägel liegen wie Gold
neben dem Lager statt darin — sonst müsste man Platz opfern, um Platz zu
gewinnen. Nebenwirkung, die passt: Was nicht lagerpflichtig ist, ist auch nicht
handelbar (`isTradable` verlangt beides), Material bleibt also am eigenen Hof.

**Das Lager ist keine Konstante mehr.** `siloLevels` ist eine Tabelle im
Katalog, `capacityOf(state, rules)` löst sie auf, und `UPGRADE_SILO` zahlt die
nächste Stufe:

| Stufe | Platz | Preis |
| --- | --- | --- |
| 1 | 200 | — |
| 2 | 280 | 8 Bretter, 4 Nägel, 300 Gold |
| 3 | 380 | 16 Bretter, 10 Nägel, 900 Gold |
| 4 | 500 | 28 Bretter, 20 Nägel, 2200 Gold |
| 5 | 650 | 44 Bretter, 34 Nägel, 5000 Gold |

Ältere Regelwerke haben keine `siloLevels` — dort fällt `capacityOf` auf
`siloCapacity` zurück, und alte Logs rechnen unverändert.

#### v10: ein Raster, auf dem man selbst baut

Bis v9 stand jedes Gebäude dort, wo der Katalog es hinschrieb — schön, aber
nicht deiner. Seit v10 ist der Hof ein **Raster von 8 × 10 Feldern**, und wo
etwas steht, ist **Spielzustand**.

Genau diese Grenze hatte ich beim „Hof als Ort" bewusst offengelassen: Solange
die Position Katalogdaten sind, kostet sie nichts. Sobald der Spieler umbauen
darf, wird sie Zustand — mit allem, was daranhängt: ein Command, eine
Migration, Invarianten, Golden Vectors.

```
Plot { level, slots, gx, gy }        gx < 0 = gekauft, aber noch nicht hingestellt
PlotDef { …, size: {w, h} }          wie viele Felder das Gebäude braucht
Ruleset { …, grid: {w: 8, h: 10} }
```

**Ein Command reicht für beides.** `PLACE {plot, gx, gy}` stellt hin *und*
verschiebt — der Unterschied ist nur, ob vorher schon eine Stelle da war. Die
Sim prüft Rand, Überlappung mit jedem anderen Gebäude und dass der Platz
überhaupt gekauft ist. Ein Umzug behält Stufe, Ladung und laufende Uhren; ein
Test hält fest, dass die Saat den Umzug übersteht.

**Gekauft heißt noch nicht hingestellt.** `BUY` verändert nur die Stufe, die
Stelle bleibt leer, und `START` weist ein Gebäude im Nirgendwo mit `NOT_PLACED`
ab. Die Oberfläche macht daraus eine Geste: kaufen → „wohin?" → tippen.

**Was am Anfang steht:** Lager, Wagen, Brett, Stand und das Hofhaus stehen fest
am oberen Rand — sie sind kein Platz im Katalog und wandern nicht. Auf dem
Raster liegen anfangs nur die drei Startfelder. Alles andere kauft man im
Bauen-Menü und stellt es selbst hin.

**Die Aufsicht ist eine Projektion, keine neue Grafik.** Der Boden wird als
Trapez gezeichnet — die hintere Reihe ist 66 % so breit wie die vordere —, und
jedes Gebäude steht aufrecht auf seiner Zelle, nach Tiefe sortiert. Felder
liegen flach (`flat: true` im Katalog), Gebäude stehen 1,55-mal so hoch wie
ihre Grundfläche tief ist. Kein einziges Bild musste dafür neu gezeichnet
werden.

**Der Riegel dazu:** `validateRuleset` rechnet nach, dass alle Gebäude zusammen
aufs Raster passen; ein Test verlangt zusätzlich 50 % Luft, sonst wäre „frei
platzieren" eine Lüge. Die Migration 9 → 10 setzt bestehende Höfe an die
Stellen, die ihren alten Prozentkoordinaten am nächsten kommen, und packt
Kollisionen deterministisch in die erste freie Lücke.

#### v11: Hindernisse auf dem Raster, Kisten mittendrin

Ein leeres 8 × 10-Feld ist ein Parkplatz, kein Hof. v11 stellt **Bäume, Steine
und einen Tümpel** darauf — als Katalogdaten, nicht als Zustand:

```
obstacles: [{ kind: 'tree', gx: 0, gy: 0, w: 1, h: 1 }, …]
```

Damit kosten sie nichts: kein Command, keine Migration, kein Feld im Zustand.
Die Sim fragt bei `PLACE` einmal `blockiert()` ab, und `validateRuleset` rechnet
nach, dass Gebäude **und** Hindernisse zusammen aufs Raster passen und dass kein
Startplatz auf einem Stein landet. Das Raster wuchs dafür auf 9 × 11.

Ein Test verlangt darüber hinaus **20 % Luft** nach Abzug von allem — sonst wäre
„frei platzieren" wieder nur eine Behauptung.

**Die Kisten liegen jetzt auf dem Hof statt neben der Scheune.** Der Server
würfelt beim Einplanen nicht nur *wann*, sondern auch *wo*: ein freies Feld,
das weder ein Gebäude noch ein Hindernis belegt. Und sie kommen doppelt so oft
(alle 15 statt 30 Minuten, acht statt sechs im Vorrat).

> Ehrlich dabei: Eine Kiste, die für in zwei Stunden eingeplant ist, kann bis
> dahin unter einem neu gebauten Stall liegen. Sie wird dann darüber gezeichnet
> statt zu verschwinden — sichtbar bleibt sie, hübsch ist es nicht. Blockieren
> lassen wollte ich sie nicht: Dann könnte eine unsichtbare Kiste einen Bauplatz
> sperren, und *das* wäre wirklich ärgerlich.

**Was der Ziehen-Test gefunden hat:** Die Vorschau beim Verschieben prüfte Rand
und Nachbarn, aber nicht die Hindernisse — das Gebäude leuchtete grün über einem
Baum und sprang beim Loslassen zurück. Zwei Prüfungen derselben Regel an zwei
Orten laufen auseinander; hier hat es der Browserlauf gefangen.

#### v12: Werkzeug aus Kisten, Hindernisse zum Wegräumen

Aus Deko wird Inhalt. Die Kisten geben jetzt **genau ein Stück**, und die
Auswahl ist klein und lesbar: ein Brett, ein Nagel, eine Säge, eine Schaufel,
eine Spitzhacke. Kein „2–5 Weizen" mehr — eine Kiste ist ein Fund, keine
Lieferung.

| Hindernis | Werkzeug | bringt |
| --- | --- | --- |
| Baum | Säge | 15 XP |
| Stein | Spitzhacke | 25 XP |
| Tümpel | Schaufel | 40 XP |

**Damit wandern die Hindernisse in den Zustand** — bis v11 waren sie reine
Katalogdaten und kosteten nichts. Jetzt merkt sich der Hof, was schon weg ist:

```
clearedObstacles: [0, 3]      Indizes in rules.obstacles
CLEAR_OBSTACLE { index }      Werkzeug weg, Feld frei, XP dazu
```

Der Index bleibt gültig, weil die Hindernisliste wie jede Katalogtabelle nur
hinten wächst. `blockiert()` bekam einen Parameter mehr und fragt jetzt, was
geräumt ist — dieselbe Funktion, überall dieselbe Antwort: in der Sim, in der
Migration, bei der Kistenplanung und in der Vorschau beim Verschieben.

**XP fürs Aufräumen ist mehr als eine Zahl.** Es ist der einzige Weg im Spiel,
Erfahrung zu bekommen, ohne etwas zu produzieren — und damit ein Grund, sich um
den Hof selbst zu kümmern statt nur um die Produktionskette. Ein Tümpel bringt
so viel wie eine ganze Stufe am Anfang.

#### v13: eine Kiste, nicht zwölf

Zwölf Kisten gleichzeitig auf dem Hof waren eine Sammelaufgabe, kein Fund. Ab
v13 liegt **immer genau eine** da, und die nächste kommt erst, wenn diese
abgeholt ist — plus sieben Minuten.

Das Schöne daran: Die Wartezeit hängt jetzt an einer *eigenen Handlung* statt
an einem Fahrplan, und genau deshalb bleibt sie offline berechenbar.
`OPEN_CHEST` setzt `chestReadyAt = tick + chestEveryTicks`; sichtbar ist
`chests[0]`, sobald der Tick da ist. Der Vorrat im Zustand schrumpft auf zwei
Einträge: die liegende Kiste und die nächste, deren Art und Stelle der Server
schon gewürfelt hat.

Weil zwischen Auswürfeln und Erscheinen jetzt nur noch eine Kiste liegt, kann
der Server die Stelle der vordersten beim Sync **nachbessern**, falls dort
inzwischen etwas gebaut wurde. Das Problem aus v11 — Kiste unter dem Stall —
löst sich damit von selbst.

> Der Testlauf hat mich hier ausgelacht: Die Prüfung „nach dem Öffnen ist keine
> Kiste da" schlug fehl, weil ich dem Server vorher 120 Sekunden geschenkt
> hatte — mehr als die 60 Sekunden Wartezeit im Dev-Regelwerk. Das Spiel hatte
> recht, der Test hatte unrecht.

#### v14: der Verkaufsstand hat Kästchen

Bis v13 war das Anbieten ein Formular: für jede Ware im Lager eine Karte mit
zwei Zahlenfeldern. Wer acht Waren hatte, scrollte durch acht Karten, und die
Frage „was steht eigentlich gerade in meiner Auslage?" beantwortete ein
zweiter Abschnitt weiter unten.

v14 dreht das um. Der Stand ist jetzt das, was er im Spiel auch ist: **eine
Reihe Kästchen**, sechs Stück, leer oder voll. Ein leeres tippt man an und
wird gefragt — erst welche Ware, dann Menge und Preis. Ein volles zeigt, was
drinsteht, und gibt es mit einem Tipp zurück.

Dazu zwei Grenzen, beide als Regelwerksdaten:

```
maxOfferAmount: 10     höchstens zehn Stück je Kästchen
maxOfferPrice: 500     harter Deckel über dem Preisband
```

`offerLimits()` rechnet beides zu einer Antwort zusammen, und alle drei
Stellen fragen dieselbe Funktion: die Sim beim `LIST_ORDER`, das Ansichts-
modell für die Regler, die Prüfung beim Laden eines Regelwerks. Der Deckel
liegt über dem Band und schneidet es nur dort ab, wo es teuer wird — heute
allein beim Käse (Band bis 630, Deckel 500). Alles darunter merkt nichts
davon, und `validateRuleset` schlägt an, sobald ein Deckel unter den
Mindestpreis einer handelbaren Ware rutschen würde.

Die alten Regelwerke bleiben ohne die beiden Felder, also ohne Grenze — ein
Log aus v13 spielt sich unverändert ab. Aufträge, die vor der Migration
eingestellt wurden, bleiben stehen, wie sie sind: Sie waren legal, als sie
entstanden. Die Grenze gilt beim Hinstellen, nicht als Zustandsbedingung.

> Der Testlauf war hier der ehrlichste Kritiker: Die alte Prüfung „leergespielt"
> hat den ganzen Weizen mit einem Tipp auf *alle* in ein einziges Kästchen
> geschoben. Das geht jetzt nicht mehr — und genau das ist der Punkt der
> Änderung. Der Test verkauft den Hof seitdem in Zehnerschritten an den
> zweiten Hof, also über den Markt, den es dafür gibt.

### M2 · Lagerlimit über alle Waren 🟢 ✅ gebaut
Scheune, Silo, Stapel, Engpässe zwischen Rohstoff und Produkt — alles dieselbe Grenze (§7).

### M3 · Zeit als Kostenfaktor 🟢 ✅ gebaut
Servergemessen, damit fälschungssicher (§4).

### M4 · Verkauf zu Festpreis 🟢 ✅ gebaut
Münzen, NPC-Preise, Produktionskosten, Verkaufspreise — eine Regel, viele Zahlen.

### M5 · Verkaufsauftrag mit Escrow 🟢 einstellen / 🔴 kaufen ✅ gebaut
Preisband, Einstellgebühr, Postfach — und seit dem Orderbuch auch die andere Seite:
**zwei Höfe handeln wirklich miteinander.**

Die Grenze zwischen offline und online läuft hier mitten durch eine Mechanik
hindurch, und sie liegt nicht dort, wo man sie zuerst vermutet:

| | geht offline | warum |
| --- | --- | --- |
| **Einstellen** | ✅ | Einseitig. Der Spieler committet Ware, die er nachweislich hat; sie verlässt sofort sein Lager. |
| **Zurückziehen** | ✅ | Ebenfalls einseitig — solange niemand gekauft hat. |
| **Kaufen** | ❌ | Zwei Leute können dieselbe Kiste wollen. Wer sie bekommt, entscheidet sich nicht auf einem Gerät. |

Drei Entscheidungen, die dabei nicht offensichtlich waren:

1. **Die Auslage liegt im Zustand, nicht im Kaufbefehl.** Ein Preis, den der
   Client mitschickt, ist ein Preis, den der Client wählt. Also legt der Server
   eine Handvoll fremder Angebote in den Snapshot (`state.offers`), und der
   Sim-Kern rechnet den Kauf ganz normal nach. Was er nicht wissen kann, ist, ob
   das Angebot noch da ist — das entscheidet der Markt beim Sync.
2. **Ein verlorenes Rennen ist kein Regelverstoß.** Der Server schneidet den
   Batch an dieser Stelle ab (`OFFER_GONE`); alles davor bleibt bestehen.
   Dieselbe Präfix-Mechanik wie überall — nur diesmal für Pech statt für Cheats.
3. **Der Kauf gewinnt gegen ein späteres Zurückziehen.** Der unangenehmste Fall:
   Der Verkäufer zieht im Funkloch zurück, während längst jemand gekauft hat. Nur
   eine Seite kann gewinnen, und es muss die sein, auf der jemand bezahlt hat.
   Deshalb wirkt ein Verkauf **sofort** auf den Snapshot des Verkäufers; sein
   `CANCEL_ORDER` läuft danach ins Leere.

Der Erlös kommt durchs Postfach, wie jedes Ereignis, von dem der Spieler nichts
wissen konnte (§7). Und weil ein Verkauf den Zustand ändert, ohne dass der
Spieler etwas getan hat, schweigt der Kanarienvogel in genau diesem Sync — sonst
meldete er einen Determinismus-Bug, den es nicht gibt.

### Was mit Ware passiert, die niemand kauft

Die Frage, an der sich entscheidet, ob eine Spielwirtschaft ehrlich ist:
**Nichts wird vernichtet.**

Ware in der Auslage **bleibt stehen**, bis jemand sie kauft oder der Verkäufer
sie zurückholt (`orderTtlTicks: 0` — Frist aus). Es gab einmal eine Frist, nach
der alles ins Postfach zurückfiel; sie ist weg, weil sie das falsche Problem
löste. Der Spieler, der drei Tage nicht spielt, verlor damit seine
Verkaufschance, ohne die Ware früher wiederzubekommen.

| Fall | Was passiert |
| --- | --- |
| Niemand kauft | Der Auftrag steht weiter — unbegrenzt |
| Zurückgezogen | Ware geht ins Lager, wenn Platz ist; sonst bleibt der Auftrag stehen |
| Verkauft | Erlös ins **Postfach** des Verkäufers, Ware zum Käufer |
| Abgeholt bei vollem Lager | Was passt, kommt ins Lager; der Rest bleibt liegen |

**Und was hindert einen daran, die Auslage als Zweitlager zu benutzen?** Zwei
Dinge, und das erste allein reichte nicht:

1. **Die Slots.** `orderSlots` begrenzt, wie viele Aufträge gleichzeitig
   offenstehen. Ein harter Riegel, aber ein grober — mit ein paar Slots lässt
   sich trotzdem dauerhaft Ware parken.
2. **Die Einstellgebühr** (`listingFeePct`, aktuell 5 %). Sie fällt **beim
   Einstellen** an, sofort, aufgerundet und unabhängig davon, ob je jemand
   kauft. Damit kostet schon das Hinlegen etwas, und Parken ist kein Gratis-Trick
   mehr, sondern eine Rechnung.

Bemessen wird sie am **NPC-Wert**, nicht am Wunschpreis. Sonst wäre sie eine
Strafe aufs Hochpreisen, und alle böten am unteren Bandrand an. Gerechnet wird
sie in `listingFee()` — einmal, für Sim und Oberfläche gemeinsam: Der angezeigte
Preis und der bezahlte müssen dieselbe Zahl sein, sonst glaubt ein Spieler dem
Spiel nichts mehr.

Nebenwirkung, die man kennen muss: Ein Hof mit **null Gold kann nichts
einstellen.** Das ist keine Sackgasse — der NPC-Händler kauft immer, und drei
Münzen für ein Korn reichen für die erste Gebühr. Aber der Markt ist damit
nicht mehr der allererste Schritt eines neuen Spielers, sondern der zweite.

### M6 · Auftrag erfüllen 🟢 ✅ gebaut
„Liefere N×A und M×B, bekomme Münzen." LKW, Kunden, Boote, Sonderaufträge,
Eventaufgaben — **eine** Mechanik, der Rest sind Auftragsvorlagen als Daten.

Und sie ist der erste Ort, an dem **Zufall und Offline zusammenkommen**: Der Server
würfelt die Aufträge im Voraus und gibt einen Stapel mit dem Snapshot mit. Der
Client verbraucht ihn, ohne je selbst zu würfeln — Falle 3 unten, in Code gegossen.

#### Einen Auftrag wegschicken

Ein Auftrag, den man nicht erfüllen kann, blockiert sonst einen der drei Plätze,
bis man ihn irgendwann doch bedient. Das ist kein interessanter Engpass, sondern
Ärger. Also darf man ihn wegschicken — und **bezahlt mit Zeit, nicht mit Geld**
(`requestSkipCooldownTicks`, aktuell 30 Minuten).

Das ist die wichtigste Zeile daran. Eine Gebühr träfe den Falschen: Wer wenig
hat, sitzt seinen schlechten Auftrag ab; wer viel hat, kauft sich die perfekte
Auslage. Eine Wartezeit trifft alle gleich und lässt sich nicht umgehen — genau
der Hebel, den ein Spiel ohne Bezahlvorteile haben darf.

Drei Regeln halten die Schlange davon ab, ein Regal zu werden:

| Regel | Wogegen |
| --- | --- |
| Nur die vorderen `requestSlots` | Sonst gräbt man sich bis zum besten Auftrag durch |
| Danach Wartezeit | Sonst ist Überspringen kostenlos und die Auslage immer perfekt |
| Kein Ertrag — kein Gold, keine Ware, kein XP | Es ist ein Verzicht, keine Aktion |

**Offline gültig**, obwohl Aufträge aus dem Zufall stammen: Der Nachrücker liegt
schon im Vorrat (§5). Es wird nichts gewürfelt, nur nach vorn gerückt.

Die Wartezeit steht als **Zeitpunkt** im Zustand (`skipReadyAt`), nicht als
Restzeit. Sonst müsste sie bei jedem Zeitfortschritt mitgezählt werden — eine
zweite Stelle, an der Client und Server auseinanderlaufen können. So ist es ein
Vergleich gegen `tick` und sonst nichts. Nebeneffekt, der zufällig richtig ist:
Ändert ein Patch die Wartezeit, wartet, wer schon wartet, die Zeit zu Ende, die
galt, als er sich entschieden hat.

### M7 · Ausbauen und Freischalten 🟢 ✅ gebaut
„Zahle Kosten, ändere dauerhaft einen Parameter." Steht als `BUY` samt Ausbaustufen
je Platz. Trägt heute schon „Gehege kaufen" und „Hühner kaufen" — zwei Dinge, die
sich im Spiel völlig verschieden anfühlen und dieselbe Regel sind. Deckt später ab:
Felder erweitern, Ställe ausbauen, Lager vergrößern, Slots und Geschwindigkeit
upgraden, Gebäude bauen.

### M8 · Level und Freischaltungen 🟢 ✅ gebaut
Erfahrung sammeln, Schwelle überschreiten, Tabelle sagt was neu ist. Der
Technologie-/Forschungsbaum ist dieselbe Mechanik mit Vorbedingungen statt Levelzahl.

**Die kleinste Mechanik im Projekt — und die einzige ohne eigenes Command.**
Erfahrung fällt beim Abholen und Liefern nebenbei an; das Level wird daraus
abgeleitet (nicht gespeichert, sonst laufen zwei Zahlen auseinander); und seine
ganze Wirkung ist eine Zahl neben dem Preis eines Platzes.

Ein Haken, der nicht offensichtlich war: Weil das Level *abgeleitet* ist, würde
eine Levelkurve, die in einem Patch **steigt**, Spieler zurückstufen — und ihnen
Plätze wieder zusperren, die sie längst gekauft haben. Deshalb dürfen Schwellen
über Versionen hinweg nur sinken. `levels.test.ts` erzwingt das.

### M9 · Aufgeschobener Zufall 🟡 **M**
Eine Regel für alle Würfel (§5) — siehe die Zufalls-Regel unten.

---

## Was NICHT in die Sim gehört

**Dekoration, Wege, Zäune, Teiche, optische Upgrades, saisonale Deko.**

Solange das keinerlei Spielwirkung hat, gehört es **nicht in den deterministischen
Zustand**. Der Server speichert es als undurchsichtigen Datenblock, der Client zeichnet es.
Kein Determinismus-Risiko, keine Golden Vectors, keine Migration.

⚠️ Sobald Deko einen Bonus gibt, wandert sie in die Sim und kostet den vollen Preis. Das
ist eine bewusste Entscheidung wert, keine beiläufige.

---

## Vier Fallen in der Liste

### 1. Zeit darf offline nie Fortschritt zerstören 🚨

„Tiere brauchen Futter" und „Bäume müssen nachwachsen" sind harmlos — solange Abwesenheit
nichts *kaputt* macht. Würden Tiere verhungern oder Ernten verfaulen, wäre Offline-Spielen
bestraft, und das Versprechen wäre eine Falle statt eines Features.

> **Regel: Zeit pausiert Fortschritt, sie vernichtet ihn nie.**
> Ein ungefüttertes Tier produziert nicht weiter. Es stirbt nicht.

(Hay Day macht das genau so — und das ist kein Zufall.)

### 2. Wetter kann den Kern vergiften 🚨

Von allen 🟡 ist **Wetter** das einzige, das gefährlich ist: Wenn Regen das Wachstum
beeinflusst und Regen zufällig ist, kann der Client offline nicht mehr ausrechnen, wann ein
Feld reif ist. Damit wäre der **Kernkreislauf** nicht mehr offline-fähig — der teuerste
Fehler, den diese Liste hergibt.

Zwei saubere Auswege:

- **Wetter im Voraus geplant.** Der Server schickt den Wetterplan der nächsten Tage mit dem
  Snapshot. Für den Client ist er dann schlicht bekannt → 🟢, voll deterministisch.
- **Wetter nur additiv.** Es gibt Boni, verändert aber nie die Grunddauer → der Kern bleibt
  berechenbar.

Was nicht geht: Wetter, das während der Offline-Phase entsteht und rückwirkend die
Wachstumszeit ändert.

### 3. Zufall vorwürfeln statt nachwürfeln

Nicht jeder Würfel muss auf den Sync warten. Entscheidend ist eine Frage:

> **Wäre es ein Vorteil, das Ergebnis vorher zu kennen?**

| | Verfahren | Ergebnis |
| --- | --- | --- |
| **Nein** — der Spieler wählt nicht | Server würfelt **vorher** und schickt es versiegelt mit | effektiv 🟢 |
| **Ja** — der Spieler wählt | Server würfelt **beim Sync** | 🟡 |

Damit werden aus deinen 🟡 die meisten grün: *zufällige Kunden*, *Sonderaufträge*,
*Eventaufgaben*, *besondere Ernte*, *zufällige Händler* — das sind Inhalte, die einem
zugeteilt werden. Der Server kann einen Vorrat mitgeben, und offline gehen die Aufträge nie
aus.

**Steht inzwischen als Code** (M6): Zwanzig Aufträge liegen im Snapshot, drei davon
sind annehmbar, der Rest rückt nach. Nachgefüllt wird beim Sync — hinten, damit ein
Sync dem Spieler nicht die Auswahl unter den Fingern wegzieht.

Ehrlich zur Grenze: Ein endlicher Vorrat *kann* leerlaufen, und im ersten Lauf tat er
das nach zwölf Lieferungen (daher jetzt zwanzig). Das ist keine Sackgasse — der
NPC-Verkauf bleibt offen. Wer den Vorrat aufbraucht, verliert den Bonus, nicht das Spiel.

Echt 🟡 bleiben nur: **Mystery-Kisten** und alles, wo man aus mehreren wählt. Da wäre
Vorwissen ein Cheat (R5).

### 4. Geschenke sind halb grün

Senden ist einseitig, braucht also niemanden: offline in die Warteschlange, Zustellung beim
Sync. Empfangen landet im Postfach (§7). Nur das *Sehen*, wer online ist, braucht Netz.

---

## Der soziale Rand — dein Aufbau stimmt

Deine 🔴-Liste ist vollständig **am Rand**: Farmen besuchen, Freunde, Nachbarschaften,
gemeinsamer Markt, Ranglisten, Community-Events. **Nichts davon liegt im Kernkreislauf.**

Das ist genau die Struktur, die die Regel aus §6 verlangt: Wer nie online geht, verliert
Extras — nie den täglichen Fortschritt. Die Gefahrenstelle wäre, den Fortschritt später an
Nachbarschafts-Aufgaben zu koppeln. Nicht tun.

---

## Mechanik-Zähler

| | |
| --- | --- |
| **Gebaut** | M1, M2, M3, M4, M5 (beide Seiten), M6, M7, M8 |
| **Fehlt** | M9 Zufall (nur noch der Fall, wo Vorwissen ein Cheat wäre) — plus Warteschlangenplätze als Parameter von M1 |
| **Gesamt** | **9 Mechaniken** |

Neun ist ein Projekt, das man bauen kann. Hundert Features wären es nicht — und die
hundert Features bekommt man trotzdem, weil sie aus diesen neun als Daten herausfallen.

### Was davon heute spielbar ist

```
Feld → Weizen → Mühle → Hühnerfutter → Gehege → Eier
                          ↓
                  Kundenauftrag → Gold + Erfahrung
                          ↓
                  Stufe erreicht → neuer Platz kaufbar

                  Markt: einstellen ← → kaufen (mit Netz)
```

Bewusst genau so viel. Der Kreislauf schließt sich, hat mit den Kundenaufträgen
ein Ziel, mit den Stufen eine Richtung, läuft vollständig offline und ist über
echtes HTTP geprüft.

Gemessen am Dev-Server: Stufe 2 nach zwei Erntezyklen (Mühle geht auf), Stufe 3
nach vieren (Gehege geht auf). In Produktionszeiten sind das rund vier und acht
Minuten — die ersten Freischaltungen kommen also im ersten Sitzen.

---

## Produktversprechen

Drei Sätze, die ab jetzt Entscheidungen gewinnen. Alle drei sind in der Architektur
verankert, damit sie nicht nur Stimmung bleiben.

### 1. Offline lebendig, nicht tot 🚨 → Architektur §6

Nicht „offline ist erlaubt", sondern **offline ist bespielbar**. Der Feldtest zeigte den
Fehlerfall in einer Minute: alles bepflanzt, Inventar leer — jeder Tap korrekt abgelehnt,
nichts zu tun. Nicht kaputt, nur leer.

Dagegen wirken drei Dinge, die alle schon in dieser Map angelegt sind:

| Mittel | Woher es kommt |
| --- | --- |
| **Vorrat statt Verbindung** — Aufträge und Kunden werden vorgewürfelt mitgeliefert und gehen offline nie aus | Falle 3, „Zufall vorwürfeln" |
| **Kein Sackgassen-Zustand** — NPC-Verkauf ist das Ventil, das immer offen ist | M4 ✅ gebaut |
| **Kurze Timer neben langen** — eine Produktionsstufe im Sekundenbereich, sonst ist offline ein Wartezimmer | M1, Parameterfrage |

> **Leerlauf-Test:** Netz aus, beliebiger Spielstand. Gibt es in 60 Sekunden etwas Sinnvolles
> zu tun? Wenn nein, fehlt Inhalt oder ein Ventil.

### 2. Schnell, einfach, modern, clean

Der interessante Teil: „schnell" ist hier keine Optimierungsaufgabe, sondern fällt aus der
Architektur heraus. Weil der Client die Sim selbst rechnet, ist **jeder** Tap sofort
wirksam — es gibt keine Aktion, die auf eine Antwort wartet. Die Konkurrenz kann das nicht,
weil sie für jede Aktion zum Server muss.

> **Kein Ladebalken zwischen Tap und Wirkung. Nie.** Ein Spinner in der Oberfläche heißt,
> dass jemand am Sim-Kern vorbeigebaut hat.

Was dafür noch fehlt: **Die App muss ohne Netz *starten*.** Heute wird die Feldtest-Seite
über das Netz geladen — ein Neuladen im Funkloch scheitert. Eine installierte App bringt
das mit (Roadmap Phase 5); das ist die letzte Lücke im Versprechen.

„Clean" heißt auch, was *nicht* da ist: kein Popup-Spießrutenlauf beim Start, keine
Werbeunterbrechung, kein Ressourcen-Nagging. Genau der Unterschied zu den Alten.

Und „einfach" meint die Oberfläche, nicht die Simulation: Neun Mechaniken tragen beliebig
viel Inhalt — Tiefe kommt aus Tabellen, nicht aus Bedienkomplexität.

### 3. Erstmal ganz ohne Monetarisierung → Architektur §12

**Wir bauen ohne Shop, ohne Premium-Währung, ohne Kaufpfad — auch ohne vorbereiteten.**

Das ist keine Verschiebung auf später, sondern eine Balancing-Entscheidung mit sofortiger
Wirkung:

> **Warten darf nie so wehtun, dass man es wegkaufen wollen würde.**

Im Genre entstehen lange Timer, Lagerengpässe und Energiesysteme nicht aus Spielgefühl,
sondern weil sie freikaufbar sein sollen. Ohne Kaufpfad fällt sofort auf, wenn eine Zahl
nur frustriert, *weil* sie frustrieren soll. Mit Shop fällt es nie auf.

Drei konkrete Verbote für die nächsten Phasen: keine zweite Währung im Zustand (ändert die
kanonische Form für ein Feature, das es nicht gibt), keine Boost-Hooks auf Vorrat (die
Ruleset-Maschinerie steht ohnehin), keine Timer, die sich nur mit „kann man später
abkürzen" rechtfertigen lassen.

**Falls es irgendwann doch kommt, dann so** — festgehalten, damit wir uns den Weg nicht
versehentlich verbauen: *Echtgeld kauft nie einen Vorteil für einen selbst. Wenn Vorteil,
dann für alle.*

| Was man dann verkaufen könnte | Technische Kosten |
| --- | --- |
| **Kosmetik** (Deko, Skins, Saison-Optik) | **null** — liegt ohnehin außerhalb der Sim |
| **Globaler Boost** („alle Farmen 24 h schneller") | ein Ruleset-Wechsel — die R2-Maschinerie steht |
| **Persönlicher Zeitraffer** | fällt weg |

Die gute Nachricht daran: **Beide erlaubten Wege brauchen heute keine Vorarbeit.** Kosmetik
liegt außerhalb der Sim, globale Boosts sind Regelversionen — beides existiert schon oder
kostet nichts. Es gibt also nichts zu „bauen für später".

Drei Dinge, die dabei zusammenpassen und einer, der wehtut:

- Der Kosmetik-Shop ist genau die Fläche, die wir sowieso aus dem deterministischen Zustand
  heraushalten — die Einnahmequelle mit **null** Determinismus-Risiko.
- Ein globaler Boost ist technisch dasselbe wie ein Balance-Patch, und den haben wir schon
  live durch ein Offline-Fenster migriert. Aber: **wirkt ab dem Sync, nie rückwirkend** —
  sonst ist es per Definition Divergenz. Sauberer als ein Zeitfenster ist deshalb ein
  **Boost-Guthaben**, das beim Sync gutgeschrieben und offline verbraucht wird (neue
  Mechanik, kein Freebie).
- Der Zeitraffer passte ohnehin nicht: Ein Kauf braucht den Server, also wäre er
  ausgerechnet im Funkloch nicht verfügbar — dort, wo Wartezeit am meisten stört.
- **Der Preis:** Zeitraffer sind der größte Umsatzhebel des Genres. Ihn zu streichen ist
  eine Wette auf Reichweite statt auf Wale. Bewusst getroffen, nicht übersehen.

---

## Noch offen

1. **Setting.** Klassischer Bauernhof, oder etwas, wo „ohne Netz" thematisch mitspielt?
2. **Der Haken.** Was macht *dieses* Farmspiel anders als die zwanzig anderen — außer der
   Offline-Fähigkeit? (Kandidat aus dem Obigen: die *Geschwindigkeit*. Ein Farmgame ohne
   einen einzigen Ladebalken ist spürbar, bevor jemand das Wort „offline" gehört hat.)
3. ~~**Monetarisierung.**~~ **Entschieden:** erstmal gar keine. Falls später, dann kein
   Pay2Win und Vorteile nur global — siehe oben.

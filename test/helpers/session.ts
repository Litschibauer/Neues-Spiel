/**
 * Geteilte Testwerkzeuge: Zufallssitzungen und die Tick-für-Tick-Grundwahrheit.
 *
 * Wird sowohl vom Session-Fuzz als auch vom Generator der Golden Vectors benutzt,
 * damit beide dieselbe Definition von „richtig" verwenden.
 *
 * Seit Inhalt Daten ist, laufen beide über MEHRERE Regelwerke: v1 hat sechs
 * Felder und einen Stall, v3 zusätzlich Mühle, Bäckerei und Weide. Damit prüft
 * der Fuzz nicht nur die Sim, sondern auch die Behauptung, dass neuer Inhalt
 * wirklich nur eine Tabellenzeile ist.
 */

import { Client } from '../../src/client/client.ts';
import { getRuleset, levelOf, levelRecipes, nextLevel, priceBand } from '../../src/sim/rules.ts';
import type { Ruleset } from '../../src/sim/rules.ts';
import { EMPTY_PLOT, cloneState, count, initialState, stored } from '../../src/sim/state.ts';
import type { MailItem, Offer } from '../../src/sim/state.ts';
import { simulate } from '../../src/sim/sim.ts';
import { advancePassivesReference } from '../../src/sim/produce.ts';
import type { State } from '../../src/sim/state.ts';
import type { Command } from '../../src/sim/commands.ts';
import type { Snapshot } from '../../src/server/server.ts';
import { topUpRequests } from '../../src/server/requests.ts';

/** Deterministischer PRNG — jeder Fehlschlag ist exakt reproduzierbar. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Unabhängiger Rechenweg: Zeit stur Tick für Tick, Command-Wirkung via Sim-Kern.
 *
 * Bewusst langsam und dumm. Genau deshalb ist er die Grundwahrheit, gegen die
 * die geschlossene Form aus §7 antreten muss — inklusive des Rennens mehrerer
 * passiver Produzenten um denselben Lagerplatz.
 */
export function referenceRun(start: State, cmds: readonly Command[], rules: Ruleset): State {
  const intervals = rules.passives.map((p) => rules.recipes[p.recipe]!.durationTicks);
  const outputs = rules.passives.map((p) => rules.recipes[p.recipe]!.output.item);
  let s = cloneState(start);

  for (const cmd of cmds) {
    if (s.tick < cmd.tick) {
      const progress = s.passives.slice();
      const items = s.items.slice();
      let free = rules.siloCapacity - stored(s, rules);

      for (let tick = s.tick; tick < cmd.tick; tick++) {
        for (let i = 0; i < intervals.length; i++) {
          if (free <= 0) continue; // blockiert — friert ein, sammelt keinen Fortschritt
          progress[i]!++;
          if (progress[i]! >= intervals[i]!) {
            items[outputs[i]!] = (items[outputs[i]!] ?? 0) + 1;
            progress[i] = 0;
            free--;
          }
        }
      }

      const advanced = cloneState(s);
      advanced.tick = cmd.tick;
      advanced.items = items;
      advanced.passives = progress;
      s = advanced;
    }
    // s.tick === cmd.tick → advanceTo schreibt nichts mehr fort, nur die
    // Auftragsfrist läuft noch (das ist Absicht, siehe sim.ts).
    s = simulate(s, cmd, rules);
  }
  return s;
}

/** Absicherung, dass die ausgeschriebene Schleife oben nicht abgedriftet ist. */
export function referenceStepMatchesUnit(): boolean {
  for (let progress = 0; progress < 3; progress++) {
    for (let space = 0; space < 3; space++) {
      const unit = advancePassivesReference(1, [progress], space, [2]);
      let produced = 0;
      let p = progress;
      if (space > 0) {
        p++;
        if (p >= 2) {
          produced++;
          p = 0;
        }
      }
      if (unit.produced[0] !== produced || unit.progress[0] !== p) return false;
    }
  }
  return true;
}

/**
 * Startzustand für den Fuzz — wahlweise frischer Hof oder schon etwas Geld.
 *
 * Beides wird gebraucht, und aus verschiedenen Gründen:
 *
 *  - **Frischer Hof** ist der echte Einstieg: drei Felder, kein Gold, kein
 *    Gehege. Er belastet vor allem den Ablehnpfad.
 *  - **Mit Startkapital** ist der einzige Weg in die hinteren Mechaniken.
 *    Ohne Gold kauft niemand eine Mühle, ohne Mühle gibt es kein Futter, ohne
 *    Futter keine Eier — und der halbe Kreislauf bliebe ungeprüft.
 *
 * Münzen einfach hineinzuschreiben ist zulässig: Sie sind nicht lagerpflichtig,
 * verletzen also keine Invariante, und der Server prüft ohnehin nur Commands
 * gegen einen Ausgangszustand — nicht, wie dieser entstanden ist.
 */
export function fuzzStart(rules: Ruleset, gold: number, rnd?: () => number): State {
  const base = initialState(rules);
  const items = base.items.slice();
  if (gold > 0) items[rules.currency] = gold;

  // Kundenaufträge gehören zum Startzustand, sonst bliebe M6 ungeprüft. Sie
  // entstehen über denselben Server-Code wie im Betrieb — nur mit einem
  // reproduzierbaren Würfel.
  const requests = rnd ? topUpRequests({ ...base, items }, rules, 1, rnd).requests : [];

  // Eine Auslage gehört dazu, sonst bliebe der Kaufpfad (M5) ungeprüft — und
  // mit ihm die einzige Aktion, die von außen ins Lager greift. Wie im Betrieb
  // legt sie der Server hinein; hier nur mit festen Zahlen statt fremden Höfen.
  const offers = rnd ? fuzzOffers(rules, rnd) : [];

  // Ein paar Postfach-Einträge, aus demselben Grund. Seit Aufträge nicht mehr
  // verfallen (die Ware bleibt im Angebot stehen), kann eine Einzelsitzung das
  // Postfach nicht mehr selbst füllen — es kommt nur noch von außen, aus
  // fremden Käufen. Ohne diese Zeilen bliebe der ganze Abholpfad ungeprüft.
  const mail = rnd ? fuzzMail(rules, rnd) : [];
  return { ...base, items, requests, offers, mail };
}

/** Eingegangene Zahlungen und Lieferungen, wie sie ein Verkauf hinterlässt. */
function fuzzMail(rules: Ruleset, rnd: () => number): MailItem[] {
  const goods = rules.items
    .map((_, i) => i)
    .filter((i) => rules.items[i]!.storable && rules.items[i]!.npcPrice > 0);
  const mail: MailItem[] = [];
  for (let i = 0; i < 3; i++) {
    const item = goods[Math.floor(rnd() * goods.length)]!;
    mail.push({ item, amount: 1 + Math.floor(rnd() * 5), arrivedAt: 0 });
    mail.push({ item: rules.currency, amount: 5 + Math.floor(rnd() * 50), arrivedAt: 0 });
  }
  return mail;
}

/** Ein paar plausible Fremdangebote — Preise im Band, Mengen lagerverträglich. */
function fuzzOffers(rules: Ruleset, rnd: () => number): Offer[] {
  const sellable = rules.items
    .map((_, i) => i)
    .filter((i) => rules.items[i]!.storable && rules.items[i]!.npcPrice > 0);
  const offers: Offer[] = [];
  for (let i = 0; i < Math.min(rules.offerSlots, sellable.length * 2); i++) {
    const item = sellable[Math.floor(rnd() * sellable.length)]!;
    const { min, max } = priceBand(rules, item);
    offers.push({
      id: i + 1,
      item,
      amount: 1 + Math.floor(rnd() * 12),
      price: min + Math.floor(rnd() * (max - min + 1)),
    });
  }
  return offers;
}

export type SessionOptions = {
  steps: number;
  maxAdvance: number;
  /** Anteil der Schritte, die nur die Uhr vorstellen. */
  advanceChance: number;
  /** Anteil rein zufälliger (meist illegaler) Aktionen — testet den Ablehnpfad. */
  chaosChance: number;
  /**
   * Nie verkaufen, nie einstellen, nie liefern — nur produzieren und einlagern.
   *
   * Klingt nach einem seltsamen Spieler, ist aber der einzige verlässliche Weg
   * ans **volle Lager**. Und das ist die kritische Ecke aus §7: Dort greift der
   * Hard Block, dort friert Produktion ein, dort saß der erste echte Bug.
   */
  hoard?: boolean;
};

/** Rezepte, die auf diesem Platz JETZT laufen dürfen — Stufe und Zutaten geprüft. */
function affordableRecipes(s: State, rules: Ruleset, plot: number): number[] {
  const level = s.plots[plot]?.level ?? 0;
  return levelRecipes(rules, plot, level).filter((r) =>
    rules.recipes[r]!.inputs.every((input) => count(s, input.item) >= input.amount),
  );
}

/** Plätze, deren nächste Ausbaustufe gerade bezahlbar ist. */
function affordableUpgrades(s: State, rules: Ruleset): number[] {
  const out: number[] = [];
  s.plots.forEach((plot, i) => {
    if (plot.recipe !== EMPTY_PLOT) return;
    const level = nextLevel(rules, i, plot.level);
    if (!level) return;
    if (levelOf(rules, s.xp) < (level.minPlayerLevel ?? 1)) return;
    if (level.cost.every((c) => count(s, c.item) >= c.amount)) out.push(i);
  });
  return out;
}

/**
 * Spielt eine zufällige Offline-Sitzung auf einem Client.
 *
 * Bewusst *zustandsbewusst*: Ein rein zufälliger Fuzzer erzeugt fast nur
 * abgelehnte Aktionen (ernten auf leeren Feldern, verkaufen ohne Ware) und
 * kommt nie in die tiefen Zustände, in denen die interessanten Bugs wohnen.
 * Über `chaosChance` bleibt trotzdem ein Anteil purer Zufall erhalten, damit
 * auch der Ablehnpfad belastet wird.
 *
 * Illegale Aktionen landen nicht im Log — genau wie bei einem echten Spieler.
 */
export function playRandomSession(
  snapshot: Snapshot,
  rnd: () => number,
  opts: SessionOptions,
): Client {
  const rules = getRuleset(snapshot.rulesetVersion);
  const client = new Client(snapshot);
  const pick = (n: number) => Math.floor(rnd() * n);
  const tradable = rules.items
    .map((_, i) => i)
    .filter((i) => rules.items[i]!.storable && rules.items[i]!.npcPrice > 0);
  /** Was der Händler abgibt — seit Saatgut verbraucht wird, der Weg zurück ins Spiel. */
  const buyable = rules.items.map((_, i) => i).filter((i) => rules.items[i]!.npcBuyPrice > 0);

  for (let i = 0; i < opts.steps; i++) {
    if (rnd() < opts.advanceChance) {
      client.advanceClock(1 + pick(opts.maxAdvance));
      continue;
    }

    if (rnd() < opts.chaosChance) {
      switch (pick(7)) {
        case 6:
          // Beim Händler kaufen, was er nicht führt — muss sauber abprallen.
          client.buyNpc(pick(rules.items.length + 1), 1 + pick(200));
          break;
        case 0:
          client.start(pick(rules.plots.length + 1), pick(rules.recipes.length + 1));
          break;
        case 1:
          client.collect(pick(rules.plots.length + 1));
          break;
        case 3:
          client.buy(pick(rules.plots.length + 1));
          break;
        case 4:
          // Auch ungültige Auftragsnummern müssen sauber abprallen.
          client.fillRequest(pick(40));
          break;
        case 2:
          // Dasselbe für Angebote, die es nie gab oder nicht mehr gibt.
          client.buyOffer(pick(40));
          break;
        case 5:
          // Und für Aufträge, die man wegschicken will, ohne dass es sie gibt
          // oder ohne dass die Wartezeit um wäre.
          client.skipRequest(pick(40));
          break;
        default:
          client.sellNpc(pick(rules.items.length + 1), 1 + pick(200));
          break;
      }
      continue;
    }

    // Aus dem wählen, was JETZT möglich ist — statt aus einem festen Rad.
    //
    // Ein Rad mit festen Fächern verhungert an einem frischen Hof: Dort gibt es
    // drei Felder und sonst nichts, also landen sechs von sieben Würfen auf
    // Aktionen, die es gar nicht geben kann. Der Fuzz käme nie über die erste
    // Ernte hinaus — und genau dahinter liegt der ganze Rest des Spiels.
    const s = client.preview();
    const moves: Array<() => void> = [];

    s.plots.forEach((plot, idx) => {
      if (plot.recipe === EMPTY_PLOT) {
        const options = affordableRecipes(s, rules, idx);
        for (const recipe of options) moves.push(() => client.start(idx, recipe));
      } else if (s.tick - plot.startedAt >= rules.recipes[plot.recipe]!.durationTicks) {
        moves.push(() => client.collect(idx));
      }
    });

    for (const plot of affordableUpgrades(s, rules)) {
      moves.push(() => client.buy(plot));
    }

    if (!opts.hoard) {
      for (const item of tradable) {
        const have = count(s, item);
        if (have <= 0) continue;
        moves.push(() => client.sellNpc(item, 1 + pick(have)));

        // Preis innerhalb des Bandes wählen, sonst wäre die Aktion fast immer
        // ungültig und der Auftragspfad bliebe ungetestet. Dieselbe Funktion
        // wie in der Sim — ein eigener Nachbau hier hätte irgendwann andere
        // Grenzen als das, was tatsächlich gilt.
        const { min, max } = priceBand(rules, item);
        moves.push(() => client.listOrder(item, 1 + pick(have), min + pick(max - min + 1)));
      }

      if (s.orders.length > 0) {
        moves.push(() => client.cancelOrder(s.orders[pick(s.orders.length)]!.id));
      }

      // Kaufen (M5). Der Fuzz spielt hier den Online-Fall: Der Server
      // bestätigt jedes Angebot, weil in dieser Sitzung niemand sonst
      // zugreift. Geprüft wird die Sim-Seite — dass Gold korrekt abgeht, Ware
      // ankommt und das Lagerlimit hält.
      //
      // Bewusst nur EIN Zug, nicht einer je Angebot. Mit zwölf Kaufoptionen
      // gegen ein Dutzend anderer Züge kaufte der Fuzz sein Gold weg, statt
      // Plätze auszubauen — und die hinteren Mechaniken blieben ungesehen.
      if (s.offers.length > 0) {
        const offer = s.offers[pick(s.offers.length)]!;
        moves.push(() => client.buyOffer(offer.id));
      }
    }
    // Saatgut nachkaufen. Auch der Hamster darf das: Er gibt nichts aus der
    // Hand, er füllt sein Lager — und ohne Nachschub steht ein Hof, der seinen
    // letzten Weizen ausgesät hat, für den Rest der Sitzung still.
    for (const item of buyable) {
      const price = rules.items[item]!.npcBuyPrice;
      const canPay = Math.floor(count(s, rules.currency) / price);
      const fits = rules.items[item]!.storable ? rules.siloCapacity - stored(s, rules) : canPay;
      const max = Math.min(canPay, fits, 10);
      if (max > 0) moves.push(() => client.buyNpc(item, 1 + pick(max)));
    }

    if (s.mail.length > 0) moves.push(() => client.collectMail());

    // Kundenaufträge beliefern, sobald die Ware da ist (M6). Nur die vorderen
    // Plätze sind annehmbar — genau wie im Spiel. Der Hamster liefert nicht:
    // Auch das gäbe Ware aus der Hand, und er will das Lager volllaufen sehen.
    if (!opts.hoard) {
      s.requests.slice(0, rules.requestSlots).forEach((request) => {
        if (request.wants.every((w) => count(s, w.item) >= w.amount)) {
          moves.push(() => client.fillRequest(request.id));
        }
      });
    }

    // Einen Auftrag wegschicken (M6). Auch der Hamster darf das — es gibt
    // nichts aus der Hand. Nur EIN Zug, nicht einer je Auftrag: Sonst wären
    // drei von wenigen Zügen Überspringen, und der Fuzz räumte die Schlange
    // leer, statt zu spielen.
    if (rules.requestSkipCooldownTicks > 0 && s.tick >= s.skipReadyAt) {
      const open = s.requests.slice(0, rules.requestSlots);
      if (open.length > 0) {
        const target = open[pick(open.length)]!;
        moves.push(() => client.skipRequest(target.id));
      }
    }

    if (moves.length > 0) moves[pick(moves.length)]!();
  }

  return client;
}

/**
 * Harte Zusicherung gegen Floats (§2.2).
 *
 * Ein einziger Float im Zustand macht bit-für-bit-Gleichheit über Plattformen
 * hinweg zur Glückssache. Diese Prüfung fängt ihn sofort.
 */
export function assertAllIntegers(s: State): void {
  const nums: Array<[string, number]> = [
    ['tick', s.tick],
    ['xp', s.xp],
    ...s.items.map((v, i): [string, number] => [`items[${i}]`, v]),
    ...s.passives.map((v, i): [string, number] => [`passives[${i}]`, v]),
    ...s.plots.map((p, i): [string, number] => [`plots[${i}].startedAt`, p.startedAt]),
    ...s.plots.map((p, i): [string, number] => [`plots[${i}].recipe`, p.recipe]),
    ...s.plots.map((p, i): [string, number] => [`plots[${i}].level`, p.level]),
  ];

  for (const [name, value] of nums) {
    if (!Number.isInteger(value)) {
      throw new Error(`Nicht-Integer im Zustand: ${name} = ${value}`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Unsicherer Integer im Zustand: ${name} = ${value}`);
    }
  }
}

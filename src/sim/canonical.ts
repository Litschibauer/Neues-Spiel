import type { State } from './state.ts';
import type { Command } from './commands.ts';

export function canonicalize(state: State): string {
  const items = state.items.join(',');
  const plots = state.plots
    .map(
      (p) =>
        `${p.level}@${p.gx},${p.gy}#${p.slots.map((x) => `${x.recipe}:${x.startedAt}`).join('/')}` +
        `~${p.tiere.join('/')}` +
        (p.baum ? `%${p.baum.reifSeit}:${p.baum.geerntet}` : ''),
    )
    .join(',');
  const passives = state.passives.join(',');
  const orders = state.orders
    .map((o) => `${o.id}:${o.item}:${o.amount}:${o.price}:${o.listedAt}+${o.verkauft}`)
    .join(',');
  const offers = state.offers
    .map((o) => `${o.id}:${o.item}:${o.amount}:${o.price}@${o.seller}${o.headline ? '!' : ''}`)
    .join(',');
  const mail = state.mail.map((m) => `${m.item}:${m.amount}:${m.arrivedAt}`).join(',');
  const stacks = (list: readonly { item: number; amount: number }[]) =>
    list.map((x) => `${x.item}x${x.amount}`).join('+');
  const requests = state.requests
    .map((r) => `${r.id}@${r.dest}:${stacks(r.wants)}>${stacks(r.reward)}+${r.xp}xp`)
    .join(',');
  return [
    `tick=${state.tick}`,
    `xp=${state.xp}`,
    `items=[${items}]`,
    `plots=[${plots}]`,
    `passives=[${passives}]`,
    `orders=[${orders}]`,
    `offers=[${offers}]`,
    `mail=[${mail}]`,
    `nextOrderId=${state.nextOrderId}`,
    `requests=[${requests}]`,
    `skipReadyAt=${state.skipReadyAt}`,
    `truck=${state.truck.loaded.join('/')}@${state.truck.awayUntil}`,
    `silo=${state.siloLevel}`,
    `chests=[${state.chests
      .map((c) => `${c.id}:${c.kind}@${c.readyAt}/${c.gx},${c.gy}`)
      .join(',')}]`,
    `nextChestId=${state.nextChestId}`,
    `chestReadyAt=${state.chestReadyAt}`,
    `boxes=[${state.pendingBoxes.join(',')}]`,
    `geraeumt=[${state.clearedObstacles.join(',')}]`,
    `expandiert=[${(state.expandiert ?? []).join(',')}]`,
    `claimed=[${(state.claimed ?? []).join(',')}]`,
    `eingepackt=[${(state.eingepackt ?? []).join(',')}]`,
    `angelFang=${state.angelFang ?? 0}`,
    `boot=${state.bootRepariert ? 1 : 0}`,
    `spots=[${(state.angelSpots ?? []).join(',')}]`,
    `sud=[${(state.angelKoeder ?? []).join(',')}]`,
    `zaehler=[${(state.zaehler ?? []).join(',')}]`,
    `serverTag=${state.serverTag ?? 0}`,
    `tagNr=${state.tagNummer ?? 0}`,
    `tagStart=[${(state.tagStart ?? []).join(',')}]`,
    `tagGeholt=[${(state.tagGeholt ?? []).join(',')}]`,
  ].join('|');
}

export function canonicalizeCommand(c: Command): string {
  switch (c.type) {
    case 'START':
      return `${c.seq}|${c.tick}|START|${c.plot}|${c.slot ?? 0}|${c.recipe}`;
    case 'COLLECT':
      return `${c.seq}|${c.tick}|COLLECT|${c.plot}|${c.slot ?? 0}`;
    case 'BUY':
      return `${c.seq}|${c.tick}|BUY|${c.plot}`;
    case 'SELL_NPC':
      return `${c.seq}|${c.tick}|SELL_NPC|${c.item}|${c.amount}`;
    case 'BUY_NPC':
      return `${c.seq}|${c.tick}|BUY_NPC|${c.item}|${c.amount}`;
    case 'LIST_ORDER':
      return `${c.seq}|${c.tick}|LIST_ORDER|${c.item}|${c.amount}|${c.price}`;
    case 'LOAD_TRUCK':
      return `${c.seq}|${c.tick}|LOAD_TRUCK|${c.stack}|${c.amount}`;
    case 'SEND_TRUCK':
      return `${c.seq}|${c.tick}|SEND_TRUCK`;
    case 'SEND_SLIP':
      return `${c.seq}|${c.tick}|SEND_SLIP|${c.slot}`;
    case 'OPEN_CHEST':
      return `${c.seq}|${c.tick}|OPEN_CHEST|${c.chestId}`;
    case 'UPGRADE_SILO':
      return `${c.seq}|${c.tick}|UPGRADE_SILO`;
    case 'PLACE':
      return `${c.seq}|${c.tick}|PLACE|${c.plot}|${c.gx}|${c.gy}`;
    case 'CLEAR_OBSTACLE':
      return `${c.seq}|${c.tick}|CLEAR_OBSTACLE|${c.index}`;
    case 'EXPAND':
      return `${c.seq}|${c.tick}|EXPAND|${c.id}`;
    case 'HARVEST_TREE':
      return `${c.seq}|${c.tick}|HARVEST_TREE|${c.plot}`;
    case 'FELL_TREE':
      return `${c.seq}|${c.tick}|FELL_TREE|${c.plot}`;
    case 'DISCARD':
      return `${c.seq}|${c.tick}|DISCARD|${c.item}|${c.amount}`;
    case 'CLAIM_ACHIEVEMENT':
      return `${c.seq}|${c.tick}|CLAIM_ACHIEVEMENT|${c.id}`;
    case 'CLAIM_TASK':
      return `${c.seq}|${c.tick}|CLAIM_TASK|${c.id}`;
    case 'REMOVE_PLOT':
      return `${c.seq}|${c.tick}|REMOVE_PLOT|${c.plot}`;
    case 'PACK_PLOT':
      return `${c.seq}|${c.tick}|PACK_PLOT|${c.plot}`;
    case 'CAST_LINE':
      return `${c.seq}|${c.tick}|CAST_LINE`;
    case 'REPAIR_BOAT':
      return `${c.seq}|${c.tick}|REPAIR_BOAT`;
    case 'CRAFT_BAIT':
      return `${c.seq}|${c.tick}|CRAFT_BAIT|${c.slot ?? -1}`;
    case 'COLLECT_BAIT':
      return `${c.seq}|${c.tick}|COLLECT_BAIT|${c.slot}`;
    case 'BAIT_SPOT':
      return `${c.seq}|${c.tick}|BAIT_SPOT|${c.spot}`;
    case 'COLLECT_SPOT':
      return `${c.seq}|${c.tick}|COLLECT_SPOT|${c.spot}`;
    case 'CANCEL_ORDER':
      return `${c.seq}|${c.tick}|CANCEL_ORDER|${c.orderId}`;
    case 'BUY_OFFER':
      return `${c.seq}|${c.tick}|BUY_OFFER|${c.offerId}`;

    case 'BUY_ANIMAL':
      return `${c.seq}|${c.tick}|BUY_ANIMAL|${c.plot}`;

    case 'COLLECT_SALE':
      return `${c.seq}|${c.tick}|COLLECT_SALE|${c.orderId}`;
    case 'COLLECT_MAIL':
      return `${c.seq}|${c.tick}|COLLECT_MAIL`;
    case 'FILL_REQUEST':
      return `${c.seq}|${c.tick}|FILL_REQUEST|${c.requestId}`;
    case 'SKIP_REQUEST':
      return `${c.seq}|${c.tick}|SKIP_REQUEST|${c.requestId}`;
    default:
      throw new Error('unknown command type');
  }
}

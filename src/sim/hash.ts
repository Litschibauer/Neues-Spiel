import type { State } from './state.ts';
import type { Command } from './commands.ts';
import { canonicalize, canonicalizeCommand } from './canonical.ts';
import { sha256Hex } from './sha256.ts';

export { canonicalize, canonicalizeCommand };

export function hashState(state: State): string {
  return sha256Hex(canonicalize(state)).slice(0, 16);
}

export function hashCommands(cmds: readonly Command[]): string {
  const canonical = cmds.map(canonicalizeCommand).join(';');
  return sha256Hex(canonical).slice(0, 16);
}

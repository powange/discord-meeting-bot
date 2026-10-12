import { config } from './config.js';
import { enregistrement } from './enregistrement.js';
import { reunion } from './reunion.js';
import type { Command } from './types.js';

export const commands: ReadonlyMap<string, Command> = new Map([reunion, config, enregistrement].map((c) => [c.data.name, c]));

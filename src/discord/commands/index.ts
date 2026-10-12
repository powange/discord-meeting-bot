import { config } from './config.js';
import type { Command } from './types.js';

/** Une seule commande : tout le reste passe par les boutons (forum, cartes, panneaux). */
export const commands: ReadonlyMap<string, Command> = new Map([config].map((c) => [c.data.name, c]));

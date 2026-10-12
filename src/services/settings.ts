import type { AppConfig } from '../config/index.js';
import type { Repositories } from '../db/repositories.js';
import type { GuildSettingsRow } from '../db/schema.js';
import { messages, type Messages } from '../i18n/index.js';

export class SettingsService {
  constructor(
    private readonly repos: Repositories,
    private readonly config: AppConfig,
  ) {}

  /** Réglages du serveur, créés à partir de la config YAML (`seed`) au premier accès. */
  get(guildId: string): Promise<GuildSettingsRow> {
    return this.repos.getSettings(guildId, this.config.guild(guildId).seed);
  }

  async messages(guildId: string): Promise<Messages> {
    return messages((await this.get(guildId)).locale);
  }
}

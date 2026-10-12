import type { Client } from 'discord.js';
import type { AppConfig } from './config/index.js';
import type { Repositories } from './db/repositories.js';
import type { Logger } from './lib/logger.js';
import type { PipelineService } from './pipeline/runner.js';
import type { CardService } from './services/cards.js';
import type { HubService } from './services/hub.js';
import type { MeetingService } from './services/meetings.js';
import type { OwnersService } from './services/owners.js';
import type { RecordingService } from './services/recordings.js';
import type { SettingsService } from './services/settings.js';

export interface AppContext {
  config: AppConfig;
  client: Client;
  log: Logger;
  repos: Repositories;
  settings: SettingsService;
  cards: CardService;
  hub: HubService;
  meetings: MeetingService;
  recordings: RecordingService;
  pipeline: PipelineService;
  owners: OwnersService;
}

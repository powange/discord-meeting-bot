import type { AutocompleteInteraction, ChatInputCommandInteraction, RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import type { AppContext } from '../../context.js';

export interface Command {
  data: RESTPostAPIChatInputApplicationCommandsJSONBody;
  execute(ctx: AppContext, interaction: ChatInputCommandInteraction<'cached'>): Promise<void>;
  autocomplete?(ctx: AppContext, interaction: AutocompleteInteraction<'cached'>): Promise<void>;
}

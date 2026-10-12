import {
  EmbedBuilder,
  MessageFlags,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type SlashCommandStringOption,
  type SlashCommandSubcommandGroupBuilder,
} from 'discord.js';
import type { AppContext } from '../../context.js';
import type { Messages } from '../../i18n/index.js';
import { UserError } from '../../lib/errors.js';
import { effectiveBackends, maskKey, moveTo, rowToConfig, testBackend } from '../../services/transcriptionBackends.js';
import { replyEphemeral } from '../interactions/common.js';

const nameOption = (o: SlashCommandStringOption) =>
  o.setName('nom').setDescription('Nom du serveur de transcription').setRequired(true).setAutocomplete(true);

/** `/config transcription …` : serveurs de transcription (Vibe, speaches…) gérés depuis Discord. */
export function transcriptionGroup(g: SlashCommandSubcommandGroupBuilder): SlashCommandSubcommandGroupBuilder {
  return g
    .setName('transcription')
    .setDescription('Serveurs de transcription (Vibe, compatibles OpenAI), par ordre de priorité')
    .addSubcommand((s) => s.setName('voir').setDescription('Lister les serveurs et leur ordre de bascule'))
    .addSubcommand((s) =>
      s
        .setName('ajouter')
        .setDescription('Ajouter un serveur (en dernière priorité)')
        .addStringOption((o) => o.setName('nom').setDescription('Nom court, ex. vibe-pc').setRequired(true).setMaxLength(40))
        .addStringOption((o) =>
          o
            .setName('type')
            .setDescription('vibe : vibe-server · openai : speaches, faster-whisper…')
            .setRequired(true)
            .addChoices({ name: 'vibe', value: 'vibe' }, { name: 'openai (compatible)', value: 'openai' }),
        )
        .addStringOption((o) =>
          o.setName('url').setDescription('vibe : http://hôte:8080 · openai : http://hôte:8000/v1').setRequired(true).setMaxLength(200),
        )
        .addStringOption((o) => o.setName('modele').setDescription('Modèle demandé (openai uniquement ; vibe utilise le modèle chargé)').setMaxLength(100))
        .addStringOption((o) => o.setName('cle').setDescription("Clé d'API éventuelle").setMaxLength(200))
        .addIntegerOption((o) => o.setName('delai').setDescription('Délai maximal par bloc, en secondes (défaut 600)').setMinValue(10).setMaxValue(3600))
        .addIntegerOption((o) => o.setName('parallele').setDescription('Requêtes simultanées (openai ; vibe : 1)').setMinValue(1).setMaxValue(8)),
    )
    .addSubcommand((s) => s.setName('retirer').setDescription('Retirer un serveur').addStringOption(nameOption))
    .addSubcommand((s) =>
      s
        .setName('priorite')
        .setDescription("Changer la place d'un serveur dans l'ordre de bascule")
        .addStringOption(nameOption)
        .addIntegerOption((o) => o.setName('position').setDescription('1 = essayé en premier').setRequired(true).setMinValue(1).setMaxValue(20)),
    )
    .addSubcommand((s) =>
      s
        .setName('activer')
        .setDescription('Activer ou désactiver un serveur sans le retirer')
        .addStringOption(nameOption)
        .addBooleanOption((o) => o.setName('actif').setDescription('Oui pour l’utiliser').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('tester')
        .setDescription('Tester un serveur, ou tous : santé puis transcription réelle d’une seconde de silence')
        .addStringOption((o) => o.setName('nom').setDescription('Serveur à tester (tous par défaut)').setAutocomplete(true)),
    );
}

export async function autocompleteBackendName(ctx: AppContext, interaction: AutocompleteInteraction<'cached'>): Promise<void> {
  const query = interaction.options.getFocused().toLowerCase();
  const rows = await ctx.repos.listBackends(interaction.guildId);
  await interaction.respond(
    rows
      .filter((r) => r.name.toLowerCase().includes(query))
      .slice(0, 25)
      .map((r) => ({ name: `${r.position + 1}. ${r.name} (${r.type}${r.enabled ? '' : ', désactivé'})`, value: r.name })),
  );
}

export async function handleTranscriptionConfig(ctx: AppContext, interaction: ChatInputCommandInteraction<'cached'>, m: Messages): Promise<void> {
  const t = m.transcriptionConfig;
  const guildId = interaction.guildId;
  const sub = interaction.options.getSubcommand();
  const language = ctx.config.guild(guildId).transcription.language;

  switch (sub) {
    case 'voir': {
      const rows = await ctx.repos.listBackends(guildId);
      const { source, backends } = await effectiveBackends(ctx.repos, ctx.config, guildId);
      const lines =
        rows.length > 0
          ? rows.map((r) => `${r.enabled ? '🟢' : '⚪'} **${r.position + 1}. ${r.name}** · ${r.type} · \`${r.url}\`${r.type === 'openai' ? ` · ${r.model}` : ''} · clé ${maskKey(r.apiKey)} · ${r.timeoutSec} s`)
          : backends.map((b, i) => `🟢 **${i + 1}. ${b.name}** · ${b.type} · \`${b.url}\` *(${t.fromYaml})*`);
      const embed = new EmbedBuilder()
        .setTitle(t.title)
        .setDescription(lines.length ? lines.join('\n') : t.none)
        .setFooter({ text: source === 'discord' ? t.footerDiscord : t.footerYaml });
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    case 'ajouter': {
      const name = interaction.options.getString('nom', true).trim();
      const type = interaction.options.getString('type', true) as 'vibe' | 'openai';
      const url = interaction.options.getString('url', true).trim().replace(/\/+$/, '');
      if (!/^https?:\/\/[^\s/]+/.test(url)) throw new UserError(t.badUrl);
      if ((await ctx.repos.listBackends(guildId)).some((r) => r.name === name)) throw new UserError(t.exists(name));
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const values = {
        guildId,
        name,
        type,
        url,
        model: interaction.options.getString('modele') ?? 'whisper-1',
        apiKey: interaction.options.getString('cle'),
        timeoutSec: interaction.options.getInteger('delai') ?? 600,
        concurrency: type === 'vibe' ? 1 : (interaction.options.getInteger('parallele') ?? 1),
      };
      await ctx.repos.addBackend(values);
      const row = (await ctx.repos.listBackends(guildId)).find((r) => r.name === name)!;
      const result = await testBackend(rowToConfig(row), ctx.config, language);
      await replyEphemeral(interaction, `${t.added(name, row.position + 1)}\n${t.result(name, result)}`);
      return;
    }

    case 'retirer': {
      const name = interaction.options.getString('nom', true);
      if (!(await ctx.repos.removeBackend(guildId, name))) throw new UserError(t.unknown(name));
      const left = await ctx.repos.listBackends(guildId);
      await replyEphemeral(interaction, left.length ? t.removed(name) : `${t.removed(name)}\n${t.backToYaml}`);
      return;
    }

    case 'priorite': {
      const name = interaction.options.getString('nom', true);
      const position = interaction.options.getInteger('position', true);
      const order = moveTo((await ctx.repos.listBackends(guildId)).map((r) => r.name), name, position - 1);
      if (!order) throw new UserError(t.unknown(name));
      await ctx.repos.reorderBackends(guildId, order);
      await replyEphemeral(interaction, t.reordered(order));
      return;
    }

    case 'activer': {
      const name = interaction.options.getString('nom', true);
      const on = interaction.options.getBoolean('actif', true);
      if (!(await ctx.repos.updateBackend(guildId, name, { enabled: on }))) throw new UserError(t.unknown(name));
      await replyEphemeral(interaction, t.toggled(name, on));
      return;
    }

    case 'tester': {
      const only = interaction.options.getString('nom');
      const { backends } = await effectiveBackends(ctx.repos, ctx.config, guildId);
      const rows = await ctx.repos.listBackends(guildId);
      const targets = only ? rows.filter((r) => r.name === only).map(rowToConfig) : backends;
      if (only && targets.length === 0) throw new UserError(t.unknown(only));
      if (targets.length === 0) throw new UserError(t.none);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const results = await Promise.all(targets.map(async (b) => t.result(b.name, await testBackend(b, ctx.config, language))));
      await replyEphemeral(interaction, results.join('\n'));
      return;
    }
  }
}

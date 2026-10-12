import {
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ForumChannel,
} from 'discord.js';
import { IANAZone } from 'luxon';
import { DURATION_MAX, DURATION_MIN } from '../../domain/meeting.js';
import { formatOffset, parseOffsets } from '../../domain/reminders.js';
import { messages } from '../../i18n/index.js';
import { UserError } from '../../lib/errors.js';
import { ensureStatusTags, missingForumPermissions } from '../forum.js';
import { replyEphemeral } from '../interactions/common.js';
import { autocompleteBackendName, handleTranscriptionConfig, transcriptionGroup } from './configTranscription.js';
import type { Command } from './types.js';

const ROLE_KEYS = { gestionnaire: 'managerRoleId', 'ne-pas-enregistrer': 'optoutRoleId', relance: 'nudgeRoleId' } as const;
const TIMEZONES = Intl.supportedValuesOf('timeZone');

const data = new SlashCommandBuilder()
  .setName('config')
  .setDescription('Configurer le bot de réunions sur ce serveur')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) => s.setName('voir').setDescription('Afficher la configuration'))
  .addSubcommandGroup(transcriptionGroup)
  .addSubcommand((s) =>
    s
      .setName('forum')
      .setDescription('Choisir le forum où publier les réunions (crée les tags de statut)')
      .addChannelOption((o) => o.setName('salon').setDescription('Salon forum').addChannelTypes(ChannelType.GuildForum).setRequired(true)),
  )
  .addSubcommand((s) =>
    s
      .setName('roles')
      .setDescription('Rôles utilisés par le bot')
      .addRoleOption((o) => o.setName('gestionnaire').setDescription("Peut gérer toutes les réunions (ODJ, modification, annulation)"))
      .addRoleOption((o) => o.setName('ne-pas-enregistrer').setDescription("Membres jamais enregistrés"))
      .addRoleOption((o) => o.setName('relance').setDescription('Membres relancés avec le premier rappel s’ils n’ont pas répondu'))
      .addStringOption((o) =>
        o
          .setName('effacer')
          .setDescription('Retirer un des rôles configurés')
          .addChoices(Object.keys(ROLE_KEYS).map((k) => ({ name: k, value: k }))),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('vocal')
      .setDescription('Imposer un salon vocal à toutes les réunions (sans option : choix libre)')
      .addChannelOption((o) => o.setName('salon').setDescription('Salon vocal des réunions').addChannelTypes(ChannelType.GuildVoice)),
  )
  .addSubcommand((s) =>
    s
      .setName('rappels')
      .setDescription('Délais des rappels avant la réunion')
      .addStringOption((o) => o.setName('delais').setDescription('ex. « 1j, 15min » ou « 1440, 15 » ; « aucun » pour désactiver').setRequired(true)),
  )
  .addSubcommand((s) =>
    s
      .setName('general')
      .setDescription('Réglages généraux')
      .addStringOption((o) => o.setName('fuseau').setDescription('Fuseau horaire de saisie des dates').setAutocomplete(true))
      .addIntegerOption((o) => o.setName('duree').setDescription('Durée par défaut (minutes)').setMinValue(DURATION_MIN).setMaxValue(DURATION_MAX))
      .addBooleanOption((o) => o.setName('enregistrement-auto').setDescription('Enregistrement auto par défaut (phase 2)'))
      .addBooleanOption((o) => o.setName('creation-restreinte').setDescription('Réserver la création de réunions aux gestionnaires')),
  )
  .toJSON();

export const config: Command = {
  data,

  async autocomplete(ctx, interaction) {
    if (interaction.options.getFocused(true).name === 'nom') return autocompleteBackendName(ctx, interaction);
    const query = interaction.options.getFocused().toLowerCase();
    const matches = TIMEZONES.filter((tz) => tz.toLowerCase().includes(query)).slice(0, 25);
    await interaction.respond(matches.map((tz) => ({ name: tz, value: tz })));
  },

  async execute(ctx, interaction) {
    const guildId = interaction.guildId;
    const settings = await ctx.settings.get(guildId);
    const m = messages(settings.locale);
    if (interaction.options.getSubcommandGroup(false) === 'transcription') return handleTranscriptionConfig(ctx, interaction, m);
    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case 'voir': {
        const c = m.config;
        const role = (id: string | null) => (id ? `<@&${id}>` : `*${c.none}*`);
        const embed = new EmbedBuilder()
          .setTitle(c.title)
          .addFields(
            { name: c.forum, value: settings.forumChannelId ? `<#${settings.forumChannelId}>` : `*${c.none}*` },
            { name: c.voice, value: settings.voiceChannelId ? `<#${settings.voiceChannelId}>` : `*${c.voiceFree}*` },
            { name: c.managerRole, value: role(settings.managerRoleId), inline: true },
            { name: c.optoutRole, value: role(settings.optoutRoleId), inline: true },
            { name: c.nudgeRole, value: role(settings.nudgeRoleId), inline: true },
            { name: c.creators, value: settings.creatorsRestricted ? c.creatorsManagers : c.creatorsAll, inline: true },
            { name: c.timezone, value: settings.timezone, inline: true },
            { name: c.duration, value: m.card.minutes(settings.defaultDurationMin), inline: true },
            { name: c.reminders, value: settings.reminderOffsetsMin.map(formatOffset).join(', ') || `*${c.none}*`, inline: true },
            { name: c.autoRecord, value: settings.autoRecordDefault ? c.yes : c.no, inline: true },
          );
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        return;
      }

      case 'forum': {
        const forum = interaction.options.getChannel('salon', true, [ChannelType.GuildForum]) as ForumChannel;
        const missing = missingForumPermissions(forum);
        if (missing.length > 0) throw new UserError(m.errors.forumPermissions(missing.join(', ')));
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const tagIds = await ensureStatusTags(forum, m);
        await ctx.repos.updateSettings(guildId, { forumChannelId: forum.id, tagIds });
        const hubId = await ctx.hub.ensure(forum, m);
        await ctx.hub.refreshNow(guildId);
        await replyEphemeral(interaction, m.config.forumReady(forum.id, hubId));
        return;
      }

      case 'roles': {
        const patch: Partial<Record<(typeof ROLE_KEYS)[keyof typeof ROLE_KEYS], string | null>> = {};
        for (const [option, key] of Object.entries(ROLE_KEYS)) {
          const role = interaction.options.getRole(option);
          if (role) patch[key] = role.id;
        }
        const clear = interaction.options.getString('effacer') as keyof typeof ROLE_KEYS | null;
        if (clear) patch[ROLE_KEYS[clear]] = null;
        await ctx.repos.updateSettings(guildId, patch);
        await replyEphemeral(interaction, m.replies.configSaved);
        return;
      }

      case 'vocal': {
        const channel = interaction.options.getChannel('salon', false, [ChannelType.GuildVoice]);
        await ctx.repos.updateSettings(guildId, { voiceChannelId: channel?.id ?? null });
        await replyEphemeral(interaction, channel ? m.config.voiceSet(channel.id) : m.config.voiceCleared);
        return;
      }

      case 'rappels': {
        const raw = interaction.options.getString('delais', true).trim();
        const offsets = /^(aucun|non|0)$/i.test(raw) ? [] : parseOffsets(raw);
        if (!offsets) throw new UserError(m.errors.offsets(raw.slice(0, 100)));
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await ctx.repos.updateSettings(guildId, { reminderOffsetsMin: offsets });
        await ctx.meetings.replanGuild(guildId);
        await replyEphemeral(interaction, m.replies.configSaved);
        return;
      }

      case 'general': {
        const timezone = interaction.options.getString('fuseau');
        if (timezone !== null && !IANAZone.isValidZone(timezone)) throw new UserError(m.errors.timezone);
        const duration = interaction.options.getInteger('duree');
        const autoRecord = interaction.options.getBoolean('enregistrement-auto');
        const restricted = interaction.options.getBoolean('creation-restreinte');
        await ctx.repos.updateSettings(guildId, {
          ...(timezone !== null && { timezone }),
          ...(duration !== null && { defaultDurationMin: duration }),
          ...(autoRecord !== null && { autoRecordDefault: autoRecord }),
          ...(restricted !== null && { creatorsRestricted: restricted }),
        });
        await replyEphemeral(interaction, m.replies.configSaved);
        return;
      }
    }
  },
};

import {
  ChannelType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type ForumChannel,
  type Interaction,
} from 'discord.js';
import { IANAZone } from 'luxon';
import type { AppContext } from '../../context.js';
import { encode, type CfgAction } from '../../domain/customId.js';
import { DURATION_MAX, DURATION_MIN } from '../../domain/meeting.js';
import { formatOffset, parseOffsets } from '../../domain/reminders.js';
import type { Messages } from '../../i18n/index.js';
import { UserError } from '../../lib/errors.js';
import { effectiveBackends } from '../../services/transcriptionBackends.js';
import { CONFIG_SECTIONS, renderConfigHome, renderConfigSection, type ConfigContext, type ConfigSection } from '../embeds/configPanel.js';
import { ensureStatusTags, missingForumPermissions } from '../forum.js';
import { openBackendPanelInPlace } from './backendPanel.js';

type CfgInteraction = Interaction<'cached'>;
type Section = Exclude<ConfigSection, 'transcription'>;

/** `/config` : ouvre le panneau de configuration (message éphémère). */
export async function openConfigPanel(ctx: AppContext, interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
  const m = await ctx.settings.messages(interaction.guildId);
  await interaction.reply({
    components: [renderConfigHome(await context(ctx, interaction.guildId, m), m)],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  });
}

async function context(ctx: AppContext, guildId: string, m: Messages, notice?: string): Promise<ConfigContext> {
  const settings = await ctx.settings.get(guildId);
  const { source, backends } = await effectiveBackends(ctx.repos, ctx.config, guildId);
  const names = backends.map((b) => b.name).join(', ');
  const transcription = source === 'yaml' && backends.length ? m.config.fromYamlSummary(names) : m.config.transcriptionSummary(backends.length, names);
  return { settings, transcription, notice };
}

/** Actions du panneau. Réservé à « Gérer le serveur » (ou aux propriétaires du bot). */
export async function handleConfigPanel(ctx: AppContext, interaction: CfgInteraction, action: CfgAction): Promise<void> {
  const guildId = interaction.guildId;
  const m = await ctx.settings.messages(guildId);
  const t = m.config;
  if (!ctx.owners.isOwner(interaction.user.id) && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw new UserError(m.backendPanel.forbidden);
  }

  const show = async (section: Section | 'home', notice?: string) => {
    const c = await context(ctx, guildId, m, notice);
    const payload = { components: [section === 'home' ? renderConfigHome(c, m) : renderConfigSection(section, c, m)], allowedMentions: { parse: [] } };
    if (interaction.isRepliable() && (interaction.deferred || interaction.replied)) await interaction.editReply(payload);
    else if (interaction.isMessageComponent()) await interaction.update(payload);
    else if (interaction.isModalSubmit() && interaction.isFromMessage()) await interaction.update(payload);
  };

  switch (action) {
    case 'home':
      return show('home');

    case 'section': {
      if (!interaction.isStringSelectMenu()) return;
      const section = interaction.values[0] as ConfigSection;
      if (!CONFIG_SECTIONS.includes(section)) return;
      if (section === 'transcription') return openBackendPanelInPlace(ctx, interaction);
      return show(section);
    }

    case 'forum': {
      if (!interaction.isChannelSelectMenu()) return;
      const forum = interaction.channels.first();
      if (!forum || forum.type !== ChannelType.GuildForum) return show('forum');
      const missing = missingForumPermissions(forum as ForumChannel);
      if (missing.length > 0) return show('forum', `❌ ${m.errors.forumPermissions(missing.join(', '))}`);
      await interaction.deferUpdate(); // tags et post épinglé : quelques secondes
      const tagIds = await ensureStatusTags(forum as ForumChannel, m);
      await ctx.repos.updateSettings(guildId, { forumChannelId: forum.id, tagIds });
      const hubId = await ctx.hub.ensure(forum as ForumChannel, m);
      await ctx.hub.refreshNow(guildId);
      return show('forum', t.forumReady(forum.id, hubId));
    }

    case 'voice': {
      if (!interaction.isChannelSelectMenu()) return;
      await ctx.repos.updateSettings(guildId, { voiceChannelId: interaction.channels.first()?.id ?? null });
      return show('voice', t.saved);
    }
    case 'voiceClear':
      await ctx.repos.updateSettings(guildId, { voiceChannelId: null });
      return show('voice', t.saved);

    case 'roleManager':
    case 'roleOptout':
    case 'roleNudge': {
      if (!interaction.isRoleSelectMenu()) return;
      const key = ({ roleManager: 'managerRoleId', roleOptout: 'optoutRoleId', roleNudge: 'nudgeRoleId' } as const)[action];
      await ctx.repos.updateSettings(guildId, { [key]: interaction.roles.first()?.id ?? null });
      return show('roles', t.saved);
    }

    case 'remindersEdit': {
      if (!interaction.isButton()) return;
      const settings = await ctx.settings.get(guildId);
      const input = new TextInputBuilder()
        .setCustomId('offsets')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(100)
        .setRequired(true)
        .setValue(settings.reminderOffsetsMin.length ? settings.reminderOffsetsMin.map(formatOffset).join(', ') : 'aucun');
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(encode({ type: 'cfg', action: 'remindersSubmit' }))
          .setTitle(t.remindersModal)
          .addLabelComponents(new LabelBuilder().setLabel(t.remindersField).setDescription(t.remindersHint).setTextInputComponent(input)),
      );
      return;
    }
    case 'remindersSubmit': {
      if (!interaction.isModalSubmit()) return;
      const raw = interaction.fields.getTextInputValue('offsets').trim().replace(/\s+j\b/g, 'j').replace(/\s+h\b/g, 'h');
      const offsets = /^(aucun|non|0)$/i.test(raw) ? [] : parseOffsets(raw);
      if (!offsets) return show('reminders', `❌ ${m.errors.offsets(raw.slice(0, 100))}`);
      await ctx.repos.updateSettings(guildId, { reminderOffsetsMin: offsets });
      await ctx.meetings.replanGuild(guildId);
      return show('reminders', t.saved);
    }

    case 'generalEdit': {
      if (!interaction.isButton()) return;
      const settings = await ctx.settings.get(guildId);
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(encode({ type: 'cfg', action: 'generalSubmit' }))
          .setTitle(t.generalModal)
          .addLabelComponents(
            new LabelBuilder()
              .setLabel(t.timezoneField)
              .setDescription(t.timezoneHint)
              .setTextInputComponent(new TextInputBuilder().setCustomId('timezone').setStyle(TextInputStyle.Short).setMaxLength(60).setRequired(true).setValue(settings.timezone)),
            new LabelBuilder()
              .setLabel(t.durationField)
              .setTextInputComponent(
                new TextInputBuilder().setCustomId('duration').setStyle(TextInputStyle.Short).setMaxLength(4).setRequired(true).setValue(String(settings.defaultDurationMin)),
              ),
          ),
      );
      return;
    }
    case 'generalSubmit': {
      if (!interaction.isModalSubmit()) return;
      const timezone = interaction.fields.getTextInputValue('timezone').trim();
      const duration = Number(interaction.fields.getTextInputValue('duration').trim());
      if (!IANAZone.isValidZone(timezone)) return show('general', `❌ ${m.errors.timezone}`);
      if (!Number.isInteger(duration) || duration < DURATION_MIN || duration > DURATION_MAX) return show('general', `❌ ${m.errors.duration(DURATION_MIN, DURATION_MAX)}`);
      await ctx.repos.updateSettings(guildId, { timezone, defaultDurationMin: duration });
      return show('general', t.saved);
    }
    case 'toggleCreators': {
      const settings = await ctx.settings.get(guildId);
      await ctx.repos.updateSettings(guildId, { creatorsRestricted: !settings.creatorsRestricted });
      return show('general', t.saved);
    }

    case 'toggleAutoRecord': {
      const settings = await ctx.settings.get(guildId);
      await ctx.repos.updateSettings(guildId, { autoRecordDefault: !settings.autoRecordDefault });
      return show('recording', t.saved);
    }
  }
}

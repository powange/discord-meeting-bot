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
  type Guild,
  type Interaction,
} from 'discord.js';
import { IANAZone } from 'luxon';
import type { AppContext } from '../../context.js';
import { pageOf, type ChannelInfo } from '../../domain/channelChoices.js';
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

/** Types de salon proposés par section. */
const CHANNEL_TYPES: Partial<Record<ConfigSection, ChannelType>> = {
  forum: ChannelType.GuildForum,
  voice: ChannelType.GuildVoice,
  alerts: ChannelType.GuildText,
};

function channelsOf(guild: Guild, type: ChannelType): ChannelInfo[] {
  return [...guild.channels.cache.values()]
    .filter((c) => c.type === type)
    .map((c) => ({
      id: c.id,
      name: c.name,
      position: 'rawPosition' in c ? c.rawPosition : 0,
      category: c.parent ? { name: c.parent.name, position: c.parent.rawPosition } : null,
    }));
}

async function context(ctx: AppContext, guildId: string, m: Messages, notice?: string): Promise<ConfigContext> {
  const settings = await ctx.settings.get(guildId);
  const { source, backends } = await effectiveBackends(ctx.repos, ctx.config, guildId);
  const names = backends.map((b) => b.name).join(', ');
  const transcription = source === 'yaml' && backends.length ? m.config.fromYamlSummary(names) : m.config.transcriptionSummary(backends.length, names);
  return { settings, transcription, notice };
}

/** Actions du panneau. Réservé à « Gérer le serveur » (ou aux propriétaires du bot). */
export async function handleConfigPanel(ctx: AppContext, interaction: CfgInteraction, action: CfgAction, arg?: string): Promise<void> {
  const guildId = interaction.guildId;
  const m = await ctx.settings.messages(guildId);
  const t = m.config;
  if (!ctx.owners.isOwner(interaction.user.id) && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw new UserError(m.backendPanel.forbidden);
  }

  const show = async (section: Section | 'home', notice?: string, page?: number) => {
    const c = await context(ctx, guildId, m, notice);
    const type = section === 'home' ? undefined : CHANNEL_TYPES[section];
    if (type !== undefined) {
      const list = channelsOf(interaction.guild, type);
      const current = { forum: c.settings.forumChannelId, voice: c.settings.voiceChannelId, alerts: c.settings.alertChannelId }[section as 'forum' | 'voice' | 'alerts'];
      c.channels = { list, page: page ?? pageOf(list, current) };
      if (list.length === 0) c.notice = [notice, t.noChannel].filter(Boolean).join('\n');
    }
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

    case 'page': {
      const [section, page] = (arg ?? '').split('.');
      if (section !== 'forum' && section !== 'voice' && section !== 'alerts') return;
      return show(section, undefined, Number(page));
    }

    case 'forum': {
      if (!interaction.isStringSelectMenu()) return;
      const forum = interaction.guild.channels.cache.get(interaction.values[0] ?? '');
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
      if (!interaction.isStringSelectMenu()) return;
      const voice = interaction.guild.channels.cache.get(interaction.values[0] ?? '');
      if (!voice || voice.type !== ChannelType.GuildVoice) return show('voice');
      await ctx.repos.updateSettings(guildId, { voiceChannelId: voice.id });
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

    case 'alerts': {
      if (!interaction.isStringSelectMenu()) return;
      const channel = interaction.guild.channels.cache.get(interaction.values[0] ?? '');
      if (!channel || channel.type !== ChannelType.GuildText) return show('alerts');
      await ctx.repos.updateSettings(guildId, { alertChannelId: channel.id });
      return show('alerts', t.saved);
    }
    case 'alertsClear':
      await ctx.repos.updateSettings(guildId, { alertChannelId: null });
      return show('alerts', t.saved);
    case 'alertsTest': {
      const channelId = (await ctx.settings.get(guildId)).alertChannelId;
      if (!channelId) return show('alerts');
      const channel = await ctx.client.channels.fetch(channelId).catch(() => null);
      if (!channel?.isSendable()) return show('alerts', `❌ ${m.errors.alertChannel}`);
      await channel.send({ content: `🚨 ${t.alertsTestMessage}`, allowedMentions: { parse: [] } });
      return show('alerts', t.alertsTestSent(channelId));
    }

    case 'toggleAutoRecord': {
      const settings = await ctx.settings.get(guildId);
      await ctx.repos.updateSettings(guildId, { autoRecordDefault: !settings.autoRecordDefault });
      return show('recording', t.saved);
    }
  }
}

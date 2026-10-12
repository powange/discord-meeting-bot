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
import { effectiveLlm, listModels, testLlm } from '../../services/llmSettings.js';
import { effectiveBackends } from '../../services/transcriptionBackends.js';
import { assertUrlAllowed } from '../../lib/hosts.js';
import { CONFIG_SECTIONS, renderConfigHome, renderConfigSection, type ConfigContext, type ConfigSection } from '../embeds/configPanel.js';
import { ensureStatusTags, missingForumPermissions } from '../forum.js';
import { openBackendPanelInPlace } from './backendPanel.js';

type CfgInteraction = Interaction<'cached'>;
type Section = Exclude<ConfigSection, 'transcription'>;

/** `/config` : ouvre le panneau de configuration (message éphémère). */
export async function openConfigPanel(ctx: AppContext, interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
  const m = await ctx.settings.messages(interaction.guildId);
  await interaction.reply({
    components: [renderConfigHome(await context(ctx, interaction.guildId, m, undefined, interaction.user.id), m)],
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

async function context(ctx: AppContext, guildId: string, m: Messages, notice?: string, userId?: string): Promise<ConfigContext> {
  const settings = await ctx.settings.get(guildId);
  const llm = effectiveLlm(settings, ctx.config);
  const { source, backends } = await effectiveBackends(ctx.repos, ctx.config, guildId);
  const names = backends.map((b) => b.name).join(', ');
  const transcription = source === 'yaml' && backends.length ? m.config.fromYamlSummary(names) : m.config.transcriptionSummary(backends.length, names);
  return {
    settings,
    transcription,
    notice,
    llm: { source: llm.source, enabled: llm.enabled, baseUrl: llm.config.baseUrl, model: llm.config.model, hasKey: Boolean(llm.config.apiKey) },
    canEditAi: userId ? ctx.owners.isOwner(userId) : false,
    refusals: await ctx.optouts.list(guildId),
  };
}

/** Actions du panneau. Réservé à « Gérer le serveur » (ou aux propriétaires du bot). */
export async function handleConfigPanel(ctx: AppContext, interaction: CfgInteraction, action: CfgAction, arg?: string): Promise<void> {
  const guildId = interaction.guildId;
  const m = await ctx.settings.messages(guildId);
  const t = m.config;
  const isOwner = ctx.owners.isOwner(interaction.user.id);
  if (!isOwner && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw new UserError(m.backendPanel.forbidden);
  }

  const show = async (section: Section | 'home', notice?: string, page?: number, models?: string[]) => {
    const c = await context(ctx, guildId, m, notice, interaction.user.id);
    if (models) c.models = models;
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
    case 'roleNudge': {
      if (!interaction.isRoleSelectMenu()) return;
      const key = ({ roleManager: 'managerRoleId', roleNudge: 'nudgeRoleId' } as const)[action];
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

    case 'llmEdit': {
      if (!interaction.isButton()) return;
      if (!isOwner) throw new UserError(m.backendPanel.ownersOnly);
      const current = effectiveLlm(await ctx.settings.get(guildId), ctx.config).config;
      const url = new TextInputBuilder().setCustomId('url').setStyle(TextInputStyle.Short).setMaxLength(200).setRequired(true).setPlaceholder('http://pc-main.tailnet:1234/v1');
      if (current.baseUrl) url.setValue(current.baseUrl);
      const model = new TextInputBuilder().setCustomId('model').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(true).setValue(current.model);
      const key = new TextInputBuilder().setCustomId('key').setStyle(TextInputStyle.Short).setMaxLength(200).setRequired(false);
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(encode({ type: 'cfg', action: 'llmSubmit' }))
          .setTitle(t.llmModal)
          .addLabelComponents(
            new LabelBuilder().setLabel(t.llmUrlField).setDescription(t.llmUrlHint).setTextInputComponent(url),
            new LabelBuilder().setLabel(t.llmModelField).setDescription(t.llmModelHint).setTextInputComponent(model),
            new LabelBuilder().setLabel(t.llmKeyField).setDescription(t.llmKeyHint).setTextInputComponent(key),
          ),
      );
      return;
    }
    case 'llmSubmit': {
      if (!interaction.isModalSubmit()) return;
      if (!isOwner) throw new UserError(m.backendPanel.ownersOnly);
      const url = interaction.fields.getTextInputValue('url').trim().replace(/\/+$/, '');
      const model = interaction.fields.getTextInputValue('model').trim();
      const keyInput = interaction.fields.getTextInputValue('key').trim();
      if (!/^https?:\/\/[^\s/]+/.test(url)) return show('summary', `❌ ${m.transcriptionConfig.badUrl}`);
      try {
        await assertUrlAllowed(url, ctx.config.ai.allowedHosts);
      } catch (err) {
        return show('summary', `❌ ${err instanceof Error ? err.message : err}`);
      }
      const settings = await ctx.settings.get(guildId);
      const apiKey = keyInput === '-' ? null : keyInput || settings.llmApiKey;
      await interaction.deferUpdate();
      await ctx.repos.updateSettings(guildId, { llmBaseUrl: url, llmModel: model || null, llmApiKey: apiKey });
      const result = await testLlm(effectiveLlm(await ctx.settings.get(guildId), ctx.config).config, ctx.config.ai.allowedHosts);
      return show('summary', `${t.saved}\n${result.ok ? t.llmTestOk(result.ms!, result.model!) : t.llmTestKo(result.error!)}`);
    }
    case 'llmModels': {
      if (!interaction.isButton()) return;
      if (!isOwner) throw new UserError(m.backendPanel.ownersOnly);
      await interaction.deferUpdate();
      try {
        const models = await listModels(effectiveLlm(await ctx.settings.get(guildId), ctx.config).config, ctx.config.ai.allowedHosts);
        return show('summary', models.length ? undefined : t.noModels, undefined, models);
      } catch (err) {
        return show('summary', `❌ ${err instanceof Error ? err.message : err}`);
      }
    }
    case 'llmModel': {
      if (!interaction.isStringSelectMenu()) return;
      if (!isOwner) throw new UserError(m.backendPanel.ownersOnly);
      await ctx.repos.updateSettings(guildId, { llmModel: interaction.values[0] ?? null });
      return show('summary', t.saved);
    }
    case 'llmTest': {
      if (!interaction.isButton()) return;
      await interaction.deferUpdate();
      const result = await testLlm(effectiveLlm(await ctx.settings.get(guildId), ctx.config).config, ctx.config.ai.allowedHosts);
      return show('summary', result.ok ? t.llmTestOk(result.ms!, result.model!) : t.llmTestKo(result.error!));
    }
    case 'llmToggle': {
      const settings = await ctx.settings.get(guildId);
      await ctx.repos.updateSettings(guildId, { llmEnabled: !settings.llmEnabled });
      return show('summary', t.saved);
    }
    case 'llmReset': {
      if (!isOwner) throw new UserError(m.backendPanel.ownersOnly);
      await ctx.repos.updateSettings(guildId, { llmBaseUrl: null, llmModel: null, llmApiKey: null });
      return show('summary', t.saved);
    }

    case 'toggleAutoRecord': {
      const settings = await ctx.settings.get(guildId);
      await ctx.repos.updateSettings(guildId, { autoRecordDefault: !settings.autoRecordDefault });
      return show('recording', t.saved);
    }
  }
}

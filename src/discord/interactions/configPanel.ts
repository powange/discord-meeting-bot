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
import { effectiveLlms, listModels, llmRowToConfig, testLlm, type LlmTest } from '../../services/llmSettings.js';
import { effectiveBackends } from '../../services/transcriptionBackends.js';
import { assertUrlAllowed, hostOf } from '../../lib/hosts.js';
import { CONFIG_SECTIONS, renderConfigHome, renderConfigSection, VOICE_LEADS_MIN, type ConfigContext, type ConfigSection, type VoiceMode } from '../embeds/configPanel.js';
import { ensureStatusTags, missingForumPermissions } from '../forum.js';
import { openBackendPanelInPlace } from './backendPanel.js';
import { encryptSecret } from '../../lib/secrets.js';

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
  const llm = await effectiveLlms(ctx.repos, settings, ctx.config);
  const rows = llm.source === 'discord' ? await ctx.repos.listLlmBackends(guildId) : [];
  const { source, backends } = await effectiveBackends(ctx.repos, ctx.config, guildId);
  const names = backends.map((b) => b.name).join(', ');
  const transcription = source === 'yaml' && backends.length ? m.config.fromYamlSummary(names) : m.config.transcriptionSummary(backends.length, names);
  return {
    settings,
    transcription,
    notice,
    llm: {
      source: llm.source,
      enabled: llm.enabled,
      servers:
        llm.source === 'discord'
          ? rows.map((r) => ({ id: r.id, name: r.name, url: r.url, model: r.model, enabled: r.enabled, hasKey: Boolean(r.apiKey) }))
          : llm.servers.map((sv) => ({ name: sv.name, url: sv.config.baseUrl ?? '', model: sv.config.model, enabled: true, hasKey: Boolean(sv.config.apiKey) })),
    },
    canEditAi: userId ? ctx.owners.isOwner(userId) : false,
    refusals: await ctx.optouts.list(guildId),
  };
}

type ShowExtra = Partial<Pick<ConfigContext, 'models' | 'confirmLlmDisable' | 'voiceMode' | 'llmSelected' | 'llmConfirmDelete'>> & { page?: number };

/** Serveurs de résumé au plus (limite raisonnable des composants du panneau). */
const MAX_LLM_SERVERS = 5;

function formatTest(result: LlmTest, t: Messages['config']): string {
  return result.ok ? t.llmTestOk(result.ms!, result.model!) : t.llmTestKo(result.error!);
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

  const show = async (section: Section | 'home', notice?: string, extra: ShowExtra = {}) => {
    const { page, ...state } = extra;
    const c = { ...(await context(ctx, guildId, m, notice, interaction.user.id)), ...state };
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

  // Serveur de résumé visé (« s.<id> » dans l'identifiant du bouton).
  const serverId = arg?.startsWith('s.') ? Number(arg.slice(2)) : Number.NaN;
  const server = async () => {
    const row = (await ctx.repos.listLlmBackends(guildId)).find((r) => r.id === serverId);
    if (!row) throw new UserError(t.llmGone);
    return row;
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
      return show(section, undefined, { page: Number(page) });
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
      await ctx.repos.updateSettings(guildId, { voiceChannelId: voice.id, autoVoice: false });
      return show('voice', t.saved);
    }
    case 'voiceClear':
      await ctx.repos.updateSettings(guildId, { voiceChannelId: null });
      return show('voice', t.saved);
    case 'voiceMode': {
      if (!interaction.isStringSelectMenu()) return;
      const mode = interaction.values[0];
      if (mode === 'free') await ctx.repos.updateSettings(guildId, { voiceChannelId: null, autoVoice: false });
      else if (mode === 'auto') {
        await ctx.repos.updateSettings(guildId, { voiceChannelId: null, autoVoice: true });
        await ctx.meetings.replanGuild(guildId);
        const settings = await ctx.settings.get(guildId);
        const problem = voiceCategoryProblem(interaction.guild, settings.autoVoiceCategoryId ?? forumParent(interaction.guild, settings.forumChannelId), m);
        return show('voice', problem ? `${t.saved}\n${problem}` : t.saved);
      }
      // « Imposé » : le salon reste à choisir dans la liste qui apparaît.
      else if (mode === 'fixed') return show('voice', t.pickVoiceNow, { voiceMode: 'fixed' });
      await ctx.meetings.replanGuild(guildId); // tâche de création du salon (ajoutée ou retirée)
      return show('voice', t.saved);
    }
    case 'voiceCategory': {
      if (!interaction.isChannelSelectMenu()) return;
      const categoryId = interaction.values[0] ?? null;
      const settings = await ctx.settings.get(guildId);
      // Catégorie où le bot ne peut pas créer de salon : refusée, plutôt qu'un échec le jour de la réunion.
      const problem = voiceCategoryProblem(interaction.guild, categoryId ?? forumParent(interaction.guild, settings.forumChannelId), m);
      if (problem && categoryId) return show('voice', problem);
      await ctx.repos.updateSettings(guildId, { autoVoiceCategoryId: categoryId });
      return show('voice', problem ? `${t.saved}\n${problem}` : t.saved);
    }
    case 'voiceLead': {
      if (!interaction.isStringSelectMenu()) return;
      const lead = Number(interaction.values[0]);
      if (!VOICE_LEADS_MIN.includes(lead as (typeof VOICE_LEADS_MIN)[number])) return;
      await ctx.repos.updateSettings(guildId, { autoVoiceLeadMin: lead });
      await ctx.meetings.replanGuild(guildId);
      return show('voice', t.saved);
    }

    case 'roleManager': {
      if (!interaction.isRoleSelectMenu()) return;
      await ctx.repos.updateSettings(guildId, { managerRoleIds: [...interaction.roles.keys()].slice(0, 5) });
      return show('roles', t.saved);
    }
    case 'roleNudge': {
      if (!interaction.isRoleSelectMenu()) return;
      await ctx.repos.updateSettings(guildId, { nudgeRoleId: interaction.roles.first()?.id ?? null });
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

    // ---------------------------------------------------------------- serveurs de résumé
    case 'llmPick': {
      if (!interaction.isStringSelectMenu()) return;
      return show('summary', undefined, { llmSelected: Number(interaction.values[0]) });
    }
    case 'llmCancel':
      return show('summary', undefined, { llmSelected: serverId });
    case 'llmAdd':
    case 'llmEdit': {
      if (!interaction.isButton()) return;
      if (!isOwner) throw new UserError(m.backendPanel.ownersOnly);
      const editing = action === 'llmEdit' ? await server() : null;
      if (!editing && (await ctx.repos.listLlmBackends(guildId)).length >= MAX_LLM_SERVERS) return show('summary', t.llmFull(MAX_LLM_SERVERS));
      const name = new TextInputBuilder().setCustomId('name').setStyle(TextInputStyle.Short).setMaxLength(40).setRequired(true).setPlaceholder('pc-salon');
      const url = new TextInputBuilder().setCustomId('url').setStyle(TextInputStyle.Short).setMaxLength(200).setRequired(true).setPlaceholder('http://192.168.0.11:1234/v1');
      const model = new TextInputBuilder().setCustomId('model').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(false);
      const key = new TextInputBuilder().setCustomId('key').setStyle(TextInputStyle.Short).setMaxLength(200).setRequired(false);
      if (editing) {
        name.setValue(editing.name);
        url.setValue(editing.url);
        model.setValue(editing.model);
      }
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(editing ? encode({ type: 'cfg', action: 'llmSubmit', arg: `s.${editing.id}` }) : encode({ type: 'cfg', action: 'llmAddSubmit' }))
          .setTitle(editing ? t.llmModalEdit : t.llmModalAdd)
          .addLabelComponents(
            new LabelBuilder().setLabel(t.llmNameField).setTextInputComponent(name),
            new LabelBuilder().setLabel(t.llmUrlField).setDescription(t.llmUrlHint).setTextInputComponent(url),
            new LabelBuilder().setLabel(t.llmModelField).setDescription(t.llmModelHint).setTextInputComponent(model),
            new LabelBuilder().setLabel(t.llmKeyField).setDescription(editing ? t.llmKeyHint : t.llmKeyNewHint).setTextInputComponent(key),
          ),
      );
      return;
    }
    case 'llmAddSubmit':
    case 'llmSubmit': {
      if (!interaction.isModalSubmit()) return;
      if (!isOwner) throw new UserError(m.backendPanel.ownersOnly);
      const editing = action === 'llmSubmit' ? await server() : null;
      const name = interaction.fields.getTextInputValue('name').trim();
      const url = interaction.fields.getTextInputValue('url').trim().replace(/\/+$/, '');
      const model = interaction.fields.getTextInputValue('model').trim();
      const keyInput = interaction.fields.getTextInputValue('key').trim();
      if (!name) return show('summary', `❌ ${m.errors.titleRequired}`);
      if (!/^https?:\/\/[^\s/]+/.test(url)) return show('summary', `❌ ${m.transcriptionConfig.badUrl}`);
      try {
        await assertUrlAllowed(url, ctx.config.ai.allowedHosts);
      } catch (err) {
        return show('summary', `❌ ${err instanceof Error ? err.message : err}`);
      }
      const others = (await ctx.repos.listLlmBackends(guildId)).filter((r) => r.id !== editing?.id);
      if (others.some((r) => r.name === name)) return show('summary', `❌ ${t.llmExists(name)}`);
      // Clé chiffrée en base ; changer d'hôte sans ressaisir la clé l'efface (elle ne part pas vers un autre serveur).
      const sameHost = editing !== null && hostOf(editing.url) === hostOf(url);
      const apiKey = keyInput && keyInput !== '-' ? encryptSecret(keyInput) : keyInput !== '-' && sameHost ? editing.apiKey : null;
      await interaction.deferUpdate();
      const yaml = ctx.config.guild(guildId).llm;
      let row = editing;
      if (editing) await ctx.repos.updateLlmBackend(guildId, editing.id, { name, url, model: model || editing.model, apiKey });
      else row = await ctx.repos.addLlmBackend({ guildId, name, url, model: model || yaml.model, apiKey });
      row = (await ctx.repos.listLlmBackends(guildId)).find((r) => r.id === row!.id)!;
      // La liste des modèles s'affiche d'emblée : un formulaire ne peut pas la proposer.
      const llm = llmRowToConfig(row, yaml);
      let models: string[] = [];
      let listError: string | undefined;
      try {
        models = await listModels(llm, ctx.config.ai.allowedHosts);
      } catch (err) {
        listError = err instanceof Error ? err.message : String(err);
      }
      if (!model) return show('summary', `${t.saved}\n${listError ? t.llmTestKo(listError) : models.length ? t.pickModelNow : t.noModels}`, { llmSelected: row.id, models });
      const result = await testLlm(llm, ctx.config.ai.allowedHosts);
      return show('summary', `${t.saved}\n${result.ok ? t.llmTestOk(result.ms!, result.model!) : t.llmTestKo(result.error!)}`, { llmSelected: row.id, models });
    }
    case 'llmModels': {
      if (!interaction.isButton()) return;
      if (!isOwner) throw new UserError(m.backendPanel.ownersOnly);
      const row = await server();
      await interaction.deferUpdate();
      try {
        const models = await listModels(llmRowToConfig(row, ctx.config.guild(guildId).llm), ctx.config.ai.allowedHosts);
        return show('summary', models.length ? undefined : t.noModels, { llmSelected: row.id, models });
      } catch (err) {
        return show('summary', `❌ ${err instanceof Error ? err.message : err}`, { llmSelected: row.id });
      }
    }
    case 'llmModel': {
      if (!interaction.isStringSelectMenu()) return;
      if (!isOwner) throw new UserError(m.backendPanel.ownersOnly);
      const row = await server();
      await ctx.repos.updateLlmBackend(guildId, row.id, { model: interaction.values[0] ?? row.model });
      return show('summary', t.saved, { llmSelected: row.id });
    }
    case 'llmUp': {
      if (!isOwner) throw new UserError(m.backendPanel.ownersOnly);
      const row = await server();
      const ids = (await ctx.repos.listLlmBackends(guildId)).map((r) => r.id);
      const at = ids.indexOf(row.id);
      if (at > 0) await ctx.repos.reorderLlmBackends(guildId, [...ids.slice(0, at - 1), row.id, ids[at - 1]!, ...ids.slice(at + 1)]);
      return show('summary', t.saved, { llmSelected: row.id });
    }
    case 'llmToggleServer': {
      if (!isOwner) throw new UserError(m.backendPanel.ownersOnly);
      const row = await server();
      await ctx.repos.updateLlmBackend(guildId, row.id, { enabled: !row.enabled });
      return show('summary', t.saved, { llmSelected: row.id });
    }
    case 'llmDelete': {
      if (!isOwner) throw new UserError(m.backendPanel.ownersOnly);
      const row = await server();
      return show('summary', t.llmDeleteAsk(row.name), { llmSelected: row.id, llmConfirmDelete: true });
    }
    case 'llmDeleteConfirm': {
      if (!isOwner) throw new UserError(m.backendPanel.ownersOnly);
      const row = await server();
      await ctx.repos.removeLlmBackend(guildId, row.id);
      const left = await ctx.repos.listLlmBackends(guildId);
      return show('summary', left.length ? t.llmDeleted(row.name) : `${t.llmDeleted(row.name)}\n${t.llmBackToYaml}`);
    }
    case 'llmTest':
    case 'llmTestAll': {
      if (!interaction.isButton()) return;
      await interaction.deferUpdate();
      const yaml = ctx.config.guild(guildId).llm;
      const rows = await ctx.repos.listLlmBackends(guildId);
      const targets = action === 'llmTest' && Number.isFinite(serverId) ? rows.filter((r) => r.id === serverId) : rows.filter((r) => r.enabled);
      if (targets.length === 0) {
        // Pas de liste dans /config : le serveur du fichier de configuration.
        const { servers } = await effectiveLlms(ctx.repos, await ctx.settings.get(guildId), ctx.config);
        const lines = await Promise.all(servers.map(async (sv) => `**${sv.name}** · ${formatTest(await testLlm(sv.config, ctx.config.ai.allowedHosts), t)}`));
        return show('summary', lines.join('\n') || t.summaryNone);
      }
      const lines = await Promise.all(targets.map(async (r) => `**${r.name}** · ${formatTest(await testLlm(llmRowToConfig(r, yaml), ctx.config.ai.allowedHosts), t)}`));
      return show('summary', lines.join('\n'), Number.isFinite(serverId) ? { llmSelected: serverId } : {});
    }
    case 'llmToggle': {
      const settings = await ctx.settings.get(guildId);
      if (settings.llmEnabled) return show('summary', t.llmDisableAsk, { confirmLlmDisable: true });
      await ctx.repos.updateSettings(guildId, { llmEnabled: true });
      return show('summary', t.saved);
    }
    case 'llmDisableConfirm': {
      await ctx.repos.updateSettings(guildId, { llmEnabled: false });
      return show('summary', t.saved);
    }
    case 'llmReset':
      // Ancien bouton (un seul serveur) : la liste le remplace.
      return show('summary');

    case 'toggleAutoRecord': {
      const settings = await ctx.settings.get(guildId);
      await ctx.repos.updateSettings(guildId, { autoRecordDefault: !settings.autoRecordDefault });
      return show('recording', t.saved);
    }
  }
}

/** Catégorie du forum des réunions (emplacement par défaut des salons temporaires). */
function forumParent(guild: Guild, forumId: string | null): string | null {
  return (forumId && guild.channels.cache.get(forumId)?.parentId) || null;
}

/** Permissions qui manquent au bot pour créer des salons dans la catégorie (ou à la racine du serveur). */
function voiceCategoryProblem(guild: Guild, categoryId: string | null, m: Messages): string | null {
  const me = guild.members.me;
  const category = categoryId ? guild.channels.cache.get(categoryId) : null;
  const perms = category && me ? category.permissionsFor(me) : (me?.permissions ?? null);
  const needed = { ManageChannels: PermissionFlagsBits.ManageChannels, ViewChannel: PermissionFlagsBits.ViewChannel };
  const missing = Object.entries(needed)
    .filter(([, flag]) => !perms?.has(flag))
    .map(([name]) => name);
  if (missing.length === 0) return null;
  const where = category ? `<#${category.id}>` : m.config.voiceCategoryForum;
  return m.config.voiceCategoryPermissions(where, missing.join(', '));
}

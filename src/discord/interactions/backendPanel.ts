import {
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { AppContext } from '../../context.js';
import type { TranscriptionBackendRow } from '../../db/schema.js';
import { encode, type TxAction } from '../../domain/customId.js';
import type { Messages } from '../../i18n/index.js';
import { UserError } from '../../lib/errors.js';
import { parseVocabulary, VOCABULARY_MAX_TERMS } from '../../domain/vocabulary.js';
import { assertUrlAllowed, hostOf } from '../../lib/hosts.js';
import { moveTo, rowToConfig, testBackend, type BackendTest } from '../../services/transcriptionBackends.js';
import { MAX_BACKENDS, renderBackendPanel, type PanelState } from '../embeds/backendPanel.js';
import { encryptSecret } from '../../lib/secrets.js';

type PanelInteraction = ButtonInteraction<'cached'> | ModalSubmitInteraction<'cached'>;

const F = { name: 'name', type: 'type', url: 'url', model: 'model', key: 'key' } as const;

/** Depuis le panneau /config : remplace la vue par celle des serveurs de transcription. */
export async function openBackendPanelInPlace(ctx: AppContext, interaction: StringSelectMenuInteraction<'cached'>): Promise<void> {
  const m = await ctx.settings.messages(interaction.guildId);
  const canEdit = ctx.owners.isOwner(interaction.user.id);
  await interaction.update(await panel(ctx, interaction.guildId, { canEdit }, m));
}

/** Actions permises aux administrateurs (consultation, tests, vocabulaire) ; le reste (adresses appelées par le bot) est réservé aux propriétaires. */
const READ_ONLY_ACTIONS: readonly TxAction[] = ['select', 'test', 'testAll', 'vocab', 'vocabSubmit'];

/** Boutons et formulaires du panneau. Chaque action revérifie la permission « Gérer le serveur ». */
export async function handleBackendPanel(ctx: AppContext, interaction: PanelInteraction, action: TxAction, backendId: number | null): Promise<void> {
  const guildId = interaction.guildId;
  const m = await ctx.settings.messages(guildId);
  const p = m.backendPanel;
  const canEdit = ctx.owners.isOwner(interaction.user.id);
  if (!canEdit && !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) throw new UserError(p.forbidden);
  if (!canEdit && !READ_ONLY_ACTIONS.includes(action)) throw new UserError(p.ownersOnly);
  const language = ctx.config.guild(guildId).transcription.language;
  const rows = await ctx.repos.listBackends(guildId);
  const target = backendId === null ? undefined : rows.find((r) => r.id === backendId);
  const needTarget = () => {
    if (!target) throw new UserError(m.transcriptionConfig.unknown('?'));
    return target;
  };
  const refresh = async (state: PanelState) => {
    const payload = await panel(ctx, guildId, { ...state, canEdit }, m);
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else if (interaction.isButton()) await interaction.update(payload);
    else if (interaction.isFromMessage()) await interaction.update(payload);
  };

  switch (action) {
    case 'select':
      return refresh({});

    case 'up':
    case 'down': {
      // « down » n'est plus affiché (limite de composants) mais reste accepté.
      const t = needTarget();
      const names = rows.map((r) => r.name);
      const order = moveTo(names, t.name, names.indexOf(t.name) + (action === 'up' ? -1 : 1));
      if (order) await ctx.repos.reorderBackends(guildId, order);
      return refresh({});
    }

    case 'toggle': {
      const t = needTarget();
      await ctx.repos.updateBackend(guildId, t.name, { enabled: !t.enabled });
      return refresh({});
    }

    case 'test': {
      const t = needTarget();
      if (interaction.isButton()) await interaction.deferUpdate();
      const result = await testBackend(rowToConfig(t), ctx.config, language);
      return refresh({ notices: new Map([[t.id, formatResult(result, m)]]) });
    }

    case 'testAll': {
      if (interaction.isButton()) await interaction.deferUpdate();
      if (rows.length === 0) {
        const yaml = ctx.config.guild(guildId).transcription.backends;
        const results = await Promise.all(yaml.map(async (b) => `**${b.name}** : ${m.backendPanel.verdict(await testBackend(b, ctx.config, language))}`));
        return refresh({ notice: results.join('\n') });
      }
      const enabled = rows.filter((r) => r.enabled);
      const results = await Promise.all(enabled.map(async (r) => [r.id, formatResult(await testBackend(rowToConfig(r), ctx.config, language), m)] as const));
      return refresh({ notices: new Map(results) });
    }

    case 'delete':
      return refresh({ confirmDeleteId: needTarget().id });

    case 'confirmDelete': {
      const t = needTarget();
      await ctx.repos.removeBackend(guildId, t.name);
      const left = await ctx.repos.listBackends(guildId);
      return refresh({ notice: left.length ? p.deleted(t.name) : `${p.deleted(t.name)}\n${m.transcriptionConfig.backToYaml}` });
    }

    case 'vocab': {
      if (!interaction.isButton()) return;
      const current = (await ctx.settings.get(guildId)).vocabulary;
      const input = new TextInputBuilder().setCustomId('vocabulary').setStyle(TextInputStyle.Paragraph).setMaxLength(2000).setRequired(false).setPlaceholder('Pol, Apothicaire, LiteLLM');
      if (current.length) input.setValue(current.join(', '));
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(encode({ type: 'tx', action: 'vocabSubmit', backendId: null }))
          .setTitle(p.vocabularyModal)
          .addLabelComponents(new LabelBuilder().setLabel(p.vocabularyField).setDescription(p.vocabularyHint(VOCABULARY_MAX_TERMS)).setTextInputComponent(input)),
      );
      return;
    }
    case 'vocabSubmit': {
      if (!interaction.isModalSubmit()) return;
      const vocabulary = parseVocabulary(interaction.fields.getTextInputValue('vocabulary'));
      await ctx.repos.updateSettings(guildId, { vocabulary });
      return refresh({ notice: p.vocabularySaved(vocabulary.length) });
    }

    case 'add': {
      if (!interaction.isButton()) return;
      if (rows.length >= MAX_BACKENDS) return refresh({ notice: p.full(MAX_BACKENDS) });
      await interaction.showModal(backendModal(m, null));
      return;
    }

    case 'edit': {
      if (!interaction.isButton()) return;
      await interaction.showModal(backendModal(m, needTarget()));
      return;
    }

    case 'addSubmit':
    case 'editSubmit': {
      if (!interaction.isModalSubmit()) return;
      const editing = action === 'editSubmit' ? needTarget() : null;
      const input = readBackendModal(interaction, m, editing);
      if (rows.some((r) => r.name === input.name && r.id !== editing?.id)) throw new UserError(m.transcriptionConfig.exists(input.name));
      try {
        await assertUrlAllowed(input.url, ctx.config.ai.allowedHosts);
      } catch (err) {
        throw new UserError(err instanceof Error ? err.message : String(err));
      }
      if (!editing && rows.length >= MAX_BACKENDS) throw new UserError(p.full(MAX_BACKENDS));
      await interaction.deferUpdate();

      if (editing) {
        await ctx.repos.updateBackend(guildId, editing.name, { ...input, concurrency: input.type === 'vibe' ? 1 : editing.concurrency });
      } else {
        await ctx.repos.addBackend({ guildId, ...input, concurrency: 1 });
      }
      const saved = (await ctx.repos.listBackends(guildId)).find((r) => r.name === input.name)!;
      const result = await testBackend(rowToConfig(saved), ctx.config, language);
      const head = editing ? p.saved(saved.name) : m.transcriptionConfig.added(saved.name, saved.position + 1);
      return refresh({ notices: new Map([[saved.id, `${head}\n${formatResult(result, m)}`]]) });
    }
  }
}

async function panel(ctx: AppContext, guildId: string, state: PanelState, m: Messages) {
  const rows = await ctx.repos.listBackends(guildId);
  const yamlFallback = rows.length === 0 ? ctx.config.guild(guildId).transcription.backends : [];
  const { vocabulary } = await ctx.settings.get(guildId);
  return { components: [renderBackendPanel(rows, { ...state, yamlFallback, vocabulary }, m)], allowedMentions: { parse: [] } };
}

/** Verdict d'un test, affiché sous le serveur concerné. */
function formatResult(result: BackendTest, m: Messages): string {
  return m.backendPanel.verdict(result);
}

function backendModal(m: Messages, row: TranscriptionBackendRow | null): ModalBuilder {
  const p = m.backendPanel;
  const name = new TextInputBuilder().setCustomId(F.name).setStyle(TextInputStyle.Short).setMaxLength(40).setRequired(true).setPlaceholder('vibe-pc');
  const url = new TextInputBuilder().setCustomId(F.url).setStyle(TextInputStyle.Short).setMaxLength(200).setRequired(true).setPlaceholder('http://pc-main.tailnet:8080');
  const model = new TextInputBuilder().setCustomId(F.model).setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(false);
  const key = new TextInputBuilder().setCustomId(F.key).setStyle(TextInputStyle.Short).setMaxLength(200).setRequired(false);
  if (row) {
    name.setValue(row.name);
    url.setValue(row.url);
    if (row.model !== 'whisper-1') model.setValue(row.model);
  }
  const type = new StringSelectMenuBuilder()
    .setCustomId(F.type)
    .setRequired(true)
    .addOptions(
      { label: p.typeVibe, value: 'vibe', description: p.typeVibeHint, default: (row?.type ?? 'vibe') === 'vibe' },
      { label: p.typeOpenai, value: 'openai', description: p.typeOpenaiHint, default: row?.type === 'openai' },
    );

  return new ModalBuilder()
    .setCustomId(encode({ type: 'tx', action: row ? 'editSubmit' : 'addSubmit', backendId: row?.id ?? null }))
    .setTitle(row ? p.modalEdit : p.modalAdd)
    .addLabelComponents(
      new LabelBuilder().setLabel(p.fieldName).setTextInputComponent(name),
      new LabelBuilder().setLabel(p.fieldType).setStringSelectMenuComponent(type),
      new LabelBuilder().setLabel(p.fieldUrl).setDescription(p.fieldUrlHint).setTextInputComponent(url),
      new LabelBuilder().setLabel(p.fieldModel).setDescription(p.fieldModelHint).setTextInputComponent(model),
      new LabelBuilder().setLabel(p.fieldKey).setDescription(row ? p.fieldKeyEditHint : p.fieldKeyHint).setTextInputComponent(key),
    );
}

function readBackendModal(interaction: ModalSubmitInteraction<'cached'>, m: Messages, editing: TranscriptionBackendRow | null) {
  const name = interaction.fields.getTextInputValue(F.name).trim();
  const type = (interaction.fields.getStringSelectValues(F.type)[0] ?? 'vibe') as 'vibe' | 'openai';
  const url = interaction.fields.getTextInputValue(F.url).trim().replace(/\/+$/, '');
  const model = interaction.fields.getTextInputValue(F.model).trim() || 'whisper-1';
  const keyInput = interaction.fields.getTextInputValue(F.key).trim();
  if (!name) throw new UserError(m.errors.titleRequired);
  if (!/^https?:\/\/[^\s/]+/.test(url)) throw new UserError(m.transcriptionConfig.badUrl);
  // Modification : champ vide = clé inchangée, « - » = clé supprimée.
  // Clé chiffrée en base ; changer d'adresse sans ressaisir la clé l'efface (elle ne part pas vers un autre hôte).
  const sameHost = editing && hostOf(editing.url) === hostOf(url);
  const apiKey = keyInput && keyInput !== '-' ? encryptSecret(keyInput) : editing && keyInput !== '-' && sameHost ? editing.apiKey : null;
  return { name, type, url, model, apiKey };
}

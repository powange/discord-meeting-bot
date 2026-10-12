import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ContainerBuilder,
  RoleSelectMenuBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  type APIContainerComponent,
} from 'discord.js';
import type { GuildSettingsRow } from '../../db/schema.js';
import { encode, type CfgAction } from '../../domain/customId.js';
import { formatOffset } from '../../domain/reminders.js';
import type { Messages } from '../../i18n/index.js';

export const CONFIG_SECTIONS = ['forum', 'voice', 'roles', 'reminders', 'general', 'recording', 'transcription'] as const;
export type ConfigSection = (typeof CONFIG_SECTIONS)[number];

export interface ConfigContext {
  settings: GuildSettingsRow;
  /** Résumé des serveurs de transcription (« 2 actifs : vibe-pc, speaches »). */
  transcription: string;
  notice?: string | undefined;
}

const cfg = (action: CfgAction) => encode({ type: 'cfg', action });
const btn = (action: CfgAction, label: string, emoji: string, style = ButtonStyle.Secondary) =>
  new ButtonBuilder().setCustomId(cfg(action)).setLabel(label).setEmoji(emoji).setStyle(style);

function role(id: string | null, m: Messages): string {
  return id ? `<@&${id}>` : `*${m.config.none}*`;
}

/** Valeur courante de chaque section, en une ligne (accueil et en-tête des sections). */
export function sectionSummary(section: ConfigSection, c: ConfigContext, m: Messages): string {
  const s = c.settings;
  const t = m.config;
  switch (section) {
    case 'forum':
      return s.forumChannelId ? `<#${s.forumChannelId}>` : `*${t.none}*`;
    case 'voice':
      return s.voiceChannelId ? `<#${s.voiceChannelId}> · ${t.voiceImposed}` : `*${t.voiceFree}*`;
    case 'roles':
      return `${t.managerRole} ${role(s.managerRoleId, m)} · ${t.optoutRole} ${role(s.optoutRoleId, m)} · ${t.nudgeRole} ${role(s.nudgeRoleId, m)}`;
    case 'reminders':
      return s.reminderOffsetsMin.length ? s.reminderOffsetsMin.map(formatOffset).join(', ') : `*${t.none}*`;
    case 'general':
      return `${s.timezone} · ${m.card.minutes(s.defaultDurationMin)} · ${s.creatorsRestricted ? t.creatorsManagers : t.creatorsAll}`;
    case 'recording':
      return s.autoRecordDefault ? t.autoOn : t.autoOff;
    case 'transcription':
      return c.transcription;
  }
}

/** Accueil : tous les réglages en un coup d'œil, et le choix de la section à modifier. */
export function renderConfigHome(c: ConfigContext, m: Messages): APIContainerComponent {
  const t = m.config;
  const lines = CONFIG_SECTIONS.map((sec) => `${t.sections[sec].emoji} **${t.sections[sec].label}** · ${sectionSummary(sec, c, m)}`);
  const select = new StringSelectMenuBuilder()
    .setCustomId(cfg('section'))
    .setPlaceholder(t.pick)
    .addOptions(CONFIG_SECTIONS.map((sec) => ({ label: t.sections[sec].label, value: sec, emoji: t.sections[sec].emoji, description: t.sections[sec].hint })));
  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents((x) => x.setContent(`## ⚙️ ${t.title}${c.notice ? `\n${c.notice}` : ''}`))
    .addSeparatorComponents((x) => x.setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents((x) => x.setContent(lines.join('\n')))
    .addActionRowComponents((row: ActionRowBuilder<StringSelectMenuBuilder>) => row.addComponents(select));
  return container.toJSON();
}

/** Vue d'une section : explication, valeur actuelle, contrôles, retour. */
export function renderConfigSection(section: Exclude<ConfigSection, 'transcription'>, c: ConfigContext, m: Messages): APIContainerComponent {
  const t = m.config;
  const s = c.settings;
  const meta = t.sections[section];
  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents((x) =>
      x.setContent(`## ${meta.emoji} ${meta.label}\n-# ${meta.help}\n\n${t.current} : ${sectionSummary(section, c, m)}${c.notice ? `\n\n${c.notice}` : ''}`),
    )
    .addSeparatorComponents((x) => x.setSpacing(SeparatorSpacingSize.Small));

  const rows: Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<ChannelSelectMenuBuilder> | ActionRowBuilder<RoleSelectMenuBuilder>> = [];
  switch (section) {
    case 'forum': {
      const select = new ChannelSelectMenuBuilder().setCustomId(cfg('forum')).setChannelTypes(ChannelType.GuildForum).setPlaceholder(t.pickForum);
      if (s.forumChannelId) select.setDefaultChannels(s.forumChannelId);
      rows.push(new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select));
      break;
    }
    case 'voice': {
      const select = new ChannelSelectMenuBuilder().setCustomId(cfg('voice')).setChannelTypes(ChannelType.GuildVoice).setPlaceholder(t.pickVoice);
      if (s.voiceChannelId) select.setDefaultChannels(s.voiceChannelId);
      rows.push(new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select));
      if (s.voiceChannelId) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(btn('voiceClear', t.voiceFreeButton, '🔓')));
      break;
    }
    case 'roles': {
      const roleSelect = (action: CfgAction, current: string | null, placeholder: string) => {
        const select = new RoleSelectMenuBuilder().setCustomId(cfg(action)).setPlaceholder(placeholder).setMinValues(0).setMaxValues(1);
        if (current) select.setDefaultRoles(current);
        return new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(select);
      };
      rows.push(
        roleSelect('roleManager', s.managerRoleId, t.pickManager),
        roleSelect('roleOptout', s.optoutRoleId, t.pickOptout),
        roleSelect('roleNudge', s.nudgeRoleId, t.pickNudge),
      );
      break;
    }
    case 'reminders':
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(btn('remindersEdit', t.editReminders, '✏️', ButtonStyle.Primary)));
      break;
    case 'general':
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          btn('generalEdit', t.editGeneral, '✏️', ButtonStyle.Primary),
          btn('toggleCreators', s.creatorsRestricted ? t.openCreation : t.restrictCreation, s.creatorsRestricted ? '🔓' : '🔒'),
        ),
      );
      break;
    case 'recording':
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          btn('toggleAutoRecord', s.autoRecordDefault ? t.disableAuto : t.enableAuto, s.autoRecordDefault ? '⏸️' : '🔴', s.autoRecordDefault ? ButtonStyle.Secondary : ButtonStyle.Primary),
        ),
      );
      break;
  }
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(btn('home', t.back, '↩️')));
  for (const row of rows) container.addActionRowComponents(row as ActionRowBuilder<ButtonBuilder>);
  return container.toJSON();
}

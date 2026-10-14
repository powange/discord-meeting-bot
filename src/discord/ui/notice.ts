import { ContainerBuilder, type APIContainerComponent } from 'discord.js';

/** Nature d'un avis : son emoji et sa couleur sont les mêmes partout. */
export type NoticeKind = 'success' | 'error' | 'warn' | 'info';

const EMOJI: Record<NoticeKind, string> = { success: '✅', error: '❌', warn: '⚠️', info: 'ℹ️' };
const COLOR: Record<NoticeKind, number> = { success: 0x57f287, error: 0xed4245, warn: 0xe67e22, info: 0x5865f2 };

/** Texte préfixé de l'emoji de sa nature (sauf s'il commence déjà par un emoji). */
export function noticeText(kind: NoticeKind, text: string): string {
  return /^\p{Extended_Pictographic}/u.test(text.trimStart()) ? text : `${EMOJI[kind]} ${text}`;
}

/** Avis dans un panneau Components V2, avec la couleur de sa nature. */
export function noticeContainer(kind: NoticeKind, text: string): APIContainerComponent {
  return new ContainerBuilder()
    .setAccentColor(COLOR[kind])
    .addTextDisplayComponents((t) => t.setContent(noticeText(kind, text)))
    .toJSON();
}

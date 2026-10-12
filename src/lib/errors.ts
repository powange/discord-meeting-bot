/**
 * Erreur « attendue », dont le message est destiné à l'utilisateur Discord (déjà traduit).
 * Tout le reste est considéré comme un bug et loggé avec sa stack.
 */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Code d'erreur de l'API Discord (DiscordAPIError.code), sinon undefined. */
export function discordErrorCode(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'number') return err.code;
  return undefined;
}

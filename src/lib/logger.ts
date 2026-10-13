import { pino, stdSerializers, type Logger } from 'pino';

export type { Logger };

/**
 * Champs d'erreur jamais journalisés : une erreur de l'API Discord porte le corps de la requête
 * (compte rendu, transcription, mentions) et la réponse brute.
 */
const DROPPED_ERROR_FIELDS = ['requestBody', 'rawError', 'requestData'];

/** Sérialise une erreur sans le contenu des messages envoyés. */
export function safeErrorSerializer(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const serialized = stdSerializers.err(err) as unknown as Record<string, unknown>;
  for (const field of DROPPED_ERROR_FIELDS) delete serialized[field];
  return serialized;
}

export function createLogger(level: string): Logger {
  const pretty = process.env.NODE_ENV !== 'production' && process.stdout.isTTY;
  return pino({
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: { err: safeErrorSerializer },
    // Clés d'API et en-têtes d'authentification, où qu'ils apparaissent dans un objet journalisé.
    redact: { paths: ['apiKey', '*.apiKey', '*.*.apiKey', 'authorization', '*.authorization', '*.headers.authorization', '*.headers.Authorization'], censor: '[masqué]' },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } } } : {}),
  });
}

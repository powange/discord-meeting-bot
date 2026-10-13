import { readFileSync } from 'node:fs';

/** Version du paquet et commit de l'image (GIT_SHA, injecté au build Docker ; « dev » en local). */
export interface BuildInfo {
  version: string;
  commit: string;
}

export function buildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  let version = 'inconnue';
  try {
    version = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? version;
  } catch {
    // package.json absent (exécution atypique) : la version reste « inconnue ».
  }
  return { version: env.APP_VERSION || version, commit: (env.GIT_SHA || 'dev').slice(0, 12) };
}

const PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Remplace récursivement `${VAR}` et `${VAR:-défaut}` dans toutes les chaînes d'un objet YAML.
 * Les variables absentes (sans défaut) sont collectées dans `missing` plutôt que de lever
 * immédiatement, pour pouvoir toutes les signaler d'un coup.
 */
export function interpolateEnv(value: unknown, env: NodeJS.ProcessEnv, missing: Set<string>, path = ''): unknown {
  if (typeof value === 'string') {
    return value.replace(PATTERN, (_match, name: string, fallback: string | undefined) => {
      const v = env[name];
      if (v !== undefined && v !== '') return v;
      if (fallback !== undefined) return fallback;
      missing.add(`${name} (${path || 'racine'})`);
      return '';
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => interpolateEnv(v, env, missing, `${path}[${i}]`));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, interpolateEnv(v, env, missing, path ? `${path}.${k}` : k)]),
    );
  }
  return value;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Fusion profonde : les objets sont fusionnés, les tableaux et scalaires de `override` remplacent ceux de `base`. */
export function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (isPlainObject(base) && isPlainObject(override)) {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(override)) out[k] = deepMerge(base[k], v);
    return out;
  }
  return override;
}

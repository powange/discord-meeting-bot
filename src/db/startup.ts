import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseConnectionString } from 'pg-connection-string';
import type pg from 'pg';
import type { Logger } from '../lib/logger.js';

/** Clé du verrou consultatif PostgreSQL : une seule instance du bot par base. */
const INSTANCE_LOCK_KEY = 0x6d72_6563; // « mrec »
const JOURNAL = fileURLToPath(new URL('../../drizzle/meta/_journal.json', import.meta.url));
const KEEP_BACKUPS = 5;

/**
 * Prend le verrou d'instance sur une connexion dédiée, gardée ouverte tant que le bot tourne.
 * Pendant un redéploiement, l'ancien conteneur peut encore le tenir quelques secondes : on
 * réessaie jusqu'à `timeoutMs`. Deux bots sur la même base (dev pointé sur la prod, chevauchement)
 * se marqueraient mutuellement leurs enregistrements « interrompus » et traiteraient tout en double.
 */
export async function acquireInstanceLock(pool: pg.Pool, log: Logger, timeoutMs = 90_000): Promise<pg.PoolClient> {
  const client = await pool.connect();
  const deadline = Date.now() + timeoutMs;
  let warned = false;
  for (;;) {
    const { rows } = await client.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [INSTANCE_LOCK_KEY]);
    if (rows[0]?.ok) return client;
    if (Date.now() >= deadline) {
      client.release();
      throw new Error('Une autre instance du bot utilise déjà cette base de données (verrou d’instance pris).');
    }
    if (!warned) log.warn('Une autre instance du bot tient la base ; nouvelle tentative pendant quelques instants');
    warned = true;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/** Migrations du dépôt et migrations déjà appliquées en base. */
export async function migrationState(pool: pg.Pool): Promise<{ total: number; applied: number }> {
  const journal = JSON.parse(await readFile(JOURNAL, 'utf8')) as { entries: unknown[] };
  const applied = await pool
    .query<{ n: string }>('select count(*) as n from drizzle.__drizzle_migrations')
    .then((r) => Number(r.rows[0]?.n ?? 0))
    .catch(() => 0); // base neuve : la table n'existe pas encore
  return { total: journal.entries.length, applied };
}

/**
 * Sauvegarde (pg_dump, format custom) avant d'appliquer de nouvelles migrations à une base qui
 * contient déjà des données : les migrations ne se défont pas, ce fichier permet de revenir en
 * arrière. Sans pg_dump (développement), on prévient et on continue ; si pg_dump échoue, on
 * s'arrête plutôt que de migrer sans filet (MIGRATION_BACKUP=off pour passer outre, en dernier
 * recours). Les 5 dernières sauvegardes sont gardées.
 */
export async function backupBeforeMigrations(
  pool: pg.Pool,
  url: string,
  dir: string,
  log: Logger,
  pgDump = 'pg_dump',
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const { total, applied } = await migrationState(pool);
  if (applied === 0 || applied >= total) return null;
  if (env.MIGRATION_BACKUP === 'off') {
    log.warn({ applied, total }, 'MIGRATION_BACKUP=off : migrations appliquées sans sauvegarde préalable');
    return null;
  }
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `pre-migration-${stamp}-${applied}-to-${total}.dump`);
  // Paramètres décomposés par le même analyseur que le pilote pg du bot (dont la connexion
  // fonctionne déjà), passés en variables PG* : l'analyse d'URL de libpq est plus stricte, et le
  // mot de passe n'apparaît pas dans la liste des processus.
  const result = await run(pgDump, ['--format=custom', '--no-owner', `--file=${file}`], { ...env, ...pgEnv(url) });
  if (result === 'missing') {
    log.warn({ applied, total }, 'pg_dump introuvable : migrations appliquées sans sauvegarde préalable');
    return null;
  }
  if (result !== 'ok') {
    await rm(file, { force: true });
    throw new Error(`Sauvegarde avant migration impossible (${result}) : migrations non appliquées.`);
  }
  log.info({ file, applied, total }, 'Base sauvegardée avant migration');
  const old = (await readdir(dir)).filter((f) => f.startsWith('pre-migration-')).sort().reverse().slice(KEEP_BACKUPS);
  for (const f of old) await rm(join(dir, f), { force: true });
  return file;
}

/** Variables libpq équivalentes à une URL de connexion. */
export function pgEnv(url: string): Record<string, string> {
  const c = parseConnectionString(url);
  const out: Record<string, string> = {};
  if (c.host) out.PGHOST = c.host;
  if (c.port) out.PGPORT = String(c.port);
  if (c.user) out.PGUSER = c.user;
  if (c.password) out.PGPASSWORD = c.password;
  if (c.database) out.PGDATABASE = c.database;
  return out;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<'ok' | 'missing' | string> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], env });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-500)));
    child.on('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'ENOENT' ? 'missing' : err.message));
    // Toutes les lignes d'erreur : la première dit ce qui a échoué, la dernière seule n'est qu'un conseil.
    child.on('close', (code) => resolve(code === 0 ? 'ok' : `code ${code} : ${stderr.trim().replace(/\s*\n\s*/g, ' ')}`));
  });
}

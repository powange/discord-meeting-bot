import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, runMigrations } from '../src/db/client.js';
import { acquireInstanceLock, backupBeforeMigrations, migrationState } from '../src/db/startup.js';
import { freshDatabase } from './helpers/db.js';

const url = process.env.TEST_DATABASE_URL;
const log = pino({ level: 'silent' });

describe.skipIf(!url)('Démarrage : verrou d’instance et sauvegarde avant migration', () => {
  let dbUrl: string;
  let ctx: ReturnType<typeof createDb>;
  let dir: string;

  beforeAll(async () => {
    dbUrl = await freshDatabase(url!, 'startup');
    ctx = createDb(dbUrl);
    dir = await mkdtemp(join(tmpdir(), 'mr-startup-'));
  });
  afterAll(async () => {
    await ctx.pool.end();
    await rm(dir, { recursive: true, force: true });
  });

  it('une seule instance par base : la seconde abandonne', async () => {
    const first = await acquireInstanceLock(ctx.pool, log);
    const other = createDb(dbUrl);
    await expect(acquireInstanceLock(other.pool, log, 0)).rejects.toThrow(/autre instance/);
    first.release();
    await other.pool.end();
  });

  it('base neuve : rien à sauvegarder ; à jour : rien non plus', async () => {
    expect((await migrationState(ctx.pool)).applied).toBe(0);
    expect(await backupBeforeMigrations(ctx.pool, dbUrl, dir, log)).toBeNull();
    await runMigrations(ctx.db);
    const state = await migrationState(ctx.pool);
    expect(state.applied).toBe(state.total);
    expect(await backupBeforeMigrations(ctx.pool, dbUrl, dir, log)).toBeNull();
  });

  it('migrations en attente : sauvegarde faite, 5 gardées ; échec de pg_dump → arrêt', async () => {
    // Simule une version plus récente : la dernière migration n'est pas encore appliquée.
    await ctx.pool.query('delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations)');

    const fake = join(dir, 'fake-pg_dump.sh');
    await writeFile(fake, '#!/bin/sh\nfor a in "$@"; do case "$a" in --file=*) touch "${a#--file=}";; esac; done\n');
    await chmod(fake, 0o755);
    const backups = join(dir, 'backups');
    for (let i = 0; i < 7; i++) expect(await backupBeforeMigrations(ctx.pool, dbUrl, backups, log, fake)).toMatch(/pre-migration-.*\.dump$/);
    expect((await readdir(backups)).length).toBe(5);

    const failing = join(dir, 'failing.sh');
    await writeFile(failing, '#!/bin/sh\necho "server version mismatch" >&2\nexit 1\n');
    await chmod(failing, 0o755);
    await expect(backupBeforeMigrations(ctx.pool, dbUrl, backups, log, failing)).rejects.toThrow(/non appliquées/);
    // Sans pg_dump (développement) : on continue sans sauvegarde.
    expect(await backupBeforeMigrations(ctx.pool, dbUrl, backups, log, join(dir, 'absent'))).toBeNull();
  });
});

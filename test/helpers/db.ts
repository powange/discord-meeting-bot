import pg from 'pg';

/**
 * Base dédiée à un fichier de tests d'intégration (les fichiers tournent en parallèle et
 * réinitialisent leur base) : `<base>_<nom>`, recréée à vide sur le même serveur.
 */
export async function freshDatabase(baseUrl: string, name: string): Promise<string> {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  const db = `mbtest_${name}`;
  await admin.query(`drop database if exists ${db} with (force)`);
  await admin.query(`create database ${db}`);
  await admin.end();
  const url = new URL(baseUrl);
  url.pathname = `/${db}`;
  return url.toString();
}

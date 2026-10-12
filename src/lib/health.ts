import { createServer, type Server } from 'node:http';

export interface HealthStatus {
  discord: boolean;
  database: boolean;
}

/**
 * Serveur de santé interne (127.0.0.1, jamais publié) : 200 si Discord et la base répondent,
 * 503 sinon. Utilisé par le HEALTHCHECK Docker ; Portainer affiche alors l'état du conteneur.
 */
export function startHealthServer(port: number, check: () => Promise<HealthStatus>): Server {
  const server = createServer((req, res) => {
    if (req.url !== '/health') return void res.writeHead(404).end();
    const timeout = new Promise<HealthStatus>((resolve) => setTimeout(() => resolve({ discord: false, database: false }), 3000));
    Promise.race([check(), timeout])
      .catch(() => ({ discord: false, database: false }))
      .then((status) => {
        const ok = status.discord && status.database;
        res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify({ ok, ...status }));
      });
  });
  server.listen(port, '127.0.0.1');
  return server;
}

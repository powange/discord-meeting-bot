# discord-meeting-bot

Bot Discord auto-hébergé de gestion de réunions : planification dans un forum, inscriptions, ordre du jour, rappels, événements Discord natifs. L'enregistrement, la transcription, les résumés et l'archivage arrivent dans les phases suivantes.

Voir [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) pour la conception d'ensemble et le plan par phases.

## Phase 1 — Gestion des réunions

| Fonction | Détail |
|---|---|
| `/reunion creer` | Formulaire : titre, date et heure, durée, salon vocal, description. Crée un post dans le forum et un événement Discord. |
| Carte de réunion | Premier message du post, régénéré depuis la BDD : date (affichée dans le fuseau de chaque lecteur), salon, organisateur, réponses, ordre du jour. |
| Réponses | Boutons Présent / Peut-être / Absent, modifiables à tout moment. |
| Ordre du jour | **Ajouter un point** (formulaire titre + détail ; auteur enregistré). **Gérer l'ODJ** (organisateur ou gestionnaire) : monter, descendre, retirer, verrouiller. |
| Tags | `À venir` → `En cours` (à l'heure prévue) → `Terminée` / `Annulée`. |
| Rappels | J-1 et 15 min avant par défaut. Ils mentionnent les présents et les peut-être. Les membres d'un rôle choisi qui n'ont pas répondu peuvent être relancés. |
| `/reunion modifier` · `annuler` · `terminer` · `dupliquer` | À utiliser dans le post de la réunion. |
| Clôture auto | 2 h après la fin prévue si personne n'a clos la réunion. |
| `/config` | `forum`, `roles`, `rappels`, `general`, `voir`. Réservé à « Gérer le serveur ». |

Qui peut gérer une réunion ? Son organisateur, les membres du **rôle gestionnaire**, et ceux qui ont la permission **Gérer les événements**.

## 1. Créer l'application Discord

1. Sur https://discord.com/developers/applications, créer une application puis ouvrir l'onglet **Bot**.
2. Copier le token : c'est `DISCORD_TOKEN`.
3. Activer **Server Members Intent**. Il sert à relancer les membres d'un rôle qui n'ont pas répondu.
4. Inviter le bot sur le serveur avec ce lien (remplacer `CLIENT_ID`) :
   ```
   https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot+applications.commands&permissions=17892834888720
   ```
   Permissions demandées :
   - Gérer les salons, nécessaire pour créer les tags du forum
   - Voir les salons, Envoyer des messages, Envoyer des messages dans les fils
   - Gérer les fils, Intégrer des liens, Voir l'historique
   - Créer et gérer les événements
   - Se connecter, en prévision de la phase 2
5. Sur le serveur, créer un **salon forum** (ex. `#réunions`) et lancer `/config forum salon:#réunions`.

## 2. Développement local

```bash
cp .env.example .env                     # renseigner DISCORD_TOKEN
cp config/config.example.yaml config/config.yaml
# dans config.yaml, renseigner discord.commandGuildIds: ["<id du serveur de test>"]
# (les commandes apparaissent alors instantanément sur ce serveur)

docker compose -f compose.dev.yml up -d  # PostgreSQL sur localhost:5432
npm install
npm run dev                              # migrations auto + rechargement à chaud
```

Commandes utiles :

| Commande | Rôle |
|---|---|
| `npm test` | Tests unitaires |
| `docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=test postgres:17`<br>`TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/postgres npm test` | Ajoute les tests d'intégration SQL. **Ils vident la base visée** : toujours utiliser une base jetable comme ici. |
| `npm run typecheck` | Vérification des types |
| `npm run db:generate` | Génère une migration après modification de [src/db/schema.ts](src/db/schema.ts) |
| `npm run db:studio` | Explore la base (Drizzle Studio) |

### Scénario de test manuel

1. `/config forum` : les 4 tags apparaissent sur le forum.
2. `/config rappels delais:"5min, 2min"`, pour voir passer les rappels rapidement.
3. `/reunion creer` avec une date dans 8 minutes. Vérifier que le post, la carte et l'événement Discord sont créés.
4. Avec deux comptes, répondre (Présent / Peut-être) et ajouter des points à l'ordre du jour. La carte se met à jour en environ une seconde.
5. Avec **Gérer l'ODJ**, réordonner, retirer un point et verrouiller. Avec le second compte, vérifier que l'ajout est refusé.
6. Vérifier les rappels à H-5 et H-2 min, puis le passage du tag à « En cours » et de l'événement à « Actif » à l'heure prévue.
7. `/reunion terminer` dans le post : tag « Terminée », boutons désactivés, événement terminé.
8. Redémarrer le bot entre deux étapes. Les boutons et les échéances doivent continuer à fonctionner, car tout est en BDD.

## 3. Déploiement Portainer

L'image est construite par GitHub Actions et publiée sur `ghcr.io/powange/discord-meeting-bot` (tags `latest`, `sha-…` et versions `vX.Y.Z`). La stack se contente de la récupérer.

1. **Une seule fois** : après le premier build, ouvrir GitHub → *Packages* → `discord-meeting-bot` → *Package settings* et passer la visibilité en **Public**. Sinon, Portainer devra s'authentifier sur ghcr.io.
2. Dans Portainer : *Stacks* → *Add stack* → **Repository**.
   - Repository URL : `https://github.com/powange/discord-meeting-bot`
   - Compose path : `docker-compose.yml`
   - Variables d'environnement :
     - `DISCORD_TOKEN`
     - `POSTGRES_PASSWORD` (alphanumérique)
     - optionnelles : `LOG_LEVEL`, `BOT_TAG` (pour épingler une version, ex. `sha-abc1234`)
   - Activer **GitOps updates → Webhook** et cocher **Re-pull image**.
3. Redéploiement automatique : copier l'URL du webhook Portainer dans le secret GitHub `PORTAINER_WEBHOOK` du dépôt. Chaque push sur `main` déclenche alors tests → image → redéploiement.
4. Configuration avancée (surcharges par serveur) : déposer un `config.yaml` sur l'hôte, par exemple `/srv/meeting-bot/config/config.yaml`. Décommenter ensuite `CONFIG_PATH` et le volume dans [docker-compose.yml](docker-compose.yml).

Le bot n'expose aucun port : Nginx Proxy Manager n'est pas nécessaire. Les migrations s'appliquent au démarrage, et l'arrêt est propre sur `SIGTERM` : le scheduler s'arrête et les cartes en attente sont mises à jour.

### Sauvegarde

```bash
docker exec meeting-bot-postgres-1 pg_dump -U bot meetingbot > meetingbot-$(date +%F).sql
```

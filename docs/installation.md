# Installation

[← Retour au README](../README.md)

1. [Créer l'application Discord](#1-créer-lapplication-discord) et inviter le bot.
2. [Déployer la stack](#2-déployer-avec-portainer) (Portainer, ou `docker compose`).
3. Dans Discord : `/config` → Forum des réunions, puis les autres sections.
4. Facultatif : [transcription et résumé](ia.md), [stockage](stockage.md), [supervision et sauvegardes](exploitation.md).

## 1. Créer l'application Discord

1. Sur https://discord.com/developers/applications, créer une application (icône prête à l'emploi : [assets/app-icon.png](../assets/app-icon.png), 1024 × 1024 ; bannière : [assets/app-banner.png](../assets/app-banner.png), 1360 × 480, à déposer dans **Bot → Banner**), puis ouvrir l'onglet **Bot**.
2. Copier le token : c'est `DISCORD_TOKEN`.
3. Activer **Server Members Intent**. Il sert à relancer les membres d'un rôle qui n'ont pas répondu.
4. Inviter le bot sur le serveur avec ce lien (remplacer `CLIENT_ID`) :
   ```
   https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot+applications.commands&permissions=17893170474000
   ```
   Permissions demandées :
   - Gérer les salons, nécessaire pour créer les tags du forum
   - Gérer les rôles (appelée « Gérer les permissions » dans les réglages d'un salon), pour réserver au bot la création de posts dans le forum (`/config` → Forum des réunions, facultatif)
   - Voir les salons, Envoyer des messages, Envoyer des messages dans les fils
   - Gérer les fils, Gérer les messages (pour garder le post épinglé vide), Intégrer des liens, Joindre des fichiers (audio et transcription du compte rendu), Voir l'historique
   - Créer et gérer les événements
   - Se connecter (enregistrement)
   - Changer le pseudo : le bot s'appelle « 🔴 Enregistrement » pendant une capture
5. Sur le serveur, créer un **salon forum** (ex. `#réunions`) puis le choisir dans `/config` → Forum des réunions. Le bouton **🔒 Réserver la création de posts au bot** empêche ensuite les membres de créer des posts à la main ; ils peuvent toujours répondre dans les posts des réunions et utiliser les boutons. Un bot déjà invité avec l'ancien lien n'a pas cette permission. Le plus sûr est de la lui donner sur le forum seulement : forum → Modifier le salon → Permissions → ajouter le rôle du bot → « Gérer les permissions » ✅. (Au niveau du serveur, elle s'appelle « Gérer les rôles » et permettrait aussi au bot de modifier les rôles placés sous le sien.)

## 2. Déployer avec Portainer

L'image est construite par GitHub Actions et publiée sur `ghcr.io/powange/meeting-recorder`. La stack se contente de la récupérer.

| Tag | Mis à jour | Usage |
|---|---|---|
| `stable` | à chaque version publiée (`git tag v…`) | **production** (valeur par défaut de la stack) |
| `1.4.0` | une fois, à la publication de cette version | épingler une version, revenir en arrière |
| `latest` | à chaque push sur `main` | essais |
| `sha-abc1234` | à chaque build | retrouver un build précis |

1. L'image est publique (elle hérite de la visibilité du dépôt) : Portainer la récupère sans identifiants.
2. Dans Portainer : *Stacks* → *Add stack* → **Repository**.
   - Repository URL : `https://github.com/powange/meeting-recorder`
   - Compose path : `docker-compose.yml`
   - Variables d'environnement :
     - `DISCORD_TOKEN`
     - `POSTGRES_PASSWORD` (alphanumérique)
     - recommandée : `APP_SECRET_KEY` (phrase longue et aléatoire, chiffre les clés d'API et les jetons de stockage)
     - facultatives : `LOG_LEVEL`, `TZ`, `AI_ALLOWED_HOSTS`, `BOT_TAG` (`stable` par défaut ; `1.4.0` pour épingler une version), `COMPOSE_PROFILES` (`litellm`, `offsite`), `LITELLM_MASTER_KEY`, `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `ONEDRIVE_CLIENT_ID` / `DROPBOX_APP_KEY` ([stockage](stockage.md))
   - Activer **GitOps updates → Webhook** et cocher **Re-pull image**.
3. Redéploiement automatique : copier l'URL du webhook Portainer dans le secret GitHub `PORTAINER_WEBHOOK` du dépôt. Seule la **publication d'une version** redéploie : un push sur `main` construit l'image `latest` sans toucher à la production, ce qui évite de couper une réunion en cours.
   ```bash
   # version du package.json à jour, puis :
   git tag v1.4.0 && git push origin v1.4.0   # tests → image stable + 1.4.0 → redéploiement
   ```
   Choisir un moment sans réunion : le redéploiement interrompt un enregistrement en cours.
4. Configuration avancée (surcharges par serveur) : déposer un `config.yaml` sur l'hôte, par exemple `/srv/meeting-bot/config/config.yaml`. Décommenter ensuite `CONFIG_PATH` et le volume dans [docker-compose.yml](../docker-compose.yml). Modèle : [config/config.example.yaml](../config/config.example.yaml).

Le bot n'expose aucun port : Nginx Proxy Manager n'est pas nécessaire. Les migrations s'appliquent au démarrage, et l'arrêt est propre sur `SIGTERM` : le scheduler s'arrête et les cartes en attente sont mises à jour.

## Versions et retour arrière

- **Quelle version tourne ?** Le premier message du journal donne la version et le commit (`Démarrage de meeting-recorder`), puis l'application Discord connectée (`Connecté à Discord` : id et nom, pour repérer un token de prod utilisé en dev). `/health` les renvoie aussi.
- **Une seule instance par base** : un second bot pointé sur la même base (par exemple `npm run dev` avec l'URL de prod) attend 90 s puis s'arrête avec un message clair.
- **Sauvegarde avant migration** : quand une nouvelle version apporte des migrations, le bot fait d'abord un `pg_dump` dans `/data/backups/pre-migration-….dump` (volume `recordings`, 5 gardées). Si la sauvegarde échoue, il s'arrête sans migrer et le journal donne l'erreur de `pg_dump`. En dernier recours, la variable `MIGRATION_BACKUP=off` le laisse migrer sans sauvegarde (à retirer ensuite).
- **Revenir à la version précédente** : les migrations ne se défont pas. Arrêter la stack, restaurer la sauvegarde d'avant migration, puis redéployer avec `BOT_TAG=<version précédente>` :
  ```bash
  docker compose stop bot
  docker compose cp bot:/data/backups/pre-migration-<date>.dump ./avant.dump   # ou docker cp depuis le volume
  docker compose exec -T postgres pg_restore -U bot -d meetingbot --clean --if-exists < ./avant.dump
  ```

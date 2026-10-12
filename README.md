# discord-meeting-bot

Bot Discord auto-hébergé de gestion de réunions : planification dans un forum, inscriptions, ordre du jour, rappels, événements Discord natifs. L'enregistrement, la transcription, les résumés et l'archivage arrivent dans les phases suivantes.

Voir [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) pour la conception d'ensemble et le plan par phases.

## Phase 1 — Gestion des réunions

| Fonction | Détail |
|---|---|
| Post épinglé | Créé par `/config forum` : bouton **Nouvelle réunion** et liste chronologique des réunions à venir. Personne ne peut y écrire : tout message posté est supprimé (le post n'est pas verrouillé, sinon les membres ne pourraient plus cliquer). Le bot le surveille : supprimé (ou son message effacé), il est recréé aussitôt ; désépinglé, verrouillé ou archivé, il est rétabli ; vérification complète au démarrage puis toutes les 15 min. |
| `/reunion creer` | Même formulaire que le bouton : titre, jour (25 prochains jours), horaire (`18h` ou `18h-19h30`), salon vocal, description. Pour une date plus lointaine : `/reunion creer quand:15/01/2027 18h`. |
| Post de réunion | Titré `Lun. 12/10 · 18h00 · Titre`. Un événement Discord est créé en parallèle. |
| Carte de réunion | Premier message du post, régénéré depuis la BDD : date (affichée dans le fuseau de chaque lecteur), salon, organisateur, réponses, ordre du jour. |
| Réponses | Boutons Présent / Peut-être / Absent, modifiables à tout moment. |
| Ordre du jour | **Ajouter un point** (formulaire titre + détail ; auteur enregistré). **Gérer l'ODJ** (organisateur ou gestionnaire) : monter, descendre, retirer, verrouiller. |
| Tags | `À venir` → `En cours` (à l'heure prévue) → `Terminée` / `Annulée`. |
| Rappels | J-1 et 15 min avant par défaut. Ils mentionnent les présents et les peut-être. Les membres d'un rôle choisi qui n'ont pas répondu peuvent être relancés. |
| `/reunion modifier` · `annuler` · `terminer` · `dupliquer` | À utiliser dans le post de la réunion. |
| Clôture auto | **Uniquement quand le vocal est vide** depuis 5 min, compté depuis le départ de la dernière personne (ou depuis la fin prévue si personne n'est venu). Une réunion qui déborde n'est jamais coupée tant qu'il reste quelqu'un. |
| `/config` | `forum`, `vocal` (impose un salon vocal à toutes les réunions ; sans option, choix libre), `roles`, `rappels`, `general`, `voir`. Réservé à « Gérer le serveur ». |

Qui peut gérer une réunion ? Son organisateur, les membres du **rôle gestionnaire**, et ceux qui ont la permission **Gérer les événements**.

## Phase 2 — Enregistrement

| Fonction | Détail |
|---|---|
| Démarrer | Message **🎙️ Enregistrement** publié dans le post quand la réunion est « En cours » et qu'au moins une personne est dans le vocal, avec le bouton **🔴 Enregistrer** (organisateur ou gestionnaire). Il devient **⏹️ Arrêter** pendant l'enregistrement. |
| Automatique | `/reunion enregistrement-auto actif:True` dans le post, ou par défaut pour le serveur avec `/config general enregistrement-auto:True`. Le bot rejoint le vocal **2 min avant l'heure** (avant l'arrivée des participants, ce qui contourne un bug connu de DAVE), avec un rattrapage à l'heure de début s'il était éteint. |
| Pendant | Le bot est dans le vocal, micro coupé. Avertissement dans le post et dans le chat du vocal. La carte affiche « Enregistrement en cours ». |
| Pistes | Un fichier OGG/Opus 48 kHz par prise de parole et par personne, sans réencodage, horodaté en base. Pas besoin de diarisation. |
| Opt-out | Rôle « ne pas m'enregistrer » (`/config roles ne-pas-enregistrer:`). Chacun peut le prendre ou le rendre avec `/enregistrement refuser` / `accepter`. La présence est notée, pas la voix. |
| Fin | Bouton Arrêter, `/reunion terminer`, ou clôture automatique de la réunion (vocal vide depuis 5 min). |
| Bilan | Message silencieux dans le post : durée, personnes enregistrées, prises de parole, inscrits présents, inscrits absents, venus sans inscription, non enregistrés. |
| Coupures | Une coupure réseau ou un redémarrage du bot arrête proprement l'enregistrement. Le bilan propose **🔴 Reprendre l'enregistrement**, qui ouvre une nouvelle session ; les pistes déjà captées sont conservées. |

Contrainte Discord : un bot ne peut être que dans **un vocal par serveur** à la fois, donc un seul enregistrement par serveur.

Les pistes sont écrites dans `dataDir/recordings/<serveur>/<session>/<utilisateur>/`, soit le volume `recordings` en Docker. Compter environ 1 Mo par 10 minutes de parole et par personne. Le transfert vers le NAS et Drive arrive en phase 4.

**Écouter une session (debug)** : `npx tsx --env-file=.env scripts/assemble.ts <recordingId>`. Le script reconstitue une piste continue par participant et un mix dans `…/<session>/assembled/` ; il nécessite ffmpeg. L'id de session se trouve dans la table `recordings` (`npm run db:studio`).

### Tester la phase 2

1. Activer **Server Members Intent** (déjà requis), et vérifier que le bot voit le salon vocal et peut s'y connecter.
2. Optionnel : `/config roles ne-pas-enregistrer:@NePasEnregistrer`, puis placer ce rôle sous celui du bot.
3. Créer une réunion dans quelques minutes et rejoindre le vocal à deux. À l'heure prévue, le message **🎙️ Enregistrement** apparaît : cliquer **🔴 Enregistrer**.
4. Parler à tour de rôle, faire `/enregistrement refuser` avec un compte et vérifier que sa voix n'est plus captée.
5. **⏹️ Arrêter l'enregistrement** dans ce message : vérifier le bilan dans le post, puis écouter avec `scripts/assemble.ts`.
6. Tester l'automatique : `/reunion enregistrement-auto actif:True` sur une réunion dans 5 min. Le bot arrive à H-2.
7. Rester au-delà de l'heure de fin : rien ne se coupe. Puis quitter le vocal : 5 min après, la réunion est close et l'enregistrement s'arrête.

## 1. Créer l'application Discord

1. Sur https://discord.com/developers/applications, créer une application puis ouvrir l'onglet **Bot**.
2. Copier le token : c'est `DISCORD_TOKEN`.
3. Activer **Server Members Intent**. Il sert à relancer les membres d'un rôle qui n'ont pas répondu.
4. Inviter le bot sur le serveur avec ce lien (remplacer `CLIENT_ID`) :
   ```
   https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot+applications.commands&permissions=17893103332368
   ```
   Permissions demandées :
   - Gérer les salons, nécessaire pour créer les tags du forum
   - Voir les salons, Envoyer des messages, Envoyer des messages dans les fils
   - Gérer les fils, Gérer les messages (pour garder le post épinglé vide), Intégrer des liens, Voir l'historique
   - Créer et gérer les événements
   - Se connecter (enregistrement)
   - Gérer les rôles : uniquement pour `/enregistrement refuser|accepter`. Le rôle « ne pas m'enregistrer » doit être placé **sous** le rôle du bot.
5. Sur le serveur, créer un **salon forum** (ex. `#réunions`) et lancer `/config forum salon:#réunions`.

> Discord ne sait pas trier les posts d'un forum selon la date de la réunion : seulement par activité récente ou par date de création. L'ordre chronologique se lit dans le post épinglé.

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

1. L'image est publique (elle hérite de la visibilité du dépôt) : Portainer la récupère sans identifiants.
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

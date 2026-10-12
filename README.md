# discord-meeting-bot

Bot Discord auto-hébergé de gestion de réunions : planification dans un forum, inscriptions, ordre du jour, rappels, événements Discord natifs. L'enregistrement, la transcription, les résumés et l'archivage arrivent dans les phases suivantes.

Voir [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) pour la conception d'ensemble et le plan par phases.

## Phase 1 — Gestion des réunions

| Fonction | Détail |
|---|---|
| Post épinglé | Créé quand on choisit le forum dans `/config` : bouton **Nouvelle réunion** et liste chronologique des réunions à venir. Personne ne peut y écrire : tout message posté est supprimé (le post n'est pas verrouillé, sinon les membres ne pourraient plus cliquer). Le bot le surveille : supprimé (ou son message effacé), il est recréé aussitôt ; désépinglé, verrouillé ou archivé, il est rétabli ; vérification complète au démarrage puis toutes les 15 min. |
| `/reunion creer` | Même formulaire que le bouton : titre, jour (25 prochains jours), horaire (`18h` ou `18h-19h30`), salon vocal, description. Pour une date plus lointaine : `/reunion creer quand:15/01/2027 18h`. |
| Post de réunion | Titré `Lun. 12/10 · 18h00 · Titre`. Un événement Discord est créé en parallèle. |
| Carte de réunion | Premier message du post, régénéré depuis la BDD : date (affichée dans le fuseau de chaque lecteur), salon, organisateur, réponses, ordre du jour. |
| Réponses | Boutons Présent / Peut-être / Absent, modifiables à tout moment. |
| Ordre du jour | **Ajouter un point** (formulaire titre + détail ; auteur enregistré). **Gérer l'ODJ** (organisateur ou gestionnaire) : monter, descendre, retirer, verrouiller. |
| Tags | `À venir` → `En cours` (à l'heure prévue) → `Terminée` / `Annulée`. |
| Rappels | J-1 et 15 min avant par défaut. Ils mentionnent les présents et les peut-être. Les membres d'un rôle choisi qui n'ont pas répondu peuvent être relancés. |
| `/reunion modifier` · `annuler` · `terminer` · `dupliquer` | À utiliser dans le post de la réunion. |
| Clôture auto | **Uniquement quand le vocal est vide** depuis 5 min, compté depuis le départ de la dernière personne (ou depuis la fin prévue si personne n'est venu). Une réunion qui déborde n'est jamais coupée tant qu'il reste quelqu'un. |
| `/config` | Une seule commande, réservée à « Gérer le serveur », qui ouvre un **panneau interactif**. L'accueil résume tous les réglages ; un menu ouvre chaque section : Forum, Salon vocal (imposé ou libre), Rôles, Rappels, Général (fuseau, durée, création), Enregistrement auto, Transcription. Les réglages se font avec des sélecteurs de salon et de rôle, des boutons et de petits formulaires. |

Qui peut gérer une réunion ? Son organisateur, les membres du **rôle gestionnaire**, et ceux qui ont la permission **Gérer les événements**.

## Phase 2 — Enregistrement

| Fonction | Détail |
|---|---|
| Démarrer | Message **🎙️ Enregistrement** publié dans le post quand la réunion est « En cours » et qu'au moins une personne est dans le vocal, avec le bouton **🔴 Enregistrer** (organisateur ou gestionnaire). Il devient **⏹️ Arrêter** pendant l'enregistrement. |
| Automatique | `/reunion enregistrement-auto actif:True` dans le post, ou par défaut pour le serveur dans `/config` → Enregistrement. Le bot rejoint le vocal **2 min avant l'heure** (avant l'arrivée des participants, ce qui contourne un bug connu de DAVE), avec un rattrapage à l'heure de début s'il était éteint. |
| Pendant | Le bot est dans le vocal, micro coupé. Avertissement dans le post et dans le chat du vocal. La carte affiche « Enregistrement en cours ». |
| Pistes | Un fichier OGG/Opus 48 kHz par prise de parole et par personne, sans réencodage, horodaté en base. Pas besoin de diarisation. |
| Opt-out | Rôle « ne pas m'enregistrer » (`/config` → Rôles). Chacun peut le prendre ou le rendre avec `/enregistrement refuser` / `accepter`. La présence est notée, pas la voix. |
| Fin | Bouton Arrêter, `/reunion terminer`, ou clôture automatique de la réunion (vocal vide depuis 5 min). |
| Bilan | Message silencieux dans le post. Il signale « ⚠️ audio possiblement incomplet » quand une part notable des paquets d'une personne n'a pas pu être déchiffrée (DAVE) ; `recording.debugVoice: true` journalise les détails de la connexion vocale. Il indique aussi : durée, personnes enregistrées, prises de parole, inscrits présents, inscrits absents, venus sans inscription, non enregistrés. |
| Coupures | Une coupure réseau ou un redémarrage du bot arrête proprement l'enregistrement. Le bilan propose **🔴 Reprendre l'enregistrement**, qui ouvre une nouvelle session ; les pistes déjà captées sont conservées. |

Contrainte Discord : un bot ne peut être que dans **un vocal par serveur** à la fois, donc un seul enregistrement par serveur.

**Conservation** : une purge quotidienne (4 h 17) supprime les fichiers locaux selon `retention` dans le YAML, réglable par serveur :
- les prises de parole brutes 30 jours après la réunion, seulement si celle-ci est close et que l'audio complet et la transcription sont faits ;
- l'audio complet au bout d'un an.

Les copies publiées dans Discord restent. Une alerte est émise si l'espace libre passe sous `diskMinFreeGb`.

Les pistes sont écrites dans `dataDir/recordings/<serveur>/<session>/<utilisateur>/`, soit le volume `recordings` en Docker. Compter environ 1 Mo par 10 minutes de parole et par personne. Le transfert vers le NAS et Drive arrive en phase 4.

**Écouter une session (debug)** : `npx tsx --env-file=.env scripts/assemble.ts <recordingId>`. Le script reconstitue une piste continue par participant et un mix dans `…/<session>/assembled/` ; il nécessite ffmpeg. L'id de session se trouve dans la table `recordings` (`npm run db:studio`).

### Tester la phase 2

1. Activer **Server Members Intent** (déjà requis), et vérifier que le bot voit le salon vocal et peut s'y connecter.
2. Optionnel : choisir le rôle « ne pas m'enregistrer » dans `/config` → Rôles, puis placer ce rôle sous celui du bot.
3. Créer une réunion dans quelques minutes et rejoindre le vocal à deux. À l'heure prévue, le message **🎙️ Enregistrement** apparaît : cliquer **🔴 Enregistrer**.
4. Parler à tour de rôle, faire `/enregistrement refuser` avec un compte et vérifier que sa voix n'est plus captée.
5. **⏹️ Arrêter l'enregistrement** dans ce message : vérifier le bilan dans le post, puis écouter avec `scripts/assemble.ts`.
6. Tester l'automatique : `/reunion enregistrement-auto actif:True` sur une réunion dans 5 min. Le bot arrive à H-2.
7. Rester au-delà de l'heure de fin : rien ne se coupe. Puis quitter le vocal : 5 min après, la réunion est close et l'enregistrement s'arrête.

## Phase 3 — Transcription et compte rendu

| Fonction | Détail |
|---|---|
| Déclenchement | À l'**arrêt de l'enregistrement** : l'audio arrive en quelques secondes. Un nouvel enregistrement dans la même réunion met tout à jour au prochain arrêt (audio refait avec toutes les sessions, seuls les nouveaux passages transcrits, compte rendu remplacé). Une session coupée par une déconnexion ou un redémarrage ne déclenche rien, pour laisser la place à une reprise : elle est traitée à la clôture de la réunion. Une réunion à la fois. |
| Audio complet | Première étape : toutes les prises de parole replacées sur une même ligne de temps, autrement dit ce que tout le monde a entendu, en **Opus mono**, publiées aussitôt dans le post avec le lecteur Discord. Le débit est ajusté pour tenir dans la limite d'envoi du serveur (10, 50 ou 100 Mo selon le boost, ≈ 55 min sans boost). Au-delà, l'audio est **découpé en parties** (jusqu'à 10, au moins 24 kbps), publiées une par message avec leurs repères de temps. Au-delà de 10 parties, il est conservé sur le serveur (`dataDir/meetings/…`). L'audio est publié même si la transcription échoue. |
| Suivi | Message **📝 Compte rendu** dans le post : ⬜ ⏳ ✅ ❌ par étape, avec la progression (blocs transcrits, passes de résumé). |
| Transcription | Prises de parole regroupées en blocs par personne, assemblées en WAV 16 kHz par ffmpeg, puis envoyées au **premier backend disponible** de `transcription.backends`. Health check court, puis bascule au suivant en cas d'erreur, de délai dépassé ou de « occupé » (Vibe ne traite qu'une requête à la fois). Les hallucinations connues de Whisper sont filtrées, ainsi que les **échos** : la même phrase captée par le micro d'un voisin sans casque n'est gardée qu'une fois (`transcription.dropEchoes`). Pas de diarisation nécessaire : chaque piste a son auteur. |
| Résumé | **Facultatif** : sans modèle configuré, l'étape est sautée (⏭️) et le compte rendu se limite à l'audio et à la transcription. Avec un modèle, via LiteLLM, Ollama ou LM Studio. Structuré **par point d'ordre du jour** : synthèse, décisions, actions (qui / échéance), questions ouvertes, sujets hors ODJ, points non traités. Une réunion longue est résumée **en plusieurs passes** (morceaux, puis fusion). |
| Publication | Compte rendu en Components V2, découpé sur plusieurs messages si besoin, avec la **transcription complète en `.md`** jointe. Les responsables d'actions reconnus sont mentionnés, donc notifiés. La trace des modèles utilisés est en pied de message. |
| Échec | L'étape passe en ❌ avec l'erreur et un bouton **🔁 Relancer** (organisateur ou gestionnaire) : seule l'étape en échec et les suivantes sont refaites, les blocs déjà transcrits sont conservés. Un arrêt du bot reprend au démarrage. |
| Régénérer | `/reunion compte-rendu` dans le post (résumé et publication), avec `retranscrire:True` pour tout refaire. L'ancien compte rendu est remplacé. |

### Mettre en place l'IA

1. **Vibe** sur le PC GPU : télécharger `vibe-server` (releases `server-v*` de [thewh1teagle/vibe](https://github.com/thewh1teagle/vibe/releases)) et un modèle (`vibe-server pull <url>`, par exemple `ggml-large-v3-turbo.bin`), puis lancer :
   ```
   vibe-server serve C:\models\ggml-large-v3-turbo.bin --host 0.0.0.0 --port 8080 --exit-with-parent false
   ```
   Pour qu'il démarre avec Windows, en faire un service, avec NSSM par exemple. Vibe n'a **ni authentification ni TLS** : l'exposer uniquement sur le LAN ou Tailscale. Vérifier depuis le serveur : `curl http://pc-main.tailnet:8080/ready`.
2. **Secours** (optionnel) : un serveur compatible OpenAI (speaches / faster-whisper) sur une autre machine, ajouté après Vibe dans la liste.
3. **Ollama** (ou LM Studio) avec un modèle de résumé, par exemple `ollama pull qwen3:14b`. Avec 16 Go de VRAM partagés avec Whisper, garder un `keep_alive` court côté Ollama et `--unload-timeout` côté Vibe.
4. **LiteLLM** : copier [config/litellm.example.yaml](config/litellm.example.yaml) sur l'hôte (`/srv/meeting-bot/litellm.yaml`), et ajouter `LITELLM_MASTER_KEY` dans les variables de la stack. Sans LiteLLM, définir `LLM_BASE_URL=http://hôte-ollama:11434/v1` et `LLM_MODEL=qwen3:14b`.
5. **Serveurs de transcription** : `/config` → Transcription. **Seuls les propriétaires du bot peuvent modifier la liste** : le propriétaire de l'application Discord, plus la liste `owners` du YAML. Les administrateurs des serveurs peuvent consulter et tester. Avec `ai.allowedHosts`, le bot n'appelle que les hôtes autorisés (par exemple `*.tailnet.ts.net`, `192.168.1.0/24`), et il ne suit jamais une redirection.
   - **Ajouter** un serveur, jusqu'à 4, avec un formulaire : nom, type Vibe ou compatible OpenAI, URL, modèle, clé d'API.
   - **Gérer chaque serveur** avec ses boutons : ✏️ Modifier · ⬆️ Monter · ⏸️ Désactiver / ▶️ Activer · 🧪 Tester · 🗑️ Supprimer (avec confirmation). L'ordre de la liste est l'ordre de bascule.
   - **Tester** : un vrai essai (santé, puis transcription d'une seconde de silence), avec la latence affichée sous le serveur. Un test est aussi lancé automatiquement après chaque ajout ou modification.
   - **Clés d'API** : stockées en base, jamais réaffichées. En modification, laisser le champ vide conserve la clé, « - » la supprime.
   - Tant qu'aucun serveur n'est ajouté ici, la section `transcription.backends` du YAML s'applique.

### Tester la phase 3

- **En local** : configurer `transcription` et `llm` dans `config/config.yaml`. ffmpeg est fourni par `ffmpeg-static`. Faire une réunion enregistrée, puis la clore avec `/reunion terminer`.
- **Sur une réunion déjà enregistrée** : `/reunion compte-rendu` dans son post.
- **Tests automatiques** : `TEST_DATABASE_URL=… npm test` lance aussi un test de bout en bout : vraies pistes OGG, ffmpeg, bascule entre serveurs simulés, LLM simulé, relance et reprise.

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
5. Sur le serveur, créer un **salon forum** (ex. `#réunions`) puis le choisir dans `/config` → Forum des réunions.

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

1. `/config` → Forum des réunions : les 4 tags et le post épinglé apparaissent sur le forum.
2. `/config` → Rappels → « 5min, 2min », pour voir passer les rappels rapidement.
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

### Supervision et sauvegarde

- **Santé** : le conteneur du bot a un `HEALTHCHECK` (connexion à Discord et à la base). Portainer l'affiche « healthy » ou « unhealthy ».
- **Alertes** : `/config` → Alertes. Choisir un salon réservé aux administrateurs. Le bot y signale un compte rendu en échec, un enregistrement coupé ou un disque presque plein, au plus une fois par heure et par cause.
- **Sauvegarde automatique** : le service `backup` de la stack fait un `pg_dump` compressé chaque jour dans le volume `backups`, conservé 14 jours (`BACKUP_KEEP_DAYS`).
- **Restaurer** :
  ```bash
  docker compose stop bot
  gunzip -c meetingbot-AAAA-MM-JJ-HHMM.sql.gz | docker exec -i meeting-bot-postgres-1 psql -U bot -d meetingbot
  docker compose start bot
  ```
  Pour une base vide : la recréer avant l'import (`dropdb`/`createdb`). Les fichiers audio sont dans le volume `recordings`, à sauvegarder séparément si besoin.

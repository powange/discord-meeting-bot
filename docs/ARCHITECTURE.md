# Bot réunions — proposition d'architecture

> Statut : **phases 1 à 3 livrées**. Doc des libs vérifiée le 2026-10-12.
>
> Écarts entre cette proposition et l'implémentation de la phase 1 :
> - **npm** au lieu de pnpm (pas de pnpm dans l'environnement ; aucun impact fonctionnel).
> - Config YAML : les réglages initiaux d'un serveur sont sous `defaults.seed` / `guilds.<id>.seed`. Les blocs `transcription`, `llm`, `storage` et `retention` arriveront avec leur phase.
> - Création et modification d'une réunion via un **formulaire** (modal avec sélecteur de salon vocal) plutôt que par options de commande.
> - Les points d'ODJ retirés sont supprimés, sans suppression logique (`removed_at`).
> - `scheduled_jobs.kind` vaut `reminder | start | auto_end` en phase 1. La relance des non-répondants accompagne chaque rappel et cible un rôle choisi (`nudge_role_id`).
> - Toutes les tables du schéma ci-dessous n'existent pas encore : chaque phase ajoute les siennes par migration.
>
> Écarts de la phase 2 :
> - **Pas de prism-media** : sa version 2 (seule à écrire de l'OGG) exige `node-crc`, un module natif. Un muxer OGG/Opus d'environ 150 lignes ([src/recording/ogg.ts](../src/recording/ogg.ts)) le remplace. Il comble aussi les courtes pauses au sein d'une prise de parole par des trames de silence, ce qui garde la durée fidèle.
> - Plusieurs sessions d'enregistrement par réunion (reprise après coupure) : `recordings` → `recording_presence`, `audio_segments`. `lost_packets` n'existe pas : les paquets que DAVE n'arrive pas à déchiffrer sont jetés sans signal par la lib.
> - Paramètres techniques dans le YAML (`recording.autoJoinLeadMin`, `endWhenEmptyMin`, `silenceMs`, `decryptionFailureTolerance`), avec la même surcharge par serveur que le reste.
> - Clôture automatique d'une réunion **uniquement sur vocal vide** (MeetingWatcher), jamais sur l'heure de fin.
>
> Écarts de la phase 3 :
> - Traitement **par réunion** (et non par session d'enregistrement) : toutes les sessions d'une réunion sont transcrites ensemble. Étapes `mix → transcribe → summarize → publish → export` ; `export` copie compte rendu, transcription et audio vers le stockage connecté par le serveur (`guild_storage` : Google Drive, OneDrive ou Dropbox, jetons OAuth chiffrés), sautée sans stockage.
> - Transcription par **blocs** (prises de parole proches d'une même personne, ≤ 5 min) : moins de requêtes, plus de contexte, peu de silence. Table `transcription_blocks` pour la reprise fine.
> - Client LLM en `fetch` direct (pas de SDK) pour lire les en-têtes LiteLLM (`x-litellm-model-id`). Mode JSON validé par zod, avec une correction automatique si le JSON est invalide.
> - Publication en **Components V2** (et non en embeds) : 4000 caractères de texte par message, découpage par sujet.

## 0. Décisions actées

| Sujet | Choix |
|---|---|
| Portée | Multi-serveurs |
| Config | **Tout par serveur** (Discord *et* infra : backends IA, stockages, rétention) |
| ORM | Drizzle (+ drizzle-kit pour les migrations SQL versionnées) |
| Consentement | Opt-out par rôle + avertissement à chaque démarrage |
| Récurrence | Non en v1 (bouton « Dupliquer ») |
| Audio | OGG/Opus **48 kHz stéréo natif**, sans réencodage |
| Langue | FR, i18n prêt (langue de transcription/résumé par serveur) |
| Démarrage enreg. | Manuel + auto optionnel par réunion |

## 1. Ce que la vérification de la doc change

### @discordjs/voice + DAVE
- Version stable : **0.19.2** (mars 2026). DAVE depuis 0.19.0 ; `@snazzah/davey` est une dépendance directe depuis 0.19.1. **Node ≥ 22.12** → image `node:24-bookworm-slim`.
- Discord n'accepte plus que les appels E2EE depuis le 1er mars 2026 : `daveEncryption` doit rester à `true` (défaut).
- `joinVoiceChannel({ selfDeaf: false, selfMute: true, decryptionFailureTolerance })` ; intents `Guilds` + `GuildVoiceStates`.
- `receiver.subscribe()` renvoie des **paquets Opus 48 kHz / 2 canaux / 20 ms**. Pour les écrire en OGG sans réencodage, il faut `prism.opus.OggLogicalBitstream`, présent **uniquement dans `prism-media@2.0.0-alpha.0`** (à ajouter explicitement). `@discordjs/opus` n'est pas nécessaire pour l'enregistrement.
- **La réception reste fragile** (« it may work », d'après les mainteneurs) :
  - les paquets que DAVE n'arrive pas à déchiffrer sont **jetés en silence** ;
  - le ticket ouvert [#11653](https://github.com/discordjs/discord.js/issues/11653) : quand le bot rejoint un vocal **où des gens sont déjà présents**, ce qui est exactement notre cas, le flux d'un utilisateur peut lever une erreur et être détruit ;
  - le compteur d'échecs est partagé entre tous les utilisateurs.
- Discord n'envoie rien pendant les silences, et l'horodatage RTP n'est pas exposé : l'alignement se fait à l'horloge murale.

**Conséquence de conception** : l'enregistrement brut se fait **par prise de parole** (un petit fichier OGG par segment, avec son début et sa fin en ms relatifs au début de l'enregistrement, stockés en BDD), plutôt qu'en une piste continue par utilisateur.
- Si un flux est détruit, on se réabonne et on ne perd que le segment en cours.
- Il n'y a pas de dérive temporelle.
- On n'envoie pas de longs silences à Whisper, qui a tendance à halluciner dessus.

La **piste continue par utilisateur** (48 kHz, OGG) est reconstruite au traitement avec ffmpeg (`adelay` + `amix`) et c'est elle qu'on archive. Les présents déclarés ne font jamais rejoindre le bot en avance. Par contre, en démarrage auto, le bot peut rejoindre le salon à H-2 min, avant l'arrivée des participants, ce qui contourne le bug #11653.

### Vibe
- Le mode serveur est désormais un **binaire séparé `vibe-server`** (releases `server-v*`) :
  `vibe-server serve C:\models\ggml-large-v3-turbo.bin --host 0.0.0.0 --port 8080 --exit-with-parent false`
- `POST /v1/audio/transcriptions` en multipart, compatible OpenAI. `response_format=verbose_json` renvoie `segments[{start,end,text}]`. Swagger sur `/docs`, `GET /health`, `GET /ready` (503 si aucun modèle n'est chargé).
- **Une seule transcription à la fois** : une deuxième requête reçoit immédiatement un **429 `busy`**, sans file d'attente.
- **Pas d'authentification ni de TLS** : à réserver au LAN ou à Tailscale.
- Le modèle est un chemin **sur la machine Vibe** ; le champ `model` de la requête est ignoré.
- Erreur `gpu_out_of_memory` possible si Ollama occupe déjà la VRAM du même PC → utiliser `--unload-timeout`.

→ Les backends `openai` et `vibe` partagent le client multipart. Ils diffèrent par le health check (`/ready` contre `/v1/models`), la gestion du 429 (on passe au backend suivant ou on réessaie avec backoff) et une concurrence côté bot fixée à **1 par backend Vibe**.

### LiteLLM
- Image `ghcr.io/berriai/litellm:<version épinglée>`, **sans Postgres** (pas besoin de l'UI ni des clés virtuelles).
- Plusieurs déploiements sous le même `model_name` assurent la répartition ; `router_settings.fallbacks` assure le repli vers un modèle plus petit. Ajouter `background_health_checks`.
- **Traçabilité** : les en-têtes `x-litellm-model-id` (= `model_info.id`, à définir explicitement), `x-litellm-model-group` et `x-litellm-attempted-fallbacks` sont stockés avec le résumé.

### rclone
- `rclone/rclone` lancé en `rcd --rc-addr :5572 --rc-user … --rc-pass …`. Monter **tout le dossier** `/config/rclone` en écriture (rclone réécrit les tokens Drive).
- L'upload passe par un volume partagé `/data` entre le bot et rclone, puis `operations/copyfile` avec `srcFs:"/"` et `_async:true` suivi de `job/status`.
- Les liens se font avec `operations/publiclink` : **OK pour Drive**, **non supporté en SFTP/WebDAV**. D'où l'API Synology.

### Synology
- **Correction** : utiliser `SYNO.FileStation.Sharing` / `create`, qui est documentée. `SYNO.Core.Sharing` est une API interne de l'UI.
- Login via `SYNO.API.Auth` → `sid`. Créer un utilisateur DSM dédié, sans 2FA, limité aux dossiers concernés.
- Les noms de paramètres et les versions exactes seront **vérifiés contre le PDF officiel** en phase 4, avant implémentation.
- `date_expired` sur le partage, aligné sur la rétention.

## 2. Arborescence

```
.
├── docker-compose.yml            # bot, postgres, litellm, rclone
├── Dockerfile                    # node:24-bookworm-slim + ffmpeg, build multi-stage
├── .github/workflows/image.yml   # build → ghcr.io (la stack Portainer tire l'image)
├── config/
│   ├── config.example.yaml
│   └── litellm.example.yaml
├── drizzle.config.ts
├── drizzle/                      # migrations SQL générées (versionnées)
├── src/
│   ├── index.ts                  # bootstrap : config → db/migrate → client → scheduler → workers
│   ├── config/                   # chargement YAML, interpolation ${ENV}, schéma zod, merge defaults←guild
│   ├── db/  schema.ts, client.ts, repositories/
│   ├── i18n/  fr.ts, index.ts    # t('rsvp.yes'), localisations des commandes
│   ├── discord/
│   │   ├── client.ts, deploy-commands.ts
│   │   ├── commands/             # reunion.ts, config.ts, enregistrement.ts
│   │   ├── interactions/         # router par préfixe de customId (rsvp:, agenda:, rec:, job:)
│   │   ├── customId.ts           # encode/décode typé + versionné
│   │   ├── embeds/               # meeting-card.ts, summary.ts, split.ts (limites Discord)
│   │   └── forum.ts, scheduled-event.ts, permissions.ts
│   ├── domain/                   # LOGIQUE PURE, testée sans Discord ni BDD
│   │   ├── meeting.ts            # transitions d'état
│   │   ├── rsvp.ts, agenda.ts    # règles, réordonnancement, verrou
│   │   └── reminders.ts          # calcul des échéances
│   ├── scheduler/                # tick node-cron (30 s) → échéances dues en BDD
│   ├── recording/                # (phase 2) session vocale, segments OGG, présence réelle
│   ├── pipeline/                 # (phase 3-4) runner d'étapes reprenable
│   │   ├── runner.ts, steps/{transcribe,summarize,mix,upload,publish}.ts
│   ├── ai/
│   │   ├── transcription/  backend.ts, openai.ts, vibe.ts, failover.ts
│   │   └── llm/  litellm.ts, summarize.ts (map-reduce), prompts/
│   ├── storage/  rclone.ts, links/{rclone-link,synology}.ts, retention.ts
│   └── lib/  logger.ts (pino), errors.ts, ffmpeg.ts, semaphore.ts
└── test/                         # vitest : domain/*, embeds/split, ai/failover, config
```

## 3. Configuration

**Principe** : deux sources, chacune pour ce qu'elle sait faire.
- **YAML + env** pour l'infra par serveur : backends, stockages, rétention, modèles. C'est l'hébergeur qui la contrôle, et elle contient des secrets.
- **BDD via `/config`** pour les réglages Discord : forum, rôles, rappels, fuseau, langue. Un admin du serveur doit pouvoir les changer sans toucher au déploiement.

Un bloc `defaults` est fusionné en profondeur avec `guilds.<id>`. Un serveur absent du YAML hérite des `defaults`.

```yaml
# config/config.yaml — secrets via ${VAR}, jamais en clair
discord:
  token: ${DISCORD_TOKEN}
  clientId: "123456789012345678"
database:
  url: ${DATABASE_URL}
paths:
  data: /data                     # volume partagé avec rclone
logLevel: info

defaults:
  recording:
    decryptionFailureTolerance: 48
    endWhenEmptyAfter: 5m
    autoJoinLead: 2m
  transcription:
    language: fr
    backends:                     # ordre = priorité
      - { name: pc-main, type: vibe,   url: http://pc-main.tailnet:8080, timeout: 30m, healthTimeout: 3s }
      - { name: pc-amd,  type: vibe,   url: http://mini-amd.tailnet:8080, timeout: 60m }
      - { name: speaches, type: openai, url: http://pc-main.tailnet:8000/v1, model: Systran/faster-whisper-large-v3, apiKey: ${SPEACHES_KEY:-} }
  llm:
    baseUrl: http://litellm:4000/v1
    apiKey: ${LITELLM_MASTER_KEY}
    model: summary                # model_name LiteLLM
    chunkTokens: 6000
  storage:
    pathTemplate: "{guild}/{yyyy}/{yyyy}-{mm}-{dd}-{slug}"
    destinations:                 # toutes reçoivent une copie ; la 1re = lien principal
      - { name: NAS, remote: "nas:reunions", link: { type: synology, url: https://nas.local:5001, user: ${SYNO_USER}, password: ${SYNO_PASS} } }
      - { name: Drive, remote: "gdrive:Réunions", link: { type: rclone } }
  retention:
    tracks: 30d
    mix: 365d
    transcript: forever

guilds:
  "111111111111111111":
    storage:
      destinations:
        - { name: Drive, remote: "gdrive:AssoX", link: { type: rclone } }
```

En BDD, réglé via `/config` : salon forum (le bot y crée ou retrouve les 4 tags et mémorise leurs IDs), rôle gestionnaire, rôle opt-out, fuseau, locale, décalages de rappel (`[1440, 15]`), relance des non-répondants, démarrage auto par défaut.

## 4. Schéma de BDD (Drizzle / PostgreSQL)

```
guild_settings      guild_id PK, forum_channel_id, tag_ids jsonb{upcoming,live,ended,cancelled},
                    manager_role_id, optout_role_id, timezone, locale,
                    reminder_offsets_min int[], nudge_non_responders bool, auto_record_default bool

meetings            id uuid PK, guild_id, thread_id UQ, card_message_id, scheduled_event_id,
                    voice_channel_id, title, description, starts_at timestamptz, duration_min,
                    organizer_id, status enum(scheduled|live|ended|cancelled),
                    auto_record bool, agenda_locked bool, created_at, updated_at

rsvps               (meeting_id, user_id) PK, status enum(yes|maybe|no), updated_at

agenda_items        id PK, meeting_id FK, position int, title, detail, author_id,
                    created_at, removed_at          -- suppression logique, position ré-indexée

scheduled_jobs      id PK, meeting_id FK, kind enum(reminder|nudge|auto_start|event_sync|retention),
                    due_at, payload jsonb, done_at, attempts, last_error,
                    UQ(meeting_id, kind, payload->>'offset')   -- idempotent au redémarrage

recordings          id uuid PK, meeting_id FK, started_at, ended_at, started_by,
                    status enum(recording|stopped|interrupted|failed),
                    data_dir, status_message_id

recording_presence  id PK, recording_id FK, user_id, display_name, joined_at, left_at,
                    excluded bool               -- opt-out : présence notée, audio ignoré

audio_segments      id PK, recording_id FK, user_id, start_ms, end_ms, file_path,
                    packets int, lost_packets int

pipeline_steps      id PK, recording_id FK, step enum(transcribe|summarize|mix|upload|publish),
                    status enum(pending|running|done|failed), attempts, locked_until,
                    started_at, finished_at, error text, output jsonb,
                    UQ(recording_id, step)

transcript_segments id PK, recording_id FK, user_id, start_ms, end_ms, text, backend, model

summaries           recording_id PK, content jsonb   -- par point d'ODJ : décisions, actions{qui,quoi,quand},
                    markdown, llm_model_group, llm_deployment_ids text[], transcription_backends text[], created_at

stored_files        id PK, recording_id FK, kind enum(track|mix|transcript), user_id NULL,
                    destination, remote_path, public_url, size_bytes,
                    uploaded_at, expires_at, deleted_at
```

- Une seule ligne `pipeline_steps` par étape et par enregistrement. Elle est prise avec `UPDATE … WHERE status IN ('pending','failed') … RETURNING`, avec un bail `locked_until`. « Réessayer » remet à `pending` **les étapes en échec** (les suivantes le sont déjà) ; l'audio complet et la transcription tournent en parallèle ; les étapes `done` réutilisent leur `output`.
- Chaque étape est idempotente. Exemple : `upload` saute une destination déjà présente dans `stored_files`.
- Au redémarrage : un enregistrement encore `recording` passe en `interrupted`, et le thread reçoit les boutons « Reprendre » et « Terminer et traiter ».

## 5. Points de conception notables

- **customId** : `v1:rsvp:<meetingId>:yes`, `v1:agenda:add:<meetingId>`, `v1:rec:start:<recordingId>`, `v1:job:retry:<recordingId>`. Ils sont décodés et validés par zod, et le préfixe de version permet de faire évoluer le format.
- **Carte de réunion** : une fonction pure `renderMeetingCard(meeting, rsvps, agenda, links)` reconstruit le message à partir de la BDD. Les éditions sont regroupées (debounce d'environ 1 s par réunion) pour encaisser les rafales de RSVP.
- **Permissions** : l'ODJ (retrait, réordonnancement, verrou) et les boutons d'enregistrement sont réservés à l'organisateur, au rôle gestionnaire ou aux membres ayant `ManageEvents`. Les vérifications sont faites dans `domain/` et testées.
- **Scheduled Event** : type `Voice` sur le salon. Le bot le passe en `Active` au démarrage et `Completed` à la fin, et l'annule avec la réunion.
- **Résumé map-reduce** :
  1. découper la transcription horodatée en chunks d'environ N tokens, sur des frontières de prise de parole ;
  2. pour chaque chunk, un appel LLM produit du JSON structuré rattaché aux points d'ODJ (validé par zod, une nouvelle tentative si invalide) ;
  3. un appel final fusionne et dédoublonne.

  Les points d'ODJ sans contenu deviennent « non traités ».
- **Découpage des embeds** : fonction pure `splitSummary(summary) → Embed[][]` (4096 caractères par description, 1024 par champ, 25 champs, 6000 au total et 10 embeds par message). Si nécessaire, les embeds sont répartis sur plusieurs messages, en coupant d'abord par point d'ODJ puis par paragraphe.
- **Logs** : pino en JSON, enrichi de `guildId`, `meetingId`, `recordingId` et `step`.

## 6. docker-compose (aperçu)

```yaml
services:
  bot:
    image: ghcr.io/<toi>/meeting-bot:${BOT_TAG:-latest}
    env_file: stack.env            # variables saisies dans Portainer
    volumes: [ "/srv/meeting-bot/config:/app/config:ro", "data:/data" ]
    depends_on: { postgres: { condition: service_healthy } }
  postgres:
    image: postgres:17
    volumes: [ "pg:/var/lib/postgresql/data" ]
    healthcheck: { test: ["CMD-SHELL","pg_isready -U bot"], interval: 5s }
  litellm:
    image: ghcr.io/berriai/litellm:<version épinglée>
    command: ["--config","/app/config.yaml"]
    volumes: [ "/srv/meeting-bot/litellm.yaml:/app/config.yaml:ro" ]
  rclone:
    image: rclone/rclone:<version épinglée>
    command: ["rcd","--rc-addr",":5572","--rc-user","${RCLONE_USER}","--rc-pass","${RCLONE_PASS}"]
    volumes: [ "/srv/meeting-bot/rclone:/config/rclone", "data:/data" ]
volumes: { pg: {}, data: {} }
```

- Aucun port n'est publié : NPM n'est pas nécessaire, le bot n'expose rien.
- Les migrations Drizzle s'appliquent au démarrage du bot.

## 7. Phases de livraison

### Phase 1 — Gestion des réunions
**Contenu**
- `/config` (forum, tags, rôles, fuseau, rappels)
- `/reunion creer|modifier|annuler|dupliquer`, avec une modal pour la description
- Thread forum avec tags, carte vivante, RSVP, ODJ (ajout, retrait, réordonnancement, verrou)
- Rappels et relance des non-répondants
- Scheduled Event synchronisé
- Scheduler en BDD

**Tests unitaires** : rsvp, agenda, reminders, customId, carte de réunion, config.

**Tester en local**
1. `docker compose -f compose.dev.yml up postgres`.
2. `pnpm dev` (tsx watch), avec les commandes enregistrées **par guilde** sur un serveur de test.
3. Un script `pnpm db:studio` (Drizzle Studio) permet d'inspecter la BDD.

**Déployer sur Portainer**
1. Pousser sur `main` : la GitHub Action publie l'image sur GHCR.
2. Créer la stack Portainer en mode Git (repo + chemin `docker-compose.yml`), avec les variables d'environnement dans l'UI et un webhook de redéploiement.
3. Déposer `config.yaml` sur l'hôte.
4. Lancer `pnpm deploy-commands` une fois (`docker exec`).

### Phase 2 — Enregistrement
**Contenu**
- Boutons Démarrer et Terminer, démarrage auto (arrivée à H-2 min)
- Avertissement RGPD et rôle opt-out
- Segments OGG par prise de parole
- Réabonnement quand un flux est détruit, compteur de paquets perdus
- Fin quand le vocal reste vide
- Bilan des présents déclarés face aux présents réels
- Gestion d'un redémarrage pendant un enregistrement

**Tester** : avec deux comptes dans le vocal du serveur de test. Un script de debug `pnpm tsx scripts/assemble.ts <recordingId>` produit les pistes continues pour les écouter.

**Déployer** : comme la phase 1, plus le volume `data`.

### Phase 3 — Transcription et résumé
**Contenu**
- Runner d'étapes reprenable
- Backends `vibe` et `openai` avec health check et bascule (429, timeout, 5xx)
- Fusion chronologique de la transcription
- Résumé map-reduce via LiteLLM, avec traçabilité
- Message de progression et bouton « Réessayer »

**Tests unitaires** : bascule (backends simulés), découpage en chunks, fusion, validation du JSON LLM.

**Tester** : Vibe sur le PC Windows (procédure NSSM fournie), LiteLLM en local, puis `pnpm tsx scripts/run-pipeline.ts <recordingId> --from transcribe`.

**Déployer** : ajouter `litellm` à la stack.

### Phase 4 — Mix, stockage, publication, rétention
**Contenu**
- Mix MP3 et pistes continues 48 kHz
- Upload rclone vers toutes les destinations
- Liens Drive et Synology
- Publication (réouverture du thread, embeds découpés, `.md` joint, boutons « Écouter », tag Terminée)
- Purge quotidienne

**Tests unitaires** : `splitSummary`, template de chemin, calcul d'expiration.

**Tester** : un remote `local:` rclone pointant vers un dossier temporaire, puis le NAS.

**Déployer** : ajouter `rclone` et monter `rclone.conf` (via `rclone config` sur l'hôte).

## 8. Questions encore ouvertes (non bloquantes pour la phase 1)
1. Image : build via **GitHub Actions → GHCR** (recommandé) plutôt que `build:` dans la stack Portainer ? Où est hébergé le repo ?
2. Quelle stratégie exacte pour la VRAM si Vibe et Ollama tournent sur le même PC de 16 Go : `--unload-timeout` pour Vibe, et `keep_alive` court pour Ollama ?

# meeting-recorder

Bot Discord auto-hébergé de gestion de réunions : planification dans un forum, inscriptions, ordre du jour, rappels et événements Discord natifs, puis enregistrement de chaque participant, transcription, compte rendu rédigé par un modèle de langue local et publication dans le post de la réunion.

Voir [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) pour la conception d'ensemble et le plan par phases.

## Phase 1 — Gestion des réunions

| Fonction | Détail |
|---|---|
| Post épinglé | Créé quand on choisit le forum dans `/config` : bouton **Nouvelle réunion** et liste chronologique des réunions à venir. Personne ne peut y écrire : tout message posté est supprimé (le post n'est pas verrouillé, sinon les membres ne pourraient plus cliquer). Le bot le surveille : supprimé (ou son message effacé), il est recréé aussitôt ; désépinglé, verrouillé ou archivé, il est rétabli ; vérification complète au démarrage puis toutes les 15 min. |
| Nouvelle réunion | Bouton du post épinglé. Formulaire : titre, jour (les 24 prochains jours, ou « 📅 Autre date… »), horaire (`18h` ou `18h-19h30` ; avec « Autre date » : `15/01/2027 18h-19h30`, `15/01 18h` ou `15 janv. 18h`), salon vocal (sauf s'il est imposé ou créé automatiquement), description. Une saisie refusée se corrige avec **✏️ Corriger la saisie**, qui rouvre le formulaire prérempli. |
| Sondage de date | Bouton **🗳️ Proposer des dates** du post épinglé, quand la date n'est pas encore connue. Formulaire : titre, créneaux (un par ligne, mêmes formats que « Autre date » : `21/10 18h`, `mar 21/10 18h-19h30`, `15 janv. 18h` ; 2 à 10), fin des réponses, description. Le post est créé tout de suite (tag « Date à choisir », ordre du jour déjà utilisable) avec une **grille de disponibilités** : pour chaque créneau, chacun répond ✅ disponible, 🟡 si nécessaire ou ❌ pas disponible (bouton **Indiquer mes disponibilités**), le meilleur créneau est marqué ⭐. L'organisateur peut ajouter ou retirer un créneau (⚙️ Gérer). Le rôle de relance est relancé la veille de la fin des réponses. À la fin des réponses, la date est fixée automatiquement s'il y a un meilleur créneau net, sinon l'organisateur est mentionné pour trancher (⚙️ Gérer → **Fixer la date**). La réunion devient alors ordinaire (événement Discord, rappels, salon) et les réponses deviennent des inscriptions (✅ → Présent, 🟡 → Peut-être). Un message **Résultat du sondage** fige la grille dans le post (créneau retenu marqué 📅) ; les réponses restent aussi en base. |
| Post de réunion | Titré `Lun. 12/10 · 18h00 · Titre`. Un événement Discord est créé en parallèle. |
| Carte de réunion | Premier message du post, régénéré depuis la BDD : date (affichée dans le fuseau de chaque lecteur), salon, organisateur, réponses, ordre du jour. |
| Réponses | Boutons Présent / Peut-être / Absent, modifiables à tout moment. |
| Ordre du jour | **Ajouter un point** (formulaire titre + détail ; auteur enregistré). **Gérer l'ordre du jour** : l'organisateur ou un gestionnaire peut modifier, monter, descendre, retirer et verrouiller. Chaque participant peut modifier ses propres points tant que l'ODJ n'est pas verrouillé. |
| Tags | `À venir` → `En cours` (à l'heure prévue) → `Terminée` / `Annulée`. |
| Rappels | J-1 et 15 min avant par défaut. Ils mentionnent les présents et les peut-être. Les membres d'un rôle choisi qui n'ont pas répondu peuvent être relancés. |
| ⚙️ Gérer | Bouton de la carte (organisateur ou gestionnaire), qui ouvre un panneau privé : modifier, dupliquer (nouveau jour et horaire, ODJ repris ou non), enregistrement auto oui/non, clore maintenant (avec confirmation), annuler (raison facultative), régénérer le compte rendu. **Le bot n'a qu'une seule commande, `/config`** : tout le reste passe par des boutons. |
| Clôture auto | **Uniquement quand le vocal est vide** depuis 5 min, compté depuis le départ de la dernière personne (ou depuis la fin prévue si personne n'est venu). Une réunion qui déborde n'est jamais coupée tant qu'il reste quelqu'un. |
| `/config` | Une seule commande, réservée à « Gérer le serveur », qui ouvre un **panneau interactif**. L'accueil résume tous les réglages ; un menu ouvre chaque section : Forum, Salon vocal (au choix, imposé, ou **créé automatiquement** : un salon au nom de la réunion, dans la catégorie choisie, N min avant le début, supprimé une fois la réunion finie et le salon vide), Rôles, Rappels, Général (fuseau, durée, création), Enregistrement auto, Transcription, Résumé (serveur et modèle, liste des modèles, test, activation), Alertes. Les réglages se font avec des sélecteurs de salon et de rôle, des boutons et de petits formulaires. |

Qui peut gérer une réunion ? Son organisateur, les membres des **rôles gestionnaires** (jusqu'à 5, `/config` → Rôles), et ceux qui ont la permission **Gérer les événements** ou **Gérer le serveur**. Le panneau ⚙️ Gérer permet aussi d'**enregistrer maintenant** (même avant l'heure) ou d'arrêter l'enregistrement ; les actions lourdes (terminer, tout retranscrire, retirer un point, désactiver le résumé) demandent une confirmation. « Dupliquer » propose le même jour la semaine suivante, titre et description modifiables.

## Phase 2 — Enregistrement

| Fonction | Détail |
|---|---|
| Démarrer | Message **🎙️ Enregistrement** publié dans le post quand la réunion est « En cours » et qu'au moins une personne est dans le vocal, avec le bouton **🔴 Enregistrer** (organisateur ou gestionnaire). Il devient **⏹️ Arrêter** pendant l'enregistrement. |
| Automatique | Carte → ⚙️ Gérer → « Enregistrer automatiquement », ou par défaut pour le serveur dans `/config` → Enregistrement. Le bot rejoint le vocal **2 min avant l'heure** (avant l'arrivée des participants, ce qui contourne un bug connu de DAVE), avec un rattrapage à l'heure de début s'il était éteint. |
| Pendant | Le bot est dans le vocal, micro coupé, et **renommé « 🔴 Enregistrement »** (pseudo restauré à l'arrêt). Avertissement dans le post et dans le chat du vocal au démarrage, puis à **chaque personne qui arrive en cours de route** (une fois par session). La carte affiche « Enregistrement en cours ». |
| Pistes | Un fichier OGG/Opus 48 kHz par prise de parole et par personne, sans réencodage, horodaté en base. Pas besoin de diarisation. |
| Opt-out | Bouton **🎙️ Mon choix d'enregistrement** (post épinglé, avertissement de démarrage, message aux arrivants) : chacun refuse ou accepte. Le choix est **gardé par le bot, invisible des autres membres** ; aucun rôle n'est nécessaire. Les admins voient la liste dans `/config` → Enregistrement. La présence est notée, pas la voix. |
| Fin | Bouton Arrêter, carte → ⚙️ Gérer → « Terminer maintenant », ou clôture automatique (vocal vide depuis 5 min, jamais avant l'heure de fin prévue). Une fois le compte rendu publié, la carte affiche les liens **Compte rendu** et **Audio**, et le post épinglé liste les 5 derniers comptes rendus. |
| Bilan | Message silencieux dans le post. Il signale « ⚠️ audio possiblement incomplet » quand une part notable des paquets d'une personne n'a pas pu être déchiffrée (DAVE) ; `recording.debugVoice: true` journalise les détails de la connexion vocale. Il indique aussi : durée, personnes enregistrées, prises de parole, inscrits présents, inscrits absents, venus sans inscription, non enregistrés. |
| Coupures | Une coupure réseau ou un redémarrage du bot arrête proprement l'enregistrement. Le bilan propose **🔴 Reprendre l'enregistrement**, qui ouvre une nouvelle session ; les pistes déjà captées sont conservées. |

Contrainte Discord : un bot ne peut être que dans **un vocal par serveur** à la fois, donc un seul enregistrement par serveur.

**Conservation** : une purge quotidienne (4 h 17) supprime les fichiers locaux selon `retention` dans le YAML, réglable par serveur :
- les prises de parole brutes 30 jours après la réunion, seulement si celle-ci est close et que l'audio complet et la transcription sont faits ;
- l'audio complet au bout d'un an.

Les copies publiées dans Discord restent. Une alerte est émise si l'espace libre passe sous `diskMinFreeGb`.

Les pistes sont écrites dans `dataDir/recordings/<serveur>/<session>/<utilisateur>/`, soit le volume `recordings` en Docker. Compter environ **3,3 Mo par 10 minutes et par personne** (Opus à ~43 kbit/s, mesuré), plus l'audio complet de la réunion (~2 Mo par 10 minutes ; pendant la réunion, un mix sans perte d'environ 38 Mo par 10 minutes permet d'ajouter chaque nouvelle session sans tout remixer, et il est supprimé dès le compte rendu de la réunion close publié) : une réunion d'une heure à 6 personnes occupe environ 130 Mo, dont les pistes brutes sont purgées après 30 jours (`retention.rawTracksDays`). Le bot refuse de démarrer un enregistrement sous le seuil `diskMinFreeGb` (5 Go) et alerte toutes les 10 minutes si l'espace baisse pendant une capture.

**Écouter une session (debug)** : `npx tsx --env-file=.env scripts/assemble.ts <recordingId>`. Le script reconstitue une piste continue par participant et un mix dans `…/<session>/assembled/` ; il nécessite ffmpeg. L'id de session se trouve dans la table `recordings` (`npm run db:studio`).

### Tester la phase 2

1. Activer **Server Members Intent** (déjà requis), et vérifier que le bot voit le salon vocal et peut s'y connecter.
2. Optionnel : avec un second compte, cliquer « Mon choix d'enregistrement » sur le post épinglé.
3. Créer une réunion dans quelques minutes et rejoindre le vocal à deux. À l'heure prévue, le message **🎙️ Enregistrement** apparaît : cliquer **🔴 Enregistrer**.
4. Parler à tour de rôle, utiliser « Mon choix d'enregistrement » → Refuser avec un compte et vérifier que sa voix n'est plus captée.
5. **⏹️ Arrêter l'enregistrement** dans ce message : vérifier le bilan dans le post, puis écouter avec `scripts/assemble.ts`.
6. Tester l'automatique : carte → ⚙️ Gérer → « Enregistrer automatiquement » sur une réunion dans 5 min. Le bot arrive à H-2.
7. Rester au-delà de l'heure de fin : rien ne se coupe. Puis quitter le vocal : 5 min après, la réunion est close et l'enregistrement s'arrête.

## Phase 3 — Transcription et compte rendu

| Fonction | Détail |
|---|---|
| Déclenchement | À l'**arrêt de l'enregistrement** : l'audio arrive en quelques secondes. Un nouvel enregistrement dans la même réunion met tout à jour au prochain arrêt (audio refait avec toutes les sessions, seuls les nouveaux passages transcrits, compte rendu remplacé). Une session coupée par une déconnexion ou un redémarrage ne déclenche rien, pour laisser la place à une reprise : elle est traitée à la clôture de la réunion. Une réunion à la fois. |
| Audio complet | Première étape : toutes les prises de parole replacées sur une même ligne de temps, autrement dit ce que tout le monde a entendu, en **Opus mono**, publiées aussitôt dans le post avec le lecteur Discord. Le débit est ajusté pour tenir dans la limite d'envoi du serveur (10, 50 ou 100 Mo selon le boost, ≈ 55 min sans boost). Au-delà, l'audio est **découpé en parties** (jusqu'à 10, au moins 24 kbps), publiées une par message avec leurs repères de temps. Au-delà de 10 parties, il est conservé sur le serveur (`dataDir/meetings/…`). L'audio est publié même si la transcription échoue. |
| Suivi | Message **📝 Compte rendu** dans le post : ⬜ ⏳ ✅ ❌ par étape, avec la progression (blocs transcrits, passes de résumé). |
| Transcription | Prises de parole regroupées en blocs par personne, assemblées en WAV 16 kHz par ffmpeg, puis envoyées au **premier backend disponible** de `transcription.backends`. Health check court, puis bascule au suivant en cas d'erreur, de délai dépassé ou de « occupé » (Vibe ne traite qu'une requête à la fois). Les hallucinations connues de Whisper sont filtrées, ainsi que les **échos** : la même phrase captée par le micro d'un voisin sans casque n'est gardée qu'une fois (`transcription.dropEchoes`). Pas de diarisation nécessaire : chaque piste a son auteur. **Vocabulaire** (`/config` → Transcription → 📖) : pseudos, noms de projets et jargon du serveur, transmis à Whisper avec les participants, les points d'ODJ et les noms propres des consignes de correction (sauf le terme fautif de « Pol et non Paul ») ; il sert aussi d'orthographe de référence au résumé. |
| Résumé | **Facultatif** : sans modèle configuré, l'étape est sautée (⏭️) et le compte rendu se limite à l'audio et à la transcription. Avec un modèle, via LiteLLM, Ollama ou LM Studio. Structuré **par point d'ordre du jour** : synthèse, décisions, actions (qui / échéance), questions ouvertes, sujets hors ODJ, points non traités. Une réunion longue est résumée **en plusieurs passes** (morceaux, puis fusion). |
| Publication | Compte rendu en Components V2, découpé sur plusieurs messages si besoin, avec la **transcription complète en `.md`** jointe. Les responsables d'actions reconnus sont mentionnés, donc notifiés. La trace des modèles utilisés est en pied de message. |
| Copie vers le stockage | Si le serveur a connecté un **Google Drive, OneDrive ou Dropbox** (`/config` → ☁️ Stockage), dernière étape : le compte rendu et la transcription en Markdown, et l'audio complet, sont copiés dans `<dossier>/<date heure - titre>/`. Une correction ou une nouvelle session remplace les fichiers. Un échec ne retarde pas le compte rendu : l'étape passe en ❌ (🔁 Relancer), le salon d'alertes est prévenu, l'organisateur n'est pas dérangé. |
| Échec | L'étape passe en ❌ avec l'erreur et un bouton **🔁 Relancer** (organisateur ou gestionnaire) : seule l'étape en échec et les suivantes sont refaites, les blocs déjà transcrits sont conservés. Un arrêt du bot reprend au démarrage. |
| Corriger | Bouton **✏️ Corriger** sous le compte rendu (organisateur ou gestionnaire) : une consigne libre (« Pol et non Paul », « la décision était de reporter »). Elle est ajoutée aux consignes précédentes et transmise au modèle en priorité, puis le résumé est régénéré sans retranscrire. |
| Régénérer | Carte → ⚙️ Gérer → « Régénérer le compte rendu » (ou 🔄 Régénérer sous le compte rendu), ou « Tout retranscrire ». L'ancien compte rendu est remplacé. |

### Mettre en place l'IA

1. **Vibe** sur le PC GPU : télécharger `vibe-server` (releases `server-v*` de [thewh1teagle/vibe](https://github.com/thewh1teagle/vibe/releases)) et un modèle (`vibe-server pull <url>`, par exemple `ggml-large-v3-turbo.bin`), puis lancer :
   ```
   vibe-server serve C:\models\ggml-large-v3-turbo.bin --host 0.0.0.0 --port 8080 --exit-with-parent false
   ```
   Pour qu'il démarre avec Windows, en faire un service, avec NSSM par exemple. Vibe n'a **ni authentification ni TLS** : l'exposer uniquement sur le LAN ou Tailscale. Vérifier depuis le serveur : `curl http://pc-main.tailnet:8080/ready`.
2. **Secours** (optionnel) : un serveur compatible OpenAI (speaches / faster-whisper) sur une autre machine, ajouté après Vibe dans la liste.
3. **Résumé** : `/config` → Résumé. Comme pour la transcription, une **liste de serveurs par ordre de priorité** (5 au plus) : si le premier échoue (éteint, occupé, erreur, modèle absent), le suivant prend le relais pour la même passe, et les passes suivantes repartent du serveur qui a répondu. Le propriétaire du bot ajoute un serveur compatible OpenAI (LM Studio `http://hôte:1234/v1`, Ollama `http://hôte:11434/v1` ou LiteLLM), choisit son modèle dans la liste proposée, puis peut le monter, le désactiver, le tester ou le supprimer ; les administrateurs peuvent tester et désactiver le résumé. La trace du compte rendu nomme le serveur qui a répondu. Sans serveur dans la liste, le bloc `llm` du YAML s'applique ; un serveur réglé avant cette version devient automatiquement « principal ».
   Côté machine : **Ollama** (ou LM Studio) avec un modèle de résumé, par exemple `ollama pull qwen3:14b`. Avec 16 Go de VRAM partagés avec Whisper, garder un `keep_alive` court côté Ollama et `--unload-timeout` côté Vibe.
4. **LiteLLM (facultatif)** : copier [config/litellm.example.yaml](config/litellm.example.yaml) sur l'hôte (`/srv/meeting-bot/litellm.yaml`), puis ajouter `COMPOSE_PROFILES=litellm` et `LITELLM_MASTER_KEY` dans les variables de la stack. Sans LiteLLM, il suffit de régler le serveur dans `/config` → Résumé.
   Le bot n'a pas besoin de la clé maîtresse : créer une clé virtuelle limitée au modèle de résumé et la donner au bot dans `LLM_API_KEY` (sinon, la clé maîtresse est utilisée par défaut) :
   ```bash
   curl -s http://<hôte-litellm>:4000/key/generate -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
     -H 'content-type: application/json' -d '{"models": ["summary"], "key_alias": "meeting-recorder"}'
   ```
   Les clés virtuelles demandent une base de données côté LiteLLM (`DATABASE_URL` dans sa configuration) ; sans elle, garder la clé maîtresse.
5. **Serveurs de transcription** : `/config` → Transcription. **Seuls les propriétaires du bot peuvent modifier la liste** : le propriétaire de l'application Discord, plus la liste `owners` du YAML. Les administrateurs des serveurs peuvent consulter et tester. Avec `ai.allowedHosts`, le bot n'appelle que les hôtes autorisés (par exemple `*.tailnet.ts.net`, `192.168.1.0/24`), et il ne suit jamais une redirection.
   - **Ajouter** un serveur, jusqu'à 4, avec un formulaire : nom, type Vibe ou compatible OpenAI, URL, modèle, clé d'API.
   - **Gérer chaque serveur** avec ses boutons : ✏️ Modifier · ⬆️ Monter · ⏸️ Désactiver / ▶️ Activer · 🧪 Tester · 🗑️ Supprimer (avec confirmation). L'ordre de la liste est l'ordre de bascule.
   - **Tester** : un vrai essai (santé, puis transcription d'une seconde de silence), avec la latence affichée sous le serveur. Un test est aussi lancé automatiquement après chaque ajout ou modification.
   - **Clés d'API** : stockées en base, jamais réaffichées. En modification, laisser le champ vide conserve la clé, « - » la supprime.
   - Tant qu'aucun serveur n'est ajouté ici, la section `transcription.backends` du YAML s'applique.

### Stockage des comptes rendus (Google Drive, OneDrive, Dropbox)

Chaque serveur Discord choisit où copier ses comptes rendus, transcriptions et audios : `/config` → ☁️ **Stockage** → « Connecter … », puis connexion avec le compte de son choix (celui de l'association, par exemple). Le bot n'expose aucune page web, la connexion se fait donc ainsi :

- **Google Drive, OneDrive** : le bot affiche un code ; on l'entre sur google.com/device ou microsoft.com/devicelogin, puis on autorise l'accès. Le panneau se met à jour tout seul.
- **Dropbox** : « Ouvrir la page », autoriser l'accès, puis « Saisir le code » et coller le code affiché par Dropbox.

Ensuite : 🧪 Tester, 📂 Ouvrir le dossier, 📁 Changer de dossier (« Meeting recorder » par défaut, créé à la racine), 🔌 Déconnecter (les fichiers déjà copiés restent). **Dossier partagé** : sur Google Drive et OneDrive, il suffit de déplacer le dossier « Meeting recorder » dans un dossier partagé ou un Drive partagé de l'organisation, ou de le partager : le bot le suit par son identifiant et continue d'y écrire. S'il est supprimé, il est recréé à la racine. Accès au plus juste : Google Drive ne laisse voir au bot que les fichiers qu'il a créés, Dropbox le limite à `Applications/<nom de l'application>`. OneDrive n'a pas de réglage équivalent qui marche partout : l'accès porte sur le OneDrive, le bot n'écrit que dans son dossier. Les jetons sont chiffrés avec `APP_SECRET_KEY`.

**Côté opérateur, une seule fois par service** : créer l'application OAuth du bot et mettre ses identifiants dans les variables de la stack. Un service sans identifiant n'est pas proposé dans `/config`.

1. **Google Drive** (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) — [console.cloud.google.com](https://console.cloud.google.com) :
   - créer un projet, puis *API et services → Bibliothèque* : activer **Google Drive API** ;
   - *Google Auth Platform* (écran de consentement) : audience **Externe**, nom de l'application et adresse de contact ; ajouter la portée `…/auth/drive.file` ;
   - **Publier l'application** (statut « En production »). En mode « Test », Google révoque l'accès au bout de 7 jours et seuls les comptes de test peuvent se connecter. `drive.file` n'est pas une portée sensible : il n'y a pas de validation à demander à Google ;
   - *Clients → Créer un client* : type **Téléviseurs et appareils à entrée limitée**. Copier l'ID client et le code secret.
2. **OneDrive** (`ONEDRIVE_CLIENT_ID`) — [entra.microsoft.com](https://entra.microsoft.com) → *Inscriptions d'applications → Nouvelle inscription* :
   - comptes pris en charge : **comptes de tout annuaire organisationnel et comptes Microsoft personnels** ; pas d'URI de redirection ;
   - *Authentification* : **Autoriser les flux clients publics** → Oui ;
   - *Autorisations d'API* : Microsoft Graph, délégué, `Files.ReadWrite` et `offline_access` ;
   - copier l'**ID d'application (client)**. Il n'y a pas de secret à créer. Avec un compte professionnel, l'administrateur de l'organisation peut devoir approuver l'application.
3. **Dropbox** (`DROPBOX_APP_KEY`) — [dropbox.com/developers/apps](https://www.dropbox.com/developers/apps) → *Create app* :
   - **Scoped access**, **App folder**, puis un nom : le dossier sera `Applications/<nom>` ;
   - onglet *Permissions* : cocher `files.content.write`, puis *Submit* ;
   - copier l'**App key**. Pas de secret ni d'URI de redirection : la connexion utilise PKCE. En mode développement, une application Dropbox accepte jusqu'à 500 comptes.

Puis redéployer la stack. Les clés se mettent aussi dans `storage` du YAML (voir [config/config.example.yaml](config/config.example.yaml)).

### Tester la phase 3

- **En local** : configurer `transcription` et `llm` dans `config/config.yaml`. ffmpeg est fourni par `ffmpeg-static`. Faire une réunion enregistrée, puis la clore (carte → ⚙️ Gérer → Terminer maintenant).
- **Sur une réunion déjà enregistrée** : carte → ⚙️ Gérer → Régénérer le compte rendu.
- **Tests automatiques** : `TEST_DATABASE_URL=… npm test` lance aussi un test de bout en bout : vraies pistes OGG, ffmpeg, bascule entre serveurs simulés, LLM simulé, relance et reprise. La couche Discord est testée avec de faux objets (`test/helpers/discordFakes.ts`) : droits de chaque action, routeur et messages d'erreur, rappels, surveillance des réunions, publication du compte rendu, démarrage d'un enregistrement.

## 1. Créer l'application Discord

1. Sur https://discord.com/developers/applications, créer une application (icône prête à l'emploi : [assets/app-icon.png](assets/app-icon.png), 1024 × 1024 ; bannière : [assets/app-banner.png](assets/app-banner.png), 1360 × 480, à déposer dans **Bot → Banner**), puis ouvrir l'onglet **Bot**.
2. Copier le token : c'est `DISCORD_TOKEN`.
3. Activer **Server Members Intent**. Il sert à relancer les membres d'un rôle qui n'ont pas répondu.
4. Inviter le bot sur le serveur avec ce lien (remplacer `CLIENT_ID`) :
   ```
   https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot+applications.commands&permissions=17892902038544
   ```
   Permissions demandées :
   - Gérer les salons, nécessaire pour créer les tags du forum
   - Voir les salons, Envoyer des messages, Envoyer des messages dans les fils
   - Gérer les fils, Gérer les messages (pour garder le post épinglé vide), Intégrer des liens, Joindre des fichiers (audio et transcription du compte rendu), Voir l’historique
   - Créer et gérer les événements
   - Se connecter (enregistrement)
   - Changer le pseudo : le bot s'appelle « 🔴 Enregistrement » pendant une capture
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
3. Bouton **Nouvelle réunion** du post épinglé, avec une heure dans 8 minutes. Vérifier que le post, la carte et l'événement Discord sont créés.
4. Avec deux comptes, répondre (Présent / Peut-être) et ajouter des points à l'ordre du jour. La carte se met à jour en environ une seconde.
5. Avec **Gérer l'ordre du jour**, réordonner, retirer un point et verrouiller. Avec le second compte, vérifier que l'ajout est refusé.
6. Vérifier les rappels à H-5 et H-2 min, puis le passage du tag à « En cours » et de l'événement à « Actif » à l'heure prévue.
7. Carte → ⚙️ Gérer → Terminer maintenant : tag « Terminée », boutons désactivés, événement terminé.
8. Redémarrer le bot entre deux étapes. Les boutons et les échéances doivent continuer à fonctionner, car tout est en BDD.

## 3. Déploiement Portainer

L'image est construite par GitHub Actions et publiée sur `ghcr.io/powange/meeting-recorder`. La stack se contente de la récupérer.

| Tag | Mis à jour | Usage |
|---|---|---|
| `stable` | à chaque version publiée (`git tag v…`) | **production** (valeur par défaut de la stack) |
| `1.2.0` | une fois, à la publication de cette version | épingler une version, revenir en arrière |
| `latest` | à chaque push sur `main` | essais |
| `sha-abc1234` | à chaque build | retrouver un build précis |

1. L'image est publique (elle hérite de la visibilité du dépôt) : Portainer la récupère sans identifiants.
2. Dans Portainer : *Stacks* → *Add stack* → **Repository**.
   - Repository URL : `https://github.com/powange/meeting-recorder`
   - Compose path : `docker-compose.yml`
   - Variables d'environnement :
     - `DISCORD_TOKEN`
     - `POSTGRES_PASSWORD` (alphanumérique)
     - optionnelles : `LOG_LEVEL`, `BOT_TAG` (`stable` par défaut ; `1.2.0` pour épingler une version), `COMPOSE_PROFILES=litellm` + `LITELLM_MASTER_KEY` (LiteLLM dans la stack)
   - Activer **GitOps updates → Webhook** et cocher **Re-pull image**.
3. Redéploiement automatique : copier l'URL du webhook Portainer dans le secret GitHub `PORTAINER_WEBHOOK` du dépôt. Seule la **publication d'une version** redéploie : un push sur `main` construit l'image `latest` sans toucher à la production, ce qui évite de couper une réunion en cours.
   ```bash
   # version du package.json à jour, puis :
   git tag v1.2.0 && git push origin v1.2.0   # tests → image stable + 1.2.0 → redéploiement
   ```
   Choisir un moment sans réunion : le redéploiement interrompt un enregistrement en cours.
4. Configuration avancée (surcharges par serveur) : déposer un `config.yaml` sur l'hôte, par exemple `/srv/meeting-bot/config/config.yaml`. Décommenter ensuite `CONFIG_PATH` et le volume dans [docker-compose.yml](docker-compose.yml).

Le bot n'expose aucun port : Nginx Proxy Manager n'est pas nécessaire. Les migrations s'appliquent au démarrage, et l'arrêt est propre sur `SIGTERM` : le scheduler s'arrête et les cartes en attente sont mises à jour.

- **Quelle version tourne ?** Le premier message du journal donne la version et le commit (`Démarrage de meeting-recorder`), puis l'application Discord connectée (`Connecté à Discord` : id et nom, pour repérer un token de prod utilisé en dev). `/health` les renvoie aussi.
- **Une seule instance par base** : un second bot pointé sur la même base (par exemple `npm run dev` avec l'URL de prod) attend 90 s puis s'arrête avec un message clair.
- **Sauvegarde avant migration** : quand une nouvelle version apporte des migrations, le bot fait d'abord un `pg_dump` dans `/data/backups/pre-migration-….dump` (volume `recordings`, 5 gardées). Si la sauvegarde échoue, il s'arrête sans migrer et le journal donne l'erreur de `pg_dump`. En dernier recours, la variable `MIGRATION_BACKUP=off` le laisse migrer sans sauvegarde (à retirer ensuite).
- **Revenir à la version précédente** : les migrations ne se défont pas. Arrêter la stack, restaurer la sauvegarde d'avant migration, puis redéployer avec `BOT_TAG=<version précédente>` :
  ```bash
  docker compose stop bot
  docker compose cp bot:/data/backups/pre-migration-<date>.dump ./avant.dump   # ou docker cp depuis le volume
  docker compose exec -T postgres pg_restore -U bot -d meetingbot --clean --if-exists < ./avant.dump
  ```

### Supervision et sauvegarde

- **Santé** : le conteneur du bot a un `HEALTHCHECK` (connexion à Discord et à la base). Portainer l'affiche « healthy » ou « unhealthy ».
- **Alertes** : `/config` → Alertes. Choisir un salon réservé aux administrateurs. Le bot y signale un compte rendu en échec, un enregistrement coupé ou un disque presque plein, au plus une fois par heure et par cause.
- **Sauvegarde automatique** : le service `backup` fait un `pg_dump` (format custom, compressé) chaque jour à 3 h 30 (`BACKUP_AT`, fuseau `TZ`) dans le volume `backups`, conservé 14 jours (`BACKUP_KEEP_DAYS`). Si la dernière sauvegarde a plus d'un jour au démarrage du conteneur, il en fait une tout de suite. Portainer affiche le conteneur **unhealthy** si aucune sauvegarde n'a réussi depuis 26 h.
- **Restaurer** (remplace le contenu actuel de la base) :
  ```bash
  docker compose stop bot
  docker compose exec -T postgres pg_restore -U bot -d meetingbot --clean --if-exists --no-owner < meetingbot-AAAA-MM-JJ-HHMM.dump
  docker compose start bot
  ```
  Le fichier se récupère depuis le volume `backups` (`docker cp <conteneur backup>:/backups/… .`). Les anciennes sauvegardes `.sql.gz` se restaurent avec `gunzip -c … | psql`.
- **Copie hors site automatique** (facultative) : le service `offsite` copie chaque nuit (4 h 30, `OFFSITE_AT`) les volumes `backups` (base) et `recordings` (audio) vers un NAS ou Google Drive avec rclone. C'est un miroir : un fichier supprimé ici (purge de rétention) est gardé 30 jours dans `<destination>/.supprimes/<date>` (`OFFSITE_KEEP_DELETED_DAYS`) avant d'être effacé ; un volume vide n'est jamais recopié (il ne peut pas vider la copie distante). Portainer affiche le conteneur **unhealthy** sans copie réussie depuis 26 h.
  1. Créer la configuration rclone sur l'hôte (une fois) :
     ```bash
     sudo mkdir -p /srv/meeting-bot/rclone
     docker run --rm -it -v /srv/meeting-bot/rclone:/config/rclone rclone/rclone:1.75.1 config
     ```
     - **NAS Synology** : activer SFTP dans DSM (Panneau de configuration → Terminal et SNMP / Services de fichiers), puis dans `rclone config` : nouveau remote `nas`, type `sftp`, hôte, utilisateur et mot de passe du NAS.
     - **Google Drive** : remote `drive`, type `drive` ; à la question « Use web browser to automatically authenticate? », répondre `n`, lancer la commande `rclone authorize "drive"` proposée sur un PC qui a un navigateur (rclone installé), puis coller le jeton obtenu.
  2. Dans les variables de la stack : `COMPOSE_PROFILES=offsite` (ou `litellm,offsite` avec LiteLLM) et `RCLONE_REMOTE=nas:meeting-bot` (ou `drive:meeting-bot`) ; facultatifs : `OFFSITE_AT`, `OFFSITE_KEEP_DELETED_DAYS`, `RCLONE_CONFIG_DIR` (dossier de `rclone.conf`, `/srv/meeting-bot/rclone` par défaut).
  3. Redéployer : une première copie part tout de suite (journal du conteneur `offsite` : « copie hors site OK »).
  - **Restaurer depuis la copie** : `docker run --rm -v /srv/meeting-bot/rclone:/config/rclone -v $PWD:/restore rclone/rclone:1.75.1 copy nas:meeting-bot/backups /restore`, puis la procédure **Restaurer** ci-dessus avec le fichier `.dump` voulu.
- **Appels sortants** : avec `AI_ALLOWED_HOSTS`, l'adresse est revérifiée au moment même de la connexion (un nom DNS ne peut pas changer d'adresse entre la vérification et l'appel).
- **Conteneur** : sans privilèges, système de fichiers en lecture seule (écriture seulement dans `/data` et `/tmp`). Chaque image est analysée par Trivy ; une faille critique corrigeable bloque le déploiement d'une version.
- **Clés d'API** : définir `APP_SECRET_KEY` (phrase longue et aléatoire) pour qu'elles soient chiffrées en base et dans les sauvegardes. Les clés déjà enregistrées sont chiffrées au démarrage suivant.

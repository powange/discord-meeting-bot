# meeting-recorder

Bot Discord **auto-hébergé** qui accompagne les réunions d'une association, de la planification au compte rendu. Il tourne sur votre machine : les enregistrements et les modèles d'IA restent chez vous.

## Ce que fait le bot

- **Organiser les réunions** dans un salon forum : bouton « Nouvelle réunion », sondage de date en grille (façon Framadate), réponses Présent / Peut-être / Absent, ordre du jour participatif, rappels, événement Discord et salon vocal créé automatiquement si besoin.
- **Enregistrer le vocal**, chaque participant sur sa propre piste, avec l'accord de chacun : ceux qui refusent ne sont jamais enregistrés. L'enregistrement peut démarrer tout seul à l'heure prévue.
- **Rédiger le compte rendu** : audio complet publié dans le post, transcription (Whisper, via Vibe), puis résumé par point d'ordre du jour avec décisions, actions et responsables, liste des présents. Le compte rendu se corrige ou se régénère d'un clic.
- **Copier le compte rendu** dans le Google Drive, le OneDrive ou le Dropbox du serveur, un dossier par réunion.
- **Tout se règle depuis Discord** avec une seule commande, `/config`, et des boutons.

## Documentation

| Guide | Pour qui | Contenu |
|---|---|---|
| [Réunions](docs/reunions.md) | membres, organisateurs | Création, sondage de date, réponses, ordre du jour, rappels, ⚙️ Gérer, `/config` |
| [Enregistrement](docs/enregistrement.md) | organisateurs | Démarrage manuel ou automatique, refus d'enregistrement, bilan, conservation des fichiers |
| [Compte rendu](docs/compte-rendu.md) | organisateurs | Étapes du traitement, corriger, régénérer, relancer après un échec |
| [Installation](docs/installation.md) | opérateur | Application Discord, déploiement Portainer, versions et retour arrière |
| [Transcription et résumé](docs/ia.md) | opérateur | Vibe, LM Studio / Ollama, LiteLLM, serveurs de secours |
| [Stockage](docs/stockage.md) | admins, opérateur | Connecter Google Drive, OneDrive ou Dropbox ; créer les applications OAuth |
| [Supervision et sauvegardes](docs/exploitation.md) | opérateur | Alertes, sauvegardes de la base, copie hors site, sécurité |
| [Développement](docs/developpement.md) | contributeurs | Lancer en local, tests, scénarios de test manuel |
| [Architecture](docs/ARCHITECTURE.md) | contributeurs | Conception d'ensemble |

## Démarrage rapide

1. [Créer l'application Discord](docs/installation.md#1-créer-lapplication-discord) et inviter le bot.
2. [Déployer la stack](docs/installation.md#2-déployer-avec-portainer) avec `DISCORD_TOKEN`, `POSTGRES_PASSWORD` et `APP_SECRET_KEY`.
3. Dans Discord : `/config` → Forum des réunions, puis Alertes.
4. Pour les comptes rendus : [installer un serveur de transcription](docs/ia.md).

Site et règles de confidentialité : https://meeting-recorder.powange.com

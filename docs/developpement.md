# Développement

[← Retour au README](../README.md)

Conception d'ensemble : [docs/ARCHITECTURE.md](ARCHITECTURE.md).

## Lancer le bot en local

```bash
cp .env.example .env                     # renseigner DISCORD_TOKEN
cp config/config.example.yaml config/config.yaml
# dans config.yaml, renseigner discord.commandGuildIds: ["<id du serveur de test>"]
# (les commandes apparaissent alors instantanément sur ce serveur)

docker compose -f compose.dev.yml up -d  # PostgreSQL sur localhost:5432
npm install
npm run dev                              # migrations auto + rechargement à chaud
```

`config/config.yaml` n'est pas suivi par git : quand l'exemple gagne une section (par exemple `storage`), la reporter à la main. Pour la transcription et le résumé en local, renseigner `transcription` et `llm` dans ce fichier, ou les régler dans `/config`. ffmpeg est fourni par `ffmpeg-static`.

## Commandes utiles

| Commande | Rôle |
|---|---|
| `npm test` | Tests unitaires |
| `docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=test postgres:17`<br>`TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/postgres npm test` | Ajoute les tests d'intégration SQL. **Ils vident la base visée** : toujours utiliser une base jetable comme ici. |
| `npm run typecheck` | Vérification des types |
| `npm run db:generate` | Génère une migration après modification de [src/db/schema.ts](../src/db/schema.ts) |
| `npm run db:studio` | Explore la base (Drizzle Studio) |

Les tests d'intégration comprennent un test de bout en bout du compte rendu : vraies pistes OGG, ffmpeg, bascule entre serveurs simulés, LLM simulé, relance et reprise. La couche Discord est testée avec de faux objets (`test/helpers/discordFakes.ts`) : droits de chaque action, routeur et messages d'erreur, rappels, surveillance des réunions, publication du compte rendu, démarrage d'un enregistrement. Les services de stockage sont testés avec des réponses HTTP simulées.

## Scénarios de test manuel

### Réunions

1. `/config` → Forum des réunions : les 4 tags et le post épinglé apparaissent sur le forum.
2. `/config` → Rappels → « 5min, 2min », pour voir passer les rappels rapidement.
3. Bouton **Nouvelle réunion** du post épinglé, avec une heure dans 8 minutes. Vérifier que le post, la carte et l'événement Discord sont créés.
4. Avec deux comptes, répondre (Présent / Peut-être) et ajouter des points à l'ordre du jour. La carte se met à jour en environ une seconde.
5. Avec **Gérer l'ordre du jour**, réordonner, retirer un point et verrouiller. Avec le second compte, vérifier que l'ajout est refusé.
6. Vérifier les rappels à H-5 et H-2 min, puis le passage du tag à « En cours » et de l'événement à « Actif » à l'heure prévue.
7. Carte → ⚙️ Gérer → Terminer maintenant : tag « Terminée », boutons désactivés, événement terminé.
8. Redémarrer le bot entre deux étapes. Les boutons et les échéances doivent continuer à fonctionner, car tout est en BDD.

### Enregistrement

1. Activer **Server Members Intent** (déjà requis), et vérifier que le bot voit le salon vocal et peut s'y connecter.
2. Facultatif : avec un second compte, cliquer « Mon choix d'enregistrement » sur le post épinglé.
3. Créer une réunion dans quelques minutes et rejoindre le vocal à deux. À l'heure prévue, le message **🎙️ Enregistrement** apparaît : cliquer **🔴 Enregistrer**.
4. Parler à tour de rôle, utiliser « Mon choix d'enregistrement » → Refuser avec un compte et vérifier que sa voix n'est plus captée.
5. **⏹️ Arrêter l'enregistrement** dans ce message : vérifier le bilan dans le post, puis écouter avec `scripts/assemble.ts` (voir [docs/enregistrement.md](enregistrement.md#écouter-une-session-débogage)).
6. Tester l'automatique : carte → ⚙️ Gérer → « Enregistrer automatiquement » sur une réunion dans 5 min. Le bot arrive à H-2.
7. Rester au-delà de l'heure de fin : rien ne se coupe. Puis quitter le vocal : 5 min après, la réunion est close et l'enregistrement s'arrête.

### Compte rendu

- Faire une réunion enregistrée, puis la clore (carte → ⚙️ Gérer → Terminer maintenant).
- Sur une réunion déjà enregistrée : carte → ⚙️ Gérer → Régénérer le compte rendu.
- Avec un stockage connecté (`/config` → Stockage) : vérifier le dossier de la réunion après publication, puis après une correction.

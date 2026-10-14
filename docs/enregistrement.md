# Enregistrement

[← Retour au README](../README.md)

| Fonction | Détail |
|---|---|
| Démarrer | Message **🎙️ Enregistrement non démarré** publié dans le post quand la réunion est « En cours » et qu'au moins une personne est dans le vocal, avec le bouton **🔴 Enregistrer** (organisateur ou gestionnaire). **Les boutons sont toujours sur le dernier message** : au démarrage, ce message est remplacé par l'avertissement « ⚠️ Cette réunion est enregistrée · lancé par … » (⏹️ Arrêter, avec une confirmation pour ne pas couper la réunion par erreur ; « Mon choix d'enregistrement »), suivi du message **📋 Suivi de l'ordre du jour** (point en cours, ▶️ Point suivant, 📝 Note). À l'arrêt, l'avertissement perd ses boutons, le suivi de l'ordre du jour est retiré, et **un seul bilan de séance** est publié : participation, inscrits absents, dernier point atteint et notes prises, avec **🔴 Reprendre l'enregistrement**. Quand le compte rendu est publié, le bilan reçoit son lien et le message de préparation du compte rendu est supprimé. |
| Automatique | Carte → ⚙️ Gérer → « Enregistrer automatiquement », ou par défaut pour le serveur dans `/config` → Enregistrement. Le bot rejoint le vocal **2 min avant l'heure** (avant l'arrivée des participants, ce qui contourne un bug connu de DAVE), avec un rattrapage à l'heure de début s'il était éteint. |
| Pendant | Le bot est dans le vocal, micro coupé, et **renommé « 🔴 Enregistrement »** (pseudo restauré à l'arrêt). Avertissement dans le post et dans le chat du vocal au démarrage, puis à **chaque personne qui arrive en cours de route** (une fois par session). La carte affiche « Enregistrement en cours ». |
| Pistes | Un fichier OGG/Opus 48 kHz par prise de parole et par personne, sans réencodage, horodaté en base. Pas besoin de diarisation. |
| Refus | Bouton **🎙️ Mon choix d'enregistrement** (post épinglé, avertissement de démarrage, message aux arrivants) : chacun refuse ou accepte. Le choix est **gardé par le bot, invisible des autres membres** ; aucun rôle n'est nécessaire. Les admins voient la liste dans `/config` → Enregistrement. La présence est notée, pas la voix. |
| Point suivant | Pendant l'enregistrement, le message affiche le **point d'ordre du jour en cours** : au premier enregistrement, la réunion commence d'office par le point 1. L'animateur (organisateur ou gestionnaire) clique **▶️ Point suivant** quand la réunion passe au point suivant, ou choisit un point dans la liste « Aller directement à un point… » (y compris « Hors ordre du jour »). Ces repères horodatés aident le résumé à rattacher chaque échange au bon point, et le compte rendu affiche le temps passé sur chaque point (⏱️). |
| Notes en direct | Bouton **📝 Note**, ouvert à tous les participants : une décision, une action (avec son responsable) ou une remarque, saisie pendant la réunion. Elle est horodatée, reprise dans le compte rendu et visible dans la transcription. |
| Fin | Bouton Arrêter, carte → ⚙️ Gérer → « Terminer maintenant », ou clôture automatique (vocal vide depuis 5 min, jamais avant l'heure de fin prévue). Une fois le compte rendu publié, la carte affiche les liens **Compte rendu** et **Audio**, et le post épinglé liste les 5 derniers comptes rendus. |
| Bilan | Message silencieux dans le post. Il signale « ⚠️ audio possiblement incomplet » quand une part notable des paquets d'une personne n'a pas pu être déchiffrée (DAVE) ; `recording.debugVoice: true` journalise les détails de la connexion vocale. Il indique aussi : durée, personnes enregistrées, prises de parole, inscrits présents, inscrits absents, venus sans inscription, non enregistrés. |
| Coupures | Une coupure réseau ou un redémarrage du bot arrête proprement l'enregistrement ; les pistes déjà captées sont conservées. **Après un redémarrage du bot** (mise à jour, arrêt brutal), l'enregistrement **reprend tout seul** si la réunion est en cours, qu'il reste quelqu'un dans le vocal et que la coupure date de moins de 15 min. Sinon, et après une déconnexion du vocal (souvent volontaire), le dernier message devient « ⚠️ Enregistrement interrompu » avec **🔴 Reprendre l'enregistrement**. Chaque reprise est une nouvelle session, réunie aux autres dans le compte rendu. |

Contrainte Discord : un bot ne peut être que dans **un vocal par serveur** à la fois, donc un seul enregistrement par serveur.

## Conservation et espace disque

Une purge quotidienne (4 h 17) supprime les fichiers locaux selon `retention` dans le YAML, réglable par serveur :

- les prises de parole brutes 30 jours après la réunion, seulement si celle-ci est close et que l'audio complet et la transcription sont faits ;
- l'audio complet au bout d'un an.

Les copies publiées dans Discord et dans le [stockage du serveur](stockage.md) restent. Une alerte est émise si l'espace libre passe sous `diskMinFreeGb`.

Les pistes sont écrites dans `dataDir/recordings/<serveur>/<session>/<utilisateur>/`, soit le volume `recordings` en Docker. Compter :

- environ **3,3 Mo par 10 minutes et par personne** (Opus à ~43 kbit/s, mesuré) ;
- plus l'audio complet de la réunion, environ 2 Mo par 10 minutes ;
- pendant la réunion, un mix sans perte d'environ 38 Mo par 10 minutes, qui permet d'ajouter chaque nouvelle session sans tout remixer. Il est supprimé dès que le compte rendu de la réunion close est publié.

Une réunion d'une heure à 6 personnes occupe donc environ 130 Mo, dont les pistes brutes sont purgées après 30 jours (`retention.rawTracksDays`). Le bot refuse de démarrer un enregistrement sous le seuil `diskMinFreeGb` (5 Go) et alerte toutes les 10 minutes si l'espace baisse pendant une capture.

## Écouter une session (débogage)

`npx tsx --env-file=.env scripts/assemble.ts <recordingId>` reconstitue une piste continue par participant et un mix dans `…/<session>/assembled/` ; il nécessite ffmpeg. L'id de session se trouve dans la table `recordings` (`npm run db:studio`).

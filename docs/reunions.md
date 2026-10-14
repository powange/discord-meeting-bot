# Réunions

[← Retour au README](../README.md)

Tout se passe dans un **salon forum** : un post épinglé pour créer les réunions, puis un post par réunion.

| Fonction | Détail |
|---|---|
| Post épinglé | Créé quand on choisit le forum dans `/config` : bouton **Nouvelle réunion** et liste chronologique des réunions à venir. Personne ne peut y écrire : tout message posté est supprimé (le post n'est pas verrouillé, sinon les membres ne pourraient plus cliquer). Le bot le surveille : supprimé (ou son message effacé), il est recréé aussitôt ; désépinglé, verrouillé ou archivé, il est rétabli ; vérification complète au démarrage puis toutes les 15 min. |
| Nouvelle réunion | Bouton du post épinglé. Formulaire : titre, jour (les 24 prochains jours, ou « 📅 Autre date… »), horaire (`18h` ou `18h-19h30` ; avec « Autre date » : `15/01/2027 18h-19h30`, `15/01 18h` ou `15 janv. 18h`), salon vocal (sauf s'il est imposé ou créé automatiquement), description. Une saisie refusée se corrige avec **✏️ Corriger la saisie**, qui rouvre le formulaire prérempli. |
| Sondage de date | Bouton **🗳️ Proposer des dates** du post épinglé, quand la date n'est pas encore connue. Formulaire : titre, créneaux (un par ligne, mêmes formats que « Autre date » : `21/10 18h`, `mar 21/10 18h-19h30`, `15 janv. 18h` ; 2 à 10), fin des réponses, description. Le post est créé tout de suite (tag « Date à choisir », ordre du jour déjà utilisable) avec une **grille de disponibilités** : pour chaque créneau, chacun répond ✅ disponible, 🟡 si nécessaire ou ❌ pas disponible (bouton **Indiquer mes disponibilités**), le meilleur créneau est marqué ⭐. L'organisateur peut ajouter ou retirer un créneau (⚙️ Gérer). **Rôles invités** : juste après la création (message de confirmation), ou plus tard dans ⚙️ Gérer, l'organisateur choisit jusqu'à 5 rôles invités à répondre, et peut inviter tout le monde avec le bouton « 📣 Inviter tout le monde (@everyone) » (Discord ne propose jamais @everyone dans ses sélecteurs). Un vrai @everyone n'est envoyé que si le bot a la permission « Mentionner @everyone » ; sinon les membres sont mentionnés un par un. Ils sont mentionnés dans le sondage (si un rôle n'est pas mentionnable, ses membres le sont un par un), et ceux qui n'ont pas répondu sont relancés la veille de la fin des réponses, à la place du rôle de relance du serveur. Sans rôle invité, c'est le rôle de relance de `/config` → Rôles qui est relancé. À la fin des réponses, la date est fixée automatiquement s'il y a un meilleur créneau net, sinon l'organisateur est mentionné pour trancher (⚙️ Gérer → **Fixer la date**). La réunion devient alors ordinaire (événement Discord, rappels, salon) et les réponses deviennent des inscriptions (✅ → Présent, 🟡 → Peut-être). Un message **Résultat du sondage** fige la grille dans le post (créneau retenu marqué 📅) ; les réponses restent aussi en base. |
| Rôles invités | Juste après la création (ou la duplication) d'une réunion, le message de confirmation propose de choisir jusqu'à 5 **rôles invités**, et un bouton « 📣 Inviter tout le monde (@everyone) ». Ils sont mentionnés dans le post de la réunion, puis ceux qui n'ont pas répondu sont relancés au premier rappel, à la place du rôle de relance du serveur. Modifiables ensuite dans ⚙️ Gérer tant que la réunion n'a pas commencé. |
| Post de réunion | Titré `Lun. 12/10 · 18h00 · Titre`. Un événement Discord est créé en parallèle. |
| Carte de réunion | Premier message du post, régénéré depuis la BDD : date (affichée dans le fuseau de chaque lecteur), salon, organisateur, réponses, ordre du jour. |
| Réponses | Boutons Présent / Peut-être / Absent, modifiables à tout moment. |
| Ordre du jour | **Ajouter un point** (formulaire titre + détail ; auteur enregistré). **Gérer l'ordre du jour** : l'organisateur ou un gestionnaire peut modifier, monter, descendre, retirer et verrouiller. Chaque participant peut modifier ses propres points tant que l'ODJ n'est pas verrouillé. |
| Tags | `À venir` → `En cours` (à l'heure prévue) → `Terminée` / `Annulée`. |
| Rappels | J-1 et 15 min avant par défaut. Ils mentionnent les présents et les peut-être. Les membres d'un rôle choisi qui n'ont pas répondu peuvent être relancés. |
| ⚙️ Gérer | Bouton de la carte (organisateur ou gestionnaire), qui ouvre un panneau privé : modifier, dupliquer (nouveau jour et horaire, ODJ repris ou non), enregistrement auto oui/non, clore maintenant (avec confirmation), annuler (raison facultative), régénérer le compte rendu. |
| Clôture auto | **Uniquement quand le vocal est vide** depuis 5 min, compté depuis le départ de la dernière personne (ou depuis la fin prévue si personne n'est venu). Une réunion qui déborde n'est jamais coupée tant qu'il reste quelqu'un. |

**Qui peut gérer une réunion ?** Son organisateur, les membres des **rôles gestionnaires** (jusqu'à 5, `/config` → Rôles), et ceux qui ont la permission **Gérer les événements** ou **Gérer le serveur**. Le panneau ⚙️ Gérer permet aussi d'**enregistrer maintenant** (même avant l'heure) ou d'arrêter l'enregistrement ; les actions lourdes (terminer, tout retranscrire, retirer un point, désactiver le résumé) demandent une confirmation. « Dupliquer » propose le même jour la semaine suivante, titre et description modifiables.

> Discord ne sait pas trier les posts d'un forum selon la date de la réunion : seulement par activité récente ou par date de création. L'ordre chronologique se lit dans le post épinglé.

## `/config`

**Le bot n'a qu'une seule commande, `/config`** : tout le reste passe par des boutons. Elle est réservée à « Gérer le serveur » et ouvre un **panneau interactif**. L'accueil résume tous les réglages ; un menu ouvre chaque section :

- **Forum des réunions**.
- **Salon vocal** : au choix de l'organisateur, imposé, ou **créé automatiquement** (un salon au nom de la réunion, dans la catégorie choisie, N min avant le début, supprimé une fois la réunion finie et le salon vide).
- **Rôles** : gestionnaires, rôle relancé.
- **Rappels**, **Général** (fuseau, durée, création), **Enregistrement** (démarrage auto, refus d'enregistrement).
- **Transcription** et **Résumé** : voir [docs/ia.md](ia.md).
- **Stockage** : voir [docs/stockage.md](stockage.md).
- **Alertes** : voir [docs/exploitation.md](exploitation.md#supervision).

Les réglages se font avec des sélecteurs de salon et de rôle, des boutons et de petits formulaires.

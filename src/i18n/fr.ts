import type { MeetingStatus, RsvpStatus } from '../domain/types.js';

export const fr = {
  status: {
    scheduled: 'À venir',
    live: 'En cours',
    ended: 'Terminée',
    cancelled: 'Annulée',
  } satisfies Record<MeetingStatus, string>,

  rsvp: {
    yes: 'Présent',
    maybe: 'Peut-être',
    no: 'Absent',
  } satisfies Record<RsvpStatus, string>,

  card: {
    when: 'Date',
    duration: 'Durée',
    voice: 'Salon vocal',
    organizer: 'Organisateur',
    agenda: 'Ordre du jour',
    agendaLocked: 'Ordre du jour 🔒',
    agendaEmpty: 'Aucun point pour le moment.',
    agendaHint: 'Tout le monde peut proposer un point avec « Ajouter un point ».',
    agendaBy: (userId: string) => `proposé par <@${userId}>`,
    nobody: '—',
    more: (n: number) => `… et ${n} de plus`,
    autoRecord: '🔴 Enregistrement automatique au démarrage',
    recording: (since: string) => `🔴 **Enregistrement en cours** depuis ${since}`,
    footer: (status: string) => `Statut : ${status}`,
    minutes: (n: number) => (n % 60 === 0 ? `${n / 60} h` : n > 60 ? `${Math.floor(n / 60)} h ${n % 60}` : `${n} min`),
  },

  buttons: {
    addItem: 'Ajouter un point',
    manageAgenda: "Gérer l'ODJ",
    edit: 'Modifier',
    moveUp: 'Monter',
    moveDown: 'Descendre',
    remove: 'Retirer',
    lock: "Verrouiller l'ODJ",
    unlock: "Déverrouiller l'ODJ",
    joinVoice: 'Rejoindre le vocal',
    record: 'Enregistrer',
    stopRecording: "Arrêter l'enregistrement",
    resumeRecording: "Reprendre l'enregistrement",
  },

  modal: {
    createTitle: 'Nouvelle réunion',
    editTitle: 'Modifier la réunion',
    title: 'Titre',
    day: 'Jour',
    dayPlaceholder: 'Choisir un jour',
    today: "aujourd'hui",
    tomorrow: 'demain',
    time: 'Horaire',
    timePlaceholder: '18h ou 18h-19h30',
    timeHint: (duration: string, tz: string) => `Début, ou début-fin. Sans heure de fin : ${duration}. (${tz})`,
    voice: 'Salon vocal',
    description: 'Description',
    descriptionHint: 'Optionnel : contexte, documents à lire…',
    agendaTitle: "Ajouter un point à l'ordre du jour",
    itemTitle: 'Titre du point',
    itemDetail: 'Détail',
    itemDetailHint: 'Optionnel',
  },

  hub: {
    threadName: '📌 Planifier une réunion',
    title: 'Réunions',
    intro:
      'Cliquez sur **Nouvelle réunion** pour planifier une réunion (ou utilisez `/reunion creer`).\n' +
      'Chaque réunion a son propre post : inscriptions, ordre du jour et rappels.',
    upcoming: 'Prochaines réunions',
    none: 'Aucune réunion prévue.',
    live: 'en cours',
    create: 'Nouvelle réunion',
  },

  agendaManager: {
    title: "Gestion de l'ordre du jour",
    pick: 'Choisir un point…',
    empty: "L'ordre du jour est vide.",
    selected: (title: string) => `Point sélectionné : **${title}**`,
  },

  replies: {
    created: (threadId: string) => `Réunion créée : <#${threadId}>`,
    updated: 'Réunion mise à jour.',
    cancelled: 'Réunion annulée.',
    ended: 'Réunion close.',
    duplicated: (threadId: string) => `Nouvelle réunion créée : <#${threadId}>`,
    itemAdded: (title: string) => `Point ajouté : **${title}**`,
    rsvpSaved: (label: string) => `Réponse enregistrée : **${label}**`,
    configSaved: 'Configuration enregistrée.',
  },

  // Messages postés dans le fil. Ceux qui notifient restent lisibles dans une notification push :
  // pas de markdown, ni de mention de salon, ni de timestamp Discord (affichés bruts sur mobile).
  thread: {
    cancelled: (title: string, by: string | null, reason: string | null) =>
      `❌ « ${title} » est annulée${by ? ` par ${by}` : ''}.${reason ? `\nRaison : ${reason}` : ''}`,
    started: (title: string, voice: string) => `🟢 « ${title} » commence maintenant dans 🔊 ${voice} !`,
    ended: (by: string | null) => (by ? `✅ Réunion close par ${by}.` : '✅ Réunion close automatiquement.'),
    rescheduled: (title: string, when: string, startsIn: string) => `📅 « ${title} » est déplacée au ${when} (${startsIn}).`,
    reminder: (title: string, startsIn: string, when: string, voice: string) => `⏰ « ${title} » commence ${startsIn} (${when}) dans 🔊 ${voice}.`,
    reminderTargets: 'Inscrits :',
    responders: 'Ont répondu :',
    nudge: "Pas encore de réponse — merci d'indiquer votre présence :",
    voiceFallback: 'le salon vocal',
  },

  recording: {
    warning: (optoutRole: string | null) =>
      '🔴 Cette réunion est enregistrée (une piste audio par participant) pour en produire le compte rendu.' +
      (optoutRole
        ? `\nPour ne pas être enregistré : \`/enregistrement refuser\` (rôle « ${optoutRole} »). Votre présence reste notée, pas votre voix.`
        : ''),
    started: (by: string | null) => (by ? `🔴 Enregistrement démarré par ${by}.` : '🔴 Enregistrement démarré automatiquement.'),
    summaryTitle: (reason: string) => `⏹️ Enregistrement terminé (${reason})`,
    reasons: {
      manual: 'arrêt manuel',
      empty: 'vocal vide',
      meeting_end: 'réunion close',
      shutdown: 'redémarrage du bot',
      disconnected: 'déconnexion du vocal',
      crash: 'arrêt inattendu du bot',
    } as Record<string, string>,
    summaryLine: (duration: string, speakers: number, segments: number) =>
      `Durée ${duration} · ${speakers} personne(s) enregistrée(s) · ${segments} prise(s) de parole`,
    came: 'Inscrits présents',
    noShow: 'Inscrits absents',
    unannounced: 'Venus sans inscription',
    notRecorded: 'Non enregistrés (opt-out)',
    interrupted: "⚠️ L'enregistrement a été interrompu. Les prises de parole déjà captées sont conservées.",
    autoStartFailed: (reason: string) => `⚠️ Démarrage automatique de l'enregistrement impossible : ${reason}`,
    started_reply: 'Enregistrement démarré.',
    stopped_reply: 'Enregistrement arrêté.',
    autoSet: (on: boolean) =>
      on ? 'Enregistrement automatique activé pour cette réunion.' : 'Enregistrement automatique désactivé pour cette réunion.',
    optoutAdded: (role: string) => `Vous ne serez plus enregistré (rôle « ${role} » ajouté). Votre présence reste notée.`,
    optoutRemoved: (role: string) => `Rôle « ${role} » retiré : vous serez de nouveau enregistré.`,
  },

  format: {
    /** Format Luxon d'une date lisible : « lundi 12/10 à 18h00 ». */
    when: "cccc dd/MM 'à' HH'h'mm",
    startsIn: (min: number) =>
      min < 1 ? 'maintenant' : min < 90 ? `dans ${min} min` : min < 36 * 60 ? `dans ${Math.round(min / 60)} h` : `dans ${Math.round(min / 1440)} jours`,
  },



  event: {
    description: (url: string, description: string) => `Inscriptions et ordre du jour : ${url}${description ? `\n\n${description}` : ''}`,
  },

  errors: {
    generic: (ref: string) => `Une erreur inattendue est survenue (réf. \`${ref}\`).`,
    forumNotConfigured: "Le forum des réunions n'est pas configuré : un administrateur doit utiliser `/config forum`.",
    tagsMissing: "Les tags du forum sont introuvables : relancez `/config forum`.",
    notInMeetingThread: "Cette commande s'utilise dans le post d'une réunion.",
    meetingNotFound: 'Réunion introuvable.',
    forbidden: "Seuls l'organisateur et les gestionnaires peuvent faire ça.",
    cannotCreate: 'La création de réunions est réservée aux gestionnaires.',
    dateFormat: 'Date illisible. Format attendu : `JJ/MM/AAAA HH:MM` (ex. `15/10/2026 18:30`).',
    dateInvalid: "Cette date n'existe pas.",
    dayRequired: 'Choisissez un jour.',
    timeFormat: 'Horaire illisible. Exemples : `18h`, `18:30`, `18h-19h30`.',
    datePast: 'La date doit être dans le futur.',
    duration: (min: number, max: number) => `Durée invalide : un nombre de minutes entre ${min} et ${max}.`,
    voiceRequired: 'Choisissez un salon vocal.',
    voiceInvalid: "Ce salon n'est pas un salon vocal de ce serveur.",
    fixedVoiceMissing: "Le salon vocal imposé par la configuration n'existe plus : un administrateur doit utiliser `/config vocal`.",
    titleRequired: 'Le titre est obligatoire.',
    meetingClosed: 'Cette réunion est terminée ou annulée.',
    cannotReschedule: 'La date, la durée et le salon ne se modifient plus une fois la réunion commencée.',
    agendaLocked: "L'ordre du jour est verrouillé.",
    agendaFull: "L'ordre du jour est plein (25 points maximum).",
    agendaEmptyTitle: 'Le titre du point est obligatoire.',
    agendaItemGone: "Ce point n'existe plus.",
    alreadyInState: 'La réunion est déjà dans cet état.',
    offsets: (input: string) =>
      `Délais illisibles : « ${input} ». Exemples : \`1j, 15min\`, \`1 jour et 15 minutes\`, \`24h, 1h30\` ou \`aucun\` (5 délais max, 14 jours max).`,
    timezone: 'Fuseau horaire inconnu (ex. `Europe/Paris`).',
    forumPermissions: (perms: string) => `Il me manque des permissions sur ce forum : ${perms}.`,
    recordingBusy: 'Un enregistrement est déjà en cours sur ce serveur (un bot ne peut être que dans un vocal à la fois).',
    alreadyRecording: 'Cette réunion est déjà en cours d’enregistrement.',
    notRecording: "Cette réunion n'est pas en cours d'enregistrement.",
    voicePermissions: (perms: string) => `Il me manque des permissions sur le salon vocal : ${perms}.`,
    voiceJoinFailed: 'Connexion au salon vocal impossible (délai dépassé). Réessayez dans un instant.',
    optoutNotConfigured: "Aucun rôle « ne pas m'enregistrer » n'est configuré : un administrateur doit utiliser `/config roles`.",
    optoutRoleUnmanageable: "Je ne peux pas attribuer ce rôle : il doit être placé sous mon rôle et j'ai besoin de la permission « Gérer les rôles ».",
  },

  config: {
    title: 'Configuration du serveur',
    forum: 'Forum des réunions',
    managerRole: 'Rôle gestionnaire',
    optoutRole: 'Rôle « ne pas m’enregistrer »',
    nudgeRole: 'Rôle relancé si pas de réponse',
    creators: 'Création de réunions',
    creatorsAll: 'Tout le monde',
    creatorsManagers: 'Gestionnaires uniquement',
    timezone: 'Fuseau horaire',
    voice: 'Salon vocal des réunions',
    voiceFree: 'au choix de l’organisateur',
    voiceSet: (id: string) => `Toutes les réunions se tiendront dans <#${id}> (le choix du salon n'est plus proposé).`,
    voiceCleared: 'Le salon vocal est de nouveau au choix de l’organisateur.',
    reminders: 'Rappels avant la réunion',
    duration: 'Durée par défaut',
    autoRecord: 'Enregistrement auto par défaut',
    none: 'non défini',
    yes: 'Oui',
    no: 'Non',
    forumReady: (forumId: string, hubId: string) =>
      `Forum configuré : <#${forumId}>. Tags de statut prêts, post épinglé <#${hubId}> créé avec le bouton « Nouvelle réunion ».`,
  },
};

export type Messages = typeof fr;

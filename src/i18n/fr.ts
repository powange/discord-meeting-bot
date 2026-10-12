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
    minutes: (n: number) => (n > 0 && n % 60 === 0 ? `${n / 60} h` : n > 60 ? `${Math.floor(n / 60)} h ${n % 60}` : `${n} min`),
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

  control: {
    idle: "🎙️ **Enregistrement** — non démarré. L'organisateur ou un gestionnaire peut l'enregistrer (une piste par participant).",
    recording: (since: string) => `🔴 **Enregistrement en cours** depuis ${since}.`,
    closed: '🎙️ Réunion close : enregistrement terminé.',
  },

  recording: {
    warning: (optoutRole: string | null) =>
      '🔴 Cette réunion est enregistrée (une piste audio par participant) pour en produire le compte rendu.' +
      (optoutRole
        ? `\nPour ne pas être enregistré : \`/enregistrement refuser\` (rôle « ${optoutRole} »). Votre présence reste notée, pas votre voix.`
        : ''),
    started: (by: string | null) => (by ? `🔴 Enregistrement démarré par ${by}.` : '🔴 Enregistrement démarré automatiquement.'),
    reasons: {
      manual: 'arrêt manuel',
      empty: 'vocal vide',
      meeting_end: 'réunion close',
      shutdown: 'redémarrage du bot',
      disconnected: 'déconnexion du vocal',
      crash: 'arrêt inattendu du bot',
    } as Record<string, string>,
    interrupted: "⚠️ L'enregistrement a été interrompu. Les prises de parole déjà captées sont conservées.",
    autoStartFailed: (reason: string) => `⚠️ Démarrage automatique de l'enregistrement impossible : ${reason}`,
    started_reply: 'Enregistrement démarré.',
    stopped_reply: 'Enregistrement arrêté.',
    autoSet: (on: boolean) =>
      on ? 'Enregistrement automatique activé pour cette réunion.' : 'Enregistrement automatique désactivé pour cette réunion.',
    optoutAdded: (role: string) => `Vous ne serez plus enregistré (rôle « ${role} » ajouté). Votre présence reste notée.`,
    optoutRemoved: (role: string) => `Rôle « ${role} » retiré : vous serez de nouveau enregistré.`,
  },

  summary: {
    title: (meeting: string) => `## ⏹️ Enregistrement · ${meeting}`,
    status: { stopped: '🟢 Terminé', interrupted: '🟠 Interrompu' },
    subtitle: (status: string, reason: string, from: string, to: string, duration: string, people: number, segments: number) =>
      `-# ${status} · ${reason} · ${from} → ${to} · ${duration} · ${people} participant${people > 1 ? 's' : ''} · ${segments} prise${segments > 1 ? 's' : ''} de parole`,
    participation: '### Participation',
    participant: (who: string, pct: number, bar: string, speech: string, presence: string, presencePct: number) =>
      `**${pct} %** ${bar} ${who} · 🗣️ ${speech} · ⏱️ ${presence} (${presencePct} %)`,
    notRecorded: (who: string, presence: string, presencePct: number) => `🔇 ${who} · non enregistré · ⏱️ ${presence} (${presencePct} %)`,
    unannounced: 'non inscrit',
    lossWarning: (pct: number) => `⚠️ audio possiblement incomplet : ≈ ${pct} % des paquets n'ont pas pu être déchiffrés (chiffrement Discord). La transcription peut avoir des trous.`,
    noShow: '### Inscrits absents',
    nobody: "Personne n'a été enregistré.",
    footnote: '-# % : part du temps de parole total · 🗣️ temps de parole · ⏱️ présence dans le vocal (part de la durée).',
  },

  backendPanel: {
    title: '🎙️ Serveurs de transcription',
    footer: "L'ordre de la liste est l'ordre de bascule : en cas d'erreur, de lenteur ou de serveur occupé, le suivant prend le relais.",
    empty: 'Aucun serveur. Cliquez sur « Ajouter ».',
    fromYaml: '*Serveurs du fichier de configuration (le premier ajout ici les remplace) :*',
    withKey: '🔑 clé',
    disabled: 'désactivé',
    full: (max: number) => `Maximum ${max} serveurs : supprimez-en un pour en ajouter un autre.`,
    up: 'Monter',
    down: 'Descendre',
    enable: 'Activer',
    disable: 'Désactiver',
    test: 'Tester',
    delete: 'Supprimer',
    confirmDelete: (name: string) => `Supprimer « ${name} »`,
    cancel: 'Annuler',
    add: 'Ajouter',
    edit: 'Modifier',
    testAll: 'Tout tester',
    testing: '🧪 Test en cours…',
    forbidden: "Réservé aux membres ayant la permission « Gérer le serveur ».",
    ownersOnly: 'Seuls les propriétaires du bot peuvent modifier les serveurs de transcription (ce sont des adresses que le bot appelle sur leur réseau).',
    readOnly: 'Consultation seule : la liste est gérée par les propriétaires du bot.',
    modalAdd: 'Ajouter un serveur de transcription',
    modalEdit: 'Modifier le serveur',
    fieldName: 'Nom',
    fieldType: 'Type',
    typeVibe: 'Vibe (vibe-server)',
    typeVibeHint: 'http://hôte:8080 — modèle préchargé, une requête à la fois',
    typeOpenai: 'Compatible OpenAI',
    typeOpenaiHint: 'speaches, faster-whisper… — http://hôte:8000/v1',
    fieldUrl: 'URL',
    fieldUrlHint: 'Vibe : http://hôte:8080 · OpenAI : http://hôte:8000/v1',
    fieldModel: 'Modèle (serveur compatible OpenAI)',
    fieldModelHint: 'Ignoré par Vibe. Ex. Systran/faster-whisper-large-v3',
    fieldKey: "Clé d'API",
    fieldKeyHint: 'Optionnelle',
    fieldKeyEditHint: 'Vide : clé inchangée · « - » : supprimer la clé',
    deleted: (name: string) => `🗑️ « ${name} » supprimé.`,
    verdict: (r: { healthy: boolean; transcribeMs?: number; model?: string; error?: string }) =>
      !r.healthy
        ? `❌ ${r.error}`
        : r.error
          ? `⚠️ Joignable, mais la transcription a échoué : ${r.error}`
          : `✅ Opérationnel · transcription en ${((r.transcribeMs ?? 0) / 1000).toFixed(1)} s${r.model ? ` · ${r.model}` : ''}`,
    saved: (name: string) => `✏️ « ${name} » mis à jour.`,
  },

  transcriptionConfig: {
    badUrl: 'URL invalide : http(s)://hôte:port (vibe) ou http(s)://hôte:port/v1 (openai).',
    exists: (name: string) => `Un serveur « ${name} » existe déjà.`,
    unknown: (name: string) => `Serveur « ${name} » introuvable.`,
    added: (name: string, position: number) => `➕ « ${name} » ajouté en position ${position}.`,
    backToYaml: "Plus aucun serveur ici : ceux du fichier de configuration s'appliquent de nouveau.",
  },

  report: {
    title: 'Compte rendu',
    offAgenda: 'hors ordre du jour',
    decisions: 'Décisions',
    actions: 'Actions',
    questions: 'Questions ouvertes',
    notCovered: 'Points non traités',
    empty: "Aucun contenu exploitable n'a été retenu de la transcription.",
    subtitle: (when: string, duration: string, people: number) => `${when} · ${duration} · ${people} participant${people > 1 ? 's' : ''}`,
    trace: (transcription: string, llm: string, passes: number) =>
      `Transcription : ${transcription} · Résumé : ${llm} · ${passes} passe${passes > 1 ? 's' : ''}`,
    noSpeech: 'Aucune parole enregistrée : pas de compte rendu.',
    listen: "Écouter l'audio",
  },

  audio: {
    published: (duration: string) => `🎧 **Audio complet de la réunion** · ${duration}`,
    tooLarge: (duration: string, mb: number) =>
      `🎧 Audio complet de la réunion (${duration}, ${mb} Mo) : trop lourd pour être envoyé sur Discord, il est conservé sur le serveur.`,
  },

  alerts: {
    stepFailed: (title: string, step: string, error: string, url: string) => `Compte rendu de « ${title} » : l'étape ${step} a échoué (${error}). ${url}`,
    recordingInterrupted: (title: string, reason: string, url: string) => `Enregistrement de « ${title} » interrompu (${reason}). Reprise possible depuis le post : ${url}`,
  },

  pipeline: {
    title: '## 📝 Compte rendu',
    steps: { mix: 'Audio complet', transcribe: 'Transcription', summarize: 'Résumé', publish: 'Publication' } as Record<string, string>,
    progressMix: (duration: string) => `assemblage de ${duration} d'audio`,
    pending: '⬜',
    running: '⏳',
    done: '✅',
    failed: '❌',
    progressTranscribe: (done: number, total: number) => `${done}/${total} bloc${total > 1 ? 's' : ''}`,
    progressSummarize: (pass: number, total: number) => `passe ${pass}/${total}`,
    published: (url: string) => `Compte rendu publié : ${url}`,
    failedHint: "Le traitement s'est arrêté. L'organisateur ou un gestionnaire peut le relancer : seules les étapes en échec sont refaites.",
    retry: 'Relancer',
    scheduled: 'Compte rendu programmé : il sera publié dans le post.',
    nothing: "Aucun enregistrement exploitable pour cette réunion.",
    running_reply: 'Un traitement est déjà en cours pour cette réunion.',
    purged: (when: string) =>
      `Les pistes audio de cette réunion ont été supprimées le ${when} (durée de conservation) : impossible de retranscrire. Le résumé peut être régénéré sans « retranscrire ».`,
  },

  format: {
    /** Durée précise : « 45 s », « 12 min 30 s », « 1 h 05 ». */
    duration: (ms: number) => {
      const s = Math.round(ms / 1000);
      if (s < 60) return `${s} s`;
      const min = Math.floor(s / 60);
      if (min < 60) return s % 60 ? `${min} min ${String(s % 60).padStart(2, '0')} s` : `${min} min`;
      return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
    },
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
    forumNotConfigured: "Le forum des réunions n'est pas configuré : un administrateur doit le choisir dans `/config` → Forum des réunions.",
    tagsMissing: "Les tags du forum sont introuvables : choisissez de nouveau le forum dans `/config`.",
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
    fixedVoiceMissing: "Le salon vocal imposé par la configuration n'existe plus : un administrateur doit le changer dans `/config` → Salon vocal.",
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
    alertChannel: "Je ne peux pas écrire dans ce salon : vérifiez mes permissions (voir le salon, envoyer des messages).",
    voicePermissions: (perms: string) => `Il me manque des permissions sur le salon vocal : ${perms}.`,
    voiceJoinFailed: 'Connexion au salon vocal impossible (délai dépassé). Réessayez dans un instant.',
    optoutNotConfigured: "Aucun rôle « ne pas m'enregistrer » n'est configuré : un administrateur doit le choisir dans `/config` → Rôles.",
    optoutRoleUnmanageable: "Je ne peux pas attribuer ce rôle : il doit être placé sous mon rôle et j'ai besoin de la permission « Gérer les rôles ».",
  },

  config: {
    title: 'Configuration',
    pick: 'Que voulez-vous régler ?',
    current: 'Actuellement',
    back: 'Retour',
    none: 'non défini',
    yes: 'Oui',
    no: 'Non',
    sections: {
      forum: { emoji: '📌', label: 'Forum des réunions', hint: 'Où sont publiées les réunions', help: 'Les réunions y sont publiées ; le bot y crée les tags de statut et le post épinglé « Nouvelle réunion ».' },
      voice: { emoji: '🔊', label: 'Salon vocal', hint: 'Imposer un vocal ou laisser le choix', help: "Imposé : toutes les réunions s'y tiennent et le choix n'est plus proposé. Sinon, l'organisateur choisit." },
      roles: { emoji: '👥', label: 'Rôles', hint: 'Gestionnaires, opt-out, relance', help: "Gestionnaires : gèrent toutes les réunions. Ne pas enregistrer : voix jamais enregistrée. Relance : membres mentionnés s'ils n'ont pas répondu. Videz un sélecteur pour retirer un rôle." },
      reminders: { emoji: '⏰', label: 'Rappels', hint: 'Délais avant la réunion', help: 'Messages envoyés avant la réunion, avec mention des inscrits. Les réunions à venir sont replanifiées.' },
      general: { emoji: '🗓️', label: 'Général', hint: 'Fuseau, durée, création', help: 'Fuseau horaire des dates saisies, durée par défaut, et qui peut créer des réunions.' },
      recording: { emoji: '🔴', label: 'Enregistrement', hint: 'Démarrage automatique par défaut', help: "Valeur par défaut des nouvelles réunions : le bot rejoint le vocal 2 min avant l'heure et enregistre seul. Modifiable réunion par réunion (/reunion enregistrement-auto)." },
      transcription: { emoji: '🎙️', label: 'Transcription', hint: 'Serveurs Vibe / Whisper', help: '' },
      alerts: {
        emoji: '🚨',
        label: 'Alertes',
        hint: 'Où signaler les problèmes',
        help: "Le bot y signale ce qui demande une action : compte rendu en échec, enregistrement coupé, disque presque plein. Une même alerte au plus une fois par heure. Choisissez un salon réservé aux administrateurs.",
      },
    },
    voiceImposed: 'imposé',
    voiceFree: 'au choix de l’organisateur',
    voiceFreeButton: 'Laisser le choix',
    managerRole: 'Gestionnaires',
    optoutRole: 'Ne pas enregistrer',
    nudgeRole: 'Relance',
    creatorsAll: 'création : tout le monde',
    creatorsManagers: 'création : gestionnaires',
    restrictCreation: 'Réserver la création aux gestionnaires',
    openCreation: 'Ouvrir la création à tous',
    autoOn: 'automatique par défaut',
    autoOff: 'manuel par défaut',
    enableAuto: 'Enregistrer automatiquement par défaut',
    disableAuto: 'Revenir au démarrage manuel',
    pickForum: 'Choisir le salon forum…',
    pickVoice: 'Choisir le salon vocal imposé…',
    pickManager: 'Rôle gestionnaire (vide : aucun)',
    pickOptout: 'Rôle « ne pas m’enregistrer » (vide : aucun)',
    pickNudge: 'Rôle relancé si pas de réponse (vide : aucun)',
    pickAlerts: "Choisir le salon d'alertes…",
    alertsTest: 'Envoyer une alerte de test',
    alertsClear: 'Désactiver les alertes',
    alertsTestMessage: 'Alerte de test : ce salon recevra les problèmes du bot de réunions.',
    alertsTestSent: (id: string) => `✅ Alerte de test envoyée dans <#${id}>.`,
    editReminders: 'Modifier les délais',
    editGeneral: 'Modifier fuseau et durée',
    remindersModal: 'Rappels avant la réunion',
    remindersField: 'Délais',
    remindersHint: 'ex. « 1j, 15min », « 1 jour et 2h » ; « aucun » pour désactiver',
    generalModal: 'Réglages généraux',
    timezoneField: 'Fuseau horaire',
    timezoneHint: 'Format IANA, ex. Europe/Paris, Europe/Brussels, America/Montreal',
    durationField: 'Durée par défaut (minutes)',
    saved: '✅ Enregistré.',
    forumReady: (forumId: string, hubId: string) => `✅ Forum <#${forumId}> prêt : tags de statut créés, post épinglé <#${hubId}>.`,
    transcriptionSummary: (active: number, names: string) => (active ? `${active} actif${active > 1 ? 's' : ''} : ${names}` : 'aucun serveur'),
    fromYamlSummary: (names: string) => `fichier de configuration : ${names}`,
  },

};

export type Messages = typeof fr;

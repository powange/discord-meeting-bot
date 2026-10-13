export interface Actor {
  userId: string;
  roleIds: readonly string[];
  /** Permission Discord « Gérer les événements » ou « Gérer le serveur » (ou Administrateur). */
  canManageEvents: boolean;
}

export interface PermissionSettings {
  managerRoleIds: readonly string[];
  creatorsRestricted: boolean;
}

export function isManager(actor: Actor, settings: PermissionSettings): boolean {
  return actor.canManageEvents || settings.managerRoleIds.some((id) => actor.roleIds.includes(id));
}

/** Organisateur de la réunion, rôle gestionnaire ou permission « Gérer les événements ». */
export function canManageMeeting(meeting: { organizerId: string }, actor: Actor, settings: PermissionSettings): boolean {
  return meeting.organizerId === actor.userId || isManager(actor, settings);
}

export function canCreateMeeting(actor: Actor, settings: PermissionSettings): boolean {
  return !settings.creatorsRestricted || isManager(actor, settings);
}

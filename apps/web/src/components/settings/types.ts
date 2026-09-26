export type Role = {
  id: string;
  key: string;
  name: string;
  isSystem: boolean;
  permissions: string[];
  memberCount: number;
};
export type Member = {
  id: string;
  createdAt: string;
  user: { id: string; email: string; name: string; lastLoginAt: string | null };
  role: { id: string; key: string; name: string };
};
export type Invitation = {
  id: string;
  email: string;
  expiresAt: string;
  role: { id: string; key: string; name: string };
};
export type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};
export type AuditEntry = {
  id: string;
  actorType: string;
  action: string;
  entityType: string;
  entityId: string | null;
  createdAt: string;
  ip: string | null;
};
export type Page<T> = { items: T[]; nextCursor: string | null };

export const fmtDate = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso))
    : "—";

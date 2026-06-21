import type {
  DocCreatePayload,
  DocFull,
  DocSavePayload,
  DocSaveResponse,
  DocSummary,
} from '@boppl/shared';

const API_URL =
  (import.meta.env.PUBLIC_API_URL as string | undefined) ?? 'http://localhost:8080';

// ── Auth token store ──────────────────────────────────────────────────────────
// The JWT is httpOnly so JS can't read the cookie cross-origin. Astro SSR pages
// receive the JWT and pass it as a prop. Call setAuthToken() once on mount and
// every apiFetch / authHeaders() call will include Authorization: Bearer.
let _authToken: string | null = null;

export function setAuthToken(token: string): void {
  _authToken = token;
}

/** Returns `{ Authorization: 'Bearer <token>' }` when a token is set, else `{}`. */
export function authHeaders(): Record<string, string> {
  return _authToken ? { Authorization: `Bearer ${_authToken}` } : {};
}

interface FetchOptions extends Omit<RequestInit, 'body' | 'signal'> {
  body?: BodyInit | object;
  /**
   * Optional AbortSignal so callers (autocomplete in Phase 3.3) can cancel
   * in-flight requests on every keystroke. Forwarded to the underlying
   * fetch so the abort propagates through the network stack.
   */
  signal?: AbortSignal;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(`API ${status}: ${message}`);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function apiFetch<T>(path: string, opts: FetchOptions = {}): Promise<T> {
  const isJsonObject =
    opts.body !== undefined &&
    typeof opts.body === 'object' &&
    !(opts.body instanceof FormData) &&
    !(opts.body instanceof Blob) &&
    !(opts.body instanceof ArrayBuffer);

  const init: RequestInit = {
    ...opts,
    credentials: 'include',
    headers: {
      // Only set a JSON content-type when there's actually a body. Sending
      // Content-Type: application/json with an EMPTY body makes Fastify reject
      // the request with a 400 ("Body cannot be empty…") before the route
      // handler runs — which broke every no-body POST (calendar sync, meeting
      // admit/ignore/dispatch).
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...authHeaders(),
      ...(opts.headers ?? {}),
    },
    body: isJsonObject ? JSON.stringify(opts.body) : (opts.body as BodyInit | undefined),
    // Forward the AbortSignal so .abort() during autocomplete cancels the
    // network call instead of just discarding the resolved promise.
    signal: opts.signal,
  };

  // In the browser use relative paths so requests route through the Astro
  // proxy (pages/api/[...path].ts) which injects the JWT from the sealed
  // session cookie. On the server (SSR) hit API_URL directly.
  const base = typeof window === 'undefined' ? API_URL : '';
  const res = await fetch(`${base}${path}`, init);
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(res.status, text || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Same as apiFetch but targets a same-origin (web) endpoint instead of the
 * API server. Used for endpoints like /auth/switch-workspace that need to
 * touch the web tier's sealed boppl_session cookie.
 */
async function webFetch<T>(path: string, opts: FetchOptions = {}): Promise<T> {
  const isJsonObject =
    opts.body !== undefined &&
    typeof opts.body === 'object' &&
    !(opts.body instanceof FormData) &&
    !(opts.body instanceof Blob) &&
    !(opts.body instanceof ArrayBuffer);

  const init: RequestInit = {
    ...opts,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
    },
    body: isJsonObject ? JSON.stringify(opts.body) : (opts.body as BodyInit | undefined),
    signal: opts.signal,
  };
  const res = await fetch(path, init);
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(res.status, text || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface CompletionRequest {
  prefix: string;
  suffix: string;
  doc_id: string;
}

export interface CompletionResponse {
  text: string;
}

// ---------------------------------------------------------------------------
// Phase 4.1 types — invitations, members, workspaces.
// ---------------------------------------------------------------------------

export type Role = 'owner' | 'editor' | 'viewer';

export interface WorkspaceSummary {
  id: string;
  slug: string;
  name: string;
  role: Role;
}

export interface InvitationRow {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  invitedBy: string;
  createdAt: string;
}

export interface MemberRow {
  userId: string;
  role: Role;
  email: string;
  displayName: string | null;
  joinedAt: string;
}

// Stage B5 — per-project access control.
export type ProjectRole = 'viewer' | 'editor' | 'admin';

export interface ProjectMemberRow {
  userId: string;
  role: ProjectRole;
  email: string;
  displayName: string | null;
  joinedAt: string;
}

// Phase B — Org / IAM.
export interface FolderAccess { folder_slug: string; permission: 'read' | 'write' | 'admin' | 'none' }
export interface OrgTeam { id: string; name: string; slug: string; description: string | null; parentTeamId: string | null; color: string | null }
export interface OrgRole { id: string; name: string; slug: string; teamId: string | null; workspaceRole: string; defaultFolderAccess: FolderAccess[] }
export interface OrgPerson { userId: string; displayName: string | null; email: string; displayTitle: string | null; roleSlug: string | null; department: string | null; botDisplayName: string | null }
export interface OrgFolder { id: string; name: string; slug: string | null; folderType: string | null }
export interface OrgGrant { id: string; resourceType: string; resourceId: string; principalType: string; principalId: string; permission: string }
export interface OrgAuditEntry { id: string; actorUserId: string | null; action: string; resourceType: string | null; resourceId: string | null; payload: unknown; createdAt: string }
export interface OrgStructure {
  teams: Array<{ name: string; slug?: string; parent_slug?: string | null; color?: string }>;
  roles: Array<{ name: string; slug?: string; team_slug?: string | null; workspace_role?: string; default_folder_access?: FolderAccess[] }>;
  people: Array<{ name: string; email?: string | null; department?: string | null; job_title?: string | null; manager_email?: string | null; role_slug?: string | null }>;
}

// Phase 2b — meetings + identity mapping.
export interface MeetingRow {
  id: string;
  title: string | null;
  meeting_url: string | null;
  started_at: string;
  ended_at: string | null;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
  status: string | null;          // 'scheduled' | 'live' | 'ended' | 'ignored' | …
  admitted: boolean | null;
  calendar_event_id: string | null;
  participant_count: number;
  unresolved_count: number;
}

export interface MeetingParticipantRow {
  id: string;
  name: string | null;
  email: string | null;
  isHost: boolean;
  resolvedUserId: string | null;
  resolvedEmail: string | null;
  resolvedName: string | null;
}

export const api = {
  listDocs: (): Promise<{ docs: DocSummary[] }> => apiFetch('/api/docs'),
  createDoc: (body: DocCreatePayload): Promise<{ doc: DocFull }> =>
    apiFetch('/api/docs', { method: 'POST', body }),
  getDoc: (id: string): Promise<{ doc: DocFull }> => apiFetch(`/api/docs/${id}`),
  saveDoc: (id: string, body: DocSavePayload): Promise<{ doc: DocSaveResponse }> =>
    apiFetch(`/api/docs/${id}`, { method: 'POST', body }),
  // Phase 3.3: stub backend; Phase 3.4 swaps the path for the SSE endpoint.
  complete: (body: CompletionRequest, signal: AbortSignal): Promise<CompletionResponse> =>
    apiFetch('/api/complete/_stub', { method: 'POST', body, signal }),

  // -------------------------------------------------------------------------
  // Phase 4.1 — workspaces, invitations, members
  // -------------------------------------------------------------------------
  listWorkspaces: (): Promise<{ workspaces: WorkspaceSummary[] }> =>
    apiFetch('/api/auth/workspaces'),
  // Note: switch + create go through the WEB tier (not the API directly).
  // The web endpoint forwards to the API, then re-seals boppl_session with
  // the new tenant_id and JWT — otherwise the server-rendered /app keeps
  // reading the old workspace from the sealed session on next reload.
  switchWorkspace: (
    workspace_id: string,
  ): Promise<{ workspace: { id: string; slug: string; name: string } }> =>
    webFetch('/auth/switch-workspace', { method: 'POST', body: { workspace_id } }),
  createWorkspace: (body: {
    name: string;
    slug?: string;
  }): Promise<{ workspace: { id: string; slug: string; name: string } }> =>
    webFetch('/auth/create-workspace', { method: 'POST', body }),

  listInvitations: (): Promise<{ invitations: InvitationRow[] }> =>
    apiFetch('/api/invitations'),
  createInvitation: (body: {
    email: string;
    role: Role;
    /** Person's name → stored as the invitation's display title. */
    name?: string;
    /** Optional org role; the backend derives the team from it. */
    orgRoleId?: string | null;
    teamId?: string | null;
  }): Promise<{ invitation: { id: string; email: string; role: Role; expires_at: string } }> =>
    apiFetch('/api/invitations', {
      method: 'POST',
      body: {
        email: body.email,
        role: body.role,
        ...(body.name ? { display_title: body.name } : {}),
        ...(body.orgRoleId ? { org_role_id: body.orgRoleId } : {}),
        ...(body.teamId ? { team_id: body.teamId } : {}),
      },
    }),
  revokeInvitation: (id: string): Promise<{ revoked: true }> =>
    apiFetch(`/api/invitations/${id}`, { method: 'DELETE' }),
  acceptInvitation: (token: string): Promise<{ workspace_id: string }> =>
    apiFetch('/api/invitations/accept', { method: 'POST', body: { token } }),

  listMembers: (): Promise<{ members: MemberRow[] }> => apiFetch('/api/members'),
  updateMemberRole: (userId: string, role: Role): Promise<{ member: MemberRow }> =>
    apiFetch(`/api/members/${userId}/role`, { method: 'PATCH', body: { role } }),
  removeMember: (userId: string): Promise<{ removed: true }> =>
    apiFetch(`/api/members/${userId}`, { method: 'DELETE' }),

  // Phase B — Org structure + IAM
  orgStructure: (): Promise<{ teams: OrgTeam[]; roles: OrgRole[]; people: OrgPerson[] }> =>
    apiFetch('/api/org/structure'),
  setOrgPerson: (userId: string, body: { orgRoleId?: string | null; displayTitle?: string | null; department?: string | null; managerUserId?: string | null }): Promise<{ ok: true }> =>
    apiFetch(`/api/org/people/${userId}`, { method: 'PATCH', body }),
  orgTeams: (): Promise<{ teams: OrgTeam[] }> => apiFetch('/api/org/teams'),
  createTeam: (body: { name: string; color?: string }): Promise<{ team: OrgTeam }> =>
    apiFetch('/api/org/teams', { method: 'POST', body }),
  deleteTeam: (id: string): Promise<{ ok: true }> => apiFetch(`/api/org/teams/${id}`, { method: 'DELETE' }),
  orgRoles: (): Promise<{ roles: OrgRole[] }> => apiFetch('/api/org/roles'),
  createOrgRole: (body: { name: string; teamId?: string | null; workspaceRole?: string; defaultFolderAccess?: FolderAccess[] }): Promise<{ role: OrgRole }> =>
    apiFetch('/api/org/roles', { method: 'POST', body }),
  updateOrgRole: (id: string, body: { defaultFolderAccess?: FolderAccess[]; workspaceRole?: string; teamId?: string | null }): Promise<{ role: OrgRole }> =>
    apiFetch(`/api/org/roles/${id}`, { method: 'PATCH', body }),
  deleteOrgRole: (id: string): Promise<{ ok: true }> => apiFetch(`/api/org/roles/${id}`, { method: 'DELETE' }),
  orgFolders: (): Promise<{ folders: OrgFolder[] }> => apiFetch('/api/org/folders'),
  orgAccess: (): Promise<{ grants: OrgGrant[] }> => apiFetch('/api/org/access'),
  setOrgAccess: (body: { principalType: 'user' | 'team' | 'org_role'; principalId: string; resourceType?: string; resourceId: string; permission: string }): Promise<{ ok: true }> =>
    apiFetch('/api/org/access', { method: 'POST', body }),
  orgAudit: (): Promise<{ entries: OrgAuditEntry[] }> => apiFetch('/api/org/audit'),
  orgImportExtract: (body: { type: 'description' | 'image'; text?: string; file_url?: string }): Promise<{ import_id: string; extracted_structure: OrgStructure; valid: boolean }> =>
    apiFetch('/api/org/import/extract', { method: 'POST', body }),
  orgImportApply: (body: { import_id?: string; confirmed_structure: OrgStructure }): Promise<{ ok: true; created: Record<string, number> }> =>
    apiFetch('/api/org/import/apply', { method: 'POST', body }),

  // Phase 2b — meetings + post-meeting identity mapping
  listMeetings: (): Promise<{ meetings: MeetingRow[] }> => apiFetch('/api/meetings'),
  // Phase C — calendar linking + admit/dispatch
  calendarStatus: (): Promise<{ connected: boolean; configured: boolean }> => apiFetch('/api/calendar/status'),
  calendarSync: (): Promise<{ ok: true; created: number; updated: number; total: number }> =>
    apiFetch('/api/calendar/sync', { method: 'POST' }),
  admitMeeting: (id: string): Promise<{ ok: true; botDispatched: boolean; minutesUntilStart: number | null }> =>
    apiFetch(`/api/meetings/${id}/admit`, { method: 'POST' }),
  ignoreMeeting: (id: string): Promise<{ ok: true }> =>
    apiFetch(`/api/meetings/${id}/ignore`, { method: 'POST' }),
  dispatchMeetingBot: (id: string): Promise<{ ok: true }> =>
    apiFetch(`/api/meetings/${id}/dispatch`, { method: 'POST' }),
  listMeetingParticipants: (
    meetingId: string,
  ): Promise<{ participants: MeetingParticipantRow[] }> =>
    apiFetch(`/api/meetings/${meetingId}/participants`),
  mapMeetingParticipant: (
    meetingId: string,
    participantId: string,
    userId: string,
  ): Promise<{ ok: true }> =>
    apiFetch(`/api/meetings/${meetingId}/participants/${participantId}/identity`, {
      method: 'POST',
      body: { user_id: userId },
    }),

  // Stage B5 — project members / access
  listProjectMembers: (projectId: string): Promise<{ members: ProjectMemberRow[] }> =>
    apiFetch(`/api/projects/${projectId}/members`),
  addProjectMember: (
    projectId: string,
    body: { email: string; role: ProjectRole },
  ): Promise<{ member: ProjectMemberRow }> =>
    apiFetch(`/api/projects/${projectId}/members`, { method: 'POST', body }),
  updateProjectMemberRole: (
    projectId: string,
    userId: string,
    role: ProjectRole,
  ): Promise<{ member: ProjectMemberRow }> =>
    apiFetch(`/api/projects/${projectId}/members/${userId}`, { method: 'PATCH', body: { role } }),
  removeProjectMember: (projectId: string, userId: string): Promise<{ removed: true }> =>
    apiFetch(`/api/projects/${projectId}/members/${userId}`, { method: 'DELETE' }),

  getCurrentWorkspace: (): Promise<{
    workspace: { id: string; slug: string; name: string; plan: string; createdAt: string };
  }> => apiFetch('/api/workspaces/current'),
  updateCurrentWorkspace: (body: {
    name?: string;
    slug?: string;
  }): Promise<{ workspace: { id: string; slug: string; name: string } }> =>
    apiFetch('/api/workspaces/current', { method: 'PATCH', body }),
};

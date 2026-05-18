import type {
  DocCreatePayload,
  DocFull,
  DocSavePayload,
  DocSaveResponse,
  DocSummary,
} from '@boppl/shared';

const API_URL =
  (import.meta.env.PUBLIC_API_URL as string | undefined) ?? 'http://localhost:8080';

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
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
    },
    body: isJsonObject ? JSON.stringify(opts.body) : (opts.body as BodyInit | undefined),
    // Forward the AbortSignal so .abort() during autocomplete cancels the
    // network call instead of just discarding the resolved promise.
    signal: opts.signal,
  };

  const res = await fetch(`${API_URL}${path}`, init);
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
  }): Promise<{ invitation: { id: string; email: string; role: Role; expires_at: string } }> =>
    apiFetch('/api/invitations', { method: 'POST', body }),
  revokeInvitation: (id: string): Promise<{ revoked: true }> =>
    apiFetch(`/api/invitations/${id}`, { method: 'DELETE' }),
  acceptInvitation: (token: string): Promise<{ workspace_id: string }> =>
    apiFetch('/api/invitations/accept', { method: 'POST', body: { token } }),

  listMembers: (): Promise<{ members: MemberRow[] }> => apiFetch('/api/members'),
  updateMemberRole: (userId: string, role: Role): Promise<{ member: MemberRow }> =>
    apiFetch(`/api/members/${userId}/role`, { method: 'PATCH', body: { role } }),
  removeMember: (userId: string): Promise<{ removed: true }> =>
    apiFetch(`/api/members/${userId}`, { method: 'DELETE' }),

  getCurrentWorkspace: (): Promise<{
    workspace: { id: string; slug: string; name: string; plan: string; createdAt: string };
  }> => apiFetch('/api/workspaces/current'),
  updateCurrentWorkspace: (body: {
    name?: string;
    slug?: string;
  }): Promise<{ workspace: { id: string; slug: string; name: string } }> =>
    apiFetch('/api/workspaces/current', { method: 'PATCH', body }),
};

import type {
  DocCreatePayload,
  DocFull,
  DocSavePayload,
  DocSaveResponse,
  DocSummary,
} from '@boppl/shared';

const API_URL =
  (import.meta.env.PUBLIC_API_URL as string | undefined) ?? 'http://localhost:8080';

interface FetchOptions extends Omit<RequestInit, 'body'> {
  body?: BodyInit | object;
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
  };

  const res = await fetch(`${API_URL}${path}`, init);
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(res.status, text || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  listDocs: (): Promise<{ docs: DocSummary[] }> => apiFetch('/api/docs'),
  createDoc: (body: DocCreatePayload): Promise<{ doc: DocFull }> =>
    apiFetch('/api/docs', { method: 'POST', body }),
  getDoc: (id: string): Promise<{ doc: DocFull }> => apiFetch(`/api/docs/${id}`),
  saveDoc: (id: string, body: DocSavePayload): Promise<{ doc: DocSaveResponse }> =>
    apiFetch(`/api/docs/${id}`, { method: 'POST', body }),
};

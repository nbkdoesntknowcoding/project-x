import { config } from '../config/env.js';

interface WritebackCtx {
  user_id: string;
  tenant_id: string;
  email: string;
  doc_id: string;
}

/**
 * Push markdown into a live Y.Doc via IPC to the collab process.
 *
 * The api and collab are SEPARATE processes — they can't share an in-process
 * registry. The collab server exposes an internal HTTP endpoint authenticated
 * by the WORKOS_COOKIE_PASSWORD shared secret (same secret already in use by
 * /api/_internal/set-session). This function POSTs to that endpoint and
 * returns true if the live doc accepted the update, false if no live session
 * exists (caller should fall back to writing the docs row directly).
 *
 * The ctx is passed through to openDirectConnection so the resulting Y.Doc
 * mutation has a lastContext for the next onStoreDocument's RLS-scoped write.
 */
export async function writeMarkdownIntoLiveDoc(
  docId: string,
  markdown: string,
  ctx: WritebackCtx,
): Promise<boolean> {
  const collabUrl =
    process.env.COLLAB_INTERNAL_URL ?? `http://localhost:${config.COLLAB_PORT}`;
  try {
    const res = await fetch(`${collabUrl}/_internal/writeback/${docId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-boppl-internal-secret': config.WORKOS_COOKIE_PASSWORD,
      },
      body: JSON.stringify({ markdown, ctx }),
    });
    if (res.status === 404) return false; // no live doc
    if (!res.ok) {
      console.error('[writeback] collab returned', res.status);
      return false;
    }
    const body = (await res.json()) as { applied?: boolean };
    return Boolean(body.applied);
  } catch (err: unknown) {
    console.error('[writeback] IPC failed', err);
    return false;
  }
}

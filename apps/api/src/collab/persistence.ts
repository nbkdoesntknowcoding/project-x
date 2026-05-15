import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import * as Y from 'yjs';
import { docVersions, docs } from '../db/schema.js';
import { withTenant } from '../db/with-tenant.js';
import type { ConnectionContext } from './auth.js';
import { markdownToYjsState, yjsStateToMarkdown } from './markdown-bridge.js';

const EMPTY_DOC_STATE_LEN = Y.encodeStateAsUpdate(new Y.Doc()).length;
const SNAPSHOT_EVERY = 50;

function contentHash(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function isEmptyState(state: Buffer): boolean {
  if (state.length !== EMPTY_DOC_STATE_LEN) return false;
  const probe = new Y.Doc();
  Y.applyUpdate(probe, state);
  return probe.getXmlFragment('prosemirror').length === 0;
}

export async function loadDocumentState(ctx: ConnectionContext): Promise<Uint8Array> {
  return await withTenant(ctx.tenant_id, async (tx) => {
    const rows = await tx
      .select({ yjsState: docs.yjsState, markdown: docs.markdown })
      .from(docs)
      .where(and(eq(docs.id, ctx.doc_id), isNull(docs.deletedAt)))
      .limit(1);
    if (rows.length === 0) {
      throw new Error('Doc not found at load time');
    }
    const row = rows[0]!;
    const state = row.yjsState as Buffer | null | undefined;
    if (state && state.length > 0 && !isEmptyState(state)) {
      return new Uint8Array(state);
    }
    if (row.markdown && row.markdown.length > 0) {
      return await markdownToYjsState(row.markdown);
    }
    return Y.encodeStateAsUpdate(new Y.Doc());
  });
}

export interface StoreResult {
  contentChanged: boolean;
  snapshotted: boolean;
}

// Per-process counter of successful content-changing stores per doc.
// Resets on restart — snapshots are best-effort recovery anchors, not audit.
const storeCounts = new Map<string, number>();

/**
 * Atomic write of yjs_state + markdown + content_hash for a single doc.
 *
 *   1. Re-derive markdown from the live Y.Doc using the @boppl/schema bridge.
 *   2. Hash the new markdown.
 *   3. Compare hash to the row's stored hash. Equal → contentChanged=false
 *      (Phase 3 reads this to skip pointless embedding work).
 *   4. UPDATE all four columns in one transaction under SET LOCAL app.tenant_id.
 *   5. Every SNAPSHOT_EVERY content-changing stores per doc, INSERT a
 *      doc_versions row as a recovery anchor.
 */
export async function storeDocumentState(
  ctx: ConnectionContext,
  yjsDoc: Y.Doc,
): Promise<StoreResult> {
  const encoded = Y.encodeStateAsUpdate(yjsDoc);
  const newMarkdown = await yjsStateToMarkdown(encoded);
  const newYjsState = Buffer.from(encoded);
  const newHash = contentHash(newMarkdown);

  return await withTenant(ctx.tenant_id, async (tx) => {
    const existing = await tx
      .select({ contentHash: docs.contentHash })
      .from(docs)
      .where(and(eq(docs.id, ctx.doc_id), isNull(docs.deletedAt)))
      .limit(1);
    if (existing.length === 0) {
      return { contentChanged: false, snapshotted: false };
    }
    const oldHash = existing[0]?.contentHash ?? '';
    const contentChanged = oldHash !== newHash;

    await tx
      .update(docs)
      .set({
        yjsState: newYjsState,
        markdown: newMarkdown,
        contentHash: newHash,
        updatedBy: ctx.user_id,
      })
      .where(and(eq(docs.id, ctx.doc_id), isNull(docs.deletedAt)));

    let snapshotted = false;
    if (contentChanged) {
      const count = (storeCounts.get(ctx.doc_id) ?? 0) + 1;
      storeCounts.set(ctx.doc_id, count);
      if (count % SNAPSHOT_EVERY === 0) {
        const nextRow = await tx.execute(
          sql`SELECT COALESCE(MAX(version), 0) + 1 AS next FROM doc_versions WHERE doc_id = ${ctx.doc_id}`,
        );
        const versionNum = Number((nextRow[0] as { next: number | string } | undefined)?.next ?? 1);
        await tx.insert(docVersions).values({
          docId: ctx.doc_id,
          version: versionNum,
          markdown: newMarkdown,
          yjsState: newYjsState,
          authorId: ctx.user_id,
          comment: `Auto-snapshot at ${count} store events`,
        });
        snapshotted = true;
      }
    }

    return { contentChanged, snapshotted };
  });
}

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { writeMarkdownIntoLiveDoc } from '../collab/writeback.js';
import { db } from '../db/index.js';
import { attachments, docs } from '../db/schema.js';
import { withTenant } from '../db/with-tenant.js';
import { contentHash, emptyYjsState } from '../lib/yjs.js';
import { enforceFreeDocLimit } from '../plugins/free-limits.js';

const UUID_RE_DOCS = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DOC_TYPE = z.enum(['doc', 'engineering', 'instruction', 'snippet']);

const createSchema = z.object({
  title: z.string().min(1).max(200).default('Untitled'),
  markdown: z.string().default(''),
  // Phase 5: content type. Defaults to 'doc' (freeform markdown) so
  // existing clients that don't send the field stay valid.
  type: DOC_TYPE.default('doc'),
  // Phase 6.4: optional folder placement on creation.
  folder_id: z.string().uuid().nullable().optional(),
});

// 1.2: title and markdown are both optional but at least one must be present.
// Title-only updates skip the writeback path; body changes try writeback first
// (so connected clients see the change immediately) and fall through to a
// direct row write if no collab session is loaded for the doc.
const saveSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    markdown: z.string().optional(),
  })
  .refine((d) => d.title !== undefined || d.markdown !== undefined, {
    message: 'Provide at least one of title or markdown',
  });

interface DocRow {
  id: string;
  path: string;
  title: string;
  markdown: string;
  contentHash: string | null;
  createdAt: Date;
  updatedAt: Date;
}
function shapeForResponse(row: DocRow): {
  id: string;
  path: string;
  title: string;
  markdown: string;
  content_hash: string | null;
  created_at: Date;
  updated_at: Date;
} {
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    markdown: row.markdown,
    content_hash: row.contentHash,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

export const docsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/docs', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });

    const q = (req.query as Record<string, unknown> | null) ?? {};

    // Phase 5: optional ?type= filter for the sidebar's typed views.
    const typeFilter = DOC_TYPE.safeParse(q.type);

    // Phase 6.4: optional ?folder_id= filter. 'null' string → unfiled docs.
    const rawFolder = q.folder_id as string | undefined;
    const folderFilter =
      rawFolder === 'null' ? 'null' :
      rawFolder && UUID_RE_DOCS.test(rawFolder) ? rawFolder :
      undefined;

    const rows = await withTenant(req.auth.tenant_id, async (tx) => {
      const conditions = [isNull(docs.deletedAt)];
      if (typeFilter.success) conditions.push(eq(docs.type, typeFilter.data));
      if (folderFilter === 'null') conditions.push(isNull(docs.folderId));
      else if (folderFilter) conditions.push(eq(docs.folderId, folderFilter));
      return await tx
        .select({
          id: docs.id,
          path: docs.path,
          title: docs.title,
          type: docs.type,
          folder_id: docs.folderId,
          created_at: docs.createdAt,
          updated_at: docs.updatedAt,
          source_attachment_format: attachments.format,
        })
        .from(docs)
        .leftJoin(attachments, eq(docs.sourceAttachmentId, attachments.id))
        .where(and(...conditions))
        .orderBy(desc(docs.updatedAt))
        .limit(100);
    });

    return { docs: rows };
  });

  // Phase 5: counts per content type. Lets the sidebar hide filter chips
  // for types the workspace doesn't have yet. One small query per shell
  // mount, cached client-side.
  app.get('/api/content/type-counts', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });

    const rows = await withTenant(req.auth.tenant_id, async (tx) => {
      return await tx.execute(
        sql`SELECT type, COUNT(*)::int AS count
            FROM docs
            WHERE deleted_at IS NULL
            GROUP BY type`,
      );
    });

    // postgres-js returns the execute() result as the array of rows directly
    // (it's not wrapped in `{ rows: [] }` the way `pg` does it).
    const counts: Record<string, number> = { doc: 0, engineering: 0, instruction: 0, snippet: 0 };
    const rowList = rows as unknown as Array<{ type: string; count: number }>;
    for (const row of rowList) {
      counts[row.type] = Number(row.count) || 0;
    }
    return { counts };
  });

  app.post('/api/docs', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });

    // Enforce free plan doc limit (no-op for paid workspaces).
    if (await enforceFreeDocLimit(req, reply, req.auth.tenant_id)) return;

    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    }
    const auth = req.auth;
    const path = `${nanoid(10)}.md`;

    const created = await withTenant(auth.tenant_id, async (tx) => {
      const inserted = await tx
        .insert(docs)
        .values({
          workspaceId: auth.tenant_id,
          folderId: parsed.data.folder_id ?? null,
          path,
          title: parsed.data.title,
          type: parsed.data.type,
          markdown: parsed.data.markdown,
          yjsState: emptyYjsState(),
          contentHash: contentHash(parsed.data.markdown),
          createdBy: auth.sub,
          updatedBy: auth.sub,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error('Failed to create doc');
      return row;
    });

    return reply.code(201).send({
      doc: {
        id: created.id,
        path: created.path,
        title: created.title,
        markdown: created.markdown,
        content_hash: created.contentHash,
        created_at: created.createdAt,
        updated_at: created.updatedAt,
      },
    });
  });

  // GET /api/docs/public/:token — no auth required; must be registered before /:id
  // so Fastify's radix tree can favour the static 'public' segment.
  app.get<{ Params: { token: string } }>('/api/docs/public/:token', async (req, reply) => {
    const { token } = req.params;
    if (!isUuid(token)) return reply.code(400).send({ error: 'bad_token' });

    // Query without row-level security (no tenant context needed)
    const rows = await db
      .select({
        id: docs.id,
        path: docs.path,
        title: docs.title,
        markdown: docs.markdown,
        contentHash: docs.contentHash,
        isPublic: docs.isPublic,
        createdAt: docs.createdAt,
        updatedAt: docs.updatedAt,
      })
      .from(docs)
      .where(and(eq(docs.publicToken, token), eq(docs.isPublic, true), isNull(docs.deletedAt)))
      .limit(1);

    const row = rows[0];
    if (!row) return reply.code(404).send({ error: 'not_found' });

    return {
      doc: {
        id: row.id,
        path: row.path,
        title: row.title,
        markdown: row.markdown,
        content_hash: row.contentHash,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      },
    };
  });

  app.get<{ Params: { id: string } }>('/api/docs/:id', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    const { id } = req.params;
    if (!isUuid(id)) return reply.code(400).send({ error: 'bad_id' });

    const result = await withTenant(req.auth.tenant_id, async (tx) => {
      const rows = await tx
        .select({
          doc: docs,
          attachmentId:       attachments.id,
          attachmentFormat:   attachments.format,
          attachmentName:     attachments.originalName,
          attachmentSize:     attachments.sizeBytes,
        })
        .from(docs)
        .leftJoin(attachments, eq(docs.sourceAttachmentId, attachments.id))
        .where(and(eq(docs.id, id), isNull(docs.deletedAt)))
        .limit(1);
      return rows[0];
    });

    if (!result) return reply.code(404).send({ error: 'not_found' });
    const { doc: row } = result;

    return {
      doc: {
        id: row.id,
        path: row.path,
        title: row.title,
        markdown: row.markdown,
        content_hash: row.contentHash,
        is_public: row.isPublic,
        public_token: row.publicToken,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        sourceAttachment: result.attachmentId ? {
          id:           result.attachmentId,
          format:       result.attachmentFormat as 'docx' | 'pdf',
          originalName: result.attachmentName,
          sizeBytes:    result.attachmentSize,
        } : null,
      },
    };
  });

  // POST /api/docs/:id/share — toggle public link on/off.
  // Body: { enable: boolean }
  // Returns: { is_public, public_token, share_url }
  app.post<{ Params: { id: string } }>('/api/docs/:id/share', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    const { id } = req.params;
    if (!isUuid(id)) return reply.code(400).send({ error: 'bad_id' });

    const parsed = z.object({ enable: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });

    const { enable } = parsed.data;
    const auth = req.auth;

    const updated = await withTenant(auth.tenant_id, async (tx) => {
      // Fetch current row to get or create publicToken
      const current = await tx
        .select({ publicToken: docs.publicToken, isPublic: docs.isPublic })
        .from(docs)
        .where(and(eq(docs.id, id), isNull(docs.deletedAt)))
        .limit(1);
      if (!current[0]) return null;

      const token = enable ? (current[0].publicToken ?? randomUUID()) : current[0].publicToken;
      const rows = await tx
        .update(docs)
        .set({ isPublic: enable, publicToken: token ?? undefined })
        .where(and(eq(docs.id, id), isNull(docs.deletedAt)))
        .returning({ id: docs.id, isPublic: docs.isPublic, publicToken: docs.publicToken });
      return rows[0];
    });

    if (!updated) return reply.code(404).send({ error: 'not_found' });

    const shareUrl = updated.publicToken
      ? `https://mnema.theboringpeople.in/share/${updated.publicToken}`
      : null;

    return { is_public: updated.isPublic, public_token: updated.publicToken, share_url: shareUrl };
  });

  app.post<{ Params: { id: string } }>('/api/docs/:id', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    const { id } = req.params;
    if (!isUuid(id)) return reply.code(400).send({ error: 'bad_id' });

    const parsed = saveSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    }
    const auth = req.auth;
    const { title, markdown } = parsed.data;

    // -------- Body update path: try writeback into the live Y.Doc first.
    let appliedViaCollab = false;
    if (markdown !== undefined) {
      appliedViaCollab = await writeMarkdownIntoLiveDoc(id, markdown, {
        user_id: auth.sub,
        tenant_id: auth.tenant_id,
        email: auth.email,
        doc_id: id,
      });
    }

    // -------- Single transaction for whatever DB writes are still needed.
    const updated = await withTenant(auth.tenant_id, async (tx) => {
      // If body went through collab, the next debounced onStoreDocument
      // writes the canonical body. Skip writing markdown/contentHash here.
      const setClause: Partial<{
        title: string;
        markdown: string;
        contentHash: string;
        updatedBy: string;
      }> = {
        updatedBy: auth.sub,
      };
      if (title !== undefined) setClause.title = title;
      if (markdown !== undefined && !appliedViaCollab) {
        setClause.markdown = markdown;
        setClause.contentHash = contentHash(markdown);
      }

      // No-op detection: if we'd only be touching updatedBy, skip the UPDATE
      // and just SELECT to return the current row.
      const hasMutation =
        setClause.title !== undefined ||
        setClause.markdown !== undefined;

      if (!hasMutation) {
        const rows = await tx
          .select()
          .from(docs)
          .where(and(eq(docs.id, id), isNull(docs.deletedAt)))
          .limit(1);
        return rows[0];
      }

      const rows = await tx
        .update(docs)
        .set(setClause)
        .where(and(eq(docs.id, id), isNull(docs.deletedAt)))
        .returning();
      return rows[0];
    });

    if (!updated) return reply.code(404).send({ error: 'not_found' });
    return { doc: shapeForResponse(updated) };
  });
};

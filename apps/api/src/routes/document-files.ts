import { eq, and } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import multipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { attachments, docs } from '../db/schema.js';
import { withTenant } from '../db/with-tenant.js';
import { config } from '../config/env.js';
import { ingestDocx } from '../lib/documents/ingest-docx.js';
import { ingestPdf } from '../lib/documents/ingest-pdf.js';
import { generateDocx } from '../lib/documents/generate-docx.js';
import { pdfGenerationQueue } from '../queue/pdf-generation.js';
import {
  uploadAttachment,
  getSignedAttachmentUrl,
  isR2Configured,
} from '../lib/storage/r2-attachments.js';
import { contentHash, emptyYjsState } from '../lib/yjs.js';

export const documentFilesRoutes: FastifyPluginAsync = async (app) => {
  // Register multipart only for this plugin scope
  await app.register(multipart, {
    limits: {
      fileSize: (config.MAX_UPLOAD_SIZE_MB + 10) * 1024 * 1024, // slight headroom; exact check below
      files:    1,
    },
  });

  function requireR2(reply: FastifyReply): boolean {
    if (!isR2Configured()) {
      void reply.status(503).send({ error: 'storage_not_configured', message: 'R2 storage is not configured on this server.' });
      return false;
    }
    return true;
  }

  // ── POST /api/document-files/upload ────────────────────────────────────────
  app.post('/api/document-files/upload', async (req, reply) => {
    if (!req.auth) return reply.status(401).send({ error: 'unauthorized' });
    if (!requireR2(reply)) return;

    const MAX_BYTES = config.MAX_UPLOAD_SIZE_MB * 1024 * 1024;

    let file: Awaited<ReturnType<typeof req.file>> | undefined;
    try {
      file = await req.file();
    } catch {
      return reply.status(400).send({ error: 'no_file', message: 'No file provided' });
    }
    if (!file) return reply.status(400).send({ error: 'no_file', message: 'No file provided' });

    const buffer = await file.toBuffer();

    if (buffer.length > MAX_BYTES) {
      return reply.status(413).send({
        error:   'file_too_large',
        message: `File exceeds ${config.MAX_UPLOAD_SIZE_MB}MB limit`,
      });
    }

    const mime     = file.mimetype;
    const filename = file.filename ?? 'upload';
    const isDocx =
      mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      filename.toLowerCase().endsWith('.docx');
    const isPdf =
      mime === 'application/pdf' ||
      filename.toLowerCase().endsWith('.pdf');

    if (!isDocx && !isPdf) {
      return reply.status(415).send({
        error:   'unsupported_format',
        message: 'Only .docx and .pdf files are supported',
      });
    }

    const format: 'docx' | 'pdf' = isDocx ? 'docx' : 'pdf';
    const workspaceId = req.auth.tenant_id;

    // Upload original to R2
    const { r2Key } = await uploadAttachment(workspaceId, buffer, format, filename);

    // Insert attachment row (status = processing)
    const [attachment] = await withTenant(workspaceId, (tx) =>
      tx.insert(attachments).values({
        workspaceId,
        type:         'source',
        format,
        originalName: filename,
        r2Key,
        sizeBytes:    buffer.length,
        mimeType:     mime,
        status:       'processing',
      }).returning(),
    );
    if (!attachment) return reply.status(500).send({ error: 'db_error' });

    let markdown  = '';
    let title     = filename.replace(/\.(docx|pdf)$/i, '');
    let imageUrls: string[] = [];
    let warnings:  string[] = [];
    let usedOcr   = false;
    let pageCount: number | null = null;

    try {
      if (isDocx) {
        const result = await ingestDocx(buffer, workspaceId, filename);
        markdown  = result.markdown;
        title     = result.title;
        imageUrls = result.imageUrls;
        warnings  = result.warnings;
      } else {
        const result = await ingestPdf(buffer, workspaceId, filename);
        markdown  = result.markdown;
        title     = result.title;
        imageUrls = result.imageUrls;
        usedOcr   = result.usedOcr;
        pageCount = result.pageCount;
      }
    } catch (err) {
      await withTenant(workspaceId, (tx) =>
        tx.update(attachments)
          .set({ status: 'failed', errorMessage: String(err), updatedAt: new Date() })
          .where(eq(attachments.id, attachment.id)),
      );
      req.log.error({ err }, 'ingestion failed');
      return reply.status(422).send({
        error:   'ingestion_failed',
        message: String(err),
      });
    }

    // Derive query params passed as form fields
    const fields = req.body as Record<string, { value?: string } | string> | undefined;
    const folderId  = (typeof fields?.folderId  === 'object' ? fields.folderId.value  : fields?.folderId)  ?? null;
    const projectId = (typeof fields?.projectId === 'object' ? fields.projectId.value : fields?.projectId) ?? null;

    // Create doc
    const path = `upload-${randomUUID()}`;
    const yjsState = emptyYjsState();
    const [doc] = await withTenant(workspaceId, (tx) =>
      tx.insert(docs).values({
        workspaceId,
        path,
        title,
        markdown,
        yjsState,
        contentHash:        contentHash(markdown),
        createdBy:          req.auth!.sub,
        updatedBy:          req.auth!.sub,
        folderId:           folderId ?? null,
        sourceAttachmentId: attachment.id,
      }).returning(),
    );
    if (!doc) return reply.status(500).send({ error: 'doc_create_failed' });

    // Update attachment with docId + status
    await withTenant(workspaceId, (tx) =>
      tx.update(attachments)
        .set({
          docId:      doc.id,
          status:     'ready',
          usedOcr,
          pageCount:  pageCount ?? undefined,
          updatedAt:  new Date(),
        })
        .where(eq(attachments.id, attachment.id)),
    );

    return reply.send({
      attachmentId: attachment.id,
      docId:        doc.id,
      title,
      usedOcr,
      pageCount,
      warnings,
    });
  });

  // ── GET /api/document-files/:attachmentId ─────────────────────────────────
  app.get('/api/document-files/:attachmentId', async (req, reply) => {
    if (!req.auth) return reply.status(401).send({ error: 'unauthorized' });
    if (!requireR2(reply)) return;

    const { attachmentId } = req.params as { attachmentId: string };
    const [row] = await withTenant(req.auth.tenant_id, (tx) =>
      tx.select().from(attachments)
        .where(and(
          eq(attachments.id, attachmentId),
          eq(attachments.workspaceId, req.auth!.tenant_id),
        ))
        .limit(1),
    );
    if (!row) return reply.status(404).send({ error: 'not_found' });

    const downloadUrl = row.r2Key
      ? await getSignedAttachmentUrl(row.r2Key)
      : null;

    return reply.send({ attachment: row, downloadUrl });
  });

  // ── GET /api/document-files/:attachmentId/download ────────────────────────
  app.get('/api/document-files/:attachmentId/download', async (req, reply) => {
    if (!req.auth) return reply.status(401).send({ error: 'unauthorized' });
    if (!requireR2(reply)) return;

    const { attachmentId } = req.params as { attachmentId: string };
    const [row] = await withTenant(req.auth.tenant_id, (tx) =>
      tx.select({ r2Key: attachments.r2Key })
        .from(attachments)
        .where(and(
          eq(attachments.id, attachmentId),
          eq(attachments.workspaceId, req.auth!.tenant_id),
        ))
        .limit(1),
    );
    if (!row) return reply.status(404).send({ error: 'not_found' });

    const url = await getSignedAttachmentUrl(row.r2Key);
    return reply.redirect(url, 302);
  });

  // ── POST /api/document-files/export ───────────────────────────────────────
  app.post('/api/document-files/export', async (req, reply) => {
    if (!req.auth) return reply.status(401).send({ error: 'unauthorized' });
    if (!requireR2(reply)) return;

    const { docId, format } = req.body as { docId?: string; format?: string };
    if (!docId || !format || !['docx', 'pdf'].includes(format)) {
      return reply.status(400).send({ error: 'invalid_params', message: 'docId and format (docx|pdf) required' });
    }

    const workspaceId = req.auth.tenant_id;

    const [doc] = await withTenant(workspaceId, (tx) =>
      tx.select({ id: docs.id, title: docs.title, markdown: docs.markdown })
        .from(docs)
        .where(and(eq(docs.id, docId), eq(docs.workspaceId, workspaceId)))
        .limit(1),
    );
    if (!doc) return reply.status(404).send({ error: 'doc_not_found' });

    // Create pending attachment record
    const [attachment] = await withTenant(workspaceId, (tx) =>
      tx.insert(attachments).values({
        workspaceId,
        docId,
        type:   'export',
        format: format as 'docx' | 'pdf',
        r2Key:  '', // filled in after upload
        status: format === 'docx' ? 'processing' : 'pending',
      }).returning(),
    );
    if (!attachment) return reply.status(500).send({ error: 'db_error' });

    if (format === 'docx') {
      try {
        const buffer   = await generateDocx(doc.markdown, { title: doc.title });
        const filename = `${doc.title.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.docx`;
        const { r2Key } = await uploadAttachment(workspaceId, buffer, 'docx', filename);

        await withTenant(workspaceId, (tx) =>
          tx.update(attachments)
            .set({ r2Key, status: 'ready', sizeBytes: buffer.length, updatedAt: new Date() })
            .where(eq(attachments.id, attachment.id)),
        );

        const downloadUrl = await getSignedAttachmentUrl(r2Key);
        return reply.send({ attachmentId: attachment.id, downloadUrl, status: 'ready' });
      } catch (err) {
        await withTenant(workspaceId, (tx) =>
          tx.update(attachments)
            .set({ status: 'failed', errorMessage: String(err), updatedAt: new Date() })
            .where(eq(attachments.id, attachment.id)),
        );
        throw err;
      }
    }

    // PDF: enqueue async job
    await pdfGenerationQueue.add('generate-pdf', {
      attachmentId: attachment.id,
      docId,
      workspaceId,
      title: doc.title,
    });
    return reply.send({ attachmentId: attachment.id, status: 'pending' });
  });

  // ── GET /api/document-files/export/:attachmentId/status ──────────────────
  app.get('/api/document-files/export/:attachmentId/status', async (req, reply) => {
    if (!req.auth) return reply.status(401).send({ error: 'unauthorized' });
    if (!requireR2(reply)) return;

    const { attachmentId } = req.params as { attachmentId: string };
    const [row] = await withTenant(req.auth.tenant_id, (tx) =>
      tx.select({
        status:       attachments.status,
        r2Key:        attachments.r2Key,
        errorMessage: attachments.errorMessage,
      })
        .from(attachments)
        .where(and(
          eq(attachments.id, attachmentId),
          eq(attachments.workspaceId, req.auth!.tenant_id),
        ))
        .limit(1),
    );
    if (!row) return reply.status(404).send({ error: 'not_found' });

    const downloadUrl =
      row.status === 'ready' && row.r2Key
        ? await getSignedAttachmentUrl(row.r2Key)
        : undefined;

    return reply.send({ status: row.status, downloadUrl, errorMessage: row.errorMessage });
  });
};

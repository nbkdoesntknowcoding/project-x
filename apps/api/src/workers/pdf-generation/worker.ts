import { Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { eq } from 'drizzle-orm';
import { config } from '../../config/env.js';
import { db } from '../../db/index.js';
import { attachments, docs } from '../../db/schema.js';
import { withTenant } from '../../db/with-tenant.js';
import { withSystemPrivilege } from '../../db/with-system-privilege.js';
import { initBrowserPool, renderPdf, closeBrowserPool } from '../../lib/pdf/browser-pool.js';
import { renderDocumentHtml } from '../../lib/pdf/template.js';
import { uploadAttachment } from '../../lib/storage/r2-attachments.js';
import { emitWorkspaceEvent } from '../../lib/events.js';
import { PDF_GENERATION_QUEUE, type PdfGenerationJobData } from '../../queue/pdf-generation.js';

export async function startPdfGenerationWorker() {
  // Browser pool lives here — never in server.ts
  await initBrowserPool();

  const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });

  const worker = new Worker<PdfGenerationJobData>(
    PDF_GENERATION_QUEUE,
    async (job: Job<PdfGenerationJobData>) => {
      const { attachmentId, docId, workspaceId, title } = job.data;

      // Fetch doc content using system privilege (worker has no user context)
      const [doc] = await withSystemPrivilege((tx) =>
        tx.select({ markdown: docs.markdown, title: docs.title })
          .from(docs)
          .where(eq(docs.id, docId))
          .limit(1),
      );
      if (!doc) throw new Error(`Doc ${docId} not found`);

      const html      = renderDocumentHtml(doc.markdown, title || doc.title);
      const pdfBuffer = await renderPdf(html);

      const safeTitle = (title || doc.title).replace(/[^a-z0-9]/gi, '-').toLowerCase();
      const filename  = `${safeTitle}.pdf`;
      const { r2Key } = await uploadAttachment(workspaceId, pdfBuffer, 'pdf', filename);

      await withTenant(workspaceId, (tx) =>
        tx.update(attachments)
          .set({
            r2Key,
            status:    'ready',
            sizeBytes: pdfBuffer.length,
            updatedAt: new Date(),
          })
          .where(eq(attachments.id, attachmentId)),
      );

      emitWorkspaceEvent(workspaceId, {
        type: 'attachment_ready',
        data: { attachmentId, docId, format: 'pdf' },
      });
    },
    { connection, concurrency: 2 },
  );

  worker.on('failed', (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[pdf-worker] job ${job?.id} failed:`, err);
    if (job) {
      void withTenant(job.data.workspaceId, (tx) =>
        tx.update(attachments)
          .set({ status: 'failed', errorMessage: String(err), updatedAt: new Date() })
          .where(eq(attachments.id, job.data.attachmentId)),
      );
    }
  });

  return worker;
}

process.on('SIGTERM', async () => {
  await closeBrowserPool();
  process.exit(0);
});

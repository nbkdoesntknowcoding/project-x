import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../../config/env.js';
import { type GraphJobData, GRAPH_QUEUE_NAME, enqueueCluster } from '../../queue/graph.js';
import { db } from '../../db/index.js';
import { extractStructural } from '../../lib/graph/extract-structural.js';
import { extractSemantic, buildSimilarityEdges } from '../../lib/graph/extract-semantic.js';
import { runClustering } from '../../lib/graph/clustering.js';
import { generateGraphReport } from '../../lib/graph/report.js';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import { emitWorkspaceEvent } from '../../lib/events.js';

const { docs, graphReports } = schema;

export function startGraphWorker(): Worker<GraphJobData> {
  const connection = new IORedis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
  });

  const worker = new Worker<GraphJobData>(
    GRAPH_QUEUE_NAME,
    async (job) => {
      const { type, workspaceId } = job.data;

      switch (type) {
        case 'extract-doc': {
          const { docId, mode = 'normal' } = job.data;
          if (!docId) throw new Error('extract-doc: missing docId');
          await job.updateProgress(10);

          await extractSemantic(workspaceId, docId, db as any, mode);
          await job.updateProgress(80);

          // Debounced cluster: 30 minutes after last doc save
          enqueueCluster(workspaceId, false, 30 * 60 * 1000);
          await job.updateProgress(100);
          break;
        }

        case 'full-build': {
          const { mode = 'normal' } = job.data;

          // Step 1: structural pass
          await job.updateProgress(5);
          await extractStructural(workspaceId, db as any);
          await job.updateProgress(20);

          // Step 2: semantic extraction for all docs in batches of 5
          const allDocs = await db
            .select({ id: docs.id })
            .from(docs)
            .where(eq(docs.workspaceId, workspaceId));

          const BATCH = 5;
          for (let i = 0; i < allDocs.length; i += BATCH) {
            const batch = allDocs.slice(i, i + BATCH);
            await Promise.allSettled(
              batch.map(d => extractSemantic(workspaceId, d.id, db as any, mode)),
            );
            const pct = 20 + Math.floor((i / allDocs.length) * 55);
            await job.updateProgress(pct);
            if (i + BATCH < allDocs.length) {
              await new Promise(r => setTimeout(r, 1000)); // 1s between batches
            }
          }

          // Step 3: pgvector similarity edges
          await job.updateProgress(75);
          await buildSimilarityEdges(workspaceId, db as any);
          await job.updateProgress(85);

          // Step 4: cluster + report
          enqueueCluster(workspaceId, true, 0);
          await job.updateProgress(100);
          break;
        }

        case 'cluster': {
          const { generateReport = false } = job.data;

          // Update report status to 'building'
          await db
            .insert(graphReports)
            .values({ workspaceId, status: 'building' })
            .onConflictDoUpdate({
              target: graphReports.workspaceId,
              set: { status: 'building', updatedAt: new Date() },
            });

          await job.updateProgress(10);
          const result = await runClustering(workspaceId, 1.0, db as any);
          await job.updateProgress(80);

          if (generateReport) {
            await generateGraphReport(workspaceId, db as any);
          }
          await job.updateProgress(95);

          // Mark report ready
          await db
            .update(graphReports)
            .set({ status: 'ready', lastBuiltAt: new Date(), updatedAt: new Date() })
            .where(eq(graphReports.workspaceId, workspaceId));

          // Emit SSE event to all connected clients
          const [nodeCount] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.graphNodes).where(eq(schema.graphNodes.workspaceId, workspaceId));
          const [edgeCount] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.graphEdges).where(eq(schema.graphEdges.workspaceId, workspaceId));
          const [commCount] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.graphCommunities).where(eq(schema.graphCommunities.workspaceId, workspaceId));
          emitWorkspaceEvent(workspaceId, {
            type: 'graph_updated',
            data: { totalNodes: nodeCount?.count ?? 0, totalEdges: edgeCount?.count ?? 0, communityCount: commCount?.count ?? 0 },
          });

          await job.updateProgress(100);
          break;
        }

        default:
          throw new Error(`Unknown graph job type: ${String(type)}`);
      }
    },
    {
      connection,
      concurrency: 2,
    },
  );

  worker.on('failed', (job, err) => {
    console.error(`[graph-worker] job ${job?.id} failed:`, err);
  });

  return worker;
}

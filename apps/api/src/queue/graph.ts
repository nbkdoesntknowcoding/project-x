import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config/env.js';

export const GRAPH_QUEUE_NAME = 'knowledge-graph';

export type GraphJobType = 'extract-doc' | 'full-build' | 'cluster';

export interface GraphJobData {
  type: GraphJobType;
  workspaceId: string;
  docId?: string;            // for extract-doc
  mode?: 'normal' | 'deep'; // for extract-doc / full-build
  generateReport?: boolean;  // for cluster
}

const connection = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const graphQueue = new Queue<GraphJobData>(GRAPH_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

/** Enqueue a semantic extraction for a single doc (fire-and-forget from doc save). */
export function enqueueExtractDoc(
  workspaceId: string,
  docId: string,
  mode: 'normal' | 'deep' = 'normal',
): void {
  void graphQueue.add(
    'extract-doc',
    { type: 'extract-doc', workspaceId, docId, mode },
    { jobId: `extract-${docId}` }, // deduplicate rapid saves
  );
}

/**
 * Remove any existing job with this id, then add fresh. BullMQ ignores add()
 * when a job with the same jobId already exists in ANY state (incl.
 * completed/failed) — so a parked terminal job silently swallows every
 * re-trigger. Removing first guarantees a re-trigger always runs.
 */
async function replaceJob(jobId: string, name: string, data: GraphJobData, delayMs = 0): Promise<void> {
  const existing = await graphQueue.getJob(jobId);
  if (existing) await existing.remove().catch(() => { /* race / already gone */ });
  await graphQueue.add(name, data, { jobId, delay: delayMs });
}

/** Enqueue a full graph rebuild for a workspace. */
export function enqueueFullBuild(
  workspaceId: string,
  mode: 'normal' | 'deep' = 'normal',
): void {
  void replaceJob(`full-build-${workspaceId}`, 'full-build', { type: 'full-build', workspaceId, mode });
}

/** Enqueue a cluster job (debounced by workspace — only one runs at a time). */
export function enqueueCluster(
  workspaceId: string,
  generateReport = false,
  delayMs = 0,
): void {
  void replaceJob(`cluster-${workspaceId}`, 'cluster', { type: 'cluster', workspaceId, generateReport }, delayMs);
}

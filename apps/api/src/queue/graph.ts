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

/** Enqueue a full graph rebuild for a workspace. */
export function enqueueFullBuild(
  workspaceId: string,
  mode: 'normal' | 'deep' = 'normal',
): void {
  void graphQueue.add(
    'full-build',
    { type: 'full-build', workspaceId, mode },
    { jobId: `full-build-${workspaceId}` },
  );
}

/** Enqueue a cluster job (debounced by workspace — only one runs at a time). */
export function enqueueCluster(
  workspaceId: string,
  generateReport = false,
  delayMs = 0,
): void {
  void graphQueue.add(
    'cluster',
    { type: 'cluster', workspaceId, generateReport },
    {
      jobId: `cluster-${workspaceId}`,
      delay: delayMs,
      // If a cluster job already exists for this workspace, replace it
      // with the newer one so we don't pile up redundant jobs.
    },
  );
}

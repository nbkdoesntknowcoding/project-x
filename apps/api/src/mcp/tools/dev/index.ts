/**
 * Dev MCP tools — Phase 1 AgentLens Task Layer.
 *
 * These 6 tools are only registered when workspace.mode === 'dev_project'.
 * They are invisible to knowledge-mode workspaces in tools/list.
 *
 * Reference: /Users/nischaybk/Projects/project-x/devmanager/agentlens/daemon/mcp/
 */

import { and, asc, desc, eq, gte, sql, sum } from 'drizzle-orm';
import { z } from 'zod';
import type { McpAuthContext } from '../../auth.js';
import { agentSessions, docs, folders, tasks, toolCalls } from '../../../db/schema.js';
import { db } from '../../../db/index.js';
import { withTenant } from '../../../db/with-tenant.js';
import { emitWorkspaceEvent } from '../../../lib/events.js';

// Priority ordering for get_next_task sorting (critical > high > medium > low)
const PRIORITY_ORDER: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/** Dev-mode gate: return error content if workspace is not dev_project. */
function devModeError() {
  return {
    content: 'This tool is only available in Dev Project workspaces.',
    structuredContent: { error: 'dev_mode_required' },
    error: 'dev_mode_required' as const,
  };
}

// ── Tool specs ────────────────────────────────────────────────────────────────

export const GET_NEXT_TASK_TOOL = {
  name: 'get_next_task',
  description: [
    'Returns the highest-priority task from the Kanban board ready for work.',
    'Defaults to backlog status. Pass status="audit_fix" to get blocked tasks needing review.',
    'Use the returned task.id with claim_task to start working on it.',
    'Returns null if no tasks are available in the requested column.',
  ].join('\n'),
  inputSchema: {
    type: 'object' as const,
    properties: {
      status: {
        type: 'string',
        description: 'Column to pull from: "backlog" (default) or "audit_fix".',
      },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, title: 'Get next task' },
};

export const CLAIM_TASK_TOOL = {
  name: 'claim_task',
  description: [
    'Claim a task and move it to In Progress, creating an agent session.',
    'Call get_next_task first to find the task id.',
    'Returns the updated task and the new session id.',
    'Error if task is not in backlog or audit_fix status.',
  ].join('\n'),
  inputSchema: {
    type: 'object' as const,
    properties: {
      taskId:      { type: 'string', description: 'UUID of the task to claim.' },
      developerId: { type: 'string', description: 'Optional identifier for the developer (e.g. your name or machine id).' },
    },
    required: ['taskId'],
    additionalProperties: false,
  },
  annotations: { title: 'Claim task' },
};

export const COMPLETE_TASK_TOOL = {
  name: 'complete_task',
  description: [
    'Mark a task as done. Moves it from in_progress or review to done.',
    'Optionally link the GitHub PR and provide a completion summary.',
    'Notifies workspace members if summary is provided.',
  ].join('\n'),
  inputSchema: {
    type: 'object' as const,
    properties: {
      taskId:      { type: 'string', description: 'UUID of the task to complete.' },
      sessionId:   { type: 'string', description: 'Agent session id from claim_task (optional).' },
      githubPrUrl: { type: 'string', description: 'GitHub PR URL to link (optional).' },
      summary:     { type: 'string', description: 'Short completion summary (optional, max 500 chars).' },
    },
    required: ['taskId'],
    additionalProperties: false,
  },
  annotations: { title: 'Complete task' },
};

export const LOG_BLOCKER_TOOL = {
  name: 'log_blocker',
  description: [
    'Log a blocker on a task and move it to Audit/Fix.',
    'Use when you cannot complete a task and need human review.',
    'description is REQUIRED and must clearly describe what failed.',
    'Increments the retry count and notifies workspace members.',
  ].join('\n'),
  inputSchema: {
    type: 'object' as const,
    properties: {
      taskId:      { type: 'string', description: 'UUID of the task that is blocked.' },
      sessionId:   { type: 'string', description: 'Agent session id from claim_task (optional).' },
      description: { type: 'string', description: 'REQUIRED. Clear description of what failed and why you are blocked.' },
    },
    required: ['taskId', 'description'],
    additionalProperties: false,
  },
  annotations: { title: 'Log blocker' },
};

export const LIST_PROJECT_TASKS_TOOL = {
  name: 'list_project_tasks',
  description: [
    'List tasks in the workspace Kanban board.',
    'Filter by status, priority, or both. Default limit: 20, max: 100.',
    'Returns tasks ordered by board position.',
  ].join('\n'),
  inputSchema: {
    type: 'object' as const,
    properties: {
      status:   { type: 'string', description: 'Filter by status: backlog, in_progress, review, audit_fix, done.' },
      priority: { type: 'string', description: 'Filter by priority: low, medium, high, critical.' },
      limit:    { type: 'number', description: 'Max tasks to return (default: 20, max: 100).' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, title: 'List project tasks' },
};

export const GET_SKILL_FILES_TOOL = {
  name: 'get_skill_files',
  description: [
    'Returns docs from the Skills folder in this Dev Project workspace.',
    'Skill files are reusable snippets, patterns, and conventions for this project.',
    'Optionally search by keyword within the Skills folder.',
    'Read these before starting work to understand project conventions.',
  ].join('\n'),
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: 'Optional keyword to search within skill files.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, title: 'Get skill files' },
};

// ── Handlers ──────────────────────────────────────────────────────────────────

const claimTaskArgs = z.object({
  taskId:      z.string().uuid(),
  developerId: z.string().optional(),
});

const completeTaskArgs = z.object({
  taskId:      z.string().uuid(),
  sessionId:   z.string().uuid().optional(),
  githubPrUrl: z.string().url().optional(),
  summary:     z.string().max(500).optional(),
});

const logBlockerArgs = z.object({
  taskId:      z.string().uuid(),
  sessionId:   z.string().uuid().optional(),
  description: z.string().min(1).max(2000),
});

const listTasksArgs = z.object({
  status:   z.string().optional(),
  priority: z.string().optional(),
  limit:    z.number().int().min(1).max(100).optional(),
});

const getSkillFilesArgs = z.object({
  query: z.string().optional(),
});

// ──────────────────────────────────────────────────────────────────────────────
// D.1: get_next_task
// ──────────────────────────────────────────────────────────────────────────────
export async function getNextTask(ctx: McpAuthContext, rawArgs: Record<string, unknown>) {
  if (ctx.workspaceMode !== 'dev_project') return devModeError();

  const statusFilter = typeof rawArgs.status === 'string' ? rawArgs.status : 'backlog';
  if (statusFilter !== 'backlog' && statusFilter !== 'audit_fix') {
    return {
      content: 'Invalid status. Use "backlog" or "audit_fix".',
      structuredContent: { error: 'invalid_status' },
    };
  }

  const taskRows = await withTenant(ctx.tenant_id, async (tx) =>
    tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.workspaceId, ctx.tenant_id), eq(tasks.status, statusFilter)))
      .orderBy(asc(tasks.boardOrder))
      .limit(20), // fetch up to 20, then sort by priority client-side
  );

  if (taskRows.length === 0) {
    return {
      content: `No tasks found in ${statusFilter} column.`,
      structuredContent: { task: null, linkedDoc: null },
    };
  }

  // Sort by priority desc (critical > high > medium > low), then by boardOrder
  const sorted = [...taskRows].sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 0;
    const pb = PRIORITY_ORDER[b.priority] ?? 0;
    if (pb !== pa) return pb - pa;
    return a.boardOrder - b.boardOrder;
  });

  const task = sorted[0]!;

  // Fetch linked doc content preview if docId is set
  let linkedDoc: { title: string; path: string; contentPreview: string } | null = null;
  if (task.docId) {
    const docRows = await withTenant(ctx.tenant_id, async (tx) =>
      tx
        .select({ title: docs.title, path: docs.path, markdown: docs.markdown })
        .from(docs)
        .where(eq(docs.id, task.docId!))
        .limit(1),
    );
    if (docRows[0]) {
      linkedDoc = {
        title: docRows[0].title,
        path: docRows[0].path,
        contentPreview: docRows[0].markdown.slice(0, 200),
      };
    }
  }

  const costStr = task.estimatedCostUsd != null ? ` · est. $${task.estimatedCostUsd.toFixed(2)}` : '';
  let content = `Next task: "${task.title}" (priority: ${task.priority}${costStr})\n`;
  if (task.description) content += `Description: ${task.description}\n`;
  if (linkedDoc) content += `Linked doc: ${linkedDoc.title} — ${linkedDoc.contentPreview}...\n`;
  if (task.status === 'audit_fix' && task.blockerDescription) {
    content += `Blocker: ${task.blockerDescription}\nRetry count: ${task.retryCount}\n`;
  }
  if (task.retryFixHint) {
    content += `Fix hint from last attempt: ${task.retryFixHint}\n`;
  }
  content += `Task ID: ${task.id} — use this in claim_task.`;

  return {
    content,
    structuredContent: { task, linkedDoc },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// D.2: claim_task
// ──────────────────────────────────────────────────────────────────────────────
export async function claimTask(ctx: McpAuthContext, rawArgs: Record<string, unknown>) {
  if (ctx.workspaceMode !== 'dev_project') return devModeError();

  const args = claimTaskArgs.safeParse(rawArgs);
  if (!args.success) {
    return { content: `Invalid arguments: ${args.error.message}`, structuredContent: { error: 'invalid_args' } };
  }

  const taskRows = await withTenant(ctx.tenant_id, async (tx) =>
    tx.select().from(tasks).where(and(eq(tasks.id, args.data.taskId), eq(tasks.workspaceId, ctx.tenant_id))).limit(1),
  );
  const task = taskRows[0];
  if (!task) {
    return { content: 'Task not found.', structuredContent: { error: 'task_not_found' } };
  }
  if (task.status !== 'backlog' && task.status !== 'audit_fix') {
    return {
      content: `Cannot claim task in status '${task.status}'. Task must be in backlog or audit_fix.`,
      structuredContent: { error: 'invalid_status', task },
    };
  }

  const previousStatus = task.status;

  // Move task to in_progress
  const [updated] = await withTenant(ctx.tenant_id, async (tx) =>
    tx
      .update(tasks)
      .set({ status: 'in_progress', blockerDescription: null, retryFixHint: null, updatedAt: new Date() })
      .where(eq(tasks.id, args.data.taskId))
      .returning(),
  );

  // Create agent session
  const [session] = await withTenant(ctx.tenant_id, async (tx) =>
    tx
      .insert(agentSessions)
      .values({
        workspaceId: ctx.tenant_id,
        taskId: args.data.taskId,
        developerId: args.data.developerId ?? 'unknown',
        agent: 'claude_code',
        status: 'active',
      })
      .returning(),
  );

  // Emit SSE event
  emitWorkspaceEvent(ctx.tenant_id, {
    type: 'task_updated',
    data: { task: updated!, previousStatus, changedBy: 'agent', developerId: args.data.developerId },
  });

  return {
    content: `Claimed task "${updated!.title}". Session ID: ${session!.id}.\nTask is now In Progress. Call complete_task or log_blocker when done.`,
    structuredContent: { task: updated, session: { id: session!.id, startedAt: session!.startedAt } },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// D.3: complete_task
// ──────────────────────────────────────────────────────────────────────────────
export async function completeTask(ctx: McpAuthContext, rawArgs: Record<string, unknown>) {
  if (ctx.workspaceMode !== 'dev_project') return devModeError();

  const args = completeTaskArgs.safeParse(rawArgs);
  if (!args.success) {
    return { content: `Invalid arguments: ${args.error.message}`, structuredContent: { error: 'invalid_args' } };
  }

  const taskRows = await withTenant(ctx.tenant_id, async (tx) =>
    tx.select().from(tasks).where(and(eq(tasks.id, args.data.taskId), eq(tasks.workspaceId, ctx.tenant_id))).limit(1),
  );
  const task = taskRows[0];
  if (!task) {
    return { content: 'Task not found.', structuredContent: { error: 'task_not_found' } };
  }
  if (task.status !== 'in_progress' && task.status !== 'review') {
    return {
      content: `Cannot complete task in status '${task.status}'. Task must be in_progress or review.`,
      structuredContent: { error: 'invalid_status', task },
    };
  }

  const previousStatus = task.status;
  const [updated] = await withTenant(ctx.tenant_id, async (tx) =>
    tx
      .update(tasks)
      .set({
        status: 'done',
        completedAt: new Date(),
        ...(args.data.githubPrUrl ? { githubPrUrl: args.data.githubPrUrl } : {}),
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, args.data.taskId))
      .returning(),
  );

  // Update session if provided
  if (args.data.sessionId) {
    await withTenant(ctx.tenant_id, async (tx) =>
      tx
        .update(agentSessions)
        .set({ status: 'completed', endedAt: new Date() })
        .where(and(eq(agentSessions.id, args.data.sessionId!), eq(agentSessions.workspaceId, ctx.tenant_id))),
    );
  }

  // Emit SSE event
  emitWorkspaceEvent(ctx.tenant_id, {
    type: 'task_updated',
    data: { task: updated!, previousStatus, changedBy: 'agent' },
  });

  let content = `Task "${updated!.title}" marked complete. Moved to Done.`;
  if (args.data.githubPrUrl) content += `\nPR linked: ${args.data.githubPrUrl}`;

  return {
    content,
    structuredContent: { task: updated },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// D.4: log_blocker
// ──────────────────────────────────────────────────────────────────────────────
export async function logBlocker(ctx: McpAuthContext, rawArgs: Record<string, unknown>) {
  if (ctx.workspaceMode !== 'dev_project') return devModeError();

  const args = logBlockerArgs.safeParse(rawArgs);
  if (!args.success) {
    return { content: `Invalid arguments: ${args.error.message}`, structuredContent: { error: 'invalid_args' } };
  }

  // Explicit check — description must not be empty
  if (!args.data.description.trim()) {
    return {
      content: 'description is required and must not be empty. Describe clearly what failed and why you are blocked.',
      structuredContent: { error: 'description_required' },
    };
  }

  const taskRows = await withTenant(ctx.tenant_id, async (tx) =>
    tx.select().from(tasks).where(and(eq(tasks.id, args.data.taskId), eq(tasks.workspaceId, ctx.tenant_id))).limit(1),
  );
  const task = taskRows[0];
  if (!task) {
    return { content: 'Task not found.', structuredContent: { error: 'task_not_found' } };
  }
  if (task.status !== 'in_progress') {
    return {
      content: `Cannot log blocker on task in status '${task.status}'. Task must be in_progress.`,
      structuredContent: { error: 'invalid_status', task },
    };
  }

  const previousStatus = task.status;
  const [updated] = await withTenant(ctx.tenant_id, async (tx) =>
    tx
      .update(tasks)
      .set({
        status: 'audit_fix',
        blockerDescription: args.data.description,
        retryCount: sql`${tasks.retryCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, args.data.taskId))
      .returning(),
  );

  // Update session if provided
  if (args.data.sessionId) {
    await withTenant(ctx.tenant_id, async (tx) =>
      tx
        .update(agentSessions)
        .set({ status: 'failed', endedAt: new Date() })
        .where(and(eq(agentSessions.id, args.data.sessionId!), eq(agentSessions.workspaceId, ctx.tenant_id))),
    );
  }

  // Emit SSE event
  emitWorkspaceEvent(ctx.tenant_id, {
    type: 'task_updated',
    data: { task: updated!, previousStatus, changedBy: 'agent' },
  });

  return {
    content: `Blocker logged on "${updated!.title}". Task moved to Audit/Fix.\nRetry count: ${updated!.retryCount}. A workspace member will review.`,
    structuredContent: { task: updated },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// D.5: list_project_tasks
// ──────────────────────────────────────────────────────────────────────────────
export async function listProjectTasks(ctx: McpAuthContext, rawArgs: Record<string, unknown>) {
  if (ctx.workspaceMode !== 'dev_project') return devModeError();

  const args = listTasksArgs.safeParse(rawArgs);
  if (!args.success) {
    return { content: `Invalid arguments: ${args.error.message}`, structuredContent: { error: 'invalid_args' } };
  }

  const limit = Math.min(args.data.limit ?? 20, 100);

  const filters: ReturnType<typeof eq>[] = [eq(tasks.workspaceId, ctx.tenant_id)];
  if (args.data.status)   filters.push(eq(tasks.status, args.data.status));
  if (args.data.priority) filters.push(eq(tasks.priority, args.data.priority));

  const taskRows = await withTenant(ctx.tenant_id, async (tx) =>
    tx
      .select()
      .from(tasks)
      .where(and(...filters))
      .orderBy(asc(tasks.boardOrder), asc(tasks.createdAt))
      .limit(limit + 1),
  );

  const hasMore = taskRows.length > limit;
  const page = hasMore ? taskRows.slice(0, limit) : taskRows;

  const STATUS_BADGE: Record<string, string> = {
    backlog: '📋',
    in_progress: '🔄',
    review: '👀',
    audit_fix: '⚠️',
    done: '✅',
  };

  const summary = page.slice(0, 10).map((t) => {
    const badge = STATUS_BADGE[t.status] ?? '•';
    const cost = t.estimatedCostUsd != null ? ` · est. $${t.estimatedCostUsd.toFixed(2)}` : '';
    return `${badge} ${t.title} · ${t.priority}${cost}`;
  }).join('\n');

  const isFiltered = !!(args.data.status || args.data.priority);
  let content = `Found ${page.length} task${page.length !== 1 ? 's' : ''}${isFiltered ? ' (filtered)' : ''}:\n${summary}`;
  if (hasMore) content += `\n…and more (showing ${limit} of ${limit + 1}+)`;

  return {
    content,
    structuredContent: { tasks: page, total: page.length, filtered: isFiltered },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// D.6: get_skill_files
// ──────────────────────────────────────────────────────────────────────────────
export async function getSkillFiles(ctx: McpAuthContext, rawArgs: Record<string, unknown>) {
  if (ctx.workspaceMode !== 'dev_project') return devModeError();

  const args = getSkillFilesArgs.safeParse(rawArgs);
  if (!args.success) {
    return { content: `Invalid arguments: ${args.error.message}`, structuredContent: { error: 'invalid_args' } };
  }

  // Find the 'Skills' folder in this workspace
  const skillsFolderRows = await withTenant(ctx.tenant_id, async (tx) =>
    tx
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.workspaceId, ctx.tenant_id), eq(folders.name, 'Skills')))
      .limit(1),
  );

  if (!skillsFolderRows[0]) {
    return {
      content: 'No Skills folder found in this workspace. Create a folder named "Skills" and add skill files to it.',
      structuredContent: { skillFiles: [] },
    };
  }

  const folderId = skillsFolderRows[0].id;

  // Fetch docs in the Skills folder, optionally filtered by keyword
  const docRows = await withTenant(ctx.tenant_id, async (tx) => {
    let q = tx
      .select({ id: docs.id, title: docs.title, path: docs.path, markdown: docs.markdown })
      .from(docs)
      .where(and(
        eq(docs.workspaceId, ctx.tenant_id),
        eq(docs.folderId, folderId),
      ))
      .orderBy(asc(docs.title))
      .limit(50);

    return await q;
  });

  // Filter by query if provided (simple substring match)
  const filtered = args.data.query
    ? docRows.filter(
        (d) =>
          d.title.toLowerCase().includes(args.data.query!.toLowerCase()) ||
          d.markdown.toLowerCase().includes(args.data.query!.toLowerCase()),
      )
    : docRows;

  const skillFiles = filtered.map((d) => ({
    id: d.id,
    title: d.title,
    path: d.path,
    preview: d.markdown.slice(0, 100),
  }));

  if (skillFiles.length === 0) {
    const msg = args.data.query
      ? `No skill files matching "${args.data.query}" found in the Skills folder.`
      : 'No skill files found in the Skills folder.';
    return { content: msg, structuredContent: { skillFiles: [] } };
  }

  const listing = skillFiles
    .map((f) => `📄 ${f.title} — ${f.preview}${f.preview.length >= 100 ? '…' : ''}`)
    .join('\n');

  return {
    content: `Skill files in this workspace:\n${listing}`,
    structuredContent: { skillFiles },
  };
}

// ── Phase 2 Tool specs ────────────────────────────────────────────────────────

export const GET_CURRENT_SESSION_TOOL = {
  name: 'get_current_session',
  description: [
    'Returns the most recent active session for this workspace.',
    'Optionally filter by developerId to find your own session.',
    'Shows current cost, tool call count, and last tool used.',
  ].join('\n'),
  inputSchema: {
    type: 'object' as const,
    properties: {
      developerId: { type: 'string', description: 'Optional developer identifier to filter by.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, title: 'Get current session' },
};

export const GET_COST_SUMMARY_TOOL = {
  name: 'get_cost_summary',
  description: [
    'Returns a cost breakdown for the workspace.',
    'Aggregates by developer, agent, and model.',
    'Periods: today (default), week, month, all.',
  ].join('\n'),
  inputSchema: {
    type: 'object' as const,
    properties: {
      period: {
        type: 'string',
        description: 'Time period: "today" (default), "week", "month", "all".',
      },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, title: 'Get cost summary' },
};

export const LOG_MILESTONE_TOOL = {
  name: 'log_milestone',
  description: [
    'Logs a milestone event in the current session timeline.',
    'Milestones are lightweight markers (not tool calls) shown as dividers in the session detail view.',
    'Use to mark important checkpoints: "Tests passing", "PR opened", "Feature complete".',
  ].join('\n'),
  inputSchema: {
    type: 'object' as const,
    properties: {
      sessionId: { type: 'string', description: 'Session ID to log the milestone in.' },
      message:   { type: 'string', description: 'Milestone description (max 500 chars).' },
    },
    required: ['sessionId', 'message'],
    additionalProperties: false,
  },
  annotations: { title: 'Log milestone' },
};

// ── Phase 2 Argument schemas ──────────────────────────────────────────────────

const getCurrentSessionArgs = z.object({
  developerId: z.string().optional(),
});

const getCostSummaryArgs = z.object({
  period: z.enum(['today', 'week', 'month', 'all']).optional().default('today'),
});

const logMilestoneArgs = z.object({
  sessionId: z.string().min(1),
  message:   z.string().min(1).max(500),
});

// ── Phase 2 Handlers ──────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────────────
// Phase 2 D.1: get_current_session
// ──────────────────────────────────────────────────────────────────────────────
export async function getCurrentSession(ctx: McpAuthContext, rawArgs: Record<string, unknown>) {
  if (ctx.workspaceMode !== 'dev_project') return devModeError();

  const args = getCurrentSessionArgs.safeParse(rawArgs);
  if (!args.success) {
    return { content: `Invalid arguments: ${args.error.message}`, structuredContent: { session: null } };
  }

  const filters: ReturnType<typeof eq>[] = [
    eq(agentSessions.workspaceId, ctx.tenant_id),
    eq(agentSessions.status, 'active'),
  ];
  if (args.data.developerId) {
    filters.push(eq(agentSessions.developerId, args.data.developerId));
  }

  const rows = await withTenant(ctx.tenant_id, (tx) =>
    tx
      .select()
      .from(agentSessions)
      .where(and(...filters))
      .orderBy(desc(agentSessions.startedAt))
      .limit(1),
  );

  const session = rows[0];
  if (!session) {
    return {
      content: 'No active session found.',
      structuredContent: { session: null },
    };
  }

  // Get the last tool call for "last tool" display
  const lastToolRows = await withTenant(ctx.tenant_id, (tx) =>
    tx
      .select({ toolName: toolCalls.toolName, timestamp: toolCalls.timestamp })
      .from(toolCalls)
      .where(eq(toolCalls.sessionId, session.id))
      .orderBy(desc(toolCalls.timestamp))
      .limit(1),
  );
  const lastTool = lastToolRows[0];

  const startedMinsAgo = Math.round((Date.now() - session.startedAt.getTime()) / 60_000);
  const lastToolInfo = lastTool
    ? ` | Last tool: ${lastTool.toolName} (${Math.round((Date.now() - lastTool.timestamp.getTime()) / 60_000)} min ago)`
    : '';

  const content = [
    `Active session ${session.id} (${session.agent})`,
    `Started: ${startedMinsAgo} min ago | Cost so far: $${session.totalCostUsd.toFixed(6)} | Tool calls: ${session.totalToolCalls}${lastToolInfo}`,
    session.gitBranch ? `Branch: ${session.gitBranch}` : '',
  ].filter(Boolean).join('\n');

  return {
    content,
    structuredContent: { session },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Phase 2 D.2: get_cost_summary
// ──────────────────────────────────────────────────────────────────────────────
export async function getCostSummary(ctx: McpAuthContext, rawArgs: Record<string, unknown>) {
  if (ctx.workspaceMode !== 'dev_project') return devModeError();

  const args = getCostSummaryArgs.safeParse(rawArgs);
  if (!args.success) {
    return { content: `Invalid arguments: ${args.error.message}`, structuredContent: { error: 'invalid_args' } };
  }

  const period = args.data.period ?? 'today';

  // Calculate period start date
  let periodStart: Date | null = null;
  const now = new Date();
  if (period === 'today') {
    periodStart = new Date(now);
    periodStart.setHours(0, 0, 0, 0);
  } else if (period === 'week') {
    periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else if (period === 'month') {
    periodStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  }
  // 'all' → no date filter

  const baseFilter = periodStart
    ? and(
        eq(agentSessions.workspaceId, ctx.tenant_id),
        gte(agentSessions.startedAt, periodStart),
      )
    : eq(agentSessions.workspaceId, ctx.tenant_id);

  // Total cost + session counts
  const [totals] = await withTenant(ctx.tenant_id, (tx) =>
    tx
      .select({
        totalCostUsd:    sum(agentSessions.totalCostUsd),
        totalSessions:   sql<number>`count(*)::int`,
        activeSessions:  sql<number>`count(*) FILTER (WHERE status = 'active')::int`,
      })
      .from(agentSessions)
      .where(baseFilter),
  );

  // By developer
  const byDeveloper = await withTenant(ctx.tenant_id, (tx) =>
    tx
      .select({
        developerId:  agentSessions.developerId,
        costUsd:      sum(agentSessions.totalCostUsd),
        sessionCount: sql<number>`count(*)::int`,
      })
      .from(agentSessions)
      .where(baseFilter)
      .groupBy(agentSessions.developerId)
      .orderBy(desc(sum(agentSessions.totalCostUsd))),
  );

  // By agent
  const byAgent = await withTenant(ctx.tenant_id, (tx) =>
    tx
      .select({
        agent:        agentSessions.agent,
        costUsd:      sum(agentSessions.totalCostUsd),
        sessionCount: sql<number>`count(*)::int`,
      })
      .from(agentSessions)
      .where(baseFilter)
      .groupBy(agentSessions.agent)
      .orderBy(desc(sum(agentSessions.totalCostUsd))),
  );

  const totalCost = Number(totals?.totalCostUsd ?? 0);
  const devSummary = byDeveloper.map((d) => `${d.developerId} $${Number(d.costUsd ?? 0).toFixed(4)}`).join(' · ');
  const agentSummary = byAgent.map((a) => `${a.agent} $${Number(a.costUsd ?? 0).toFixed(4)}`).join(' · ');

  const content = [
    `Cost summary (${period}):`,
    `Total: $${totalCost.toFixed(6)}`,
    byDeveloper.length > 0 ? `By developer: ${devSummary}` : '',
    byAgent.length > 0 ? `By agent: ${agentSummary}` : '',
    `Sessions: ${totals?.totalSessions ?? 0} total, ${totals?.activeSessions ?? 0} active`,
  ].filter(Boolean).join('\n');

  return {
    content,
    structuredContent: {
      period,
      totalCostUsd: totalCost,
      byDeveloper:  byDeveloper.map((d) => ({ ...d, costUsd: Number(d.costUsd ?? 0) })),
      byAgent:      byAgent.map((a) => ({ ...a, costUsd: Number(a.costUsd ?? 0) })),
      activeSessions: totals?.activeSessions ?? 0,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Phase 2 D.3: log_milestone
// ──────────────────────────────────────────────────────────────────────────────
export async function logMilestone(ctx: McpAuthContext, rawArgs: Record<string, unknown>) {
  if (ctx.workspaceMode !== 'dev_project') return devModeError();

  const args = logMilestoneArgs.safeParse(rawArgs);
  if (!args.success) {
    return { content: `Invalid arguments: ${args.error.message}`, structuredContent: { error: 'invalid_args' } };
  }

  // Validate session exists and belongs to workspace
  const sessionRows = await withTenant(ctx.tenant_id, (tx) =>
    tx
      .select({ id: agentSessions.id, workspaceId: agentSessions.workspaceId })
      .from(agentSessions)
      .where(and(
        eq(agentSessions.id, args.data.sessionId),
        eq(agentSessions.workspaceId, ctx.tenant_id),
      ))
      .limit(1),
  );

  const session = sessionRows[0];
  if (!session) {
    return { content: 'Session not found.', structuredContent: { error: 'session_not_found' } };
  }

  // Insert as a special tool_calls row with toolName = '_milestone'
  const [milestone] = await withTenant(ctx.tenant_id, (tx) =>
    tx
      .insert(toolCalls)
      .values({
        sessionId:   args.data.sessionId,
        workspaceId: ctx.tenant_id,
        toolName:    '_milestone',
        inputJson:   { message: args.data.message },
        isError:     false,
      })
      .returning({ id: toolCalls.id, timestamp: toolCalls.timestamp }),
  );

  // Emit SSE event
  emitWorkspaceEvent(ctx.tenant_id, {
    type: 'session_cost_updated',
    data: {
      sessionId:      args.data.sessionId,
      developerId:    ctx.user_id,
      totalCostUsd:   0, // milestone doesn't change cost
      totalToolCalls: 0,
      latestToolName: '_milestone',
    },
  });

  return {
    content: `Milestone logged: '${args.data.message}'`,
    structuredContent: {
      milestoneId: milestone!.id,
      sessionId:   args.data.sessionId,
      timestamp:   milestone!.timestamp.toISOString(),
    },
  };
}

// ── Dev tool registry ─────────────────────────────────────────────────────────

export const DEV_TOOLS = [
  { spec: GET_NEXT_TASK_TOOL,        handler: getNextTask },
  { spec: CLAIM_TASK_TOOL,           handler: claimTask },
  { spec: COMPLETE_TASK_TOOL,        handler: completeTask },
  { spec: LOG_BLOCKER_TOOL,          handler: logBlocker },
  { spec: LIST_PROJECT_TASKS_TOOL,   handler: listProjectTasks },
  { spec: GET_SKILL_FILES_TOOL,      handler: getSkillFiles },
  // Phase 2 tools
  { spec: GET_CURRENT_SESSION_TOOL,  handler: getCurrentSession },
  { spec: GET_COST_SUMMARY_TOOL,     handler: getCostSummary },
  { spec: LOG_MILESTONE_TOOL,        handler: logMilestone },
] as const;

/**
 * list_projects — Sprint 4 Chunk E.1
 * Available in BOTH workspace modes (knowledge + dev_project).
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { projects, tasks } from '../../db/schema.js';
import { withTenant } from '../../db/with-tenant.js';
import type { McpAuthContext } from '../auth.js';

export const LIST_PROJECTS_TOOL = {
  name: 'list_projects',
  description: [
    'List projects in this workspace with task counts per status.',
    'Default: active projects only. Pass status="all" to include paused/archived.',
    'Available in both knowledge and dev_project workspace modes.',
  ].join('\n'),
  inputSchema: {
    type: 'object' as const,
    properties: {
      status: {
        type: 'string',
        description: "Filter by project status: 'active' (default), 'paused', 'completed', 'all'.",
      },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, title: 'List projects' },
};

const COLOR_CIRCLE: Record<string, string> = {
  '#f0997b': '🟠',
  '#fbbf24': '🟡',
  '#4ade80': '🟢',
  '#a78bfa': '🟣',
  '#60a5fa': '🔵',
  '#f87171': '🔴',
  '#34d399': '🟩',
  '#fb923c': '🟧',
  '#e879f9': '🩷',
  '#52525b': '⬜',
};

function colorCircle(color: string): string {
  return COLOR_CIRCLE[color.toLowerCase()] ?? '▪️';
}

export async function listProjects(ctx: McpAuthContext, rawArgs: Record<string, unknown>) {
  const statusFilter = typeof rawArgs.status === 'string' ? rawArgs.status : 'active';

  // The project LIST runs on the RAW db connection (the DATABASE_URL role, which HAS a SELECT
  // grant on projects; projects has no RLS — relrowsecurity=f — so a plain workspace filter is
  // correct and complete). It must NOT run inside withTenant: that does SET LOCAL ROLE
  // app_user, and app_user was never granted SELECT on `projects` (only docs/tasks/etc. were
  // set up for it), so the list comes back EMPTY under app_user — the bug we chased.
  const rows = await db
    .select()
    .from(projects)
    .where(
      statusFilter === 'all'
        ? eq(projects.workspaceId, ctx.tenant_id)
        : and(
            eq(projects.workspaceId, ctx.tenant_id),
            eq(projects.status, statusFilter),
          ),
    )
    .orderBy(asc(projects.boardOrder), asc(projects.createdAt));

  // ONLY the task-count aggregation runs inside withTenant, so the counts pass the SAME RLS
  // predicate (workspace_id = tenant AND app_can_see_project(project_id)) that
  // list_project_tasks enforces — keeping the two consistent. (app_user DOES have the grant on
  // tasks, so this is safe.)
  const countRows = await withTenant(ctx.tenant_id, async (tx) =>
    (await tx.execute(
      sql`SELECT project_id::text, status, COUNT(*)::int AS cnt
          FROM tasks
          WHERE workspace_id = ${ctx.tenant_id}::uuid
            AND project_id IS NOT NULL
          GROUP BY project_id, status`,
    )) as unknown as { project_id: string; status: string; cnt: number }[],
  );

  // TEMP DIAGNOSTIC (remove after): prove what tenant the request resolves to and how many
  // rows the scoped query returns vs an unscoped count — pinpoints auth-tenant vs query.
  try {
    const totalAny = (await db.execute(
      sql`SELECT COUNT(*)::int AS c FROM projects`,
    )) as unknown as { c: number }[];
    // eslint-disable-next-line no-console
    console.error(`[list_projects DEBUG] tenant_id=${ctx.tenant_id} scoped_rows=${rows.length} `
      + `total_projects_in_db=${totalAny?.[0]?.c} status=${statusFilter}`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[list_projects DEBUG] tenant_id=${ctx.tenant_id} scoped_rows=${rows.length} (count failed: ${String(e).slice(0, 80)})`);
  }

  if (rows.length === 0) {
    return {
      content: 'No projects found in this workspace.',
      structuredContent: { projects: [] },
    };
  }

  const countsMap: Record<string, Record<string, number>> = {};
  for (const r of countRows) {
    if (!countsMap[r.project_id]) countsMap[r.project_id] = {};
    countsMap[r.project_id]![r.status] = r.cnt;
  }

  const projectsWithCounts = rows.map((p) => {
    const tc = countsMap[p.id] ?? {};
    const total = Object.values(tc).reduce((a, b) => a + b, 0);
    const inProgress = tc['in_progress'] ?? 0;
    return { ...p, taskCounts: tc, _total: total, _inProgress: inProgress };
  });

  const lines = projectsWithCounts.map((p) => {
    const circle = colorCircle(p.color);
    const taskNote = p._total > 0
      ? ` — ${p._total} task${p._total !== 1 ? 's' : ''}${p._inProgress > 0 ? `, ${p._inProgress} in progress` : ''}`
      : ' — no tasks';
    return `${circle} ${p.name} (${p.slug})${taskNote}`;
  });

  return {
    content: `Projects in this workspace:\n${lines.join('\n')}`,
    structuredContent: {
      projects: projectsWithCounts.map(({ _total, _inProgress, ...p }) => p),
    },
  };
}

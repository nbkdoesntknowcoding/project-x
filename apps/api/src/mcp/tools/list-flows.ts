import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { flowNodes, flowVersions, flows } from '../../db/schema.js';
import { withTenant } from '../../db/with-tenant.js';
import type { McpAuthContext } from '../auth.js';
import { requireScope } from '../scope.js';
import { withAudit } from './audit.js';

/**
 * MCP tool: `list_flows`.
 *
 * Lists the *published* flows in the current workspace. Drafts are
 * deliberately hidden — Claude should only see the version the workspace
 * has chosen to expose. The tool returns each flow's slug as the public
 * `id` (not the database UUID) because the slug is human-readable and
 * stable: when a user says "walk the onboarding-engineering flow",
 * Claude can pass that string straight to `get_flow_step`.
 *
 * Phase 6.1 replaces the Phase 5 preview stub with this real implementation.
 */
export const LIST_FLOWS_TOOL = {
  name: 'list_flows',
  description: [
    'Lists published context flows defined in this workspace.',
    '',
    'A flow is a named, sequenced bundle of content steps the workspace author has prepared',
    'for AI agents. Each step in a flow has an instruction plus content (a doc, a snippet,',
    'or a freeform instruction). Use this tool to discover what flows are available, then',
    'call get_flow_step(flow_id, step_index) to walk through one step at a time.',
    '',
    'Drafts are not returned — only flows the author has published.',
    'Each item carries a `step_count` so you can size up the flow before walking it.',
    'Typical latency: under 100ms.',
  ].join('\n'),
  inputSchema: {
    type: 'object' as const,
    properties: {},
    additionalProperties: false,
  },
};

const argsSchema = z.object({}).strict();

export interface ListFlowsResult {
  flows: Array<{
    id: string;
    name: string;
    description: string | null;
    step_count: number;
    version: number;
  }>;
}

export async function listFlows(
  ctx: McpAuthContext,
  rawArgs: Record<string, unknown>,
): Promise<ListFlowsResult> {
  requireScope(ctx, 'docs:read');
  argsSchema.parse(rawArgs);

  return await withAudit(
    ctx,
    { tool_name: LIST_FLOWS_TOOL.name, args: {} },
    async () =>
      withTenant(ctx.tenant_id, async (tx) => {
        // Inner-join on the published version row so we only see flows
        // the author has explicitly published. The `deleted_at IS NULL`
        // filter belt-and-suspenders alongside RLS — the soft-delete
        // partial index `flows_active_idx` covers this case.
        const rows = await tx
          .select({
            slug: flows.slug,
            name: flows.name,
            description: flows.description,
            versionId: flowVersions.id,
            versionNumber: flowVersions.versionNumber,
            updatedAt: flows.updatedAt,
          })
          .from(flows)
          .innerJoin(flowVersions, eq(flowVersions.id, flows.publishedVersionId))
          .where(and(isNull(flows.deletedAt), eq(flowVersions.isPublished, true)))
          .orderBy(desc(flows.updatedAt));

        // Per-flow step counts. One small query each — flows are few.
        const out: ListFlowsResult['flows'] = [];
        for (const r of rows) {
          const c = await tx
            .select({ n: count() })
            .from(flowNodes)
            .where(eq(flowNodes.flowVersionId, r.versionId));
          out.push({
            id: r.slug,
            name: r.name,
            description: r.description,
            step_count: Number(c[0]?.n ?? 0),
            version: r.versionNumber,
          });
        }

        return { flows: out };
      }),
    (result) => ({ flow_count: result.flows.length }),
  );
}

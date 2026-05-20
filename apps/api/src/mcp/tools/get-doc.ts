import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { docs } from '../../db/schema.js';
import { withTenant } from '../../db/with-tenant.js';
import type { McpAuthContext } from '../auth.js';
import { requireScope } from '../scope.js';
import { withAudit } from './audit.js';

/**
 * MCP tool: `get_doc`.
 *
 * Returns the full markdown of a single doc, looked up by either id or
 * path (xor). The description is product copy — Claude reads it to decide
 * between get_doc, get_doc_section, and search_docs. Don't trim it.
 */
export const GET_DOC_TOOL = {
  name: 'get_doc',
  description: [
    'Fetches the full markdown content and metadata of a single doc.',
    '',
    'Use this when:',
    ' - You have a specific doc id or path from list_docs or search_docs',
    ' - The user asks "show me X", "read X to me", or refers to a doc by name',
    ' - You need the complete content of a doc to answer a question',
    '',
    'Do NOT use this when:',
    ' - You only need one section of a long doc — call get_doc_section instead',
    ' - You do not yet know which doc to fetch — call search_docs first',
    '',
    'Returns the full markdown, the title, and timestamps.',
    'Large docs are returned in full; consider get_doc_section for token efficiency.',
    'Typical latency: under 100ms.',
  ].join('\n'),
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: {
        type: 'string',
        description: 'The UUID of the doc to fetch. Mutually exclusive with path.',
      },
      path: {
        type: 'string',
        description: 'The path of the doc (as returned by list_docs). Mutually exclusive with id.',
      },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, title: 'Fetch the full content of a document' },
};

const argsSchema = z
  .object({
    id: z.string().uuid().optional(),
    path: z.string().min(1).optional(),
  })
  .refine((d) => Boolean(d.id) !== Boolean(d.path), {
    message: 'Provide exactly one of id or path',
  });

export interface GetDocResult {
  id: string;
  path: string;
  title: string;
  markdown: string;
  created_at: string;
  updated_at: string;
}

export async function getDoc(
  ctx: McpAuthContext,
  rawArgs: Record<string, unknown>,
): Promise<GetDocResult> {
  requireScope(ctx, 'docs:read');

  const args = argsSchema.parse(rawArgs);

  return await withAudit(
    ctx,
    { tool_name: GET_DOC_TOOL.name, args: args as Record<string, unknown> },
    async () =>
      withTenant(ctx.tenant_id, async (tx) => {
        const where = (
          args.id
            ? and(eq(docs.id, args.id), isNull(docs.deletedAt))
            : and(eq(docs.path, args.path!), isNull(docs.deletedAt))
        ) as SQL;

        const rows = await tx
          .select({
            id: docs.id,
            path: docs.path,
            title: docs.title,
            markdown: docs.markdown,
            createdAt: docs.createdAt,
            updatedAt: docs.updatedAt,
          })
          .from(docs)
          .where(where)
          .limit(1);

        if (rows.length === 0) {
          throw new Error('Doc not found');
        }
        const r = rows[0]!;
        return {
          id: r.id,
          path: r.path,
          title: r.title,
          markdown: r.markdown,
          created_at: r.createdAt.toISOString(),
          updated_at: r.updatedAt.toISOString(),
        };
      }),
    (result) => ({ doc_id: result.id, content_length: result.markdown.length }),
  );
}

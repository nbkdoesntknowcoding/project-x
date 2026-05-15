import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant } from '../../db/with-tenant.js';
import type { McpAuthContext } from '../auth.js';
import { requireScope } from '../scope.js';
import { withAudit } from './audit.js';

/**
 * MCP tool: `search_docs` (Phase 2.4 — keyword mode only).
 *
 * The `mode` parameter exists today with one accepted value (`"keyword"`)
 * so Phase 3 can add `"semantic"` and `"hybrid"` without changing the
 * tool signature claude.ai already learned. Don't widen the enum until
 * those modes actually ship.
 *
 * The query path:
 *   - `websearch_to_tsquery('english', $1)` for forgiving Google-style
 *     input (quoted phrases, OR, leading `-` for negation)
 *   - `ts_rank_cd(d.tsv, q.tsquery)` honors the schema's per-column
 *     weights (title = A = 1.0, body = B = 0.4)
 *   - `ts_headline` builds <mark>-tagged snippets natively
 *   - Two boolean expressions per row resolve `match_type` without a
 *     second round-trip
 *
 * Don't swap to `plainto_tsquery` "for simplicity" — the websearch flavor
 * is the right Claude-driven query shape.
 */
export const SEARCH_DOCS_TOOL = {
  name: 'search_docs',
  description: [
    'Searches docs in the current workspace by keyword. Use this when the user mentions a topic, term, or concept and you do not already know which doc to fetch.',
    '',
    'Use this when:',
    ' - The user asks "what do we have on X", "find docs about Y", "search for Z"',
    ' - You need to discover relevant docs before fetching content',
    ' - You are answering a question and need to ground it in our docs',
    '',
    'Do NOT use this when:',
    ' - You already know the doc id or path — call get_doc directly',
    ' - The user wants a directory listing — call list_docs',
    '',
    'Results are ranked by relevance and include a snippet with <mark> tags around hits, plus match_type ("title" / "body" / "both") so you can judge confidence — title matches are usually the strongest signal.',
    '',
    'The mode parameter currently accepts only "keyword". Semantic and hybrid modes will arrive in a future version; for now, prefer specific terms over abstract concepts (the keyword index understands stemming but not paraphrase). Quote multi-word phrases to require exact-order matches.',
    '',
    'Typical latency: under 100ms.',
  ].join('\n'),
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        minLength: 1,
        description:
          'The search query. Accepts plain words ("pricing tiers"), quoted phrases ("\\"customer onboarding\\""), and negation ("-deprecated").',
      },
      mode: {
        type: 'string',
        enum: ['keyword'],
        description: 'Search mode. Currently only "keyword" is supported. Defaults to "keyword".',
      },
      limit: {
        type: 'number',
        minimum: 1,
        maximum: 20,
        description: 'Maximum results to return. Defaults to 10.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

const argsSchema = z.object({
  query: z
    .string()
    .min(1)
    .refine((q) => q.trim().length > 0, {
      message: 'Query cannot be empty or whitespace-only',
    }),
  mode: z.enum(['keyword']).optional().default('keyword'),
  limit: z.number().int().min(1).max(20).optional().default(10),
});

export interface SearchHit {
  id: string;
  title: string;
  path: string;
  updated_at: string;
  rank: number;
  match_type: 'title' | 'body' | 'both';
  snippet: string;
}

export interface SearchResult {
  query: string;
  mode: 'keyword';
  results: SearchHit[];
}

/**
 * Row shape returned by the SQL below. postgres-js + drizzle return
 * snake_case keys directly from the SELECT — no auto camelCase mapping
 * happens for `tx.execute(sql`...`)`. The generic on `tx.execute<RawRow>`
 * threads this type through to the RowList.
 */
interface RawRow extends Record<string, unknown> {
  id: string;
  title: string;
  path: string;
  updated_at: Date | string;
  rank: number | string;
  snippet: string;
  title_match: boolean;
  body_match: boolean;
}

export async function searchDocs(
  ctx: McpAuthContext,
  rawArgs: Record<string, unknown>,
): Promise<SearchResult> {
  // Scope check FIRST — bubbles McpForbiddenError before audit / DB.
  requireScope(ctx, 'docs:read');

  const args = argsSchema.parse(rawArgs);

  return await withAudit(
    ctx,
    { tool_name: SEARCH_DOCS_TOOL.name, args: args as Record<string, unknown> },
    async () =>
      withTenant(ctx.tenant_id, async (tx) => {
        // The CTE binds `tsquery` once so we don't reparse the user input
        // four times (in the WHERE, the ts_rank_cd, the ts_headline, and
        // each match_type predicate).
        //
        // RLS is doing the workspace_id scoping for us via the
        // docs_tenant_select policy + app.tenant_id GUC; we only need the
        // soft-delete predicate here.
        const result = await tx.execute<RawRow>(sql`
          WITH q AS (
            SELECT websearch_to_tsquery('english', ${args.query}) AS tsquery
          )
          SELECT
            d.id,
            d.title,
            d.path,
            d.updated_at,
            ts_rank_cd(d.tsv, q.tsquery) AS rank,
            ts_headline(
              'english',
              d.markdown,
              q.tsquery,
              'StartSel=<mark>, StopSel=</mark>, MaxFragments=2, MaxWords=15, MinWords=5, ShortWord=2'
            ) AS snippet,
            (to_tsvector('english', coalesce(d.title, '')) @@ q.tsquery) AS title_match,
            (to_tsvector('english', coalesce(d.markdown, '')) @@ q.tsquery) AS body_match
          FROM docs d, q
          WHERE
            d.tsv @@ q.tsquery
            AND d.deleted_at IS NULL
          ORDER BY rank DESC
          LIMIT ${args.limit}
        `);

        // postgres-js RowList is array-like; iterate directly. Don't
        // dereference `.rows` — that's the node-postgres driver's shape,
        // not postgres-js.
        const hits: SearchHit[] = [];
        for (const r of result) {
          const matchType: SearchHit['match_type'] =
            r.title_match && r.body_match
              ? 'both'
              : r.title_match
                ? 'title'
                : 'body';
          hits.push({
            id: r.id,
            title: r.title,
            path: r.path,
            updated_at:
              r.updated_at instanceof Date
                ? r.updated_at.toISOString()
                : new Date(r.updated_at).toISOString(),
            rank: Number(r.rank),
            match_type: matchType,
            snippet: r.snippet,
          });
        }

        return {
          query: args.query,
          mode: 'keyword' as const,
          results: hits,
        };
      }),
    (result) => ({ result_count: result.results.length }),
  );
}

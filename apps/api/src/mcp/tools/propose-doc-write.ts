/**
 * MCP tool: `propose_doc_write`.
 *
 * Phase 10 — the model-facing half of the write-preview pattern. Computes a
 * preview of the proposed write WITHOUT committing, issues a signed
 * proposal_token, and returns structuredContent + the write-preview UI resource
 * URI. The actual commit only happens when the user clicks Approve in the iframe.
 *
 * Visibility: ["model"] — only the AI can call this tool.
 * The companion commit_proposed_write is ["app"]-only (UI-triggered only).
 *
 * Operations supported in Chunk 1: append, replace_section, replace_body, create, trash_doc.
 *
 * Gate: requireWriteScope → live role check → validate doc + args → issue token
 * Returns: content (short summary), structuredContent (preview + token)
 * No audit here — this is a read-phase (no commit). Audit happens in commit_proposed_write.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { docs, workspaceMembers } from '../../db/schema.js';
import { withSystemPrivilege } from '../../db/with-system-privilege.js';
import { withTenant } from '../../db/with-tenant.js';
import type { McpAuthContext } from '../auth.js';
import { requireWriteScope } from '../scope.js';
import { hashContent, issueProposalToken, storeProposalContent } from '../apps/proposal-token.js';

const WRITE_ROLES = new Set(['owner', 'admin', 'editor']);

export const PROPOSE_DOC_WRITE_TOOL_NAME = 'propose_doc_write';

export const PROPOSE_DOC_WRITE_TOOL_SPEC = {
  name: PROPOSE_DOC_WRITE_TOOL_NAME,
  description: [
    'Propose a write to a doc and open an interactive preview panel.',
    '',
    'Use this instead of direct write tools when the user asks to write/edit',
    'a doc. The proposed content is shown in a preview with Approve/Reject',
    'buttons — the commit only fires when the user clicks Approve.',
    '',
    'Supported operations:',
    '  append          — add blocks at the end of the doc (or after anchor)',
    '  replace_section — replace one section (requires anchor_id)',
    '  replace_body    — replace the entire doc body',
    '  create          — create a new doc (doc_id not required)',
    '  trash_doc       — soft-delete a doc',
    '',
    'Returns a summary in content. The preview panel opens automatically.',
    'REQUIRES: workspace:write scope.',
  ].join('\n'),
  inputSchema: {
    type: 'object' as const,
    properties: {
      operation: {
        type: 'string',
        enum: ['append', 'replace_section', 'replace_body', 'create', 'trash_doc'],
        description: 'The write operation to preview.',
      },
      doc_id: {
        type: 'string',
        description: 'UUID of the target doc (omit for create operation).',
      },
      markdown: {
        type: 'string',
        description: 'The proposed markdown content to write.',
      },
      anchor_id: {
        type: 'string',
        description: 'For replace_section: the anchor id of the section to replace.',
      },
      doc_name: {
        type: 'string',
        description: 'For create operation: the new doc title.',
      },
    },
    required: ['operation'],
    additionalProperties: false,
  },
  annotations: { destructiveHint: false, title: 'Propose a doc write (with preview)' },
};

const argsSchema = z.object({
  operation: z.enum(['append', 'replace_section', 'replace_body', 'create', 'trash_doc']),
  doc_id: z.string().uuid().optional(),
  markdown: z.string().max(100_000).optional(),
  anchor_id: z.string().min(1).max(64).optional(),
  doc_name: z.string().min(1).max(200).optional(),
}).strict();

export interface ProposeDocWriteResult {
  content: string;
  structuredContent: Record<string, unknown>;
  error?: string;
  message?: string;
}

export async function proposeDocWrite(
  ctx: McpAuthContext,
  rawArgs: Record<string, unknown>,
): Promise<ProposeDocWriteResult> {
  requireWriteScope(ctx);
  const args = argsSchema.parse(rawArgs);

  // Live role check
  const [member] = await withSystemPrivilege((tx) =>
    tx.select({ role: workspaceMembers.role }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, ctx.user_id), eq(workspaceMembers.workspaceId, ctx.tenant_id)))
      .limit(1),
  );
  if (!member || !WRITE_ROLES.has(member.role)) {
    return {
      content: 'Error: insufficient role.',
      structuredContent: {},
      error: 'insufficient_role',
      message: 'Only workspace owners, admins, and editors can write docs.',
    };
  }

  // For operations that target an existing doc, validate it exists
  let docTitle = args.doc_name ?? 'Untitled';
  let beforeContent: string | undefined;

  if (args.operation !== 'create') {
    if (!args.doc_id) {
      return {
        content: 'Error: doc_id required for this operation.',
        structuredContent: {},
        error: 'missing_doc_id',
      };
    }
    const docRows = await withTenant(ctx.tenant_id, (tx) =>
      tx.select({ id: docs.id, title: docs.title, markdown: docs.markdown })
        .from(docs)
        .where(and(eq(docs.id, args.doc_id!), isNull(docs.deletedAt)))
        .limit(1),
    );
    if (docRows.length === 0) {
      return {
        content: `Error: doc ${args.doc_id} not found.`,
        structuredContent: {},
        error: 'doc_not_found',
      };
    }
    docTitle = docRows[0]!.title ?? 'Untitled';
    if (args.operation === 'replace_section' || args.operation === 'replace_body') {
      const fullMarkdown = docRows[0]!.markdown ?? '';
      if (args.operation === 'replace_section' && args.anchor_id) {
        // Show a truncated before view for sections; full replace shows the whole doc.
        beforeContent = fullMarkdown.slice(0, 500) + (fullMarkdown.length > 500 ? '\n…' : '');
      } else {
        beforeContent = fullMarkdown;
      }
    }
  }

  const proposedContent = args.markdown ?? '';
  const contentHash = hashContent(proposedContent);

  const { token, nonce, exp } = issueProposalToken({
    u: ctx.user_id,
    w: ctx.tenant_id,
    d: args.doc_id ?? '',
    op: args.operation,
    h: contentHash,
    ...(args.anchor_id ? { a: args.anchor_id } : {}),
  });

  // Store proposed content for commit retrieval (in-memory, 10-min TTL)
  storeProposalContent(nonce, proposedContent, exp, args.anchor_id, args.doc_name);

  const structuredContent: Record<string, unknown> = {
    operation: args.operation,
    doc_id: args.doc_id ?? null,
    doc_title: docTitle,
    proposed_content: proposedContent,
    before_content: beforeContent ?? null,
    proposal_token: token,
    anchor_id: args.anchor_id ?? null,
  };

  const opDescriptions: Record<string, string> = {
    append: `append ${proposedContent.split('\n').filter(Boolean).length} line(s)`,
    replace_section: 'replace a section',
    replace_body: 'replace the entire body',
    create: 'create a new doc',
    trash_doc: 'trash the doc',
  };
  const opDesc = opDescriptions[args.operation] ?? args.operation;
  const contentSummary = `Proposed: ${opDesc} in "${docTitle}". Awaiting user approval in the preview panel.`;

  return { content: contentSummary, structuredContent };
}

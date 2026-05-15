import type { McpAuthContext } from './auth.js';

/**
 * 403-class failure: the token is valid but its `scopes` claim doesn't
 * include the scope the requested tool requires. Distinct from
 * McpUnauthorizedError because the HTTP semantics differ — a 401 invites
 * re-auth, a 403 says "this token will never be enough."
 */
export class McpForbiddenError extends Error {
  constructor(public readonly requiredScope: string) {
    super(`MCP forbidden: missing scope ${requiredScope}`);
    this.name = 'McpForbiddenError';
  }
}

/**
 * Throws McpForbiddenError if the caller's token does not carry `scope`.
 *
 * Phase 2.2 wires the primitive but no tool calls it yet (the registry is
 * empty in production builds). Phase 2.3's read tools use it for `docs:read`;
 * Phase 5's `append_to_doc` uses it for `docs:write`.
 */
export function requireScope(ctx: McpAuthContext, scope: string): void {
  if (!ctx.scopes.includes(scope)) {
    throw new McpForbiddenError(scope);
  }
}

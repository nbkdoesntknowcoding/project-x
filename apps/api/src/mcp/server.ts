import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerAppTool, registerAppResource } from '@modelcontextprotocol/ext-apps/server';
import type { McpAuthContext } from './auth.js';
import { mcpConfig } from './config.js';
import { McpForbiddenError } from './scope.js';
import { PRODUCTION_TOOLS } from './tools/index.js';
import { callTestProbe, isTestProbeName, registerTestProbe } from './_test-probe.js';
import { PROBE_HTML } from './apps/probe-html.js';
import { getWritePreviewHtml } from './apps/write-preview-html.js';
import {
  PROPOSE_DOC_WRITE_TOOL_NAME,
  PROPOSE_DOC_WRITE_TOOL_SPEC,
  proposeDocWrite,
} from './tools/propose-doc-write.js';
import {
  COMMIT_PROPOSED_WRITE_TOOL_NAME,
  COMMIT_PROPOSED_WRITE_TOOL_SPEC,
  commitProposedWrite,
} from './tools/commit-proposed-write.js';

/**
 * Build a fresh McpServer instance per request, capturing the verified
 * caller context in handler closures.
 *
 * Phase 10: migrated from low-level `Server` + setRequestHandler to `McpServer`
 * from @modelcontextprotocol/sdk/server/mcp.js. This enables use of
 * registerAppTool / registerAppResource from @modelcontextprotocol/ext-apps/server
 * to serve interactive HTML UIs in the conversation (MCP Apps).
 *
 * Why per-request: the MCP SDK's handler callbacks don't take a context bag —
 * request-scoped state (user/tenant) has to live in a closure. Module-level
 * context would be a catastrophic cross-tenant leak under concurrent requests.
 */

const WRITE_PREVIEW_RESOURCE_URI = 'ui://mnema/write-preview.html';
const PROBE_RESOURCE_URI = 'ui://mnema/probe.html';
const API_ORIGIN = process.env.MCP_BASE_URL ?? 'https://api.theboringpeople.in';

// ── JSON Schema → Zod raw shape converter ──────────────────────────────────
// SDK 1.29.0 requires registerTool to receive a Zod schema or raw Zod shape.
// Our tool specs carry plain JSON Schema objects for client documentation.
// This converter bridges the two so the SDK stays happy while tools/list
// still returns a proper (though simplified) schema for Claude to read.
// Real arg validation happens inside each handler via its own argsSchema.
type JsonSchemaProp = { type?: string; description?: string };
type JsonSchemaObj = { type?: string; properties?: Record<string, JsonSchemaProp>; required?: string[] };

// Returns undefined for no-property schemas so the SDK treats the tool as
// accepting any input (SDK rejects an empty {} object at runtime).
function jsonSchemaToZodShape(schema: object): Record<string, z.ZodTypeAny> | undefined {
  const s = schema as JsonSchemaObj;
  const entries = Object.entries(s.properties ?? {});
  if (entries.length === 0) return undefined;
  const required = new Set(s.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of entries) {
    let field: z.ZodTypeAny;
    switch (prop.type) {
      case 'number':  field = z.number(); break;
      case 'boolean': field = z.boolean(); break;
      default:        field = z.string(); break;
    }
    if (prop.description) field = field.describe(prop.description);
    if (!required.has(key)) field = field.optional();
    shape[key] = field;
  }
  return shape;
}

export function createMcpServer(ctx: McpAuthContext): McpServer {
  const mcpServer = new McpServer({
    name: mcpConfig.serverName,
    version: mcpConfig.serverVersion,
  });

  // ── Register all existing production tools ──────────────────────────────────
  for (const { spec, handler } of PRODUCTION_TOOLS) {
    // Test-only probes are registered separately below — skip if in test mode
    // to avoid duplicate registration; they'll be added via the probe path.
    mcpServer.registerTool(
      spec.name,
      {
        description: spec.description,
        inputSchema: jsonSchemaToZodShape(spec.inputSchema),
        annotations: spec.annotations,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (args: any) => {
        if (process.env.NODE_ENV === 'test' && isTestProbeName(spec.name)) {
          const result = await callTestProbe(ctx, spec.name, args as Record<string, unknown>);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        }
        try {
          const result = await handler(ctx, args as Record<string, unknown>);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        } catch (err) {
          if (err instanceof McpForbiddenError) throw err;
          const message = err instanceof Error ? err.message : String(err);
          return { isError: true, content: [{ type: 'text' as const, text: message }] };
        }
      },
    );
  }

  // ── Test-only probe tool ────────────────────────────────────────────────────
  if (process.env.NODE_ENV === 'test') {
    for (const probeDef of registerTestProbe()) {
      mcpServer.registerTool(
        probeDef.name,
        {
          description: probeDef.description,
          inputSchema: jsonSchemaToZodShape(probeDef.inputSchema as object),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (args: any) => {
          try {
            const result = await callTestProbe(ctx, probeDef.name, args as Record<string, unknown>);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          } catch (err) {
            return {
              isError: true,
              content: [{ type: 'text' as const, text: `Test probe error: ${err instanceof Error ? err.message : String(err)}` }],
            };
          }
        },
      );
    }
  }

  // ── Phase 10: propose_doc_write (model-visible, ["model"]) ──────────────────
  registerAppTool(
    mcpServer,
    PROPOSE_DOC_WRITE_TOOL_NAME,
    {
      description: PROPOSE_DOC_WRITE_TOOL_SPEC.description,
      inputSchema: jsonSchemaToZodShape(PROPOSE_DOC_WRITE_TOOL_SPEC.inputSchema),
      annotations: PROPOSE_DOC_WRITE_TOOL_SPEC.annotations,
      _meta: {
        ui: {
          resourceUri: WRITE_PREVIEW_RESOURCE_URI,
          visibility: ['model'],
        },
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) => {
      try {
        const result = await proposeDocWrite(ctx, args as Record<string, unknown>);
        if (result.error) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: result.message ?? result.error }],
          };
        }
        return {
          content: [{ type: 'text' as const, text: result.content }],
          structuredContent: result.structuredContent,
        };
      } catch (err) {
        if (err instanceof McpForbiddenError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: 'text' as const, text: message }] };
      }
    },
  );

  // ── Phase 10: commit_proposed_write (app-only, ["app"]) ────────────────────
  registerAppTool(
    mcpServer,
    COMMIT_PROPOSED_WRITE_TOOL_NAME,
    {
      description: COMMIT_PROPOSED_WRITE_TOOL_SPEC.description,
      inputSchema: jsonSchemaToZodShape(COMMIT_PROPOSED_WRITE_TOOL_SPEC.inputSchema),
      annotations: COMMIT_PROPOSED_WRITE_TOOL_SPEC.annotations,
      _meta: {
        ui: {
          // No resourceUri: this tool is only called from the write-preview iframe,
          // not associated with a new resource.
          visibility: ['app'], // HIDDEN from model — only the iframe Approve button can call this
        },
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) => {
      try {
        const result = await commitProposedWrite(ctx, args as Record<string, unknown>);
        if (result.error) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: result.message ?? result.error }],
          };
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as Record<string, unknown>,
        };
      } catch (err) {
        if (err instanceof McpForbiddenError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: 'text' as const, text: message }] };
      }
    },
  );

  // ── Phase 10: __ui_probe (dev/test only — temporary) ───────────────────────
  if (process.env.NODE_ENV !== 'production') {
    registerAppTool(
      mcpServer,
      '__ui_probe',
      {
        description: 'TEMPORARY — proves the MCP Apps protocol end-to-end. Remove after verification.',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        inputSchema: undefined,
        _meta: {
          ui: {
            resourceUri: PROBE_RESOURCE_URI,
            visibility: ['model'],
          },
        },
      },
      async () => {
        return {
          content: [{ type: 'text' as const, text: 'MCP Apps probe triggered. Check the panel.' }],
          structuredContent: {
            workspace_name: ctx.tenant_id,
            user_id: ctx.user_id,
            probe: 'connected',
            timestamp: new Date().toISOString(),
          },
        };
      },
    );
  }

  // ── Phase 10: UI resources ──────────────────────────────────────────────────

  // Write-preview HTML resource (production + all envs)
  registerAppResource(
    mcpServer,
    'Write Preview',
    WRITE_PREVIEW_RESOURCE_URI,
    {
      description: 'Mnema write-preview panel — shows proposed content with Approve/Reject.',
    },
    async () => ({
      contents: [{
        uri: WRITE_PREVIEW_RESOURCE_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: getWritePreviewHtml(),
        _meta: {
          ui: {
            csp: {
              connectDomains: [API_ORIGIN],
            },
          },
        },
      }],
    }),
  );

  // Probe HTML resource (dev/test only)
  if (process.env.NODE_ENV !== 'production') {
    registerAppResource(
      mcpServer,
      'Mnema Probe',
      PROBE_RESOURCE_URI,
      {
        description: 'Temporary hello-world MCP App probe.',
      },
      async () => ({
        contents: [{
          uri: PROBE_RESOURCE_URI,
          mimeType: 'text/html;profile=mcp-app',
          text: PROBE_HTML,
        }],
      }),
    );
  }

  return mcpServer;
}

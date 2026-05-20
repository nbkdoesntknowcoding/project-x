import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpAuthContext } from './auth.js';
import { mcpConfig } from './config.js';
import { McpForbiddenError } from './scope.js';
import { findTool, listToolSpecs } from './tools/index.js';
import { callTestProbe, isTestProbeName, registerTestProbe } from './_test-probe.js';

/**
 * Build a fresh MCP Server instance per request, capturing the verified
 * caller context in handler closures.
 *
 * Why per-request: the MCP SDK's setRequestHandler callbacks don't take a
 * context bag — request-scoped state has to live in a closure. Module-level
 * context would be a catastrophic cross-tenant leak under concurrent requests.
 *
 * Phase 2.3 adds the production read tools (list_docs, get_doc,
 * get_doc_section) to the catalog. The test-only probe stays gated on
 * NODE_ENV=test so MCP regression tests can keep running it.
 */
export function createMcpServer(ctx: McpAuthContext): Server {
  const server = new Server(
    {
      name: mcpConfig.serverName,
      version: mcpConfig.serverVersion,
    },
    {
      capabilities: { tools: {} },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = listToolSpecs().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.annotations ? { annotations: t.annotations } : {}),
    }));
    const allTools = [...tools];
    if (process.env.NODE_ENV === 'test') {
      allTools.push(...registerTestProbe());
    }
    return { tools: allTools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    // Test-only probe path. Gated on NODE_ENV so the probe can never reach
    // a production build, even if a name collision is engineered.
    if (process.env.NODE_ENV === 'test' && isTestProbeName(name)) {
      try {
        const result = await callTestProbe(ctx, name, args);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Test probe error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }

    const tool = findTool(name);
    if (!tool) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: `Unknown tool: ${name}. Call tools/list to see what is available.`,
          },
        ],
      };
    }

    try {
      const result = await tool.handler(ctx, args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (err) {
      // Scope failures bubble all the way to plugin.ts → 403. Anything else
      // becomes a tool-shaped { isError: true } so the model can surface
      // the message to the user without claude.ai treating it as transport
      // failure.
      if (err instanceof McpForbiddenError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text' as const, text: message }],
      };
    }
  });

  return server;
}

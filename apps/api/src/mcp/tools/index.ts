import type { McpAuthContext } from '../auth.js';
import { GET_DOC_SECTION_TOOL, getDocSection } from './get-doc-section.js';
import { GET_DOC_TOOL, getDoc } from './get-doc.js';
import { LIST_DOCS_TOOL, listDocs } from './list-docs.js';
import { SEARCH_DOCS_TOOL, searchDocs } from './search-docs.js';

/**
 * The production tool catalog. The MCP server reads this on each request
 * to build its tools/list response and to dispatch tools/call.
 *
 * Order matters subtly — Claude reads the catalog in the order returned,
 * and the description copy reinforces a primary flow:
 *
 *     search_docs (discover) → get_doc / get_doc_section (fetch)
 *
 * Putting search_docs first nudges the model toward that flow when both
 * search_docs and list_docs would technically work. list_docs stays a
 * separate tool because "show me all my docs" is a different intent than
 * "find docs about X" — both are legitimate.
 */

export interface McpToolSpec {
  name: string;
  description: string;
  inputSchema: object;
}

interface ToolDescriptor {
  spec: McpToolSpec;
  handler: (ctx: McpAuthContext, args: Record<string, unknown>) => Promise<unknown>;
}

export const PRODUCTION_TOOLS: readonly ToolDescriptor[] = [
  { spec: SEARCH_DOCS_TOOL, handler: searchDocs },
  { spec: LIST_DOCS_TOOL, handler: listDocs },
  { spec: GET_DOC_TOOL, handler: getDoc },
  { spec: GET_DOC_SECTION_TOOL, handler: getDocSection },
];

export function listToolSpecs(): McpToolSpec[] {
  return PRODUCTION_TOOLS.map((t) => t.spec);
}

export function findTool(name: string): ToolDescriptor | undefined {
  return PRODUCTION_TOOLS.find((t) => t.spec.name === name);
}

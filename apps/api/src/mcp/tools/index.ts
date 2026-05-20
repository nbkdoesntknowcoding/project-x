import type { McpAuthContext } from '../auth.js';
import { GET_DOC_SECTION_TOOL, getDocSection } from './get-doc-section.js';
import { GET_DOC_TOOL, getDoc } from './get-doc.js';
import { GET_FLOW_STEP_TOOL, getFlowStep } from './get-flow-step.js';
import { LIST_DOCS_TOOL, listDocs } from './list-docs.js';
import { LIST_FLOWS_TOOL, listFlows } from './list-flows.js';
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
  /** MCP tool annotations for directory submission compliance. */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    title?: string;
  };
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
  // Phase 6.1: real flow tools. list_flows returns published flows in the
  // workspace; get_flow_step walks one step of a published flow per call.
  // Drafts are deliberately invisible to MCP — only published versions are
  // walkable.
  { spec: LIST_FLOWS_TOOL, handler: listFlows },
  { spec: GET_FLOW_STEP_TOOL, handler: getFlowStep },
];

export function listToolSpecs(): McpToolSpec[] {
  return PRODUCTION_TOOLS.map((t) => t.spec);
}

export function findTool(name: string): ToolDescriptor | undefined {
  return PRODUCTION_TOOLS.find((t) => t.spec.name === name);
}

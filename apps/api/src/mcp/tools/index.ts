import type { McpAuthContext } from '../auth.js';
import {
  APPEND_BLOCKS_TO_DOC_TOOL,
  appendBlocksToDoc,
} from './append-blocks-to-doc.js';
import { ADD_FLOW_NODE_TOOL, addFlowNode } from './add-flow-node.js';
import { CONNECT_FLOW_NODES_TOOL, connectFlowNodes } from './connect-flow-nodes.js';
import { CREATE_DOC_TOOL, createDoc } from './create-doc.js';
import { CREATE_FLOW_TOOL, createFlow } from './create-flow.js';
import { CREATE_FOLDER_TOOL, createFolder } from './create-folder.js';
import { GET_DOC_SECTION_TOOL, getDocSection } from './get-doc-section.js';
import { GET_DOC_TOOL, getDoc } from './get-doc.js';
import { GET_FLOW_STEP_TOOL, getFlowStep } from './get-flow-step.js';
import { GET_FLOW_TOOL, getFlow } from './get-flow.js';
import { LIST_DOCS_TOOL, listDocs } from './list-docs.js';
import { LIST_FLOWS_TOOL, listFlows } from './list-flows.js';
import { LIST_FOLDERS_TOOL, listFolders } from './list-folders.js';
import { MOVE_DOC_TOOL, moveDoc } from './move-doc.js';
import { MOVE_FOLDER_TOOL, moveFolder } from './move-folder.js';
import { PUBLISH_FLOW_TOOL, publishFlow } from './publish-flow.js';
import { REMOVE_FLOW_EDGE_TOOL, removeFlowEdge } from './remove-flow-edge.js';
import { REMOVE_FLOW_NODE_TOOL, removeFlowNode } from './remove-flow-node.js';
import { RENAME_FOLDER_TOOL, renameFolder } from './rename-folder.js';
import { REPLACE_DOC_BODY_TOOL, replaceDocBody } from './replace-doc-body.js';
import { REPLACE_DOC_SECTION_TOOL, replaceDocSection } from './replace-doc-section.js';
import { SEARCH_DOCS_TOOL, searchDocs } from './search-docs.js';
import { TRASH_DOC_TOOL, trashDoc } from './trash-doc.js';
import { TRASH_FOLDER_TOOL, trashFolder } from './trash-folder.js';
import { UPDATE_FLOW_NODE_TOOL, updateFlowNode } from './update-flow-node.js';

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
  // Phase 9.1: write tools. append_blocks_to_doc is the only write tool;
  // it requires workspace:write scope + user confirmation + live role check.
  { spec: APPEND_BLOCKS_TO_DOC_TOOL, handler: appendBlocksToDoc },
  // Phase 9.2: additional write tools.
  { spec: CREATE_DOC_TOOL, handler: createDoc },
  { spec: REPLACE_DOC_SECTION_TOOL, handler: replaceDocSection },
  { spec: REPLACE_DOC_BODY_TOOL, handler: replaceDocBody },
  { spec: TRASH_DOC_TOOL, handler: trashDoc },
  // Phase 9.3: folder organisation — 1 read + 5 write tools.
  { spec: LIST_FOLDERS_TOOL, handler: listFolders },
  { spec: CREATE_FOLDER_TOOL, handler: createFolder },
  { spec: MOVE_DOC_TOOL, handler: moveDoc },
  { spec: MOVE_FOLDER_TOOL, handler: moveFolder },
  { spec: RENAME_FOLDER_TOOL, handler: renameFolder },
  { spec: TRASH_FOLDER_TOOL, handler: trashFolder },
  // Phase 9.4: flow writes — 1 new read + 7 write tools.
  // get_flow returns the DRAFT graph (for editing); get_flow_step serves PUBLISHED.
  { spec: GET_FLOW_TOOL, handler: getFlow },
  { spec: CREATE_FLOW_TOOL, handler: createFlow },
  { spec: ADD_FLOW_NODE_TOOL, handler: addFlowNode },
  { spec: UPDATE_FLOW_NODE_TOOL, handler: updateFlowNode },
  { spec: REMOVE_FLOW_NODE_TOOL, handler: removeFlowNode },
  { spec: CONNECT_FLOW_NODES_TOOL, handler: connectFlowNodes },
  { spec: REMOVE_FLOW_EDGE_TOOL, handler: removeFlowEdge },
  { spec: PUBLISH_FLOW_TOOL, handler: publishFlow },
];

export function listToolSpecs(): McpToolSpec[] {
  return PRODUCTION_TOOLS.map((t) => t.spec);
}

export function findTool(name: string): ToolDescriptor | undefined {
  return PRODUCTION_TOOLS.find((t) => t.spec.name === name);
}

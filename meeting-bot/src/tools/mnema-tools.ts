// meeting-bot/src/tools/mnema-tools.ts  (STEP 8 — Mnema Tools)
//
// These follow the VAP Control Plane tool pattern exactly (same as the Google
// Calendar tools: an HTTP handler keyed by the tool name, returning JSON to the
// pipeline). In the VAP, tool calls arrive as POST routes under /tools/* in
// control-plane/src/routes/tools.ts, and the LLM function schemas live in
// media-worker/providers/openai_llm.py (TOOL_DEFINITIONS). To register these:
//   1. Add each `mnemaToolDefinitions` entry to TOOL_DEFINITIONS (openai_llm.py).
//   2. Expose each `mnemaTools` fn as a POST /tools/<name> route, dispatching to
//      the matching function here. Do NOT invent a new dispatch system.

const MNEMA_API_BASE = process.env.MNEMA_API_URL; // e.g. https://api.theboringpeople.in
const MNEMA_API_KEY = process.env.MNEMA_API_KEY;

const headers = {
  Authorization: `Bearer ${MNEMA_API_KEY}`,
  'Content-Type': 'application/json',
};

export const mnemaTools = {
  // Create a task in Mnema during the meeting
  create_task: async (args: {
    title: string;
    description?: string;
    project_id?: string;
    assignee?: string;
  }) => {
    const res = await fetch(`${MNEMA_API_BASE}/api/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify(args),
    });
    const task = (await res.json()) as { id?: string };
    return {
      success: true,
      task_id: task.id,
      message: `Task created: "${args.title}"`,
    };
  },

  // Create a doc (pre-meeting brief, post-meeting notes, meeting notes)
  create_doc: async (args: {
    title: string;
    content: string;
    project_id?: string;
    type: 'pre_meeting' | 'post_meeting' | 'notes';
  }) => {
    const res = await fetch(`${MNEMA_API_BASE}/api/docs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: args.title, content: args.content, folderId: args.project_id }),
    });
    const doc = (await res.json()) as { id?: string };
    return { success: true, doc_id: doc.id, message: `Doc created: "${args.title}"` };
  },

  // Search the Mnema knowledge graph
  search_knowledge: async (args: { query: string }) => {
    const res = await fetch(
      `${MNEMA_API_BASE}/api/search?q=${encodeURIComponent(args.query)}`,
      { headers }
    );
    const results = (await res.json()) as { docs?: Array<{ title: string; summary?: string; content?: string }> };
    return {
      results: results.docs?.slice(0, 3).map((d: { title: string; summary?: string; content?: string }) => ({
        title: d.title,
        summary: d.summary ?? d.content?.slice(0, 200),
      })),
    };
  },

  // Get project context to inject into LLM
  get_project: async (args: { name: string }) => {
    const res = await fetch(
      `${MNEMA_API_BASE}/api/projects?name=${encodeURIComponent(args.name)}`,
      { headers }
    );
    const projects = (await res.json()) as unknown[];
    return projects[0] ?? { error: 'Project not found' };
  },

  // Link this meeting to a Mnema project (creates meeting graph node)
  link_meeting_to_project: async (args: {
    project_id: string;
    meeting_title: string;
    call_id: string;
  }) => {
    const res = await fetch(`${MNEMA_API_BASE}/api/graph/meetings`, {
      method: 'POST',
      headers,
      body: JSON.stringify(args),
    });
    return await res.json();
  },
};

// LLM function definitions — passed to GPT-4o-mini alongside VAP's existing tools.
// Mirror these into media-worker/providers/openai_llm.py TOOL_DEFINITIONS
// (wrapped as { type: 'function', function: <def> } to match the VAP's shape).
export const mnemaToolDefinitions = [
  {
    name: 'create_task',
    description: 'Create a task in Mnema for something that needs to be done. Use when someone commits to an action item.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title — concise action statement' },
        description: { type: 'string', description: 'More detail about what needs to be done' },
        project_id: { type: 'string', description: 'Mnema project UUID if known' },
      },
      required: ['title'],
    },
  },
  {
    name: 'create_doc',
    description: 'Create a document in Mnema. Use for meeting notes, decisions, or summaries.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string', description: 'Markdown content' },
        type: { type: 'string', enum: ['pre_meeting', 'post_meeting', 'notes'] },
        project_id: { type: 'string' },
      },
      required: ['title', 'content', 'type'],
    },
  },
  {
    name: 'search_knowledge',
    description: 'Search the Mnema knowledge graph to answer questions from meeting context.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'get_project',
    description: 'Get context about a Mnema project by name.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'link_meeting_to_project',
    description: 'Link this meeting to a Mnema project. Call when the project is identified.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        meeting_title: { type: 'string' },
        call_id: { type: 'string' },
      },
      required: ['project_id', 'meeting_title', 'call_id'],
    },
  },
];

export type MnemaToolName = keyof typeof mnemaTools;

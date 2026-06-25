"""
mnema_tool_defs.py — OpenAI function-tool schemas for the meeting bot's Mnema
tools. These are the tools GPT-4o-mini can call; the handlers in mnema_client.py
map each to the real Mnema MCP tool (search_docs, get_doc, create_task, etc.).

Knowledge-graph + doc-fetch tools let the bot actually answer from the workspace's
docs/graph; create_task/create_doc let it capture action items and meeting notes.
"""

MNEMA_TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "search_knowledge",
            "description": "Search the knowledge base (hybrid keyword + semantic). Each result is labelled with its project (project_name) — use that to answer about the RIGHT project and never mix projects. If the question is about a specific project, pass project_id (resolve it with list_projects first) to search only that project.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "What to look up"},
                    "mode": {"type": "string", "enum": ["hybrid", "keyword", "semantic"], "description": "Defaults to hybrid"},
                    "project_id": {"type": "string", "description": "Optional: restrict to this project (from list_projects)"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_projects",
            "description": "List the projects you can access (id, name, slug). Call this first to resolve a project the user named (e.g. 'the voice clone project') into a project_id before searching/listing within it.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "whoami",
            "description": "Who you are currently talking to: their name, job title, org role, team, department and workspace access. Call this whenever someone asks who they are, what their role/title/team is, or what they can access.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_recent_docs",
            "description": "List the most recently updated docs (newest first). Use for 'latest', 'recent', or 'what's new' questions instead of search. Pass project_id to scope to one project.",
            "parameters": {
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "description": "How many (default 10)"},
                    "project_id": {"type": "string", "description": "Optional: restrict to this project"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_project_tasks",
            "description": "List a live task board (what's in progress, in review, done, etc.). Use for questions about tasks, status, the latest build, or what moved — this reflects today's board, not docs. Pass project (id or slug, from list_projects) to scope to one project.",
            "parameters": {
                "type": "object",
                "properties": {
                    "status": {"type": "string", "description": "Optional: backlog | in_progress | review | audit_fix | done"},
                    "project": {"type": "string", "description": "Optional: project id or slug to scope to"},
                    "limit": {"type": "integer", "description": "How many (default 20)"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_doc",
            "description": "Fetch the full markdown of a single doc by id (from search_knowledge) or by path. Use when you need complete content to answer.",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "Doc UUID (mutually exclusive with path)"},
                    "path": {"type": "string", "description": "Doc path (mutually exclusive with id)"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_doc_section",
            "description": "Fetch a single section of a doc by heading — cheaper than the whole doc when only one section is relevant.",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "Doc UUID"},
                    "heading": {"type": "string", "description": "Heading text or 'Parent > Heading' path"},
                },
                "required": ["id", "heading"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_task",
            "description": "Create a task in Mnema when someone commits to an action item. Confirm verbally after.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Concise action statement"},
                    "description": {"type": "string"},
                    "priority": {"type": "string", "enum": ["low", "medium", "high", "critical"]},
                    "project_id": {"type": "string", "description": "Project UUID if known (else the default is used)"},
                },
                "required": ["title"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_doc",
            "description": "Save a document in Mnema — e.g. post-meeting notes or a summary. Markdown content.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "content": {"type": "string", "description": "Markdown body"},
                    "folder_id": {"type": "string", "description": "Optional target folder UUID"},
                },
                "required": ["title", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_project",
            "description": "Get context about a Mnema project by id or slug.",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "slug": {"type": "string"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "traverse_graph",
            "description": "Explore the knowledge graph: shortest path between two nodes, or the 1-hop neighborhood of one node.",
            "parameters": {
                "type": "object",
                "properties": {
                    "from": {"type": "string", "description": "Start node id/name"},
                    "to": {"type": "string", "description": "Optional end node id/name for a path"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_god_nodes",
            "description": "Return the most central/important nodes in the knowledge graph (by betweenness centrality).",
            "parameters": {
                "type": "object",
                "properties": {"limit": {"type": "integer", "description": "How many (default 10)"}},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_graph_report",
            "description": "Fetch the knowledge-graph summary report (communities, themes, key connections).",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_surprising_connections",
            "description": "Cross-domain links the graph found between different kinds of things (e.g. a doc in one project related to a flow in another). Use to volunteer a relevant cross-project connection.",
            "parameters": {
                "type": "object",
                "properties": {"limit": {"type": "integer", "description": "Max connections (default 10)"}},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_concept_context",
            "description": "Hydrate a concept/topic/decision into the ACTUAL source text behind it — follows the concept to the docs it connects to in the graph and returns the matched passages. Use when someone asks what a concept or decision actually says or means and you want concrete detail, not just that the topic exists.",
            "parameters": {
                "type": "object",
                "properties": {
                    "concept": {"type": "string", "description": "Concept/topic label to hydrate"},
                    "limit": {"type": "integer", "description": "Max source docs (default 3)"},
                },
                "required": ["concept"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_meeting_context",
            "description": "Identity of a meeting — its title, project, and participants. Use for 'what meeting is this', 'which project is this meeting for', 'who's on the invite'. Look up by meeting_id (or the live bot's recall_bot_id).",
            "parameters": {
                "type": "object",
                "properties": {
                    "meeting_id": {"type": "string", "description": "Meeting UUID"},
                    "recall_bot_id": {"type": "string", "description": "Recall bot id (live bot)"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_meeting_brief",
            "description": "The room-safe start brief — where we left off last time + related meetings, as plain text, ACL-scoped to what EVERYONE in the room may see. Use at the start of a meeting for 'what happened last time / where did we leave off'. Returns empty when there's nothing the whole room can hear.",
            "parameters": {
                "type": "object",
                "properties": {
                    "meeting_id": {"type": "string", "description": "Meeting UUID"},
                    "recall_bot_id": {"type": "string", "description": "Recall bot id (live bot)"},
                },
            },
        },
    },
]

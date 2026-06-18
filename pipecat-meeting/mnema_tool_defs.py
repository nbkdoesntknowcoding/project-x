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
            "description": "Search the Mnema knowledge base (hybrid keyword + semantic) to answer questions from meeting context. Returns ranked doc snippets with ids you can pass to get_doc.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "What to look up"},
                    "mode": {"type": "string", "enum": ["hybrid", "keyword", "semantic"], "description": "Defaults to hybrid"},
                },
                "required": ["query"],
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
]

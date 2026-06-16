"""
mnema_tool_defs.py — OpenAI function-tool schemas for the Mnema meeting tools
(STEP 8). Mirror of meeting-bot/src/tools/mnema-tools.ts `mnemaToolDefinitions`,
wrapped in the {type: function, function: ...} shape Pipecat/OpenAI expect (the
same shape as the VAP's TOOL_DEFINITIONS in media-worker/providers/openai_llm.py).

Dispatch follows the VAP Control Plane pattern: the LLM emits a tool_call, which
is routed to an HTTP handler (control-plane /tools/<name>) that calls the Mnema
API. Register the function-call handlers on the OpenAILLMService accordingly —
do NOT invent a new dispatch system.
"""

MNEMA_TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "create_task",
            "description": "Create a task in Mnema for something that needs to be done. Use when someone commits to an action item.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Task title — concise action statement"},
                    "description": {"type": "string", "description": "More detail about what needs to be done"},
                    "project_id": {"type": "string", "description": "Mnema project UUID if known"},
                },
                "required": ["title"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_doc",
            "description": "Create a document in Mnema. Use for meeting notes, decisions, or summaries.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "content": {"type": "string", "description": "Markdown content"},
                    "type": {"type": "string", "enum": ["pre_meeting", "post_meeting", "notes"]},
                    "project_id": {"type": "string"},
                },
                "required": ["title", "content", "type"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_knowledge",
            "description": "Search the Mnema knowledge graph to answer questions from meeting context.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_project",
            "description": "Get context about a Mnema project by name.",
            "parameters": {
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "link_meeting_to_project",
            "description": "Link this meeting to a Mnema project. Call when the project is identified.",
            "parameters": {
                "type": "object",
                "properties": {
                    "project_id": {"type": "string"},
                    "meeting_title": {"type": "string"},
                    "call_id": {"type": "string"},
                },
                "required": ["project_id", "meeting_title", "call_id"],
            },
        },
    },
]

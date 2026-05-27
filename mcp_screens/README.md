# Mnema · MCP-embedded UI screens

Five UI surfaces that render **inside Claude's conversation** when Claude calls a
Mnema MCP tool. They're branded as Mnema (dark canvas, amber accent, Geist) but
wrapped in a thin "Claude chrome" frame — a tool-call attribution line above,
and a continuation of Claude's reply below — so you can see how they sit in
context.

| # | File | MCP tool | Purpose |
| --- | --- | --- | --- |
| 1 | `01-Walk-Simulator.html`     | `walk_flow`       | Step-by-step runner. Segmented progress bar. At decision steps, clickable branch buttons. |
| 2 | `02-Flow-Graph-Canvas.html`  | `get_flow_graph`  | Visual graph: cards as nodes, arrows with branch labels, right-side detail drawer when a node is selected. |
| 3 | `03-Doc-Write-Preview.html`  | `write_doc`       | Pre-commit diff for a doc edit. Add/remove/context lines with line numbers and a hunk header. Approve / Reject. |
| 4 | `04-Flow-Publish-Preview.html` | `publish_flow`  | Pre-publish diff of a flow draft — v07 → v08, the five node changes since the last published version. |
| 5 | `05-Folder-Trash-Preview.html` | `trash_folder`  | Destructive-action confirmation. Folder rendering, impact stats, a callout when flows still cite it. |

## How the framing works

Each file shares `_mcp.css`. The page is the warm "Claude paper" background
(`--paper: #F5F3EE`), the toolname pill above the card carries `mnema.<tool>` in
mono, and the card itself is the full Mnema dark surface. Below the card, a
short follow-up paragraph stands in for what Claude would say after the user
acts. Keep the framing — it makes the screen legible as a tool surface, not
just a screenshot of the product.

## Hard rules these surfaces inherit

- One accent at most per card — used for the primary action button (Continue, Approve, Publish) or the current state pill, never both.
- Mono labels in UPPERCASE with `0.06em` tracking for everything meta.
- Destructive actions use the coral status color (`--status-error`) on the *button only* — never as a background flood.
- No emoji. No icon decoration. Status-bar style "MCP · v2025-11-25" identifier visible on the card's right-side meta.

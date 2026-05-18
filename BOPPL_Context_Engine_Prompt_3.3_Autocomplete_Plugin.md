# Claude Code Prompt 3.3 — Autocomplete ProseMirror Plugin

---

```
═══════════════════════════════════════════════════════════════════════
🛑 HARD RULE — READ BEFORE TAKING ANY ACTION

This build runs LOCAL-ONLY until the user issues an explicit
deployment command ("deploy now" or equivalent) in their own words.

You MUST NOT in this prompt:
  • Create accounts on Fly, Vercel, Neon, Upstash, Cloudflare, Stripe
  • Run cloud CLI deploy/provision commands
  • Configure DNS, custom domains, or TLS certificates
  • Call Gemini, OpenAI, or any real LLM (that's 3.4)

You MUST in this prompt:
  • Run everything against localhost
  • Use a stub backend endpoint that returns canned completions

Deployment is Phase D. Real LLM integration is 3.4.
═══════════════════════════════════════════════════════════════════════
```

---

## Pre-flight — known state after 3.2

Phase 3.2 is verified:
- `search_docs` supports keyword / semantic / hybrid modes
- Query embeddings cache to Redis with 10-minute TTL
- 100+ tests passing including the 9 new hybrid-search tests
- HNSW + GIN indexes both confirmed in use via EXPLAIN

If any of that is broken, **stop and fix before continuing**. Layering autocomplete on top of a wobbling search system is fine — they're orthogonal — but base-state hygiene matters.

## What you are building in this prompt

The autocomplete UI in the editor. The "Cursor for docs" surface. By the end:

1. As the user types in the Milkdown editor, a 350ms debounced request fires for an inline completion.
2. The completion renders as **ghost text** inline at the cursor — same font, same size, color `--editor-ghost-text` from the design system.
3. **Tab** accepts the suggestion: the ghost text becomes real text, the cursor advances to its end.
4. **Escape** dismisses the suggestion.
5. **Any other keystroke** during a pending request aborts it (`AbortController.abort()`) and any visible ghost text disappears.
6. **A tiny "AI" pill** appears 4px right of the ghost text's end, fading in 200ms after the suggestion appears.
7. The trigger gating is correct: completions fire only when the cursor is at end-of-word or end-of-line in a typeable text context — never inside a code block, math node, mermaid block, or other atom node.
8. The backend endpoint exists as a **stub** that returns canned text. This prompt does not call any real LLM. 3.4 swaps the stub for streaming Gemini.

What is **not** in this prompt:
- Real LLM integration (3.4)
- SSE streaming (3.4 — the stub returns the full string in one response, simulating a synchronous completion)
- Rate limiting (3.4)
- Token-budget management on the prompt side (3.4)
- Telemetry for accept/reject rate (Phase 4 polish)

The reason for the split: ProseMirror plugin engineering and LLM integration are independent problems. By stubbing the backend, we can verify the interaction model — debounce timing, Tab/Esc/Abort semantics, ghost-text rendering, trigger gating — without any LLM variability. When 3.4 replaces the stub, if autocomplete feels janky, we know the bug is on the LLM side because the UI is already proven.

---

## Architecture

### Where the ghost text lives

ProseMirror's `Decoration.widget` is the right primitive. It lets us insert non-document DOM (the ghost text span and the AI pill) at a specific position without touching the actual document content. The widget is purely visual; the document is unchanged until Tab is pressed.

A `Plugin` with a state field tracks:
- The current suggestion text (if any)
- The position the suggestion was issued for (so we can detect "cursor moved, suggestion is stale")
- An AbortController for the in-flight request (if any)
- A debounce timer handle

When the suggestion text is non-empty and the cursor is still at the issued position, we add a `Decoration.widget` at that position. Otherwise the decoration set is empty.

### The debounce model

350ms feels right and is what Cursor uses. Shorter and you fire too often; longer and the UX feels laggy. We anchor it as a config value (`AUTOCOMPLETE_DEBOUNCE_MS=350`) so 3.4 can tune from data without changing code.

The debounce is "trailing" — the timer resets on every keystroke; we fire when the timer elapses with no further input. This is the correct shape: we want one request after the user *paused*, not one request per character.

### The abort model

This matters more than the debounce model. Every new keystroke during an in-flight request must:
1. Cancel the in-flight `fetch` via its `AbortController.abort()`
2. The backend must propagate the abort to upstream LLM calls (3.4 will), so cancelled requests don't bill

For 3.3 with a stub backend, the abort just means the response never lands. For 3.4 with real LLM calls, the abort propagation is the difference between $5/day and $50/day on Voyage/Gemini bills under bursty editing.

### Trigger gating

We **don't** want autocomplete firing:
- Inside `code_block`, `math_inline`, `math_block`, or any atom node
- When the cursor is at the start of a line with no characters yet typed
- When there's a selection (autocomplete is for the next-token case, not for replacing selected text)
- In the middle of a word — only at word boundaries, end-of-line, or after punctuation

The gate is a single `shouldTrigger(state: EditorState): boolean` function evaluated on every transaction. It's fast (purely structural) and runs synchronously.

### The "AI" pill

Visual signal that the ghost text came from us. Fades in 200ms after the ghost text appears (so it doesn't feel pushy) and disappears the moment the suggestion is dismissed or accepted. Color: `--text-tertiary` on a `--surface-overlay` background, 1px `--border-default`. Tiny — `--text-xs` font, 4px horizontal padding. The design system already specs it; we just render it.

### The stub backend

A new route `POST /api/complete/_stub` accepts `{ prefix: string, suffix: string }` and returns `{ text: string }` after a 200-400ms artificial delay (simulating LLM latency). The canned text is deterministic from the prefix — last word of the prefix, returned as " continuation." That makes verification easy: type "hello world" and you get " continuation"; type "the quick brown" and you get " continuation". Always the same shape, always 1 token of artificial delay variation.

The route requires authentication (the existing cookie-auth from 0.2 handles this — autocomplete is a web-app surface, not an MCP surface). It does NOT require any scope check; autocomplete is a UX feature, not gated by MCP scopes.

---

## Tech stack additions

No new packages. Reuses what's already in place:
- `prosemirror-state` and `prosemirror-view` are already deps via Milkdown
- The existing `apps/web/src/lib/api.ts` typed fetch wrapper handles the call

The only new code is the plugin itself plus its CSS, the editor wiring, and the stub backend route.

---

## File structure — additions

```
apps/api/src/
└── routes/
    └── complete.ts                  [NEW — POST /api/complete/_stub]

apps/web/src/components/editor/
├── plugins/
│   └── autocomplete/
│       ├── plugin.ts                [NEW — the ProseMirror plugin]
│       ├── trigger.ts               [NEW — shouldTrigger() gating logic]
│       ├── ghost-widget.ts          [NEW — Decoration.widget DOM construction]
│       └── client.ts                [NEW — the fetch wrapper with AbortController]
├── Editor.tsx                       [UPDATED — register autocompletePlugin]
└── editor.css                       [UPDATED — ghost-text + AI-pill styles]

apps/web/src/lib/
└── api.ts                           [UPDATED — typed completion call (still hits stub)]
```

---

## Implementation steps in order

### Step 1: Env additions

Append to `.env.example`:

```bash
# Autocomplete
AUTOCOMPLETE_DEBOUNCE_MS=350
AUTOCOMPLETE_MAX_PREFIX_CHARS=2000
AUTOCOMPLETE_MAX_SUFFIX_CHARS=500
```

Add to `apps/api/src/config/env.ts`:

```typescript
AUTOCOMPLETE_DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(350),
AUTOCOMPLETE_MAX_PREFIX_CHARS: z.coerce.number().int().positive().default(2000),
AUTOCOMPLETE_MAX_SUFFIX_CHARS: z.coerce.number().int().nonnegative().default(500),
```

The `MAX_PREFIX` / `MAX_SUFFIX` caps will matter in 3.4 (LLM token budget); they're declared now so the contract is stable.

### Step 2: The stub backend route

Create `apps/api/src/routes/complete.ts`:

```typescript
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

const bodySchema = z.object({
  prefix: z.string().max(10000),
  suffix: z.string().max(2000),
  doc_id: z.string().uuid(),
});

export const completeRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/complete/_stub', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });

    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });

    // Artificial latency between 200-400ms to simulate LLM response time
    await new Promise((r) => setTimeout(r, 200 + Math.floor(Math.random() * 200)));

    // Deterministic stub: return " continuation" if the prefix ends with a word,
    // otherwise return an empty string to verify the trigger gating.
    const trimmed = parsed.data.prefix.trimEnd();
    const lastChar = trimmed.length > 0 ? trimmed[trimmed.length - 1]! : '';
    const isWordChar = /[A-Za-z0-9]/.test(lastChar);

    if (!isWordChar) {
      return { text: '' };
    }

    // Return a deterministic continuation that's recognizable in tests
    return { text: ' continuation' };
  });
};
```

Register in `apps/api/src/server.ts`:

```typescript
import { completeRoutes } from './routes/complete.js';
// ... after the other route registrations:
await app.register(completeRoutes);
```

### Step 3: Web — typed completion call

Update `apps/web/src/lib/api.ts` — add to the `api` export object:

```typescript
interface CompletionRequest {
  prefix: string;
  suffix: string;
  doc_id: string;
}

interface CompletionResponse {
  text: string;
}

export const api = {
  // ... existing entries
  complete: (body: CompletionRequest, signal: AbortSignal) =>
    apiFetch<CompletionResponse>('/api/complete/_stub', {
      method: 'POST',
      body,
      signal,
    }),
};
```

Update `apiFetch` to forward the `signal` option to the underlying `fetch`:

```typescript
async function apiFetch<T>(path: string, opts: FetchOptions = {}): Promise<T> {
  const init: RequestInit = {
    ...opts,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
    },
    body: opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)
      ? JSON.stringify(opts.body)
      : (opts.body as BodyInit | undefined),
    signal: opts.signal,
  };
  // ... unchanged
}
```

`FetchOptions` needs an optional `signal: AbortSignal`. Add it to the interface.

### Step 4: Web — trigger gating

Create `apps/web/src/components/editor/plugins/autocomplete/trigger.ts`:

```typescript
import type { EditorState } from 'prosemirror-state';

const ATOM_NODE_TYPES = new Set([
  'code_block',
  'math_inline',
  'math_block',
  'horizontal_rule',
  'image',
]);

const PARAGRAPH_NODE_TYPES = new Set([
  'paragraph',
  'heading',
  'blockquote',
]);

export function shouldTrigger(state: EditorState): { ok: boolean; reason?: string } {
  const { selection, doc } = state;

  // No selection — only at-cursor completions
  if (!selection.empty) return { ok: false, reason: 'has_selection' };

  const $cursor = selection.$head;
  const parent = $cursor.parent;

  // Must be inside a typeable text container
  if (!PARAGRAPH_NODE_TYPES.has(parent.type.name)) {
    // Inside a list item, the parent is paragraph wrapping text; the immediate
    // ancestor is list_item. We check the parent (which is the text container).
    return { ok: false, reason: `non_text_parent:${parent.type.name}` };
  }

  // Walk up: are we inside an atom node anywhere up the tree?
  for (let depth = $cursor.depth; depth > 0; depth--) {
    const ancestor = $cursor.node(depth);
    if (ATOM_NODE_TYPES.has(ancestor.type.name)) {
      return { ok: false, reason: `inside_atom:${ancestor.type.name}` };
    }
  }

  // Are we at the very start of an empty doc? Skip.
  const textBefore = $cursor.parent.textBetween(0, $cursor.parentOffset);
  if (textBefore.length === 0) {
    return { ok: false, reason: 'start_of_empty_block' };
  }

  // End-of-word or end-of-line check
  // - end-of-line: cursor at end of parent's text
  // - end-of-word: last character is alphanumeric AND (next char doesn't exist
  //   OR next char is whitespace/punctuation)
  const lastChar = textBefore[textBefore.length - 1]!;
  const isWordChar = /[A-Za-z0-9]/.test(lastChar);
  if (!isWordChar) {
    return { ok: false, reason: 'cursor_after_non_word' };
  }

  const atEndOfBlock = $cursor.parentOffset === $cursor.parent.content.size;
  if (atEndOfBlock) return { ok: true };

  // Mid-block: check the next character is a word boundary
  const textAfter = $cursor.parent.textBetween($cursor.parentOffset, $cursor.parent.content.size);
  const nextChar = textAfter[0] ?? '';
  if (/[A-Za-z0-9]/.test(nextChar)) {
    return { ok: false, reason: 'mid_word' };
  }

  return { ok: true };
}

export function extractContext(state: EditorState, maxPrefixChars: number, maxSuffixChars: number): {
  prefix: string;
  suffix: string;
} {
  const $cursor = state.selection.$head;
  const docText = state.doc.textBetween(0, state.doc.content.size, '\n', '\n');
  const cursorPos = positionToTextOffset(state);

  const prefix = docText.slice(Math.max(0, cursorPos - maxPrefixChars), cursorPos);
  const suffix = docText.slice(cursorPos, cursorPos + maxSuffixChars);

  return { prefix, suffix };
}

function positionToTextOffset(state: EditorState): number {
  // Walk from doc start to the cursor, accumulating text length.
  let offset = 0;
  const targetPos = state.selection.from;
  state.doc.nodesBetween(0, targetPos, (node, pos) => {
    if (node.isText) {
      const slice = node.text!.slice(0, Math.max(0, targetPos - pos));
      offset += slice.length;
    } else if (node.isBlock && pos < targetPos && offset > 0) {
      offset += 1; // implicit newline between blocks (matches the '\n' separator in textBetween)
    }
    return true;
  });
  return offset;
}
```

A note on the `positionToTextOffset` helper: ProseMirror's positions count *all* tokens including node boundaries, but our backend wants character-offset prefixes. The walk above approximates the same offsets `textBetween` produces. Good enough for the prefix/suffix extraction; 3.4 may revisit if token-accurate context windowing matters.

### Step 5: Web — ghost widget DOM

Create `apps/web/src/components/editor/plugins/autocomplete/ghost-widget.ts`:

```typescript
export function createGhostWidget(text: string): HTMLElement {
  const wrapper = document.createElement('span');
  wrapper.className = 'autocomplete-ghost-wrapper';
  wrapper.setAttribute('contenteditable', 'false');

  const ghost = document.createElement('span');
  ghost.className = 'autocomplete-ghost-text';
  ghost.textContent = text;

  const pill = document.createElement('span');
  pill.className = 'autocomplete-ai-pill';
  pill.textContent = 'AI';
  pill.setAttribute('aria-hidden', 'true');

  wrapper.appendChild(ghost);
  wrapper.appendChild(pill);
  return wrapper;
}
```

### Step 6: Web — completion client

Create `apps/web/src/components/editor/plugins/autocomplete/client.ts`:

```typescript
import { api } from '../../../../lib/api';

export interface CompletionContext {
  prefix: string;
  suffix: string;
  doc_id: string;
}

export async function fetchCompletion(ctx: CompletionContext, signal: AbortSignal): Promise<string> {
  const response = await api.complete(ctx, signal);
  return response.text;
}
```

### Step 7: Web — the ProseMirror plugin

Create `apps/web/src/components/editor/plugins/autocomplete/plugin.ts`:

```typescript
import { Plugin, PluginKey } from 'prosemirror-state';
import type { EditorState, Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { EditorView } from 'prosemirror-view';
import { shouldTrigger, extractContext } from './trigger';
import { createGhostWidget } from './ghost-widget';
import { fetchCompletion } from './client';

export interface AutocompletePluginOptions {
  docId: string;
  debounceMs: number;
  maxPrefixChars: number;
  maxSuffixChars: number;
}

interface PluginStateShape {
  suggestion: string | null;
  suggestionAtPos: number | null;
  decorations: DecorationSet;
}

export const autocompletePluginKey = new PluginKey<PluginStateShape>('boppl-autocomplete');

const META_KEY = 'boppl-autocomplete-set';

export function createAutocompletePlugin(opts: AutocompletePluginOptions): Plugin<PluginStateShape> {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let inflightController: AbortController | null = null;

  function clearInflight(): void {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (inflightController) { inflightController.abort(); inflightController = null; }
  }

  function scheduleRequest(view: EditorView): void {
    clearInflight();
    debounceTimer = setTimeout(() => {
      void runCompletion(view);
    }, opts.debounceMs);
  }

  async function runCompletion(view: EditorView): Promise<void> {
    debounceTimer = null;
    const state = view.state;
    const gate = shouldTrigger(state);
    if (!gate.ok) return;

    const { prefix, suffix } = extractContext(state, opts.maxPrefixChars, opts.maxSuffixChars);
    if (prefix.length === 0) return;

    const controller = new AbortController();
    inflightController = controller;
    const issuedAtPos = state.selection.from;

    try {
      const text = await fetchCompletion(
        { prefix, suffix, doc_id: opts.docId },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (!text) return;

      // Verify the cursor is still where we issued the request
      if (view.state.selection.from !== issuedAtPos) return;

      view.dispatch(
        view.state.tr.setMeta(META_KEY, {
          suggestion: text,
          suggestionAtPos: issuedAtPos,
        }),
      );
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      console.warn('[autocomplete] request failed', err);
    } finally {
      if (inflightController === controller) inflightController = null;
    }
  }

  function dismissSuggestion(view: EditorView): boolean {
    const current = autocompletePluginKey.getState(view.state);
    if (!current?.suggestion) return false;
    view.dispatch(view.state.tr.setMeta(META_KEY, { suggestion: null, suggestionAtPos: null }));
    return true;
  }

  function acceptSuggestion(view: EditorView): boolean {
    const current = autocompletePluginKey.getState(view.state);
    if (!current?.suggestion || current.suggestionAtPos == null) return false;
    const tr = view.state.tr;
    tr.insertText(current.suggestion, current.suggestionAtPos);
    tr.setMeta(META_KEY, { suggestion: null, suggestionAtPos: null });
    view.dispatch(tr);
    return true;
  }

  return new Plugin<PluginStateShape>({
    key: autocompletePluginKey,
    state: {
      init: () => ({ suggestion: null, suggestionAtPos: null, decorations: DecorationSet.empty }),
      apply(tr: Transaction, prev: PluginStateShape, _oldState, newState): PluginStateShape {
        const meta = tr.getMeta(META_KEY) as { suggestion: string | null; suggestionAtPos: number | null } | undefined;

        if (meta !== undefined) {
          if (meta.suggestion && meta.suggestionAtPos != null) {
            const widget = Decoration.widget(meta.suggestionAtPos, () => createGhostWidget(meta.suggestion!), {
              side: 1,
              key: 'boppl-autocomplete-ghost',
            });
            return {
              suggestion: meta.suggestion,
              suggestionAtPos: meta.suggestionAtPos,
              decorations: DecorationSet.create(newState.doc, [widget]),
            };
          }
          return { suggestion: null, suggestionAtPos: null, decorations: DecorationSet.empty };
        }

        // If the doc changed (typing happened), kill any existing suggestion
        if (tr.docChanged && prev.suggestion) {
          return { suggestion: null, suggestionAtPos: null, decorations: DecorationSet.empty };
        }

        // If the selection moved away from suggestionAtPos, dismiss
        if (prev.suggestion && prev.suggestionAtPos != null && newState.selection.from !== prev.suggestionAtPos) {
          return { suggestion: null, suggestionAtPos: null, decorations: DecorationSet.empty };
        }

        // Map decorations forward through the transaction
        return {
          ...prev,
          decorations: prev.decorations.map(tr.mapping, tr.doc),
        };
      },
    },
    props: {
      decorations(state) {
        return autocompletePluginKey.getState(state)?.decorations ?? DecorationSet.empty;
      },
      handleKeyDown(view, event) {
        const current = autocompletePluginKey.getState(view.state);
        if (event.key === 'Tab' && current?.suggestion) {
          event.preventDefault();
          acceptSuggestion(view);
          return true;
        }
        if (event.key === 'Escape' && current?.suggestion) {
          event.preventDefault();
          dismissSuggestion(view);
          return true;
        }
        return false;
      },
    },
    view(view) {
      // Run scheduler on every transaction. The actual debounce + abort logic
      // is inside scheduleRequest.
      return {
        update(updatedView, prevState) {
          const newState = updatedView.state;
          const docChanged = !newState.doc.eq(prevState.doc);
          const cursorMoved = newState.selection.from !== prevState.selection.from;

          if (docChanged) {
            // User typed — cancel any in-flight + schedule a new one if the trigger gates allow
            clearInflight();
            const gate = shouldTrigger(newState);
            if (gate.ok) scheduleRequest(updatedView);
          } else if (cursorMoved) {
            // Cursor moved without typing — cancel inflight, do not schedule
            clearInflight();
          }
        },
        destroy() {
          clearInflight();
        },
      };
    },
  });
}
```

### Step 8: Web — Editor wiring

Update `apps/web/src/components/editor/Editor.tsx` to register the plugin. Add inside the `useEffect` after `crepe.editor.use(collab)`:

```typescript
import { createAutocompletePlugin } from './plugins/autocomplete/plugin';
import { $prose } from '@milkdown/kit/utils';

// ... inside useEffect, after collab:
const autocompletePlugin = $prose(() =>
  createAutocompletePlugin({
    docId,
    debounceMs: 350,
    maxPrefixChars: 2000,
    maxSuffixChars: 500,
  }),
);
crepe.editor.use(autocompletePlugin);
```

The debounce / max-chars values are hard-coded for now. 3.4 will pull them from `import.meta.env.PUBLIC_AUTOCOMPLETE_*` for runtime tuning.

### Step 9: CSS

Append to `apps/web/src/components/editor/editor.css`:

```css
/* ============================ Autocomplete ============================ */

.autocomplete-ghost-wrapper {
  display: inline;
  pointer-events: none;
  user-select: none;
  position: relative;
}

.autocomplete-ghost-text {
  color: var(--editor-ghost-text);
  font-family: inherit;
  font-size: inherit;
  font-weight: inherit;
  line-height: inherit;
  white-space: pre-wrap;
}

.autocomplete-ai-pill {
  display: inline-block;
  margin-left: 4px;
  padding: 0 4px;
  font-size: 0.6875rem;          /* --text-xs */
  font-weight: 500;
  font-family: var(--font-sans);
  color: var(--text-tertiary);
  background: var(--surface-overlay);
  border: 1px solid var(--border-default);
  border-radius: 3px;
  vertical-align: 1px;
  opacity: 0;
  animation: autocomplete-pill-fade-in 200ms ease-out 200ms forwards;
}

@keyframes autocomplete-pill-fade-in {
  to { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .autocomplete-ai-pill {
    animation: none;
    opacity: 1;
  }
}
```

The pill's 200ms-delayed fade-in is intentional — it lets the ghost text appear first, then the pill follows. This prevents the pill from being a visual centerpiece during transient suggestions that the user immediately overrides.

### Step 10: Tests

The plugin runs in a real browser with a real ProseMirror view, which is hard to test without a JSDOM-ish environment. Two layers of testing:

**Unit-level (`trigger.test.ts`):** the `shouldTrigger` function is pure and easy to test with a constructed `EditorState`. Cover the gates explicitly.

**Manual smoke checklist:** the interaction model — debounce, abort, accept, dismiss, ghost-text rendering — is exercised through the browser. The verification checklist below lists the manual steps. Phase 4 may add Playwright tests; for 3.3 the manual smoke is the contract.

Create `apps/web/src/components/editor/plugins/autocomplete/trigger.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { Schema, type Node } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { shouldTrigger } from './trigger';

// Minimal schema for testing — paragraph + code_block + text
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    code_block: { group: 'block', content: 'text*', code: true, defining: true, toDOM: () => ['pre', ['code', 0]] },
    horizontal_rule: { group: 'block', atom: true, selectable: true, toDOM: () => ['hr'] },
    text: { group: 'inline' },
  },
});

function stateFromText(text: string, cursorOffset?: number): EditorState {
  const doc: Node = schema.node('doc', null, [
    schema.node('paragraph', null, text.length > 0 ? [schema.text(text)] : []),
  ]);
  const targetPos = cursorOffset !== undefined ? cursorOffset + 1 : doc.content.size; // +1 for the opening <p>
  return EditorState.create({ schema, doc, selection: { anchor: targetPos, head: targetPos } as any });
}

describe('shouldTrigger', () => {
  it('returns false on empty doc', () => {
    const s = stateFromText('');
    expect(shouldTrigger(s).ok).toBe(false);
  });

  it('returns true at end of a word at end of line', () => {
    const s = stateFromText('hello');
    expect(shouldTrigger(s).ok).toBe(true);
  });

  it('returns false in the middle of a word', () => {
    const s = stateFromText('hello', 3);   // cursor between "hel" and "lo"
    expect(shouldTrigger(s).ok).toBe(false);
  });

  it('returns false after punctuation', () => {
    const s = stateFromText('hello.');
    expect(shouldTrigger(s).ok).toBe(false);
  });

  it('returns true at end of word followed by space', () => {
    // Construct: "hello world" with cursor at offset 5 (right after "hello")
    const s = stateFromText('hello world', 5);
    expect(shouldTrigger(s).ok).toBe(true);
  });

  it('returns false inside a code block', () => {
    const doc = schema.node('doc', null, [
      schema.node('code_block', null, [schema.text('const x = 1')]),
    ]);
    const targetPos = doc.content.size;
    const s = EditorState.create({ schema, doc, selection: { anchor: targetPos, head: targetPos } as any });
    expect(shouldTrigger(s).ok).toBe(false);
  });
});
```

If your installed ProseMirror types reject the bare `{ anchor, head }` selection literal, use `TextSelection.create(doc, pos, pos)` instead. The cast above is the cleanest cross-version pattern; if it fails, switch to `TextSelection.create` and import from `prosemirror-state`.

Add to `apps/web/package.json` if not already present:

```json
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest"
},
"devDependencies": {
  "vitest": "^2.0.0"
}
```

### Step 11: CI workflow update

Add to `.github/workflows/test.yml`:

```yaml
- name: Autocomplete trigger
  run: pnpm --filter @boppl/web test src/components/editor/plugins/autocomplete/trigger.test.ts
```

---

## Verification checklist

```bash
# 1. All previous checks still green
pnpm typecheck
pnpm lint
pnpm test:round-trip                                                          # 83/83
pnpm --filter @boppl/api test                                                 # all api tests
pnpm --filter @boppl/api test src/tests/mcp-search-hybrid.test.ts             # 9/9

# 2. New autocomplete trigger tests
pnpm --filter @boppl/web test src/components/editor/plugins/autocomplete/trigger.test.ts   # 6/6
```

**Three processes start cleanly:**

```bash
pnpm dev
# Expected: api, collab, workers all up
```

**Backend stub works:**

```bash
JWT="<from-browser-cookie>"
curl -s -X POST -H "Cookie: boppl_jwt=$JWT" -H "Content-Type: application/json" \
  -d '{"prefix":"hello world","suffix":"","doc_id":"00000000-0000-0000-0000-000000000000"}' \
  http://localhost:8080/api/complete/_stub | jq
# Expected: { "text": " continuation" } after a ~300ms delay
```

(The doc_id can be a placeholder UUID — the stub doesn't enforce ownership for verification. 3.4 will tighten this.)

**Manual browser smoke (the real test):**

Sign into the editor. Open a doc. Then:

1. **Trigger appears.** Type `hello world`. After ~350ms of no typing, ghost text appears: ` continuation`, with a tiny "AI" pill 4px to its right.
2. **Tab accepts.** Press Tab. The ghost text becomes real text. The pill disappears. Cursor lands at the end of the inserted text.
3. **Esc dismisses.** Type more, wait for the next suggestion, press Esc. Ghost text disappears immediately. The AI pill disappears too.
4. **Typing aborts.** Type, wait ~100ms, then type more before the debounce fires. No suggestion ever appears for the in-between state. (Watch the network tab: you should see zero fetches during fast continuous typing.)
5. **Pause + type aborts.** Type "hello", wait for the ghost text to appear (~350ms), then type one more character. The ghost text disappears the moment you type. No torn / glitched rendering.
6. **Mid-word doesn't trigger.** Click in the middle of an existing word. Wait. Type one character. No suggestion fires (trigger gate rejects).
7. **End-of-punctuation doesn't trigger.** Type `hello.` Wait. No suggestion (trigger gate: cursor after non-word char).
8. **Code block doesn't trigger.** Insert a code block via the slash menu. Type Python code inside. No suggestions appear.
9. **Math block doesn't trigger.** Insert a display math block. Type LaTeX. No suggestions appear.
10. **Selection doesn't trigger.** Select some text. Wait. No suggestion appears.

**Performance sanity:**

11. **Fast typing has no jank.** Type a paragraph at full speed (~5 chars/sec). The editor should remain smooth. Watch the network tab — at most a few requests fire (one per pause), and most are aborted before completing.

**Style fidelity:**

12. **Ghost text matches surrounding font/size/line-height.** It should look like a continuation of your text, just dimmer. No font shift, no baseline drift.
13. **AI pill is unobtrusive.** Small, slightly elevated, doesn't disrupt the text flow.

If any check fails, do not declare this prompt complete.

---

## Do NOT do in this prompt

- Do **NOT** deploy anything.
- Do **NOT** call Gemini, OpenAI, Anthropic, or any real LLM. The stub backend is the contract for 3.3.
- Do **NOT** add SSE streaming. The stub returns a single JSON body. 3.4 swaps in streaming.
- Do **NOT** add rate limiting. 3.4 handles it.
- Do **NOT** add tool-audit-style writes for autocomplete. Autocomplete is per-keystroke; auditing every fire would explode the table.
- Do **NOT** weaken the trigger gating. Specifically: don't allow mid-word, don't allow inside-code-block, don't allow inside-math.
- Do **NOT** "improve" the AI pill into a chip showing model name or cost. Keep it minimal.
- Do **NOT** add a settings UI to toggle autocomplete on/off. Phase 4 polish.
- Do **NOT** persist the suggestion to the doc on idle. Suggestions are ephemeral until Tab.
- Do **NOT** allow Tab acceptance when there's no suggestion — let Tab fall through to its normal behavior (indent in lists, etc.).
- Do **NOT** modify the Yjs document on suggestion appearance or dismissal. Only Tab modifies. The whole UX is "you haven't committed to anything until you press Tab."
- Do **NOT** add a "regenerate suggestion" hotkey. Phase 4.
- Do **NOT** use `as any` to paper over ProseMirror type mismatches. The plugin signatures are stable; if something doesn't compile, the call shape is wrong.

---

## When you're done

Report back with:

1. All previous tests green plus 6 new trigger tests passing.
2. The stub backend curl result.
3. Manual smoke confirmation: each of the 13 numbered browser checks, ideally with a screenshot or two (especially: ghost text + AI pill rendered correctly, mid-word non-trigger, code-block non-trigger).
4. Network-tab observation: aborted requests visible during fast typing.
5. Confirmation that no cloud account was created, no deploy command was run, and no real LLM was called.
6. The exact reproduce: `docker compose up -d && pnpm dev`

Wait for the user to verify before proceeding to Prompt 3.4 (SSE streaming + Gemini Flash-Lite + per-tenant rate limits — swapping the stub for the production completion path).

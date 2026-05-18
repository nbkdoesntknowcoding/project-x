# Claude Code Prompt 3.4 — SSE Streaming + Gemini Flash-Lite + Rate Limits

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

You MUST in this prompt:
  • Run everything against localhost
  • Use the user's own Gemini API key from Google AI Studio
    (free tier is generous; no billing needed for typical dev usage)
  • Cap rate limits low for local-dev safety

Deployment is Phase D.
═══════════════════════════════════════════════════════════════════════
```

---

## Pre-flight — known state after 3.3

Phase 3.3 is verified:
- Autocomplete plugin in the editor with all the interaction contracts working: 350ms debounce, Tab/Esc, AbortController on every keystroke, trigger gating
- Stub backend at `POST /api/complete/_stub` returns `" continuation"` after 200-400ms
- Ghost text and AI pill render per design system
- 6/6 trigger tests passing
- The manual 13-step smoke passed in the browser

**Pre-flight requirement specific to 3.4:** the user has obtained a **Gemini API key** from Google AI Studio (`aistudio.google.com`). It's free, no credit card needed. They will paste it into `.env`. Claude Code does not create the Google account or fetch the key.

If `.env` does not contain a valid `GEMINI_API_KEY`, **stop and tell the user to add it**.

---

## What you are building in this prompt

The production autocomplete path. By the end:

1. A new endpoint `POST /api/complete` (note: the production path, not `/_stub`) streams tokens back via Server-Sent Events.
2. The endpoint calls Gemini 2.5 Flash-Lite through the **Vercel AI SDK 5** (`@ai-sdk/google` provider). Model: `gemini-2.5-flash-lite`. Max output tokens: 60. Stop sequences: double-newline (paragraph break) so completions don't run on past the current sentence.
3. The client-side plugin upgrades to consume SSE: it opens the stream, coalesces tokens via `requestAnimationFrame` at ~33ms intervals, updates the ghost text incrementally.
4. The `AbortController` flow now propagates end-to-end: client aborts → SSE connection closes → server's `req.signal` aborts → Gemini SDK's `streamText` call aborts → no further Google API tokens consumed.
5. **Per-user rate limit**: 60 requests/minute, 1000 requests/day. Implemented as a Redis sliding window. Exceeded → 429 response, the client treats this as "no suggestion right now" (no error toast, no UI noise).
6. **Per-tenant cost cap**: $5/day spending limit (configurable). Tracked in a Redis counter incremented by estimated cost per call. Exceeded → 429 + a warning log line.
7. The stub endpoint at `/api/complete/_stub` stays in the codebase (useful for E2E testing of just the plugin) but is no longer the default.
8. The system prompt to Gemini is short, cached on the model side via Gemini's context cache primitive when possible, and instructs the model to write in markdown matching the surrounding style.
9. Tool audit for autocomplete is **explicitly skipped** — per-keystroke audit would explode the table. We log aggregate stats per minute to stdout instead; Phase 4 may persist these to a dedicated `autocomplete_metrics` table.

What is **not** in this prompt:
- Per-user accept/reject telemetry (Phase 4)
- Context windowing using related docs via RAG (deferred; flat prefix/suffix is sufficient initially)
- Multi-model fallback (Phase 5 if Gemini ever has an outage)
- Locale / language detection (English-only)

After this prompt, **Phase 3 is complete**. The editor feels like Cursor for docs.

---

## Architecture

### Why Gemini Flash-Lite

The research locked this in. Three reasons it's right:

- **Latency floor is the constraint.** Autocomplete needs sub-600ms time-to-first-token (TTFT) or it feels laggy. Flash-Lite ships at ~200-400ms TTFT typical; Claude Haiku 4.5 is comparable; GPT-4o-mini is slightly slower; self-hosted small models add infra burden and have unpredictable cold starts.
- **Per-token cost is negligible.** Flash-Lite is one of the cheapest mainstream models. At ~60 output tokens × 30 requests per active doc-hour × 8 hours × 5 users, the math says under $1/day at production scale. Free tier even more so.
- **Quality is sufficient for short completions.** Autocomplete asks for 30-60 tokens that read well in context. Flash-Lite handles that ceiling fine. We're not asking for reasoning; we're asking for fluent continuation.

The model name to use: `gemini-2.5-flash-lite`. If a newer Flash-Lite variant has shipped by the time this prompt runs, **stay pinned** unless explicitly told otherwise. Model swaps mid-build introduce a variable we don't want during integration.

### Why Vercel AI SDK 5

Two pieces it gives us essentially free:
- A consistent `streamText({ model, prompt, abortSignal })` API across providers. Swap providers later by changing one import.
- First-class `AbortSignal` propagation. When we abort from Fastify, the SDK aborts the upstream provider call. This is the cost-protection mechanism.

The alternative is the raw `@google/generative-ai` SDK. It works, but its streaming API and abort semantics are clunkier. Vercel AI SDK wraps it with cleaner ergonomics. For 3.4 we use:
- `@ai-sdk/google` — the Google provider
- `ai` — the SDK proper (renamed package in v5)

### The streaming envelope

Server-Sent Events is the right transport. Three reasons:
- Native browser support via `EventSource`; no WebSocket overhead for a unidirectional stream
- One-way is exactly what we need — server sends tokens, client renders
- Cleanly composes with abort: closing the SSE connection on the client triggers the server's `req.signal`

The Fastify response shape:

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no

data: {"delta":"hel"}

data: {"delta":"lo "}

data: {"delta":"world"}

data: {"done":true}
```

Each `data:` line is a one-line JSON event. The client parses each delta and appends. On `done: true`, the stream closes cleanly. On errors, a `data: {"error": "..."}` event is sent before close.

We use plain `EventSource` won't work because we need to POST a body with the prefix/suffix. So the client opens a `fetch` with `Accept: text/event-stream` and reads `response.body` as a ReadableStream — same wire format, different client API. This is the standard pattern for SSE-with-POST.

### The system prompt

Short, focused, baked into the request:

```
You are an inline autocomplete assistant for a Notion-style markdown editor.
Given the prefix (text before the cursor) and suffix (text after the cursor),
predict the most likely continuation at the cursor position.

Rules:
- Output ONLY the continuation text, no explanations.
- Match the surrounding style: same tense, same person, same level of formality.
- Continue the current sentence or list item; do not start a new section.
- Generate 5-30 words. Stop at a sentence boundary or natural pause.
- If the prefix ends mid-word, complete the word first.
- If you don't have enough context to predict, output an empty string.
```

We include the system prompt in every request. Gemini's context-cache feature can deduplicate it server-side if used heavily, but we don't manually invoke caching — Gemini infers cacheability from the prefix bytes.

The user prompt is structured as:

```
<prefix>
{prefix}
</prefix>
<suffix>
{suffix}
</suffix>
Continuation:
```

This is the canonical FIM (Fill-In-the-Middle) prompt shape. Flash-Lite handles it well.

### Rate limiting shape

Two layers, both Redis sliding-window:

**Per-user limit**: 60 requests in 60 seconds, 1000 requests in 24 hours. Implemented with two Redis sorted sets per user (`ratelimit:user:{user_id}:minute` and `ratelimit:user:{user_id}:day`). On each request, prune entries older than the window, count remaining, accept or reject. The day window's 1000-cap matters for cost protection more than the minute's 60-cap; burst spikes are usually fine but sustained-over-the-day overuse is the actual risk.

**Per-tenant cost cap**: estimate ~$0.0001 per request (Flash-Lite at 700 input tokens × $0.10/MTok = $0.00007, plus output). Maintain a single Redis counter per tenant per UTC day. On each request, increment by 1 (one unit ≈ $0.0001), check against a configured ceiling (default 50,000 units = $5.00). Exceeded → 429.

Both layers reject independently. The 429 response includes a `Retry-After` header indicating seconds until the most-restrictive window has space.

### Why we don't audit per-keystroke

The `tool_audit` table is partitioned by month and sized for MCP tool calls — call volumes in the hundreds-per-tenant-per-day range. Autocomplete fires at debounce-bound rates: a typing session could produce thousands per hour. Auditing each one would explode the table.

For 3.4 we log aggregate stats every minute to stdout: requests issued, tokens consumed (estimated), aborts, cache hits, rate-limit rejections. Phase 4 may add a dedicated table (`autocomplete_metrics`) that aggregates per-tenant per-day. For now, stdout is enough — production logging will capture it via Axiom.

---

## Tech stack additions

| Package | Version | Workspace | Purpose |
|---|---|---|---|
| `ai` | ^5.x | `apps/api` | Vercel AI SDK |
| `@ai-sdk/google` | ^1.x | `apps/api` | Google Gemini provider for the SDK |

Install:
```bash
pnpm --filter @boppl/api add ai @ai-sdk/google
```

If the SDK versions resolve differently than expected, **stay on the v5 line of `ai`** — v5 is the current stable, and the streaming/abort APIs we rely on landed there. Pre-v5 APIs are different enough that the code below won't work.

---

## File structure — additions

```
apps/api/src/
├── routes/
│   ├── complete.ts                  [UPDATED — add production /api/complete endpoint]
│   └── complete/                    [NEW directory]
│       ├── handler.ts               [NEW — the SSE handler]
│       ├── prompt.ts                [NEW — system + user prompt builders]
│       ├── rate-limit.ts            [NEW — Redis sliding-window limits]
│       └── metrics.ts               [NEW — stdout aggregate logger]
└── config/
    └── env.ts                       [UPDATED — Gemini key, rate-limit knobs]

apps/web/src/components/editor/plugins/autocomplete/
└── client.ts                        [UPDATED — SSE parsing + incremental rendering]

apps/api/src/tests/
└── complete-rate-limit.test.ts      [NEW — sliding-window correctness]
```

---

## Implementation steps in order

### Step 1: Env additions

Append to `.env.example`:

```bash
# Gemini (user obtains from aistudio.google.com)
GEMINI_API_KEY=
AUTOCOMPLETE_MODEL=gemini-2.5-flash-lite
AUTOCOMPLETE_MAX_OUTPUT_TOKENS=60
AUTOCOMPLETE_STOP_SEQUENCES=\n\n,\n#

# Rate limits
RATE_LIMIT_USER_PER_MIN=60
RATE_LIMIT_USER_PER_DAY=1000
RATE_LIMIT_TENANT_DAILY_UNITS=50000
```

Update `apps/api/src/config/env.ts`:

```typescript
GEMINI_API_KEY: z.string().min(1),
AUTOCOMPLETE_MODEL: z.string().default('gemini-2.5-flash-lite'),
AUTOCOMPLETE_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(60),
AUTOCOMPLETE_STOP_SEQUENCES: z.string().default('\n\n').transform((s) => s.split(',').map((x) => x.replace(/\\n/g, '\n'))),
RATE_LIMIT_USER_PER_MIN: z.coerce.number().int().positive().default(60),
RATE_LIMIT_USER_PER_DAY: z.coerce.number().int().positive().default(1000),
RATE_LIMIT_TENANT_DAILY_UNITS: z.coerce.number().int().positive().default(50000),
```

### Step 2: Rate-limit helpers

Create `apps/api/src/routes/complete/rate-limit.ts`:

```typescript
import IORedis from 'ioredis';
import { config } from '../../config/env.js';

const redis = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec: number | null;
  reason?: 'user_per_min' | 'user_per_day' | 'tenant_daily_budget';
}

/**
 * Sliding-window check using Redis sorted sets. We zremrangebyscore + zcard,
 * which is O(log N) per call. Each "request" is recorded by zadd with the
 * timestamp as both score and member.
 */
async function checkSlidingWindow(key: string, windowSec: number, limit: number): Promise<boolean> {
  const now = Date.now();
  const cutoff = now - windowSec * 1000;
  const pipeline = redis.pipeline();
  pipeline.zremrangebyscore(key, 0, cutoff);
  pipeline.zcard(key);
  const results = await pipeline.exec();
  if (!results) return true; // Redis hiccup — fail open for now
  const count = (results[1]?.[1] as number) ?? 0;
  return count < limit;
}

async function recordHit(key: string, windowSec: number): Promise<void> {
  const now = Date.now();
  const pipeline = redis.pipeline();
  pipeline.zadd(key, now, `${now}:${Math.random().toString(36).slice(2, 8)}`);
  pipeline.expire(key, windowSec + 60); // generous TTL so the key gets GC'd
  await pipeline.exec();
}

export async function checkRateLimits(opts: {
  userId: string;
  tenantId: string;
}): Promise<RateLimitResult> {
  const userMinKey = `ratelimit:user:${opts.userId}:min`;
  const userDayKey = `ratelimit:user:${opts.userId}:day`;
  const tenantBudgetKey = `ratelimit:tenant:${opts.tenantId}:budget:${utcDateString()}`;

  // Check all three in parallel
  const [minOk, dayOk, budgetUnits] = await Promise.all([
    checkSlidingWindow(userMinKey, 60, config.RATE_LIMIT_USER_PER_MIN),
    checkSlidingWindow(userDayKey, 86400, config.RATE_LIMIT_USER_PER_DAY),
    redis.get(tenantBudgetKey).then((v) => Number(v ?? '0')),
  ]);

  if (!minOk) {
    return { allowed: false, retryAfterSec: 60, reason: 'user_per_min' };
  }
  if (!dayOk) {
    return { allowed: false, retryAfterSec: secondsUntilUtcMidnight(), reason: 'user_per_day' };
  }
  if (budgetUnits >= config.RATE_LIMIT_TENANT_DAILY_UNITS) {
    return { allowed: false, retryAfterSec: secondsUntilUtcMidnight(), reason: 'tenant_daily_budget' };
  }

  return { allowed: true, retryAfterSec: null };
}

export async function recordRequest(opts: { userId: string; tenantId: string }): Promise<void> {
  const userMinKey = `ratelimit:user:${opts.userId}:min`;
  const userDayKey = `ratelimit:user:${opts.userId}:day`;
  const tenantBudgetKey = `ratelimit:tenant:${opts.tenantId}:budget:${utcDateString()}`;

  await Promise.all([
    recordHit(userMinKey, 60),
    recordHit(userDayKey, 86400),
    redis.incr(tenantBudgetKey).then(() => redis.expire(tenantBudgetKey, 86400 + 3600)),
  ]);
}

function utcDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function secondsUntilUtcMidnight(): number {
  const now = new Date();
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return Math.max(1, Math.floor((midnight.getTime() - now.getTime()) / 1000));
}
```

The `recordRequest` increments the budget by 1 unit per request — this is a coarse approximation. Phase 5 may refine to actual-cost-tracking by reading token counts from the SDK response, but for 3.4 the simple counter is enough for catching runaway scenarios.

### Step 3: Prompt builders

Create `apps/api/src/routes/complete/prompt.ts`:

```typescript
export const SYSTEM_PROMPT = `You are an inline autocomplete assistant for a Notion-style markdown editor.
Given the prefix (text before the cursor) and suffix (text after the cursor), predict the most likely continuation at the cursor position.

Rules:
- Output ONLY the continuation text, no explanations.
- Match the surrounding style: same tense, same person, same level of formality.
- Continue the current sentence or list item; do not start a new section.
- Generate 5-30 words. Stop at a sentence boundary or natural pause.
- If the prefix ends mid-word, complete the word first.
- If you don't have enough context to predict, output an empty string.`;

export function buildUserPrompt(prefix: string, suffix: string): string {
  return `<prefix>\n${prefix}\n</prefix>\n<suffix>\n${suffix}\n</suffix>\nContinuation:`;
}
```

### Step 4: Metrics

Create `apps/api/src/routes/complete/metrics.ts`:

```typescript
interface MetricsBucket {
  requests: number;
  aborts: number;
  rateLimited: number;
  tokensOut: number;
  errors: number;
}

const buckets = new Map<string, MetricsBucket>(); // key: tenant_id

function bucketFor(tenantId: string): MetricsBucket {
  let b = buckets.get(tenantId);
  if (!b) {
    b = { requests: 0, aborts: 0, rateLimited: 0, tokensOut: 0, errors: 0 };
    buckets.set(tenantId, b);
  }
  return b;
}

export function recordRequestStarted(tenantId: string): void {
  bucketFor(tenantId).requests += 1;
}
export function recordAbort(tenantId: string): void {
  bucketFor(tenantId).aborts += 1;
}
export function recordRateLimited(tenantId: string): void {
  bucketFor(tenantId).rateLimited += 1;
}
export function recordTokens(tenantId: string, n: number): void {
  bucketFor(tenantId).tokensOut += n;
}
export function recordError(tenantId: string): void {
  bucketFor(tenantId).errors += 1;
}

// Flush every minute to stdout
setInterval(() => {
  if (buckets.size === 0) return;
  for (const [tenantId, b] of buckets) {
    if (b.requests === 0 && b.rateLimited === 0) continue;
    console.log(
      `[autocomplete-metrics] tenant=${tenantId} ` +
        `req=${b.requests} abort=${b.aborts} rl=${b.rateLimited} tok=${b.tokensOut} err=${b.errors}`,
    );
  }
  buckets.clear();
}, 60_000).unref();
```

The `unref()` ensures this interval doesn't keep the process alive during shutdown.

### Step 5: The SSE handler

Create `apps/api/src/routes/complete/handler.ts`:

```typescript
import type { FastifyRequest, FastifyReply } from 'fastify';
import { streamText } from 'ai';
import { google } from '@ai-sdk/google';
import { z } from 'zod';
import { config } from '../../config/env.js';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';
import { checkRateLimits, recordRequest } from './rate-limit.js';
import {
  recordAbort, recordError, recordRateLimited, recordRequestStarted, recordTokens,
} from './metrics.js';

const bodySchema = z.object({
  prefix: z.string().max(10000),
  suffix: z.string().max(2000),
  doc_id: z.string().uuid(),
});

export async function handleComplete(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.auth) {
    reply.code(401).send({ error: 'unauthorized' });
    return;
  }
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    return;
  }

  const userId = req.auth.sub;
  const tenantId = req.auth.tenant_id;

  const limit = await checkRateLimits({ userId, tenantId });
  if (!limit.allowed) {
    recordRateLimited(tenantId);
    reply
      .code(429)
      .header('Retry-After', String(limit.retryAfterSec ?? 60))
      .header('X-RateLimit-Reason', limit.reason ?? 'unknown')
      .send({ error: 'rate_limited', reason: limit.reason, retry_after: limit.retryAfterSec });
    return;
  }

  await recordRequest({ userId, tenantId });
  recordRequestStarted(tenantId);

  // Set up SSE response. We hijack the reply so Fastify doesn't double-write.
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  reply.hijack();

  const controller = new AbortController();

  // Propagate client disconnect → abort the SDK call
  req.raw.on('close', () => {
    if (!controller.signal.aborted) {
      controller.abort();
      recordAbort(tenantId);
    }
  });

  try {
    const result = streamText({
      model: google(config.AUTOCOMPLETE_MODEL),
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(parsed.data.prefix, parsed.data.suffix),
      maxOutputTokens: config.AUTOCOMPLETE_MAX_OUTPUT_TOKENS,
      stopSequences: config.AUTOCOMPLETE_STOP_SEQUENCES,
      abortSignal: controller.signal,
      temperature: 0.2,
    });

    let tokenCount = 0;
    for await (const delta of result.textStream) {
      if (controller.signal.aborted) break;
      tokenCount += estimateTokens(delta);
      reply.raw.write(`data: ${JSON.stringify({ delta })}\n\n`);
    }
    recordTokens(tenantId, tokenCount);

    if (!controller.signal.aborted) {
      reply.raw.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      // Normal client disconnect during streaming
    } else {
      recordError(tenantId);
      console.error('[complete] stream error', err);
      try {
        reply.raw.write(`data: ${JSON.stringify({ error: 'stream_failed' })}\n\n`);
      } catch {
        // Connection may already be closed; swallow
      }
    }
  } finally {
    try {
      reply.raw.end();
    } catch {
      // Already ended
    }
  }
}

function estimateTokens(text: string): number {
  // ~4 chars per token approximation; refined accuracy doesn't matter here
  return Math.ceil(text.length / 4);
}
```

### Step 6: Register the route

Replace the contents of `apps/api/src/routes/complete.ts`:

```typescript
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { handleComplete } from './complete/handler.js';

const stubBodySchema = z.object({
  prefix: z.string().max(10000),
  suffix: z.string().max(2000),
  doc_id: z.string().uuid(),
});

export const completeRoutes: FastifyPluginAsync = async (app) => {
  // The production SSE endpoint
  app.post('/api/complete', handleComplete);

  // The 3.3 stub — kept around for plugin-only testing
  app.post('/api/complete/_stub', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = stubBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });

    await new Promise((r) => setTimeout(r, 200 + Math.floor(Math.random() * 200)));

    const trimmed = parsed.data.prefix.trimEnd();
    const lastChar = trimmed.length > 0 ? trimmed[trimmed.length - 1]! : '';
    const isWordChar = /[A-Za-z0-9]/.test(lastChar);
    return { text: isWordChar ? ' continuation' : '' };
  });
};
```

### Step 7: Update the web client to consume SSE

Rewrite `apps/web/src/components/editor/plugins/autocomplete/client.ts`:

```typescript
const API_URL = import.meta.env.PUBLIC_API_URL ?? 'http://localhost:8080';

export interface CompletionContext {
  prefix: string;
  suffix: string;
  doc_id: string;
}

export type CompletionStreamCallback = (cumulativeText: string) => void;

/**
 * Opens an SSE stream for an inline completion. Calls `onUpdate` with the
 * accumulated text on each token. Resolves with the final text when the
 * stream completes. Rejects on error or abort.
 */
export async function streamCompletion(
  ctx: CompletionContext,
  signal: AbortSignal,
  onUpdate: CompletionStreamCallback,
): Promise<string> {
  const response = await fetch(`${API_URL}/api/complete`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify(ctx),
    signal,
  });

  if (response.status === 429) {
    // Soft no — caller should treat this as "no suggestion this time"
    return '';
  }
  if (!response.ok) {
    throw new Error(`completion failed: ${response.status}`);
  }
  if (!response.body) {
    throw new Error('no response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';

  while (true) {
    if (signal.aborted) {
      void reader.cancel().catch(() => undefined);
      throw new DOMException('aborted', 'AbortError');
    }

    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by double-newlines
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';

    for (const evt of events) {
      const line = evt.trim();
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6);
      let parsed: { delta?: string; done?: boolean; error?: string };
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      if (parsed.error) throw new Error(parsed.error);
      if (parsed.done) return accumulated;
      if (parsed.delta) {
        accumulated += parsed.delta;
        onUpdate(accumulated);
      }
    }
  }

  return accumulated;
}
```

### Step 8: Update the plugin to render incrementally

Update `apps/web/src/components/editor/plugins/autocomplete/plugin.ts`'s `runCompletion`:

```typescript
import { streamCompletion } from './client';

// ... inside the plugin closure:
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

  // RAF-coalesced update: we accumulate text in this closure, and at most
  // once per frame we dispatch a meta to update the suggestion. This keeps
  // ProseMirror's transaction count manageable during a burst of tokens.
  let pendingText: string | null = null;
  let rafScheduled = false;

  function commitPending(): void {
    rafScheduled = false;
    if (pendingText == null) return;
    if (controller.signal.aborted) return;
    if (view.state.selection.from !== issuedAtPos) {
      controller.abort();
      return;
    }
    view.dispatch(
      view.state.tr.setMeta(META_KEY, {
        suggestion: pendingText,
        suggestionAtPos: issuedAtPos,
      }),
    );
    pendingText = null;
  }

  try {
    const finalText = await streamCompletion(
      { prefix, suffix, doc_id: opts.docId },
      controller.signal,
      (cumulativeText) => {
        pendingText = cumulativeText;
        if (!rafScheduled) {
          rafScheduled = true;
          requestAnimationFrame(commitPending);
        }
      },
    );

    if (controller.signal.aborted) return;

    // Final commit, in case the last delta hasn't been flushed by RAF yet
    if (finalText && view.state.selection.from === issuedAtPos) {
      view.dispatch(
        view.state.tr.setMeta(META_KEY, {
          suggestion: finalText,
          suggestionAtPos: issuedAtPos,
        }),
      );
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    if ((err as Error).message?.includes('429')) return; // soft no
    console.warn('[autocomplete] stream failed', err);
  } finally {
    if (inflightController === controller) inflightController = null;
  }
}
```

The RAF coalescing matters: Gemini Flash-Lite streams tokens at ~50/sec, which would mean 50 ProseMirror transactions per second if we updated naively. RAF caps us at ~60 frames/sec and gives the browser room to render between updates. Smooth ghost-text typing animation falls out of this design for free.

### Step 9: Tests

Create `apps/api/src/tests/complete-rate-limit.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import IORedis from 'ioredis';
import { config } from '../config/env.js';
import { checkRateLimits, recordRequest } from '../routes/complete/rate-limit.js';

const redis = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });

beforeEach(async () => {
  // Clear any rate-limit keys for our test IDs
  const keys = await redis.keys('ratelimit:user:rate-test-*');
  if (keys.length > 0) await redis.del(keys);
  const dayKeys = await redis.keys('ratelimit:tenant:rate-test-*');
  if (dayKeys.length > 0) await redis.del(dayKeys);
});

afterAll(async () => {
  await redis.quit();
});

describe('rate limit', () => {
  it('allows requests under the minute window', async () => {
    const userId = `rate-test-user-min-${Date.now()}`;
    const tenantId = `rate-test-tenant-min-${Date.now()}`;
    for (let i = 0; i < 5; i++) {
      const r = await checkRateLimits({ userId, tenantId });
      expect(r.allowed).toBe(true);
      await recordRequest({ userId, tenantId });
    }
  });

  it('rejects after the minute window is full', async () => {
    const userId = `rate-test-user-burst-${Date.now()}`;
    const tenantId = `rate-test-tenant-burst-${Date.now()}`;
    for (let i = 0; i < config.RATE_LIMIT_USER_PER_MIN; i++) {
      const r = await checkRateLimits({ userId, tenantId });
      expect(r.allowed).toBe(true);
      await recordRequest({ userId, tenantId });
    }
    const overLimit = await checkRateLimits({ userId, tenantId });
    expect(overLimit.allowed).toBe(false);
    expect(overLimit.reason).toBe('user_per_min');
    expect(overLimit.retryAfterSec).toBeGreaterThan(0);
  });

  it('rejects when tenant daily budget exceeded', async () => {
    const userId = `rate-test-budget-user-${Date.now()}`;
    const tenantId = `rate-test-budget-tenant-${Date.now()}`;
    const today = new Date().toISOString().slice(0, 10);
    await redis.set(`ratelimit:tenant:${tenantId}:budget:${today}`, String(config.RATE_LIMIT_TENANT_DAILY_UNITS));
    const r = await checkRateLimits({ userId, tenantId });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('tenant_daily_budget');
  });
});
```

### Step 10: Update CI

Add to `.github/workflows/test.yml`:

```yaml
- name: Rate limit
  run: pnpm --filter @boppl/api test src/tests/complete-rate-limit.test.ts
  env:
    NODE_ENV: test
    GEMINI_API_KEY: ci_dummy_key_not_used
```

The Gemini key in CI is a placeholder — the rate-limit test doesn't call Gemini. It exercises only the Redis sliding-window logic.

---

## Verification checklist

```bash
# 1. All previous tests still green
pnpm typecheck
pnpm lint
pnpm test:round-trip                                                          # 83/83
pnpm --filter @boppl/api test                                                 # all api tests
pnpm --filter @boppl/web test                                                 # 6/6 trigger tests

# 2. New rate-limit tests
pnpm --filter @boppl/api test src/tests/complete-rate-limit.test.ts          # 3/3
```

**Both processes start:**

```bash
pnpm dev
# All three: api, collab, workers
```

**Backend endpoint responds (uses real Gemini):**

```bash
JWT="<from-browser-cookie>"
curl -sN -X POST -H "Cookie: boppl_jwt=$JWT" -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"prefix":"The quick brown fox jumps over the lazy","suffix":"","doc_id":"00000000-0000-0000-0000-000000000000"}' \
  http://localhost:8080/api/complete
```

Expected output: a stream of `data: {"delta":"..."}` lines, ending with `data: {"done":true}`. The combined deltas should look like a sensible continuation (likely something like " dog. The fox was quick because..."). The whole stream completes in well under 2 seconds.

**Manual browser smoke (the real test):**

1. **Real ghost text from Gemini.** Type a sentence in the editor. Pause. Ghost text appears that's a coherent continuation — not the stub's " continuation" anymore. Streaming is visible: the ghost text *types itself in* over ~200-500ms.

2. **Tab accepts.** Press Tab. The full streamed text becomes real text in the doc.

3. **Mid-stream abort.** Type, wait for streaming to start (you'll see the ghost text growing). Type another character mid-stream. Ghost text disappears, no further deltas land. Watch the network tab — the SSE connection closes mid-response.

4. **Rate limit observable.** Set `RATE_LIMIT_USER_PER_MIN=5` in `.env`, restart `pnpm dev`. Fire 6+ requests quickly (or use the curl above repeatedly). Observe the 6th returns 429 with `Retry-After`. The browser plugin silently doesn't show a suggestion (no error toast). Revert the env var.

5. **Trigger gates still hold.** Inside a code block: no ghost text. Mid-word: no ghost text. After punctuation: no ghost text.

6. **Streaming under fast typing.** Type a paragraph at full speed. Watch the network tab — most requests get aborted, only the post-pause ones complete. No torn rendering or stuck ghost text.

7. **Aggregate metrics in stdout.** After a couple of minutes of editing, the `[autocomplete-metrics]` log line appears in the api stdout with non-zero counts. Confirm the counts are reasonable.

**Cost confirmation:**

Visit `aistudio.google.com/usage` after running real completions. Token consumption should appear within a few minutes. Should be in the low hundreds of tokens per minute of light editing — comfortably under any free-tier ceiling.

**Stub backend still works (regression):**

```bash
curl -s -X POST -H "Cookie: boppl_jwt=$JWT" -H "Content-Type: application/json" \
  -d '{"prefix":"hello world","suffix":"","doc_id":"00000000-0000-0000-0000-000000000000"}' \
  http://localhost:8080/api/complete/_stub | jq
# Expected: still returns { "text": " continuation" }
```

If any check fails, do not declare this prompt complete.

---

## Do NOT do in this prompt

- Do **NOT** deploy anything.
- Do **NOT** call Anthropic, OpenAI, or any provider other than Google. Single-provider is the contract for 3.4.
- Do **NOT** swap `gemini-2.5-flash-lite` for a different model in this prompt. Model swap is a tuning decision, not a build decision.
- Do **NOT** raise `MAX_OUTPUT_TOKENS` above 60. Longer outputs feel laggy and rarely improve quality for autocomplete.
- Do **NOT** add a fallback to OpenAI / Anthropic when Gemini fails. Phase 5 might. For 3.4, errors surface as silent dismissal.
- Do **NOT** persist autocomplete metrics to the database. Stdout is the contract.
- Do **NOT** write to `tool_audit` for autocomplete events. Volumes are too high.
- Do **NOT** add user-facing rate-limit error UI. The plugin should silently treat 429 as "no suggestion right now."
- Do **NOT** widen the system prompt. The current 6 rules cover the cases; longer prompts add tokens and dilute the signal.
- Do **NOT** add temperature controls in the UI. 0.2 is fine; higher would feel chaotic in an autocomplete surface.
- Do **NOT** add a "retry suggestion" hotkey. The next debounce cycle handles regeneration.
- Do **NOT** integrate related-docs context via RAG in this prompt. Flat prefix/suffix is sufficient at our scale; RAG is Phase 5 if data warrants.
- Do **NOT** use `as any` to paper over SDK type mismatches. The `ai` v5 types are accurate; if `streamText` doesn't accept your config, the config is wrong.
- Do **NOT** remove or repurpose the `/api/complete/_stub` endpoint. It stays as a development tool.

---

## When you're done

Report back with:

1. All previous tests green plus 3 new rate-limit tests passing.
2. The curl result showing a real SSE stream from `/api/complete`.
3. Manual smoke confirmation: each of the 7 numbered browser checks.
4. A screenshot or paste of an `[autocomplete-metrics]` log line.
5. The Google AI Studio usage panel showing token consumption matching your test usage.
6. Confirmation that no cloud account was created (beyond the user's already-existing Google AI Studio account), no deploy command was run, and the MCP server is still unregistered with claude.ai.
7. The exact reproduce: `docker compose up -d && pnpm dev`

**This completes Phase 3.**

Combined Phase 3 deliverable: heading-aware embedding pipeline writing to pgvector, hybrid search (keyword + semantic via RRF), and a production autocomplete path (ghost text + Gemini Flash-Lite + SSE + per-tenant rate limits). The editor now feels like Cursor for docs. The MCP server is search-quality production. The system is ready for closed beta.

After verification, the next major piece is **Phase 4 — productization**: public signup, workspace invitations, comments + doc versions UI, marketing pages, light mode, Stripe scaffolding. That's where this moves from "internal tool that's nearly done" to "product BOPPL ships."

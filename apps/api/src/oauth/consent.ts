/**
 * OAuth consent screen HTML.
 *
 * Rendered server-side as a raw HTML string from the authorize route
 * when the user needs to grant or review access. Styled to match the
 * Mnema design system (dark surface, Geist Sans).
 */
import type { FastifyReply } from 'fastify';
import { scopeLabel, parseScopes } from './scopes.js';

interface ConsentParams {
  requestId: string;
  clientName: string;
  userEmail: string;
  scope: string;
  resource: string | null | undefined;
  workspaces: Array<{ id: string; name: string; slug: string }>;
}

export function renderConsentScreen(reply: FastifyReply, params: ConsentParams): void {
  const { requestId, clientName, userEmail, scope, workspaces } = params;
  const scopes = parseScopes(scope).filter((s) => s !== 'offline_access');

  const workspaceOptions = workspaces
    .map(
      (ws, i) =>
        `<label class="ws-option">
          <input type="radio" name="workspace_id" value="${esc(ws.id)}" ${i === 0 ? 'checked' : ''} required>
          <span class="ws-name">${esc(ws.name)}</span>
          <span class="ws-slug">@${esc(ws.slug)}</span>
        </label>`,
    )
    .join('');

  const scopeItems = scopes
    .map((s) => `<li class="scope-item"><span class="scope-dot">●</span>${esc(scopeLabel(s))}</li>`)
    .join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize — Mnema</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --surface: #0f0f0f;
      --surface-2: #1a1a1a;
      --border: #2a2a2a;
      --ink: #f0f0f0;
      --ink-muted: #888;
      --accent: #6366f1;
      --accent-hover: #818cf8;
      --danger: #ef4444;
    }
    body {
      background: var(--surface);
      color: var(--ink);
      font-family: 'Geist', system-ui, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }
    .card {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 2rem;
      width: 100%;
      max-width: 420px;
    }
    .logo { font-size: 1.1rem; font-weight: 600; margin-bottom: 1.5rem; color: var(--ink); letter-spacing: -0.02em; }
    .logo span { color: var(--ink-muted); font-weight: 400; }
    h1 { font-size: 1.1rem; font-weight: 600; margin-bottom: 0.3rem; }
    .client-name { font-family: 'Geist Mono', monospace; font-size: 0.85rem; color: var(--accent); }
    .user-tag { font-size: 0.8rem; color: var(--ink-muted); margin-bottom: 1.5rem; margin-top: 0.4rem; }
    .section-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-muted); margin-bottom: 0.5rem; }
    .scope-list { list-style: none; margin-bottom: 1.5rem; }
    .scope-item { font-size: 0.875rem; padding: 0.35rem 0; display: flex; gap: 0.5rem; align-items: baseline; }
    .scope-dot { color: var(--accent); font-size: 0.5rem; flex-shrink: 0; }
    .ws-options { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1.5rem; }
    .ws-option { display: flex; align-items: center; gap: 0.75rem; padding: 0.6rem 0.75rem; border: 1px solid var(--border); border-radius: 8px; cursor: pointer; font-size: 0.875rem; transition: border-color 0.15s; }
    .ws-option:has(input:checked) { border-color: var(--accent); }
    .ws-option input { accent-color: var(--accent); }
    .ws-name { font-weight: 500; }
    .ws-slug { color: var(--ink-muted); font-size: 0.8rem; margin-left: auto; }
    .actions { display: flex; gap: 0.75rem; }
    .btn-approve { flex: 1; background: var(--accent); color: #fff; border: none; border-radius: 8px; padding: 0.65rem 1rem; font-size: 0.875rem; font-weight: 500; cursor: pointer; transition: background 0.15s; }
    .btn-approve:hover { background: var(--accent-hover); }
    .btn-deny { flex: 0 0 auto; background: transparent; color: var(--ink-muted); border: 1px solid var(--border); border-radius: 8px; padding: 0.65rem 1rem; font-size: 0.875rem; cursor: pointer; transition: border-color 0.15s; }
    .btn-deny:hover { border-color: var(--danger); color: var(--danger); }
    .divider { border: none; border-top: 1px solid var(--border); margin: 1.25rem 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">mnema <span>/ authorize</span></div>
    <h1><span class="client-name">${esc(clientName)}</span> wants access</h1>
    <p class="user-tag">Signed in as ${esc(userEmail)}</p>

    <form method="POST" action="/oauth/authorize/approve">
      <input type="hidden" name="request_id" value="${esc(requestId)}">
      <input type="hidden" name="scope" value="${esc(scope)}">

      <div class="section-label">Permissions</div>
      <ul class="scope-list">${scopeItems}</ul>

      <hr class="divider">

      <div class="section-label">Choose workspace</div>
      <div class="ws-options">${workspaceOptions}</div>

      <div class="actions">
        <button type="submit" class="btn-approve">Approve</button>
        <button type="button" class="btn-deny" onclick="deny()">Deny</button>
      </div>
    </form>
  </div>
  <script>
    function deny() {
      const f = document.createElement('form');
      f.method = 'POST';
      f.action = '/oauth/authorize/deny';
      const inp = document.createElement('input');
      inp.type = 'hidden'; inp.name = 'request_id'; inp.value = '${esc(requestId)}';
      f.appendChild(inp);
      document.body.appendChild(f);
      f.submit();
    }
  </script>
</body>
</html>`;

  reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
}

export function renderErrorPage(reply: FastifyReply, opts: { error: string; description?: string }): void {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Error — Mnema OAuth</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f0f0f; color: #f0f0f0; display:flex; align-items:center; justify-content:center; min-height:100vh; }
    .card { background: #1a1a1a; border:1px solid #2a2a2a; border-radius:12px; padding:2rem; max-width:380px; text-align:center; }
    h1 { font-size:1rem; margin-bottom:.5rem; color:#ef4444; }
    p { color:#888; font-size:.875rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorization error</h1>
    <p><strong>${esc(opts.error)}</strong>${opts.description ? ': ' + esc(opts.description) : ''}</p>
  </div>
</body>
</html>`;
  reply.header('Content-Type', 'text/html; charset=utf-8').status(400).send(html);
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

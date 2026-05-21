/**
 * Write-preview MCP App HTML bundle — Phase 10, Step 1.4.
 *
 * Rendered in a sandboxed iframe when propose_doc_write returns.
 * Shows the proposed content, doc title, operation, and Approve/Reject buttons.
 *
 * On Approve: calls commit_proposed_write tool via app.callServerTool().
 * On Reject: dismisses silently (no server call).
 *
 * Design: pure-black Mnema theme, design tokens inlined (no external fetch).
 * CSP: no external origins.
 */

import { readFileSync } from 'fs';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);

function loadAppWithDeps(): string {
  try {
    const pkgPath = _require.resolve('@modelcontextprotocol/ext-apps/app-with-deps');
    return readFileSync(pkgPath, 'utf8');
  } catch (e) {
    return `console.error('ext-apps load failed: ${String(e)}');`;
  }
}

const APP_WITH_DEPS_JS = loadAppWithDeps();

// Cache so it is only built once.
let _html: string | null = null;

export function getWritePreviewHtml(): string {
  if (_html) return _html;

  _html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mnema Write Preview</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #000;
  --surface: #111;
  --border: #222;
  --text-primary: #fff;
  --text-secondary: #a3a3a3;
  --text-muted: #525252;
  --green: #4ade80;
  --red: #f87171;
  --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-mono: 'SF Mono', 'Fira Code', 'Fira Mono', monospace;
}
html, body { background: var(--bg); color: var(--text-primary); font-family: var(--font); font-size: 13px; }
body { padding: 16px; display: flex; flex-direction: column; gap: 12px; min-height: 200px; }

.header { display: flex; flex-direction: column; gap: 4px; }
.op-badge {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 10px; font-weight: 600; letter-spacing: 0.05em;
  text-transform: uppercase; color: var(--text-muted);
}
.doc-title { font-size: 15px; font-weight: 600; color: var(--text-primary); }

.preview-label { font-size: 10px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--text-muted); }
.preview-block {
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 2px solid var(--green);
  border-radius: 6px;
  padding: 12px;
  font-size: 13px;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 300px;
  overflow-y: auto;
  font-family: var(--font-mono);
  line-height: 1.6;
}
.replace-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.before-label { color: var(--red); }
.after-label { color: var(--green); }
.before-block { border-left-color: var(--red); }

.actions { display: flex; gap: 8px; padding-top: 4px; }
.btn {
  flex: 1; padding: 9px 16px;
  border-radius: 6px; border: 1px solid var(--border);
  font-size: 13px; font-weight: 500;
  cursor: pointer; transition: opacity 0.15s;
}
.btn:hover { opacity: 0.85; }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-approve { background: #fff; color: #000; border-color: #fff; }
.btn-reject { background: transparent; color: var(--text-secondary); }

.status-line { font-size: 12px; color: var(--text-muted); min-height: 18px; }
.status-line.ok { color: var(--green); }
.status-line.err { color: var(--red); }

.connecting { color: var(--text-muted); font-size: 12px; }
</style>
</head>
<body>
<div id="root"><p class="connecting">Connecting…</p></div>
<script>window.__sdk=${JSON.stringify(APP_WITH_DEPS_JS)};</script>
<script type="module">
const OP_LABELS = {
  append: '+ Append',
  replace_section: '↻ Replace section',
  replace_body: '↻ Replace body',
  create: '+ Create doc',
  trash_doc: '🗑 Trash doc',
  trash_folder: '🗑 Trash folder',
  publish_flow: '▶ Publish flow',
};

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function render(data, root) {
  const { operation, doc_title, proposed_content, before_content, proposal_token, cascade_count } = data;
  const opLabel = OP_LABELS[operation] || operation;
  const isTrash = operation === 'trash_doc' || operation === 'trash_folder';
  const isReplace = operation === 'replace_section' || operation === 'replace_body';

  let previewHtml = '';
  if (isTrash) {
    const cascadeNote = (cascade_count > 0)
      ? \`<p style="color:var(--red);margin-top:8px;font-family:var(--font)">This will also trash \${cascade_count} item(s) inside.</p>\`
      : '';
    previewHtml = \`<div class="preview-block" style="border-left-color:var(--red);">\${escHtml(doc_title)}\${cascadeNote}</div>\`;
  } else if (isReplace && before_content) {
    previewHtml = \`
      <div class="replace-grid">
        <div>
          <div class="preview-label before-label">Before</div>
          <div class="preview-block before-block">\${escHtml(before_content)}</div>
        </div>
        <div>
          <div class="preview-label after-label">After</div>
          <div class="preview-block">\${escHtml(proposed_content || '')}</div>
        </div>
      </div>\`;
  } else {
    previewHtml = \`<div class="preview-block">\${escHtml(proposed_content || '')}</div>\`;
  }

  const approveLabel = isTrash
    ? (operation === 'trash_folder' ? 'Trash folder' : 'Trash doc')
    : operation === 'publish_flow'
      ? 'Publish'
      : 'Approve';

  root.innerHTML = \`
    <div class="header">
      <span class="op-badge">\${escHtml(opLabel)}</span>
      <span class="doc-title">\${escHtml(doc_title || '')}</span>
    </div>
    <div>
      <div class="preview-label" style="margin-bottom:6px">Preview</div>
      \${previewHtml}
    </div>
    <div class="actions">
      <button id="btn-reject" class="btn btn-reject">Reject</button>
      <button id="btn-approve" class="btn btn-approve">\${escHtml(approveLabel)}</button>
    </div>
    <div id="status" class="status-line"></div>
  \`;

  return { proposal_token };
}

async function main() {
  const root = document.getElementById('root');

  const blob = new Blob([window.__sdk], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  const { App, PostMessageTransport } = await import(url);
  URL.revokeObjectURL(url);

  const app = new App({ name: 'mnema-write-preview', version: '1.0.0' }, {}, { autoResize: true });

  app.ontoolresult = async ({ structuredContent, isError }) => {
    if (isError || !structuredContent) {
      root.innerHTML = '<p style="color:var(--red)">Tool error — no preview available.</p>';
      return;
    }
    const { proposal_token } = render(structuredContent, root);

    // Approve button
    document.getElementById('btn-approve').onclick = async () => {
      const approveBtn = document.getElementById('btn-approve');
      const rejectBtn = document.getElementById('btn-reject');
      const statusEl = document.getElementById('status');
      approveBtn.disabled = true;
      rejectBtn.disabled = true;
      approveBtn.textContent = '…';
      statusEl.textContent = 'Committing…';
      statusEl.className = 'status-line';
      try {
        await app.callServerTool({
          name: 'commit_proposed_write',
          arguments: { proposal_token },
        });
        statusEl.textContent = '✓ Written successfully';
        statusEl.className = 'status-line ok';
        approveBtn.textContent = 'Done';
      } catch (err) {
        const msg = String(err?.message || err);
        statusEl.textContent = msg.includes('expired')
          ? '⚠ Preview expired — ask Claude to re-propose.'
          : '❌ ' + msg;
        statusEl.className = 'status-line err';
        approveBtn.disabled = false;
        rejectBtn.disabled = false;
        approveBtn.textContent = 'Retry';
      }
    };

    // Reject button
    document.getElementById('btn-reject').onclick = () => {
      root.innerHTML = '<p style="color:var(--text-muted);font-size:12px">Write cancelled.</p>';
    };
  };

  await app.connect(new PostMessageTransport(window.parent, window.parent));
}

main().catch(err => {
  document.getElementById('root').innerHTML =
    '<p style="color:var(--red)">Failed to connect: ' + String(err) + '</p>';
});
</script>
</body>
</html>`;

  return _html;
}

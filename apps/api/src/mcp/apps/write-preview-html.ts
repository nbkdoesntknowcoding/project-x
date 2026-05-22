/**
 * Write-preview MCP App HTML bundle — Phase 10.
 *
 * ONE bundle for ALL write-preview operations. Rendered in a sandboxed iframe
 * when any propose_* tool returns. Shows the proposed change, the target name,
 * the operation, and Approve/Reject buttons.
 *
 * On Approve: calls the tool named in structuredContent.commit_tool via
 *   app.callServerTool() — commit_doc_write, commit_trash_folder,
 *   commit_flow_publish.
 * On Reject: posts a "Write cancelled by user." message and dismisses.
 *
 * Render switches on structuredContent.preview.kind:
 *   append, replace_section, replace_body, create, trash_doc, trash_folder,
 *   flow_publish.
 *
 * Design: pure-black Mnema theme, design tokens inlined (no external fetch).
 * CSP: no external origins, no CDN, no google fonts.
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
  --amber: #fbbf24;
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
.danger-block { border-left-color: var(--red); }
.danger-note { color: var(--red); margin-top: 8px; font-family: var(--font); }
.drift-warning {
  color: var(--amber); font-family: var(--font); font-size: 12px;
  margin-bottom: 6px;
}
.meta-row { color: var(--text-secondary); font-family: var(--font); margin-top: 6px; }

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
  flow_publish: '▶ Publish flow',
};

function escHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Shared two-column before/after diff renderer.
function renderDiff(before, after) {
  return \`
    <div class="replace-grid">
      <div>
        <div class="preview-label before-label">Before</div>
        <div class="preview-block before-block">\${escHtml(before)}</div>
      </div>
      <div>
        <div class="preview-label after-label">After</div>
        <div class="preview-block">\${escHtml(after)}</div>
      </div>
    </div>\`;
}

// Returns { previewHtml, targetName, approveLabel } for a given preview kind.
function renderPreview(preview) {
  const kind = preview.kind;
  switch (kind) {
    case 'append':
      return {
        targetName: preview.doc_title,
        approveLabel: 'Approve',
        previewHtml: \`
          <div class="preview-label" style="margin-bottom:6px">New content</div>
          <div class="preview-block">\${escHtml(preview.new_blocks_markdown || '')}</div>\`,
      };
    case 'replace_section':
      return {
        targetName: preview.doc_title,
        approveLabel: 'Approve',
        previewHtml:
          \`<div class="preview-label" style="margin-bottom:6px">Section: \${escHtml(preview.section_heading || 'section')}</div>\`
          + renderDiff(preview.before_markdown || '', preview.after_markdown || ''),
      };
    case 'replace_body': {
      const drift = preview.anchor_drift
        ? '<div class="drift-warning">⚠ The document changed since this preview was generated — review carefully.</div>'
        : '';
      return {
        targetName: preview.doc_title,
        approveLabel: 'Replace entire document',
        previewHtml: drift + renderDiff(preview.before_markdown || '', preview.after_markdown || ''),
      };
    }
    case 'create':
      return {
        targetName: preview.title,
        approveLabel: 'Approve',
        previewHtml: \`
          <div class="meta-row">Folder: \${escHtml(preview.folder_name || 'workspace root')}</div>
          <div class="preview-label" style="margin:8px 0 6px">Body</div>
          <div class="preview-block">\${escHtml(preview.body_markdown || '')}</div>\`,
      };
    case 'trash_doc':
      return {
        targetName: preview.doc_title,
        approveLabel: 'Trash doc',
        previewHtml: \`
          <div class="preview-block danger-block">
            \${escHtml(preview.doc_title)}
            <div class="danger-note">\${preview.block_count || 0} block(s) will be moved to Trash.</div>
            <div class="danger-note">Restorable for \${preview.restore_days || 30} days.</div>
          </div>\`,
      };
    case 'trash_folder':
      return {
        targetName: preview.folder_name,
        approveLabel: 'Trash folder',
        previewHtml: \`
          <div class="preview-block danger-block">
            \${escHtml(preview.folder_name)}
            <div class="danger-note">\${preview.doc_count || 0} doc(s) and \${preview.subfolder_count || 0} subfolder(s) will be moved to Trash.</div>
            <div class="danger-note">Restorable for \${preview.restore_days || 30} days.</div>
          </div>\`,
      };
    case 'flow_publish': {
      const d = preview.node_diff || { added: [], removed: [], changed: [] };
      const pub = preview.published_version == null
        ? 'none (first publish)'
        : 'v' + preview.published_version;
      const msg = preview.publish_message
        ? \`<div class="meta-row">Note: \${escHtml(preview.publish_message)}</div>\`
        : '';
      return {
        targetName: preview.flow_name,
        approveLabel: 'Publish',
        previewHtml: \`
          <div class="preview-block">
            Draft v\${escHtml(preview.draft_version)} → published \${escHtml(pub)}
            <div class="meta-row">\${escHtml(preview.branch_summary || '')}</div>
            <div class="meta-row">Node diff — \${(d.added||[]).length} added, \${(d.removed||[]).length} removed, \${(d.changed||[]).length} changed</div>
            \${msg}
          </div>\`,
      };
    }
    default:
      return {
        targetName: '',
        approveLabel: 'Approve',
        previewHtml: \`<div class="preview-block">Unknown preview kind: \${escHtml(kind)}</div>\`,
      };
  }
}

function render(data, root) {
  const preview = data.preview || {};
  const commit_tool = data.commit_tool;
  const proposal_token = data.proposal_token;
  const opLabel = OP_LABELS[preview.kind] || preview.kind || 'Write';

  const { previewHtml, targetName, approveLabel } = renderPreview(preview);

  root.innerHTML = \`
    <div class="header">
      <span class="op-badge">\${escHtml(opLabel)}</span>
      <span class="doc-title">\${escHtml(targetName || data.doc_title || '')}</span>
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

  return { proposal_token, commit_tool };
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
    const { proposal_token, commit_tool } = render(structuredContent, root);

    if (!commit_tool) {
      root.innerHTML = '<p style="color:var(--red)">Missing commit_tool — cannot commit.</p>';
      return;
    }

    // Approve button — calls the commit tool named in structuredContent.commit_tool.
    document.getElementById('btn-approve').onclick = async () => {
      const approveBtn = document.getElementById('btn-approve');
      const rejectBtn = document.getElementById('btn-reject');
      const statusEl = document.getElementById('status');
      const origLabel = approveBtn.textContent;
      approveBtn.disabled = true;
      rejectBtn.disabled = true;
      approveBtn.textContent = '…';
      statusEl.textContent = 'Committing…';
      statusEl.className = 'status-line';
      try {
        await app.callServerTool({
          name: commit_tool,
          arguments: { proposal_token },
        });
        statusEl.textContent = '✓ Done';
        statusEl.className = 'status-line ok';
        approveBtn.textContent = '✓ Done';
      } catch (err) {
        const msg = String((err && err.message) || err);
        statusEl.textContent = msg.includes('expired')
          ? '⚠ Preview expired — ask Claude to re-propose.'
          : '❌ ' + msg;
        statusEl.className = 'status-line err';
        approveBtn.disabled = false;
        rejectBtn.disabled = false;
        approveBtn.textContent = origLabel;
      }
    };

    // Reject button — post a cancellation message, then dismiss.
    document.getElementById('btn-reject').onclick = async () => {
      try {
        await app.sendMessage({
          role: 'user',
          content: [{ type: 'text', text: 'Write cancelled by user.' }],
        });
      } catch (e) {
        // If sendMessage fails, just update the UI.
      }
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

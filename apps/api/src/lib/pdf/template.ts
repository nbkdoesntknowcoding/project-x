import { marked } from 'marked';

// Diagram Phase 1 (Sprint 2): render mermaid + sanitized SVG fences in the export. Runs inside the
// Chromium export page. CDN libs are loaded ONLY when a diagram block is actually present, so
// normal (no-diagram) exports gain ZERO latency / network. Sets window.__diagramsReady so renderPdf
// can wait for async mermaid before printing; a 12s fallback guarantees the export never hangs even
// if a CDN fetch stalls (worst case the diagram prints as its source code — graceful degradation).
const DIAGRAM_RENDER_SCRIPT = `<script>
window.__diagramsReady = false;
setTimeout(function () { window.__diagramsReady = true; }, 12000);
(async function () {
  function loadScript(src) { return new Promise(function (res, rej) { var s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }
  function replaceWithDiagram(code, html) { var w = document.createElement('div'); w.className = 'diagram'; w.innerHTML = html; var pre = code.closest('pre'); if (pre) pre.replaceWith(w); }
  try {
    var svgBlocks = Array.prototype.slice.call(document.querySelectorAll('pre > code.language-svg'));
    var mmBlocks = Array.prototype.slice.call(document.querySelectorAll('pre > code.language-mermaid'));
    if (svgBlocks.length) {
      await loadScript('https://cdn.jsdelivr.net/npm/dompurify@3.4.3/dist/purify.min.js');
      svgBlocks.forEach(function (code) {
        var clean = window.DOMPurify.sanitize(code.textContent || '', { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['script', 'style', 'foreignObject', 'iframe', 'object', 'embed'] });
        replaceWithDiagram(code, clean);
      });
    }
    if (mmBlocks.length) {
      var mod = await import('https://cdn.jsdelivr.net/npm/mermaid@11.15.0/dist/mermaid.esm.min.mjs');
      var mermaid = mod.default;
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
      for (var i = 0; i < mmBlocks.length; i++) {
        try {
          var out = await mermaid.render('exp-mmd-' + i, mmBlocks[i].textContent || '');
          replaceWithDiagram(mmBlocks[i], out.svg);
        } catch (e) { /* leave the code block as-is on a mermaid parse error */ }
      }
    }
  } finally { window.__diagramsReady = true; }
})();
</script>`;

// Light-mode professional document template.
// Intentionally separate from Mnema's dark UI — exported PDFs are clean documents.
export function renderDocumentHtml(markdown: string, title: string): string {
  marked.setOptions({ gfm: true, breaks: false });
  const body = marked.parse(markdown) as string;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: 'Georgia', 'Times New Roman', serif;
    font-size: 11pt;
    line-height: 1.7;
    color: #1a1a1a;
    background: #ffffff;
  }

  h1 { font-size: 22pt; margin-bottom: 8pt; margin-top: 24pt; }
  h2 { font-size: 16pt; margin-bottom: 6pt; margin-top: 18pt; }
  h3 { font-size: 13pt; margin-bottom: 4pt; margin-top: 14pt; }
  h1:first-child, h2:first-child { margin-top: 0; }

  p { margin-bottom: 10pt; }

  table {
    width: 100%;
    border-collapse: collapse;
    margin: 14pt 0;
    font-size: 10pt;
  }
  th {
    background: #f3f4f6;
    font-weight: 600;
    text-align: left;
    padding: 7pt 10pt;
    border: 1px solid #d1d5db;
  }
  td {
    padding: 6pt 10pt;
    border: 1px solid #e5e7eb;
    vertical-align: top;
  }
  tr:nth-child(even) td { background: #fafafa; }

  pre {
    background: #f6f8fa;
    border: 1px solid #e5e7eb;
    border-radius: 4px;
    padding: 12pt;
    margin: 12pt 0;
    font-family: 'Courier New', monospace;
    font-size: 9pt;
    line-height: 1.5;
    page-break-inside: avoid;
    white-space: pre-wrap;
    word-break: break-all;
  }
  code {
    font-family: 'Courier New', monospace;
    font-size: 9pt;
    background: #f6f8fa;
    padding: 1pt 4pt;
    border-radius: 3px;
  }
  pre code { background: none; padding: 0; }

  img { max-width: 100%; height: auto; margin: 10pt 0; page-break-inside: avoid; }

  blockquote {
    border-left: 3px solid #d1d5db;
    padding-left: 14pt;
    color: #4b5563;
    margin: 12pt 0;
    font-style: italic;
  }

  ul, ol { padding-left: 20pt; margin-bottom: 10pt; }
  li { margin-bottom: 3pt; }

  hr { border: none; border-top: 1px solid #e5e7eb; margin: 20pt 0; }

  a { color: #1d4ed8; text-decoration: underline; }

  h1, h2, h3 { page-break-after: avoid; }
  pre, table, img { page-break-inside: avoid; }

  .diagram { margin: 14pt 0; text-align: center; page-break-inside: avoid; }
  .diagram svg { max-width: 100%; height: auto; }
</style>
</head>
<body>
${body}
${DIAGRAM_RENDER_SCRIPT}
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

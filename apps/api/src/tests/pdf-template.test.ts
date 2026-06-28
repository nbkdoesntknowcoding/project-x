/**
 * Diagram Phase 1, Sprint 2 — PDF export template wiring. The actual rasterization happens in the
 * Chromium export page (deploy-time smoke test); this asserts the template emits the right code
 * blocks + the render/sanitize script, and that a no-diagram doc's body is unchanged (no CDN fetch
 * unless a diagram block is present).
 */
import { describe, it, expect } from 'vitest';
import { renderDocumentHtml } from '../lib/pdf/template.js';

describe('renderDocumentHtml — diagram export', () => {
  it('mermaid fence → language-mermaid block + the render script (mermaid pinned + strict)', () => {
    const html = renderDocumentHtml('# Title\n\n```mermaid\ngraph TD; A-->B;\n```', 'Doc');
    expect(html).toContain('class="language-mermaid"');     // marked output Chromium will render
    expect(html).toContain('window.__diagramsReady');        // render-wait flag
    expect(html).toContain('mermaid@11.15.0');               // pinned CDN version
    expect(html).toContain("securityLevel: 'strict'");       // strict in export too
  });

  it('svg fence → language-svg block + DOMPurify sanitize in the export script', () => {
    const html = renderDocumentHtml('```svg\n<svg><circle r="5"/></svg>\n```', 'Doc');
    expect(html).toContain('class="language-svg"');
    expect(html).toContain('DOMPurify.sanitize');
    expect(html).toContain('FORBID_TAGS');                   // script/foreignObject/etc. forbidden
    expect(html).toContain('dompurify@3.4.3');               // pinned CDN
  });

  it('no-regression: a no-diagram doc renders its body unchanged; no diagram blocks ⇒ no CDN fetch', () => {
    const html = renderDocumentHtml('# Hello\n\nJust **text**, no diagrams.\n\n- a\n- b', 'Doc');
    expect(html).toContain('<h1>Hello</h1>');
    expect(html).toContain('<strong>text</strong>');
    expect(html).toContain('<li>a</li>');
    // no rendered diagram code blocks (the script's selector strings don't count)
    expect(html).not.toContain('class="language-mermaid"');
    expect(html).not.toContain('class="language-svg"');
    // the script is present but its conditional guards mean no CDN import runs for this doc
    expect(html).toContain('window.__diagramsReady');
  });
});

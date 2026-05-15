import { codeBlockConfig } from '@milkdown/kit/component/code-block';
import type { Ctx } from '@milkdown/kit/ctx';
import mermaid from 'mermaid';

let mermaidInitialized = false;
function initMermaid(): void {
  if (mermaidInitialized) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    themeVariables: {
      primaryColor: '#1c1f24',
      primaryTextColor: '#ededed',
      primaryBorderColor: '#8b78f0',
      lineColor: '#8b78f0',
      secondaryColor: '#14161a',
      tertiaryColor: '#0b0c0e',
      fontFamily: 'Inter, system-ui, sans-serif',
    },
  });
  mermaidInitialized = true;
}

let mermaidIdCounter = 0;
function nextMermaidId(): string {
  mermaidIdCounter += 1;
  return `mermaid-render-${mermaidIdCounter}`;
}

/**
 * Mermaid renders inside Crepe's CodeMirror code-block via the
 * `renderPreview` hook on `codeBlockConfig`. Same pattern Crepe's Latex
 * feature uses for KaTeX. Click "Hide" / "Edit" toggles between source
 * (CodeMirror) and rendered Mermaid SVG.
 *
 * We attempted a ProseMirror Plugin nodeView for `code_block` first; it
 * loses to Crepe's `$view`-registered CodeMirror nodeView (Milkdown's
 * `$view` mechanism takes precedence over raw plugin nodeViews).
 */
export function configureMermaidPreview(ctx: Ctx): void {
  initMermaid();
  ctx.update(codeBlockConfig.key, (prev) => ({
    ...prev,
    renderPreview: (language, content, applyPreview) => {
      if (language.toLowerCase() !== 'mermaid') {
        return prev.renderPreview(language, content, applyPreview);
      }
      if (!content.trim()) {
        const empty = document.createElement('div');
        empty.className = 'mermaid-empty';
        empty.textContent = 'Empty diagram';
        return empty;
      }

      // Return undefined → preview-panel shows previewLoading, then waits
      // for applyPreview(...) below. Returning the host element synchronously
      // would lock Vue's reactivity to that one instance and never re-render
      // when its innerHTML is mutated later.
      mermaid
        .render(nextMermaidId(), content)
        .then(({ svg }) => {
          const host = document.createElement('div');
          host.className = 'mermaid-preview';
          host.innerHTML = svg;
          applyPreview(host);
        })
        .catch((err: unknown) => {
          console.error('mermaid render failed', err);
          const errEl = document.createElement('div');
          errEl.className = 'mermaid-error';
          errEl.textContent = `Mermaid: ${String((err as { message?: string })?.message ?? err).slice(0, 200)}`;
          applyPreview(errEl);
        });
      return undefined;
    },
  }));
}

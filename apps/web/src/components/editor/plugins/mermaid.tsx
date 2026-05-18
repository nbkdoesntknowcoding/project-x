import { codeBlockConfig } from '@milkdown/kit/component/code-block';
import type { Ctx } from '@milkdown/kit/ctx';
import mermaid from 'mermaid';

/**
 * Mermaid theme variables for each Mnema theme. The brand accent stays
 * identical across themes (so node borders + flow arrows read the same
 * regardless of mode), only surfaces and text colors swap. Values come
 * from the design tokens — keep them in sync if global.css changes.
 */
const MERMAID_VARS = {
  dark: {
    primaryColor: '#1c1f24',
    primaryTextColor: '#ededed',
    primaryBorderColor: '#8b78f0',
    lineColor: '#8b78f0',
    secondaryColor: '#14161a',
    tertiaryColor: '#0b0c0e',
    fontFamily: 'Inter, system-ui, sans-serif',
  },
  light: {
    primaryColor: '#f4f5f7',
    primaryTextColor: '#1c1f24',
    primaryBorderColor: '#8b78f0',
    lineColor: '#8b78f0',
    secondaryColor: '#fafafa',
    tertiaryColor: '#ffffff',
    fontFamily: 'Inter, system-ui, sans-serif',
  },
} as const;

function currentTheme(): 'dark' | 'light' {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/**
 * Idempotent init that re-applies on every call. mermaid.initialize() is
 * safe to call repeatedly; later calls replace the theme variables on the
 * shared mermaid global. Existing already-rendered SVGs keep their old
 * theme (their DOM is innerHTML the editor doesn't re-trigger on its own)
 * — re-rendering them is a Phase 5 polish if the seam matters.
 */
function initMermaid(): void {
  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    themeVariables: MERMAID_VARS[currentTheme()],
  });
}

let themeObserver: MutationObserver | null = null;
function ensureThemeObserver(): void {
  if (themeObserver || typeof document === 'undefined') return;
  themeObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes' && m.attributeName === 'data-theme') {
        initMermaid();
        return;
      }
    }
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
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
 * Phase 4.3: also subscribes to <html data-theme> changes so future
 * diagrams render in the active theme's palette without a page reload.
 */
export function configureMermaidPreview(ctx: Ctx): void {
  initMermaid();
  ensureThemeObserver();
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

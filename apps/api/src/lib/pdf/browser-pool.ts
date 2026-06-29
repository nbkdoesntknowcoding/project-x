import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium, type Browser, type Page } from 'playwright';
import { config } from '../../config/env.js';

// Build 4: diagram libs are read from the API's own node_modules and injected into the export page
// (no CDN). Read lazily + cached — a no-diagram export never touches them, and an SVG-only export
// never loads the 3.2MB mermaid bundle. require.resolve works under ESM via createRequire.
const requireFromHere = createRequire(import.meta.url);
let dompurifySrc: string | null = null;
let mermaidSrc: string | null = null;
function getDompurifySrc(): string {
  return (dompurifySrc ??= readFileSync(requireFromHere.resolve('dompurify/dist/purify.min.js'), 'utf8'));
}
function getMermaidSrc(): string {
  return (mermaidSrc ??= readFileSync(requireFromHere.resolve('mermaid/dist/mermaid.min.js'), 'utf8'));
}

// Runs INSIDE the export page (serialized by Playwright). Swaps ```svg / ```mermaid code blocks for
// rendered figures: SVG is sanitized via the injected DOMPurify (svg profile, no script/handlers);
// mermaid is rendered via the injected mermaid global in strict mode. A per-block try/catch leaves
// the source visible on a parse error rather than failing the whole export.
async function renderDiagramsInPage(): Promise<void> {
  const w = window as unknown as {
    DOMPurify?: { sanitize: (s: string, opts: unknown) => string };
    mermaid?: { initialize: (o: unknown) => void; render: (id: string, src: string) => Promise<{ svg: string }> };
  };
  const replaceWithDiagram = (code: Element, htmlStr: string): void => {
    const fig = document.createElement('div');
    fig.className = 'diagram';
    fig.innerHTML = htmlStr;
    code.closest('pre')?.replaceWith(fig);
  };
  if (w.DOMPurify) {
    for (const code of Array.from(document.querySelectorAll('pre > code.language-svg'))) {
      const clean = w.DOMPurify.sanitize(code.textContent || '', {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'object', 'embed'],
      });
      replaceWithDiagram(code, clean);
    }
  }
  const mmBlocks = Array.from(document.querySelectorAll('pre > code.language-mermaid'));
  if (mmBlocks.length && w.mermaid) {
    // Build 5: brand the exported mermaid (light palette — PDFs are light-mode) so it matches the
    // in-app look rather than mermaid's flat default. Mirrors MERMAID_VARS.light in the web editor.
    w.mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      // SVG <text> labels (not <foreignObject>) — matches the in-app render so the PDF looks the same.
      htmlLabels: false,
      flowchart: { htmlLabels: false, useMaxWidth: true },
      theme: 'base',
      themeVariables: {
        primaryColor: '#f4f5f7',
        primaryTextColor: '#1c1f24',
        primaryBorderColor: 'rgba(214, 122, 51, 0.7)',
        lineColor: '#6E737C',
        secondaryColor: '#eceef1',
        tertiaryColor: '#ffffff',
        fontFamily: 'Geist, system-ui, sans-serif',
        fontSize: '15px',
      },
    });
    for (let i = 0; i < mmBlocks.length; i++) {
      const code = mmBlocks[i];
      if (!code) continue;
      try {
        const out = await w.mermaid.render(`exp-mmd-${i}`, code.textContent || '');
        replaceWithDiagram(code, out.svg);
      } catch { /* leave the source block as-is on a mermaid parse error */ }
    }
  }
}

const POOL_SIZE = 2;
const pool: Browser[] = [];
let initialised = false;

export async function initBrowserPool(): Promise<void> {
  if (initialised) return;
  for (let i = 0; i < POOL_SIZE; i++) {
    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
      ],
    });
    pool.push(browser);
  }
  initialised = true;
  // eslint-disable-next-line no-console
  console.log(`[browser-pool] initialised ${POOL_SIZE} Chromium instance(s)`);
}

let poolIndex = 0;
function getBrowser(): Browser {
  const browser = pool[poolIndex % pool.length];
  poolIndex++;
  if (!browser) throw new Error('Browser pool is empty — call initBrowserPool() first');
  return browser;
}

export async function renderPdf(html: string): Promise<Buffer> {
  const browser = getBrowser();
  let page: Page | null = null;
  try {
    page = await browser.newPage();
    // 'load' waits for the doc's own images but no longer races any network fetch — diagram libs are
    // injected locally below, so there's nothing external to stall on.
    let t = Date.now();
    await page.setContent(html, {
      waitUntil: 'load',
      timeout:   config.PDF_RENDER_TIMEOUT_MS,
    });
    logStep('setContent', t);
    // Build 4: render diagrams from LOCAL libs (no CDN). Only inject what a given doc needs — SVG
    // needs DOMPurify; mermaid needs the (large) mermaid bundle.
    const hasSvg = html.includes('language-svg');
    const hasMermaid = html.includes('language-mermaid');
    if (hasSvg || hasMermaid) {
      // HARD time-bound the whole diagram step (lib inject + render). A render that hangs in headless
      // Chromium must NEVER hang the job — on budget-exceeded we abandon it and print whatever the
      // page has (the diagram degrades to its source code). This restores the guarantee the old
      // CDN-era 12s fallback gave; without it a hung mermaid.render stalls the job to a 30s timeout.
      t = Date.now();
      const work = (async () => {
        if (hasSvg) { await page!.addScriptTag({ content: getDompurifySrc() }); logStep('inject:dompurify', t); }
        if (hasMermaid) { const m = Date.now(); await page!.addScriptTag({ content: getMermaidSrc() }); logStep('inject:mermaid', m); }
        const r = Date.now();
        await page!.evaluate(renderDiagramsInPage);
        logStep('render:diagrams', r);
      })();
      try {
        await Promise.race([
          work,
          new Promise((_, rej) => setTimeout(() => rej(new Error('diagram-render-budget-exceeded')), DIAGRAM_BUDGET_MS)),
        ]);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[browser-pool] diagram step abandoned after ${Date.now() - t}ms: ${String(err)} — printing source`);
      }
    }
    t = Date.now();
    const pdf = await page.pdf({
      format:     'A4',
      margin:     { top: '25mm', right: '20mm', bottom: '25mm', left: '20mm' },
      printBackground: true,
    });
    logStep('pdf', t);
    return Buffer.from(pdf);
  } finally {
    await page?.close();
  }
}

// Upper bound for the whole diagram render step. Must be comfortably under export_doc's 30s poll so a
// pathological diagram degrades to source and the job still returns a PDF instead of a 'timeout'.
const DIAGRAM_BUDGET_MS = 15_000;

function logStep(label: string, since: number): void {
  // eslint-disable-next-line no-console
  console.log(`[browser-pool] ${label}: ${Date.now() - since}ms`);
}

export async function closeBrowserPool(): Promise<void> {
  await Promise.all(pool.map((b) => b.close()));
  pool.length = 0;
  initialised = false;
}

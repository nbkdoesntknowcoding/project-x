import { chromium, type Browser, type Page } from 'playwright';
import { config } from '../../config/env.js';

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
    await page.setContent(html, {
      waitUntil: 'networkidle',
      timeout:   config.PDF_RENDER_TIMEOUT_MS,
    });
    const pdf = await page.pdf({
      format:     'A4',
      margin:     { top: '25mm', right: '20mm', bottom: '25mm', left: '20mm' },
      printBackground: true,
    });
    return Buffer.from(pdf);
  } finally {
    await page?.close();
  }
}

export async function closeBrowserPool(): Promise<void> {
  await Promise.all(pool.map((b) => b.close()));
  pool.length = 0;
  initialised = false;
}

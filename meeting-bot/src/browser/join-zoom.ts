// meeting-bot/src/browser/join-zoom.ts  (STEP 7 — Playwright Zoom joiner)
//
// Same pattern as GoogleMeetBot. Navigates the Zoom *web client*
// (https://zoom.us/wc/join/{id}). The web client keeps the "Join" button DISABLED
// until a name is entered (and passcode, if required), so we fill those first,
// wait for the button to become enabled, then click. On any failure we dump a
// screenshot to /app/.auth/zoom-*.png (mounted to ./.auth on the host) so the
// actual page state can be inspected instead of guessed.
import { chromium, Browser, Page } from 'playwright';
import { EventEmitter } from 'events';
import type { MeetingBotConfig } from './join-meet';

export class ZoomBot extends EventEmitter {
  private browser: Browser | null = null;
  private page: Page | null = null;

  constructor(private config: MeetingBotConfig) {
    super();
  }

  private async snapshot(tag: string): Promise<void> {
    try {
      await this.page?.screenshot({ path: `/app/.auth/zoom-${tag}.png`, fullPage: true });
      console.log(`[ZoomBot] saved screenshot .auth/zoom-${tag}.png`);
    } catch {}
  }

  async join(meetingId: string, password?: string): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--use-fake-ui-for-media-stream',
        '--alsa-output-device=pulse',
        '--alsa-input-device=pulse',
      ],
      env: {
        ...process.env,
        PULSE_SINK: this.config.pulseSinkName,
        PULSE_SOURCE: this.config.pulseSourceName,
        DISPLAY: ':1',
      },
    });

    const context = await this.browser.newContext({ permissions: ['microphone', 'camera'] });
    this.page = await context.newPage();
    const page = this.page;

    const meetingUrl = `https://zoom.us/wc/join/${meetingId}`;
    await page.goto(meetingUrl, { waitUntil: 'domcontentloaded' });

    // Cookie banner
    try { await page.getByRole('button', { name: /accept/i }).click({ timeout: 4000 }); } catch {}

    // Fill the display name (try several selectors — Zoom's web DOM shifts)
    let nameFilled = false;
    for (const sel of ['#input-for-name', 'input#inputname', 'input[placeholder*="name" i]', 'input[type="text"]']) {
      try {
        const el = page.locator(sel).first();
        if (await el.count()) { await el.fill(this.config.displayName, { timeout: 3000 }); nameFilled = true; break; }
      } catch {}
    }
    console.log(`[ZoomBot] name field filled: ${nameFilled}`);

    // Passcode, if supplied
    if (password) {
      for (const sel of ['#input-for-pwd', 'input[type="password"]', 'input[placeholder*="passcode" i]']) {
        try {
          const el = page.locator(sel).first();
          if (await el.count()) { await el.fill(password, { timeout: 3000 }); break; }
        } catch {}
      }
    }

    await this.snapshot('prejoin');

    // Wait for the Join button to become ENABLED, then click it.
    try {
      // Body runs in the browser context; cast to any so it compiles under Node libs.
      await page.waitForFunction(() => {
        const d = (globalThis as any).document;
        const b = Array.from(d.querySelectorAll('button'))
          .find((x: any) => /join/i.test(x.textContent || '')) as any;
        return !!b && !b.disabled && !String(b.className).includes('disabled');
      }, { timeout: 30000 });
      await page.locator('button:has-text("Join")').first().click();
    } catch (e) {
      await this.snapshot('join-failed');
      throw new Error(
        `Zoom Join button never enabled (name filled: ${nameFilled}). ` +
        `Check .auth/zoom-prejoin.png — meeting may be unstarted, need a passcode, or require sign-in. ${e}`
      );
    }

    // Join computer audio so the virtual mic (ElevenLabs TTS) is live
    try {
      await page.locator('button[aria-label="Join Audio"], button:has-text("Join Audio")').first().click({ timeout: 30000 });
    } catch {}

    // Confirm we're inside
    try {
      await page.waitForSelector('[aria-label*="participant" i], [aria-label*="Participants" i], [class*="footer-button"]', { timeout: 60000 });
    } catch { await this.snapshot('post-join'); }

    console.log('[ZoomBot] Joined meeting as', this.config.displayName);
    this.emit('joined');
  }

  async leave(): Promise<void> {
    try {
      await this.page?.locator('[aria-label*="Leave" i], button:has-text("Leave")').first().click();
    } catch {}
    await this.browser?.close();
    this.emit('left');
  }
}

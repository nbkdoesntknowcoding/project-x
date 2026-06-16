// meeting-bot/src/browser/join-zoom.ts  (STEP 7 — Playwright Zoom joiner)
//
// Same pattern as GoogleMeetBot.
// Navigate to https://zoom.us/wc/join/{meetingId}
// Handle: name field, audio/video toggles, "Join" button.
// Note: the Zoom web client requires accepting cookies and may show a waiting room.
import { chromium, Browser, Page } from 'playwright';
import { EventEmitter } from 'events';
import type { MeetingBotConfig } from './join-meet';

export class ZoomBot extends EventEmitter {
  private browser: Browser | null = null;
  private page: Page | null = null;

  constructor(private config: MeetingBotConfig) {
    super();
  }

  async join(meetingId: string, password?: string): Promise<void> {
    // Same Playwright + PulseAudio routing pattern as GoogleMeetBot, different selectors.
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

    const context = await this.browser.newContext({
      permissions: ['microphone', 'camera'],
    });
    this.page = await context.newPage();

    const meetingUrl = `https://zoom.us/wc/join/${meetingId}`;
    await this.page.goto(meetingUrl);

    // Accept cookies if the banner appears
    try {
      await this.page.locator('button:has-text("Accept")').first().click({ timeout: 5000 });
    } catch {}

    // Key selectors (Zoom web client):
    //   Name:        '#input-for-name'
    //   Passcode:    '#input-for-pwd'
    //   Join:        '#join-btn'
    //   Join audio:  button[aria-label="Join Audio"]
    //   Waiting room:'[class*="waiting-room"]'
    try {
      await this.page.fill('#input-for-name', this.config.displayName);
    } catch {}
    if (password) {
      try { await this.page.fill('#input-for-pwd', password); } catch {}
    }

    try {
      await this.page.locator('#join-btn').click();
    } catch {
      await this.page.locator('button:has-text("Join")').first().click();
    }

    // Join computer audio so the virtual mic (ElevenLabs TTS) is live
    try {
      await this.page.locator('button[aria-label="Join Audio"]').click({ timeout: 30000 });
    } catch {}

    // Wait until inside the meeting (toolbar / participants appear).
    try {
      await this.page.waitForSelector(
        '[aria-label*="participant" i], [aria-label*="Participants" i], [class*="footer"]',
        { timeout: 60000 }
      );
    } catch {}

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

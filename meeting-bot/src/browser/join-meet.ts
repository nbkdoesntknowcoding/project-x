// meeting-bot/src/browser/join-meet.ts  (STEP 7 — Playwright Google Meet joiner)
import { chromium, Browser, Page } from 'playwright';
import { EventEmitter } from 'events';
import { existsSync, statSync } from 'node:fs';

const GOOGLE_AUTH_PATH = '.auth/google-bot.json';

export interface MeetingBotConfig {
  displayName: string;          // 'Mnema' — what participants see
  googleAccountEmail: string;   // Dedicated bot Google account
  googleAccountPassword: string;
  pulseSinkName: string;        // 'mnema_meeting_sink'
  pulseSourceName: string;      // 'mnema_meeting_source'
}

export class GoogleMeetBot extends EventEmitter {
  private browser: Browser | null = null;
  private page: Page | null = null;

  constructor(private config: MeetingBotConfig) {
    super();
  }

  async join(meetingUrl: string): Promise<void> {
    // Launch Chromium with PulseAudio audio routing.
    // PULSE_SINK: all audio Chromium plays goes to our virtual sink (capture).
    // PULSE_SOURCE: Chromium reads its mic from our virtual source (injection).
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--use-fake-ui-for-media-stream',     // Auto-grant mic/camera permissions
        '--alsa-output-device=pulse',
        '--alsa-input-device=pulse',
      ],
      env: {
        ...process.env,
        PULSE_SINK: this.config.pulseSinkName,        // Route audio output here
        PULSE_SOURCE: this.config.pulseSourceName,    // Read mic from here
        DISPLAY: ':1',                                // Virtual X display (Xvfb)
      },
    });

    // Load the saved Google session so the bot is already signed in as the bot
    // account. Generate this file once via an interactive login (see README/notes)
    // and place it at .auth/google-bot.json. A tiny/empty file means "no auth".
    const hasAuth = existsSync(GOOGLE_AUTH_PATH) && statSync(GOOGLE_AUTH_PATH).size > 100;
    if (hasAuth) {
      console.log('[MeetBot] Loaded saved Google auth from', GOOGLE_AUTH_PATH);
    } else {
      console.warn('[MeetBot] No valid saved Google auth at', GOOGLE_AUTH_PATH,
        '— the join will likely hit a sign-in wall. Generate it once interactively.');
    }

    const context = await this.browser.newContext({
      permissions: ['microphone', 'camera'],
      ...(hasAuth ? { storageState: GOOGLE_AUTH_PATH } : {}),
    });

    this.page = await context.newPage();

    // Navigate to the meeting
    await this.page.goto(meetingUrl);

    // Handle pre-join screen
    await this._handlePreJoin();

    // Wait until inside the meeting
    await this._waitUntilJoined();

    console.log('[MeetBot] Joined meeting as', this.config.displayName);
    this.emit('joined');
  }

  private async _handlePreJoin(): Promise<void> {
    if (!this.page) return;

    // Set display name
    try {
      const nameField = this.page.locator('[placeholder*="name" i], [aria-label*="name" i]');
      await nameField.fill(this.config.displayName);
    } catch {
      // Name field may not appear if signed in with Google account
    }

    // Turn off camera
    try {
      const cameraBtn = this.page.locator('[aria-label*="camera" i], [data-is-muted]').first();
      await cameraBtn.click();
    } catch {}

    // DO NOT turn off mic — we need it for TTS injection.
    // The virtual source provides audio from ElevenLabs TTS.

    // Click Join
    const joinBtn = this.page.locator(
      'button:has-text("Join now"), button:has-text("Ask to join"), button:has-text("Join")'
    ).first();
    await joinBtn.click();
  }

  private async _waitUntilJoined(): Promise<void> {
    if (!this.page) return;
    // Wait for in-meeting UI — presence of participant list or chat button
    await this.page.waitForSelector(
      '[aria-label*="participant" i], [aria-label*="People" i]',
      { timeout: 60000 }
    );
  }

  async leave(): Promise<void> {
    try {
      const leaveBtn = this.page?.locator('[aria-label*="Leave" i]').first();
      await leaveBtn?.click();
    } catch {}
    await this.browser?.close();
    this.emit('left');
  }
}

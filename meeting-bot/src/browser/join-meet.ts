// meeting-bot/src/browser/join-meet.ts  (STEP 7 — Playwright Google Meet joiner)
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { EventEmitter } from 'events';

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

    const context = await this.browser.newContext({
      permissions: ['microphone', 'camera'],
    });

    this.page = await context.newPage();

    // Sign in with the bot's Google account
    await this._signInGoogle(context);

    // Navigate to the meeting
    await this.page.goto(meetingUrl);

    // Handle pre-join screen
    await this._handlePreJoin();

    // Wait until inside the meeting
    await this._waitUntilJoined();

    console.log('[MeetBot] Joined meeting as', this.config.displayName);
    this.emit('joined');
  }

  private async _signInGoogle(context: BrowserContext): Promise<void> {
    // Sign into the dedicated bot Google account.
    // Use a saved auth state (auth.json) to avoid login every time.
    // On first run: headless=false, sign in manually, save state.
    try {
      await context.storageState({ path: '.auth/google-bot.json' });
      console.log('[MeetBot] Using saved Google auth');
    } catch {
      console.warn('[MeetBot] No saved auth — sign in manually on first run');
      // Manual sign-in flow: set headless: false above, sign in, then save state
      await context.storageState({ path: '.auth/google-bot.json' });
    }
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

// meeting-bot/src/index.ts  (STEP 10 — Main Service Entry Point)
import express from 'express';
import { GoogleMeetBot } from './browser/join-meet';
import { ZoomBot } from './browser/join-zoom';
import { CaptureBridge } from './audio/capture-bridge';
import { InjectionBridge } from './audio/injection-bridge';

const app = express();
app.use(express.json());

// Phase 2 (audio injection) is gated OFF by default. HARD RULE: do not enable it
// until Phase 1 verification passes (bot joins + transcript appears in turn table).
// Flip ENABLE_INJECTION=true once Phase 1 is verified.
const ENABLE_INJECTION = process.env.ENABLE_INJECTION === 'true';

app.get('/health', (_req, res) => res.json({ status: 'ok', injection: ENABLE_INJECTION }));

// POST /join — called by Mnema or calendar integration when a meeting starts
app.post('/join', async (req, res) => {
  const { meetingUrl, meetingPlatform, meetingTitle, projectId } = req.body;

  const PIPECAT_WS = process.env.PIPECAT_MEETING_WS_URL ?? 'ws://localhost:8765';
  const PULSE_SINK = process.env.PULSE_SINK ?? 'mnema_meeting_sink';
  const PULSE_SOURCE = process.env.PULSE_SOURCE ?? 'mnema_meeting_source';

  try {
    // Phase 1: Start audio capture bridge (participants → Pipecat)
    const capture = new CaptureBridge({
      pulseSinkMonitor: `${PULSE_SINK}.monitor`,
      pipecatWsUrl: PIPECAT_WS,
      sampleRate: 8000,
    });
    await capture.start();
    console.log('[Main] Phase 1: Capture bridge started');

    // Phase 2: Start audio injection bridge (Pipecat TTS → meeting). Gated.
    let injection: InjectionBridge | null = null;
    if (ENABLE_INJECTION) {
      injection = new InjectionBridge();
      await injection.start(PULSE_SOURCE);
      console.log('[Main] Phase 2: Injection bridge started');
      // Forward TTS frames the Pipecat meeting transport sends back (over the same
      // capture WebSocket) into the virtual source so the bot is heard.
      capture.onAudioFromPipecat((chunk) => injection!.injectAudio(chunk));
    } else {
      console.log('[Main] Phase 2: Injection DISABLED (ENABLE_INJECTION!=true) — capture/transcript only');
    }

    // Join the meeting
    let bot;
    if (meetingPlatform === 'zoom') {
      bot = new ZoomBot({
        displayName: 'Mnema',
        googleAccountEmail: '',
        googleAccountPassword: '',
        pulseSinkName: PULSE_SINK,
        pulseSourceName: PULSE_SOURCE,
      });
    } else {
      bot = new GoogleMeetBot({
        displayName: 'Mnema',
        googleAccountEmail: process.env.BOT_GOOGLE_EMAIL!,
        googleAccountPassword: process.env.BOT_GOOGLE_PASSWORD!,
        pulseSinkName: PULSE_SINK,
        pulseSourceName: PULSE_SOURCE,
      });
    }

    await bot.join(meetingUrl);

    res.json({ success: true, message: 'Bot joined meeting', meetingTitle, projectId });
  } catch (err) {
    console.error('[Main] Failed to join meeting:', err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

app.listen(3001, () => console.log('[MeetingBot] Service on port 3001'));

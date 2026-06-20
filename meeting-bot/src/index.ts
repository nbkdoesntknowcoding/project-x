// meeting-bot/src/index.ts — Recall-based meeting controller.
//
// Thin HTTP service: /join asks Recall to send a bot ("Mnema") into the meeting.
// Recall streams the meeting's mixed audio to pipecat-meeting (via the public WS),
// which runs Deepgram → GPT-4o-mini (+ Mnema tools) → ElevenLabs, and (talking
// path) plays the reply back through Recall Output Media.
import express from 'express';
import { createBot, leaveBot } from './recall';

const app = express();
app.use(express.json());

const MNEMA_API_URL = (process.env.MNEMA_API_URL ?? '').replace(/\/+$/, '');
const MNEMA_API_KEY = process.env.MNEMA_API_KEY ?? '';

// Create the meeting row immediately at join time (before Recall enters the call),
// authenticated with the bot's Mnema key → establishes recall_bot_id ↔ workspace +
// organizer. This MUST exist before Recall's participant webhooks arrive, so the
// signature-verified roster (Phase 4) can attach to it. Best-effort; never blocks join.
async function ensureMeetingRow(botId: string, meetingUrl: string): Promise<void> {
  if (!MNEMA_API_URL || !MNEMA_API_KEY) return;
  try {
    await fetch(`${MNEMA_API_URL}/api/_internal/meeting-participants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MNEMA_API_KEY}` },
      body: JSON.stringify({ recall_bot_id: botId, meeting_url: meetingUrl, participants: [] }),
    });
  } catch (err) {
    console.error('[MeetingBot] ensureMeetingRow failed:', err);
  }
}

app.get('/health', (_req, res) => res.json({ status: 'ok', backend: 'recall' }));

// POST /join — { meetingUrl } (meetingPlatform optional; Recall detects it from the URL)
app.post('/join', async (req, res) => {
  const { meetingUrl } = req.body ?? {};
  if (!meetingUrl) return res.status(400).json({ success: false, error: 'meetingUrl required' });
  try {
    const bot = await createBot(meetingUrl);
    console.log('[MeetingBot] Recall bot created:', bot.id, 'for', meetingUrl);
    await ensureMeetingRow(bot.id, meetingUrl);
    res.json({ success: true, botId: bot.id });
  } catch (err) {
    console.error('[MeetingBot] join failed:', err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

// POST /leave — { botId }
app.post('/leave', async (req, res) => {
  const { botId } = req.body ?? {};
  if (!botId) return res.status(400).json({ success: false, error: 'botId required' });
  try {
    await leaveBot(botId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// Recall status webhooks land here (bot joined / done / errored). Logged for now.
app.post('/recall/webhook', (req, res) => {
  console.log('[MeetingBot] Recall webhook:', JSON.stringify(req.body));
  res.json({ ok: true });
});

app.listen(3001, () => console.log('[MeetingBot] Recall controller on port 3001'));

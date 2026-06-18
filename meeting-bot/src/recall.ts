// meeting-bot/src/recall.ts — Recall.ai REST client.
//
// Recall replaces the (blocked) self-driven browser: it joins Zoom/Meet/Teams,
// streams real-time mixed audio to our pipecat WS (input), and — via Output Media —
// loads our webpage as the bot's camera so the page can stream the bot's TTS audio
// back into the meeting with true barge-in (Stage 2).
//
// Region-specific base URL; auth is a bare token (NO "Bearer").
import { randomUUID } from 'crypto';

const REGION = process.env.RECALL_REGION ?? 'ap-northeast-1';
const BASE = `https://${REGION}.recall.ai/api/v1`;
const API_KEY = process.env.RECALL_API_KEY ?? '';

// Public wss URL Recall connects to and pushes mixed audio into (Caddy → pipecat-meeting),
// e.g. wss://meet-ws.theboringpeople.in/<secret>. We derive the host + secret from it to
// build the Output Media page URL (same host, served by pipecat at /output-page).
const AUDIO_WSS = process.env.RECALL_AUDIO_WSS ?? '';
const TTS_RATE = process.env.MEETING_TTS_SAMPLE_RATE ?? '24000';

const headers = {
  Authorization: API_KEY,
  'Content-Type': 'application/json',
};

export interface CreateBotResult {
  id: string;
  // Recall returns more (status, recordings, …) — id is what we need.
  [k: string]: unknown;
}

/** Build the Output Media page URL from the audio WSS (same host + secret). */
function outputPageUrl(cid: string): string {
  const u = new URL(AUDIO_WSS);                 // wss://<host>/<secret>
  const secret = u.pathname.replace(/^\/+/, '');
  return `https://${u.host}/output-page?secret=${encodeURIComponent(secret)}` +
    `&cid=${encodeURIComponent(cid)}&rate=${encodeURIComponent(TTS_RATE)}`;
}

/**
 * Create a Recall bot that joins `meetingUrl`, streams mixed audio to our pipecat WS,
 * and outputs its voice via an Output Media webpage. Works for Meet/Zoom/Teams.
 */
export async function createBot(meetingUrl: string): Promise<CreateBotResult> {
  if (!API_KEY) throw new Error('RECALL_API_KEY not set');
  if (!AUDIO_WSS) throw new Error('RECALL_AUDIO_WSS not set');

  // Our own correlation id: it links this bot's Output Media page (URL query) to its
  // realtime audio stream. We set it as bot metadata, which Recall echoes in the
  // audio_mixed_raw.data payload as bot.metadata.cid (pipecat keys the output WS on it).
  const cid = randomUUID();

  const body = {
    meeting_url: meetingUrl,
    bot_name: 'Mnema',
    metadata: { cid },
    recording_config: {
      // Enable mixed audio capture (required) ...
      audio_mixed_raw: {},
      // ... and stream it in real time to our Pipecat WS (input path).
      // Format is mono 16-bit LE PCM @ 16 kHz (parsed by recall_io.RecallSerializer).
      realtime_endpoints: [
        {
          type: 'websocket',
          url: AUDIO_WSS,
          events: ['audio_mixed_raw.data'],
        },
      ],
    },
    // Output path (talking): the bot renders our webpage as its camera; the page holds
    // a WS back to pipecat (/output/<secret>?cid=) and plays streamed TTS audio into the
    // meeting, flushing instantly on barge-in. (Mutually exclusive with
    // automatic_audio_output — which is why we no longer set a silent mp3.)
    output_media: {
      camera: {
        kind: 'webpage',
        config: { url: outputPageUrl(cid) },
      },
    },
  };

  const res = await fetch(`${BASE}/bot`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Recall createBot failed ${res.status}: ${text}`);
  }
  return (await res.json()) as CreateBotResult;
}

/** Remove the bot from the meeting. */
export async function leaveBot(botId: string): Promise<void> {
  await fetch(`${BASE}/bot/${botId}/leave_call`, { method: 'POST', headers });
}

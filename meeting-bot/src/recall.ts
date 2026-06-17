// meeting-bot/src/recall.ts — Recall.ai REST client.
//
// Recall replaces the (blocked) self-driven browser: it joins Zoom/Meet/Teams and
// streams real-time mixed audio to our public WS (→ pipecat-meeting → Pipecat), and
// (Phase 2 / talking) plays our TTS back into the meeting via Output Media.
//
// Region-specific base URL; auth is a bare token (NO "Bearer").
const REGION = process.env.RECALL_REGION ?? 'ap-northeast-1';
const BASE = `https://${REGION}.recall.ai/api/v1`;
const API_KEY = process.env.RECALL_API_KEY ?? '';

// Public wss URL Recall connects to and pushes mixed audio into (Caddy → pipecat-meeting).
const AUDIO_WSS = process.env.RECALL_AUDIO_WSS ?? '';

const headers = {
  Authorization: API_KEY,
  'Content-Type': 'application/json',
};

export interface CreateBotResult {
  id: string;
  // Recall returns more (status, recordings, …) — id is what we need.
  [k: string]: unknown;
}

/**
 * Create a Recall bot that joins `meetingUrl` and streams real-time mixed audio
 * to our pipecat WS. Works for Meet/Zoom/Teams — Recall figures out the platform
 * from the URL.
 */
export async function createBot(meetingUrl: string): Promise<CreateBotResult> {
  if (!API_KEY) throw new Error('RECALL_API_KEY not set');
  if (!AUDIO_WSS) throw new Error('RECALL_AUDIO_WSS not set');

  const body = {
    meeting_url: meetingUrl,
    bot_name: 'Mnema',
    recording_config: {
      // Real-time mixed audio → our Pipecat WS (input path).
      realtime_endpoints: [
        {
          type: 'websocket',
          url: AUDIO_WSS,
          events: ['audio_mixed_raw.data'],
        },
      ],
      // TODO(recall-mcp): add Output Media config so the bot SPEAKS our TTS back
      // into the meeting (cloned voice). Exact field/shape to be confirmed via the
      // Recall MCP before wiring pipecat-meeting/recall_output.py.
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

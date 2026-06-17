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

// A ~0.3s silent mp3 (base64). Recall requires an `automatic_audio_output` to be
// configured for the Output Audio endpoint to be usable; we never want a real
// auto-played clip, so we register silence. pipecat-meeting then speaks replies
// on demand via POST /bot/{id}/output_audio/ (recall_io.py).
const SILENT_MP3_B64 =
  'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYyLjEyLjEwMQAAAAAAAAAAAAAA//tAwAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAANAAAF/gAvLy8vLy8vQUFBQUFBQUFSUlJSUlJSUmNjY2NjY2N1dXV1dXV1dYaGhoaGhoaGl5eXl5eXl6mpqampqampurq6urq6urrLy8vLy8vL3d3d3d3d3d3u7u7u7u7u7v////////8AAAAATGF2YzYyLjI4AAAAAAAAAAAAAAAAJASSAAAAAAAABf5Vs5qDAAAAAAD/+xDEAAPAAAGkAAAAIAAANIAAAARMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVf/7EMQpg8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVV//sQxFMDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVX/+xDEfIPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVf/7EMSmA8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVV//sQxM+DwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVX/+xDE1gPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVf/7EMTWA8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//sQxNYDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/+xDE1gPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7EMTWA8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//sQxNYDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/+xDE1gPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVQ==';

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
    // Output path (talking): the bot speaks our ElevenLabs replies via the Output
    // Audio endpoint (POST /bot/{id}/output_audio/), which Recall only unlocks if
    // an automatic_audio_output is configured. We register a silent clip so nothing
    // auto-plays; pipecat-meeting drives the real speech on demand.
    automatic_audio_output: {
      in_call_recording: {
        data: { kind: 'mp3', b64_data: SILENT_MP3_B64 },
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

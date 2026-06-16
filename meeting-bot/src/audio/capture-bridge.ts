// meeting-bot/src/audio/capture-bridge.ts  (STEP 4 — Phase 1: Capture Only)
//
// Captures audio from the PulseAudio sink (what meeting participants say) and
// streams it to Pipecat as µ-law 8kHz frames — the same format Twilio sent in
// the VAP. The Pipecat meeting transport accepts these binary frames.
import { spawn, ChildProcess } from 'child_process';
import WebSocket from 'ws';

export interface CaptureBridgeConfig {
  pulseSinkMonitor: string;  // 'mnema_meeting_sink.monitor'
  pipecatWsUrl: string;      // WebSocket URL to the Pipecat meeting worker
  sampleRate: number;        // 8000 (µ-law 8kHz)
}

export class CaptureBridge {
  private ffmpegProcess: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private audioHandler: ((chunk: Buffer) => void) | null = null;

  constructor(private config: CaptureBridgeConfig) {}

  /**
   * Phase 2 wiring: register a handler for TTS audio the Pipecat meeting
   * transport sends back on this same WebSocket (binary µ-law 8kHz frames).
   * index.ts forwards these into the InjectionBridge so the bot is heard.
   */
  onAudioFromPipecat(cb: (chunk: Buffer) => void): void {
    this.audioHandler = cb;
  }

  async start(): Promise<void> {
    // Connect to Pipecat meeting worker
    this.ws = new WebSocket(this.config.pipecatWsUrl);

    await new Promise<void>((resolve, reject) => {
      this.ws!.once('open', resolve);
      this.ws!.once('error', reject);
    });

    console.log('[CaptureBridge] Connected to Pipecat');

    // Inbound: TTS audio from Pipecat (Phase 2). Forwarded to the InjectionBridge
    // via the handler registered by onAudioFromPipecat().
    this.ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary && this.audioHandler) {
        this.audioHandler(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      }
    });

    // FFmpeg: read from PulseAudio sink → encode µ-law 8kHz → stdout
    // This matches exactly what Twilio sent to Pipecat in the VAP
    this.ffmpegProcess = spawn('ffmpeg', [
      '-f', 'pulse',                          // PulseAudio input
      '-i', this.config.pulseSinkMonitor,     // Virtual sink monitor
      '-ar', String(this.config.sampleRate),  // 8000 Hz
      '-ac', '1',                             // Mono
      '-f', 'mulaw',                          // µ-law encoding (matches Twilio format)
      '-',                                    // Output to stdout
    ]);

    this.ffmpegProcess.stdout?.on('data', (chunk: Buffer) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        // Send as binary WebSocket frame (same as Twilio Media Streams)
        this.ws.send(chunk);
      }
    });

    this.ffmpegProcess.stderr?.on('data', (data: Buffer) => {
      console.log('[FFmpeg capture]', data.toString());
    });

    this.ffmpegProcess.on('exit', (code) => {
      console.log('[CaptureBridge] FFmpeg exited with code', code);
    });
  }

  stop(): void {
    this.ffmpegProcess?.kill();
    this.ws?.close();
  }
}

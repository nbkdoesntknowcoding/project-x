// meeting-bot/src/audio/injection-bridge.ts  (STEP 5 — Phase 2: Bot Speaking)
//
// Receives TTS audio from Pipecat (raw µ-law 8kHz) and writes it to the
// PulseAudio virtual source. Chromium reads this as its microphone, so meeting
// participants hear the bot.
//
// HARD RULE: do not activate Phase 2 (injection) until Phase 1 verification
// passes (bot joins + transcript appears in the turn table). TTS frames arrive
// on the same WebSocket the CaptureBridge opened — index.ts forwards them here
// via injectAudio() (the transport's send_audio path).
import { spawn, ChildProcess } from 'child_process';

export class InjectionBridge {
  private ffmpegProcess: ChildProcess | null = null;

  // Call start() once the Pipecat connection is established
  async start(pulseSourceName: string): Promise<void> {
    // FFmpeg: read raw µ-law 8kHz from stdin → write to PulseAudio virtual source
    this.ffmpegProcess = spawn('ffmpeg', [
      '-ar', '8000',
      '-ac', '1',
      '-f', 'mulaw',
      '-i', 'pipe:0',                 // Read TTS audio from stdin
      '-f', 'pulse',
      '-device', pulseSourceName,     // Write to virtual source (bot mic)
      '-',
    ]);

    this.ffmpegProcess.stderr?.on('data', (data: Buffer) => {
      console.log('[FFmpeg inject]', data.toString());
    });

    console.log('[InjectionBridge] Ready — bot can now speak into meeting');
  }

  // Called when Pipecat sends TTS audio back
  injectAudio(chunk: Buffer): void {
    this.ffmpegProcess?.stdin?.write(chunk);
  }

  stop(): void {
    this.ffmpegProcess?.stdin?.end();
    this.ffmpegProcess?.kill();
  }
}

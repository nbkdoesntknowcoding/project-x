# pipecat-meeting/transport_meeting.py  (STEP 6 — reference transport)
#
# Derived from voice-clone/media-worker/pipeline/assembler.py (which uses
# FastAPIWebsocketTransport + TwilioFrameSerializer). This file is the doc's
# reference WebSocket transport: it accepts µ-law 8kHz frames from the meeting-bot
# CaptureBridge and sends TTS µ-law 8kHz frames back to the InjectionBridge.
#
# In the real integration (see pipeline.py) we keep Pipecat's
# FastAPIWebsocketTransport and only swap the SERIALIZER from TwilioFrameSerializer
# to RawMulawSerializer — that is the "change ONLY the transport" the build prompt
# intends, since the rest of the pipeline (STT → LLM → TTS) is UNTOUCHED.
#
# This standalone class is kept for clarity / local loopback testing of the
# CaptureBridge↔InjectionBridge wire format before wiring into Pipecat.
import asyncio
import websockets
from pipecat.frames.frames import AudioRawFrame, EndFrame  # noqa: F401


class MeetingBotTransport:
    """
    WebSocket transport for the meeting bot.
    Receives µ-law 8kHz audio from CaptureBridge (meeting participants speaking).
    Sends µ-law 8kHz audio to InjectionBridge (bot TTS to inject into meeting).

    Drop-in replacement for the Twilio transport in the VAP pipeline.
    The rest of the Pipecat pipeline (STT → LLM → TTS) is UNTOUCHED.
    """

    def __init__(self, host: str = "0.0.0.0", port: int = 8765):
        self.host = host
        self.port = port
        self._websocket = None
        self._pipeline = None  # set by the pipeline assembler

    async def start(self):
        async with websockets.serve(self._handle_connection, self.host, self.port):
            print(f"[MeetingBotTransport] Listening on ws://{self.host}:{self.port}")
            await asyncio.Future()  # run forever

    async def _handle_connection(self, websocket, path):
        self._websocket = websocket
        print("[MeetingBotTransport] CaptureBridge connected")

        async for message in websocket:
            if isinstance(message, bytes):
                # µ-law 8kHz audio frame from meeting participants.
                # Forward to the VAP pipeline (same as Twilio frames).
                frame = AudioRawFrame(audio=message, sample_rate=8000, num_channels=1)
                await self._pipeline.process_frame(frame, direction="downstream")

    async def send_audio(self, audio_bytes: bytes):
        """Called by TTS to send bot speech back to InjectionBridge."""
        if self._websocket:
            await self._websocket.send(audio_bytes)

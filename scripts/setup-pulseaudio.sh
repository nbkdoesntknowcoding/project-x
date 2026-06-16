#!/bin/bash
# File: setup-pulseaudio.sh
# Run once on VPS to create virtual audio devices (STEP 2)
set -euo pipefail

# Install PulseAudio if not present
apt-get install -y pulseaudio pulseaudio-utils

# Create a PulseAudio daemon config for the meeting bot user
mkdir -p ~/.config/pulse
cat > ~/.config/pulse/default.pa << 'EOF'
#!/usr/bin/pulseaudio -nF
.include /etc/pulse/default.pa

# Virtual sink: Chromium sends meeting audio here
# This is what the participants in the meeting are saying
load-module module-null-sink \
  sink_name=mnema_meeting_sink \
  sink_properties=device.description="Mnema_Meeting_Capture"

# Virtual source: Chromium reads TTS audio from here
# This is what the bot will say into the meeting
load-module module-virtual-source \
  source_name=mnema_meeting_source \
  master=mnema_meeting_sink.monitor \
  source_properties=device.description="Mnema_Bot_Mic"
EOF

# Start PulseAudio as a daemon (not system-wide)
pulseaudio --start --log-target=syslog

# Verify virtual devices created
pactl list short sinks | grep mnema_meeting_sink
pactl list short sources | grep mnema_meeting_source

echo "PulseAudio virtual devices ready."
echo "Loopback test (verification gate):"
echo "  ffmpeg -f pulse -i mnema_meeting_sink.monitor -t 5 /tmp/test-capture.wav"

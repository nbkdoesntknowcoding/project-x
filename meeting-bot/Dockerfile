# meeting-bot/Dockerfile
# Playwright image ships Chromium + system deps (incl. audio libs + xvfb).
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

# FFmpeg + PulseAudio client utilities for the audio bridges; xvfb for headful Chrome.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg pulseaudio-utils xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install

COPY src ./src
RUN npm run build

# Install REAL Google Chrome (channel: 'chrome'). Meet redirects headless Chromium
# to its marketing page as an "unsupported browser"; real Chrome run headful under
# Xvfb looks like a genuine user. Keep bundled chromium too as a fallback.
RUN npx playwright install --with-deps chrome chromium

EXPOSE 3001
# Run under a virtual display so Chrome can launch HEADFUL (much less detectable).
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1280x720x24", "node", "dist/index.js"]

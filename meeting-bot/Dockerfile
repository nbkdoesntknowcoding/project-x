# meeting-bot/Dockerfile
# Playwright image ships Chromium + system deps (incl. audio libs).
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

# FFmpeg + PulseAudio client utilities for the audio bridges
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg pulseaudio-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install

COPY src ./src
RUN npm run build

# Chromium is already installed in the base image; ensure browser deps present
RUN npx playwright install chromium

EXPOSE 3001
CMD ["node", "dist/index.js"]

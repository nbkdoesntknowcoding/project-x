# pipecat-meeting/Dockerfile
FROM python:3.11-slim

# ffmpeg/audio libs not needed here (audio bridges live in meeting-bot); Pipecat
# needs build essentials for some wheels.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . ./

EXPOSE 8765
CMD ["python", "pipeline.py"]

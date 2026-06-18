"""
output_page.py — the webpage Recall loads as the bot's camera for Output Media.

Recall's Output Media streams a webpage's audio+video into the meeting. We serve this
page from pipecat itself (GET /output-page) over the existing meet-ws route, so the
page and its audio WebSocket are same-origin and reuse the meet-ws cert — no new
subdomain/cert needed.

The page:
  - connects to  wss://<host>/output/<secret>?bot=<botId>
  - receives BINARY frames = raw PCM16 mono (the bot's TTS) → plays them gaplessly
    via Web Audio, scheduling each buffer right after the previous one
  - receives TEXT frames = JSON control: {"type":"interrupt"} flushes all queued/
    playing audio immediately (barge-in), {"type":"config","sampleRate":N} sets rate
  - renders a branded placeholder (Output Media always sends the camera video)

PCM rate is passed as ?rate=… (default 24000, matching the ElevenLabs pcm_24000 TTS).
Buffers are created at the PCM rate; the AudioContext resamples on playback, so it
works regardless of the device/context native rate.
"""

_HTML = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=1280, height=720" />
<title>Mnema</title>
<style>
  html,body{margin:0;height:100%;background:#0b0b12;color:#e8e8f2;
    font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
    display:flex;align-items:center;justify-content:center;overflow:hidden}
  .brand{text-align:center}
  .row{display:flex;align-items:center;justify-content:center;gap:14px}
  .dot{width:16px;height:16px;border-radius:50%;background:#6b7cff;
    box-shadow:0 0 24px #6b7cff;animation:pulse 1.6s ease-in-out infinite}
  @keyframes pulse{0%,100%{transform:scale(.7);opacity:.45}50%{transform:scale(1);opacity:1}}
  h1{font-weight:600;font-size:64px;letter-spacing:1px;margin:0}
  p{opacity:.55;font-size:20px;margin:14px 0 0}
  .speaking .dot{animation-duration:.5s;background:#7CF59B;box-shadow:0 0 28px #7CF59B}
</style>
</head>
<body>
  <div class="brand" id="brand">
    <div class="row"><span class="dot"></span><h1>Mnema</h1></div>
    <p id="status">connecting…</p>
  </div>
<script>
(function () {
  var qs = new URLSearchParams(location.search);
  var cid = qs.get('cid') || '';
  var secret = qs.get('secret') || '';
  var sampleRate = parseInt(qs.get('rate') || '24000', 10) || 24000;
  var statusEl = document.getElementById('status');
  var brandEl = document.getElementById('brand');
  var wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') +
    location.host + '/output/' + encodeURIComponent(secret) +
    '?cid=' + encodeURIComponent(cid);

  var ac = null, nextTime = 0, sources = [], speakingTimer = null;

  function ctx() {
    if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }
  function markSpeaking() {
    brandEl.classList.add('speaking');
    if (speakingTimer) clearTimeout(speakingTimer);
    speakingTimer = setTimeout(function () { brandEl.classList.remove('speaking'); }, 400);
  }
  function play(arrayBuf) {
    var c = ctx();
    var i16 = new Int16Array(arrayBuf);
    if (!i16.length) return;
    var f32 = new Float32Array(i16.length);
    for (var i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
    var buf = c.createBuffer(1, f32.length, sampleRate);
    buf.getChannelData(0).set(f32);
    var src = c.createBufferSource();
    src.buffer = buf; src.connect(c.destination);
    var now = c.currentTime;
    if (nextTime < now + 0.02) nextTime = now + 0.02;  // tiny lead to avoid underrun
    src.start(nextTime);
    nextTime += buf.duration;
    sources.push(src);
    src.onended = function () { sources = sources.filter(function (s) { return s !== src; }); };
    markSpeaking();
  }
  function interrupt() {
    for (var i = 0; i < sources.length; i++) { try { sources[i].stop(); } catch (e) {} }
    sources = [];
    if (ac) nextTime = ac.currentTime;
    brandEl.classList.remove('speaking');
  }

  function connect() {
    var ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { setTimeout(connect, 1000); return; }
    ws.binaryType = 'arraybuffer';
    ws.onopen = function () { statusEl.textContent = 'live'; };
    ws.onmessage = function (ev) {
      if (typeof ev.data === 'string') {
        try {
          var m = JSON.parse(ev.data);
          if (m.type === 'interrupt') interrupt();
          else if (m.type === 'config' && m.sampleRate) sampleRate = m.sampleRate;
        } catch (e) {}
      } else {
        play(ev.data);
      }
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
    ws.onclose = function () { statusEl.textContent = 'reconnecting…'; setTimeout(connect, 1000); };
  }
  connect();
})();
</script>
</body>
</html>
"""


def output_page_html() -> str:
    return _HTML

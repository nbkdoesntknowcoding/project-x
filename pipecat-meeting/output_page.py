"""
output_page.py — the webpage Recall loads as the bot's camera for Output Media.

Recall's Output Media streams a webpage's audio+video into the meeting. We serve this
page from pipecat itself (GET /output-page) over the existing meet-ws route, so the
page and its audio WebSocket are same-origin and reuse the meet-ws cert.

The page:
  - connects to  wss://<host>/output/<secret>?cid=<cid>
  - receives BINARY frames = raw PCM16 mono (the bot's TTS) and feeds them to a single
    continuous AudioWorklet player (a FIFO that emits samples gaplessly) — this is the
    approach Recall's own voice-agent demo uses (WavStreamPlayer). It avoids the drift/
    gaps/garble of hand-scheduling individual BufferSources.
  - receives TEXT frames = JSON control: {"type":"interrupt"} clears the FIFO instantly
    (barge-in), {"type":"config","sampleRate":N} ignored (rate fixed at load).
  - renders a branded placeholder (Output Media always sends the camera video)

PCM rate is passed as ?rate=… (default 24000, matching Inworld PCM @ 24000). The
AudioContext is created at that rate so samples map 1:1.
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

  // AudioWorklet that holds a FIFO of Float32 chunks and emits them gaplessly,
  // sample-accurate — no manual scheduling. (WavStreamPlayer pattern.)
  var workletCode =
    "class StreamProcessor extends AudioWorkletProcessor {" +
    "  constructor(){ super(); this.q=[]; this.i=0;" +
    "    this.port.onmessage=(e)=>{ var d=e.data;" +
    "      if(d.event==='write'){ this.q.push(d.buffer); }" +
    "      else if(d.event==='clear'){ this.q=[]; this.i=0; } }; }" +
    "  process(inputs, outputs){ var out=outputs[0][0]; if(!out) return true;" +
    "    for(var n=0;n<out.length;n++){" +
    "      if(this.q.length===0){ out[n]=0; continue; }" +
    "      out[n]=this.q[0][this.i++];" +
    "      if(this.i>=this.q[0].length){ this.q.shift(); this.i=0; } }" +
    "    return true; } }" +
    "registerProcessor('stream_processor', StreamProcessor);";

  var ac = null, node = null, ready = false, speakingTimer = null;

  function markSpeaking() {
    brandEl.classList.add('speaking');
    if (speakingTimer) clearTimeout(speakingTimer);
    speakingTimer = setTimeout(function () { brandEl.classList.remove('speaking'); }, 400);
  }

  function initAudio() {
    if (ac) return Promise.resolve();
    try {
      ac = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: sampleRate });
    } catch (e) {
      ac = new (window.AudioContext || window.webkitAudioContext)();
    }
    var blob = new Blob([workletCode], { type: 'application/javascript' });
    var url = URL.createObjectURL(blob);
    // Keep nudging the context to run (Recall's browser may start it suspended).
    setInterval(function () { if (ac && ac.state !== 'running') { try { ac.resume(); } catch (e) {} } }, 300);
    return ac.audioWorklet.addModule(url).then(function () {
      node = new AudioWorkletNode(ac, 'stream_processor', { outputChannelCount: [1] });
      node.connect(ac.destination);
      ready = true;
      try { ac.resume(); } catch (e) {}
    }).catch(function (err) { statusEl.textContent = 'audio init failed'; });
  }

  function play(arrayBuf) {
    if (!ready || !node) return;            // not initialised yet — drop (don't backlog)
    if (ac.state !== 'running') { try { ac.resume(); } catch (e) {} }
    var i16 = new Int16Array(arrayBuf);
    if (!i16.length) return;
    var f32 = new Float32Array(i16.length);
    for (var i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
    node.port.postMessage({ event: 'write', buffer: f32 }, [f32.buffer]);
    markSpeaking();
  }

  function interrupt() {
    if (node) node.port.postMessage({ event: 'clear' });
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
        } catch (e) {}
      } else {
        play(ev.data);
      }
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
    ws.onclose = function () { statusEl.textContent = 'reconnecting…'; setTimeout(connect, 1000); };
  }

  initAudio().then(connect);
})();
</script>
</body>
</html>
"""


def output_page_html() -> str:
    return _HTML

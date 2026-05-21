/**
 * Hello-world MCP App HTML bundle — Phase 10, Step 1.2.
 *
 * Temporary. Proves the protocol end-to-end through the Cloudflare tunnel
 * and OAuth before any write logic is added. Removed after verification.
 *
 * Self-contained: inlines app-with-deps.js via a runtime blob URL import.
 * CSP: no external origins declared (enforced by registerAppResource config).
 */

import { readFileSync } from 'fs';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);

function loadAppWithDeps(): string {
  try {
    const pkgPath = _require.resolve('@modelcontextprotocol/ext-apps/app-with-deps');
    return readFileSync(pkgPath, 'utf8');
  } catch (e) {
    return `console.error('ext-apps load failed: ${String(e)}');`;
  }
}

const APP_WITH_DEPS_JS = loadAppWithDeps();

export const PROBE_HTML: string = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mnema Probe</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: #000; color: #fff;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 13px; padding: 16px;
  display: flex; flex-direction: column; gap: 8px;
}
#s { color: #a3a3a3; }
#s.ok { color: #4ade80; font-weight: 600; }
#s.err { color: #f87171; }
#d { color: #737373; font-size: 11px; font-family: monospace; white-space: pre-wrap; }
</style>
</head>
<body>
<div id="s">⏳ Connecting…</div>
<div id="d"></div>
<script>window.__sdk=${JSON.stringify(APP_WITH_DEPS_JS)};</script>
<script type="module">
(async()=>{
  const s=document.getElementById('s'),d=document.getElementById('d');
  try {
    const blob=new Blob([window.__sdk],{type:'text/javascript'});
    const url=URL.createObjectURL(blob);
    const {App,PostMessageTransport}=await import(url);
    URL.revokeObjectURL(url);
    const app=new App({name:'mnema-probe',version:'1.0.0'},{},{autoResize:true});
    app.ontoolresult=({structuredContent,isError})=>{
      s.textContent=isError?'❌ Tool error':'✓ Mnema MCP App: connected';
      s.className=isError?'err':'ok';
      d.textContent=JSON.stringify(structuredContent,null,2);
    };
    await app.connect(new PostMessageTransport(window.parent,window.parent));
    s.textContent='✓ Mnema MCP App: connected (awaiting result…)';
    s.className='ok';
  } catch(err) {
    s.textContent='❌ '+String(err);
    s.className='err';
  }
})();
</script>
</body>
</html>`;

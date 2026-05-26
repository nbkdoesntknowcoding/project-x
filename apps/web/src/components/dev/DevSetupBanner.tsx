// TODO: Claude Design — apply Mnema glassmorphism design system
// Background: var(--bg) #0a0a0a
// Cards: rgba(255,255,255,0.04) + backdrop-filter: blur(24px)
// See BOPPL_Context_Engine_Prompt_UI_Redesign_All_MCP_Panels for token system

import { type JSX, useState } from 'react';

interface DevSetupBannerProps {
  workspaceId: string;
  hookToken: string; // plaintext — shown once
  onDismiss: () => void;
}

export function DevSetupBanner({ workspaceId, hookToken, onDismiss }: DevSetupBannerProps): JSX.Element {
  const [copied, setCopied] = useState<string | null>(null);
  const webBase = typeof window !== 'undefined'
    ? window.location.origin
    : 'https://mnema.theboringpeople.in';

  const installCommand = `MNEMA_HOOK_TOKEN=${hookToken} MNEMA_WORKSPACE_ID=${workspaceId} bash <(curl -sf ${webBase}/install/claude-hooks.sh)`;
  const mcpSnippet = JSON.stringify({
    mcpServers: { mnema: { url: `${webBase}/mcp`, headers: { Authorization: 'Bearer <YOUR_MCP_TOKEN>' } } },
  }, null, 2);

  async function copyText(text: string, key: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }

  function handleDismiss(): void {
    if (typeof window !== 'undefined') {
      localStorage.setItem(`mnema_setup_banner_${workspaceId}`, 'dismissed');
    }
    onDismiss();
  }

  return (
    <div style={{
      background: 'rgba(99,102,241,0.08)',
      border: '1px solid rgba(99,102,241,0.3)',
      borderRadius: 12,
      padding: 20,
      marginBottom: 20,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <h3 style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>
            🚀 Dev Project workspace created
          </h3>
          <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--ink-muted)' }}>
            Copy your hook token now — it won't be shown again.
          </p>

          {/* Hook token */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 11, color: 'var(--ink-muted)', marginBottom: 4 }}>
              Hook Token (copy now — shown once)
            </label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <code style={{
                flex: 1, padding: '6px 10px', borderRadius: 6,
                background: 'rgba(0,0,0,0.4)', border: '1px solid var(--line)',
                fontSize: 12, color: '#10b981', wordBreak: 'break-all',
              }}>
                {hookToken}
              </code>
              <button
                onClick={() => void copyText(hookToken, 'token')}
                style={{ ...copyBtnStyle, background: copied === 'token' ? '#10b981' : undefined }}
              >
                {copied === 'token' ? '✓' : 'Copy'}
              </button>
            </div>
          </div>

          {/* Install command */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 11, color: 'var(--ink-muted)', marginBottom: 4 }}>
              Install hooks in Claude Code
            </label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <code style={{
                flex: 1, padding: '6px 10px', borderRadius: 6,
                background: 'rgba(0,0,0,0.4)', border: '1px solid var(--line)',
                fontSize: 11, color: 'var(--ink-soft)', wordBreak: 'break-all',
              }}>
                {installCommand}
              </code>
              <button
                onClick={() => void copyText(installCommand, 'install')}
                style={{ ...copyBtnStyle, background: copied === 'install' ? '#10b981' : undefined }}
              >
                {copied === 'install' ? '✓' : 'Copy'}
              </button>
            </div>
          </div>

          {/* MCP config snippet */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 11, color: 'var(--ink-muted)', marginBottom: 4 }}>
              MCP Config (~/.claude/mcp.json)
            </label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <pre style={{
                flex: 1, margin: 0, padding: '6px 10px', borderRadius: 6,
                background: 'rgba(0,0,0,0.4)', border: '1px solid var(--line)',
                fontSize: 11, color: 'var(--ink-soft)', overflow: 'auto',
              }}>
                {mcpSnippet}
              </pre>
              <button
                onClick={() => void copyText(mcpSnippet, 'mcp')}
                style={{ ...copyBtnStyle, background: copied === 'mcp' ? '#10b981' : undefined }}
              >
                {copied === 'mcp' ? '✓' : 'Copy'}
              </button>
            </div>
          </div>

          <button
            onClick={handleDismiss}
            style={{
              padding: '7px 16px', borderRadius: 6,
              background: 'rgba(99,102,241,0.2)', border: '1px solid rgba(99,102,241,0.4)',
              color: '#818cf8', fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}
          >
            I've copied my token
          </button>
        </div>
      </div>
    </div>
  );
}

const copyBtnStyle: React.CSSProperties = {
  padding: '5px 10px', borderRadius: 5,
  border: '1px solid var(--line)', background: 'var(--surface-2)',
  color: 'var(--ink-muted)', fontSize: 11, cursor: 'pointer', flexShrink: 0,
  transition: 'background 0.2s',
};

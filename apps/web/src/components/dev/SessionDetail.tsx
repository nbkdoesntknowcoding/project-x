// TODO: Claude Design — apply Mnema glassmorphism design system
// Background: var(--bg) #0a0a0a
// Cards: rgba(255,255,255,0.04) + backdrop-filter: blur(24px)
// See BOPPL_Context_Engine_Prompt_UI_Redesign_All_MCP_Panels for token system

import { type JSX, useCallback, useEffect, useRef, useState } from 'react';

// ── API helpers ───────────────────────────────────────────────────────────────

const API_BASE =
  (typeof window !== 'undefined' &&
    (window as unknown as Record<string, string>).__PUBLIC_API_URL__) ||
  (import.meta as unknown as { env: Record<string, string> }).env?.PUBLIC_API_URL ||
  'http://localhost:8080';

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentSession {
  id:               string;
  workspaceId:      string;
  taskId:           string | null;
  taskTitle:        string | null;
  developerId:      string;
  agent:            string;
  status:           string;
  startedAt:        string;
  endedAt:          string | null;
  durationMs:       number | null;
  totalInputTokens:  number;
  totalOutputTokens: number;
  totalCostUsd:      number;
  totalToolCalls:    number;
  model:             string | null;
  gitBranch:         string | null;
  gitCommitBefore:   string | null;
  gitCommitAfter:    string | null;
  filesModifiedCount: number;
}

interface ToolCallRow {
  id:           string;
  toolName:     string;
  filePath:     string | null;
  durationMs:   number | null;
  isError:      boolean;
  errorMessage: string | null;
  exitCode:     number | null;
  inputTokens:  number | null;
  outputTokens: number | null;
  costUsd:      number | null;
  timestamp:    string;
  truncated:    boolean;
  inputJson?:   unknown;
  outputJson?:  unknown;
}

interface FileDiffRow {
  id:           string;
  filePath:     string;
  linesAdded:   number | null;
  linesRemoved: number | null;
  truncated:    boolean;
  toolCallId:   string | null;
  timestamp:    string;
}

interface FileDiffDetail extends FileDiffRow {
  diffContent: string | null;
}

// ── SSE ───────────────────────────────────────────────────────────────────────

interface SessionCostUpdatedEvent {
  sessionId:      string;
  totalCostUsd:   number;
  totalToolCalls: number;
  latestToolName: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.001) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}

// Parse unified diff into coloured lines
function parseDiff(diff: string): Array<{ type: 'add' | 'remove' | 'context' | 'header'; text: string }> {
  return diff.split('\n').map((line) => {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') || line.startsWith('diff ')) {
      return { type: 'header' as const, text: line };
    }
    if (line.startsWith('+')) return { type: 'add' as const, text: line };
    if (line.startsWith('-')) return { type: 'remove' as const, text: line };
    return { type: 'context' as const, text: line };
  });
}

// ── Component ─────────────────────────────────────────────────────────────────

interface SessionDetailProps {
  sessionId: string;
}

export function SessionDetail({ sessionId }: SessionDetailProps): JSX.Element {
  const [session, setSession] = useState<AgentSession | null>(null);
  const [toolCallRows, setToolCallRows] = useState<ToolCallRow[]>([]);
  const [diffRows, setDiffRows] = useState<FileDiffRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedToolCall, setExpandedToolCall] = useState<string | null>(null);
  const [expandedToolCallData, setExpandedToolCallData] = useState<{ inputJson?: unknown; outputJson?: unknown } | null>(null);
  const [selectedDiffId, setSelectedDiffId] = useState<string | null>(null);
  const [selectedDiff, setSelectedDiff] = useState<FileDiffDetail | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  // ── Fetch session data ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    const fetchAll = async () => {
      setLoading(true);
      try {
        const [sess, toolCalls, diffs] = await Promise.all([
          apiFetch<AgentSession>(`/api/sessions/${sessionId}`),
          apiFetch<{ toolCalls: ToolCallRow[] }>(`/api/sessions/${sessionId}/tool-calls`),
          apiFetch<{ fileDiffs: FileDiffRow[] }>(`/api/sessions/${sessionId}/file-diffs`),
        ]);
        if (cancelled) return;
        setSession(sess);
        setToolCallRows(toolCalls.toolCalls);
        setDiffRows(diffs.fileDiffs);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load session');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void fetchAll();
    return () => { cancelled = true; };
  }, [sessionId]);

  // ── SSE for active sessions ─────────────────────────────────────────────────
  useEffect(() => {
    if (session?.status !== 'active') return;

    const es = new EventSource(`${API_BASE}/api/notifications/stream`, {
      withCredentials: true,
    } as EventSourceInit);
    esRef.current = es;

    const handleCostUpdated = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data as string) as SessionCostUpdatedEvent;
        if (data.sessionId !== sessionId) return;

        // Update session cost + tool count
        setSession((prev) =>
          prev
            ? { ...prev, totalCostUsd: data.totalCostUsd, totalToolCalls: data.totalToolCalls }
            : prev,
        );

        // Append new tool call row (minimal data — no IO)
        const newRow: ToolCallRow = {
          id:           `live-${Date.now()}`,
          toolName:     data.latestToolName,
          filePath:     null,
          durationMs:   null,
          isError:      false,
          errorMessage: null,
          exitCode:     null,
          inputTokens:  null,
          outputTokens: null,
          costUsd:      null,
          timestamp:    new Date().toISOString(),
          truncated:    false,
        };
        setToolCallRows((prev) => [...prev, newRow]);
      } catch { /* ignore */ }
    };

    es.addEventListener('session_cost_updated', handleCostUpdated);

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [session?.status, sessionId]);

  // ── Expand tool call with IO ────────────────────────────────────────────────
  const handleExpandToolCall = useCallback(async (id: string) => {
    if (expandedToolCall === id) {
      setExpandedToolCall(null);
      setExpandedToolCallData(null);
      return;
    }

    setExpandedToolCall(id);
    try {
      const data = await apiFetch<{ toolCalls: ToolCallRow[] }>(
        `/api/sessions/${sessionId}/tool-calls?include_io=true&limit=500`,
      );
      const row = data.toolCalls.find((tc) => tc.id === id);
      if (row) {
        setExpandedToolCallData({ inputJson: row.inputJson, outputJson: row.outputJson });
      }
    } catch { /* show what we have */ }
  }, [expandedToolCall, sessionId]);

  // ── Load diff content ───────────────────────────────────────────────────────
  const handleSelectDiff = useCallback(async (diffId: string) => {
    if (selectedDiffId === diffId) {
      setSelectedDiffId(null);
      setSelectedDiff(null);
      return;
    }
    setSelectedDiffId(diffId);
    setLoadingDiff(true);
    try {
      const diff = await apiFetch<FileDiffDetail>(`/api/sessions/${sessionId}/file-diffs/${diffId}`);
      setSelectedDiff(diff);
    } catch { /* show error */ } finally {
      setLoadingDiff(false);
    }
  }, [selectedDiffId, sessionId]);

  // ── Export ──────────────────────────────────────────────────────────────────
  const [exportOpen, setExportOpen] = useState(false);

  const handleExport = useCallback((format: 'md' | 'json' | 'csv') => {
    const suffix = format === 'md' ? '' : `?format=${format}`;
    window.location.href = `${API_BASE}/api/sessions/${sessionId}/export${suffix}`;
    setExportOpen(false);
  }, [sessionId]);

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loading) {
    return <div style={{ padding: '40px', color: 'var(--ink-muted)', fontSize: '13px' }}>Loading session…</div>;
  }

  if (error || !session) {
    return (
      <div style={{ padding: '40px', color: '#f87171', fontSize: '13px' }}>
        {error ?? 'Session not found'}
      </div>
    );
  }

  return (
    // TODO: Claude Design — three-panel layout
    <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr 300px', gap: '16px', padding: '24px', height: 'calc(100vh - 80px)', overflow: 'hidden' }}>

      {/* LEFT PANEL — session metadata */}
      <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {/* TODO: Claude Design */}
        <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '12px', padding: '16px' }}>
          <h2 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--ink)', marginBottom: '12px' }}>Session</h2>
          <MetaRow label="ID"         value={session.id.slice(0, 12) + '…'} mono />
          <MetaRow label="Status"     value={session.status} />
          <MetaRow label="Developer"  value={session.developerId} />
          <MetaRow label="Agent"      value={session.agent} />
          {session.taskTitle && <MetaRow label="Task" value={session.taskTitle} />}
          <MetaRow label="Started"    value={new Date(session.startedAt).toLocaleString()} />
          {session.endedAt && <MetaRow label="Ended" value={new Date(session.endedAt).toLocaleString()} />}
          {session.model && <MetaRow label="Model" value={session.model} mono />}
          {session.gitBranch && <MetaRow label="Branch" value={session.gitBranch} mono />}
        </div>

        <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '12px', padding: '16px' }}>
          <h2 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--ink)', marginBottom: '12px' }}>Stats</h2>
          <MetaRow label="Cost"         value={formatCost(session.totalCostUsd)} mono />
          <MetaRow label="Tool calls"   value={String(session.totalToolCalls)} />
          <MetaRow label="Files changed" value={String(session.filesModifiedCount)} />
          <MetaRow label="Tokens in"    value={session.totalInputTokens.toLocaleString()} />
          <MetaRow label="Tokens out"   value={session.totalOutputTokens.toLocaleString()} />
        </div>

        <div style={{ position: 'relative' }}>
          <button
            onClick={() => { setExportOpen((v) => !v); }}
            style={{ padding: '8px 14px', fontSize: '12px', background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.4)', borderRadius: '8px', color: '#a5b4fc', cursor: 'pointer', width: '100%' }}
          >
            ↓ Export ▾
          </button>
          {exportOpen && (
            <div
              style={{
                position: 'absolute', left: 0, bottom: '110%', zIndex: 10,
                background: 'var(--surface-elevated, #161616)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '8px', overflow: 'hidden',
                minWidth: '160px',
                boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
              }}
            >
              {[
                { fmt: 'md' as const,   label: 'Markdown (.md)' },
                { fmt: 'json' as const, label: 'JSON (.json)' },
                { fmt: 'csv' as const,  label: 'CSV (.csv)' },
              ].map(({ fmt, label }) => (
                <button
                  key={fmt}
                  onClick={() => { handleExport(fmt); }}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    padding: '8px 14px', fontSize: '12px',
                    background: 'transparent', border: 'none',
                    color: 'var(--text-secondary)', cursor: 'pointer',
                  }}
                  onMouseOver={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
                  onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* CENTRE PANEL — tool call timeline */}
      <div style={{ overflowY: 'auto' }}>
        <h2 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--ink)', marginBottom: '12px' }}>Timeline</h2>
        {toolCallRows.length === 0 && (
          <div style={{ color: 'var(--ink-muted)', fontSize: '13px' }}>No tool calls yet.</div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {toolCallRows.map((tc) => (
            <ToolCallEntry
              key={tc.id}
              tc={tc}
              expanded={expandedToolCall === tc.id}
              expandedData={expandedToolCall === tc.id ? expandedToolCallData : null}
              onToggle={() => void handleExpandToolCall(tc.id)}
            />
          ))}
        </div>
      </div>

      {/* RIGHT PANEL — file diffs */}
      <div style={{ overflowY: 'auto' }}>
        <h2 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--ink)', marginBottom: '12px' }}>Files changed</h2>
        {diffRows.length === 0 && (
          <div style={{ color: 'var(--ink-muted)', fontSize: '13px' }}>No file changes recorded.</div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {diffRows.map((d) => (
            <div key={d.id}>
              <div
                onClick={() => void handleSelectDiff(d.id)}
                style={{
                  padding: '8px 10px',
                  background: selectedDiffId === d.id ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${selectedDiffId === d.id ? 'rgba(99,102,241,0.4)' : 'rgba(255,255,255,0.06)'}`,
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '12px',
                }}
              >
                <div style={{ fontFamily: 'var(--mono)', color: 'var(--ink)', fontSize: '11px', wordBreak: 'break-all' }}>{d.filePath}</div>
                <div style={{ color: 'var(--ink-muted)', marginTop: '2px' }}>
                  <span style={{ color: '#22c55e' }}>+{d.linesAdded ?? 0}</span>
                  {' / '}
                  <span style={{ color: '#ef4444' }}>-{d.linesRemoved ?? 0}</span>
                  {d.truncated && <span style={{ color: '#f59e0b', marginLeft: '6px' }}>(truncated)</span>}
                </div>
              </div>

              {selectedDiffId === d.id && (
                <div style={{ marginTop: '4px', borderRadius: '6px', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.06)' }}>
                  {loadingDiff && (
                    <div style={{ padding: '8px', fontSize: '12px', color: 'var(--ink-muted)' }}>Loading diff…</div>
                  )}
                  {!loadingDiff && selectedDiff?.diffContent && (
                    <DiffViewer
                      diff={selectedDiff.diffContent}
                      truncated={selectedDiff.truncated}
                    />
                  )}
                  {!loadingDiff && !selectedDiff?.diffContent && (
                    <div style={{ padding: '8px', fontSize: '12px', color: 'var(--ink-muted)' }}>No diff content available.</div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── MetaRow ───────────────────────────────────────────────────────────────────

function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: '12px' }}>
      <span style={{ color: 'var(--ink-muted)' }}>{label}</span>
      <span style={{ color: 'var(--ink)', fontFamily: mono ? 'var(--mono)' : undefined, textAlign: 'right', maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {value}
      </span>
    </div>
  );
}

// ── ToolCallEntry ─────────────────────────────────────────────────────────────

function ToolCallEntry({
  tc,
  expanded,
  expandedData,
  onToggle,
}: {
  tc:           ToolCallRow;
  expanded:     boolean;
  expandedData: { inputJson?: unknown; outputJson?: unknown } | null;
  onToggle:     () => void;
}): JSX.Element {
  const isMilestone = tc.toolName === '_milestone';
  const milestoneMsg = isMilestone && tc.inputJson && typeof tc.inputJson === 'object'
    ? (tc.inputJson as Record<string, unknown>).message as string
    : null;

  if (isMilestone) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', color: '#a78bfa', fontSize: '12px' }}>
        {/* TODO: Claude Design — milestone divider */}
        <div style={{ height: '1px', flex: 1, background: 'rgba(167,139,250,0.3)' }} />
        <span>🏁 {milestoneMsg ?? 'Milestone'}</span>
        <div style={{ height: '1px', flex: 1, background: 'rgba(167,139,250,0.3)' }} />
      </div>
    );
  }

  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: `1px solid ${tc.isError ? 'rgba(239,68,68,0.3)' : 'rgba(255,255,255,0.06)'}`,
        borderRadius: '6px',
        overflow: 'hidden',
      }}
    >
      <div
        onClick={onToggle}
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 60px 70px 70px',
          gap: '8px',
          padding: '8px 10px',
          cursor: 'pointer',
          fontSize: '12px',
          alignItems: 'center',
        }}
      >
        {/* Tool name + file */}
        <div>
          <span style={{ fontWeight: 600, color: tc.isError ? '#f87171' : 'var(--ink)' }}>
            {tc.toolName}
          </span>
          {tc.filePath && (
            <span style={{ color: 'var(--ink-muted)', marginLeft: '6px', fontFamily: 'var(--mono)', fontSize: '11px' }}>
              {tc.filePath.split('/').pop()}
            </span>
          )}
        </div>

        {/* Duration */}
        <span style={{ color: 'var(--ink-muted)', textAlign: 'right' }}>
          {tc.durationMs !== null ? `${tc.durationMs}ms` : '—'}
        </span>

        {/* Tokens */}
        <span style={{ color: 'var(--ink-muted)', textAlign: 'right', fontFamily: 'var(--mono)' }}>
          {tc.inputTokens !== null ? tc.inputTokens.toLocaleString() : '—'}
        </span>

        {/* Cost */}
        <span style={{ color: tc.costUsd ? '#a78bfa' : 'var(--ink-muted)', textAlign: 'right', fontFamily: 'var(--mono)' }}>
          {tc.costUsd !== null ? `$${tc.costUsd.toFixed(5)}` : '—'}
        </span>
      </div>

      {/* Expanded IO */}
      {expanded && (
        <div style={{ padding: '8px 10px', borderTop: '1px solid rgba(255,255,255,0.06)', fontSize: '11px', fontFamily: 'var(--mono)', background: 'rgba(0,0,0,0.2)' }}>
          {expandedData ? (
            <>
              {expandedData.inputJson !== undefined && (
                <div>
                  <div style={{ color: 'var(--ink-muted)', marginBottom: '4px' }}>INPUT</div>
                  <pre style={{ color: 'var(--ink)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }}>
                    {JSON.stringify(expandedData.inputJson, null, 2)}
                  </pre>
                </div>
              )}
              {expandedData.outputJson !== undefined && (
                <div style={{ marginTop: '8px' }}>
                  <div style={{ color: 'var(--ink-muted)', marginBottom: '4px' }}>OUTPUT</div>
                  <pre style={{ color: 'var(--ink)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }}>
                    {JSON.stringify(expandedData.outputJson, null, 2)}
                  </pre>
                </div>
              )}
            </>
          ) : (
            <div style={{ color: 'var(--ink-muted)' }}>Loading IO data…</div>
          )}
          {tc.errorMessage && (
            <div style={{ marginTop: '8px', color: '#f87171' }}>
              <div style={{ marginBottom: '4px' }}>ERROR</div>
              <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{tc.errorMessage}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── DiffViewer ────────────────────────────────────────────────────────────────

function DiffViewer({ diff, truncated }: { diff: string; truncated: boolean }): JSX.Element {
  const lines = parseDiff(diff);

  const lineStyle: Record<string, React.CSSProperties> = {
    add:     { background: 'rgba(34,197,94,0.1)', color: '#86efac' },
    remove:  { background: 'rgba(239,68,68,0.1)', color: '#fca5a5' },
    context: { color: 'var(--ink-muted)' },
    header:  { color: '#6366f1', background: 'rgba(99,102,241,0.08)' },
  };

  return (
    <div style={{ background: 'rgba(0,0,0,0.3)', fontSize: '11px', fontFamily: 'var(--mono)', maxHeight: '400px', overflowY: 'auto' }}>
      {truncated && (
        <div style={{ padding: '4px 8px', background: 'rgba(245,158,11,0.15)', color: '#fbbf24', fontSize: '11px' }}>
          ⚠ Diff truncated at 100KB
        </div>
      )}
      {lines.map((line, i) => (
        <div key={i} style={{ padding: '1px 8px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', ...lineStyle[line.type] }}>
          {line.text || ' '}
        </div>
      ))}
    </div>
  );
}

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

interface SessionSummary {
  id:             string;
  status:         string;
  developerId:    string;
  agent:          string;
  taskId:         string | null;
  taskTitle:      string | null;
  totalCostUsd:   number;
  totalToolCalls: number;
  durationMs:     number | null;
  model:          string | null;
  gitBranch:      string | null;
  startedAt:      string;
  endedAt:        string | null;
}

interface SessionsResponse {
  sessions:    SessionSummary[];
  next_cursor: string | null;
  totals: {
    count:        number;
    totalCostUsd: number;
  };
}

interface Filters {
  status:      string;
  developerId: string;
  agent:       string;
  from:        string;
  to:          string;
}

// ── SSE event types ───────────────────────────────────────────────────────────

interface SessionStartedEvent {
  sessionId:   string;
  developerId: string;
  agent:       string;
  taskId?:     string;
}

interface SessionEndedEvent {
  sessionId:    string;
  totalCostUsd: number;
  status:       string;
}

interface SessionCostUpdatedEvent {
  sessionId:      string;
  developerId:    string;
  totalCostUsd:   number;
  totalToolCalls: number;
  latestToolName: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.001) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}

function buildQueryString(filters: Filters, cursor: string | null): string {
  const params = new URLSearchParams();
  if (filters.status)      params.set('status', filters.status);
  if (filters.developerId) params.set('developerId', filters.developerId);
  if (filters.agent)       params.set('agent', filters.agent);
  if (filters.from)        params.set('from', filters.from);
  if (filters.to)          params.set('to', filters.to);
  if (cursor)              params.set('cursor', cursor);
  params.set('limit', '20');
  return params.toString() ? `?${params.toString()}` : '';
}

// ── Component ─────────────────────────────────────────────────────────────────

interface SessionsListProps {
  workspaceId: string;
}

export function SessionsList({ workspaceId }: SessionsListProps): JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [totals, setTotals] = useState<{ count: number; totalCostUsd: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>({
    status:      '',
    developerId: '',
    agent:       '',
    from:        '',
    to:          '',
  });

  const esRef = useRef<EventSource | null>(null);

  // ── Fetch sessions ──────────────────────────────────────────────────────────
  const fetchSessions = useCallback(async (f: Filters, cursor: string | null = null) => {
    const qs = buildQueryString(f, cursor);
    if (!cursor) setLoading(true);
    else setLoadingMore(true);

    try {
      const data = await apiFetch<SessionsResponse>(`/api/sessions${qs}`);
      if (cursor) {
        setSessions((prev) => [...prev, ...data.sessions]);
      } else {
        setSessions(data.sessions);
        setTotals(data.totals);
      }
      setNextCursor(data.next_cursor);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    void fetchSessions(filters);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Refetch on filter change
  const handleFilterChange = useCallback(
    (key: keyof Filters, value: string) => {
      const next = { ...filters, [key]: value };
      setFilters(next);
      setNextCursor(null);
      void fetchSessions(next);
    },
    [filters, fetchSessions],
  );

  // ── SSE subscription ────────────────────────────────────────────────────────
  useEffect(() => {
    const es = new EventSource(`${API_BASE}/api/notifications/stream`, {
      withCredentials: true,
    } as EventSourceInit);
    esRef.current = es;

    const handleSessionStarted = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data as string) as SessionStartedEvent;
        // Prepend new session stub to list
        const newSession: SessionSummary = {
          id:             data.sessionId,
          status:         'active',
          developerId:    data.developerId,
          agent:          data.agent,
          taskId:         data.taskId ?? null,
          taskTitle:      null,
          totalCostUsd:   0,
          totalToolCalls: 0,
          durationMs:     null,
          model:          null,
          gitBranch:      null,
          startedAt:      new Date().toISOString(),
          endedAt:        null,
        };
        setSessions((prev) => [newSession, ...prev]);
        setTotals((prev) => prev ? { ...prev, count: prev.count + 1 } : null);
      } catch { /* ignore parse errors */ }
    };

    const handleSessionEnded = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data as string) as SessionEndedEvent;
        setSessions((prev) =>
          prev.map((s) =>
            s.id === data.sessionId
              ? { ...s, status: data.status, totalCostUsd: data.totalCostUsd, endedAt: new Date().toISOString() }
              : s,
          ),
        );
      } catch { /* ignore */ }
    };

    const handleCostUpdated = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data as string) as SessionCostUpdatedEvent;
        setSessions((prev) =>
          prev.map((s) =>
            s.id === data.sessionId
              ? { ...s, totalCostUsd: data.totalCostUsd, totalToolCalls: data.totalToolCalls }
              : s,
          ),
        );
        setTotals((prev) =>
          prev ? { ...prev, totalCostUsd: prev.totalCostUsd + (data.totalCostUsd - 0) } : null,
        );
      } catch { /* ignore */ }
    };

    es.addEventListener('session_started', handleSessionStarted);
    es.addEventListener('session_ended', handleSessionEnded);
    es.addEventListener('session_cost_updated', handleCostUpdated);

    return () => {
      es.close();
      esRef.current = null;
    };
  }, []);

  // ── Load more ───────────────────────────────────────────────────────────────
  const loadMore = () => {
    if (nextCursor && !loadingMore) {
      void fetchSessions(filters, nextCursor);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: '24px' }}>
      {/* TODO: Claude Design — header with Mnema design tokens */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h1 style={{ fontSize: '18px', fontWeight: 600, color: 'var(--ink)' }}>Sessions</h1>
        {totals && (
          <span style={{ fontSize: '13px', color: 'var(--ink-muted)' }}>
            {totals.count} sessions · {formatCost(totals.totalCostUsd)} total
          </span>
        )}
      </div>

      {/* Filters */}
      {/* TODO: Claude Design — filter bar styling */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <select
          value={filters.status}
          onChange={(e) => handleFilterChange('status', e.target.value)}
          style={{ fontSize: '12px', padding: '4px 8px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--ink)' }}
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
        </select>

        <select
          value={filters.agent}
          onChange={(e) => handleFilterChange('agent', e.target.value)}
          style={{ fontSize: '12px', padding: '4px 8px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--ink)' }}
        >
          <option value="">All agents</option>
          <option value="claude_code">Claude Code</option>
          <option value="cursor">Cursor</option>
          <option value="aider">Aider</option>
        </select>

        <input
          type="text"
          placeholder="Developer ID"
          value={filters.developerId}
          onChange={(e) => handleFilterChange('developerId', e.target.value)}
          style={{ fontSize: '12px', padding: '4px 8px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--ink)', width: '140px' }}
        />

        <input
          type="date"
          value={filters.from}
          onChange={(e) => handleFilterChange('from', e.target.value)}
          style={{ fontSize: '12px', padding: '4px 8px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--ink)' }}
        />

        <input
          type="date"
          value={filters.to}
          onChange={(e) => handleFilterChange('to', e.target.value)}
          style={{ fontSize: '12px', padding: '4px 8px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--ink)' }}
        />
      </div>

      {/* Error */}
      {error && (
        <div style={{ padding: '12px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '8px', color: '#f87171', fontSize: '13px', marginBottom: '12px' }}>
          {error}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div style={{ color: 'var(--ink-muted)', fontSize: '13px', padding: '24px 0' }}>
          Loading sessions…
        </div>
      )}

      {/* Sessions table */}
      {/* TODO: Claude Design — table/card design */}
      {!loading && sessions.length === 0 && (
        <div style={{ color: 'var(--ink-muted)', fontSize: '13px', padding: '24px 0' }}>
          No sessions found.
        </div>
      )}

      {!loading && sessions.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {sessions.map((session) => (
            <SessionRow key={session.id} session={session} />
          ))}
        </div>
      )}

      {/* Load more */}
      {nextCursor && (
        <button
          onClick={loadMore}
          disabled={loadingMore}
          style={{ marginTop: '16px', padding: '8px 16px', fontSize: '13px', background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--ink)', cursor: loadingMore ? 'wait' : 'pointer' }}
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}

// ── Session row ───────────────────────────────────────────────────────────────

function SessionRow({ session }: { session: SessionSummary }): JSX.Element {
  const statusColor: Record<string, string> = {
    active:    '#22c55e',
    completed: '#6b7280',
    failed:    '#ef4444',
    stalled:   '#f59e0b',
  };

  const handleClick = () => {
    window.location.href = `/app/sessions/${session.id}`;
  };

  return (
    // TODO: Claude Design — row styling
    <div
      onClick={handleClick}
      style={{
        display: 'grid',
        gridTemplateColumns: '20px 1fr 120px 90px 70px 80px',
        gap: '12px',
        alignItems: 'center',
        padding: '10px 14px',
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: '8px',
        cursor: 'pointer',
        fontSize: '13px',
        color: 'var(--ink)',
      }}
    >
      {/* Status dot */}
      <span
        style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: statusColor[session.status] ?? '#6b7280',
          display: 'inline-block',
          flexShrink: 0,
        }}
      />

      {/* Session info */}
      <div>
        <div style={{ fontSize: '12px', fontFamily: 'var(--mono)', color: 'var(--ink-muted)' }}>
          {session.id.slice(0, 8)}
          {session.gitBranch && (
            <span style={{ marginLeft: '8px', color: '#6366f1' }}>{session.gitBranch}</span>
          )}
        </div>
        <div style={{ fontSize: '12px', color: 'var(--ink-muted)', marginTop: '2px' }}>
          {session.developerId} · {session.agent}
          {session.taskTitle && <span> · {session.taskTitle}</span>}
        </div>
      </div>

      {/* Started at */}
      <span style={{ fontSize: '12px', color: 'var(--ink-muted)' }}>
        {new Date(session.startedAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
      </span>

      {/* Duration */}
      <span style={{ fontSize: '12px', color: 'var(--ink-muted)', textAlign: 'right' }}>
        {formatDuration(session.durationMs)}
      </span>

      {/* Tool calls */}
      <span style={{ fontSize: '12px', color: 'var(--ink-muted)', textAlign: 'right' }}>
        {session.totalToolCalls} calls
      </span>

      {/* Cost */}
      <span style={{ fontSize: '12px', color: session.totalCostUsd > 0 ? '#a78bfa' : 'var(--ink-muted)', textAlign: 'right', fontFamily: 'var(--mono)' }}>
        {formatCost(session.totalCostUsd)}
      </span>
    </div>
  );
}

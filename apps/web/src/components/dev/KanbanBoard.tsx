// DESIGN APPLIED: 2026-05-27

import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import { T } from '../../lib/dev-tokens';
import { AddTaskModal } from './AddTaskModal';
import { DevSetupBanner } from './DevSetupBanner';
import { KanbanColumn } from './KanbanColumn';
import type { Task } from './TaskCard';

interface KanbanBoardProps {
  workspaceId: string;
}

interface DevConfig {
  mode: string;
  hookTokenSet: boolean;
  hookReceiverUrl: string;
  mcpConfigSnippet: string;
  installCommand: string;
}

// Map column id → transition endpoint segment (POST /api/tasks/:id/<segment>)
const STATUS_TRANSITION: Record<string, string | null> = {
  backlog:     'reopen',   // reopen is for done/audit_fix → backlog
  in_progress: 'start',
  review:      'review',
  audit_fix:   'block',
  done:        'complete',
};

// For tasks moving from in_progress to backlog (no standard transition — just reopen if needed)
// We track source status to determine the right endpoint
function resolveTransitionEndpoint(
  fromStatus: string,
  toStatus: string,
): string | null {
  if (fromStatus === toStatus) return null;
  if (toStatus === 'in_progress') return 'start';
  if (toStatus === 'review')      return 'review';
  if (toStatus === 'done')        return 'complete';
  if (toStatus === 'audit_fix')   return 'block';
  if (toStatus === 'backlog')     return 'reopen';
  return null;
}

const COLUMNS: { id: string; label: string; color: string }[] = [
  { id: 'backlog',     label: 'Backlog',     color: T.textMuted },
  { id: 'in_progress', label: 'In Progress', color: T.amber },
  { id: 'review',      label: 'Review',      color: T.violet },
  { id: 'audit_fix',   label: 'Audit / Fix', color: T.red },
  { id: 'done',        label: 'Done',        color: T.green },
];

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

export function KanbanBoard({ workspaceId }: KanbanBoardProps): JSX.Element {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [devConfig, setDevConfig] = useState<DevConfig | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const sseRef = useRef<EventSource | null>(null);

  // Check if banner was previously dismissed
  useEffect(() => {
    const dismissed = localStorage.getItem(`mnema_setup_banner_${workspaceId}`);
    if (dismissed === 'dismissed') setBannerDismissed(true);
  }, [workspaceId]);

  // Fetch tasks
  const fetchTasks = useCallback(async () => {
    try {
      const data = await apiFetch<{ tasks: Task[] }>('/api/tasks');
      setTasks(data.tasks);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch dev config (for setup banner)
  useEffect(() => {
    void apiFetch<DevConfig>(`/api/workspaces/${workspaceId}/dev-config`)
      .then(setDevConfig)
      .catch(() => { /* ignore */ });
  }, [workspaceId]);

  // Load tasks on mount
  useEffect(() => {
    void fetchTasks();
  }, [fetchTasks]);

  // SSE: subscribe to task_updated events
  useEffect(() => {
    const es = new EventSource(`${API_BASE}/api/notifications/stream`, {
      withCredentials: true,
    });

    es.addEventListener('task_updated', (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data as string) as { task: Task };
        setTasks((prev) => {
          const idx = prev.findIndex((t) => t.id === payload.task.id);
          if (idx === -1) return [...prev, payload.task];
          const next = [...prev];
          next[idx] = payload.task;
          return next;
        });
      } catch {
        /* malformed event */
      }
    });

    es.onerror = () => {
      // EventSource auto-reconnects; just log silently
    };

    sseRef.current = es;
    return () => {
      es.close();
      sseRef.current = null;
    };
  }, [workspaceId]);

  // Group tasks by status, sorted by boardOrder
  const tasksByStatus = COLUMNS.reduce<Record<string, Task[]>>((acc, col) => {
    acc[col.id] = tasks
      .filter((t) => t.status === col.id)
      .sort((a, b) => a.boardOrder - b.boardOrder);
    return acc;
  }, {});

  // Handle drop between / within columns
  const handleTaskDrop = useCallback(
    async (taskId: string, targetStatus: string, targetIndex: number) => {
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return;

      const fromStatus = task.status;

      if (fromStatus === targetStatus) {
        // Reorder within the same column
        const colTasks = tasksByStatus[targetStatus] ?? [];
        const oldIdx = colTasks.findIndex((t) => t.id === taskId);
        if (oldIdx === targetIndex) return;

        // Optimistic update
        setTasks((prev) => {
          const withoutTask = prev.filter((t) => t.id !== taskId);
          const colWithout = withoutTask.filter((t) => t.status === targetStatus).sort((a, b) => a.boardOrder - b.boardOrder);
          colWithout.splice(targetIndex, 0, task);
          const reordered = colWithout.map((t, i) => ({ ...t, boardOrder: i }));
          return [
            ...withoutTask.filter((t) => t.status !== targetStatus),
            ...reordered,
          ];
        });

        try {
          const colTasks2 = [...(tasksByStatus[targetStatus] ?? [])].filter((t) => t.id !== taskId);
          colTasks2.splice(targetIndex, 0, task);
          await apiFetch('/api/tasks/reorder', {
            method: 'PATCH',
            body: JSON.stringify({
              taskIds: colTasks2.map((t) => t.id),
              status: targetStatus,
            }),
          });
        } catch {
          void fetchTasks(); // revert on error
        }
        return;
      }

      // Transition to different column
      const endpoint = resolveTransitionEndpoint(fromStatus, targetStatus);
      if (!endpoint) return;

      // Optimistic update
      setTasks((prev) =>
        prev.map((t) => (t.id === taskId ? { ...t, status: targetStatus } : t)),
      );

      try {
        // For 'block', we need a blockerDescription — use a default if none
        const body =
          endpoint === 'block'
            ? JSON.stringify({ blockerDescription: 'Needs attention' })
            : undefined;

        await apiFetch(`/api/tasks/${taskId}/${endpoint}`, {
          method: 'POST',
          body,
        });
      } catch {
        void fetchTasks(); // revert on error
      }
    },
    [tasks, tasksByStatus, fetchTasks],
  );

  // Add task to backlog
  const handleAddTask = useCallback(
    async (title: string, description?: string, priority?: string) => {
      await apiFetch('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ title, description, priority: priority ?? 'medium' }),
      });
      await fetchTasks();
    },
    [fetchTasks],
  );

  const showBanner =
    devConfig !== null &&
    !devConfig.hookTokenSet &&
    !bannerDismissed &&
    devConfig.installCommand !== undefined;

  if (loading) {
    return (
      <div style={{
        padding:    40,
        color:      T.textMuted,
        fontSize:   13,
        fontFamily: T.fontUI,
        background: T.bg,
        height:     '100%',
        boxSizing:  'border-box',
      }}>
        Loading tasks…
      </div>
    );
  }

  if (error) {
    return (
      <div style={{
        padding:    40,
        background: T.bg,
        height:     '100%',
        boxSizing:  'border-box',
        fontFamily: T.fontUI,
      }}>
        <p style={{ color: T.red, fontSize: 13, marginBottom: 12 }}>{error}</p>
        <button
          onClick={() => { void fetchTasks(); }}
          style={{
            padding:      '7px 16px',
            borderRadius: 8,
            border:       `0.5px solid ${T.glassBorder}`,
            background:   T.glass,
            color:        T.textSecondary,
            fontSize:     12,
            cursor:       'pointer',
            fontFamily:   T.fontUI,
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div style={{
      padding:    '24px 28px',
      height:     '100%',
      boxSizing:  'border-box',
      display:    'flex',
      flexDirection: 'column',
      background: T.bg,
      fontFamily: T.fontUI,
    }}>
      {/* Header */}
      <div style={{
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'space-between',
        marginBottom:   24,
      }}>
        <div>
          <h1 style={{
            margin:     0,
            fontSize:   20,
            fontWeight: 700,
            color:      T.textPrimary,
            fontFamily: T.fontDisplay,
            letterSpacing: '-0.02em',
          }}>
            Board
          </h1>
          <p style={{
            margin:   '3px 0 0',
            fontSize: 12,
            color:    T.textMuted,
          }}>
            {tasks.length} task{tasks.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button
          onClick={() => { setShowAddModal(true); }}
          style={{
            padding:      '7px 16px',
            borderRadius: 8,
            border:       'none',
            background:   T.accent,
            color:        '#0A0B0D',
            fontSize:     13,
            fontWeight:   600,
            cursor:       'pointer',
            fontFamily:   T.fontUI,
            letterSpacing: '-0.01em',
          }}
        >
          + Add task
        </button>
      </div>

      {/* Dev Setup Banner — shown if hook token not yet set */}
      {showBanner && devConfig && (
        <DevSetupBanner
          workspaceId={workspaceId}
          hookToken={devConfig.installCommand}   // placeholder — banner only shows pre-token-set
          onDismiss={() => { setBannerDismissed(true); }}
        />
      )}

      {/* Columns — grid scroll container */}
      <div style={{
        display:          'grid',
        gridAutoFlow:     'column',
        gridAutoColumns:  '280px',
        gap:              16,
        flex:             1,
        overflowX:        'auto',
        overflowY:        'hidden',
        paddingBottom:    8,
        alignItems:       'start',
      }}>
        {COLUMNS.map((col) => (
          <KanbanColumn
            key={col.id}
            id={col.id}
            label={col.label}
            color={col.color}
            tasks={tasksByStatus[col.id] ?? []}
            onTaskDrop={handleTaskDrop}
            onAddTask={col.id === 'backlog' ? () => { setShowAddModal(true); } : undefined}
          />
        ))}
      </div>

      {/* Add Task Modal */}
      {showAddModal && (
        <AddTaskModal
          onAdd={handleAddTask}
          onClose={() => { setShowAddModal(false); }}
        />
      )}
    </div>
  );
}

// Keep STATUS_TRANSITION in scope to silence unused-var lint (it documents the mapping)
void STATUS_TRANSITION;

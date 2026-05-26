// TODO: Claude Design — apply Mnema glassmorphism design system
// Background: var(--bg) #0a0a0a
// Cards: rgba(255,255,255,0.04) + backdrop-filter: blur(24px)
// See BOPPL_Context_Engine_Prompt_UI_Redesign_All_MCP_Panels for token system

import type { JSX } from 'react';

export interface Task {
  id: string;
  workspaceId: string;
  docId: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  estimatedCostUsd: number | null;
  assignedMemberId: string | null;
  githubPrUrl: string | null;
  githubPrStatus: string | null;
  blockerDescription: string | null;
  retryCount: number;
  boardOrder: number;
  tags: string[] | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface TaskCardProps {
  task: Task;
  isDragging?: boolean;
}

const PRIORITY_COLORS: Record<string, string> = {
  critical: '#ef4444',
  high:     '#f97316',
  medium:   '#eab308',
  low:      '#6b7280',
};

export function TaskCard({ task, isDragging }: TaskCardProps): JSX.Element {
  const priorityColor = PRIORITY_COLORS[task.priority] ?? PRIORITY_COLORS.medium!;

  return (
    <div
      style={{
        background: isDragging ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 8,
        padding: '10px 12px',
        cursor: 'grab',
        opacity: isDragging ? 0.8 : 1,
        userSelect: 'none',
      }}
    >
      {/* Title */}
      <p style={{
        margin: 0,
        fontSize: 13,
        fontWeight: 500,
        color: 'var(--ink)',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      }}>
        {task.title}
      </p>

      {/* Meta row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        {/* Priority badge */}
        <span style={{
          fontSize: 10,
          fontWeight: 600,
          padding: '2px 6px',
          borderRadius: 4,
          background: `${priorityColor}22`,
          color: priorityColor,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}>
          {task.priority}
        </span>

        {/* Cost */}
        {task.estimatedCostUsd != null && (
          <span style={{ fontSize: 11, color: 'var(--ink-muted)' }}>
            ${task.estimatedCostUsd.toFixed(2)}
          </span>
        )}

        {/* Linked doc indicator */}
        {task.docId && (
          <span title="Linked doc" style={{ fontSize: 11 }}>📄</span>
        )}

        {/* PR link */}
        {task.githubPrUrl && (
          <a
            href={task.githubPrUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            style={{ fontSize: 11, color: 'var(--accent)', textDecoration: 'none' }}
            title="GitHub PR"
          >
            PR ↗
          </a>
        )}

        {/* Blocker badge */}
        {task.status === 'audit_fix' && task.blockerDescription && (
          <span title={task.blockerDescription} style={{ color: '#ef4444', fontSize: 13 }}>⚠</span>
        )}
      </div>

      {/* Tags */}
      {task.tags && task.tags.length > 0 && (
        <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
          {task.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              style={{
                fontSize: 10,
                padding: '1px 5px',
                borderRadius: 3,
                background: 'rgba(255,255,255,0.06)',
                color: 'var(--ink-muted)',
              }}
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// TODO: Claude Design — apply Mnema glassmorphism design system
// Background: var(--bg) #0a0a0a
// Cards: rgba(255,255,255,0.04) + backdrop-filter: blur(24px)
// See BOPPL_Context_Engine_Prompt_UI_Redesign_All_MCP_Panels for token system

import type { JSX } from 'react';
import { TaskCard, type Task } from './TaskCard';

interface KanbanColumnProps {
  id: string;
  label: string;
  color: string;
  tasks: Task[];
  onTaskDrop: (taskId: string, targetStatus: string, targetIndex: number) => void;
  onAddTask?: () => void;
}

export function KanbanColumn({
  id,
  label,
  color,
  tasks,
  onTaskDrop,
  onAddTask,
}: KanbanColumnProps): JSX.Element {
  function handleDragOver(e: React.DragEvent): void {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }

  function handleDrop(e: React.DragEvent): void {
    e.preventDefault();
    const taskId = e.dataTransfer.getData('text/plain');
    if (taskId) {
      onTaskDrop(taskId, id, tasks.length);
    }
  }

  return (
    <div
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      style={{
        flex: '0 0 220px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minHeight: 200,
      }}
    >
      {/* Column header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {label}
          </span>
          <span style={{ fontSize: 11, color: 'var(--ink-muted)' }}>{tasks.length}</span>
        </div>
        {id === 'backlog' && onAddTask && (
          <button
            onClick={onAddTask}
            style={{
              width: 20, height: 20, borderRadius: 4, border: '1px solid var(--line)',
              background: 'transparent', color: 'var(--ink-muted)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14,
            }}
            title="Add task"
          >
            +
          </button>
        )}
      </div>

      {/* Task cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
        {tasks.map((task) => (
          <div
            key={task.id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('text/plain', task.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
          >
            <TaskCard task={task} />
          </div>
        ))}

        {/* Drop zone hint when empty */}
        {tasks.length === 0 && (
          <div style={{
            border: '1px dashed rgba(255,255,255,0.1)',
            borderRadius: 8,
            padding: '16px 12px',
            textAlign: 'center',
            color: 'var(--ink-faint)',
            fontSize: 12,
          }}>
            Drop here
          </div>
        )}
      </div>
    </div>
  );
}

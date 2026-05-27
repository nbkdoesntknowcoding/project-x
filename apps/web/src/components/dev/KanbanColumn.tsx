// DESIGN APPLIED: 2026-05-27

import type { JSX } from 'react';
import { T } from '../../lib/dev-tokens';
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
        display:       'flex',
        flexDirection: 'column',
        minHeight:     200,
        fontFamily:    T.fontUI,
      }}
    >
      {/* Column header */}
      <div style={{
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'space-between',
        marginBottom:   12,
        paddingLeft:    2,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          {/* Colour dot */}
          <span style={{
            width:       7,
            height:      7,
            borderRadius: '50%',
            background:  color,
            flexShrink:  0,
            boxShadow:   `0 0 6px ${color}80`,
          }} />
          {/* Label */}
          <span style={{
            fontSize:      11,
            fontWeight:    600,
            color:         T.textSecondary,
            textTransform: 'uppercase',
            letterSpacing: '0.07em',
          }}>
            {label}
          </span>
          {/* Count */}
          <span style={{
            fontSize:     11,
            color:        T.textDisabled,
            fontFamily:   T.fontMono,
          }}>
            {tasks.length}
          </span>
        </div>

        {/* Add button — backlog only */}
        {id === 'backlog' && onAddTask && (
          <button
            onClick={onAddTask}
            style={{
              width:          22,
              height:         22,
              borderRadius:   6,
              border:         `0.5px solid ${T.glassBorder}`,
              background:     T.glass,
              color:          T.textMuted,
              cursor:         'pointer',
              display:        'flex',
              alignItems:     'center',
              justifyContent: 'center',
              fontSize:       16,
              lineHeight:     1,
              flexShrink:     0,
            }}
            title="Add task"
          >
            +
          </button>
        )}
      </div>

      {/* Task cards list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
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
            border:      `1px dashed ${T.glassBorder}`,
            borderRadius: 12,
            padding:     '18px 12px',
            textAlign:   'center',
            color:       T.textDisabled,
            fontSize:    12,
            background:  'rgba(255,255,255,0.01)',
          }}>
            Drop here
          </div>
        )}
      </div>
    </div>
  );
}

import { Handle, Position } from '@xyflow/react';
import type { ReactNode } from 'react';

interface Props {
  indicatorColor: string;
  kindLabel: string;
  title: string;
  children?: ReactNode;
  showInputHandle?: boolean;
  showOutputHandle?: boolean;
  selected?: boolean;
  isConnectable?: boolean;
}

export function NodeShell({
  indicatorColor,
  kindLabel,
  title,
  children,
  showInputHandle = true,
  showOutputHandle = true,
  selected = false,
  isConnectable = true,
}: Props) {
  return (
    <div
      className={
        'w-[280px] bg-[var(--surface-overlay)] border rounded-[var(--radius-md)] ' +
        'transition-[border-color] cursor-pointer ' +
        (selected
          ? 'border-[var(--text-primary)] [box-shadow:0_0_0_1px_var(--text-primary)]'
          : 'border-[var(--border-default)] hover:border-[var(--border-strong)]')
      }
    >
      {showInputHandle && (
        <Handle
          type="target"
          position={Position.Top}
          id="default"
          isConnectable={isConnectable}
          style={{
            background: 'var(--surface-overlay)',
            borderColor: 'var(--border-strong)',
            width: 8,
            height: 8,
          }}
        />
      )}

      <div className="px-3 py-2 flex items-center gap-2 border-b border-[var(--border-subtle)]">
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{ background: indicatorColor }}
        />
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
          {kindLabel}
        </span>
      </div>

      <div className="px-3 pt-2.5 pb-1">
        <h3 className="text-[13px] font-medium text-[var(--text-primary)] leading-[1.3]">
          {title}
        </h3>
      </div>

      <div className="px-3 pb-3">{children}</div>

      {showOutputHandle && (
        <Handle
          type="source"
          position={Position.Bottom}
          id="default"
          isConnectable={isConnectable}
          style={{
            background: 'var(--surface-overlay)',
            borderColor: 'var(--border-strong)',
            width: 8,
            height: 8,
          }}
        />
      )}
    </div>
  );
}

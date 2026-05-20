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
  const handleStyle: React.CSSProperties = selected
    ? {
        width: 9,
        height: 9,
        background: 'var(--accent-soft)',
        border: '1.5px solid var(--accent)',
        borderRadius: '50%',
      }
    : {
        width: 9,
        height: 9,
        background: 'var(--surface-2)',
        border: '1.5px solid var(--line-bright)',
        borderRadius: '50%',
      };

  return (
    <div
      style={{
        width: 280,
        background: 'var(--surface)',
        border: `1px solid ${selected ? 'var(--accent)' : 'var(--line)'}`,
        borderRadius: 10,
        cursor: 'pointer',
        transition: 'border-color 140ms ease, box-shadow 140ms ease',
        boxShadow: selected
          ? '0 0 0 3px var(--accent-soft), 0 12px 32px -12px rgba(var(--accent-rgb), 0.35)'
          : 'none',
      }}
    >
      {showInputHandle && (
        <Handle
          type="target"
          position={Position.Top}
          id="default"
          isConnectable={isConnectable}
          style={handleStyle}
        />
      )}

      {/* Kind header row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          padding: '10px 14px 7px',
          fontFamily: 'var(--mono)',
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--ink-muted)',
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            flexShrink: 0,
            background: indicatorColor,
            display: 'inline-block',
          }}
        />
        {kindLabel}
      </div>

      {/* Title */}
      <div
        style={{
          padding: '0 14px 7px',
          fontFamily: 'var(--sans)',
          fontSize: 13,
          fontWeight: 500,
          lineHeight: 1.35,
          color: 'var(--ink)',
        }}
      >
        {title}
      </div>

      {/* Body content */}
      {children && (
        <div style={{ padding: '0 14px 14px', fontFamily: 'var(--sans)' }}>
          {children}
        </div>
      )}

      {showOutputHandle && (
        <Handle
          type="source"
          position={Position.Bottom}
          id="default"
          isConnectable={isConnectable}
          style={handleStyle}
        />
      )}
    </div>
  );
}

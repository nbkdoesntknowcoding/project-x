// DESIGN APPLIED: 2026-05-27

import { type JSX, useEffect, useState } from 'react';
import { T, glassCard } from '../../lib/dev-tokens';
import type { Task } from './TaskCard';

interface TaskDetailModalProps {
  task: Task;
  onClose: () => void;
}

const PRIORITY_COLORS: Record<string, string> = {
  critical: T.critical,
  high:     T.high,
  medium:   T.medium,
  low:      T.low,
};

const PRIORITY_BG: Record<string, string> = {
  critical: 'rgba(239,68,68,0.10)',
  high:     'rgba(249,115,22,0.10)',
  medium:   'rgba(251,191,36,0.10)',
  low:      'rgba(161,161,170,0.10)',
};

export function TaskDetailModal({ task, onClose }: TaskDetailModalProps): JSX.Element {
  const [docTitle, setDocTitle] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const priorityColor = PRIORITY_COLORS[task.priority] ?? PRIORITY_COLORS.medium!;
  const priorityBg    = PRIORITY_BG[task.priority]    ?? PRIORITY_BG.medium!;
  const statusColors  = T.sbadge[task.status as keyof typeof T.sbadge] ?? T.sbadge.backlog;

  // Sprint tags vs other tags
  const sprintTag  = task.tags?.find((t) => t.startsWith('sprint:'));
  const sprintName = sprintTag ? sprintTag.slice('sprint:'.length) : null;
  const otherTags  = (task.tags ?? []).filter((t) => !t.startsWith('sprint:'));

  // Fetch source doc title when docId is present
  useEffect(() => {
    if (!task.docId) return;
    void fetch(`/api/docs/${task.docId}`, { credentials: 'include' })
      .then((r) => r.ok ? r.json() : null)
      .then((d: { title?: string } | null) => {
        if (d?.title) setDocTitle(d.title);
      })
      .catch(() => { /* best effort */ });
  }, [task.docId]);

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function copyId() {
    await navigator.clipboard.writeText(task.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    /* ── Backdrop ── */
    <div
      onClick={onClose}
      style={{
        position:   'fixed',
        inset:      0,
        background: 'rgba(0,0,0,0.72)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        zIndex:     1000,
        display:    'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding:    '24px 16px',
      }}
    >
      {/* ── Panel ── */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          ...glassCard,
          background:  T.surface1,
          border:      `0.5px solid ${T.glassBorderStrong}`,
          borderRadius: 20,
          width:       '100%',
          maxWidth:    640,
          maxHeight:   '88vh',
          display:     'flex',
          flexDirection: 'column',
          overflow:    'hidden',
          fontFamily:  T.fontUI,
          boxShadow:   '0 32px 80px rgba(0,0,0,0.6), 0 0 0 0.5px rgba(255,255,255,0.06)',
        }}
      >
        {/* ── Header ── */}
        <div style={{
          padding:        '20px 24px 16px',
          borderBottom:   `0.5px solid ${T.line}`,
          display:        'flex',
          alignItems:     'flex-start',
          gap:            12,
        }}>
          {/* Priority strip */}
          <div style={{
            width:        3,
            minHeight:    40,
            borderRadius: 2,
            background:   priorityColor,
            flexShrink:   0,
            marginTop:    3,
          }} />

          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Sprint breadcrumb */}
            {sprintName && (
              <div style={{
                fontSize:      10,
                fontWeight:    600,
                color:         T.accent,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                marginBottom:  6,
              }}>
                {sprintName}
              </div>
            )}

            {/* Title */}
            <h2 style={{
              margin:      0,
              fontSize:    17,
              fontWeight:  600,
              color:       T.textPrimary,
              lineHeight:  '1.35',
              wordBreak:   'break-word',
              fontFamily:  T.fontUI,
              letterSpacing: '-0.01em',
            }}>
              {task.title}
            </h2>

            {/* Meta row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
              {/* Status */}
              <span style={{
                display:      'inline-flex',
                alignItems:   'center',
                padding:      '2px 8px',
                borderRadius: 6,
                fontSize:     11,
                fontWeight:   500,
                background:   statusColors.bg,
                border:       `0.5px solid ${statusColors.border}`,
                color:        statusColors.text,
              }}>
                {task.status.replace('_', ' ')}
              </span>

              {/* Priority */}
              <span style={{
                display:      'inline-flex',
                alignItems:   'center',
                padding:      '2px 8px',
                borderRadius: 6,
                fontSize:     11,
                fontWeight:   500,
                background:   priorityBg,
                border:       `0.5px solid ${priorityColor}40`,
                color:        priorityColor,
              }}>
                {task.priority}
              </span>

              {/* Other tags */}
              {otherTags.map((tag) => (
                <span key={tag} style={{
                  fontSize:     10,
                  padding:      '2px 6px',
                  borderRadius: 4,
                  background:   T.glass,
                  border:       `0.5px solid ${T.glassBorder}`,
                  color:        T.textMuted,
                  fontFamily:   T.fontMono,
                }}>
                  {tag}
                </span>
              ))}

              {/* Task ID — click to copy */}
              <button
                onClick={() => { void copyId(); }}
                title="Copy task ID"
                style={{
                  marginLeft:   'auto',
                  background:   'none',
                  border:       'none',
                  padding:      0,
                  cursor:       'pointer',
                  fontSize:     10,
                  color:        copied ? T.green : T.textDisabled,
                  fontFamily:   T.fontMono,
                  lineHeight:   1,
                  transition:   'color 0.15s',
                }}
              >
                {copied ? 'copied!' : task.id.slice(0, 8) + '…'}
              </button>
            </div>
          </div>

          {/* Close button */}
          <button
            onClick={onClose}
            style={{
              width:        28,
              height:       28,
              borderRadius: 8,
              border:       `0.5px solid ${T.glassBorder}`,
              background:   T.glass,
              color:        T.textMuted,
              cursor:       'pointer',
              display:      'flex',
              alignItems:   'center',
              justifyContent: 'center',
              fontSize:     15,
              flexShrink:   0,
              fontFamily:   T.fontUI,
            }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* ── Body (scrollable) ── */}
        <div style={{
          flex:       1,
          overflowY:  'auto',
          padding:    '20px 24px',
          display:    'flex',
          flexDirection: 'column',
          gap:        20,
        }}>

          {/* Instructions / Description */}
          {task.description ? (
            <div>
              <div style={{
                fontSize:      10,
                fontWeight:    600,
                color:         T.textMuted,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                marginBottom:  10,
              }}>
                Instructions
              </div>
              <div style={{
                background:   T.surface2,
                border:       `0.5px solid ${T.glassBorder}`,
                borderRadius: 12,
                padding:      '14px 16px',
                fontSize:     13,
                color:        T.textSecondary,
                lineHeight:   '1.65',
                whiteSpace:   'pre-wrap',
                wordBreak:    'break-word',
                fontFamily:   T.fontUI,
              }}>
                {task.description}
              </div>
            </div>
          ) : (
            <div style={{
              background:   T.surface2,
              border:       `0.5px solid ${T.glassBorder}`,
              borderRadius: 12,
              padding:      '20px 16px',
              fontSize:     13,
              color:        T.textDisabled,
              textAlign:    'center',
              fontStyle:    'italic',
            }}>
              No instructions yet. Claude will add them when it claims this task.
            </div>
          )}

          {/* Source doc link */}
          {task.docId && (
            <div>
              <div style={{
                fontSize:      10,
                fontWeight:    600,
                color:         T.textMuted,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                marginBottom:  10,
              }}>
                Source doc
              </div>
              <a
                href={`/app/content/${task.docId}`}
                style={{
                  display:        'flex',
                  alignItems:     'center',
                  gap:            10,
                  padding:        '12px 16px',
                  background:     T.surface2,
                  border:         `0.5px solid ${T.glassBorder}`,
                  borderRadius:   12,
                  textDecoration: 'none',
                  transition:     'border-color 0.15s, background 0.15s',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLAnchorElement).style.borderColor = `${T.accent}60`;
                  (e.currentTarget as HTMLAnchorElement).style.background  = T.surface3;
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLAnchorElement).style.borderColor = T.glassBorder;
                  (e.currentTarget as HTMLAnchorElement).style.background  = T.surface2;
                }}
              >
                <span style={{ fontSize: 16, lineHeight: 1 }}>📄</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize:    13,
                    fontWeight:  500,
                    color:       T.textPrimary,
                    overflow:    'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace:  'nowrap',
                  }}>
                    {docTitle ?? 'Source spec doc'}
                  </div>
                  <div style={{
                    fontSize:   10,
                    color:      T.textMuted,
                    fontFamily: T.fontMono,
                    marginTop:  2,
                  }}>
                    {task.docId}
                  </div>
                </div>
                <span style={{ color: T.accent, fontSize: 13, flexShrink: 0 }}>↗</span>
              </a>
            </div>
          )}

          {/* Assigned member */}
          {task.assignedMemberId && (
            <div>
              <div style={{
                fontSize:      10,
                fontWeight:    600,
                color:         T.textMuted,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                marginBottom:  10,
              }}>
                Assigned to
              </div>
              <div style={{
                display:      'flex',
                alignItems:   'center',
                gap:          8,
                padding:      '10px 14px',
                background:   T.surface2,
                border:       `0.5px solid ${T.glassBorder}`,
                borderRadius: 12,
              }}>
                <div style={{
                  width:        28,
                  height:       28,
                  borderRadius: '50%',
                  background:   `${T.accent}30`,
                  border:       `0.5px solid ${T.accent}60`,
                  display:      'flex',
                  alignItems:   'center',
                  justifyContent: 'center',
                  fontSize:     12,
                  color:        T.accent,
                  fontWeight:   600,
                  flexShrink:   0,
                }}>
                  👤
                </div>
                <span style={{
                  fontSize:   12,
                  color:      T.textSecondary,
                  fontFamily: T.fontMono,
                  overflow:   'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {task.assignedMemberId}
                </span>
              </div>
            </div>
          )}

          {/* PR link */}
          {task.githubPrUrl && (
            <div>
              <div style={{
                fontSize:      10,
                fontWeight:    600,
                color:         T.textMuted,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                marginBottom:  10,
              }}>
                Pull Request
              </div>
              <a
                href={task.githubPrUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display:        'flex',
                  alignItems:     'center',
                  gap:            8,
                  padding:        '10px 14px',
                  background:     T.surface2,
                  border:         `0.5px solid ${T.glassBorder}`,
                  borderRadius:   12,
                  textDecoration: 'none',
                  fontSize:       13,
                  color:          T.accent,
                  fontWeight:     500,
                }}
              >
                <span>🔗</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {task.githubPrUrl}
                </span>
                <span>↗</span>
              </a>
            </div>
          )}

          {/* Blocker note */}
          {task.status === 'audit_fix' && task.blockerDescription && (
            <div>
              <div style={{
                fontSize:      10,
                fontWeight:    600,
                color:         T.red,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                marginBottom:  10,
              }}>
                ⚠ Blocker
              </div>
              <div style={{
                background:   'rgba(248,113,113,0.06)',
                border:       `0.5px solid ${T.red}40`,
                borderRadius: 12,
                padding:      '12px 16px',
                fontSize:     13,
                color:        T.red,
                lineHeight:   '1.5',
                whiteSpace:   'pre-wrap',
              }}>
                {task.blockerDescription}
              </div>
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div style={{
          padding:      '12px 24px',
          borderTop:    `0.5px solid ${T.line}`,
          display:      'flex',
          alignItems:   'center',
          justifyContent: 'space-between',
          gap:          8,
        }}>
          <span style={{ fontSize: 11, color: T.textDisabled, fontFamily: T.fontMono }}>
            Created {new Date(task.createdAt).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })}
            {task.estimatedCostUsd != null && ` · $${task.estimatedCostUsd.toFixed(4)} est.`}
          </span>
          <button
            onClick={onClose}
            style={{
              padding:      '6px 16px',
              borderRadius: 8,
              border:       `0.5px solid ${T.glassBorder}`,
              background:   T.glass,
              color:        T.textSecondary,
              fontSize:     12,
              cursor:       'pointer',
              fontFamily:   T.fontUI,
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

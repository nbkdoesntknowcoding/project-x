// Shared tokens + date helpers for the Meetings page (calendar-primary redesign).
import type { CSSProperties } from 'react';
import type { MeetingRow } from '../../lib/api';

export const muted = 'var(--ink-muted, #71717a)';
export const soft = 'var(--ink-soft, #a1a1aa)';
export const ink = 'var(--ink, #e7e7e9)';
export const line = 'var(--line, rgba(255,255,255,0.1))';
export const surface = 'var(--surface-1, rgba(255,255,255,0.02))';
export const surface2 = 'var(--surface, #131418)';
export const accent = 'var(--amber, #f0997b)';
export const green = 'var(--green, #6BE39B)';

export const btn: CSSProperties = {
  padding: '6px 12px', borderRadius: 8, border: 'none', background: accent,
  color: '#0A0B0D', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
};
export const ghost: CSSProperties = {
  padding: '6px 12px', borderRadius: 8, border: `0.5px solid ${line}`,
  background: 'transparent', color: soft, fontSize: 12.5, cursor: 'pointer',
};

/** The date a meeting sits on: its scheduled slot, else when the bot started. */
export function meetingDate(m: MeetingRow): Date {
  return new Date(m.scheduled_start_at || m.started_at);
}

export function isLive(m: MeetingRow): boolean {
  return m.status === 'live' || (!!m.started_at && !m.ended_at && m.status !== 'scheduled' && m.status !== 'ignored');
}

/** A meeting the bot actually recorded — has a transcript, notes doc, or extracted summary. */
export function hasContent(m: MeetingRow): boolean {
  return m.transcript_status === 'ready' || !!m.post_meeting_doc_id || !!m.has_summary;
}

export interface StatusBadge { label: string; color: string }
export function statusOf(m: MeetingRow): StatusBadge {
  if (m.status === 'ignored') return { label: 'Ignored', color: muted };
  if (isLive(m)) return { label: 'Live', color: green };
  if (m.ended_at) return { label: 'Ended', color: soft };
  if (m.scheduled_start_at) return { label: m.admitted ? 'Admitted' : 'Scheduled', color: m.admitted ? green : accent };
  return { label: 'Ended', color: soft };
}

export function fmtDateTime(s: string): string {
  try {
    return new Date(s).toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch { return s; }
}

export function fmtTime(d: Date): string {
  try {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      .replace(' ', '').replace(':00', '');
  } catch { return ''; }
}

/** "45m" / "1h 12m" between started_at and ended_at, when both exist. */
export function durationLabel(m: MeetingRow): string | null {
  if (!m.started_at || !m.ended_at) return null;
  const ms = new Date(m.ended_at).getTime() - new Date(m.started_at).getTime();
  if (ms <= 0) return null;
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

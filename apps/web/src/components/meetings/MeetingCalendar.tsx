import { type JSX, useMemo, useState } from 'react';
import type { MeetingRow } from '../../lib/api';
import {
  muted, soft, ink, line, surface, surface2, accent, green,
  meetingDate, isLive, fmtTime, dayKey, sameDay, addDays,
} from './shared';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Month calendar — the primary Meetings view. Lays meetings onto the day grid
 * by their scheduled slot (or bot-start time), and selecting a chip opens the
 * detail panel. Pure client render off the already-loaded meetings array.
 */
export function MeetingCalendar({
  meetings, selectedId, onSelect, initialMonth,
}: {
  meetings: MeetingRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  initialMonth: Date;
}): JSX.Element {
  const [cursor, setCursor] = useState(() => new Date(initialMonth.getFullYear(), initialMonth.getMonth(), 1));
  const today = new Date();

  const year = cursor.getFullYear();
  const month = cursor.getMonth();

  const cells = useMemo(() => {
    const first = new Date(year, month, 1);
    const gridStart = addDays(first, -first.getDay());
    return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  }, [year, month]);

  const byDay = useMemo(() => {
    const map = new Map<string, MeetingRow[]>();
    for (const m of meetings) {
      const k = dayKey(meetingDate(m));
      const arr = map.get(k);
      if (arr) arr.push(m); else map.set(k, [m]);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => meetingDate(a).getTime() - meetingDate(b).getTime());
    }
    return map;
  }, [meetings]);

  const monthLabel = cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      {/* nav */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h2 style={{ flex: 1, margin: 0, font: '500 16px/1.2 var(--sans)', letterSpacing: '-0.01em', color: ink }}>
          {monthLabel}
        </h2>
        <button style={navBtn} onClick={() => setCursor(new Date(year, month - 1, 1))} aria-label="Previous month">‹</button>
        <button style={{ ...navBtn, width: 'auto', padding: '0 12px', fontSize: 12.5 }} onClick={() => setCursor(new Date(today.getFullYear(), today.getMonth(), 1))}>Today</button>
        <button style={navBtn} onClick={() => setCursor(new Date(year, month + 1, 1))} aria-label="Next month">›</button>
      </div>

      {/* weekday header */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1 }}>
        {WEEKDAYS.map((w) => (
          <div key={w} style={{ fontSize: 10.5, color: muted, textTransform: 'uppercase', letterSpacing: '0.06em', padding: '0 4px 4px', textAlign: 'left' }}>{w}</div>
        ))}
      </div>

      {/* grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gridAutoRows: 'minmax(92px, auto)', gap: 1, background: line, border: `0.5px solid ${line}`, borderRadius: 10, overflow: 'hidden' }}>
        {cells.map((d) => {
          const inMonth = d.getMonth() === month;
          const isToday = sameDay(d, today);
          const dayMeetings = byDay.get(dayKey(d)) || [];
          return (
            <div key={d.toISOString()} style={{ background: surface2, padding: 5, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3, opacity: inMonth ? 1 : 0.4 }}>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <span style={{
                  fontSize: 11, fontWeight: isToday ? 700 : 500,
                  color: isToday ? '#0A0B0D' : (inMonth ? soft : muted),
                  background: isToday ? accent : 'transparent',
                  borderRadius: 999, minWidth: 18, height: 18, lineHeight: '18px', textAlign: 'center', padding: '0 5px',
                }}>{d.getDate()}</span>
              </div>
              {dayMeetings.slice(0, 3).map((m) => (
                <Chip key={m.id} meeting={m} selected={m.id === selectedId} onSelect={onSelect} />
              ))}
              {dayMeetings.length > 3 && dayMeetings[3] && (
                <button onClick={() => onSelect(dayMeetings[3]!.id)} style={{ ...chipBase, background: 'transparent', color: muted, justifyContent: 'flex-start' }}>
                  +{dayMeetings.length - 3} more
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Chip({ meeting, selected, onSelect }: { meeting: MeetingRow; selected: boolean; onSelect: (id: string) => void }): JSX.Element {
  const ignored = meeting.status === 'ignored';
  const live = isLive(meeting);
  return (
    <button
      onClick={() => onSelect(meeting.id)}
      title={meeting.title || 'Untitled meeting'}
      style={{
        ...chipBase,
        background: selected ? accent : surface,
        border: `0.5px solid ${selected ? accent : line}`,
        color: selected ? '#0A0B0D' : (ignored ? muted : ink),
        opacity: ignored ? 0.6 : 1,
      }}
    >
      {live && <span style={{ width: 5, height: 5, borderRadius: 999, background: selected ? '#0A0B0D' : green, flexShrink: 0, boxShadow: selected ? 'none' : `0 0 0 2px ${green}33` }} />}
      <span style={{ fontSize: 9.5, opacity: 0.7, flexShrink: 0 }}>{fmtTime(meetingDate(meeting))}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meeting.title || 'Untitled'}</span>
    </button>
  );
}

const navBtn: React.CSSProperties = {
  width: 28, height: 28, borderRadius: 8, border: `0.5px solid ${line}`,
  background: surface, color: soft, fontSize: 15, cursor: 'pointer', lineHeight: 1,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0,
};

const chipBase: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 4, width: '100%',
  padding: '2px 5px', borderRadius: 5, border: 'none', cursor: 'pointer',
  fontSize: 10.5, fontWeight: 500, textAlign: 'left', minWidth: 0,
};

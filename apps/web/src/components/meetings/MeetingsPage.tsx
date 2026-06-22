import { type JSX, useEffect, useState } from 'react';
import { api, type MeetingRow, type MemberRow } from '../../lib/api';
import { muted, soft, ink, line, surface, btn, ghost, meetingDate, hasContent } from './shared';
import { MeetingCalendar } from './MeetingCalendar';
import { MeetingDetailPanel } from './MeetingDetailPanel';

/**
 * Meetings — calendar-primary view. The month calendar is the centerpiece;
 * selecting a meeting opens the detail panel (transcript / post-meeting doc /
 * key points / participants). Defaults to the latest meeting.
 */
export function MeetingsPage(): JSX.Element {
  const [meetings, setMeetings] = useState<MeetingRow[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [m, mem] = await Promise.all([api.listMeetings(), api.listMembers()]);
        setMeetings(m.meetings);
        setMembers(mem.members);
        // Default-select the latest meeting that actually has a RECORDING (transcript/doc/
        // notes), so the panel opens on real content — not an empty scheduled calendar slot.
        const recorded = m.meetings.find(hasContent);
        setSelectedId((cur) => cur ?? recorded?.id ?? m.meetings[0]?.id ?? null);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function refresh() {
    const m = await api.listMeetings();
    setMeetings(m.meetings);
  }

  if (loading) return <p style={{ color: muted, fontSize: 14 }}>Loading…</p>;

  const selected = meetings.find((m) => m.id === selectedId) || null;
  const latest = meetings[0] ? meetingDate(meetings[0]) : new Date();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <CalendarBar onSynced={refresh} />

      {meetings.length === 0 ? (
        <EmptyAll />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 360px', gap: 18, alignItems: 'start' }}>
          <MeetingCalendar
            meetings={meetings}
            selectedId={selectedId}
            onSelect={setSelectedId}
            initialMonth={selected ? meetingDate(selected) : latest}
          />
          <MeetingDetailPanel meeting={selected} members={members} onChange={refresh} onSelectMeeting={setSelectedId} />
        </div>
      )}
    </div>
  );
}

function EmptyAll(): JSX.Element {
  return (
    <div style={{ padding: '48px 16px', textAlign: 'center', border: `0.5px dashed ${line}`, borderRadius: 12, background: surface }}>
      <div style={{ fontSize: 26, marginBottom: 8 }}>📅</div>
      <div style={{ fontSize: 14, color: ink, fontWeight: 500 }}>No meetings yet</div>
      <p style={{ fontSize: 13, color: soft, maxWidth: 360, margin: '6px auto 0', lineHeight: 1.5 }}>
        Connect your Google Calendar above to auto-detect scheduled meetings, or send the bot
        into a call — they'll show up on the calendar here.
      </p>
    </div>
  );
}

function CalendarBar({ onSynced }: { onSynced: () => void }): JSX.Element {
  const [state, setState] = useState<{ connected: boolean; configured: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void api.calendarStatus().then(setState).catch(() => setState({ connected: false, configured: false }));
  }, []);

  async function sync() {
    setBusy(true); setMsg(null);
    try {
      const r = await api.calendarSync();
      setMsg(`Synced — ${r.created} new, ${r.updated} updated.`);
      onSynced();
    } catch {
      setMsg('Sync failed.');
    } finally { setBusy(false); }
  }

  const wrap: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderRadius: 12, background: surface, border: `0.5px solid ${line}` };
  if (!state) return <div style={wrap}><span style={{ color: muted, fontSize: 13 }}>Checking calendar…</span></div>;

  if (!state.configured) {
    return (
      <div style={wrap}>
        <span style={{ color: soft, fontSize: 13 }}>📅 Calendar integration isn't configured yet. An admin needs to add the Google OAuth credentials.</span>
      </div>
    );
  }

  return (
    <div style={wrap}>
      <span style={{ flex: 1, color: ink, fontSize: 13 }}>
        {state.connected ? '📅 Google Calendar connected' : '📅 Link your Google Calendar to auto-detect meetings'}
      </span>
      {msg && <span style={{ color: muted, fontSize: 12 }}>{msg}</span>}
      {state.connected
        ? <button style={ghost} disabled={busy} onClick={sync}>{busy ? 'Syncing…' : 'Sync now'}</button>
        : <a href="/api/calendar/connect" style={{ ...btn, textDecoration: 'none' }}>Connect Google Calendar</a>}
    </div>
  );
}

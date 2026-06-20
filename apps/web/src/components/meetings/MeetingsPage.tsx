import { type JSX, useEffect, useState } from 'react';
import {
  api,
  type MeetingRow,
  type MeetingParticipantRow,
  type MemberRow,
} from '../../lib/api';

/**
 * Post-meeting identity mapping (Phase 2b). Lists meetings the bot attended and
 * lets an admin map unrecognized attendees (by display name) to a workspace member.
 * Mapping is saved as an alias, so that person is recognized in every future meeting.
 */
const muted = 'var(--ink-muted, #71717a)';
const soft = 'var(--ink-soft, #a1a1aa)';
const ink = 'var(--ink, #e7e7e9)';
const line = 'var(--line, rgba(255,255,255,0.1))';
const surface = 'var(--surface-1, rgba(255,255,255,0.02))';
const accent = 'var(--amber, #f0997b)';
const btn: React.CSSProperties = { padding: '6px 12px', borderRadius: 8, border: 'none', background: accent, color: '#0A0B0D', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };
const ghost: React.CSSProperties = { padding: '6px 12px', borderRadius: 8, border: `0.5px solid ${line}`, background: 'transparent', color: soft, fontSize: 12.5, cursor: 'pointer' };

export function MeetingsPage(): JSX.Element {
  const [meetings, setMeetings] = useState<MeetingRow[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [m, mem] = await Promise.all([api.listMeetings(), api.listMembers()]);
        setMeetings(m.meetings);
        setMembers(mem.members);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function refreshMeetings() {
    const m = await api.listMeetings();
    setMeetings(m.meetings);
  }

  if (loading) return <p style={{ color: muted, fontSize: 14 }}>Loading…</p>;

  // Calendar-scheduled meetings (have a scheduled start) vs bot-attended meetings.
  const scheduled = meetings.filter((m) => m.scheduled_start_at && m.status !== 'ignored');
  const attended = meetings.filter((m) => !m.scheduled_start_at);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: '46rem' }}>
      <CalendarBar onSynced={refreshMeetings} />

      {scheduled.length > 0 && (
        <section>
          <h3 style={{ fontSize: 12, color: muted, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 10px' }}>Upcoming (from calendar)</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {scheduled.map((m) => <ScheduledCard key={m.id} meeting={m} onChange={refreshMeetings} />)}
          </div>
        </section>
      )}

      <section>
        <h3 style={{ fontSize: 12, color: muted, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 10px' }}>Meetings the bot attended</h3>
        {attended.length === 0 ? (
          <p style={{ color: soft, fontSize: 13, maxWidth: '34rem' }}>
            None yet. Admit an upcoming meeting (or send the bot in) and its attendees show up here.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {attended.map((m) => (
              <MeetingCard
                key={m.id}
                meeting={m}
                members={members}
                open={openId === m.id}
                onToggle={() => setOpenId(openId === m.id ? null : m.id)}
                onMapped={refreshMeetings}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function CalendarBar({ onSynced }: { onSynced: () => void }): JSX.Element {
  const [state, setState] = useState<{ connected: boolean; configured: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => { void api.calendarStatus().then(setState).catch(() => setState({ connected: false, configured: false })); }, []);

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

  const wrap: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 12, background: surface, border: `0.5px solid ${line}` };
  if (!state) return <div style={wrap}><span style={{ color: muted, fontSize: 13 }}>Checking calendar…</span></div>;

  if (!state.configured) return (
    <div style={wrap}>
      <span style={{ color: soft, fontSize: 13 }}>📅 Calendar integration isn't configured yet. An admin needs to add the Google OAuth credentials.</span>
    </div>
  );

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

function ScheduledCard({ meeting, onChange }: { meeting: MeetingRow; onChange: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function admit() {
    setBusy(true); setNote(null);
    try {
      const r = await api.admitMeeting(meeting.id);
      setNote(r.botDispatched ? 'Admitted — bot dispatched.' : 'Admitted.');
      onChange();
    } finally { setBusy(false); }
  }
  async function ignore() { setBusy(true); try { await api.ignoreMeeting(meeting.id); onChange(); } finally { setBusy(false); } }
  async function sendBot() {
    setBusy(true); setNote(null);
    try { await api.dispatchMeetingBot(meeting.id); setNote('Bot dispatched.'); }
    catch { setNote('Bot dispatch failed.'); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 12, background: surface, border: `0.5px solid ${line}` }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, color: ink, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meeting.title || 'Untitled meeting'}</div>
        <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>
          {meeting.scheduled_start_at ? fmtDate(meeting.scheduled_start_at) : 'time TBD'}
          {meeting.admitted ? <span style={{ color: 'var(--green, #6BE39B)' }}> · admitted</span> : null}
        </div>
      </div>
      {note && <span style={{ color: muted, fontSize: 12 }}>{note}</span>}
      {meeting.admitted
        ? <button style={ghost} disabled={busy} onClick={sendBot}>{busy ? '…' : 'Send bot now'}</button>
        : (
          <>
            <button style={btn} disabled={busy} onClick={admit}>{busy ? '…' : 'Admit'}</button>
            <button style={ghost} disabled={busy} onClick={ignore}>Ignore</button>
          </>
        )}
    </div>
  );
}

function fmtDate(s: string): string {
  try {
    return new Date(s).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return s;
  }
}

function MeetingCard({
  meeting, members, open, onToggle, onMapped,
}: {
  meeting: MeetingRow;
  members: MemberRow[];
  open: boolean;
  onToggle: () => void;
  onMapped: () => void;
}): JSX.Element {
  const [participants, setParticipants] = useState<MeetingParticipantRow[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || participants !== null) return;
    void api.listMeetingParticipants(meeting.id).then((r) => setParticipants(r.participants));
  }, [open, participants, meeting.id]);

  async function map(pid: string, userId: string) {
    if (!userId) return;
    setBusyId(pid);
    try {
      await api.mapMeetingParticipant(meeting.id, pid, userId);
      const r = await api.listMeetingParticipants(meeting.id);
      setParticipants(r.participants);
      onMapped();
    } finally {
      setBusyId(null);
    }
  }

  const card: React.CSSProperties = {
    border: '0.5px solid var(--line, rgba(255,255,255,0.1))',
    borderRadius: 12,
    background: 'var(--surface-1, rgba(255,255,255,0.02))',
    overflow: 'hidden',
  };

  return (
    <div style={card}>
      <button
        onClick={onToggle}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, padding: '14px 16px', background: 'transparent', border: 'none',
          cursor: 'pointer', textAlign: 'left',
        }}
      >
        <div>
          <div style={{ fontSize: 14, color: 'var(--ink)', fontWeight: 500 }}>
            {fmtDate(meeting.started_at)}
            {meeting.ended_at ? '' : ' · live'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 2 }}>
            {meeting.participant_count} attendee{meeting.participant_count !== 1 ? 's' : ''}
            {meeting.unresolved_count > 0 && (
              <span style={{ color: 'var(--amber, #f0997b)' }}>
                {' · '}{meeting.unresolved_count} to map
              </span>
            )}
          </div>
        </div>
        <span style={{ color: 'var(--ink-muted)', fontSize: 13 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ borderTop: '0.5px solid var(--line, rgba(255,255,255,0.08))', padding: '8px 16px 14px' }}>
          {participants === null ? (
            <p style={{ color: 'var(--ink-muted)', fontSize: 13 }}>Loading attendees…</p>
          ) : participants.length === 0 ? (
            <p style={{ color: 'var(--ink-muted)', fontSize: 13 }}>No attendees recorded.</p>
          ) : (
            participants.map((p) => (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: 'var(--ink)' }}>
                    {p.name || '(unnamed)'}{p.isHost ? ' · host' : ''}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--ink-muted)' }}>
                    {p.resolvedUserId
                      ? `✓ ${p.resolvedName || p.resolvedEmail || 'mapped'}`
                      : p.email
                        ? p.email
                        : 'not recognized'}
                  </div>
                </div>
                {!p.resolvedUserId && p.name && (
                  <select
                    defaultValue=""
                    disabled={busyId === p.id}
                    onChange={(e) => { void map(p.id, e.target.value); }}
                    style={{
                      padding: '6px 8px', borderRadius: 7, fontSize: 12,
                      border: '0.5px solid var(--line, rgba(255,255,255,0.15))',
                      background: 'var(--surface-2, rgba(255,255,255,0.04))', color: 'var(--ink)',
                    }}
                  >
                    <option value="" disabled>Map to…</option>
                    {members.map((mem) => (
                      <option key={mem.userId} value={mem.userId}>
                        {mem.displayName || mem.email}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

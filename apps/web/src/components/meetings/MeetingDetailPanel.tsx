import { type JSX, useEffect, useState } from 'react';
import { api, type MeetingRow, type MeetingParticipantRow, type MemberRow } from '../../lib/api';
import {
  muted, soft, ink, line, surface, surface2, accent, green,
  btn, ghost, fmtDateTime, durationLabel, statusOf,
} from './shared';

type Tab = 'overview' | 'transcript' | 'doc' | 'people';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'transcript', label: 'Transcript' },
  { id: 'doc', label: 'Post-Meeting Doc' },
  { id: 'people', label: 'Participants' },
];

/**
 * Right-hand detail panel for the selected meeting. Header carries the
 * contextual actions (Admit / Ignore / Send bot / Join); tabs expose the
 * meeting's data. Transcript / Doc / Key-points light up in Phase 2 once the
 * recording + summarization backend lands — Phase 1 shows their empty states.
 */
export function MeetingDetailPanel({
  meeting, members, onChange,
}: {
  meeting: MeetingRow | null;
  members: MemberRow[];
  onChange: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<Tab>('overview');

  if (!meeting) {
    return (
      <div style={panel}>
        <p style={{ color: muted, fontSize: 13, margin: 'auto', textAlign: 'center', maxWidth: 220 }}>
          Pick a meeting on the calendar to see its details, attendees, transcript and notes.
        </p>
      </div>
    );
  }

  const st = statusOf(meeting);
  const when = meeting.scheduled_start_at || meeting.started_at;
  const dur = durationLabel(meeting);

  return (
    <div style={panel}>
      {/* header */}
      <div style={{ padding: '16px 16px 12px', borderBottom: `0.5px solid ${line}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 10.5, fontWeight: 600, color: st.color, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{st.label}</span>
          {dur && <span style={{ fontSize: 11, color: muted }}>· {dur}</span>}
        </div>
        <h2 style={{ margin: 0, font: '500 16px/1.25 var(--sans)', letterSpacing: '-0.01em', color: ink }}>
          {meeting.title || 'Untitled meeting'}
        </h2>
        <div style={{ fontSize: 12, color: soft, marginTop: 4 }}>{fmtDateTime(when)}</div>
        <div style={{ fontSize: 11.5, color: muted, marginTop: 2 }}>
          {meeting.participant_count} attendee{meeting.participant_count !== 1 ? 's' : ''}
          {meeting.unresolved_count > 0 && <span style={{ color: accent }}>{' · '}{meeting.unresolved_count} to map</span>}
        </div>
        <Actions meeting={meeting} onChange={onChange} />
      </div>

      {/* tabs */}
      <div style={{ display: 'flex', gap: 2, padding: '8px 10px 0', borderBottom: `0.5px solid ${line}` }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: '7px 10px', border: 'none', background: 'transparent', cursor: 'pointer',
              fontSize: 12, fontWeight: tab === t.id ? 600 : 500,
              color: tab === t.id ? ink : muted,
              borderBottom: `2px solid ${tab === t.id ? accent : 'transparent'}`,
              marginBottom: -1,
            }}
          >{t.label}</button>
        ))}
      </div>

      {/* body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        {tab === 'overview' && <Overview meeting={meeting} />}
        {tab === 'transcript' && <EmptyState icon="🎙" title="No transcript yet" body="Once meeting recording is enabled, the full transcript of this meeting will appear here." />}
        {tab === 'doc' && <EmptyState icon="📄" title="No post-meeting doc yet" body="When a recorded meeting ends, Mnema writes a Post-Meeting Notes doc — summary, decisions and action items — and links it here." />}
        {tab === 'people' && <People meeting={meeting} members={members} onChange={onChange} />}
      </div>
    </div>
  );
}

function Overview({ meeting }: { meeting: MeetingRow }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section>
        <Label>Key points</Label>
        <EmptyState
          inline
          icon="✨"
          title="No key points yet"
          body="Key points, decisions and action items are extracted automatically after a recorded meeting ends."
        />
      </section>
      {meeting.meeting_url && (
        <section>
          <Label>Meeting link</Label>
          <a href={meeting.meeting_url} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, color: accent, wordBreak: 'break-all' }}>
            {meeting.meeting_url}
          </a>
        </section>
      )}
    </div>
  );
}

function Actions({ meeting, onChange }: { meeting: MeetingRow; onChange: () => void }): JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const scheduled = !!meeting.scheduled_start_at && meeting.status !== 'ignored';
  const ended = !!meeting.ended_at;

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setNote(null);
    try { await fn(); setNote(ok); onChange(); }
    catch { setNote('Something went wrong.'); }
    finally { setBusy(false); }
  }

  if (ended && !meeting.meeting_url) return null;

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 12 }}>
      {meeting.meeting_url && !ended && (
        <a href={meeting.meeting_url} target="_blank" rel="noreferrer" style={{ ...ghost, textDecoration: 'none' }}>Join</a>
      )}
      {scheduled && !meeting.admitted && (
        <>
          <button style={btn} disabled={busy} onClick={() => run(() => api.admitMeeting(meeting.id), 'Admitted.')}>{busy ? '…' : 'Admit'}</button>
          <button style={ghost} disabled={busy} onClick={() => run(() => api.ignoreMeeting(meeting.id), 'Ignored.')}>Ignore</button>
        </>
      )}
      {scheduled && meeting.admitted && !ended && (
        <button style={ghost} disabled={busy} onClick={() => run(() => api.dispatchMeetingBot(meeting.id), 'Bot dispatched.')}>{busy ? '…' : 'Send bot now'}</button>
      )}
      {note && <span style={{ fontSize: 11.5, color: muted }}>{note}</span>}
    </div>
  );
}

function People({ meeting, members, onChange }: { meeting: MeetingRow; members: MemberRow[]; onChange: () => void }): JSX.Element {
  const [participants, setParticipants] = useState<MeetingParticipantRow[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    setParticipants(null);
    void api.listMeetingParticipants(meeting.id).then((r) => setParticipants(r.participants));
  }, [meeting.id]);

  async function map(pid: string, userId: string) {
    if (!userId) return;
    setBusyId(pid);
    try {
      await api.mapMeetingParticipant(meeting.id, pid, userId);
      const r = await api.listMeetingParticipants(meeting.id);
      setParticipants(r.participants);
      onChange();
    } finally { setBusyId(null); }
  }

  if (participants === null) return <p style={{ color: muted, fontSize: 13 }}>Loading attendees…</p>;
  if (participants.length === 0) {
    return <EmptyState inline icon="👥" title="No attendees recorded" body="When the bot joins this meeting, the people it sees show up here to map to Mnema accounts." />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {participants.map((p) => (
        <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: `0.5px solid ${line}` }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, color: ink, display: 'flex', alignItems: 'center', gap: 6 }}>
              {p.name || '(unnamed)'}
              {p.isHost && <span style={badge('host')}>host</span>}
              {p.resolvedUserId && <span style={badge('verified')}>✓</span>}
            </div>
            <div style={{ fontSize: 11, color: muted, marginTop: 1 }}>
              {p.resolvedUserId ? (p.resolvedName || p.resolvedEmail || 'mapped') : p.email ? p.email : 'not recognized'}
            </div>
          </div>
          {!p.resolvedUserId && p.name && (
            <select
              defaultValue=""
              disabled={busyId === p.id}
              onChange={(e) => { void map(p.id, e.target.value); }}
              style={{
                padding: '6px 8px', borderRadius: 7, fontSize: 12,
                border: `0.5px solid ${line}`, background: surface, color: ink, maxWidth: 150,
              }}
            >
              <option value="" disabled>Map to…</option>
              {members.map((mem) => (
                <option key={mem.userId} value={mem.userId}>{mem.displayName || mem.email}</option>
              ))}
            </select>
          )}
        </div>
      ))}
    </div>
  );
}

function badge(kind: 'host' | 'verified'): React.CSSProperties {
  const c = kind === 'verified' ? green : soft;
  return {
    fontSize: 9.5, fontWeight: 600, color: c, border: `0.5px solid ${c}55`,
    borderRadius: 999, padding: '1px 6px', textTransform: 'uppercase', letterSpacing: '0.04em',
  };
}

function Label({ children }: { children: React.ReactNode }): JSX.Element {
  return <div style={{ fontSize: 10.5, color: muted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>{children}</div>;
}

function EmptyState({ icon, title, body, inline }: { icon: string; title: string; body: string; inline?: boolean }): JSX.Element {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
      gap: 6, padding: inline ? '18px 12px' : '40px 16px', color: muted,
      border: `0.5px dashed ${line}`, borderRadius: 10, background: surface,
    }}>
      <span style={{ fontSize: 22, opacity: 0.8 }}>{icon}</span>
      <div style={{ fontSize: 13, color: soft, fontWeight: 500 }}>{title}</div>
      <div style={{ fontSize: 12, color: muted, maxWidth: 280, lineHeight: 1.5 }}>{body}</div>
    </div>
  );
}

const panel: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', minHeight: 420,
  border: `0.5px solid ${line}`, borderRadius: 12, background: surface2, overflow: 'hidden',
};

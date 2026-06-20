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

  if (loading) return <p style={{ color: 'var(--ink-muted)', fontSize: 14 }}>Loading…</p>;
  if (meetings.length === 0) {
    return (
      <p style={{ color: 'var(--ink-soft)', fontSize: 14, maxWidth: '34rem' }}>
        No meetings captured yet. After the bot attends a meeting, its attendees show up
        here so you can connect anyone it didn't recognize to their Mnema account.
      </p>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: '46rem' }}>
      {meetings.map((m) => (
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

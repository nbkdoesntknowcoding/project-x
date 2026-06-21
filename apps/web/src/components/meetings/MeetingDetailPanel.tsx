import { type JSX, useEffect, useState } from 'react';
import {
  api, type MeetingRow, type MeetingParticipantRow, type MemberRow,
  type MeetingDetail, type MeetingSummary, type TranscriptTurn,
  type MeetingTask, type LinkedMeeting,
} from '../../lib/api';
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
 * meeting's data. Overview / Transcript / Doc bind to the Phase 2 backend
 * (transcript + summary + auto-written doc) and show status-aware empty states
 * while a recorded meeting is still being processed.
 */
export function MeetingDetailPanel({
  meeting, members, onChange, onSelectMeeting,
}: {
  meeting: MeetingRow | null;
  members: MemberRow[];
  onChange: () => void;
  onSelectMeeting?: (id: string) => void;
}): JSX.Element {
  const [tab, setTab] = useState<Tab>('overview');
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [tasks, setTasks] = useState<MeetingTask[]>([]);
  const [linked, setLinked] = useState<LinkedMeeting[]>([]);
  const meetingId = meeting?.id ?? null;

  useEffect(() => {
    setDetail(null); setTasks([]); setLinked([]);
    if (!meetingId) return;
    let live = true;
    void api.getMeeting(meetingId).then((r) => {
      if (!live) return;
      setDetail(r.meeting); setTasks(r.tasks); setLinked(r.linked_meetings);
    }).catch(() => {});
    return () => { live = false; };
  }, [meetingId]);

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
  const tStatus = detail?.transcript_status ?? meeting.transcript_status ?? 'none';
  const docId = detail?.post_meeting_doc_id ?? meeting.post_meeting_doc_id ?? null;

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
        {tab === 'overview' && <Overview meeting={meeting} summary={detail?.summary ?? null} tStatus={tStatus} tasks={tasks} linked={linked} onSelectMeeting={onSelectMeeting} />}
        {tab === 'transcript' && <TranscriptTab meetingId={meeting.id} tStatus={tStatus} />}
        {tab === 'doc' && <DocTab docId={docId} preDocId={detail?.pre_meeting_doc_id ?? null} tStatus={tStatus} />}
        {tab === 'people' && <People meeting={meeting} members={members} onChange={onChange} />}
      </div>
    </div>
  );
}

function transcriptHint(tStatus: string): { title: string; body: string } {
  if (tStatus === 'pending') return { title: 'Processing…', body: 'The recording is being transcribed — this usually takes a minute or two after the meeting ends.' };
  if (tStatus === 'failed') return { title: 'No transcript', body: "We couldn't get a transcript for this meeting." };
  if (tStatus === 'ready') return { title: 'Nothing here', body: 'No turns were captured for this meeting.' };
  return { title: 'No transcript yet', body: 'Once a recorded meeting ends, its full transcript appears here.' };
}

function Overview({ meeting, summary, tStatus, tasks, linked, onSelectMeeting }: {
  meeting: MeetingRow; summary: MeetingSummary | null; tStatus: string;
  tasks: MeetingTask[]; linked: LinkedMeeting[]; onSelectMeeting?: (id: string) => void;
}): JSX.Element {
  const hasSummary = !!summary && (summary.keyPoints.length > 0 || summary.decisions.length > 0 || summary.actionItems.length > 0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section>
        <Label>Key points</Label>
        {hasSummary ? (
          <SummaryView summary={summary!} />
        ) : (
          <EmptyState
            inline
            icon="✨"
            title={tStatus === 'pending' ? 'Processing…' : 'No key points yet'}
            body={tStatus === 'pending'
              ? 'Key points, decisions and action items are being extracted from the recording.'
              : 'Key points, decisions and action items are extracted automatically after a recorded meeting ends.'}
          />
        )}
      </section>

      {tasks.length > 0 && (
        <section>
          <Label>Tasks created</Label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {tasks.map((t) => (
              <div key={t.id} style={{ fontSize: 12.5, color: ink, display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <span style={{ color: t.status === 'done' ? green : muted }}>{t.status === 'done' ? '●' : '○'}</span>
                <span style={{ flex: 1 }}>{t.title}{t.assignee ? <span style={{ color: muted }}> — {t.assignee}</span> : null}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {linked.length > 0 && (
        <section>
          <Label>Related meetings</Label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {linked.map((m) => (
              <button
                key={m.id}
                onClick={() => onSelectMeeting?.(m.id)}
                style={{ textAlign: 'left', background: 'transparent', border: 'none', cursor: onSelectMeeting ? 'pointer' : 'default', padding: '2px 0', fontSize: 12.5, color: accent }}
              >
                {m.title || 'Untitled meeting'}
              </button>
            ))}
          </div>
        </section>
      )}

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

function SummaryView({ summary }: { summary: MeetingSummary }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {summary.keyPoints.length > 0 && (
        <ul style={listStyle}>{summary.keyPoints.map((k, i) => <li key={i} style={liStyle}>{k}</li>)}</ul>
      )}
      {summary.decisions.length > 0 && (
        <div>
          <Label>Decisions</Label>
          <ul style={listStyle}>{summary.decisions.map((d, i) => <li key={i} style={liStyle}>{d}</li>)}</ul>
        </div>
      )}
      {summary.actionItems.length > 0 && (
        <div>
          <Label>Action items</Label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {summary.actionItems.map((a, i) => (
              <div key={i} style={{ fontSize: 12.5, color: ink, display: 'flex', gap: 8 }}>
                <span style={{ color: green }}>○</span>
                <span>{a.text}{a.owner ? <span style={{ color: muted }}> — {a.owner}</span> : null}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TranscriptTab({ meetingId, tStatus }: { meetingId: string; tStatus: string }): JSX.Element {
  const [turns, setTurns] = useState<TranscriptTurn[] | null>(null);
  useEffect(() => {
    setTurns(null);
    void api.getMeetingTranscript(meetingId).then((r) => setTurns(r.turns)).catch(() => setTurns([]));
  }, [meetingId]);

  if (turns === null) return <p style={{ color: muted, fontSize: 13 }}>Loading…</p>;
  if (turns.length === 0) {
    const h = transcriptHint(tStatus);
    return <EmptyState inline icon="🎙" title={h.title} body={h.body} />;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {turns.map((t) => (
        <div key={t.seq}>
          <div style={{ fontSize: 11, fontWeight: 600, color: soft }}>{t.speaker || 'Speaker'}</div>
          <div style={{ fontSize: 12.5, color: ink, lineHeight: 1.5 }}>{t.text}</div>
        </div>
      ))}
    </div>
  );
}

function DocTab({ docId, preDocId, tStatus }: { docId: string | null; preDocId: string | null; tStatus: string }): JSX.Element {
  if (!docId && !preDocId) {
    return (
      <EmptyState
        icon="📄"
        title={tStatus === 'pending' ? 'Writing notes…' : 'No meeting docs yet'}
        body={tStatus === 'pending'
          ? 'Mnema is writing the Post-Meeting Notes — summary, decisions and action items — from the transcript.'
          : 'A pre-meeting brief is filed when you admit a meeting, and Post-Meeting Notes when it ends.'}
      />
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {preDocId && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ fontSize: 12.5, color: soft, lineHeight: 1.5, margin: 0 }}>
            Pre-meeting brief — context, the previous meeting, and a suggested agenda.
          </p>
          <a href={`/app/content/${preDocId}`} style={{ ...ghost, textDecoration: 'none', alignSelf: 'flex-start' }}>Open Pre-Meeting Brief →</a>
        </div>
      )}
      {docId && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ fontSize: 12.5, color: soft, lineHeight: 1.5, margin: 0 }}>
            Post-Meeting Notes — summary, decisions, tasks created, and the full transcript.
          </p>
          <a href={`/app/content/${docId}`} style={{ ...btn, textDecoration: 'none', alignSelf: 'flex-start' }}>Open Post-Meeting Notes →</a>
        </div>
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

const listStyle: React.CSSProperties = { margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 };
const liStyle: React.CSSProperties = { fontSize: 12.5, color: ink, lineHeight: 1.5 };

const panel: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', minHeight: 420,
  border: `0.5px solid ${line}`, borderRadius: 12, background: surface2, overflow: 'hidden',
};

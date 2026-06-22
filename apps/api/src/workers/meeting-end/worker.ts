/**
 * Meeting worker (Phase 2 + 3). Two job kinds:
 *
 *  - 'brief' (on admit): generate a pre-meeting brief doc and file it.
 *  - 'end'  (on meeting end):
 *      1. fetch Recall's post-meeting transcript → store turns,
 *      2. gpt-4o-mini → key points / decisions / action items → meetings.summary,
 *      3. auto-create tasks from action items (assignee = the speaker who owns it),
 *      4. ensure a "Meeting Docs/" folder + write the Post-Meeting Notes doc,
 *      5. auto-link related meetings,
 *      6. wire the meeting into the knowledge graph (project / docs / people /
 *         tasks / linked meetings) + enqueue concept extraction of the notes doc,
 *      7. purge Recall's recording media (Mnema keeps only the transcript text).
 *
 * Retryable while the recording/transcript is still processing; idempotent on
 * re-run (reuses stored turns, tasks, and docs).
 */
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import OpenAI from 'openai';
import { config } from '../../config/env.js';
import { db } from '../../db/index.js';
import {
  docs, folders, meetings, meetingParticipants, meetingTranscripts, projects, tasks,
  type MeetingSummary,
} from '../../db/schema.js';
import { contentHash, emptyYjsState } from '../../lib/yjs.js';
import { syncMeetingNode } from '../../lib/graph/meeting-graph.js';
import { enqueueExtractDoc, enqueueCluster } from '../../queue/graph.js';
import {
  recallEnabled, getBotRecording, createAsyncTranscript, getTranscriptArtifact, downloadTranscript,
  deleteBotMedia, type TranscriptTurn,
} from '../../lib/recall.js';
import { MEETING_END_QUEUE_NAME, type MeetingEndJobData } from '../../queue/meeting-end.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
type MeetingRow = typeof meetings.$inferSelect;
interface CreatedTask { id: string; title: string; owner: string | null }

function openai(): OpenAI {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, dangerouslyAllowBrowser: true });
}

function fmtDate(d: Date | string | null): string {
  if (!d) return '';
  try { return new Date(d).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return String(d); }
}

// ── Summary ───────────────────────────────────────────────────────────────────
const SUMMARY_PROMPT = `You summarise a meeting transcript into strict JSON with this exact shape:
{ "keyPoints": string[], "decisions": string[], "actionItems": [{ "text": string, "owner": string|null }] }
Rules: keyPoints = 3–7 concise bullets capturing what mattered. decisions = explicit decisions made (may be empty). actionItems = concrete tasks someone committed to, with the owner's name if stated (else null). Return ONLY the JSON object, no prose.`;

async function summarise(turns: TranscriptTurn[]): Promise<MeetingSummary | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  const transcript = turns.map((t) => `${t.speaker ?? 'Speaker'}: ${t.text}`).join('\n').slice(0, 48_000);
  const res = await openai().chat.completions.create({
    model: 'gpt-4o-mini', max_tokens: 1500, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: SUMMARY_PROMPT }, { role: 'user', content: transcript }],
  });
  const parsed = JSON.parse(res.choices[0]?.message?.content ?? '{}') as Partial<MeetingSummary>;
  return {
    keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints.map(String) : [],
    decisions: Array.isArray(parsed.decisions) ? parsed.decisions.map(String) : [],
    actionItems: Array.isArray(parsed.actionItems)
      ? parsed.actionItems.map((a) => ({ text: String((a as { text?: unknown }).text ?? ''), owner: (a as { owner?: string | null }).owner ?? null })).filter((a) => a.text)
      : [],
  };
}

// ── Tasks from action items ─────────────────────────────────────────────────────
async function createMeetingTasks(meeting: MeetingRow, summary: MeetingSummary | null): Promise<CreatedTask[]> {
  // Idempotent: if tasks already exist for this meeting (re-run), return them.
  const existing = await db.select({ id: tasks.id, title: tasks.title }).from(tasks).where(eq(tasks.meetingId, meeting.id));
  if (existing.length > 0) return existing.map((t) => ({ id: t.id, title: t.title, owner: null }));
  if (!summary || summary.actionItems.length === 0) return [];

  // Resolve an action-item owner name → a resolved participant's user id.
  const parts = await db
    .select({ name: meetingParticipants.name, userId: meetingParticipants.resolvedUserId })
    .from(meetingParticipants)
    .where(and(eq(meetingParticipants.meetingId, meeting.id), isNotNull(meetingParticipants.resolvedUserId)));
  const resolveOwner = (owner: string | null | undefined): string | null => {
    if (!owner) return null;
    const o = owner.toLowerCase();
    const hit = parts.find((p) => p.name && (p.name.toLowerCase().includes(o) || o.includes(p.name.toLowerCase())));
    return hit?.userId ?? null;
  };

  const created: CreatedTask[] = [];
  for (const item of summary.actionItems) {
    const [t] = await db.insert(tasks).values({
      workspaceId: meeting.workspaceId,
      title: item.text.slice(0, 200),
      status: 'backlog', priority: 'medium',
      projectId: meeting.projectId ?? null,
      meetingId: meeting.id,
      assignedMemberId: resolveOwner(item.owner),
    }).returning({ id: tasks.id, title: tasks.title });
    if (t) created.push({ id: t.id, title: t.title, owner: item.owner ?? null });
  }
  return created;
}

// ── Post-meeting notes doc ──────────────────────────────────────────────────────
function renderNotes(meeting: MeetingRow, summary: MeetingSummary | null, turns: TranscriptTurn[], createdTasks: CreatedTask[]): string {
  const lines: string[] = [];
  lines.push(`# Post-Meeting Notes — ${meeting.title || 'Meeting'}`, `_${fmtDate(meeting.startedAt)}_`, '');
  if (summary?.keyPoints.length) lines.push('## Key points', ...summary.keyPoints.map((k) => `- ${k}`), '');
  if (summary?.decisions.length) lines.push('## Decisions', ...summary.decisions.map((d) => `- ${d}`), '');
  if (createdTasks.length) {
    lines.push('## Tasks created', ...createdTasks.map((t) => `- [ ] ${t.title}${t.owner ? ` — ${t.owner}` : ''}`), '');
  } else if (summary?.actionItems.length) {
    lines.push('## Action items', ...summary.actionItems.map((a) => `- [ ] ${a.text}${a.owner ? ` — ${a.owner}` : ''}`), '');
  }
  if (turns.length) {
    lines.push('## Transcript', '');
    for (const t of turns) lines.push(`**${t.speaker ?? 'Speaker'}:** ${t.text}`, '');
  } else {
    lines.push('_No transcript was captured for this meeting._');
  }
  return lines.join('\n');
}

async function ensureMeetingFolder(workspaceId: string, meeting: MeetingRow): Promise<string> {
  if (meeting.meetingFolderId) {
    const existing = await db.query.folders.findFirst({ where: eq(folders.id, meeting.meetingFolderId) });
    if (existing) return existing.id;
  }
  let root = await db.query.folders.findFirst({
    where: and(eq(folders.workspaceId, workspaceId), eq(folders.folderType, 'meeting_docs'), isNull(folders.meetingId), isNull(folders.parentFolderId)),
  });
  if (!root) {
    const [created] = await db.insert(folders).values({
      workspaceId, name: 'Meeting Docs', folderType: 'meeting_docs', isDeletable: false, createdBy: meeting.organizerUserId ?? null,
    }).returning();
    root = created;
  }
  let mf = await db.query.folders.findFirst({ where: and(eq(folders.workspaceId, workspaceId), eq(folders.meetingId, meeting.id)) });
  if (!mf) {
    const [created] = await db.insert(folders).values({
      workspaceId, name: `${meeting.title || 'Meeting'} — ${fmtDate(meeting.startedAt)}`,
      parentFolderId: root!.id, folderType: 'meeting_docs', meetingId: meeting.id, isDeletable: false, createdBy: meeting.organizerUserId ?? null,
    }).returning();
    mf = created;
  }
  return mf!.id;
}

async function writeDoc(workspaceId: string, folderId: string, meeting: MeetingRow, existingDocId: string | null, title: string, markdown: string): Promise<string> {
  const createdBy = meeting.organizerUserId ?? null;
  if (existingDocId) {
    const existing = await db.query.docs.findFirst({ where: eq(docs.id, existingDocId) });
    if (existing) {
      await db.update(docs).set({ markdown, contentHash: contentHash(markdown), updatedAt: new Date() }).where(eq(docs.id, existing.id));
      return existing.id;
    }
  }
  const [doc] = await db.insert(docs).values({
    workspaceId, folderId, projectId: meeting.projectId ?? null,
    path: `${nanoid(10)}.md`, title, type: 'doc', markdown,
    yjsState: emptyYjsState(), contentHash: contentHash(markdown), createdBy, updatedBy: createdBy,
  }).returning();
  return doc!.id;
}

// ── Auto-link related meetings ──────────────────────────────────────────────────
async function autoLink(meeting: MeetingRow): Promise<void> {
  const rows = await db.execute(sql`
    SELECT m.id FROM meetings m
    WHERE m.workspace_id = ${meeting.workspaceId}::uuid
      AND m.id <> ${meeting.id}::uuid
      AND (
        (${meeting.projectId}::uuid IS NOT NULL AND m.project_id = ${meeting.projectId}::uuid)
        OR m.id IN (
          SELECT DISTINCT mp2.meeting_id
          FROM meeting_participants mp1
          JOIN meeting_participants mp2 ON mp1.resolved_user_id = mp2.resolved_user_id
          WHERE mp1.meeting_id = ${meeting.id}::uuid
            AND mp1.resolved_user_id IS NOT NULL
            AND mp2.meeting_id <> ${meeting.id}::uuid
        )
      )
    ORDER BY COALESCE(m.scheduled_start_at, m.started_at) DESC
    LIMIT 5`);
  const ids = (rows as unknown as Array<{ id: string }>).map((r) => r.id);
  await db.update(meetings).set({ linkedMeetingIds: ids }).where(eq(meetings.id, meeting.id));
}

// ── Pre-meeting brief (on admit) ────────────────────────────────────────────────
const BRIEF_PROMPT = `You write a concise pre-meeting brief (max 350 words, markdown) with sections: ## Context, ## Previous meeting, ## Suggested agenda. Use the provided project and prior-meeting info; if little is known, keep it short but useful. Return ONLY markdown.`;

async function generateBrief(meeting: MeetingRow): Promise<void> {
  if (!process.env.OPENAI_API_KEY) return;
  let projectName: string | null = null;
  if (meeting.projectId) {
    const p = await db.query.projects.findFirst({ where: eq(projects.id, meeting.projectId) });
    projectName = p?.name ?? null;
  }
  const priorRows = await db.execute(sql`
    SELECT title, summary FROM meetings
    WHERE workspace_id = ${meeting.workspaceId}::uuid AND id <> ${meeting.id}::uuid AND summary IS NOT NULL
      AND (${meeting.projectId}::uuid IS NULL OR project_id = ${meeting.projectId}::uuid)
    ORDER BY COALESCE(scheduled_start_at, started_at) DESC LIMIT 1`);
  const prior = (priorRows as unknown as Array<{ title: string | null; summary: MeetingSummary | null }>)[0];
  const priorText = prior?.summary
    ? `${prior.title ?? 'Previous meeting'}: ${(prior.summary.keyPoints ?? []).join('; ')}`
    : 'none';

  const res = await openai().chat.completions.create({
    model: 'gpt-4o-mini', max_tokens: 700,
    messages: [
      { role: 'system', content: BRIEF_PROMPT },
      { role: 'user', content: `Meeting: ${meeting.title || 'Untitled'}\nProject: ${projectName ?? '—'}\nMost recent related meeting summary: ${priorText}` },
    ],
  });
  const markdown = res.choices[0]?.message?.content?.trim();
  if (!markdown) return;

  const folderId = await ensureMeetingFolder(meeting.workspaceId, meeting);
  const docId = await writeDoc(meeting.workspaceId, folderId, meeting, meeting.preMeetingDocId, `Pre-Meeting Brief — ${meeting.title || 'Meeting'}`, markdown);
  await db.update(meetings).set({ meetingFolderId: folderId, preMeetingDocId: docId }).where(eq(meetings.id, meeting.id));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await syncMeetingNode(db as any, meeting.workspaceId, meeting.id);
}

// ── Worker ──────────────────────────────────────────────────────────────────────
export function startMeetingEndWorker(): Worker<MeetingEndJobData> {
  const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });

  const worker = new Worker<MeetingEndJobData>(
    MEETING_END_QUEUE_NAME,
    async (job) => {
      const { meetingId, workspaceId, recallBotId, kind = 'end' } = job.data;
      const meeting = await db.query.meetings.findFirst({ where: eq(meetings.id, meetingId) });
      if (!meeting) return; // deleted

      if (kind === 'brief') { await generateBrief(meeting); return; }

      // No bot / no Recall creds → nothing to transcribe; skip silently.
      if (!recallBotId || !recallEnabled()) return;

      // ── 1. Transcript (idempotent; retryable while still processing) ─────────
      const stored = await db
        .select({ seq: meetingTranscripts.seq, speaker: meetingTranscripts.speaker, text: meetingTranscripts.text, tsMs: meetingTranscripts.tsMs })
        .from(meetingTranscripts).where(eq(meetingTranscripts.meetingId, meetingId)).orderBy(asc(meetingTranscripts.seq));
      let turns: TranscriptTurn[] = stored.map((t) => ({ speaker: t.speaker, text: t.text, tsMs: t.tsMs }));

      if (turns.length === 0) {
        await db.update(meetings).set({ transcriptStatus: 'pending' }).where(eq(meetings.id, meetingId));
        const rec = await getBotRecording(recallBotId);
        if (!rec) throw new Error(`no recording for bot ${recallBotId} yet`);
        if (!rec.recordingDone) throw new Error(`recording ${rec.recordingId} not done`);
        let transcriptId = rec.transcriptId;
        if (!transcriptId) transcriptId = await createAsyncTranscript(rec.recordingId);

        let transcriptStatus: 'ready' | 'failed' = 'failed';
        let downloadUrl: string | null = null;
        for (let i = 0; i < 12; i++) {
          const art = await getTranscriptArtifact(transcriptId);
          if (art.statusCode === 'done') { downloadUrl = art.downloadUrl; break; }
          if (art.statusCode === 'failed' || art.statusCode === 'error') { transcriptStatus = 'failed'; break; }
          await sleep(12_000);
        }
        if (downloadUrl) { turns = await downloadTranscript(downloadUrl); transcriptStatus = 'ready'; }
        else if (transcriptStatus !== 'failed') throw new Error('transcript still processing');

        if (turns.length) {
          await db.delete(meetingTranscripts).where(eq(meetingTranscripts.meetingId, meetingId));
          await db.insert(meetingTranscripts).values(turns.map((t, i) => ({ meetingId, seq: i, speaker: t.speaker, text: t.text, tsMs: t.tsMs })));
        }
        await db.update(meetings).set({ transcriptStatus }).where(eq(meetings.id, meetingId));
      }

      // ── 2. Summary ───────────────────────────────────────────────────────────
      let summary: MeetingSummary | null = meeting.summary ?? null;
      if (turns.length && !summary) {
        try {
          summary = await summarise(turns);
          if (summary) await db.update(meetings).set({ summary }).where(eq(meetings.id, meetingId));
        } catch (err) { console.error('[meeting-end] summarise failed:', err); } // eslint-disable-line no-console
      }

      // Give the meeting a real title (calendar-less bot meetings have none, so they show
      // as "Untitled"). Prefer the first key point; fall back to a dated label.
      if (!meeting.title) {
        const t = (summary?.keyPoints?.[0]?.replace(/\s+/g, ' ').trim().slice(0, 70))
          || `Meeting — ${fmtDate(meeting.startedAt)}`;
        await db.update(meetings).set({ title: t }).where(eq(meetings.id, meetingId));
        meeting.title = t;
      }

      // ── 3. Tasks from action items ───────────────────────────────────────────
      const createdTasks = await createMeetingTasks(meeting, summary);

      // ── 4. Folder + Post-Meeting Notes doc ───────────────────────────────────
      const folderId = await ensureMeetingFolder(workspaceId, meeting);
      await db.update(meetings).set({ meetingFolderId: folderId }).where(eq(meetings.id, meetingId));
      const docMd = renderNotes(meeting, summary, turns, createdTasks);
      const docId = await writeDoc(workspaceId, folderId, meeting, meeting.postMeetingDocId, `Post-Meeting Notes — ${meeting.title || 'Meeting'}`, docMd);
      await db.update(meetings).set({ postMeetingDocId: docId }).where(eq(meetings.id, meetingId));

      // ── 5. Auto-link related meetings ────────────────────────────────────────
      await autoLink(meeting);

      // ── 6. Wire into the knowledge graph ─────────────────────────────────────
      const fresh = await db.query.meetings.findFirst({ where: eq(meetings.id, meetingId) });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (fresh) await syncMeetingNode(db as any, workspaceId, meetingId);
      enqueueExtractDoc(workspaceId, docId);       // extract concepts from the notes doc
      enqueueCluster(workspaceId, false, 60_000);  // re-cluster shortly after

      // ── 7. Purge Recall media (keep only the transcript text) ────────────────
      if (turns.length) await deleteBotMedia(recallBotId);
    },
    { connection, concurrency: 2, lockDuration: 5 * 60 * 1000, stalledInterval: 60 * 1000 },
  );

  worker.on('failed', (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[meeting-end] job ${job?.id} failed (attempt ${job?.attemptsMade}):`, err);
    if (job && job.data.kind !== 'brief' && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      void db.update(meetings).set({ transcriptStatus: 'failed' }).where(eq(meetings.id, job.data.meetingId)).catch(() => {});
    }
  });

  return worker;
}

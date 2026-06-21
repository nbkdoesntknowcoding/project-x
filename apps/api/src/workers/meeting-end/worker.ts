/**
 * Meeting-end worker (Phase 2). When a recorded meeting ends, this:
 *   1. fetches Recall's post-meeting transcript (creating it if needed),
 *   2. stores the turns in `meeting_transcripts`,
 *   3. asks gpt-4o-mini for key points / decisions / action items → meetings.summary,
 *   4. ensures a per-meeting folder under "Meeting Docs/" and writes a
 *      Post-Meeting Notes doc, linking meetingFolderId / postMeetingDocId.
 *
 * Each retryable failure (recording/transcript still processing) throws so BullMQ
 * retries with backoff; a transcript that genuinely fails is recorded as
 * 'failed' and processing continues so the meeting still gets a folder/doc.
 */
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import OpenAI from 'openai';
import { config } from '../../config/env.js';
import { db } from '../../db/index.js';
import { docs, folders, meetings, meetingTranscripts, type MeetingSummary } from '../../db/schema.js';
import { contentHash, emptyYjsState } from '../../lib/yjs.js';
import {
  recallEnabled, getBotRecording, createAsyncTranscript, getTranscriptArtifact, downloadTranscript,
  deleteBotMedia, type TranscriptTurn,
} from '../../lib/recall.js';
import { MEETING_END_QUEUE_NAME, type MeetingEndJobData } from '../../queue/meeting-end.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const SUMMARY_PROMPT = `You summarise a meeting transcript into strict JSON with this exact shape:
{ "keyPoints": string[], "decisions": string[], "actionItems": [{ "text": string, "owner": string|null }] }
Rules: keyPoints = 3–7 concise bullets capturing what mattered. decisions = explicit decisions made (may be empty). actionItems = concrete tasks someone committed to, with the owner's name if stated (else null). Return ONLY the JSON object, no prose.`;

async function summarise(turns: TranscriptTurn[]): Promise<MeetingSummary | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  const transcript = turns.map((t) => `${t.speaker ?? 'Speaker'}: ${t.text}`).join('\n').slice(0, 48_000);
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, dangerouslyAllowBrowser: true });
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 1500,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SUMMARY_PROMPT },
      { role: 'user', content: transcript },
    ],
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

function fmtDate(d: Date | string | null): string {
  if (!d) return '';
  try { return new Date(d).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return String(d); }
}

type MeetingRow = typeof meetings.$inferSelect;

async function ensureMeetingFolder(workspaceId: string, meeting: MeetingRow): Promise<string> {
  if (meeting.meetingFolderId) {
    const existing = await db.query.folders.findFirst({ where: eq(folders.id, meeting.meetingFolderId) });
    if (existing) return existing.id;
  }
  // Workspace-level "Meeting Docs" root (created once).
  let root = await db.query.folders.findFirst({
    where: and(eq(folders.workspaceId, workspaceId), eq(folders.folderType, 'meeting_docs'), isNull(folders.meetingId), isNull(folders.parentFolderId)),
  });
  if (!root) {
    const [created] = await db.insert(folders).values({
      workspaceId, name: 'Meeting Docs', folderType: 'meeting_docs', isDeletable: false, createdBy: meeting.organizerUserId ?? null,
    }).returning();
    root = created;
  }
  // Per-meeting child folder.
  let mf = await db.query.folders.findFirst({ where: and(eq(folders.workspaceId, workspaceId), eq(folders.meetingId, meeting.id)) });
  if (!mf) {
    const name = `${meeting.title || 'Meeting'} — ${fmtDate(meeting.startedAt)}`;
    const [created] = await db.insert(folders).values({
      workspaceId, name, parentFolderId: root!.id, folderType: 'meeting_docs', meetingId: meeting.id, isDeletable: false, createdBy: meeting.organizerUserId ?? null,
    }).returning();
    mf = created;
  }
  return mf!.id;
}

function renderDoc(meeting: MeetingRow, summary: MeetingSummary | null, turns: TranscriptTurn[]): string {
  const lines: string[] = [];
  lines.push(`# Post-Meeting Notes — ${meeting.title || 'Meeting'}`);
  lines.push(`_${fmtDate(meeting.startedAt)}_`);
  lines.push('');
  if (summary && summary.keyPoints.length) {
    lines.push('## Key points', ...summary.keyPoints.map((k) => `- ${k}`), '');
  }
  if (summary && summary.decisions.length) {
    lines.push('## Decisions', ...summary.decisions.map((d) => `- ${d}`), '');
  }
  if (summary && summary.actionItems.length) {
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

async function writePostMeetingDoc(workspaceId: string, folderId: string, meeting: MeetingRow, summary: MeetingSummary | null, turns: TranscriptTurn[]): Promise<string> {
  const markdown = renderDoc(meeting, summary, turns);
  const createdBy = meeting.organizerUserId ?? null;
  if (meeting.postMeetingDocId) {
    const existing = await db.query.docs.findFirst({ where: eq(docs.id, meeting.postMeetingDocId) });
    if (existing) {
      await db.update(docs).set({ markdown, contentHash: contentHash(markdown), updatedAt: new Date() }).where(eq(docs.id, existing.id));
      return existing.id;
    }
  }
  const [doc] = await db.insert(docs).values({
    workspaceId, folderId, projectId: meeting.projectId ?? null,
    path: `${nanoid(10)}.md`, title: `Post-Meeting Notes — ${meeting.title || 'Meeting'}`,
    type: 'doc', markdown, yjsState: emptyYjsState(), contentHash: contentHash(markdown),
    createdBy, updatedBy: createdBy,
  }).returning();
  return doc!.id;
}

export function startMeetingEndWorker(): Worker<MeetingEndJobData> {
  const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });

  const worker = new Worker<MeetingEndJobData>(
    MEETING_END_QUEUE_NAME,
    async (job) => {
      const { meetingId, workspaceId, recallBotId } = job.data;
      const meeting = await db.query.meetings.findFirst({ where: eq(meetings.id, meetingId) });
      if (!meeting) return; // deleted

      // No bot / no Recall creds → nothing to transcribe; skip silently.
      if (!recallBotId || !recallEnabled()) return;

      // ── 1. Transcript ──────────────────────────────────────────────────────
      // Idempotent: if a retry runs after we've already stored the transcript
      // (and possibly purged Recall's media), reuse the stored turns instead of
      // hitting Recall again.
      const stored = await db
        .select({ seq: meetingTranscripts.seq, speaker: meetingTranscripts.speaker, text: meetingTranscripts.text, tsMs: meetingTranscripts.tsMs })
        .from(meetingTranscripts)
        .where(eq(meetingTranscripts.meetingId, meetingId))
        .orderBy(asc(meetingTranscripts.seq));

      let turns: TranscriptTurn[] = stored.map((t) => ({ speaker: t.speaker, text: t.text, tsMs: t.tsMs }));

      if (turns.length === 0) {
        await db.update(meetings).set({ transcriptStatus: 'pending' }).where(eq(meetings.id, meetingId));

        const rec = await getBotRecording(recallBotId);
        if (!rec) throw new Error(`no recording for bot ${recallBotId} yet`);          // retry
        if (!rec.recordingDone) throw new Error(`recording ${rec.recordingId} not done`); // retry

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
        if (downloadUrl) {
          turns = await downloadTranscript(downloadUrl);
          transcriptStatus = 'ready';
        } else if (transcriptStatus !== 'failed') {
          throw new Error('transcript still processing'); // retry — same transcriptId resumes
        }

        if (turns.length) {
          await db.delete(meetingTranscripts).where(eq(meetingTranscripts.meetingId, meetingId));
          await db.insert(meetingTranscripts).values(
            turns.map((t, i) => ({ meetingId, seq: i, speaker: t.speaker, text: t.text, tsMs: t.tsMs })),
          );
        }
        await db.update(meetings).set({ transcriptStatus }).where(eq(meetings.id, meetingId));
      }

      // ── 2. Summary ─────────────────────────────────────────────────────────
      let summary: MeetingSummary | null = null;
      if (turns.length) {
        try {
          summary = await summarise(turns);
          if (summary) await db.update(meetings).set({ summary }).where(eq(meetings.id, meetingId));
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[meeting-end] summarise failed:', err);
        }
      }

      // ── 3. Folder + doc ────────────────────────────────────────────────────
      const folderId = await ensureMeetingFolder(workspaceId, meeting);
      await db.update(meetings).set({ meetingFolderId: folderId }).where(eq(meetings.id, meetingId));
      const docId = await writePostMeetingDoc(workspaceId, folderId, meeting, summary, turns);
      await db.update(meetings).set({ postMeetingDocId: docId }).where(eq(meetings.id, meetingId));

      // All artifacts persisted → purge Recall's stored video + audio so nothing
      // is retained anywhere; Mnema keeps only the transcript text. Best-effort.
      if (turns.length) await deleteBotMedia(recallBotId);
    },
    {
      connection,
      concurrency: 2,
      lockDuration: 5 * 60 * 1000, // in-job transcript poll can run a couple minutes
      stalledInterval: 60 * 1000,
    },
  );

  worker.on('failed', (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[meeting-end] job ${job?.id} failed (attempt ${job?.attemptsMade}):`, err);
    // Final attempt exhausted → mark the meeting's transcript failed so the UI stops "pending".
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      void db.update(meetings).set({ transcriptStatus: 'failed' }).where(eq(meetings.id, job.data.meetingId)).catch(() => {});
    }
  });

  return worker;
}

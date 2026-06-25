/**
 * get_meeting_context — identity of a specific MEETING (title, project, participants,
 * timing), looked up by meeting_id (normal chat use) or recall_bot_id (the live meeting bot
 * uses this at join, M0). Reusable beyond the bot: any agent/chat can scope to a meeting.
 *
 * Workspace-scoped (ctx.tenant_id). Returns only what is recorded — fields may be null
 * (G-DEGRADE: callers drop the missing clause, never fabricate). aclScope marks the
 * least-privilege scope the meeting's content sits in (project, else workspace), which the
 * Aspect-6 brief assembler (M3) uses to ACL-bound spoken output.
 */
import { and, eq } from 'drizzle-orm';
import { withTenant } from '../../db/with-tenant.js';
import * as schema from '../../db/schema.js';
import type { McpAuthContext } from '../auth.js';

const { meetings, meetingParticipants, projects } = schema;

export const GET_MEETING_CONTEXT_TOOL_SPEC = {
  name: 'get_meeting_context',
  description: [
    'Identity of a specific MEETING: its title, project, participants, and timing.',
    'Look it up by meeting_id (normal use) or recall_bot_id (the live bot uses this at join).',
    'Use to scope answers to a meeting — "what meeting is this", "who is in this meeting",',
    'which project it belongs to. Returns only what is recorded; fields may be null.',
  ].join('\n'),
  inputSchema: {
    type: 'object' as const,
    properties: {
      meeting_id: { type: 'string', description: 'Meeting UUID.' },
      recall_bot_id: { type: 'string', description: 'Recall bot id — the live bot lookup at join.' },
    },
  },
  annotations: { readOnlyHint: true, title: 'Get meeting context' },
};

export async function getMeetingContext(
  ctx: McpAuthContext,
  args: Record<string, unknown>,
): Promise<{ content: string; structuredContent: Record<string, unknown> }> {
  const workspaceId = ctx.tenant_id;
  const meetingId = typeof args.meeting_id === 'string' ? args.meeting_id : undefined;
  const recallBotId = typeof args.recall_bot_id === 'string' ? args.recall_bot_id : undefined;
  if (!meetingId && !recallBotId) {
    return { content: 'Provide meeting_id or recall_bot_id.', structuredContent: { error: 'missing_id' } };
  }

  const [m] = await withTenant(workspaceId, tx =>
    tx.select().from(meetings).where(and(
      eq(meetings.workspaceId, workspaceId),
      meetingId ? eq(meetings.id, meetingId) : eq(meetings.recallBotId, recallBotId!),
    )).limit(1));
  if (!m) {
    return { content: 'Meeting not found.', structuredContent: { error: 'not_found' } };
  }

  let projectName: string | null = null;
  if (m.projectId) {
    const [p] = await withTenant(workspaceId, tx =>
      tx.select({ name: projects.name }).from(projects).where(eq(projects.id, m.projectId!)).limit(1));
    projectName = p?.name ?? null;
  }

  const parts = await withTenant(workspaceId, tx =>
    tx.select({ name: meetingParticipants.name, email: meetingParticipants.email, isHost: meetingParticipants.isHost })
      .from(meetingParticipants).where(eq(meetingParticipants.meetingId, m.id)));

  // Least-privilege scope for the room's spoken brief (M3): project if scoped, else workspace.
  const aclScope = m.projectId ? `project:${m.projectId}` : `workspace:${workspaceId}`;
  const names = parts.map(p => p.name).filter((n): n is string => !!n);
  const content = [
    `Meeting: ${m.title || 'untitled'}${projectName ? ` (project: ${projectName})` : ''}.`,
    names.length ? `Participants: ${names.join(', ')}.` : 'No participants recorded yet.',
  ].join(' ');

  return {
    content,
    structuredContent: {
      meetingId: m.id,
      projectId: m.projectId,
      projectName,
      title: m.title,
      status: m.status,
      startedAt: m.startedAt,
      endedAt: m.endedAt,
      participants: parts,
      aclScope,
    },
  };
}

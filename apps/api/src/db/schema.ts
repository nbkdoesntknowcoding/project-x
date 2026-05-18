import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// citext: case-insensitive text. Postgres extension `citext` is enabled in 0000_initial_schema.sql.
const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext';
  },
});

// bytea: binary data column for Yjs state and updates.
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
  toDriver(value: Uint8Array): Buffer {
    return Buffer.from(value);
  },
  fromDriver(value: Buffer): Uint8Array {
    return new Uint8Array(value);
  },
});

// tsvector: full-text search vector. Generated column managed by Postgres.
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

// vector(N): pgvector embedding column.
const vector = (dim: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dim})`;
    },
    toDriver(value: number[]): string {
      return `[${value.join(',')}]`;
    },
    fromDriver(value: string): number[] {
      return value.slice(1, -1).split(',').map(Number);
    },
  });

export const workspaceRole = pgEnum('workspace_role', [
  'owner',
  'admin',
  'editor',
  'viewer',
]);

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  plan: text('plan').notNull().default('free'),
  settings: jsonb('settings').notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  email: citext('email').notNull().unique(),
  displayName: text('display_name'),
  passwordHash: text('password_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
});

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: workspaceRole('role').notNull().default('editor'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workspaceId, table.userId] }),
  }),
);

/**
 * Pending or historical workspace invitations.
 *
 * Each invitation is paired with a signed JWT (token_jti = the JWT's jti
 * claim). The JWT carries the data inline (workspace_id, role, email,
 * inviter); this row is the revocation/acceptance/expiry audit trail.
 * The accept flow validates BOTH the JWT signature AND the row state
 * (not revoked, not already accepted, not expired) before granting access.
 *
 * RLS is enabled in the 0002 migration. The `invitations_pending_idx`
 * partial index makes the per-workspace "show me pending invites" query
 * O(log N) over pending rows only.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    email: citext('email').notNull(),
    role: workspaceRole('role').notNull(),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id),
    tokenJti: text('token_jti').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedBy: uuid('accepted_by').references(() => users.id),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdx: index('invitations_workspace_idx').on(table.workspaceId),
    emailIdx: index('invitations_email_idx').on(table.email),
    pendingIdx: index('invitations_pending_idx')
      .on(table.workspaceId, table.email)
      .where(sql`accepted_at IS NULL AND revoked_at IS NULL`),
  }),
);

export const docs = pgTable(
  'docs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    title: text('title').notNull(),
    markdown: text('markdown').notNull().default(''),
    yjsState: bytea('yjs_state').notNull(),
    yjsStateVector: bytea('yjs_state_vector'),
    contentHash: text('content_hash'),
    createdBy: uuid('created_by').references(() => users.id),
    updatedBy: uuid('updated_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    tsv: tsvector('tsv'),
  },
  (table) => ({
    workspacePathUnique: unique().on(table.workspaceId, table.path),
    workspaceIdx: index('docs_workspace_idx').on(table.workspaceId),
    workspaceUpdatedIdx: index('docs_workspace_updated').on(
      table.workspaceId,
      table.updatedAt.desc(),
    ),
  }),
);

export const docVersions = pgTable(
  'doc_versions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    docId: uuid('doc_id')
      .notNull()
      .references(() => docs.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    markdown: text('markdown').notNull(),
    yjsState: bytea('yjs_state').notNull(),
    yjsUpdate: bytea('yjs_update'),
    authorId: uuid('author_id').references(() => users.id),
    comment: text('comment'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    docVersionUnique: unique().on(table.docId, table.version),
    docIdx: index('doc_versions_doc_idx').on(table.docId, table.version.desc()),
  }),
);

/**
 * Phase 4.2 comments model.
 *
 * Threads carry the Yjs anchor (start + end RelativePositions serialized as
 * BYTEA), the resolved/unresolved state, and the workspace_id used for RLS.
 * Individual replies live in the `comments` table below and are scoped to a
 * thread; the comments policy joins through to comment_threads for tenant
 * isolation rather than duplicating workspace_id on every row.
 *
 * The original Phase-1.2 single-table comments shape (with block_id /
 * parent_id) was scaffolded but never wired into any code path; migration
 * 0004 drops it before recreating these.
 */
export const commentThreads = pgTable(
  'comment_threads',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    docId: uuid('doc_id')
      .notNull()
      .references(() => docs.id, { onDelete: 'cascade' }),
    anchorStart: bytea('anchor_start').notNull(),
    anchorEnd: bytea('anchor_end').notNull(),
    resolved: boolean('resolved').notNull().default(false),
    resolvedBy: uuid('resolved_by').references(() => users.id),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    docIdx: index('comment_threads_doc_idx').on(table.docId, table.resolved),
  }),
);

export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => commentThreads.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
  },
  (table) => ({
    threadIdx: index('comments_thread_idx').on(table.threadId, table.createdAt),
  }),
);

/**
 * Per-user last-seen timestamp for a doc. Drives the "unread comments" dot
 * in the doc list: a doc is unread if there's a comment newer than this
 * row's last_seen_at and authored by someone other than the user.
 */
export const docReadState = pgTable(
  'doc_read_state',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    docId: uuid('doc_id')
      .notNull()
      .references(() => docs.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.docId] }),
  }),
);

export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color'),
  },
  (table) => ({
    workspaceNameUnique: unique().on(table.workspaceId, table.name),
  }),
);

export const docTags = pgTable(
  'doc_tags',
  {
    docId: uuid('doc_id')
      .notNull()
      .references(() => docs.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.docId, table.tagId] }),
    tagIdx: index('doc_tags_tag_idx').on(table.tagId),
  }),
);

export const embeddings = pgTable(
  'embeddings',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    docId: uuid('doc_id')
      .notNull()
      .references(() => docs.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    chunkText: text('chunk_text').notNull(),
    tokenCount: integer('token_count'),
    headingPath: text('heading_path'),
    embedding: vector(1024)('embedding').notNull(),
    model: text('model').notNull(),
    contentHash: text('content_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    chunkUnique: unique().on(table.docId, table.chunkIndex, table.model),
    docIdx: index('embeddings_doc_idx').on(table.docId),
    workspaceIdx: index('embeddings_workspace_idx').on(table.workspaceId),
  }),
);

export const docAcl = pgTable(
  'doc_acl',
  {
    docId: uuid('doc_id')
      .notNull()
      .references(() => docs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    canRead: boolean('can_read').notNull().default(true),
    canWrite: boolean('can_write').notNull().default(true),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.docId, table.userId] }),
  }),
);

export const toolAudit = pgTable(
  'tool_audit',
  {
    id: bigserial('id', { mode: 'number' }).notNull(),
    workspaceId: uuid('workspace_id'),
    userId: uuid('user_id'),
    agentId: text('agent_id'),
    toolName: text('tool_name').notNull(),
    args: jsonb('args').notNull(),
    resultSummary: jsonb('result_summary'),
    latencyMs: integer('latency_ms'),
    status: text('status').notNull(),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceTimeIdx: index('tool_audit_ws_time_idx').on(
      table.workspaceId,
      table.createdAt.desc(),
    ),
    toolIdx: index('tool_audit_tool_idx').on(table.toolName, table.createdAt.desc()),
  }),
);

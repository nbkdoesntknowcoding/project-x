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

export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    docId: uuid('doc_id')
      .notNull()
      .references(() => docs.id, { onDelete: 'cascade' }),
    blockId: text('block_id'),
    parentId: uuid('parent_id'),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    body: text('body').notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    docIdx: index('comments_doc_idx').on(table.docId, table.createdAt.desc()),
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

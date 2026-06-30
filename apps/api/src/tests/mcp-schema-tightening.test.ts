/**
 * Tier 4 — MCP schema tightening regression test (DB-free).
 *
 * Proves the upgraded jsonSchemaToZodShape now PUBLISHES + ENFORCES the JSON-schema
 * `enum`/`minimum`/`maximum` (previously dropped), AND that every previously-valid
 * value still parses (no narrowing) while garbage is rejected. This is the
 * "every valid call still works" safety net the schema-tightening tier requires.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { jsonSchemaToZodShape } from '../mcp/server.js';
import { LIST_PROJECTS_TOOL } from '../mcp/tools/list-projects.js';
import { GET_NEXT_TASK_TOOL, LIST_PROJECT_TASKS_TOOL } from '../mcp/tools/dev/index.js';
import {
  BUILD_KNOWLEDGE_GRAPH_TOOL_SPEC,
  TRAVERSE_GRAPH_TOOL_SPEC,
  GET_GOD_NODES_TOOL_SPEC,
  GET_SURPRISING_CONNECTIONS_TOOL_SPEC,
} from '../mcp/tools/graph.js';
import { ADD_CHART_TOOL_SPEC } from '../mcp/tools/add-chart.js';
import { PROPOSE_DOC_WRITE_TOOL_SPEC } from '../mcp/tools/propose-doc-write.js';

const obj = (spec: { inputSchema: object }) => z.object(jsonSchemaToZodShape(spec.inputSchema)!);
const ok = (s: z.ZodTypeAny, v: unknown) => s.safeParse(v).success;

describe('Tier 4 — enums published + enforced; valid calls preserved', () => {
  it('list_projects.status accepts every real status + omitted; rejects garbage', () => {
    const s = obj(LIST_PROJECTS_TOOL);
    for (const v of ['active', 'paused', 'completed', 'archived', 'all']) expect(ok(s, { status: v })).toBe(true);
    expect(ok(s, {})).toBe(true);                 // default-omitted → handler default 'active'
    expect(ok(s, { status: 'bogus' })).toBe(false);
  });

  it('get_next_task.status enum = backlog|audit_fix (handler-enforced set)', () => {
    const s = obj(GET_NEXT_TASK_TOOL);
    expect(ok(s, { status: 'backlog' })).toBe(true);
    expect(ok(s, { status: 'audit_fix' })).toBe(true);
    expect(ok(s, {})).toBe(true);
    expect(ok(s, { status: 'done' })).toBe(false); // not a get_next_task column
  });

  it('list_project_tasks.status + .priority enums match the board', () => {
    const s = obj(LIST_PROJECT_TASKS_TOOL);
    for (const v of ['backlog', 'in_progress', 'review', 'audit_fix', 'done']) expect(ok(s, { status: v })).toBe(true);
    for (const v of ['low', 'medium', 'high', 'critical']) expect(ok(s, { priority: v })).toBe(true);
    expect(ok(s, { status: 'nope' })).toBe(false);
    expect(ok(s, { priority: 'urgent' })).toBe(false);
  });

  it('build_knowledge_graph.mode enum = normal|deep', () => {
    const s = obj(BUILD_KNOWLEDGE_GRAPH_TOOL_SPEC);
    expect(ok(s, { mode: 'normal' })).toBe(true);
    expect(ok(s, { mode: 'deep' })).toBe(true);
    expect(ok(s, {})).toBe(true);
    expect(ok(s, { mode: 'fast' })).toBe(false);
  });

  it('add_chart.chart_type keeps the donut alias + all canonical types (no narrowing)', () => {
    const s = obj(ADD_CHART_TOOL_SPEC);
    for (const v of ['bar', 'line', 'area', 'scatter', 'pie', 'doughnut', 'donut'])
      expect(ok(s, { doc_id: 'x', chart_type: v })).toBe(true);
    expect(ok(s, { doc_id: 'x', chart_type: 'pie3d' })).toBe(false);
  });

  it('propose_doc_write.operation enum still accepts all real operations (regression)', () => {
    const s = obj(PROPOSE_DOC_WRITE_TOOL_SPEC);
    for (const v of ['append', 'replace_section', 'replace_body', 'create', 'trash_doc'])
      expect(ok(s, { operation: v })).toBe(true);
    expect(ok(s, { operation: 'delete_everything' })).toBe(false);
  });

  it('numeric bounds: god_nodes.limit 1..20, surprising.limit 1..50, traverse.depth 1..10; defaults omittable', () => {
    const god = obj(GET_GOD_NODES_TOOL_SPEC);
    expect(ok(god, { limit: 10 })).toBe(true);
    expect(ok(god, {})).toBe(true);
    expect(ok(god, { limit: 0 })).toBe(false);
    expect(ok(god, { limit: 999 })).toBe(false);

    const sur = obj(GET_SURPRISING_CONNECTIONS_TOOL_SPEC);
    expect(ok(sur, { limit: 50 })).toBe(true);
    expect(ok(sur, { limit: 51 })).toBe(false);

    const tr = obj(TRAVERSE_GRAPH_TOOL_SPEC);
    expect(ok(tr, { from: 'X', depth: 5 })).toBe(true);
    expect(ok(tr, { from: 'X', depth: 0 })).toBe(false);
    expect(ok(tr, { from: 'X', depth: 99 })).toBe(false);
  });
});

/**
 * Semantic extraction (Pass 2) — LLM-powered.
 * Extracts concepts, relationships, and rationale (why) nodes per doc.
 * Also builds pgvector semantically_similar_to edges across all docs.
 */

import OpenAI from 'openai';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';

const { graphNodes, graphEdges, docs, embeddings } = schema;

type Tx = NodePgDatabase<typeof schema>;
type ExtractionMode = 'normal' | 'deep';

const EXTRACTION_PROMPT = (docTitle: string, docContent: string, otherDocTitles: string[]) => `
You are extracting a knowledge graph from a document.

DOCUMENT: "${docTitle}"
CONTENT: ${docContent.slice(0, 6000)}

OTHER DOCUMENTS IN THIS WORKSPACE: ${otherDocTitles.slice(0, 50).join(', ')}

Return ONLY valid JSON:
{
  "concepts": [{ "label": string, "summary": string, "type": "concept"|"decision"|"rationale" }],
  "relationships": [{
    "from": string, "to": string,
    "edge_type": "references"|"implements"|"depends_on"|"informs"|"contradicts"|"supersedes"|"rationale_for"|"semantically_similar_to",
    "provenance": "EXTRACTED"|"INFERRED"|"AMBIGUOUS",
    "confidence_score": number,
    "rationale": string,
    "extracted_from": string
  }],
  "why_nodes": [{ "label": string, "rationale": string, "refers_to": string }]
}

Rules:
- EXTRACTED: found explicitly in text, confidence=1.0
- INFERRED: reasonable inference, confidence 0.5-0.95
- AMBIGUOUS: uncertain, confidence < 0.5
- why_nodes: from decision rationale, inline comments, "we chose X because Y" patterns
`;

interface LLMExtractionResult {
  concepts: Array<{ label: string; summary: string; type: string }>;
  relationships: Array<{
    from: string;
    to: string;
    edge_type: string;
    provenance: string;
    confidence_score: number;
    rationale: string;
    extracted_from: string;
  }>;
  why_nodes: Array<{ label: string; rationale: string; refers_to: string }>;
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function upsertNode(
  db: Tx,
  workspaceId: string,
  entityType: string,
  entityId: string,
  label: string,
  summary?: string,
): Promise<string> {
  const existing = await db
    .select({ id: graphNodes.id })
    .from(graphNodes)
    .where(
      and(
        eq(graphNodes.workspaceId, workspaceId),
        eq(graphNodes.entityType, entityType),
        eq(graphNodes.entityId, entityId),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(graphNodes)
      .set({ label, summary, extractionPass: 'semantic', lastExtractedAt: new Date(), updatedAt: new Date() })
      .where(eq(graphNodes.id, existing[0]!.id));
    return existing[0]!.id;
  }

  const rows = await db
    .insert(graphNodes)
    .values({ workspaceId, entityType, entityId, label, summary, extractionPass: 'semantic', lastExtractedAt: new Date() })
    .returning({ id: graphNodes.id });
  return rows[0]!.id;
}

async function upsertEdge(
  db: Tx,
  workspaceId: string,
  fromNodeId: string,
  toNodeId: string,
  edgeType: string,
  provenance: string,
  confidenceScore: number,
  weight: number,
  rationale?: string,
  extractedFrom?: string,
): Promise<void> {
  await db
    .insert(graphEdges)
    .values({
      workspaceId, fromNodeId, toNodeId, edgeType,
      provenance, confidenceScore, weight,
      rationale: rationale ?? null,
      extractedFrom: extractedFrom ?? null,
    })
    .onConflictDoNothing();
}

// Resolve a label to the nearest matching node ID, or return null
async function resolveLabel(db: Tx, workspaceId: string, label: string): Promise<string | null> {
  const rows = await db
    .select({ id: graphNodes.id })
    .from(graphNodes)
    .where(
      and(
        eq(graphNodes.workspaceId, workspaceId),
        sql`lower(${graphNodes.label}) = lower(${label})`,
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

// ── main export ───────────────────────────────────────────────────────────────

export async function extractSemantic(
  workspaceId: string,
  docId: string,
  db: Tx,
  mode: ExtractionMode = 'normal',
): Promise<{ conceptCount: number; edgeCount: number }> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not set — cannot run semantic extraction');
  }

  // Fetch the doc
  const [doc] = await db
    .select({ id: docs.id, title: docs.title, markdown: docs.markdown })
    .from(docs)
    .where(and(eq(docs.id, docId), eq(docs.workspaceId, workspaceId), isNull(docs.deletedAt)))
    .limit(1);
  if (!doc) throw new Error(`Doc ${docId} not found`);

  // Fetch titles of other docs for context
  const otherDocs = await db
    .select({ title: docs.title })
    .from(docs)
    .where(and(eq(docs.workspaceId, workspaceId), isNull(docs.deletedAt)));
  const otherDocTitles = otherDocs
    .map(d => d.title)
    .filter(t => t !== doc.title);

  // Delete stale INFERRED edges from this doc's node
  const [docNode] = await db
    .select({ id: graphNodes.id })
    .from(graphNodes)
    .where(
      and(
        eq(graphNodes.workspaceId, workspaceId),
        eq(graphNodes.entityType, 'doc'),
        eq(graphNodes.entityId, docId),
      ),
    )
    .limit(1);

  if (docNode) {
    await db
      .delete(graphEdges)
      .where(
        and(
          eq(graphEdges.workspaceId, workspaceId),
          eq(graphEdges.fromNodeId, docNode.id),
          sql`${graphEdges.provenance} != 'EXTRACTED'`,
        ),
      );
  }

  // Call LLM
  const model = mode === 'deep' ? 'gpt-4o' : 'gpt-4o-mini';
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await openai.chat.completions.create({
    model,
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: EXTRACTION_PROMPT(doc.title || 'Untitled', doc.markdown || '', otherDocTitles),
      },
    ],
  });

  const rawText = response.choices[0]?.message?.content ?? '';

  let result: LLMExtractionResult;
  try {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    result = JSON.parse(jsonMatch?.[0] ?? rawText) as LLMExtractionResult;
  } catch {
    result = { concepts: [], relationships: [], why_nodes: [] };
  }

  let conceptCount = 0;
  let edgeCount = 0;

  // Ensure the doc node exists
  const docNodeId = await upsertNode(db, workspaceId, 'doc', docId, doc.title || 'Untitled');

  // Upsert concept nodes
  const conceptNodeMap = new Map<string, string>(); // label → nodeId
  for (const concept of result.concepts ?? []) {
    if (!concept.label) continue;
    const entityId = `${workspaceId}-${concept.label.toLowerCase().replace(/\s+/g, '-')}`;
    const nodeId = await upsertNode(
      db, workspaceId, concept.type || 'concept', entityId, concept.label, concept.summary,
    );
    conceptNodeMap.set(concept.label.toLowerCase(), nodeId);
    conceptCount++;
  }

  // Upsert why_nodes (rationale nodes)
  for (const why of result.why_nodes ?? []) {
    if (!why.label) continue;
    const entityId = `${workspaceId}-why-${why.label.toLowerCase().replace(/\s+/g, '-')}`;
    const nodeId = await upsertNode(db, workspaceId, 'rationale', entityId, why.label, why.rationale);
    conceptNodeMap.set(why.label.toLowerCase(), nodeId);
    conceptCount++;

    // rationale_for edge: why_node → refers_to concept
    const refId = why.refers_to
      ? (conceptNodeMap.get(why.refers_to.toLowerCase()) ?? await resolveLabel(db, workspaceId, why.refers_to))
      : null;
    if (refId) {
      await upsertEdge(db, workspaceId, nodeId, refId, 'rationale_for', 'INFERRED', 0.9, 1.0, why.rationale);
      edgeCount++;
    }
  }

  // Upsert relationship edges
  for (const rel of result.relationships ?? []) {
    if (!rel.from || !rel.to || !rel.edge_type) continue;

    // Resolve from/to: try concept map first, then DB label lookup, then doc node as fallback
    const fromId = conceptNodeMap.get(rel.from.toLowerCase())
      ?? await resolveLabel(db, workspaceId, rel.from)
      ?? (rel.from.toLowerCase() === (doc.title || '').toLowerCase() ? docNodeId : null);

    const toId = conceptNodeMap.get(rel.to.toLowerCase())
      ?? await resolveLabel(db, workspaceId, rel.to)
      ?? (rel.to.toLowerCase() === (doc.title || '').toLowerCase() ? docNodeId : null);

    if (!fromId || !toId || fromId === toId) continue;

    const weight = rel.provenance === 'EXTRACTED' ? 1.0 : 0.8;
    await upsertEdge(
      db, workspaceId, fromId, toId,
      rel.edge_type, rel.provenance || 'INFERRED',
      rel.confidence_score ?? 0.8, weight,
      rel.rationale, rel.extracted_from,
    );
    edgeCount++;
  }

  // Mark doc as extracted
  await db
    .update(graphNodes)
    .set({ lastExtractedAt: new Date(), extractionPass: 'semantic', updatedAt: new Date() })
    .where(eq(graphNodes.id, docNodeId));

  return { conceptCount, edgeCount };
}

// ── pgvector semantic similarity edges ────────────────────────────────────────

export async function buildSimilarityEdges(
  workspaceId: string,
  db: Tx,
): Promise<number> {
  // Raw SQL for the vector cosine similarity query.
  // Embeddings live in the separate `embeddings` table (not on docs directly).
  // We pick the most recent embedding per doc via DISTINCT ON.
  const rows = await db.execute<{ from_id: string; to_id: string; similarity: number }>(
    sql`
      WITH doc_vecs AS MATERIALIZED (
        SELECT doc_id, avg(embedding)::vector AS embedding
        FROM embeddings
        WHERE workspace_id = ${workspaceId}
        GROUP BY doc_id
      )
      SELECT a.doc_id as from_id, b.doc_id as to_id,
             1 - (a.embedding <=> b.embedding) as similarity
      FROM doc_vecs a JOIN doc_vecs b ON a.doc_id < b.doc_id
      WHERE 1 - (a.embedding <=> b.embedding) > 0.85
      ORDER BY similarity DESC LIMIT 100
    `,
  );

  let edgeCount = 0;
  for (const row of rows.rows) {
    // Resolve doc nodes
    const [fromNode] = await db
      .select({ id: graphNodes.id })
      .from(graphNodes)
      .where(and(eq(graphNodes.workspaceId, workspaceId), eq(graphNodes.entityType, 'doc'), eq(graphNodes.entityId, row.from_id)))
      .limit(1);
    const [toNode] = await db
      .select({ id: graphNodes.id })
      .from(graphNodes)
      .where(and(eq(graphNodes.workspaceId, workspaceId), eq(graphNodes.entityType, 'doc'), eq(graphNodes.entityId, row.to_id)))
      .limit(1);

    if (!fromNode || !toNode) continue;

    await upsertEdge(
      db, workspaceId, fromNode.id, toNode.id,
      'semantically_similar_to', 'INFERRED',
      row.similarity, row.similarity,
      `Cosine similarity: ${(row.similarity * 100).toFixed(1)}%`,
    );
    edgeCount++;
  }
  return edgeCount;
}

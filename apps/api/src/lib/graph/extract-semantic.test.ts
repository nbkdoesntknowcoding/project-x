/**
 * A2.6 — unit tests for the pure graph-extraction helpers (fuzzy dedup + chunking).
 * The LLM/DB paths need live services; here we lock the deterministic logic.
 */
import { describe, it, expect } from 'vitest';
import { normalizeLabel, compactLabel, conceptSlug, chunkMarkdown } from './extract-semantic.js';

describe('normalizeLabel (fuzzy concept dedup)', () => {
  it('collapses case / punctuation / whitespace variants to one key', () => {
    const k = normalizeLabel('Voice Clone');
    expect(normalizeLabel('voice clone')).toBe(k);
    expect(normalizeLabel('Voice-Clone')).toBe(k);
    expect(normalizeLabel('  Voice   Clone  ')).toBe(k);
    expect(normalizeLabel('VOICE_CLONE')).toBe(k);
  });
  it('keeps distinct concepts distinct', () => {
    expect(normalizeLabel('Voice Clone')).not.toBe(normalizeLabel('Voice Agent'));
  });
  it('handles empty / nullish input', () => {
    expect(normalizeLabel('')).toBe('');
    expect(normalizeLabel(undefined as unknown as string)).toBe('');
  });
});

describe('compactLabel (SQL-side match form)', () => {
  it('strips everything non-alphanumeric', () => {
    expect(compactLabel('Voice-Clone v2!')).toBe('voiceclonev2');
    expect(compactLabel('voice clone v2')).toBe('voiceclonev2');
  });
});

describe('conceptSlug', () => {
  it('produces a stable workspace-scoped slug, dedup-equal across variants', () => {
    const ws = 'ws-123';
    expect(conceptSlug(ws, 'Voice Clone')).toBe('ws-123-voice-clone');
    expect(conceptSlug(ws, 'Voice-Clone')).toBe(conceptSlug(ws, 'voice clone'));
  });
});

describe('chunkMarkdown (whole-doc extraction)', () => {
  it('returns a single chunk when under size', () => {
    expect(chunkMarkdown('short', 6000)).toEqual(['short']);
  });
  it('splits long docs and respects maxChunks', () => {
    const md = 'x'.repeat(20000);
    const chunks = chunkMarkdown(md, 6000, 4);
    expect(chunks.length).toBe(4);                 // capped (would be 4 here anyway)
    expect(chunks[0].length).toBe(6000);
    expect(chunks.join('').length).toBeLessThanOrEqual(20000);
  });
  it('caps coverage and drops the tail beyond maxChunks', () => {
    const md = 'y'.repeat(60000);                  // 10 chunks worth
    const chunks = chunkMarkdown(md, 6000, 4);
    expect(chunks.length).toBe(4);                 // only first 24000 chars covered
  });
  it('handles empty input', () => {
    expect(chunkMarkdown('', 6000)).toEqual(['']);
  });
});

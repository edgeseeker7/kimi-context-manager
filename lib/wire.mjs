#!/usr/bin/env node
/**
 * kimi-context-manager — wire.jsonl access layer ("the swap").
 *
 * Session discovery convention (ours, not kimi-code's): the currently active
 * session is the wire.jsonl with the newest mtime under
 * $KIMI_CODE_HOME/sessions/*-/*- /agents/*- /wire.jsonl. One CLI process
 * serves one active session in practice; multi-session mixing is accepted for
 * M1 (ponytail: revisit when it actually bites).
 *
 * seq = 0-based line number in wire.jsonl. Lines are append-only, so seqs are
 * stable within a session and history_read can range-read them directly.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tokenize, topTerms } from './tokens.mjs';

const KIMI_HOME = process.env.KIMI_CODE_HOME ?? `${process.env.HOME}/.kimi-code`;
const DISCOVERY_TTL_MS = 5000;
let cachedWire = null;
let cachedAt = 0;

/** Newest wire.jsonl under the sessions tree (mtime desc), cached briefly. */
export function activeWirePath() {
  const now = Date.now();
  if (cachedWire !== null && now - cachedAt < DISCOVERY_TTL_MS) return cachedWire;
  let best = null;
  let bestMtime = -1;
  const sessionsDir = join(KIMI_HOME, 'sessions');
  for (const ws of safeReadDir(sessionsDir)) {
    for (const ses of safeReadDir(join(sessionsDir, ws))) {
      for (const agent of safeReadDir(join(sessionsDir, ws, ses, 'agents'))) {
        const candidate = join(sessionsDir, ws, ses, 'agents', agent, 'wire.jsonl');
        try {
          const mtime = statSync(candidate).mtimeMs;
          if (mtime > bestMtime) {
            bestMtime = mtime;
            best = candidate;
          }
        } catch {
          // not a regular file — skip
        }
      }
    }
  }
  cachedWire = best;
  cachedAt = now;
  return best;
}

/** Stable key of the active session (for pins/notes namespacing). */
export function activeSessionKey() {
  const wire = activeWirePath();
  if (wire === null) return 'no-session';
  const parts = wire.split('/');
  // .../sessions/<ws>/<ses>/agents/<agent>/wire.jsonl
  return parts
    .slice(-5, -1)
    .filter((part) => part !== 'agents')
    .join('_')
    .replace(/[^a-zA-Z0-9_-]/g, '_');
}

function safeReadDir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Lazily read + cache the wire lines (cheap: files are MBs, reads are per call). */
export function wireLines(path) {
  try {
    return readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/** Plain text of one wire record, or '' when it carries no model-visible text. */
export function recordText(line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return '';
  }
  const type = record.type;
  if (type === 'context.append_message' || type === 'prompt.accepted') {
    const msg = record.message ?? record;
    return contentText(msg.content);
  }
  if (type === 'context.append_loop_event') {
    const event = record.event ?? {};
    if (event.type === 'content.part') {
      const part = event.part ?? {};
      return part.text ?? part.think ?? '';
    }
    if (event.type === 'tool.call') {
      return `${event.name ?? ''} ${JSON.stringify(event.arguments ?? {})}`;
    }
    if (event.type === 'tool.result') {
      return contentText(event.content ?? event.result);
    }
  }
  return '';
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (typeof block === 'string' ? block : (block?.text ?? '')))
    .filter(Boolean)
    .join('\n');
}

const MEMORY_TOOL_NAMES = new Set([
  'history_search',
  'history_read',
  'context_alloc',
  'context_free',
  'context_list',
  'notes_append',
  'notes_read',
]);

/** Type tag of a wire line for self-loop exclusion. */
function recordType(line) {
  const i = line.indexOf('"type":"');
  if (i < 0) return '';
  const rest = line.slice(i + 8);
  return rest.slice(0, rest.indexOf('"'));
}

const DEDUPE_JACCARD = 0.6;
const MAX_MATCHES = 50;

/**
 * BM25-lite token search over wire.jsonl (ported from dsh-context-manager
 * history.js: CJK-bigram tokenization, phrase tier, echo demotion, Jaccard
 * dedupe). Returns { matches: [{seq, snippet, score, matched, type}], scanned }.
 */
export function wireSearch(path, { query, limit = 10, beforeSeq } = {}) {
  const lines = wireLines(path);
  const needle = String(query ?? '').toLowerCase();
  const terms = tokenize(query);
  const termSet = new Set(terms);
  const cap = Math.max(1, Math.min(Math.trunc(limit) || 10, MAX_MATCHES));
  if (terms.length === 0) return { matches: [], scanned: 0 };
  const lastSeq = lines.length - 1;
  const scanFrom = beforeSeq === undefined ? lastSeq : Math.min(Math.max(Math.trunc(beforeSeq) - 1, -1), lastSeq);
  // Current-turn exclusion (same contract as dsh): events after the latest
  // user message are the in-flight turn itself — already in the caller's
  // context, and its query echo would top the results otherwise.
  let turnStart = Number.POSITIVE_INFINITY;
  if (beforeSeq === undefined) {
    for (let seq = lastSeq; seq >= 0; seq -= 1) {
      const line = lines[seq];
      if (line.includes('"context.append_message"') && line.includes('"role":"user"')) {
        turnStart = seq;
        break;
      }
    }
  }

  const candidates = [];
  const docFreq = new Map();
  let scanned = 0;
  for (let seq = scanFrom; seq >= 0; seq -= 1) {
    if (seq > turnStart) continue;
    scanned += 1;
    const line = lines[seq];
    const type = recordType(line);
    if (type === 'metadata') continue;
    const text = recordText(line);
    if (text.length === 0) continue;
    const lower = text.toLowerCase();
    const phraseIndex = needle.length >= 2 ? lower.indexOf(needle) : -1;
    const tf = new Map();
    let anchorIndex = phraseIndex;
    for (const token of tokenize(text)) {
      if (termSet.has(token)) {
        tf.set(token, (tf.get(token) ?? 0) + 1);
        if (anchorIndex < 0) anchorIndex = lower.indexOf(token);
      }
    }
    for (const token of tf.keys()) docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
    const normalizedText = text.replace(/\s+/g, ' ').trim().toLowerCase();
    const echo = phraseIndex >= 0 && normalizedText === needle.replace(/\s+/g, ' ').trim();
    const tier = echo ? 1 : phraseIndex >= 0 ? 0 : tf.size > 0 ? 1 : 3;
    if (tier === 3) continue;
    candidates.push({ seq, type, tier, tf, matched: tf.size, echo, textLength: text.length, anchorIndex, snippet: snippetOf(text, anchorIndex) });
  }

  const total = Math.max(scanned, 1);
  for (const c of candidates) {
    let score = 0;
    for (const [token, count] of c.tf) {
      const df = docFreq.get(token) ?? 1;
      score += count * Math.log(1 + (total - df + 0.5) / (df + 0.5));
    }
    if (c.echo) score *= 0.1;
    c.score = score;
  }
  const bestTier = candidates.reduce((best, c) => Math.min(best, c.tier), 3);
  const pool = candidates.filter((c) => c.tier === bestTier);
  pool.sort((a, b) =>
    a.tier !== b.tier ? a.tier - b.tier
    : a.score !== b.score ? b.score - a.score
    : a.matched !== b.matched ? b.matched - a.matched
    : a.textLength !== b.textLength ? a.textLength - b.textLength
    : b.seq - a.seq,
  );

  const kept = [];
  const overflow = [];
  for (const c of pool) {
    c.tokens = new Set(tokenize(c.snippet));
    const dupe = kept.some((k) => jaccard(k.tokens, c.tokens) >= DEDUPE_JACCARD);
    (dupe ? overflow : kept).push(c);
  }
  const matches = [...kept, ...overflow].slice(0, cap).map((c) => ({
    seq: c.seq,
    type: c.type,
    score: Math.round(c.score * 1000) / 1000,
    matched: c.matched,
    echo: c.echo,
    snippet: c.snippet,
  }));
  // results-mention tail: high-frequency anchors in the hit set, minus query terms
  const mentionText = matches.map((m) => m.snippet).join('\n');
  const mentions = topTerms(mentionText, 5).filter((t) => !termSet.has(t));
  return { matches, scanned, mentions };
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

const SNIPPET_RADIUS = 120;
function snippetOf(text, anchorIndex) {
  if (anchorIndex < 0) return `${text.slice(0, SNIPPET_RADIUS * 2)}…`;
  const from = Math.max(0, anchorIndex - SNIPPET_RADIUS);
  const to = Math.min(text.length, anchorIndex + SNIPPET_RADIUS);
  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`;
}

const READ_MAX_EVENTS = 200;

/**
 * Range read of wire lines with a char budget and an in-event char cursor
 * (ported semantics: oversized events continue via offset, never dropped whole).
 */
export function wireRead(path, { fromSeq, toSeq, offset = 0, maxChars = 60000 }) {
  const lines = wireLines(path);
  const from = Math.max(0, Math.trunc(fromSeq) || 0);
  const to = Math.min(lines.length - 1, Math.trunc(toSeq) || from);
  const events = [];
  let chars = 0;
  let truncated = false;
  const cap = Math.min(to - from + 1, READ_MAX_EVENTS);
  for (let i = 0; i < cap; i += 1) {
    const seq = from + i;
    let text = recordText(lines[seq]);
    if (text.length === 0) text = lines[seq].slice(0, 500);
    if (i === 0 && offset > 0) text = text.slice(offset);
    if (chars + text.length > maxChars) {
      const room = maxChars - chars;
      events.push({ seq, text: text.slice(0, room) });
      truncated = true;
      break;
    }
    chars += text.length;
    events.push({ seq, text });
  }
  const lastEmitted = events.length > 0 ? events[events.length - 1].seq : from - 1;
  const cont = truncated
    ? { nextFromSeq: lastEmitted, nextOffset: offset + (events.length > 0 ? events[events.length - 1].text.length : 0) }
    : to < lines.length - 1 && events.length - 1 < cap - 1
      ? { nextFromSeq: lastEmitted + 1, nextOffset: 0 }
      : null;
  return { events, scanned: to - from + 1, truncated, continue: cont, total: lines.length };
}

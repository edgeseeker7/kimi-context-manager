/**
 * kimi-context-manager — pins (vault) + notes (diary) persistence.
 *
 * Same semantics as dsh-context-manager: pins are verbatim facts pinned into
 * an always-visible table (task scope = this session, permanent = all
 * sessions); notes are a structured JSONL diary (id, tags, supersedes chains).
 * Files live under ~/.kimi-code/context-manager/<sessionKey>/.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.env.KIMI_CODE_HOME ?? `${process.env.HOME}/.kimi-code`, 'context-manager');

function sessionDir(sessionKey) {
  const dir = join(ROOT, sessionKey);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function pinsPath(sessionKey) {
  return join(sessionDir(sessionKey), 'pins.json');
}

function notesPath(sessionKey) {
  return join(sessionDir(sessionKey), 'notes.jsonl');
}

/** Rough CJK-aware token estimate (≈ dsh estimateTokens semantics). */
function estimateTokens(text) {
  let count = 0;
  for (const ch of String(text)) {
    count += /[⺀-鿿豈-﫿　-〿＀-￯]/.test(ch) ? 1 : 0.25;
  }
  return Math.ceil(count);
}

const PIN_BUDGET_TOKENS = 20000;

export function pinAlloc(sessionKey, { text, label, scope = 'task' }) {
  const pins = readPins(sessionKey);
  const used = pins.reduce((sum, pin) => sum + pin.tokens, 0);
  const tokens = estimateTokens(text);
  if (used + tokens > PIN_BUDGET_TOKENS) {
    return { ok: false, error: `pin budget exceeded: ${used}+${tokens} > ${PIN_BUDGET_TOKENS}` };
  }
  const handle = `${scope === 'permanent' ? 'w' : 't'}${pins.filter((p) => p.scope === scope).length + 1}`;
  pins.push({ handle, label: label ?? String(text).split('\n')[0].slice(0, 200), text: String(text), scope, tokens, createdAt: Date.now() });
  writePins(sessionKey, pins);
  return { ok: true, handle, used: used + tokens, budget: PIN_BUDGET_TOKENS };
}

export function pinFree(sessionKey, { handle }) {
  const pins = readPins(sessionKey);
  const index = pins.findIndex((pin) => pin.handle === handle);
  if (index < 0) return { ok: false, error: `no such pin: ${handle}` };
  pins.splice(index, 1);
  writePins(sessionKey, pins);
  return { ok: true };
}

export function pinList(sessionKey) {
  const pins = readPins(sessionKey);
  const used = pins.reduce((sum, pin) => sum + pin.tokens, 0);
  return { pins, used, budget: PIN_BUDGET_TOKENS };
}

function readPins(sessionKey) {
  try {
    return JSON.parse(readFileSync(pinsPath(sessionKey), 'utf8'));
  } catch {
    return [];
  }
}

function writePins(sessionKey, pins) {
  writeFileSync(pinsPath(sessionKey), JSON.stringify(pins, null, 1));
}

/** Permanent pins from a shared (cross-session) file. */
export function permanentPins() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'pins-permanent.json'), 'utf8'));
  } catch {
    return [];
  }
}

let noteCounter = null;

export function noteAppend(sessionKey, { text, tags = [], supersedes = [] }) {
  if (noteCounter === null) noteCounter = readNotes(sessionKey).length;
  noteCounter += 1;
  const entry = { id: `n${noteCounter}`, ts: new Date().toISOString(), text: String(text), tags, supersedes };
  appendFileSync(notesPath(sessionKey), `${JSON.stringify(entry)}\n`);
  return { ok: true, id: entry.id };
}

export function noteRead(sessionKey, { tag, id, listTags = false } = {}) {
  const notes = readNotes(sessionKey);
  const superseded = new Set(notes.flatMap((n) => n.supersedes ?? []));
  const active = notes.filter((n) => !superseded.has(n.id));
  if (id) {
    const found = notes.find((n) => n.id === id);
    return found ? { note: found, superseded: superseded.has(id) } : { error: `no such note: ${id}` };
  }
  if (listTags) {
    const counts = {};
    for (const n of active) for (const t of n.tags ?? []) counts[t] = (counts[t] ?? 0) + 1;
    return { tags: counts, active: active.length };
  }
  const filtered = tag ? active.filter((n) => (n.tags ?? []).includes(tag)) : active;
  return { notes: filtered, active: active.length, total: notes.length };
}

function readNotes(sessionKey) {
  const path = notesPath(sessionKey);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

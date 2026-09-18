#!/usr/bin/env node
/**
 * kimi-context-manager — MCP stdio server.
 *
 * Seven tools, same names/semantics as dsh-context-manager so the operating
 * manual (system prompts, checkpoint text) carries over verbatim.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { noteAppend, noteRead, pinAlloc, pinFree, pinList } from './memory.mjs';
import { activeSessionKey, activeWirePath, wireRead, wireSearch } from './wire.mjs';

const server = new McpServer({ name: 'kimi-context-manager', version: '0.1.0' });

function out(payload) {
  return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) }] };
}

function requireWire() {
  const wire = activeWirePath();
  if (wire === null) throw new Error('no active kimi-code session found (no wire.jsonl under ~/.kimi-code/sessions)');
  return wire;
}

server.registerTool(
  'context_alloc',
  {
    description:
      'Pin a VERBATIM fact (exact version, constraint, credential path, ID, user mandate) into the always-visible vault. scope "task" (default) = this session; "permanent" survives across sessions. Use ONLY for facts where one wrong character breaks things.',
    inputSchema: {
      text: z.string().describe('The exact verbatim text to pin'),
      label: z.string().optional().describe('Short label for the allocation table'),
      scope: z.enum(['task', 'permanent']).optional(),
    },
  },
  ({ text, label, scope }) => out(pinAlloc(activeSessionKey(), { text, label, scope })),
);

server.registerTool(
  'context_free',
  { description: 'Free one pin from the vault by handle (e.g. t1, w2) the moment it goes stale.', inputSchema: { handle: z.string() } },
  ({ handle }) => out(pinFree(activeSessionKey(), { handle })),
);

server.registerTool(
  'context_list',
  { description: 'Show the vault allocation table: every pin with handle, label, size, plus total usage against the quota.', inputSchema: {} },
  () => out(pinList(activeSessionKey())),
);

server.registerTool(
  'notes_append',
  {
    description:
      'Append a durable note that survives context resets and compactions. Record key decisions and WHY, user constraints, important paths/IDs, dead ends already ruled out. tags file the note into buckets; supersedes replaces earlier notes (they fold away but stay auditable).',
    inputSchema: {
      text: z.string(),
      tags: z.array(z.string()).optional(),
      supersedes: z.array(z.string()).optional(),
    },
  },
  ({ text, tags, supersedes }) => out(noteAppend(activeSessionKey(), { text, tags, supersedes })),
);

server.registerTool(
  'notes_read',
  {
    description:
      'Read durable notes. listTags enumerates buckets; tag reads one bucket; id fetches one note verbatim (including superseded).',
    inputSchema: { tag: z.string().optional(), id: z.string().optional(), listTags: z.boolean().optional() },
  },
  ({ tag, id, listTags }) => out(noteRead(activeSessionKey(), { tag, id, listTags })),
);

server.registerTool(
  'history_search',
  {
    description:
      'Search the session FULL history (wire.jsonl — nothing is ever deleted; compaction only shadows events from the context surface). Take query entities (identifiers, numbers, error strings, exact names) VERBATIM from the question; several terms that must all appear beat one long paraphrase. Returns seq anchors for history_read.',
    inputSchema: {
      query: z.string(),
      limit: z.number().optional(),
      beforeSeq: z.number().optional().describe('Only consider events before this seq'),
    },
  },
  ({ query, limit, beforeSeq }) => out(wireSearch(requireWire(), { query, limit, beforeSeq })),
);

server.registerTool(
  'history_read',
  {
    description:
      'Read an exact range of the session history back as message text, including turns removed from the context by compaction. Find seq anchors with history_search first. Long output is truncated with the exact continuation cursor.',
    inputSchema: {
      fromSeq: z.number(),
      toSeq: z.number(),
      offset: z.number().optional().describe('Char cursor into the first event, for continuing an oversized event'),
    },
  },
  ({ fromSeq, toSeq, offset }) => out(wireRead(requireWire(), { fromSeq, toSeq, offset })),
);

await server.connect(new StdioServerTransport());

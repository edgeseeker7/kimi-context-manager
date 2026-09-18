# kimi-context-manager

Explicit context-memory subsystem for [Kimi Code](https://github.com/MoonshotAI/kimi-code), as an MCP server — a port of [dsh-context-manager](https://github.com/edgeseeker7/dsh-context-manager)'s memory model.

## What it gives the agent

| Tool | Layer | Purpose |
|---|---|---|
| `context_alloc` / `context_free` / `context_list` | vault | Pin VERBATIM facts (versions, constraints, IDs) that no compaction can shadow |
| `notes_append` / `notes_read` | diary | Structured durable notes (tags, supersedes chains) surviving resets |
| `history_search` / `history_read` | swap | CJK-aware BM25 search + range read over the full `wire.jsonl` (compaction only shadows events; the log keeps everything) |

## Install

```json
// ~/.kimi-code/mcp.json
{
  "mcpServers": {
    "context-manager": {
      "command": "node",
      "args": ["/path/to/kimi-context-manager/lib/server.mjs"]
    }
  }
}
```

New sessions then see the seven tools. Session discovery convention: the active
session is the newest `~/.kimi-code/sessions/*/*/agents/*/wire.jsonl` by mtime;
pins/notes persist under `~/.kimi-code/context-manager/<sessionKey>/`.

## Test

```
npm install && npm run check
```

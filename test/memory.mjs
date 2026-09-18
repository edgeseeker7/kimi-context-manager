/* pins + notes persistence semantics. Uses a throwaway KIMI_CODE_HOME. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.KIMI_CODE_HOME = mkdtempSync(join(tmpdir(), 'kcm-test-'));
const { noteAppend, noteRead, pinAlloc, pinFree, pinList } = await import('../lib/memory.mjs');

let passed = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.log(`FAIL ${name}`);
  }
}

const S = 'test-session';

const a1 = pinAlloc(S, { text: 'exact version 1.10.0-kis.1', scope: 'task' });
ok(a1.ok && a1.handle === 't1', 'pin alloc t1');
const a2 = pinAlloc(S, { text: 'do not leak kis to github', scope: 'permanent' });
ok(a2.ok && a2.handle === 'w1', 'pin alloc w1');
const lst = pinList(S);
ok(lst.pins.length === 2 && lst.used > 0, 'pin list shows two');
ok(pinFree(S, { handle: 't1' }).ok, 'pin free t1');
ok(pinList(S).pins.length === 1, 'pin list after free');
ok(!pinFree(S, { handle: 'nope' }).ok, 'free unknown handle fails honestly');

const n1 = noteAppend(S, { text: 'decision: use MCP server, zero source change', tags: ['design'] });
ok(n1.ok && n1.id === 'n1', 'note n1');
const n2 = noteAppend(S, { text: 'correction: one file per session', tags: ['design'], supersedes: ['n1'] });
ok(n2.id === 'n2', 'note n2');
const read = noteRead(S);
ok(read.notes.length === 1 && read.notes[0].id === 'n2' && read.total === 2, 'superseded folds away but counts');
ok(noteRead(S, { id: 'n1' }).note.id === 'n1', 'id fetch bypasses fold');
ok(noteRead(S, { listTags: true }).tags.design === 1, 'listTags counts active only');
ok(noteRead(S, { tag: 'design' }).notes.length === 1, 'tag filter');

rmSync(process.env.KIMI_CODE_HOME, { recursive: true, force: true });
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

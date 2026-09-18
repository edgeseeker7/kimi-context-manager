/* wire.jsonl search/read against a synthetic wire fixture. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'kcm-wire-'));
process.env.KIMI_CODE_HOME = HOME;
const wireDir = join(HOME, 'sessions', 'wd_test_1', 'ses_1', 'agents', 'main');
mkdirSync(wireDir, { recursive: true });
const WIRE = join(wireDir, 'wire.jsonl');
writeFileSync(
  WIRE,
  [
    JSON.stringify({ type: 'metadata', protocol_version: '1.5' }),
    JSON.stringify({ type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: '美规水晶盒的尺寸数据是多少' }] } }),
    JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: '美规内盒 USNS011 长 45cm 宽 30cm 高 20cm。' } } }),
    JSON.stringify({ type: 'context.append_loop_event', event: { type: 'tool.call', name: 'Bash', arguments: { command: 'ls /tmp' } } }),
    JSON.stringify({ type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: '青瓷的良品率现在多少' }] } }),
    JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: '青瓷良品率卡在 82%, 主要是釉面气泡。' } } }),
    JSON.stringify({ type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: '帮我查一下之前说过的内容' }] } }),
    '',
  ].join('\n'),
);

const { activeWirePath, activeSessionKey, wireRead, wireSearch } = await import('../lib/wire.mjs');

let passed = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.log(`FAIL ${name}`);
  }
}

ok(activeWirePath() === WIRE, 'discovers the only wire.jsonl');
ok(activeSessionKey().startsWith('wd_test_1_ses_1'), 'session key from path');

const r1 = wireSearch(WIRE, { query: 'USNS011 尺寸', limit: 5 });
ok(r1.matches.some((mt) => mt.seq === 2), 'finds the USNS011 event');
const r2 = wireSearch(WIRE, { query: '青瓷 良品率', limit: 5 });
ok(r2.matches.some((mt) => mt.seq === 5), 'CJK query hits ceramics event');
const r3 = wireSearch(WIRE, { query: '不存在的东西xyz', limit: 5 });
ok(r3.matches.length === 0, 'absent topic returns empty');

const rd = wireRead(WIRE, { fromSeq: 1, toSeq: 2 });
ok(rd.events.length === 2 && rd.events[0].text.includes('水晶盒'), 'range read returns text');
ok(rd.total === 7, 'total line count');

rmSync(HOME, { recursive: true, force: true });
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

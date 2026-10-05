import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonLines } from '../scripts/github-control-direct.mjs';

test('reads complete Fly records from consecutive pretty JSON objects', () => {
  const events = [
    {timestamp:'2026-10-05T11:44:00Z',instance:'machine1',message:'[CheckinShoutout] { status: "sent" }',meta:{Error:{Code:0,Message:''}}},
    {timestamp:'2026-10-05T11:44:01Z',instance:'machine2',message:'escaped \\"quote\\" and } brace',meta:{Error:{Code:0,Message:''}}},
  ];
  assert.deepEqual(parseJsonLines(events.map(x=>JSON.stringify(x,null,2)).join('\n')),events);
});
test('supports JSONL, arrays, concatenated objects, and plain warnings', () => {
  const events=[{message:'one'},{message:'two'}];
  assert.deepEqual(parseJsonLines(events.map(x=>JSON.stringify(x)).join('\n')),events);
  assert.deepEqual(parseJsonLines(JSON.stringify(events,null,2)),events);
  assert.deepEqual(parseJsonLines(events.map(x=>JSON.stringify(x)).join('')),events);
  assert.deepEqual(parseJsonLines('warning\n'+JSON.stringify(events[0])),[{message:'warning'},events[0]]);
});
test('nested Error metadata cannot become a fake application error', () => {
  const input={level:'info',message:'check-in sent',meta:{Error:{Code:0,Message:''}}};
  const rows=parseJsonLines(JSON.stringify(input,null,2));
  assert.equal(rows.length,1);
  assert.equal(rows.filter(x=>/error|failed/i.test(x.message)).length,0);
});
test('incomplete records are reported without leaking a partial payload', () => {
  const rows=parseJsonLines('{\n"message": "private test data');
  assert.deepEqual(rows,[{message:'[Incomplete Fly log record skipped]'}]);
});

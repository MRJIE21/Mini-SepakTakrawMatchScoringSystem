import assert from 'node:assert/strict';
import { fmtDateTime, compareScheduledMatches } from '../web/js/dateTime.js';

process.env.TZ = 'Asia/Shanghai';
assert.equal(fmtDateTime('2026-10-06T11:03:00.000Z'), '2026-10-06 19:03');
assert.equal(fmtDateTime('2026-10-06T16:03:00Z'), '2026-10-07 00:03');
assert.equal(fmtDateTime('2026-10-06T19:03:00+08:00'), '2026-10-06 19:03');
assert.equal(fmtDateTime('2026-10-07 09:00'), '2026-10-07 09:00');
assert.equal(fmtDateTime('2026-10-07T09:00'), '2026-10-07 09:00');
assert.equal(fmtDateTime('2026-10-06 19:03:22'), '2026-10-06 19:03');
assert.equal(fmtDateTime(null), '');
assert.equal(fmtDateTime('invalidZ'), 'invalidZ');
console.log('PASS 8 本地时间、跨日、显式偏移与计划时间检查');

const matches = [
  { id: 4, scheduled_at: '', stage_id: 2 },
  { id: 3, scheduled_at: null, stage_id: 1 },
  { id: 2, scheduled_at: '2026-10-07T11:30', stage_id: 2 },
  { id: 1, scheduled_at: '2026-10-07 09:00', stage_id: 1 },
];
assert.deepEqual(matches.sort(compareScheduledMatches).map((m) => m.id), [1, 2, 3, 4]);
assert.ok(compareScheduledMatches({ id: 1, scheduled_at: '  ' }, { id: 2, scheduled_at: '2026-10-07 09:00' }) > 0);
assert.ok(compareScheduledMatches({ stage_id: 1, round_no: 1, seq: 2 }, { stage_id: 1, round_no: 2, seq: 1 }) < 0);
console.log('PASS 场次时间、未安排、阶段和轮次排序');

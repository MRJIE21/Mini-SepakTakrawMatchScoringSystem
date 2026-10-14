import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROJECT_PRESETS, existingProject, nameAfterChoice, participantLabel, setupSummary, venueOrder } from '../web/js/setupModel.js';

test('four distinct presets and duplicate checks are confined to the selected group', () => {
  assert.deepEqual(PROJECT_PRESETS.map(p => p.name), ['男子三人赛', '女子三人赛', '男子个人赛', '女子个人赛']);
  assert.equal(new Set(PROJECT_PRESETS.map(p => p.key)).size, 4);
  const first = { categories: [{ ...PROJECT_PRESETS[0], name: '自定义项目名称' }] };
  assert.equal(existingProject(first, PROJECT_PRESETS[0]).name, '自定义项目名称');
  assert.equal(existingProject(first, PROJECT_PRESETS[1]), undefined);
  assert.equal(existingProject({ categories: [] }, PROJECT_PRESETS[0]), undefined);
});
test('preset changes update generated names and preserve custom names verbatim', () => {
  let result = nameAfterChoice('', '', PROJECT_PRESETS[0]);
  result = nameAfterChoice(result.value, result.generated, PROJECT_PRESETS[3]);
  assert.equal(result.value, '女子个人赛');
  result = nameAfterChoice('  自定义技巧赛  ', result.generated, PROJECT_PRESETS[1]);
  assert.equal(result.value, '  自定义技巧赛  ');
  result = nameAfterChoice(result.value, result.generated, PROJECT_PRESETS[0]);
  assert.equal(result.value, '  自定义技巧赛  ');
});
test('saved structure summaries mark dates and venues as optional and never claim readiness', () => {
  const empty = { event: {}, groups: [], venues: [] };
  assert.deepEqual(setupSummary(empty), { event: '赛事已创建 · 日期可后补', structure: '先添加组别，再开设项目', venues: '暂未添加 · 可后补' });
  const full = setupSummary({ event: { start_date: '2026-10-13' }, groups: [{ categories: [{}] }, { categories: [] }], venues: [{}] });
  assert.equal(full.structure, '2 个组别 · 1 个项目');
  assert.equal(full.venues, '1 个场地 · 全赛事共用');
  assert.match(full.event, /已填写日期/);
  assert.doesNotMatch(JSON.stringify(full), /可开赛|100%|全部完成/);
});
test('participation counts use the actual project unit', () => {
  assert.equal(participantLabel({ kind: 'team', participants: 7 }), '7 队已报名');
  assert.equal(participantLabel({ kind: 'individual', participants: 7 }), '7 人已报名');
  assert.equal(participantLabel({ kind: 'individual', participants: 0 }), '0 人已报名');
});
test('a new venue defaults to the last order and explicit invalid orders are rejected', () => {
  assert.equal(venueOrder('', []), 1);
  assert.equal(venueOrder(' ', [{ seq: 3 }, { seq: 9 }]), 10);
  assert.equal(venueOrder('0', [{ seq: 9 }]), 0);
  assert.equal(venueOrder('2', [{ seq: 9 }]), 2);
  for (const input of ['1.5', '-1', 'abc', '9007199254740992']) assert.throws(() => venueOrder(input, []), /整数/);
});

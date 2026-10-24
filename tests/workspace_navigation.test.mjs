import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workspaceTab, workspaceLink } from '../web/js/workspaceContext.js';
import { workspaceTabs } from '../web/js/permissions.js';

test('管理账号工作台按任务顺序收敛为五个目的地，其他角色保持原权限', () => {
  for (const role of ['admin', 'organizer']) assert.deepEqual(workspaceTabs(role, 'team'),
    ['overview', 'registration', 'schedule', 'matches', 'results']);
  assert.deepEqual(workspaceTabs('viewer', 'team'), ['schedule', 'results']);
  assert.deepEqual(workspaceTabs('recorder', 'team'), ['matches']);
  for (const role of ['admin', 'organizer']) assert.deepEqual(workspaceTabs(role, 'individual'), ['overview', 'registration', 'entry', 'results']);
  assert.deepEqual(workspaceTabs('viewer', 'individual'), ['results']);
  assert.deepEqual(workspaceTabs('recorder', 'individual'), ['entry']);
});

test('旧分组/任务/复核参数收敛到赛程/概况，显式新菜单优先且不改变其他目的地', () => {
  assert.equal(workspaceTab({ tab: 'schedule', view: 'groups' }), 'schedule');
  assert.equal(workspaceTab({ tab: 'schedule', view: 'fixtures' }), 'schedule');
  assert.equal(workspaceTab({ tab: 'groups', view: 'fixtures' }), 'schedule');
  assert.equal(workspaceTab({ tab: 'groups' }), 'schedule');
  assert.equal(workspaceTab({ tab: 'tasks' }), 'overview');
  assert.equal(workspaceTab({ tab: 'review' }), 'review');
  for (const tab of ['overview', 'registration', 'matches', 'entry', 'results']) assert.equal(workspaceTab({ tab, view: 'groups' }), tab);
  assert.equal(workspaceTab({}), undefined);
});

test('规范链接保留赛事项目和赛程位置，不再生成内层模式', () => {
  const category = { event_id: 9, group_id: 2, id: 3 };
  const parse = (tab, opts) => Object.fromEntries(new URLSearchParams(workspaceLink(category, tab, opts).split('?')[1]));
  assert.deepEqual(parse('schedule', { view: 'groups', draw: 1 }), { event: '9', group: '2', category: '3', tab: 'schedule', view: 'groups', draw: '1' });
  assert.deepEqual(parse('schedule', { view: 'fixtures', stage: 12, sort: 'schedule', venue: 4, status: 'pending' }),
    { event: '9', group: '2', category: '3', tab: 'schedule', stage: '12', sort: 'schedule', venue: '4', status: 'pending' });
});

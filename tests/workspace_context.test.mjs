import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchingCategory, workspaceLink } from '../web/js/workspaceContext.js';

test('切换大组保留女子三人赛，不跳到首个男子项目', () => {
  const categories = [{ id: 1, name: '男子三人赛', kind: 'team', gender: 'male' },
    { id: 2, name: '女子个人赛', kind: 'individual', gender: 'female' },
    { id: 3, name: '女子三人赛', kind: 'team', gender: 'female' }];
  assert.equal(matchingCategory(categories, { name: '女子三人赛', kind: 'team', gender: 'female' }).id, 3);
  assert.equal(matchingCategory(categories.slice(0, 2), { kind: 'team', gender: 'female' }).id, 1);
  assert.equal(matchingCategory([], { kind: 'team', gender: 'female' }), undefined);
});

test('待办链接保留赛事、组别和项目，进入指定排名或赛程模式', () => {
  const category = { event_id: 5, group_id: 6, id: 7 };
  const params = new URLSearchParams(workspaceLink(category, 'results', { pool: 21 }).split('?')[1]);
  assert.deepEqual(Object.fromEntries(params), { event: '5', group: '6', category: '7', tab: 'results', pool: '21' });
  assert.match(workspaceLink(category, 'schedule', { view: 'planning' }), /tab=schedule&view=planning/);
});

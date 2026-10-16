import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchingCategory, workspaceLink, groupWorkspaceLink, workspaceSchoolLink, resolveSchoolContext } from '../web/js/workspaceContext.js';

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

test('未开设项目的组别仍可从工作台进入报名名单', () => {
  const params = new URLSearchParams(groupWorkspaceLink({ event_id: 5, id: 6 }, 'registration').split('?')[1]);
  assert.deepEqual(Object.fromEntries(params), { event: '5', group: '6', tab: 'registration' });
  assert.equal(params.has('category'), false, '没有项目时链接不能带 category');
});

test('学校报名统一落在工作台报名名单，取消勾选后回到同组别学校列表', () => {
  const detail = new URLSearchParams(workspaceSchoolLink({
    eventId: 5, groupId: 6, categoryId: 7, schoolId: 42,
  }).split('?')[1]);
  assert.deepEqual(Object.fromEntries(detail),
    { event: '5', tab: 'registration', group: '6', category: '7', school: '42' });

  const list = new URLSearchParams(workspaceSchoolLink({ eventId: 5, groupId: 6, schoolId: null }).split('?')[1]);
  assert.equal(list.get('school'), null, '返回学校列表必须去掉 school');
  assert.equal(list.get('category'), null, '学校列表不绑定单个项目');
  assert.equal(list.get('tab'), 'registration');
});

const structure = { event: { id: 5 }, groups: [
  { id: 6, categories: [{ id: 7 }, { id: 8 }] },
  { id: 9, categories: [{ id: 10 }] }, { id: 11, categories: [] },
] };
const school = (group = 6, event = 5) => ({ school: { id: 42, event_id: event }, group: { id: group } });

test('显式项目优先；记忆只补齐同组未指定项目，不能覆盖学校归属', () => {
  assert.equal(resolveSchoolContext(structure, { group: '6', category: '7' }, null, '8').category.id, 7);
  assert.equal(resolveSchoolContext(structure, { group: '6' }, null, '8').category.id, 8);
  assert.equal(resolveSchoolContext(structure, { group: '6' }, null, '10').category.id, 7);
  const resolved = resolveSchoolContext(structure, { school: '42' }, school(9), '8');
  assert.equal(resolved.group.id, 9); assert.equal(resolved.category.id, 10);
  assert.equal(resolved.schoolId, 42);
});

test('显式非法或相互冲突的赛事/组别/项目/学校必须报错', () => {
  for (const params of [{ event: 99 }, { group: 99 }, { category: 99 }, { group: 6, category: 10 },
    { group: 9, school: 42 }, { category: 10, school: 42 }, { school: 43 }]) {
    assert.throws(() => resolveSchoolContext(structure, params, school()));
  }
  assert.throws(() => resolveSchoolContext(structure, { school: 42 }, school(6, 99)));
  assert.throws(() => resolveSchoolContext(structure, { school: 42 }, null));
  for (const value of ['0', '-1', '2x', '1.5', '1e2', '9007199254740993']) {
    for (const key of ['event', 'group', 'category', 'school']) {
      assert.throws(() => resolveSchoolContext(structure, { [key]: value }, school()));
    }
  }
});

test('无项目组别与无组别保持空状态，不借用其他组项目', () => {
  const empty = resolveSchoolContext(structure, { group: 11 }, null, 7);
  assert.equal(empty.group.id, 11); assert.equal(empty.category, null);
  assert.deepEqual(resolveSchoolContext({ event: { id: 5 }, groups: [] }), { group: null, category: null, schoolId: null });
  const legacy = resolveSchoolContext(structure, { school: 42 }, school(11), 10);
  assert.equal(legacy.group.id, 11); assert.equal(legacy.category, null);
});

test('直接进入可恢复有效记忆，缺失或失效记忆使用合法默认，显式组别优先', () => {
  for (const remembered of [null, '9999', 'broken']) {
    const resolved = resolveSchoolContext(structure, {}, null, remembered);
    assert.equal(resolved.group.id, 6); assert.equal(resolved.category.id, 7);
  }
  const remembered = resolveSchoolContext(structure, {}, null, '10');
  assert.equal(remembered.group.id, 9); assert.equal(remembered.category.id, 10);
  assert.equal(resolveSchoolContext(structure, { group: 6 }, null, '10').category.id, 7);
  const emptyFirst = { ...structure, groups: [structure.groups[2], ...structure.groups.slice(0, 2)] };
  assert.equal(resolveSchoolContext(emptyFirst).group.id, 11);
  assert.equal(resolveSchoolContext(emptyFirst).category, null);
});

test('返回学校列表保留合法项目和待补筛选，不输出空值参数', () => {
  const query = new URLSearchParams(workspaceSchoolLink({ eventId: 5, groupId: 6, categoryId: 8, profile: 'incomplete' }).split('?')[1]);
  assert.equal(query.get('category'), '8'); assert.equal(query.get('profile'), 'incomplete');
  assert.equal(query.has('school'), false);
  assert.equal(workspaceSchoolLink({ eventId: 5 }).includes('undefined'), false);
});

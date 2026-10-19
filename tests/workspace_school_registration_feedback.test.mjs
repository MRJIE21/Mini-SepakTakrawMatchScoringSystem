/* 报名页反馈修复的纯函数单测：号码带入、预览前拦截、错误摘要与基线冲突合并。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  errorSummary, jerseyOrEmpty, localIssues, reconcile,
} from '../web/js/schoolRegistrationModel.js';

const person = (key, name, gender = 'male', extra = {}) => ({ key, name, gender, jersey_no: '', note: '', ...extra });
const project = (categoryId, extra = {}) => ({
  category_id: categoryId, choice: 'unresolved', members: [], captain_key: '',
  athlete_key: '', seed_no: null, note: '', ...extra,
});
const model = (overrides = {}) => ({
  people: [person('a:1', '甲'), person('a:2', '乙')],
  categories: [
    { id: 1, name: '男子三人赛', kind: 'team', gender: 'male' },
    { id: 2, name: '女子三人赛', kind: 'team', gender: 'female' },
    { id: 3, name: '男子个人赛', kind: 'individual', gender: 'male' },
  ],
  projects: [project(1), project(2), project(3)],
  ...overrides,
});

test('本项目号码只接受 1—20 的整数，常用号码超出范围不原样带入', () => {
  for (const [input, expected] of [['1', '1'], ['7', '7'], ['20', '20'], ['10', '10'], [7, '7'],
    ['21', ''], ['0', ''], ['05', ''], ['1.0', ''], ['２３', ''], ['无', ''], ['', ''], [null, '']]) {
    assert.equal(jerseyOrEmpty(input), expected, `jerseyOrEmpty(${JSON.stringify(input)})`);
  }
});

test('错误摘要拼接服务端 message 与 detail.fields 具体人员，去重且兼容缺字段', () => {
  const summary = errorSummary({
    message: '运动员性别与项目不符',
    detail: { fields: { members: '测试员甲性别与项目不符', athlete_id: '运动员性别与项目不符' } },
  });
  assert.equal(summary.message, '运动员性别与项目不符');
  assert.deepEqual(summary.details, ['测试员甲性别与项目不符']);
  assert.equal(summary.text, '运动员性别与项目不符；测试员甲性别与项目不符');
  assert.deepEqual(errorSummary({ message: '第 1 位队员号码必须是 1—20 的整数', detail: { fields: { members: '第 1 位队员号码必须是 1—20 的整数' } } }).details, []);
  assert.deepEqual(errorSummary(new Error('网络错误')).details, []);
  assert.equal(errorSummary(null).message, '操作失败，请修正后重试');
});

test('合法清单预览前无问题', () => {
  const data = model({
    projects: [
      project(1, { choice: 'participate', members: [{ athlete_key: 'a:1', jersey_no: '7' }], captain_key: 'a:1', seed_no: 5 }),
      project(2), project(3),
    ],
  });
  assert.deepEqual(localIssues(data), []);
});

test('预览前拦截已报名运动员性别冲突', () => {
  const data = model({
    people: [person('a:1', '甲', 'female'), person('a:2', '乙')],
    projects: [project(1, { choice: 'participate', members: [{ athlete_key: 'a:1', jersey_no: '7' }] }), project(2), project(3)],
  });
  const issues = localIssues(data);
  assert.equal(issues.length, 1);
  assert.ok(issues[0].includes('甲'));
  assert.ok(issues[0].includes('性别'));
  assert.ok(issues[0].includes('男子三人赛'));
});

test('预览前拦截个人赛参加未选人、非法种子、空姓名与超员', () => {
  const noAthlete = model({ projects: [project(1), project(2), project(3, { choice: 'participate', athlete_key: '' })] });
  assert.ok(localIssues(noAthlete).some((item) => item.includes('请先选择 1 名运动员')));

  for (const seed of ['abc', '0', '2.5', '-1']) {
    const badSeed = model({ projects: [project(1, { choice: 'participate', seed_no: seed }), project(2), project(3)] });
    assert.ok(localIssues(badSeed).some((item) => item.includes('种子序号必须是正整数')), String(seed));
  }
  for (const seed of ['5', 5, '05', null, '']) {
    const goodSeed = model({ projects: [project(1, { choice: 'participate', seed_no: seed }), project(2), project(3)] });
    assert.deepEqual(localIssues(goodSeed), [], String(seed));
  }

  const emptyName = model({ people: [person('a:1', ' '), person('a:2', '乙')] });
  assert.ok(localIssues(emptyName).some((item) => item.includes('未填写姓名')));

  const tooMany = model({
    people: Array.from({ length: 7 }, (_, index) => person(`a:${index + 1}`, `人${index + 1}`)),
    projects: [project(1, { choice: 'participate', members: Array.from({ length: 7 }, (_, index) => ({ athlete_key: `a:${index + 1}`, jersey_no: String(index + 1) })) }), project(2), project(3)],
  });
  assert.ok(localIssues(tooMany).some((item) => item.includes('最多 6 名队员')));
});

test('409 基线更新合并：保留未冲突本地修改、冲突项显式返回', () => {
  const base = {
    people: [person('a:1', '甲'), person('a:2', '乙')],
    projects: [project(1, { note: '旧备注' })],
  };
  const local = {
    people: [person('a:1', '甲（本地改名）'), person('a:2', '乙'), person('new:1', '丙', 'male', { note: '新增' })],
    projects: [project(1, { note: '旧备注', seed_no: 3 })],
  };
  const latest = {
    people: [person('a:1', '甲'), person('a:2', '乙（后台改名）')],
    projects: [project(1, { note: '旧备注' })],
  };
  const merged = reconcile(base, local, latest);
  assert.deepEqual(merged.conflicts, []);
  assert.equal(merged.merged.people.find((item) => item.key === 'a:1').name, '甲（本地改名）');
  assert.equal(merged.merged.people.find((item) => item.key === 'a:2').name, '乙（后台改名）');
  assert.ok(merged.merged.people.some((item) => item.key === 'new:1'));
  assert.equal(merged.merged.projects[0].seed_no, 3);
  assert.equal(merged.merged.projects[0].note, '旧备注');

  const conflicting = reconcile(base, local, {
    ...latest,
    people: [person('a:1', '甲（远端改名）'), person('a:2', '乙（后台改名）')],
  });
  assert.equal(conflicting.conflicts.length, 1);
  assert.equal(conflicting.conflicts[0].key, 'a:1');
  assert.equal(conflicting.merged.people.find((item) => item.key === 'a:1').name, '甲（远端改名）');
});

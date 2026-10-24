import test from 'node:test';
import assert from 'node:assert/strict';
import { canView, workspaceTabs } from '../web/js/permissions.js';

const ALL = ['dashboard', 'setup', 'teamRules', 'schoolRegistration', 'workspace', 'catalog', 'matches', 'schedule', 'scheduling', 'field', 'display', 'scoring', 'individual', 'review', 'results', 'school', 'bracket', 'admin', 'users', 'account', 'resultReview'];

test('G1 导航矩阵：管理员可见全部业务视图', () => {
  for (const name of ALL) assert.equal(canView('admin', name), true, name);
});

test('G1 导航矩阵：编排与成绩人员不含账号管理，但可进复核与更正', () => {
  assert.equal(canView('organizer', 'admin'), true);
  assert.equal(canView('organizer', 'users'), false);
  assert.equal(canView('organizer', 'resultReview'), true);
  assert.equal(canView('organizer', 'display'), true);
});

test('G1 导航矩阵：记录员只到现场/记录/个人赛/复核', () => {
  for (const name of ['field', 'scoring', 'individual', 'review', 'account', 'resultReview']) {
    assert.equal(canView('recorder', name), true, name);
  }
  for (const name of ['dashboard', 'results', 'school', 'admin', 'users', 'display']) {
    assert.equal(canView('recorder', name), false, name);
  }
});

test('G1 导航矩阵：查看者与大屏操作员只读，不含复核与首页', () => {
  for (const role of ['viewer', 'display_operator']) {
    for (const name of ['dashboard', 'resultReview', 'admin', 'users']) {
      assert.equal(canView(role, name), false, `${role}:${name}`);
    }
    for (const name of ['workspace', 'results', 'school', 'bracket', 'account']) {
      assert.equal(canView(role, name), true, `${role}:${name}`);
    }
  }
  assert.equal(canView('display_operator', 'display'), true);
  assert.equal(canView('viewer', 'display'), false);
});

test('G1 工作台页签矩阵', () => {
  assert.deepEqual(workspaceTabs('recorder', 'team'), ['matches']);
  assert.deepEqual(workspaceTabs('recorder', 'individual'), ['entry']);
  assert.deepEqual(workspaceTabs('viewer', 'team'), ['schedule', 'results']);
  assert.deepEqual(workspaceTabs('viewer', 'individual'), ['results']);
  for (const role of ['admin', 'organizer']) {
    assert.deepEqual(workspaceTabs(role, 'team'),
      ['overview', 'registration', 'schedule', 'matches', 'results']);
    assert.deepEqual(workspaceTabs(role, 'individual'),
      ['overview', 'registration', 'entry', 'results']);
  }
});

/* Entry-point contracts supplement real module and browser coverage. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const MAIN = read('web/js/main.js');
const WORKSPACE = read('web/js/views/workspace.js');
const SCHOOL = read('web/js/views/schoolRegistration.js');
const CATALOG = read('web/js/views/catalog.js');
const DASHBOARD = read('web/js/views/dashboard.js');
const UI = read('web/js/ui.js');

test('侧栏学校报名是工作台快捷入口，不再作为独立页面入口', () => {
  assert.match(MAIN, /\{ view: 'schoolRegistration', label: '学校报名', href: '#\/workspace\?tab=registration'/,
    '侧栏学校报名必须是工作台报名页签的快捷入口');
  assert.match(MAIN, /\{ group: '成绩', items: \[[\s\S]*\{ view: 'resultReview' \}/,
    '成绩组应包含成绩复核入口');
  assert.doesNotMatch(MAIN, /\{ group: '比赛管理'/,
    '旧“比赛管理”分组已并入项目与赛程/成绩');
});

test('旧入口与待办链接都落到工作台报名名单，不直接打开独立页面', () => {
  for (const [name, source] of [['catalog.js', CATALOG], ['dashboard.js', DASHBOARD],
    ['workspace.js', WORKSPACE], ['schoolRegistration.js', SCHOOL]]) {
    assert.doesNotMatch(source, /go\('schoolRegistration'/,
      `${name} 不应再把用户送出工作台`);
  }
  assert.match(CATALOG, /go\('workspace', \{\s*event: state\.eventId, group: cat\.group_id, tab: 'registration', school: r\.school_id,/,
    '名单行内入口应带 group 与 school 进入工作台');
  assert.match(WORKSPACE, /tab: 'registration', school: part\.school_id/,
    '概况“补资料”应进入工作台报名名单的目标学校');
});

test('学校报名详情在工作台内渲染，返回与删除都留在工作台', () => {
  assert.match(WORKSPACE, /const schoolView = state\.views\.schoolRegistration/,
    '工作台应复用原学校报名组件');
  assert.ok(WORKSPACE.includes("embedded: 'workspace'"));
  assert.match(SCHOOL, /registerView\(\{[^\n]*renderDirectory/, '学校名单需要暴露给工作台复用');
  assert.match(SCHOOL, /const backButton = btn\('返回学校列表', \(\) => \{ location\.hash = listLink\(\); \}\)/,
    '返回学校列表应改地址回到同一组别列表');
  assert.ok(SCHOOL.includes('schoolId: resolved.schoolId'), '旧详情保留目标学校');
});

test('换页守卫在旧页面退场前不会被清空（未提交输入仍有离开确认）', () => {
  assert.match(UI, /if \(guard === null && pendingNavigation\) return;/,
    'ui.js 必须支持“换页中先冻结守卫”');
  assert.match(MAIN, /markPageLeaveGuardPending\(\);/, 'renderRoute 必须先声明换页');
  assert.match(MAIN, /settlePageLeaveGuard\(\);/, 'renderRoute 必须在 finally 里结束换页');
  assert.match(MAIN, /finally \{\s*settlePageLeaveGuard\(\);\s*\}/,
    '结束换页必须放在 finally，避免报错或取消时守卫永久冻结');
  assert.doesNotMatch(MAIN, /async function renderRoute[\s\S]{0,120}setPageLeaveGuard\(null\)/,
    '换页开头不能直接清空守卫');
});

test('取消离开后地址回到真正渲染的那一页', () => {
  assert.match(MAIN, /const restore = renderedHash \|\| `#\/\$\{roleHome\(\)\.replace\(\/\^#\\\/\?\/, ''\)\}`;/,
    '没有已渲染地址时要回到角色首页，而不是把用户留在未渲染的目标地址');
  assert.match(MAIN, /if \(location\.hash !== restore\) history\.replaceState\(null, '', restore\);/,
    '取消离开必须把 hash 还原到已渲染页面');
});

test('工作台正文复用学校统一编辑与整批核对视图', () => {
  assert.match(SCHOOL, /\['edit', '统一编辑'\], \['review', '整批核对'\]/,
    '学校详情应有统一编辑与整批核对页签');
});

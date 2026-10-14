import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../web/js/main.js', import.meta.url), 'utf8');
const setup = fs.readFileSync(new URL('../web/js/views/setup.js', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const catalogApi = fs.readFileSync(new URL('../app/api/catalog.py', import.meta.url), 'utf8');

assert.ok(index.includes('id="btn-new-event"'), '顶栏必须保留新建赛事入口');
assert.ok(setup.includes("params.action === 'new'"), '已有赛事时也必须可以进入新建流程');
assert.ok(main.indexOf("group: '赛事管理'") < main.indexOf("group: '比赛管理'"),
  '赛事管理必须排在比赛管理之前');
assert.ok(!main.includes("items: ['workspace', 'catalog']"),
  '学校和人员不得作为项目工作台之外的独立步骤');
assert.ok(setup.includes("h('b', '赛事')") && setup.includes("h('span', '比赛项目')"),
  '设置页必须展示赛事到比赛项目的上下级关系');
assert.match(catalogApi,
  /@route\("POST", r"\/api\/events\/\(\?P<event_id>\\d\+\)\/groups", roles=ORG\)/,
  '组委会角色创建赛事后必须能继续建立大组别');

console.log('赛事创建入口与层级：6 项通过');

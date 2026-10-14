import assert from 'node:assert/strict';
import { categoryLabel } from '../web/js/labels.js';

const cases = [
  [{ name: '单人赛', gender: 'male' }, '男子 · 单人赛'],
  [{ name: '三人赛', gender: 'female' }, '女子 · 三人赛'],
  [{ name: '男子三人赛', gender: 'male' }, '男子三人赛'],
  [{ category_name: '单人赛', category_gender: 'female' }, '女子 · 单人赛'],
];

for (const [input, expected] of cases) assert.equal(categoryLabel(input), expected);
assert.equal(categoryLabel({ name: '单人赛', gender: 'male', group_name: '央属高校：甲组' },
  { withGroup: true }), '央属高校 / 男子 · 单人赛');

console.log('项目名称性别标识：5 项通过');

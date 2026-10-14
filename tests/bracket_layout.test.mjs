/* 对阵树布局测试（Node 运行）：node tests/bracket_layout.test.mjs
   校验每轮一列、节点居中于前序场次之间、同列不重叠、连线数量正确。 */
import assert from 'node:assert/strict';
import { computeLayout, BOX_W, BOX_H, GAP_Y, COL_GAP } from '../web/js/bracketLayout.js';


let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

function m(id, round, seq, homeFeeder, awayFeeder) {
  return {
    id, round_no: round, seq, round_label: `第${round}轮`,
    home: { source_match_id: homeFeeder ?? null, type: homeFeeder ? 'match_winner' : 'pool_rank' },
    away: { source_match_id: awayFeeder ?? null, type: awayFeeder ? 'match_winner' : 'pool_rank' },
  };
}

console.log('对阵树布局');

test('8 队三列：首轮按序排列', () => {
  const matches = [
    m(1, 1, 1), m(2, 1, 2), m(3, 1, 3), m(4, 1, 4),
    m(5, 2, 5, 1, 2), m(6, 2, 6, 3, 4),
    m(7, 3, 7, 5, 6),
  ];
  const { pos, rounds, width, height } = computeLayout(matches);
  assert.deepEqual(rounds, [1, 2, 3]);
  assert.equal(pos.get(1).x, 0);
  assert.equal(pos.get(5).x, BOX_W + COL_GAP);
  assert.equal(pos.get(7).x, 2 * (BOX_W + COL_GAP));
  const ys = [1, 2, 3, 4].map((id) => pos.get(id).y);
  assert.deepEqual(ys, [0, BOX_H + GAP_Y, 2 * (BOX_H + GAP_Y), 3 * (BOX_H + GAP_Y)]);
  assert.equal(height, 3 * (BOX_H + GAP_Y) + BOX_H);
  assert.equal(width, 3 * BOX_W + 2 * COL_GAP);
});

test('后续轮次纵向居中于前序两场之间', () => {
  const matches = [
    m(1, 1, 1), m(2, 1, 2), m(3, 1, 3), m(4, 1, 4),
    m(5, 2, 5, 1, 2), m(6, 2, 6, 3, 4),
    m(7, 3, 7, 5, 6),
  ];
  const { pos } = computeLayout(matches);
  const expected5 = (pos.get(1).y + pos.get(2).y) / 2;
  assert.equal(pos.get(5).y, expected5);
  assert.equal(pos.get(6).y, (pos.get(3).y + pos.get(4).y) / 2);
  assert.equal(pos.get(7).y, (pos.get(5).y + pos.get(6).y) / 2);
});

test('同列重叠时向下错开（三四名决赛不与决赛重叠）', () => {
  // 决赛与三四名决赛都由两场半决赛产出，y 相同，必须错开
  const matches = [
    m(1, 1, 1), m(2, 1, 2),
    m(3, 2, 3, 1, 2),                     // 决赛
    m(4, 2, 4, 1, 2),                     // 三四名决赛
  ];
  const { pos, height } = computeLayout(matches);
  assert.equal(pos.get(3).y, pos.get(4).y - (BOX_H + GAP_Y));
  assert.equal(height, pos.get(4).y + BOX_H);
});

test('待定签位不参与连线（只有胜者来源才连线）', () => {
  const matches = [m(1, 1, 1), m(2, 1, 2), m(3, 2, 3, 1, 2)];
  const { pos } = computeLayout(matches);
  const feeders = matches.flatMap((x) => [x.home.source_match_id, x.away.source_match_id])
    .filter((id) => id && pos.has(id));
  assert.equal(feeders.length, 2, '决赛应有两条来自半决赛的连线');
});

test('轮空直接晋级时首轮只有真实比赛', () => {
  // 6 队：首轮 2 场真实比赛，第二轮 2 场（各含一个轮空直进的队）
  const matches = [
    m(1, 1, 1), m(2, 1, 2),
    m(3, 2, 3, 1, null), m(4, 2, 4, 2, null),
    m(5, 3, 5, 3, 4),
  ];
  const { pos } = computeLayout(matches);
  assert.equal(pos.has(1) && pos.has(2) && pos.has(5), true);
  assert.equal(pos.get(5).y, (pos.get(3).y + pos.get(4).y) / 2);
  const links = matches.flatMap((x) => [x.home.source_match_id, x.away.source_match_id])
    .filter((id) => id && pos.has(id)).length;
  assert.equal(links, 4);
});

test('单场阶段（只有决赛）也能定位', () => {
  const { pos, width } = computeLayout([m(1, 3, 1)]);
  assert.equal(pos.get(1).x, 0);
  assert.equal(pos.get(1).y, 0);
  assert.equal(width, BOX_W);
});

console.log(`\n${passed} 项通过${process.exitCode ? '，存在失败项' : '，全部通过'}`);

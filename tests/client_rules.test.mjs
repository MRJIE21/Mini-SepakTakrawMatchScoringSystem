/* 前端计分规则测试（Node 运行）：node tests/client_rules.test.mjs
   验证记录页使用的 15 分制、三局两胜、撤回逻辑与后端一致。 */
import assert from 'node:assert/strict';
import {
  addPoint, summarize, undoEvent, undoTarget, setWinner, matchWinnerFromSets, isSetOpen, SET_CAP,
} from '../web/js/scoring.js';

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

/* 用「先落后方得分、再胜方得分」的顺序补到目标比分，保证过程合法且只填满当前这一局 */
function playTo(events, home, away) {
  const setNo = summarize(events).currentSet;
  const target = { home, away };
  const order = home > away ? ['away', 'home'] : ['home', 'away'];
  for (const side of order) {
    while (true) {
      const state = summarize(events);
      const set = state.sets.find((s) => s.set_no === setNo);
      const current = side === 'home' ? (set?.home_points || 0) : (set?.away_points || 0);
      if (current >= target[side]) break;
      const e = addPoint(events, side, state);
      assert.ok(e, `${side} 应能继续得分（第${setNo}局）`);
      events.push(e);
      const after = summarize(events).sets.find((s) => s.set_no === setNo);
      if (after && after.winner_side) break;
    }
  }
  return summarize(events);
}

console.log('三人赛计分规则');

test(`每局 ${SET_CAP} 分封顶`, () => {
  const events = [];
  const state = playTo(events, 15, 13);
  assert.equal(state.sets[0].home_points, 15);
  assert.equal(state.sets[0].winner_side, 'home');
  assert.equal(state.matchOver, false);
});

test('每局必须手动开启后才能记录', () => {
  const events = [];
  let state = summarize(events);
  assert.equal(isSetOpen(state, null), false);
  assert.equal(isSetOpen(state, 1), true);
  playTo(events, 15, 10);
  state = summarize(events);
  assert.equal(state.currentSet, 2);
  assert.equal(isSetOpen(state, 1), false, '上一局的开启状态不能自动沿用到下一局');
  assert.equal(isSetOpen(state, 2), true);
});

test('14 平后再得 1 分即结束（15:14）', () => {
  const events = [];
  const state = playTo(events, 15, 14);
  assert.equal(state.sets[0].winner_side, 'home');
  const next = addPoint(events, 'home', state);
  assert.ok(!next || next.set_no === 2, '已结束的局不能再记分，下一分应进入第二局');
  if (next) events.push(next);
  const after = summarize(events);
  assert.equal(after.sets[0].home_points, 15, '第一局比分保持不变');
  assert.equal(after.sets[0].away_points, 14);
});

test('一局得分不超过 15 分', () => {
  const events = [];
  const state = playTo(events, 15, 0);
  assert.equal(state.sets[0].home_points, 15);
  const next = addPoint(events, 'home', state);
  assert.ok(!next || next.set_no === 2, '超出 15 分的记分不应落回本局');
  const other = addPoint(events, 'away', state);
  assert.ok(!other || other.set_no === 2, '对手的得分同样进入下一局');
});

test('三局两胜：2:0 直接结束', () => {
  const events = [];
  playTo(events, 15, 8);
  const state = playTo(events, 15, 9);
  assert.equal(state.matchOver, true);
  assert.equal(state.winners.home, 2);
  assert.deepEqual(state.liveScore, [15, 9], '比赛结束后计分板保留最后一局比分');
  assert.equal(addPoint(events, 'home', state), null);
});

test('第三局同样为 15 分', () => {
  const events = [];
  playTo(events, 15, 10);
  playTo(events, 12, 15);
  const state = playTo(events, 15, 13);
  assert.equal(state.sets.length, 3);
  assert.equal(state.sets[2].home_points, 15);
  assert.equal(state.matchOver, true);
  assert.equal(state.winners.home, 2);
});

test('撤回上一分并重新开放该局', () => {
  const events = [];
  playTo(events, 15, 12);
  const before = summarize(events);
  assert.equal(before.currentSet, 2);
  const undo = undoEvent(events);
  events.push(undo);
  const after = summarize(events);
  assert.equal(after.sets[0].home_points, 14, '撤回应撤销本局最后一分');
  assert.equal(after.sets[0].winner_side, '', '该局回到未结束状态');
  assert.equal(after.currentSet, 1);
});

test('撤回可以连续进行且只作用于最后一次有效记分', () => {
  const events = [];
  playTo(events, 3, 1);
  events.push(undoEvent(events));
  events.push(undoEvent(events));
  const state = summarize(events);
  assert.equal(state.liveScore[0], 1);
  assert.equal(state.liveScore[1], 1);
  assert.equal(undoTarget(events).home_after, 1);
});

test('比分与胜方判定一致', () => {
  assert.equal(setWinner(15, 14), 'home');
  assert.equal(setWinner(14, 15), 'away');
  assert.equal(setWinner(14, 14), null);
  assert.equal(matchWinnerFromSets([
    { winner_side: 'away' }, { winner_side: 'away' },
  ]), 'away');
});

console.log(`\n${passed} 项通过${process.exitCode ? '，存在失败项' : '，全部通过'}`);

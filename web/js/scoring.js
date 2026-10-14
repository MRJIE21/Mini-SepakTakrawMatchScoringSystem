/* 三人赛计分规则（与后端 app/domain/validation.py 保持一致）。

三局两胜，每局均为 15 分（含第三局），14 平后再得 1 分即结束，15 分封顶。
*/
export const SET_CAP = 15;
export const SETS_TO_WIN = 2;
export const MAX_SETS = 3;

export function setWinner(home, away, cap = SET_CAP) {
  if (home >= cap && home > away) return 'home';
  if (away >= cap && away > home) return 'away';
  return null;
}

export function matchWinnerFromSets(sets) {
  const home = sets.filter((s) => s.winner_side === 'home').length;
  const away = sets.filter((s) => s.winner_side === 'away').length;
  if (home >= SETS_TO_WIN) return 'home';
  if (away >= SETS_TO_WIN) return 'away';
  return null;
}

/* 按事件重建比分：kind=score 加分，kind=undo 撤回指定事件 */
export function replay(events, cap = SET_CAP) {
  const scores = {};
  const decided = new Set();
  const active = new Map();
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  for (const e of ordered) {
    const setNo = e.set_no;
    if (!scores[setNo]) scores[setNo] = [0, 0];
    if (e.kind === 'score') {
      if (decided.has(setNo)) continue;
      const idx = e.side === 'home' ? 0 : 1;
      scores[setNo][idx] += 1;
      active.set(e.seq, { set_no: setNo, side: e.side });
      if (scores[setNo][0] >= cap || scores[setNo][1] >= cap) decided.add(setNo);
    } else if (e.kind === 'undo') {
      const ref = active.get(e.ref_seq);
      if (!ref) continue;
      active.delete(e.ref_seq);
      scores[ref.set_no][ref.side === 'home' ? 0 : 1] -= 1;
      decided.delete(ref.set_no);
    }
  }
  return { scores, decided };
}

export function summarize(events) {
  const { scores, decided } = replay(events);
  const setNos = Object.keys(scores).map(Number).sort((a, b) => a - b);
  const sets = setNos.map((no) => {
    const [h, a] = scores[no];
    return { set_no: no, home_points: h, away_points: a, winner_side: setWinner(h, a) || '' };
  });
  const winners = { home: 0, away: 0 };
  for (const s of sets) if (s.winner_side) winners[s.winner_side] += 1;
  const decidedSets = [...decided].sort((a, b) => a - b);
  const matchOver = winners.home >= SETS_TO_WIN || winners.away >= SETS_TO_WIN;
  const currentSet = matchOver ? null : (decidedSets.length ? decidedSets[decidedSets.length - 1] + 1 : 1);
  return {
    sets,
    winners,
    matchOver,
    currentSet: currentSet > MAX_SETS ? MAX_SETS : currentSet,
    liveScore: matchOver ? scores[setNos[setNos.length - 1]] || [0, 0]
      : currentSet && scores[currentSet] ? scores[currentSet] : [0, 0],
    finishedSets: sets.filter((s) => s.winner_side).length,
  };
}

export function nextSeq(events) {
  return events.reduce((max, e) => Math.max(max, e.seq || 0), 0) + 1;
}

export function addPoint(events, side, state = summarize(events)) {
  if (state.matchOver) return null;
  const setNo = state.currentSet;
  const [h, a] = state.liveScore;
  const home = side === 'home' ? h + 1 : h;
  const away = side === 'away' ? a + 1 : a;
  if (home > SET_CAP || away > SET_CAP) return null;
  return {
    seq: nextSeq(events), kind: 'score', set_no: setNo, side,
    home_after: home, away_after: away, created_at: new Date().toISOString(),
  };
}

/* 每局必须由记录员显式开启。activeSet 属于本机记录台状态，不写入正式比分事件；
   因而不会改变既有提交协议或历史成绩重放。 */
export function isSetOpen(state, activeSet) {
  return !state.matchOver && Number(activeSet) === Number(state.currentSet);
}

export function undoTarget(events) {
  const active = new Map();
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.kind === 'score') active.set(e.seq, e);
    else if (e.kind === 'undo') active.delete(e.ref_seq);
  }
  const remaining = [...active.values()];
  return remaining.length ? remaining[remaining.length - 1] : null;
}

export function undoEvent(events) {
  const target = undoTarget(events);
  if (!target) return null;
  return {
    seq: nextSeq(events), kind: 'undo', set_no: target.set_no, side: '',
    ref_seq: target.seq, created_at: new Date().toISOString(),
  };
}

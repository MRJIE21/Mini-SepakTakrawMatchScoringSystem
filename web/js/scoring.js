/* Event replay always uses the rules frozen for the match. Legacy callers retain defaults. */
import { DEFAULT_RULES, normalizeRules, ruleForSet, setsToWin, winner, legalScore } from './teamRules.js';
export const SET_CAP = 15;
export const SETS_TO_WIN = 2;
export const MAX_SETS = 3;
function inputRules(value = DEFAULT_RULES) {
  return typeof value === 'number' ? normalizeRules({ ...DEFAULT_RULES,
    regular: { mode: 'target', target_points: value, win_by: 1, point_cap: value } }) : normalizeRules(value);
}
export function setWinner(home, away, cap = SET_CAP) {
  const rule = typeof cap === 'number' ? { mode: 'target', target_points: cap, win_by: 1, point_cap: cap } : cap;
  return winner(home, away, rule);
}
export function matchWinnerFromSets(sets, rules = DEFAULT_RULES) {
  const home = sets.filter(s => s.winner_side === 'home').length;
  const away = sets.filter(s => s.winner_side === 'away').length;
  return home >= setsToWin(rules) ? 'home' : away >= setsToWin(rules) ? 'away' : null;
}
export function replay(events, rawRules = DEFAULT_RULES) {
  const rules = inputRules(rawRules), scores = {}, active = new Map(), errors = [];
  let previousSeq = 0;
  const decide = () => new Map(Object.entries(scores).map(([no, score]) =>
    [Number(no), winner(...score, ruleForSet(rules, Number(no)))]).filter(([, w]) => w));
  for (const e of events) {
    if (!e || !Number.isInteger(e.seq) || e.seq > 2147483647 || e.seq <= previousSeq) { errors.push('事件序号不正确'); continue; }
    previousSeq = e.seq;
    const no = e.set_no;
    if (!Number.isInteger(no) || no < 1 || no > rules.max_sets) { errors.push('局次超出范围'); continue; }
    if (e.kind === 'undo') {
      if (e.side !== undefined && e.side !== null && e.side !== '') { errors.push('撤回不应指定得分方'); continue; }
      const ref = active.get(e.ref_seq), last = [...active.keys()].at(-1);
      if (!ref || e.ref_seq !== last || no !== ref.set_no) { errors.push('只能撤回最后一次有效记分'); continue; }
      active.delete(e.ref_seq);
      scores[no][ref.side === 'home' ? 0 : 1]--;
      continue;
    }
    const decided = decide(), winners = [...decided.values()];
    const over = ['home', 'away'].some(side => winners.filter(w => w === side).length >= setsToWin(rules));
    const current = Array.from({ length: rules.max_sets }, (_, i) => i + 1).find(i => !decided.has(i));
    if (e.kind !== 'score' || !['home', 'away'].includes(e.side) || over || no !== current) {
      errors.push('比赛/局已结束或得分事件不合法'); continue;
    }
    scores[no] ||= [0, 0];
    const index = e.side === 'home' ? 0 : 1; scores[no][index]++;
    if (!legalScore(...scores[no], ruleForSet(rules, no))) { scores[no][index]--; errors.push('比分不合法'); continue; }
    if ((e.home_after !== undefined || e.away_after !== undefined) &&
        (e.home_after !== scores[no][0] || e.away_after !== scores[no][1])) errors.push('过程比分与回放不一致');
    active.set(e.seq, e);
  }
  return { scores, decided: new Set(decide().keys()), errors, rules };
}
export function summarize(events, rules = DEFAULT_RULES) {
  const state = replay(events, rules), { scores, decided, errors } = state;
  rules = state.rules;
  const setNos = Object.keys(scores).map(Number).filter(no => scores[no].some(Boolean)).sort((a, b) => a - b);
  const sets = setNos.map(no => ({ set_no: no, home_points: scores[no][0], away_points: scores[no][1],
    winner_side: winner(...scores[no], ruleForSet(rules, no)) || '' }));
  const winners = { home: 0, away: 0 };
  for (const s of sets) if (s.winner_side) winners[s.winner_side]++;
  const matchOver = Math.max(winners.home, winners.away) >= setsToWin(rules);
  const currentSet = matchOver ? null : Array.from({ length: rules.max_sets }, (_, i) => i + 1).find(no => !decided.has(no));
  return { sets, winners, matchOver, currentSet, rules, errors,
    liveScore: matchOver ? scores[setNos.at(-1)] || [0, 0] : scores[currentSet] || [0, 0],
    finishedSets: sets.filter(s => s.winner_side).length };
}
export function nextSeq(events) { return events.reduce((max, e) => Math.max(max, e.seq || 0), 0) + 1; }
export function addPoint(events, side, state = summarize(events)) {
  if (state.matchOver || state.errors?.length || !['home', 'away'].includes(side)) return null;
  const no = state.currentSet, rules = state.rules || DEFAULT_RULES;
  const [h, a] = state.liveScore, home = h + (side === 'home' ? 1 : 0), away = a + (side === 'away' ? 1 : 0);
  if (!legalScore(home, away, ruleForSet(rules, no))) return null;
  return { seq: nextSeq(events), kind: 'score', set_no: no, side,
    home_after: home, away_after: away, created_at: new Date().toISOString() };
}
export function isSetOpen(state, activeSet) {
  return !state.matchOver && !state.errors?.length && Number(activeSet) === Number(state.currentSet);
}
export function undoTarget(events) {
  const active = new Map();
  for (const e of events) {
    if (e.kind === 'score') active.set(e.seq, e);
    else if (e.kind === 'undo') active.delete(e.ref_seq);
  }
  return [...active.values()].at(-1) || null;
}
export function undoEvent(events) {
  const target = undoTarget(events);
  return target ? { seq: nextSeq(events), kind: 'undo', set_no: target.set_no, side: '',
    ref_seq: target.seq, created_at: new Date().toISOString() } : null;
}

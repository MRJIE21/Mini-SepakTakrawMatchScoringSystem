/* Pure scoring parameters shared by settings, recording, recovery and review. */
export const DEFAULT_RULES = Object.freeze({ schema_version: 1, max_sets: 3,
  regular: Object.freeze({ mode: 'target', target_points: 15, win_by: 1, point_cap: 15 }), deciding: null });
function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}必须是 ${min}—${max} 的整数`);
  return value;
}
export function normalizeSet(value) {
  const allowed = value?.mode === 'target' ? ['mode', 'target_points', 'win_by', 'point_cap']
    : value?.mode === 'fixed_deuce' ? ['mode', 'target_points', 'deuce_points'] : [];
  if (!value || !allowed.length || Object.keys(value).sort().join() !== allowed.sort().join()) throw new Error('获胜方式或规则参数不正确');
  const target = integer(value.target_points, 2, 99, '目标分');
  if (value.mode === 'fixed_deuce') return { mode: value.mode, target_points: target,
    deuce_points: integer(value.deuce_points, target + 1, 999, '固定加赛分') };
  return { mode: value.mode, target_points: target, win_by: integer(value.win_by, 1, 2, '领先分差'),
    point_cap: value.point_cap === null ? null : integer(value.point_cap, target, 999, '封顶分') };
}
export function normalizeRules(value = DEFAULT_RULES) {
  if (!value || Object.keys(value).sort().join() !== ['schema_version', 'max_sets', 'regular', 'deciding'].sort().join()
      || value.schema_version !== 1) throw new Error('比赛规则格式或版本不受支持');
  const maximum = integer(value.max_sets, 1, 9, '最多局数');
  if (!(maximum % 2)) throw new Error('最多局数必须是奇数');
  return { schema_version: 1, max_sets: maximum, regular: normalizeSet(value.regular),
    deciding: value.deciding === null ? null : normalizeSet(value.deciding) };
}
export function setsToWin(rules = DEFAULT_RULES) { return (normalizeRules(rules).max_sets + 1) / 2; }
export function ruleForSet(rules, setNo) {
  const value = normalizeRules(rules); integer(setNo, 1, value.max_sets, '局次');
  return setNo === value.max_sets ? value.deciding || value.regular : value.regular;
}
export function winner(home, away, rawRule) {
  integer(home, 0, 2147483647, '主队得分'); integer(away, 0, 2147483647, '客队得分');
  const rule = normalizeSet(rawRule), high = Math.max(home, away), low = Math.min(home, away);
  if (high === low) return null;
  const done = rule.mode === 'fixed_deuce'
    ? high >= (low >= rule.target_points - 1 ? rule.deuce_points : rule.target_points)
    : high >= rule.target_points && (high - low >= rule.win_by || (rule.point_cap !== null && high >= rule.point_cap));
  return done ? home > away ? 'home' : 'away' : null;
}
export function legalScore(home, away, rule) {
  let expected; try { expected = winner(home, away, rule); } catch { return false; }
  const high = Math.max(home, away), low = Math.min(home, away), diff = high - low;
  const cap = rule.mode === 'target' ? rule.point_cap : rule.deuce_points;
  if (rule.mode === 'target' && rule.win_by === 1 && (high > rule.target_points || low >= rule.target_points)) return false;
  if (cap !== null && (high > cap || low >= cap)) return false;
  if (!expected) return true;
  if (rule.mode === 'fixed_deuce') return high === (low >= rule.target_points - 1 ? rule.deuce_points : rule.target_points);
  return (high === rule.target_points && diff >= rule.win_by) || (high > rule.target_points && diff === rule.win_by)
    || (cap !== null && high === cap && diff >= 1 && diff <= rule.win_by);
}
export function setSummary(rule) {
  rule = normalizeSet(rule);
  return rule.mode === 'fixed_deuce' ? `${rule.target_points}分，${rule.target_points - 1}平后先到${rule.deuce_points}分`
    : `${rule.target_points}分，${rule.win_by === 1 ? '直接获胜' : '须领先2分'}，${rule.point_cap === null ? '不封顶' : `${rule.point_cap}分封顶`}`;
}
export function rulesSummary(rules = DEFAULT_RULES) {
  rules = normalizeRules(rules);
  return `${rules.max_sets}局${setsToWin(rules)}胜 · ${setSummary(rules.regular)}；${rules.deciding ? `决胜局：${setSummary(rules.deciding)}` : '决胜局沿用'}`;
}
export function sameRules(a, b) { return JSON.stringify(normalizeRules(a)) === JSON.stringify(normalizeRules(b)); }
export const RULE_PRESETS = [
  ['15直接', { mode: 'target', target_points: 15, win_by: 1, point_cap: 15 }],
  ['15分领先两分，17封顶', { mode: 'target', target_points: 15, win_by: 2, point_cap: 17 }],
  ['15分，14平后打到17（规则参考）', { mode: 'fixed_deuce', target_points: 15, deuce_points: 17 }],
  ['21分领先两分，25封顶', { mode: 'target', target_points: 21, win_by: 2, point_cap: 25 }],
];

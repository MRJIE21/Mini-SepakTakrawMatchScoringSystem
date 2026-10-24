const views = {
  admin: null,
  organizer: ['dashboard', 'setup', 'teamRules', 'schoolRegistration', 'workspace', 'matches', 'schedule', 'scheduling', 'field', 'display', 'scoring', 'individual', 'review', 'results', 'school', 'bracket', 'admin', 'account'],
  recorder: ['setup', 'teamRules', 'field', 'workspace', 'scoring', 'individual', 'review', 'account'],
  viewer: ['setup', 'teamRules', 'workspace', 'matches', 'results', 'school', 'bracket', 'account'],
  display_operator: ['setup', 'teamRules', 'workspace', 'matches', 'results', 'school', 'bracket', 'display', 'account'],
};
export function canView(role, name) {
  if (name === 'resultReview') return ['admin','organizer','recorder'].includes(role);
  return role === 'admin' || !!views[role]?.includes(name);
}
/* 工作台页签收敛为任务顺序：概况 → 报名 → 赛程（含分组） → 比赛/录入 → 成绩。
   旧 tab=tasks/review/groups 由 workspace.js 做兼容映射。 */
export function workspaceTabs(role, kind) {
  if (role === 'recorder') return [kind === 'team' ? 'matches' : 'entry'];
  // 查看者与大屏操作员只读；操作员不能进入需要报名/工作台写接口的页签。
  if (role === 'viewer' || role === 'display_operator') return kind === 'team' ? ['schedule', 'results'] : ['results'];
  return kind === 'team'
    ? ['overview', 'registration', 'schedule', 'matches', 'results']
    : ['overview', 'registration', 'entry', 'results'];
}

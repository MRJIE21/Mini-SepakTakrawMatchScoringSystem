const views = {
  admin: null,
  organizer: ['dashboard', 'setup', 'teamRules', 'schoolRegistration', 'workspace', 'catalog', 'matches', 'schedule', 'scheduling', 'field', 'display', 'scoring', 'individual', 'review', 'results', 'teamRankings', 'individualRankings', 'school', 'bracket', 'admin', 'account'],
  recorder: ['field', 'workspace', 'scoring', 'individual', 'review', 'account'],
  viewer: ['setup', 'teamRules', 'workspace', 'matches', 'results', 'teamRankings', 'individualRankings', 'school', 'bracket', 'account'],
  display_operator: ['setup', 'teamRules', 'workspace', 'matches', 'results', 'teamRankings', 'individualRankings', 'school', 'bracket', 'display', 'account'],
};
export function canView(role, name) { return role === 'admin' || !!views[role]?.includes(name); }
export function hasCapability(capabilities, name) {
  return Array.isArray(capabilities) && capabilities.includes(name);
}
export function workspaceTabs(role, kind) {
  if (role === 'recorder') return [kind === 'team' ? 'matches' : 'entry'];
  // 查看者与大屏操作员只读；操作员不能进入需要报名/工作台写接口的页签。
  if (role === 'viewer' || role === 'display_operator') return kind === 'team' ? ['schedule', 'results'] : ['results'];
  return kind === 'team' ? ['overview', 'registration', 'groups', 'schedule', 'matches', 'results'] : ['overview', 'registration', 'draw', 'entry', 'results'];
}

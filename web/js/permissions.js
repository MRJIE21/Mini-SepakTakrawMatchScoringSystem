const views = {
  admin: null,
  organizer: ['dashboard', 'setup', 'teamRules', 'schoolRegistration', 'workspace', 'catalog', 'matches', 'schedule', 'scheduling', 'field', 'scoring', 'individual', 'review', 'results', 'school', 'bracket', 'admin', 'account'],
  recorder: ['setup', 'teamRules', 'field', 'workspace', 'scoring', 'individual', 'review', 'account'],
  viewer: ['setup', 'teamRules', 'workspace', 'matches', 'results', 'school', 'bracket', 'account'],
};
export function canView(role, name) { return role === 'admin' || !!views[role]?.includes(name); }
export function workspaceTabs(role, kind) {
  if (role === 'recorder') return [kind === 'team' ? 'matches' : 'entry'];
  if (role === 'viewer') return kind === 'team' ? ['schedule', 'results'] : ['results'];
  return kind === 'team' ? ['overview', 'registration', 'groups', 'schedule', 'matches', 'results'] : ['overview', 'registration', 'entry', 'results'];
}

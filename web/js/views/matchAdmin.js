/* Old editor addresses lead to the single workbench schedule. */
import { registerView, go, state } from '../main.js';
import { h } from '../ui.js';

registerView({ name: 'matches', label: '比赛赛程', roles: ['admin', 'organizer', 'viewer'], render: ({ params }) => {
  const cat = state.structure?.groups.flatMap(g => g.categories).find(c => c.id === Number(params.category))
    || state.structure?.groups.flatMap(g => g.categories).find(c => c.kind === 'team');
  go('workspace', { event: state.eventId, category: cat?.id, tab: 'schedule' });
} });
registerView({ name: 'scheduling', label: '功能已移除', roles: ['admin', 'organizer'], render: ({ el, params }) => {
  el.append(h('div.panel', h('h2', '自动辅助编排已移除'), h('p', '分组和赛程统一在项目工作台维护。'),
    h('button.btn.btn-primary', { onclick: () => go('workspace', { event: state.eventId, category: params.category, tab: 'schedule' }) }, '进入比赛赛程')));
} });

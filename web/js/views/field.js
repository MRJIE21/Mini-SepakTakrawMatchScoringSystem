/* 记录员首页：仅以后台赛事项目展示现场入口。 */
import { registerView, state, go } from '../main.js';
import { h, emptyState, categoryLabel } from '../ui.js';

async function render({ el }) {
  if (!state.eventId) {
    el.append(emptyState({ text: '当前没有赛事', hint: '请联系组委会创建赛事并配置比赛项目。' }));
    return;
  }
  const categories = state.structure?.groups.flatMap((group) => group.categories.map((category) => ({
    ...category, group_name: group.name, group_id: group.id,
  }))) || [];
  const openProject = (category) => go('workspace', {
    event: state.eventId, group: category.group_id, category: category.id,
    tab: category.kind === 'team' ? 'matches' : 'entry',
  });
  el.append(h('div.panel', h('div.panel-head', h('h2', '现场任务')),
  h('div.small.muted', '选择比赛项目即可查找场次或录入个人赛成绩。')));

  if (!categories.length) {
    el.append(emptyState({ text: '当前赛事没有比赛项目', hint: '请联系组委会配置项目。' }));
    return;
  }
  for (const [kind, title] of [['team', '三人赛 · 查找场次'], ['individual', '个人赛 · 录入成绩']]) {
    const items = categories.filter((category) => category.kind === kind);
    if (!items.length) continue;
    el.append(h('div.panel', h('h3', title),
      h('div.stat-grid', ...items.map((category) => {
        return h('button.cat-card.workspace-choice', { onclick: () => openProject(category) },
          h('h4', categoryLabel(category, { withGroup: true })),
          h('div.small.muted', kind === 'team' ? '打开比赛记录队列' : '打开成绩录入名单'));
      }))));
  }
}

registerView({ name: 'field', label: '现场任务',
  roles: ['admin', 'organizer', 'recorder'], render });

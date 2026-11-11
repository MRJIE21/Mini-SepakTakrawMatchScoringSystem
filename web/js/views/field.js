/* 记录员首页：按项目进入记录，或按场地查看三人赛场次。 */
import { registerView, state, go } from '../main.js';
import { h, emptyState, errorState, field, selectInput } from '../ui.js';

async function render({ el, params, refresh }) {
  if (!state.eventId) {
    el.append(emptyState({ text: '当前没有赛事', hint: '请联系组委会创建赛事并配置比赛项目。' }));
    return;
  }
  const mode = params.mode === 'venue' || (!params.mode && params.venue) ? 'venue' : 'project';
  el.append(h('nav.workspace-sections', { 'aria-label': '现场任务筛选方式' },
    ...[['project', '按项目'], ['venue', '按场地']].map(([key, label]) => h('a', {
      href: `#/field?${new URLSearchParams({ event: state.eventId, mode: key })}`,
      class: key === mode ? 'active' : '',
      'aria-current': key === mode ? 'page' : null,
    }, label))));
  if (mode === 'venue') {
    await renderVenues(el, params, refresh);
    return;
  }

  const categories = state.structure?.groups.flatMap((group) => group.categories.map((category) => ({
    ...category, group_name: group.name, group_id: group.id,
  }))) || [];
  const openProject = (category) => go('workspace', {
    event: state.eventId, group: category.group_id, category: category.id,
    tab: category.kind === 'team' ? 'matches' : 'entry',
  });

  if (!categories.length) {
    el.append(emptyState({ text: '当前赛事没有比赛项目', hint: '请联系组委会配置项目。' }));
    return;
  }
  const groupPanel = h('div');
  const projectButtons = [];
  const projects = [['team', 'male', '男子三人赛'], ['team', 'female', '女子三人赛'],
    ['individual', 'male', '男子个人赛'], ['individual', 'female', '女子个人赛']];
  el.append(h('div.panel.field-project-panel', h('h3', '选择比赛项目'),
    h('div.field-project-grid', ...projects.map(([kind, gender, title]) => {
      const items = categories.filter((category) => category.kind === kind && category.gender === gender);
      const button = h('button.workspace-choice.field-project-card.field-project-toggle', { 'aria-pressed': 'false', onclick: () => {
        projectButtons.forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
        groupPanel.replaceChildren(h('div.panel.field-project-panel', h('h3', `${title} · 选择组别`),
          items.length ? h('div.field-project-grid', ...items.map((category) =>
            h('button.workspace-choice.field-project-card', { onclick: () => openProject(category) },
              h('div.field-project-copy', h('h4', category.group_name)),
              h('span.field-project-arrow', { 'aria-hidden': 'true' }, '›'))))
            : emptyState({ text: '当前赛事没有该比赛项目' })));
      } }, h('div.field-project-copy', h('h4', title)));
      projectButtons.push(button);
      return button;
    }))), groupPanel);
}

async function renderVenues(el, params, refresh) {
  const venues = state.structure?.venues || [];
  if (!venues.length) {
    el.append(emptyState({ text: '当前赛事没有场地' }));
    return;
  }
  const venue = venues.find((item) => String(item.id) === params.venue) || venues[0];
  el.append(h('div.panel.field-project-panel',
    field('按场地查看三人赛', selectInput(venues.map((item) => [item.id, item.name]),
      venue.id, { onchange: (event) => go('field', {
        event: state.eventId, mode: 'venue', venue: event.target.value,
      }) }))));
  const venueQueue = h('div');
  el.append(venueQueue);
  try {
    await state.views.scoring.render({ el: venueQueue, params: { from: 'field', venue: String(venue.id) }, refresh });
  } catch (error) {
    if (!error.cancelled) venueQueue.replaceChildren(h('div.panel', errorState(error, refresh)));
  }
}

registerView({ name: 'field', label: '现场任务',
  roles: ['admin', 'organizer', 'recorder'], render });

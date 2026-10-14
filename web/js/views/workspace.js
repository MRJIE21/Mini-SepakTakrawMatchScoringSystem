import { workspaceTabs } from '../permissions.js';
/* 以比赛项目为中心的工作台：统一上下文、二级导航、概况待办与报名闭环。 */
import { api } from '../api.js';
import { registerView, state, loadStructure, reloadShell, go } from '../main.js';
import { rosterView } from './catalog.js';
import { matchingCategory, workspaceLink } from '../workspaceContext.js';
import {
  h, clear, selectInput, statusBadge, emptyState, errorState, loadingState, categoryLabel, toast, fmtDateTime,
} from '../ui.js';

const TAB_LABELS = {
  overview: '概况与待办', registration: '报名名单', schedule: '分组与赛程',
  matches: '比赛记录', entry: '成绩录入', results: '成绩与名次',
};

function contextKey(eventId, categoryId, tab) {
  return `stss_workspace:${state.user.username}:${eventId}:${categoryId}:${tab}`;
}

function readPageState(eventId, categoryId, tab) {
  try { return JSON.parse(localStorage.getItem(contextKey(eventId, categoryId, tab))) || {}; }
  catch { return {}; }
}

function writePageState(eventId, categoryId, tab, value) {
  try { localStorage.setItem(contextKey(eventId, categoryId, tab), JSON.stringify(value)); }
  catch { /* 状态记忆失败不影响业务提交 */ }
}

function lastCategoryKey(eventId) {
  return `stss_workspace_last:${state.user.username}:${eventId}`;
}

function openTab(category, tab, replace = false, options = {}) {
  const allowed = workspaceTabs(state.user.role, category.kind);
  const next = allowed.includes(tab) ? tab : allowed[0];
  const hash = workspaceLink(category, next, options);
  if (replace) history.replaceState(null, '', hash); else location.hash = hash;
}

async function render({ el, params, refresh }) {
  if (!state.events.length) {
    el.append(emptyState({ text: '还没有赛事', hint: '请先创建赛事并配置组别与项目。',
      action: state.user.role === 'admin' ? h('button.btn.btn-primary', { onclick: () => go('dashboard') }, '创建赛事') : null }));
    return;
  }

  const requestedEvent = params.event ? Number(params.event) : state.eventId;
  const event = state.events.find((item) => item.id === requestedEvent);
  if (!event) {
    renderInvalid(el, '链接中的赛事不存在或当前账号不可访问。');
    return;
  }
  if (state.eventId !== event.id) await reloadShell(event.id);
  const structure = state.structure || await loadStructure();
  const choices = structure.groups.flatMap((group) => group.categories.map((category) => ({
    ...category, group_name: group.name, group_id: group.id, event_id: event.id,
  })));
  if (!choices.length) {
    el.append(emptyState({ text: '当前赛事还没有比赛项目', hint: '先配置组别与项目，再进入项目工作台。',
      action: state.user.role === 'admin' ? h('button.btn.btn-primary', { onclick: () => go('setup', { step: 'categories' }) }, '配置项目') : null }));
    return;
  }

  let categoryId = Number(params.category || 0);
  if (!categoryId && params.category !== '0') {
    try { categoryId = Number(localStorage.getItem(lastCategoryKey(event.id)) || 0); } catch { /* 可直接选项目 */ }
  }
  if (!categoryId) {
    renderChooser(el, event, choices);
    return;
  }
  const category = choices.find((item) => item.id === categoryId);
  if (!category || (params.group && Number(params.group) !== category.group_id)) {
    renderInvalid(el, '链接中的项目不存在，或项目与赛事、组别不一致。', event, choices);
    return;
  }
  try { localStorage.setItem(lastCategoryKey(event.id), String(category.id)); } catch { /* 导航不依赖缓存 */ }

  const allowedTabs = workspaceTabs(state.user.role, category.kind);
  const requestedTab = params.tab || 'overview';
  const tab = allowedTabs.includes(requestedTab) ? requestedTab : allowedTabs[0];
  if (!params.event || !params.group || !params.category || tab !== requestedTab) {
    openTab(category, tab, true);
  }

  const groups = structure.groups.filter((item) => item.categories.length);
  const groupSelect = selectInput(groups.map((item) => [item.id, item.name]), category.group_id);
  const categorySelect = selectInput(
    groups.find((item) => item.id === category.group_id).categories
      .map((item) => [item.id, categoryLabel(item)]), category.id);
  const switchTab = (next) => {
    const supported = (workspaceTabs(state.user.role, next.kind)).includes(tab);
    if (!supported) toast('目标项目不支持当前页签，已切换到概况与待办', 'info');
    openTab(next, supported ? tab : 'overview');
  };
  groupSelect.onchange = () => {
    const nextGroup = groups.find((item) => item.id === Number(groupSelect.value));
    const next = nextGroup && matchingCategory(nextGroup.categories, category);
    if (next) switchTab({ ...next, group_id: nextGroup.id, event_id: event.id });
  };
  categorySelect.onchange = () => {
    const next = choices.find((item) => item.id === Number(categorySelect.value));
    if (next) switchTab(next);
  };
  el.append(h('div.ctx-bar',
    h('div.ctx-path', h('div.small.muted', event.name),
      h('h2', `${category.group_name} · ${categoryLabel(category)}`)),
    h('div.workspace-switchers',
      h('label.context-field', h('span', '大组别'), groupSelect),
      h('span.context-arrow', { 'aria-hidden': 'true' }, '›'),
      h('label.context-field', h('span', '比赛项目'), categorySelect)),
    h('button.btn', { onclick: () => renderChooserReset(event) }, '全部项目')));
  el.append(h('nav.ctx-tabs', { 'aria-label': '项目工作台导航' }, ...allowedTabs.map((key) => h('a', {
    href: workspaceLink(category, key),
    class: key === tab ? 'active' : '',
    'aria-current': key === tab ? 'page' : null,
  }, TAB_LABELS[key]))));

  const content = h('div.workspace-content');
  el.append(content);
  const saved = readPageState(event.id, category.id, tab);
  await renderTab(content, category, tab, saved, refresh, params);
  if (!params.pool && !params.stage) requestAnimationFrame(() => window.scrollTo(0, Number(saved.scrollY || 0)));
  window.addEventListener('hashchange', () => {
    writePageState(event.id, category.id, tab, { ...saved, scrollY: window.scrollY });
  }, { once: true });
}

function renderChooser(el, event, choices) {
  el.append(h('div.panel', h('h2', '选择比赛项目'),
    h('div.small.muted.mb', `${event.name} · 选择后进入该项目的报名、赛程或成绩工作台。`),
    h('div.stat-grid', ...choices.map((category) => h('button.cat-card.workspace-choice', {
      onclick: () => openTab(category, 'overview'),
    }, h('h4', categoryLabel(category, { withGroup: true })),
    h('div.small.muted', category.kind === 'team' ? '三人赛工作台' : '个人赛工作台'))))));
}

function renderInvalid(el, message, event = null, choices = []) {
  el.append(h('div.panel', errorState(new Error(message))),
    h('div.panel', h('div.row',
      choices.length ? h('button.btn.btn-primary', { onclick: () => renderChooserReset(event) }, '重新选择项目') : null,
      h('button.btn', { onclick: () => go('dashboard') }, '返回赛事首页'))));
}

function renderChooserReset(event) {
  try { localStorage.removeItem(lastCategoryKey(event.id)); } catch { /* 忽略 */ }
  location.hash = `#/workspace?event=${event.id}`;
}

async function renderTab(el, category, tab, saved, refresh, params) {
  if (tab === 'overview') return renderOverview(el, category);
  if (tab === 'registration') return renderRegistration(el, category, saved, params);
  if (tab === 'schedule') return renderSchedule(el, category, saved, refresh, params);
  const mapping = { matches: 'scoring', entry: 'individual', results: 'results' };
  const view = state.views[mapping[tab]];
  if (!view) throw new Error('对应业务页面尚未载入');
  return view.render({ el, params: {
    category: category.id, embedded: 'workspace', from: 'workspace',
    ...(params.status ? { status: params.status } : {}),
    ...(params.pool ? { pool: params.pool } : {}),
  }, state, refresh });
}

async function renderSchedule(el, category, saved, refresh, params) {
  const canManage = ['admin', 'organizer'].includes(state.user.role);
  const mode = canManage && params.view === 'planning' ? 'planning' : 'fixtures';
  if (canManage) el.append(h('nav.workspace-schedule-nav', { 'aria-label': '赛程操作' },
    ...[['fixtures', '比赛列表与场地'], ['planning', '抽签与编排']].map(([key, label]) => h('a', {
      href: workspaceLink(category, 'schedule', { view: key }),
      class: mode === key ? 'active' : '', 'aria-current': mode === key ? 'page' : null,
    }, label)),
    h('span.small.muted', '逐场录入或抽签编排，沿用同一项目的赛程')));
  const child = h('div'); el.append(child);
  const view = state.views[mode === 'planning' ? 'scheduling' : 'matches'];
  return view.render({ el: child, params: {
    category: category.id, embedded: 'workspace', from: 'workspace', draw: params.draw, stage: params.stage,
    status: params.status ?? saved.status ?? '',
    onPlanning: (draw = false) => openTab(category, 'schedule', false, { view: 'planning', ...(draw ? { draw: 1 } : {}) }),
    onStatusChange: (value) => {
      saved.status = value;
      writePageState(category.event_id, category.id, 'schedule', saved);
      history.replaceState(null, '', workspaceLink(category, 'schedule', { view: mode, ...(value ? { status: value } : {}) }));
    },
  }, state, refresh });
}

async function renderOverview(el, category) {
  clear(el);
  el.append(h('div.panel', loadingState('正在计算项目状态…')));
  try {
    const data = await api.get(`/api/categories/${category.id}/workspace`);
    clear(el);
    const c = data.counts;
    const runAction = ({ tab, label, ...options }) => openTab(category, tab, false, options);
    const metric = (value, label, action) => h('button.workspace-metric', {
      onclick: () => runAction(action), 'aria-label': `${label}，${value}，点击查看`,
    }, h('b', String(value)), h('span', label), h('span.metric-arrow', { 'aria-hidden': 'true' }, '›'));
    el.append(h('section.panel.workspace-summary', { 'aria-label': '项目进度', style: `--workspace-step-count:${data.steps.length}` },
      h('div.panel-head', h('div', h('h3', '项目进度'), h('div.small.muted', '点击进度或待办，直接进入对应操作')),
        h('button.btn', { onclick: () => renderOverview(el, category) }, '刷新项目状态')),
      h('nav.project-steps', { 'aria-label': '项目流程' }, ...data.steps.map((step, index) => h('button.project-step', {
        class: `${step.state}${step.tab === data.primary_action.tab ? ' next' : ''}`,
        onclick: () => openTab(category, step.tab),
      }, h('div.project-step-heading', h('span.step-number', String(index + 1)), h('strong', step.label),
        step.tab === data.primary_action.tab ? statusBadge('下一步', 'info') : null),
      h('b', step.summary), h('span.small.muted', step.detail)))),
      h('div.workspace-metrics',
        metric(c.profiles_incomplete, '资料待补充', { tab: 'registration', profile: 'incomplete' }),
        category.kind === 'team'
          ? [metric(c.matches_scoreable, '可记录场次', { tab: 'matches', status: 'ready' }),
            metric(c.pools_to_confirm, '小组排名待确认', { tab: 'results' }),
            metric(c.matches_unscheduled, '场地或时间待安排', { tab: 'schedule', view: 'fixtures' })]
          : [metric(c.individual_results_missing, '成绩待录入', { tab: 'entry' }),
            metric(c.individual_results_unconfirmed, '成绩待确认', { tab: 'entry' }),
            metric(c.placements_pending, '名次待确认', { tab: 'results' })]),
      h('div.workspace-next', h('div.grow', h('span.small.muted', '当前建议'), h('h3', data.task)),
        h('button.btn.btn-primary', { onclick: () => runAction(data.primary_action) }, data.primary_action.label))));

    const work = category.kind === 'team' ? renderUpcoming(category, data) : h('section.panel',
      h('div.panel-head', h('h3', '个人赛成绩'), statusBadge(`${c.individual_results} / ${c.enrolled} 位已录入`, 'info')),
      h('p', c.individual_results_missing ? `还有 ${c.individual_results_missing} 位运动员没有后台保存的成绩。`
        : c.individual_results_unconfirmed ? `${c.individual_results_unconfirmed} 位运动员的成绩已保存到后台，待核对确认。`
          : '已报名运动员的成绩已全部录入，可核对名次与学校积分。'),
      h('div.row', h('button.btn.btn-primary', { onclick: () => openTab(category, 'entry') }, '进入成绩录入'),
        h('button.btn', { onclick: () => openTab(category, 'results') }, '查看成绩与名次')));
    const todos = h('section.panel.workspace-tasks', { 'aria-label': '待办事项' },
      h('div.panel-head', h('h3', '待办事项'), statusBadge(String(data.tasks.length), data.tasks.length ? 'warn' : 'ok')));
    if (!data.tasks.length) todos.append(h('div.empty-inline', '当前没有其他待办，按上方建议继续操作。'));
    for (const item of data.tasks) {
      todos.append(h('div.workspace-task', h('strong', item.message), h('div.small.muted', item.detail),
        item.items?.length ? h('div.workspace-gap-list', ...item.items.slice(0, 3).map((part) => h('div.workspace-gap',
          h('div', h('b', part.display), h('div.small.muted', part.gaps.join('、'))),
          h('button.btn.small', { onclick: () => go('schoolRegistration', {
            event: category.event_id, group: category.group_id, school: part.school_id,
          }) }, '补资料'))), item.items.length > 3 ? h('div.small.muted', `另有 ${item.items.length - 3} 所学校待补充`) : null) : null,
        h('button.btn', { onclick: () => runAction(item.action) }, item.action.label)));
    }
    el.append(h('div.workspace-overview-grid', h('div.workspace-main', work), todos));
  } catch (error) {
    clear(el); el.append(h('div.panel', errorState(error, () => renderOverview(el, category))));
  }
}

function renderUpcoming(category, data) {
  const c = data.counts;
  const panel = h('section.panel.workspace-upcoming', { 'aria-label': '可记录场次' },
    h('div.panel-head', h('div', h('h3', `可记录场次（${c.matches_scoreable}）`),
      h('div.small.muted', '优先显示已安排时间的比赛；进入记录后领取该场任务')),
    h('button.btn', { onclick: () => openTab(category, 'matches', false, { status: 'ready' }) }, '查看全部场次')));
  if (data.upcoming_matches.length) {
    panel.append(h('div.workspace-match-list', ...data.upcoming_matches.map((match) => h('article.workspace-match',
      h('div.workspace-match-main', h('div.small.muted', `${match.stage_name || ''} · ${match.round_label} · 第 ${match.seq} 场`),
        h('div.workspace-match-teams', h('strong', match.home.label), h('span.small.muted', 'vs'), h('strong', match.away.label)),
        h('div.small.muted', `${match.venue_name || '场地待安排'} · ${match.scheduled_at ? fmtDateTime(match.scheduled_at) : '时间待安排'}`)),
      h('div.workspace-match-action', match.recorder_name ? h('span.small.muted', `记录员：${match.recorder_name}`) : null,
        h('button.btn.btn-primary', { onclick: () => go('scoring', {
          match: match.id, category: category.id, from: 'workspace',
        }) }, match.recorder_id ? (match.recorder_id === state.user.id ? '继续记录' : '查看任务') : '进入记录'))))));
  } else {
    const done = (c.matches_total > 0 || c.matches_void > 0) && c.matches_finished === c.matches_total && !c.stages_next_round;
    panel.append(h('div.workspace-empty', h('h4', c.stages_next_round ? '当前轮比赛已确认，待生成下一轮' : done ? '本项目比赛已全部处理完成' : c.matches_pending ? '后续比赛正在等待晋级名单' : '当前没有可记录的比赛'),
      h('p.muted', done ? '继续核对小组排名和项目名次。' : data.plan?.status === 'previewed'
        ? '赛程预览确认后，已确定双方的场次会出现在这里。' : '先准备参赛名单和赛程；已确认比赛可在场次列表中查看。'),
      h('button.btn', { onclick: () => c.stages_next_round
        ? openTab(category, 'schedule', false, { view: 'planning', stage: data.primary_action.stage })
        : openTab(category, done ? 'results' : 'schedule') }, done ? '查看成绩与名次' : '查看分组与赛程')));
  }
  if (data.waiting_matches.length) panel.append(h('details.workspace-waiting',
    h('summary', `待晋级场次（${c.matches_pending}）`),
    ...data.waiting_matches.map((match) => h('div.workspace-waiting-match',
      h('b', `${match.round_label} · 第 ${match.seq} 场`),
      h('div.small.muted', [match.home.label || match.home.reason, match.away.label || match.away.reason].filter(Boolean).join('；')))),
    h('button.btn.small', { onclick: () => openTab(category, 'schedule', false, { status: 'pending' }) }, '查看晋级关系')));
  return panel;
}

async function renderRegistration(el, category, saved, params = {}) {
  clear(el);
  el.append(h('div.panel', loadingState('正在加载报名名单…')));
  try {
    const data = await api.get(`/api/categories/${category.id}/participations`);
    clear(el);
    const panel = h('div.panel', h('div.panel-head', h('h3', '报名名单'),
      h('button.btn', { onclick: () => go('schoolRegistration', { event: category.event_id, group: category.group_id }) }, '按学校集中整理报名')));
    const filters = { q: '', status: 'all', profile: 'all', ...saved.filters };
    if (params.profile) filters.profile = params.profile;
    panel.append(rosterView(data.category, data.participations,
      () => renderRegistration(el, category, saved), filters,
      (next) => {
        saved.filters = { ...next };
        writePageState(category.event_id, category.id, 'registration', saved);
        // 待办链接的筛选只初始化一次，用户随后改变筛选应保留自己的选择。
        if (params.profile) {
          delete params.profile;
          history.replaceState(null, '', workspaceLink(category, 'registration'));
        }
      }));
    el.append(panel);
  } catch (error) {
    clear(el); el.append(h('div.panel', errorState(error, () => renderRegistration(el, category, saved))));
  }
}

registerView({ name: 'workspace', label: '项目工作台',
  roles: ['admin', 'organizer', 'recorder', 'viewer'], render });

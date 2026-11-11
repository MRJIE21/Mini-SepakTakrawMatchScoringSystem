import { workspaceTabs } from '../permissions.js';
/* 以比赛项目为中心的工作台：统一上下文、二级导航、概况待办与报名闭环。 */
import { api, captureRequestContext } from '../api.js';
import { registerView, state, loadStructure, reloadShell, go, replaceViewParams } from '../main.js';
import { matchingCategory, workspaceLink, workspaceTab, workspaceSection, workspaceSectionLink, groupWorkspaceLink, workspaceSchoolLink, resolveSchoolContext } from '../workspaceContext.js';
import {
  h, clear, selectInput, statusBadge, emptyState, errorState, loadingState, categoryLabel, toast, fmtDateTime,
} from '../ui.js';

const TAB_LABELS = {
  overview: '概况', registration: '报名', groups: '分组', schedule: '赛程',
  matches: '比赛', draw: '抽签', entry: '成绩录入', results: '成绩',
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

function lastContextKey(eventId, section) {
  return `stss_workspace_context:${state.user.username}:${eventId}:${section}`;
}

function readContext(eventId, section) {
  try {
    const saved = localStorage.getItem(lastContextKey(eventId, section));
    if (saved !== null) return JSON.parse(saved) || {};
    // 首次进入阶段兼容升级前的位置；之后两个阶段独立写入。
    return { category: localStorage.getItem(`stss_workspace_last:${state.user.username}:${eventId}`) };
  }
  catch { return {}; }
}

function renderSections(el, section, canRegister, params) {
  el.append(h('nav.workspace-sections', { 'aria-label': '项目工作台阶段' },
      ...['registration', 'competition'].map(key => h('a', {
        href: workspaceSectionLink(key, params), class: key === section ? 'active' : '',
        'aria-current': key === section ? 'page' : null,
        ...(key === 'registration' && !canRegister ? { 'aria-disabled': 'true', tabindex: '-1',
          onclick: e => e.preventDefault(), title: '当前角色无报名权限' } : {}),
      }, key === 'registration' ? '赛前报名' : '赛中工作'))));
}

function openTab(category, tab, replace = false, options = {}) {
  const allowed = workspaceTabs(state.user.role, category.kind);
  const next = allowed.includes(tab) ? tab : allowed[0];
  const hash = workspaceLink(category, next, options);
  if (replace) history.replaceState(null, '', hash); else location.hash = hash;
}

async function render({ el, params, refresh, signal, requestContext = captureRequestContext(), isCurrent = () => true }) {
  const alive = () => el.isConnected && !signal?.aborted && isCurrent();
  const context = { refresh, signal, requestContext, isCurrent: alive };
  if (!state.events.length) {
    el.append(emptyState({ text: '还没有赛事', hint: '请先创建赛事。',
      action: state.user.role === 'admin' ? h('button.btn.btn-primary', { onclick: () => go('dashboard') }, '创建赛事') : null })); return;
  }
  const requestedEvent = params.event ? Number(params.event) : state.eventId;
  const event = state.events.find(item => item.id === requestedEvent);
  if (!event) { renderInvalid(el, '链接中的赛事不存在或当前账号不可访问。'); return; }
  if (state.eventId !== event.id) await reloadShell(event.id);
  if (!alive()) return;
  const structure = state.structure || await loadStructure();
  if (!alive() || structure?.event.id !== event.id) return;
  const choices = structure.groups.flatMap(group => group.categories.map(category => ({
    ...category, group_name: group.name, group_id: group.id, event_id: event.id,
  })));
  const canRegister = workspaceTabs(state.user.role, 'team').includes('registration');
  const section = canRegister ? workspaceSection(params) : 'competition';
  const registration = section === 'registration';
  const requestedTab = workspaceTab(params) || (registration ? 'registration' : 'overview');
  const previous = readContext(event.id, section);
  // 只恢复仍属于当前赛事的记忆；显式链接始终交给严格校验。
  const previousGroup = structure.groups.find(group => group.id === Number(previous.group))
    || structure.groups.find(group => group.categories.some(category => category.id === Number(previous.category)));
  const remembered = previousGroup?.categories.find(category => category.id === Number(previous.category))?.id;
  if (!params.group && !params.category && !params.school && previousGroup) {
    params = { ...params, group: previousGroup.id, ...(remembered ? { category: remembered } : {}) };
  }
  let schoolData = null;
  if (registration && params.school) {
    schoolData = await api.get(`/api/schools/${encodeURIComponent(params.school)}/registration-workspace`, { context: requestContext, signal });
    if (!alive()) return;
  }
  // 报名可在无项目组别维护人员；其他页签只在有项目的组别选择默认位置。
  const defaultCategory = choices.find(item => item.id === Number(remembered)) || choices[0];
  const contextParams = registration ? params : { ...params, school: null,
    ...(!params.group && !params.category ? { category: defaultCategory?.id } : {}) };
  const resolved = resolveSchoolContext(structure, contextParams, schoolData, remembered);
  renderSections(el, section, canRegister, { event: event.id, group: resolved.group?.id, category: resolved.category?.id });
  replaceViewParams({ section });
  if (!resolved.group) {
    el.append(emptyState({ text: '当前赛事还没有组别', hint: '添加组别后即可配置比赛项目与报名。',
      action: state.user.role === 'admin' ? h('a.btn', { href: '#/setup?step=structure' }, '配置组别与项目') : null })); return;
  }
  try { localStorage.setItem(lastContextKey(event.id, section), JSON.stringify({ group: resolved.group.id, category: resolved.category?.id })); } catch {}
  if (!resolved.category) {
    if (registration) return renderGroupRegistration(el, event, resolved.group, structure.groups, params, context, schoolData);
    renderInvalid(el, '当前组别还没有比赛项目，请先配置项目。', event); return;
  }
  const category = choices.find(item => item.id === resolved.category.id);
  const allowedTabs = workspaceTabs(state.user.role, category.kind).filter(key => registration ? key === 'registration' : key !== 'registration');
  const tab = allowedTabs.includes(requestedTab) ? requestedTab : allowedTabs[0];
  replaceViewParams({ event: event.id, group: category.group_id, category: category.id, tab, section,
    view: null, school: tab === 'registration' ? params.school : null });
  const groups = canRegister && tab === 'registration' ? structure.groups : structure.groups.filter(item => item.categories.length);
  const groupSelect = selectInput(groups.map(item => [item.id, item.name]), category.group_id);
  const categorySelect = selectInput(groups.find(item => item.id === category.group_id).categories.map(item => [item.id, categoryLabel(item)]), category.id);
  groupSelect.setAttribute('aria-label', '大组别');
  categorySelect.setAttribute('aria-label', '比赛项目');
  const restore = () => { groupSelect.value = String(category.group_id); categorySelect.value = String(category.id); };
  groupSelect.onchange = () => {
    const group = groups.find(item => item.id === Number(groupSelect.value)); restore(); if (!group) return;
    const next = matchingCategory(group.categories, category);
    if (next) openTab({ ...next, group_id: group.id, event_id: event.id }, tab);
    else location.hash = groupWorkspaceLink({ event_id: event.id, id: group.id }, 'registration');
  };
  categorySelect.onchange = () => { const next = choices.find(item => item.id === Number(categorySelect.value)); restore(); if (next) openTab(next, tab); };
  el.append(h('div.ctx-bar', h('div.ctx-path', h('h2', registration
    ? `${category.group_name} · 学校报名` : `${category.group_name} · ${categoryLabel(category)}`)),
    h('div.workspace-switchers', h('div.context-field', groupSelect),
      registration ? null : [h('span.context-arrow', '›'), h('label.context-field', h('span', '比赛项目'), categorySelect)])));
  el.append(h('nav.ctx-tabs', { 'aria-label': '项目工作台导航', 'data-count': allowedTabs.length }, ...allowedTabs.map(key => h('a', {
    href: workspaceLink(category, key, key === 'registration' && params.school ? { school: params.school } : {}),
    class: key === tab ? 'active' : '', 'aria-current': key === tab ? 'page' : null,
  }, TAB_LABELS[key]))));
  const content = h('div.workspace-content'); el.append(content);
  const saved = readPageState(event.id, category.id, tab);
  await renderTab(content, category, tab, saved, { ...context, schoolData }, params);
  if (alive() && !params.pool && !params.stage && !params.school) requestAnimationFrame(() => { if (alive()) window.scrollTo(0, Number(saved.scrollY || 0)); });
  if (alive()) window.addEventListener('hashchange', () => {
    if (el.isConnected && !signal?.aborted) writePageState(event.id, category.id, tab, { ...saved, scrollY: window.scrollY });
  }, { signal });
}

function renderInvalid(el, message, event = null) {
  el.append(h('div.panel', errorState(new Error(message))),
    h('div.panel', h('div.row',
      event ? h('a.btn.btn-primary', { href: `#/workspace?event=${event.id}` }, '返回工作台') : null,
      h('button.btn', { onclick: () => go('dashboard') }, '返回赛事首页'))));
}

async function renderTab(el, category, tab, saved, context = {}, params = {}) {
  if (tab === 'overview') return renderOverview(el, category);
  if (tab === 'registration') return renderRegistration(el, category, saved, params, context);
  if (tab === 'groups' || tab === 'schedule') return renderSchedule(el, category, saved, context, params, tab);
  const mapping = { matches: 'scoring', draw: 'individual', entry: 'individual', results: 'results' };
  const view = state.views[mapping[tab]];
  if (!view) throw new Error('对应业务页面尚未载入');
  return view.render({ el, params: {
    category: category.id, embedded: 'workspace', from: 'workspace', mode: tab === 'draw' ? 'draw' : 'entry',
    ...(params.status ? { status: params.status } : {}),
    ...(params.pool ? { pool: params.pool } : {}),
  }, state, refresh: context.refresh, signal: context.signal,
    requestContext: context.requestContext, isCurrent: context.isCurrent });
}

async function renderSchedule(el, category, saved, context, params, tab) {
  const view = state.views.schedule;
  return view.render({ el, params: {
    category: category.id, embedded: 'workspace', from: 'workspace', draw: params.draw, stage: params.stage,
    view: tab === 'groups' ? 'groups' : 'fixtures',
    sort: params.sort, venue: params.venue,
    status: params.status ?? saved.status ?? '',
  }, state, refresh: context.refresh, signal: context.signal, requestContext: context.requestContext, isCurrent: context.isCurrent });
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
      h('div.panel-head', h('div', h('h3', '项目进度')),
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
          h('button.btn.small', { onclick: () => go('workspace', {
            event: category.event_id, group: category.group_id, tab: 'registration', school: part.school_id,
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
    h('div.panel-head', h('div', h('h3', `可记录场次（${c.matches_scoreable}）`)),
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
    const done = (c.matches_total > 0 || c.matches_void > 0) && c.matches_finished === c.matches_total;
    panel.append(h('div.workspace-empty', h('h4', done ? '本项目比赛已全部处理完成' : c.matches_pending ? '后续比赛正在等待晋级名单' : '当前没有可记录的比赛'),
      h('p.muted', done ? '继续核对小组排名和项目名次。' : data.plan?.status === 'previewed'
        ? '赛程预览确认后，已确定双方的场次会出现在这里。' : '先准备参赛名单和赛程；已确认比赛可在场次列表中查看。'),
      h('button.btn', { onclick: () => openTab(category, done ? 'results' : 'schedule') }, done ? '查看成绩与名次' : '查看赛程')));
  }
  if (data.waiting_matches.length) panel.append(h('details.workspace-waiting',
    h('summary', `待晋级场次（${c.matches_pending}）`),
    ...data.waiting_matches.map((match) => h('div.workspace-waiting-match',
      h('b', `${match.round_label} · 第 ${match.seq} 场`),
      h('div.small.muted', [match.home.label || match.home.reason, match.away.label || match.away.reason].filter(Boolean).join('；')))),
    h('button.btn.small', { onclick: () => openTab(category, 'schedule', false, { status: 'pending' }) }, '查看晋级关系')));
  return panel;
}

/* 报名名单只使用原学校报名流程；资料待补也是学校列表筛选。 */
async function renderRegistration(el, category, saved, params = {}, context = {}) {
  const schoolView = state.views.schoolRegistration;
  if (!schoolView) throw new Error('学校报名组件尚未载入');
  const groupId = category?.group_id || Number(params.group);
  if (params.school) return schoolView.render({ el,
    params: { ...params, group: groupId, category: category?.id, embedded: 'workspace', initialSchoolData: context.schoolData },
    signal: context.signal, requestContext: context.requestContext, isCurrent: context.isCurrent });
  let incomplete = null;
  if (category && params.profile === 'incomplete') {
    const summary = await api.get(`/api/categories/${category.id}/workspace`, { signal: context.signal, context: context.requestContext });
    if (!context.isCurrent()) return;
    incomplete = summary.reminders.find(item => item.code === 'profiles_incomplete')?.items || [];
  }
  const directory = h('div'); el.append(directory);
  await schoolView.renderDirectory({ el: directory, groupId, categoryId: category?.id, profile: params.profile, incomplete,
    signal: context.signal, requestContext: context.requestContext, isCurrent: context.isCurrent });
}

async function renderGroupRegistration(el, event, group, groups, params, context, schoolData) {
  replaceViewParams({ event: event.id, group: group.id, category: null, tab: 'registration', school: params.school || null });
  const select = selectInput(groups.map(item => [item.id, item.name]), group.id);
  select.setAttribute('aria-label', '大组别');
  select.onchange = () => { const next = Number(select.value); select.value = String(group.id);
    location.hash = groupWorkspaceLink({ event_id: event.id, id: next }, 'registration'); };
  el.append(h('div.ctx-bar', h('div.ctx-path', h('h2', `${group.name} · 报名名单`)),
    h('div.workspace-switchers', h('div.context-field', select), h('span.small.muted', '尚未开设项目，可先维护学校与人员'))));
  el.append(h('nav.ctx-tabs', { 'aria-label': '项目工作台导航' }, h('a.active', { href: groupWorkspaceLink({ event_id: event.id, id: group.id }, 'registration') }, '报名名单')));
  const content = h('div.workspace-content'); el.append(content);
  await renderRegistration(content, null, {}, { ...params, event: event.id, group: group.id }, { ...context, schoolData });
}

registerView({ name: 'workspace', label: '项目工作台',
  roles: ['admin', 'organizer', 'recorder', 'viewer'], render });

// 历史学校与人员入口继续可用，权限仍由 catalog 的既有 canView 规则检查。
registerView({ name: 'catalog', label: '学校与人员', render: ({ params }) => {
  go('workspace', { ...params, section: 'registration', tab: 'registration' });
} });

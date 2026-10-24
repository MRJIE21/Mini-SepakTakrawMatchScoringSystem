import { workspaceTabs } from '../permissions.js';
/* 以比赛项目为中心的工作台：统一上下文、二级导航、概况待办与报名闭环。 */
import { api, captureRequestContext } from '../api.js';
import { localStore } from '../store.js';
import { registerView, state, loadStructure, reloadShell, go, replaceViewParams } from '../main.js';
import { matchingCategory, workspaceLink, workspaceTab, groupWorkspaceLink, workspaceSchoolLink, resolveSchoolContext } from '../workspaceContext.js';
import {
  h, clear, selectInput, statusBadge, emptyState, errorState, loadingState, categoryLabel, toast, fmtDateTime,
} from '../ui.js';

const TAB_LABELS = {
  overview: '概况', registration: '报名', schedule: '赛程',
  matches: '比赛', entry: '成绩录入', results: '成绩',
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
  /* 兼容后端 primary_action 与旧入口：groups/tasks 收敛到赛程/概况，review 回到全局复核。 */
  if (tab === 'review') { go('resultReview', { category: category.id }); return; }
  const normalized = tab === 'groups' ? 'schedule' : tab === 'tasks' ? 'overview' : tab;
  const nextOptions = tab === 'groups' ? { ...options, view: 'groups' } : options;
  const next = allowed.includes(normalized) ? normalized : allowed[0];
  const hash = workspaceLink(category, next, nextOptions);
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
  let remembered = null;
  try { remembered = localStorage.getItem(lastCategoryKey(event.id)); } catch {}
  const canRegister = workspaceTabs(state.user.role, 'team').includes('registration');
  const requestedTab = workspaceTab(params) || (canRegister ? 'overview' : null);
  const registration = requestedTab === 'registration' && canRegister;
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
  if (!resolved.group) {
    el.append(emptyState({ text: '当前赛事还没有组别', hint: '添加组别后即可配置比赛项目与报名。',
      action: state.user.role === 'admin' ? h('a.btn', { href: '#/setup?step=structure' }, '配置组别与项目') : null })); return;
  }
  if (!resolved.category) {
    if (registration) return renderGroupRegistration(el, event, resolved.group, structure.groups, params, context, schoolData);
    el.append(emptyState({ text: '当前组别还没有比赛项目',
      hint: `${resolved.group.name}：${canRegister ? '可先维护学校和人员报名，配置比赛项目后进入计分任务。' : '请由管理员配置比赛项目。'}`,
      action: h('div.row',
        canRegister ? h('a.btn.btn-primary', { href: groupWorkspaceLink({ ...resolved.group, event_id: event.id }, 'registration') }, '维护学校报名') : null,
        state.user.role === 'admin' ? h('a.btn', { href: '#/setup?step=structure' }, '配置比赛项目') : null),
    })); return;
  }
  const category = choices.find(item => item.id === resolved.category.id);
  /* 旧工作台“成绩复核”页签已收敛到侧栏成绩复核；旧链接跳转到全局复核并按项目预选。 */
  if (requestedTab === 'review') {
    go('resultReview', { category: category.id });
    return;
  }
  try { localStorage.setItem(lastCategoryKey(event.id), String(category.id)); } catch {}
  const allowedTabs = workspaceTabs(state.user.role, category.kind);
  const tab = allowedTabs.includes(requestedTab) ? requestedTab : allowedTabs[0];
  const groupView = tab === 'schedule' && (params.tab === 'groups' || params.view === 'groups') ? 'groups' : null;
  replaceViewParams({ event: event.id, group: category.group_id, category: category.id, tab,
    view: groupView, school: tab === 'registration' ? params.school : null });
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
  el.append(h('div.ctx-bar',
    h('div.ctx-path',
      h('nav.ctx-crumbs', { 'aria-label': '当前位置' },
        h('span', event.name),
        h('span.ctx-crumb-sep', { 'aria-hidden': 'true' }, '›'),
        h('span.current', '项目工作台')),
      h('div.ctx-title',
        h('h2', `${category.group_name} · ${categoryLabel(category)}`),
        h('div.ctx-status',
          statusBadge(category.kind === 'team' ? '三人赛' : '个人赛', 'info'),
          (state.user.role === 'viewer' || state.user.role === 'display_operator')
            ? statusBadge('只读', '') : null,
          category.registration_locked_reason
            ? statusBadge('报名与种子已冻结', 'warn') : null))),
    h('div.workspace-switchers', h('label.context-field', h('span', '大组别'), groupSelect), h('span.context-arrow', '›'), h('label.context-field', h('span', '比赛项目'), categorySelect))));
  const tabs = h('nav.ctx-tabs', { 'aria-label': '项目工作台导航', 'data-count': allowedTabs.length }, ...allowedTabs.map(key => h('a', {
    href: workspaceLink(category, key, key === 'registration' && params.school ? { school: params.school } : {}),
    class: key === tab ? 'active' : '', 'aria-current': key === tab ? 'page' : null,
  }, TAB_LABELS[key])));
  el.append(tabs);
  /* 页签多于可视宽度时把当前页签滚到中间，手机与窄窗口下不用先找自己在哪一页。 */
  requestAnimationFrame(() => {
    const active = tabs.querySelector('a.active');
    if (!tabs.isConnected || !active || tabs.scrollWidth <= tabs.clientWidth + 4) return;
    tabs.scrollLeft = Math.max(0, active.offsetLeft - (tabs.clientWidth - active.offsetWidth) / 2);
  });
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
  if (tab === 'schedule') return renderSchedule(el, category, saved, context, params, tab);
  const mapping = { matches: 'scoring', entry: 'individual', results: 'results' };
  const view = state.views[mapping[tab]];
  if (!view) throw new Error('对应业务页面尚未载入');
  return view.render({ el, params: {
    category: category.id, embedded: 'workspace', from: 'workspace',
    ...(params.status ? { status: params.status } : {}),
    ...(params.pool ? { pool: params.pool } : {}),
  }, state, refresh: context.refresh, signal: context.signal,
    requestContext: context.requestContext, isCurrent: context.isCurrent });
}

async function renderSchedule(el, category, saved, context, params, tab) {
  const view = state.views.schedule;
  return view.render({ el, params: {
    category: category.id, embedded: 'workspace', from: 'workspace', draw: params.draw, stage: params.stage,
    view: (params.view === 'groups' || params.tab === 'groups') ? 'groups' : 'fixtures',
    sort: params.sort, venue: params.venue,
    status: params.status ?? saved.status ?? '',
  }, state, refresh: context.refresh, signal: context.signal, requestContext: context.requestContext, isCurrent: context.isCurrent });
}

async function renderTasks(el,category,context={}) {
  let generation=0,snapshot=null,filter='all';
  const notice=h('div',{'aria-live':'polite'}),body=h('div');
  el.append(h('section.panel',h('div.panel-head',h('h2','计分任务'),h('button.btn',{onclick:load},'刷新任务')),
    h('p.small.muted','按当前项目定位记录、独立复核和名次核对。服务器候选与本机草稿分别计数。')),notice,body);
  async function load() {
    const seq=++generation;clear(notice);notice.append(loadingState(snapshot?'更新中，保留上次快照…':'正在读取项目任务…'));
    try {
      const [data,queue,local]=await Promise.all([api.get(`/api/categories/${category.id}/workspace`,{context:context.requestContext,signal:context.signal}),
        api.get(`/api/result-candidates?category_id=${category.id}`,{context:context.requestContext,signal:context.signal}),localStore.all()]);
      if(seq!==generation||context.signal?.aborted||context.isCurrent&&!context.isCurrent()||!el.isConnected)return;
      const identity=context.requestContext?.identity;
      const drafts=local.filter(d=>['match','individual'].includes(d.kind)&&!d.receipt&&!d.terminal&&!d.review_archive
        && d.category_id===category.id&&d.event_identity?.event_uuid===identity?.event_uuid&&d.event_identity?.deployment_id===identity?.deployment_id);
      snapshot={data,queue,drafts,at:new Date().toISOString()};draw();
    }catch(e){if(e.cancelled||seq!==generation||!el.isConnected)return;
      clear(notice);notice.append(errorState(e,load));if(snapshot)notice.append(h('p.small',`保留 ${fmtDateTime(snapshot.at)} 的过期快照。`));}
  }
  function draw() {
    clear(notice);clear(body);const {data,queue,drafts,at}=snapshot,c=data.counts;
    notice.append(h('p.small.muted',`读取于 ${fmtDateTime(at)} · ${category.kind==='team'?'场次为单位':'有效报名人次为单位'}`));
    const enter=category.kind==='team'?'matches':'entry';
    const metric=(n,label,tab)=>h('button.workspace-metric',{onclick:()=>openTab(category,tab)},h('b',String(n)),h('span',label));
    body.append(h('section.panel',h('div.workspace-metrics',metric(category.kind==='team'?c.matches_scoreable:c.individual_results_missing,category.kind==='team'?'可进入记录（场）':'尚无正式结果（人次）',enter),
      metric(c.candidates_pending,'待独立复核（份）','review'),metric(category.kind==='team'?c.matches_finished:c.individual_results_confirmed,'正式结果'+(category.kind==='team'?'（场）':'（人次）'),'results'),
      metric(c.placements_pending,'名次待确认（项）','results'))));
    if(!c.enrolled)body.append(h('section.panel',h('div.warn-box','尚无有效报名，不表示成绩已完成。'),h('button.btn',{onclick:()=>openTab(category,'registration')},'整理报名名单')));
    if(c.disputes_open)body.append(h('section.panel',h('h3','需要先处理'),h('div.warn-box',`${c.disputes_open} 项成绩争议未解决。最后正式结果保留，新推进受保护。`),
      h('button.btn',{onclick:()=>go('admin',{category:category.id})},'核对正式结果与更正')));
    for(const item of data.blockers)body.append(h('section.panel',h('div.warn-box',item.message),h('button.btn',{onclick:()=>openTab(category,item.tab)},'定位处理')));
    const upcoming=data.upcoming_matches||[];
    const matches=upcoming.filter(m=>filter==='all'?true:filter==='unclaimed'?!m.recorder_id:m.recorder_id===state.user.id);
    const counts={all:upcoming.length,unclaimed:upcoming.filter(m=>!m.recorder_id).length,mine:upcoming.filter(m=>m.recorder_id===state.user.id).length};
    body.append(h('section.panel',
      h('div.panel-head',h('h3','记录与复核'),h('div.row',
        h('button.btn.btn-primary',{onclick:()=>openTab(category,enter)},category.kind==='team'?'查找并记录场次':'录入个人赛结果'),
        h('button.btn',{onclick:()=>openTab(category,'review')},`核对候选（${queue.total}份）`))),
      h('div.ctx-filters',{role:'group','aria-label':'按领取状态筛选待记录场次'},
        ...[['all','全部'],['unclaimed','未领取'],['mine','我已领取']].map(([key,text])=>h('button.filter-chip',{
          class:filter===key?'active':'','aria-pressed':filter===key?'true':'false',
          onclick:()=>{filter=key;draw();}},`${text}（${counts[key]}）`))),
      matches.length?h('div.workspace-match-list',...matches.map(m=>h('div.workspace-match',
        h('div.workspace-match-main',
          h('div.small.muted',`${m.stage_name||''} · ${m.round_label} · 第 ${m.seq||m.id} 场`),
          h('div.workspace-match-teams',h('strong',m.home.label),h('span.small.muted','vs'),h('strong',m.away.label)),
          h('div.small.muted',`${m.venue_name||'场地待安排'} · ${m.scheduled_at?fmtDateTime(m.scheduled_at):'时间待安排'} · ${m.recorder_name?`记录员：${m.recorder_name}`:'未领取'}`)),
        h('div.workspace-match-action',
          statusBadge(m.recorder_id?'已领取':'未领取',m.recorder_id?'info':''),
          h('button.btn.btn-primary',{onclick:()=>go('scoring',{match:m.id,category:category.id})},m.recorder_id===state.user.id?'继续记录':m.recorder_id?'查看任务':'进入记录')))))
        :h('div.empty-inline','当前筛选下没有待记录场次；比赛双方确定后会出现在这里。')));
    body.append(h('section.panel',h('h3',`本设备未提交原件（${drafts.length}份）`),h('p.small','仅本账号、本赛事、本设备记录；不与服务器待审份数相加。'),
      h('button.btn',{onclick:()=>go('review')},'待核实提交与导出原件')));
    const exceptions=[...data.tasks,...data.reminders];
    if(exceptions.length)body.append(h('section.panel',h('h3',`其他待办与提醒（${exceptions.length}条）`),...exceptions.map(item=>h('div.workspace-task',
      h('div',h('b',item.message),item.detail?h('p.small.muted',item.detail):null),h('button.btn',{onclick:()=>openTab(category,item.action?.tab||item.tab||'results')},item.action?.label||'查看')))));
  }
  await load();
}

const overviewGenerations=new WeakMap();

async function renderOverview(el, category) {
  const generation=(overviewGenerations.get(el)||0)+1;overviewGenerations.set(el,generation);
  const hadContent=el.hasChildNodes();
  if(!hadContent)el.append(h('div.panel', loadingState('正在计算项目状态…')));
  try {
    const data = await api.get(`/api/categories/${category.id}/workspace`);
    if(overviewGenerations.get(el)!==generation||!el.isConnected)return;
    clear(el);
    el.append(h('p.small.muted',`读取于 ${fmtDateTime(new Date().toISOString())}`));
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
      h('p', !c.enrolled ? '尚无有效报名，不表示成绩已完成。' : c.individual_results_missing ? `还有 ${c.individual_results_missing} 位运动员没有正式确认的成绩。`
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
    if(overviewGenerations.get(el)!==generation||error.cancelled||!el.isConnected)return;
    if(!hadContent)clear(el);
    el.append(h('div.panel',h('p.small',hadContent?'读取失败，保留上次过期快照。':''),errorState(error, () => renderOverview(el, category))));
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
  return schoolView.renderDirectory({ el, groupId, categoryId: category?.id, profile: params.profile, incomplete,
    signal: context.signal, requestContext: context.requestContext, isCurrent: context.isCurrent,
    client: { get: path => api.get(path, { signal: context.signal, context: context.requestContext }) } });
}

async function renderGroupRegistration(el, event, group, groups, params, context, schoolData) {
  replaceViewParams({ event: event.id, group: group.id, category: null, tab: 'registration', school: params.school || null });
  const select = selectInput(groups.map(item => [item.id, item.name]), group.id);
  select.setAttribute('aria-label', '大组别');
  select.onchange = () => { const next = Number(select.value); select.value = String(group.id);
    location.hash = groupWorkspaceLink({ event_id: event.id, id: next }, 'registration'); };
  el.append(h('div.ctx-bar',
    h('div.ctx-path',
      h('nav.ctx-crumbs', { 'aria-label': '当前位置' },
        h('span', event.name), h('span.ctx-crumb-sep', { 'aria-hidden': 'true' }, '›'), h('span.current', '项目工作台')),
      h('div.ctx-title',
        h('h2', `${group.name} · 报名名单`),
        h('div.ctx-status', statusBadge('尚未开设项目', 'warn')))),
    h('div.workspace-switchers', h('label.context-field', h('span', '大组别'), select), h('span.small.muted', '尚未开设项目，可先维护学校与人员'))));
  el.append(h('nav.ctx-tabs', { 'aria-label': '项目工作台导航' }, h('a.active', { href: groupWorkspaceLink({ event_id: event.id, id: group.id }, 'registration'), 'aria-current': 'page' }, '报名名单')));
  const content = h('div.workspace-content'); el.append(content);
  await renderRegistration(content, null, {}, { ...params, event: event.id, group: group.id }, { ...context, schoolData });
}

registerView({ name: 'workspace', label: '项目工作台',
  roles: ['admin', 'organizer', 'recorder', 'viewer'], render });

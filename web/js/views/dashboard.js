/* 赛事首页：赛事级状态、关键指标、组别项目入口、待办聚合与最近确认场次。

   T-03 落地（交付物3 P1、L-01）：
   - 页头统一为“面包屑 + 唯一 H1 + 状态徽标 + 主操作”；
   - 首屏给出赛事级四指标，点击直达对应页面；
   - 待办聚合把待复核、争议、名次待确认、可记录场次集中到右栏；
   - 组别与项目卡保留“按实际数据推荐下一步”，个人赛不出现编排入口。 */
import { api } from '../api.js';
import { registerView, state, go } from '../main.js';
import {
  h, table, statusBadge, clear, emptyState,
  errorState, loadingState, categoryLabel, pageHeader,
} from '../ui.js';

const RESULT_TEXT = {
  normal: '正常完成',
  home_forfeit: '主队弃权',
  away_forfeit: '客队弃权',
  unfinished: '未完成',
  cancelled: '取消',
};

function resultKind(status) {
  if (status === 'normal') return 'ok';
  if (status === 'unfinished') return 'warn';
  return 'danger';
}

const KIND_TEXT = { team: '三人赛', individual: '个人赛' };

async function render({ el, refresh }) {
  if (!state.eventId) {
    el.append(emptyState({ text: '还没有赛事', hint: '请按步骤设置赛事、大组别和比赛项目，确认后统一创建。',
      action: h('button.btn.btn-primary', { onclick: () => go('setup', { action: 'new' }) }, '开始创建赛事') }));
    return;
  }
  const box = h('div');
  el.append(box);
  await load();

  async function load() {
    clear(box);
    box.append(h('div.panel', loadingState('正在加载赛事概览…')));
    try {
      const data = await api.get(`/api/events/${state.eventId}/dashboard`);
      clear(box);
      box.append(...drawDashboard(data));
    } catch (e) {
      clear(box);
      box.append(h('div.panel', errorState(e, load)));
    }
  }
}

/* 把接口返回的项目与场次统计压成赛事级指标。 */
function summarize(data) {
  const categories = data.groups.flatMap((group) => group.categories.map((category) => ({
    ...category, group_id: group.id, group_name: group.name, event_id: data.event.id,
  })));
  const sum = (list, pick) => list.reduce((n, item) => n + (pick(item) || 0), 0);
  const matchesTotal = sum(data.groups, (group) => group.matches_total);
  const matchesFinished = sum(data.groups, (group) => group.matches_finished);
  return {
    categories,
    enrolled: sum(categories, (item) => item.participants),
    matchesTotal,
    matchesFinished,
    candidates: sum(categories, (item) => item.candidates_pending),
    disputes: sum(categories, (item) => item.disputes_open),
    placementsPending: sum(categories, (item) => Math.max(0, (item.placements_required || 0) - (item.placements_confirmed || 0))),
    scoreable: sum(categories, (item) => item.matches_ready),
  };
}

function pickCategory(stats, predicate) {
  return stats.categories.find(predicate) || null;
}

function enterWorkspace(category, tab, options = {}) {
  if (!category) { go('dashboard'); return; }
  go('workspace', { event: category.event_id, group: category.group_id, category: category.id, tab, ...options });
}

function drawDashboard(data) {
  const stats = summarize(data);
  const first = pickCategory(stats, (item) => item.participants) || stats.categories[0] || null;
  const scoreable = pickCategory(stats, (item) => item.matches_ready > 0);
  const dispute = pickCategory(stats, (item) => item.disputes_open > 0);
  const out = [];

  out.push(pageHeader({
    crumbs: [{ label: data.event.name }, { label: '赛事首页' }],
    title: data.event.name,
    badges: [statusBadge(
      data.completed ? '全部确认' : stats.enrolled ? '进行中' : '待报名',
      data.completed ? 'ok' : stats.enrolled ? 'info' : 'warn',
    )],
    meta: [
      h('span', `${data.event.start_date || '日期待定'}${data.event.end_date ? ` ~ ${data.event.end_date}` : ''}`),
      data.event.location ? h('span', data.event.location) : null,
      h('span', `${stats.categories.length} 个项目 · ${stats.enrolled} 个参赛主体`),
    ],
    actions: [
      h('button.btn.btn-primary', {
        disabled: !first,
        onclick: () => enterWorkspace(first, 'overview'),
      }, '进入项目工作台'),
      state.user.role === 'admin'
        ? h('a.btn', { href: '#/setup?step=event' }, '赛事设置')
        : null,
    ],
  }));

  out.push(h('div.dash-metrics', { 'aria-label': '赛事关键指标' },
    metricCard('参赛主体', stats.enrolled, stats.enrolled ? '已报名学校或运动员' : '尚未报名',
      first ? () => enterWorkspace(first, 'registration') : null),
    metricCard('已确认场次', `${stats.matchesFinished}/${stats.matchesTotal}`, stats.matchesTotal ? '正式确认后才计入' : '尚未生成场次',
      first ? () => enterWorkspace(first, 'results') : null),
    metricCard('待独立复核', stats.candidates, stats.candidates ? '候选等待独立复核' : '没有待复核候选',
      stats.candidates ? () => go('resultReview') : null, 'warn'),
    metricCard('可记录场次', stats.scoreable, stats.scoreable ? '双方已确定，可直接记录' : '暂无可记录场次',
      scoreable ? () => enterWorkspace(scoreable, 'matches') : null, 'info')));

  if (!stats.enrolled) {
    out.push(h('div.panel', h('div.info-box',
      '还没有任何报名。请选择下面的项目添加报名名单；名单未齐也可以先报名，开赛前补齐。')));
  }
  if (data.completed) {
    out.push(h('div.panel', h('div.notice',
      h('b', '全部已报名项目的成绩与名次已确认'),
      h('div.small.mt', '学校积分已结算，可导出、打印成绩并保存赛事备份。'),
      h('div.row.mt',
        h('button.btn.btn-primary', { onclick: () => go('school') }, '查看与打印学校总分'),
        h('button.btn', { onclick: () => go('admin') }, '导出成绩与备份')))));
  }

  out.push(h('div.dash-grid',
    h('div.dash-main', ...data.groups.map((group) => groupPanel(group))),
    h('aside.dash-side', todoPanel(data, stats, { dispute, first, scoreable }))));
  out.push(recentPanel(data));

  return out;
}

function metricCard(label, value, hint, action, tone = '') {
  return h(`button.dash-metric${tone ? `.is-${tone}` : ''}`, {
    disabled: !action,
    onclick: action || undefined,
    'aria-label': action ? `${label}：${value}，点击查看` : `${label}：${value}`,
  },
  h('span.dash-metric-label', label),
  h('b.dash-metric-value', String(value)),
  h('span.dash-metric-hint', hint),
  action ? h('span.metric-arrow', { 'aria-hidden': 'true' }, '›') : null);
}

function todoPanel(data, stats, { dispute, first, scoreable }) {
  const items = [];
  if (stats.candidates) {
    items.push(todoItem(stats.candidates, '待独立复核', '候选已提交，需要独立复核确认', () => go('resultReview')));
  }
  if (stats.disputes) {
    items.push(todoItem(stats.disputes, '成绩争议待处理', '最后正式结果保留，新推进受保护',
      dispute ? () => go('admin', { category: dispute.id }) : null, 'danger'));
  }
  if (stats.placementsPending) {
    items.push(todoItem(stats.placementsPending, '名次待确认', '成绩已确认的项目可核对名次',
      first ? () => enterWorkspace(first, 'results') : null, 'warn'));
  }
  if (stats.scoreable) {
    items.push(todoItem(stats.scoreable, '可记录场次', '进入记录台领取并计分',
      scoreable ? () => enterWorkspace(scoreable, 'matches') : null, 'info'));
  }
  const panel = h('section.panel.dash-todo-panel',
    h('div.panel-head',
      h('h2', '待办聚合'),
      statusBadge(items.length ? `${items.length} 类` : '无待办', items.length ? 'warn' : 'ok')));
  if (!items.length) {
    panel.append(h('div.empty-inline', '当前没有待办；比赛提交或成绩更正后会出现在这里。'));
  } else {
    panel.append(...items);
  }
  panel.append(h('p.small.muted.dash-todo-note',
    '待办数字来自服务器当前数据；本机未提交的记录请在对应记录台核实。'));
  return panel;
}

function todoItem(count, label, detail, action, tone = '') {
  return h(`button.dash-todo${tone ? `.is-${tone}` : ''}`, {
    disabled: !action,
    onclick: action || undefined,
  },
  h('span.dash-todo-count', String(count)),
  h('span.dash-todo-text', h('strong', label), h('span.small.muted', detail)),
  action ? h('span.metric-arrow', { 'aria-hidden': 'true' }, '›') : null);
}

function groupPanel(group) {
  const panel = h('section.panel',
    h('div.panel-head',
      h('h2', group.name),
      h('span.badge', `场次 ${group.matches_finished || 0}/${group.matches_total || 0} 已确认`)));
  if (!group.categories.length) {
    panel.append(emptyState({
      text: '该组别还没有项目',
      hint: '请先在“赛事设置”中添加比赛项目。',
      action: h('button.btn', { onclick: () => go('setup', { step: 'structure', group: group.id }) }, '前往赛事设置'),
    }));
  } else {
    panel.append(h('div.category-grid', ...group.categories.map((cat) => categoryCard(cat, group))));
  }
  return panel;
}

function recentPanel(data) {
  const panel = h('section.panel', h('div.panel-head', h('h2', '最近确认的场次')));
  if (!data.recent.length) {
    panel.append(emptyState({
      text: '暂无已确认场次',
      hint: '比赛记录提交并通过独立复核后会显示在这里。',
    }));
  } else {
    panel.append(h('div.table-scroll', table([
      { label: '时间', key: 'updated_at' },
      { label: '大组别', key: 'group_name' },
      { label: '项目', render: (row) => categoryLabel({
        name: row.category_name, gender: row.category_gender, group_name: row.group_name,
      }) },
      { label: '轮次', key: 'round_label' },
      { label: '结果', render: (row) => statusBadge(
        RESULT_TEXT[row.result_status] || row.result_status, resultKind(row.result_status)) },
      {
        label: '操作', render: (row) => h('button.btn.small', {
          onclick: () => go('workspace', {
            event: data.event.id, category: row.category_id, tab: 'results',
          }),
        }, '查看'),
      },
    ], data.recent)));
  }
  return panel;
}

/* 按项目类型与实际数据推荐下一步（§5.3、Q15） */
function categoryCard(cat, group) {
  const isTeam = cat.kind === 'team';
  const enrolled = cat.participants || 0;
  const plan = cat.plan;
  const total = cat.matches_total || 0;
  const finished = cat.matches_finished || 0;
  const ready = cat.matches_ready || 0;
  const processed = finished + (cat.matches_void || 0);
  const label = categoryLabel({ ...cat, group_name: group.name });

  let next;
  if (!enrolled) {
    next = { text: '还没有报名', action: '添加参赛学校', tab: 'registration' };
  } else if (cat.completed) {
    next = { text: '成绩与名次已确认，积分已结算', action: '查看与导出成绩', tab: 'results' };
  } else if (cat.results_complete) {
    next = { text: '成绩已完整，请确认项目名次', action: '核对项目名次', tab: 'results' };
  } else if (!isTeam) {
    next = { text: '个人赛可直接录入成绩，不需要编排方案', action: '录入成绩', tab: 'entry' };
  } else if (!plan && cat.draw_status !== 'confirmed') {
    next = { text: '已有报名，先完成学校抽签与分组', action: '完成学校分组', tab: 'schedule', view: 'groups' };
  } else if (!plan) {
    next = { text: '已有报名，等待录入组委会赛程', action: '录入赛程', tab: 'schedule' };
  } else if (plan.managed_state === 'draft' || (!plan.managed_state && ['draft', 'previewed'].includes(plan.status))) {
    next = { text: '有赛程阶段待核对', action: '核对赛程', tab: 'schedule' };
  } else if (total && processed < total) {
    next = { text: ready ? `${ready} 场待记录` : `${total - finished} 场未确认`, action: '进入待记录场次', tab: 'matches' };
  } else {
    next = { text: '比赛已完成，核对名次', action: '查看成绩与名次', tab: 'results' };
  }

  const enter = (tab, options = {}) => enterWorkspace({ ...cat, group_id: group.id, event_id: group.event_id }, tab, options);
  const planBadge = cat.completed ? statusBadge('已完成', 'ok') : isTeam && plan
    ? statusBadge(planText(plan), planKind(plan.status))
    : isTeam ? statusBadge('赛程未录入', 'warn') : statusBadge(KIND_TEXT[cat.kind] || '个人赛', 'info');

  return h('article.cat-card',
    h('div.cat-card-head', h('h3', label), planBadge),
    h('div.cat-metrics',
      h('div.cat-metric', h('b', String(enrolled)), h('span', isTeam ? '参赛学校' : '参赛人')),
      isTeam ? h('div.cat-metric', h('b', `${finished}/${total}`), h('span', '已确认场次')) : null,
      !isTeam ? h('div.cat-metric', h('b', `${cat.individual_confirmed || 0}/${enrolled}`), h('span', '已确认成绩')) : null,
      h('div.cat-metric', h('b', `${cat.placements_confirmed || 0}/${cat.placements_required ?? enrolled}`), h('span', '已确认名次')),
      isTeam ? h('div.cat-metric', h('b', String(ready)), h('span', '待记录')) : null,
      isTeam ? h('div.cat-metric', h('b', String(cat.matches_pending || 0)), h('span', '待前序结果')) : null),
    cat.candidates_pending || cat.disputes_open ? h('div.cat-flags',
      cat.candidates_pending ? statusBadge(`${cat.candidates_pending} 份待复核`, 'warn') : null,
      cat.disputes_open ? statusBadge(`${cat.disputes_open} 项争议`, 'danger') : null) : null,
    h('div.cat-task',
      h('div.grow', h('div.cat-task-label', '下一步'), h('div.small', next.text)),
      h('button.btn.small.btn-primary', { onclick: () => enter(next.tab, next.view ? { view: next.view } : {}) }, next.action)),
    h('div.cat-card-actions',
      h('button.btn.small', { onclick: () => enter('registration') }, '报名名单'),
      h('button.btn.small', { onclick: () => enter('overview') }, '进入工作台')));
}

function planText(plan) {
  if (plan.managed_state) return plan.managed_state === 'draft' ? '阶段待确认' : '阶段已确认';
  const map = { draft: '待生成预览', previewed: '已预览待锁定', locked: '已锁定', running: '执行中', archived: '已归档' };
  return `${map[plan.status] || plan.status} v${plan.version}`;
}

function planKind(status) {
  return { locked: 'ok', running: 'ok', previewed: 'info', draft: 'warn' }[status] || '';
}

registerView({ name: 'dashboard', label: '赛事首页', render });

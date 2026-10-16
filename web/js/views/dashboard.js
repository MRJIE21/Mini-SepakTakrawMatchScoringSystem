/* 赛事首页：大组别与项目入口、按状态推荐的下一步、最近确认场次。

   改进方案 §3.3、§5.1、§5.3、Q15：
   - 卡片按项目类型给入口，个人赛不再出现“编排 / 场次”；
   - 每个项目按实际数据推荐下一步动作，不用一个“完成度”糊过去；
   - 首次创建后只提示“请选择项目添加报名名单”，不声称已经可以开赛。 */
import { api } from '../api.js';
import { registerView, state, go } from '../main.js';
import {
  h, table, statusBadge, clear, emptyState,
  errorState, loadingState, categoryLabel,
} from '../ui.js';

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

function drawDashboard(data) {
  const out = [];
  const totalParticipants = data.groups.reduce(
    (n, g) => n + g.categories.reduce((m, c) => m + (c.participants || 0), 0), 0);
  out.push(h('div.panel',
    h('div.panel-head',
      h('h2', `${data.event.name}`),
      h('span.muted.small',
        `${data.event.start_date || ''}${data.event.end_date ? ` ~ ${data.event.end_date}` : ''}`
        + `${data.event.location ? ` · ${data.event.location}` : ''}`)),
    h('div.row.small.muted',
      h('span', '赛制口径：三人赛按各项目比赛规则计分；小组排名依次比较积分、C 值、Z 值、抽签')),
    /* 结构刚建好时明确下一步，不声称此时已可开赛（§5.1、Q01） */
    totalParticipants === 0 ? h('div.info-box.mt',
      '还没有任何报名。请选择下面的项目添加报名名单；名单未齐也可以先报名，开赛前补齐。') : null,
    data.completed ? h('div.notice.mt',
      h('b', '全部已报名项目的成绩与名次已确认'),
      h('div.small.mt', '学校积分已结算，可导出、打印成绩并保存赛事备份。'),
      h('div.row.mt', h('button.btn.btn-primary', { onclick: () => go('school') }, '查看与打印学校总分'),
        h('button.btn', { onclick: () => go('admin') }, '导出成绩与备份'))) : null));

  for (const group of data.groups) {
    const panel = h('div.panel',
      h('div.panel-head',
        h('h3', group.name),
        h('span.badge', `场次 ${group.matches_finished}/${group.matches_total} 已确认`)));
    if (!group.categories.length) {
      panel.append(emptyState({
        text: '该组别还没有项目',
        hint: '请先在“赛事设置”中添加比赛项目。',
        action: h('button.btn', { onclick: () => go('setup', { step: 'categories', group: group.id }) },
          '前往赛事设置'),
      }));
    } else {
      panel.append(h('div.category-grid', ...group.categories.map((cat) => categoryCard(cat, group))));
    }
    out.push(panel);
  }

  const recent = h('div.panel', h('h3', '最近确认的场次'));
  if (!data.recent.length) {
    recent.append(emptyState({
      text: '暂无已确认场次',
      hint: '比赛记录提交并确认后会显示在这里。',
    }));
  } else {
    recent.append(h('div.table-scroll', table([
      { label: '时间', key: 'updated_at' },
      { label: '大组别', key: 'group_name' },
      { label: '项目', render: (r) => categoryLabel(r) },
      { label: '轮次', key: 'round_label' },
      { label: '结果', render: (r) => (r.result_status === 'normal' ? '正常完成' : r.result_status) },
      {
        label: '', render: (r) => h('button.btn.small', {
          onclick: () => go('workspace', { event: data.event.id, category: r.category_id, tab: 'results' }),
        }, '查看'),
      },
    ], data.recent)));
  }
  out.push(recent);
  return out;
}

/* 按项目类型与实际数据推荐下一步（§5.3、Q15） */
function categoryCard(cat, group) {
  const short = group.name.split('：')[0];
  const isTeam = cat.kind === 'team';
  const enrolled = cat.participants || 0;
  const plan = cat.plan;
  const total = cat.matches_total || 0;
  const finished = cat.matches_finished || 0;
  const ready = cat.matches_ready || 0;
  const processed = finished + (cat.matches_void || 0);

  let next;
  if (!enrolled) {
    next = { text: '还没有报名', action: '添加参赛学校', view: 'catalog', params: { group: group.id } };
  } else if (cat.completed) {
    next = { text: '成绩与名次已确认，积分已结算', action: '查看与导出成绩', view: 'results', params: { category: cat.id } };
  } else if (cat.results_complete) {
    next = { text: '成绩已完整，请确认项目名次', action: '核对项目名次', view: isTeam ? 'results' : 'individual', params: { category: cat.id } };
  } else if (!isTeam) {
    next = { text: '个人赛可直接录入成绩，不需要编排方案', action: '录入成绩', view: 'individual', params: { category: cat.id } };
  } else if (!plan && cat.draw_status !== 'confirmed') {
    next = { text: '已有报名，先完成学校抽签与分组', action: '完成学校分组', view: 'groups', params: { category: cat.id } };
  } else if (!plan) {
    next = { text: '已有报名，等待录入组委会赛程', action: '录入赛程', view: 'scheduling', params: { category: cat.id } };
  } else if (plan.managed_state === 'draft' || !plan.managed_state && ['draft', 'previewed'].includes(plan.status)) {
    next = { text: '有赛程阶段待核对', action: '核对赛程', view: 'scheduling', params: { category: cat.id } };
  } else if (total && processed < total) {
    next = { text: ready ? `${ready} 场待记录` : `${total - finished} 场未确认`, action: '进入待记录场次', view: 'matches', params: { category: cat.id } };
  } else {
    next = { text: '比赛已完成，核对名次', action: '查看成绩与名次', view: 'results', params: { category: cat.id } };
  }

  const tabByView = { catalog: 'registration', groups: 'groups', scheduling: 'schedule', matches: 'matches',
    individual: 'entry', results: 'results' };
  const enter = (tab) => go('workspace', {
    event: state.eventId, group: group.id, category: cat.id, tab,
  });
  const planBadge = cat.completed ? statusBadge('已完成', 'ok') : isTeam && plan
    ? statusBadge(planText(plan), planKind(plan.status))
    : isTeam ? statusBadge('赛程未录入', 'warn') : statusBadge('个人赛', 'info');

  return h('div.cat-card',
    h('div.cat-card-head', h('h4', categoryLabel(cat)), planBadge),
    h('div.cat-metrics',
      h('div.cat-metric', h('b', String(enrolled)), h('span', isTeam ? '参赛学校' : '参赛人')),
      isTeam ? h('div.cat-metric', h('b', `${finished}/${total}`), h('span', '已确认场次')) : null,
      !isTeam ? h('div.cat-metric', h('b', `${cat.individual_confirmed || 0}/${enrolled}`), h('span', '已确认成绩')) : null,
      h('div.cat-metric', h('b', `${cat.placements_confirmed || 0}/${cat.placements_required ?? enrolled}`), h('span', '已确认名次')),
      isTeam ? h('div.cat-metric', h('b', String(ready)), h('span', '待记录')) : null,
      isTeam ? h('div.cat-metric', h('b', String(cat.matches_pending || 0)), h('span', '待前序结果')) : null),
    h('div.cat-task',
      h('div.grow', h('div.cat-task-label', '下一步'), h('div.small', next.text)),
      h('button.btn.small.btn-primary', { onclick: () => enter(tabByView[next.view] || 'overview') }, next.action)),
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

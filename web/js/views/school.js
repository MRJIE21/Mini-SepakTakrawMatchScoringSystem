/* 学校总分页：本大组别总分榜与分项目积分明细（设计大纲 7.2、8）。 */
import { api, download, openPrint } from '../api.js';
import { registerView, state, loadStructure } from '../main.js';
import {
  h, table, toast, modal, formDialog, clear, task, loadingState, errorState, emptyState,
  categoryLabel, exportOrderControl,
} from '../ui.js';

const canWrite = () => ['admin', 'organizer'].includes(state.user.role);

function registrationLink(groupId) {
  const params = new URLSearchParams({ event: String(state.eventId), group: String(groupId),
    tab: 'registration' });
  return `#/workspace?${params.toString()}`;
}

async function render({ el, params }) {
  if (!state.eventId) throw new Error('请先在“赛事首页”中创建赛事');
  const structure = state.structure || await loadStructure();
  if (!structure.groups.length) {
    /* REQ-017：空赛事不显示 NaN 组别与只有表头的表格，给出下一步入口。 */
    el.append(h('div.panel',
      h('div.panel-head', h('h2', '学校团体总分')),
      emptyState({
        text: '暂无组别/学校',
        hint: '还没有建立大组别或学校。请先在“赛事设置”中建立组别并完成学校报名。',
        action: h('a.btn.btn-primary', { href: '#/setup?step=structure' }, '去赛事设置'),
      })));
    return;
  }
  const groupId = Number(params.group || structure.groups[0]?.id);
  const group = structure.groups.find((g) => g.id === groupId) || structure.groups[0];
  let exportOrder = 'asc';

  el.append(h('div.panel',
    h('div.panel-head',
      h('h2', '学校团体总分'),
      h('div.row.tight',
        ...structure.groups.map((g) => h('button.btn', {
          class: g.id === group.id ? 'btn-primary' : '',
          onclick: () => { location.hash = `#/school?group=${g.id}`; },
        }, g.name.split('：')[0])),
        /* 导出范围写在按钮旁，避免“写着当前组别却导出整届”（§13.4） */
        canWrite() ? exportOrderControl((value) => { exportOrder = value; }) : null,
        canWrite() ? h('button.btn', {
          title: `只导出 ${group.name} 的学校总分`,
          onclick: task(() => download('/api/exports/school-totals.csv', {
            group_id: group.id, order: exportOrder })),
        }, `导出 ${group.name.split('：')[0]} CSV`) : null,
        canWrite() ? h('button.btn', {
          title: `只导出 ${group.name} 的学校总分（Excel）`,
          onclick: task(() => download('/api/exports/school-totals.xlsx', {
            group_id: group.id, order: exportOrder })),
        }, `导出 ${group.name.split('：')[0]} XLSX`) : null,
        canWrite() ? h('button.btn', {
          onclick: task(() => openPrint('school-notice', {
            group_id: group.id, order: exportOrder, event: state.eventId })),
        }, '打印本组学校总分表') : null,
      )),
    h('div.small.muted', `${group.name} · 单项前八名积分 9、7、6、5、4、3、2、1，集体项目（三人赛）双倍计入；`
      + '总分相同依次比较第一名数量、第二名数量……仍相同则录入现场确认结果。未确认名次不计入正式积分。'),
  ));

  const panelBody = h('div');
  const totalsTitle = h('h3', `${group.name} 总分榜`);
  el.append(h('div.panel', totalsTitle, panelBody));
  const overviewPanel = h('div.panel', h('h3', '各组别独立汇总'));
  el.append(overviewPanel);

  async function load() {
    clear(panelBody);
    panelBody.append(loadingState('正在计算总分…'));
    clear(overviewPanel);
    overviewPanel.append(h('h3', '各组别独立汇总'), loadingState());
    try {
      const data = await api.get(`/api/groups/${group.id}/school-totals`);
      clear(panelBody);
      totalsTitle.textContent = `${group.name} 总分榜（${data.rows.length} 所学校）`;
      panelBody.append(drawTotals(data, group, load));
      const all = await api.get(`/api/events/${state.eventId}/school-totals`);
      clear(overviewPanel);
      overviewPanel.append(h('h3', '各组别独立汇总'));
      for (const item of all.groups) {
        overviewPanel.append(h('div.stage-block',
          h('h4', item.group.name),
          !item.rows.length
            ? h('div.small.muted', '暂无学校/暂无成绩')
            : item.started === false
              ? h('div.small.muted', '未开赛/无成绩')
              : h('div.small', item.rows.slice(0, 8)
                .map((r) => `${r.rank ?? '待确认'}. ${r.name}（${r.total}）`).join('　'))));
      }
    } catch (e) {
      clear(panelBody);
      panelBody.append(errorState(e, load));
    }
  }
  await load();
}

function drawTotals(data, group, reload) {
  const body = h('div');
  if (!data.rows.length) {
    /* REQ-017：有组别但没有学校/成绩时给明确的空态行与去报名入口，保留顶部导出按钮。 */
    body.append(emptyState({
      text: '暂无学校/暂无成绩',
      hint: '本组别还没有学校报名或成绩。先在学校报名中添加学校并完成报名，再回到本页查看总分。',
      action: h('a.btn.btn-primary', {
        href: registrationLink(group.id),
      }, '去学校报名'),
    }));
    return body;
  }
  const started = data.started !== false;
  if (!started) {
    /* REQ-008：完全未开赛的组别不产生伪名次；页面与导出/公告使用同一 started 口径。 */
    body.append(h('div.info-box.mb', '本组别尚未开赛/无成绩，名次不计入。'));
  }
  body.append(h('div.table-scroll', table([
    {
      label: '名次',
      render: (r) => {
        if (!started) return h('span.badge.badge-info', '未开赛/无成绩');
        return r.status === 'tie_pending'
          ? h('span.badge.badge-warn', '待确认')
          : h('b', { class: r.rank === 1 ? 'rank-1' : '' }, r.rank);
      },
    },
    { label: '学校', key: 'name' },
    { label: '团体总分', key: 'total', align: 'right' },
    { label: '第一名', render: (r) => r.rank_counts['1'] || 0, align: 'center' },
    { label: '第二名', render: (r) => r.rank_counts['2'] || 0, align: 'center' },
    { label: '第三名', render: (r) => r.rank_counts['3'] || 0, align: 'center' },
    {
      label: '待确认',
      render: (r) => (!started
        ? h('span.muted', '—')
        : (r.pending.length
          ? h('span.badge.badge-warn', `${r.pending.length} 项`) : h('span.muted', '—'))),
    },
    {
      label: '明细',
      render: (r) => h('button.btn.small', { onclick: () => showDetail(r) },
        `分项目明细（${r.details.length}）`),
    },
  ], data.rows)));
  /* 未确认名次不加入正式总分：说明缺项，不伪装为统计完成（§13.3）；未开赛组不显示该警告。 */
  const pendingCount = data.rows.reduce((n, r) => n + (r.pending ? r.pending.length : 0), 0);
  if (started && pendingCount) {
    body.append(h('div.warn-box.mt',
      `还有 ${pendingCount} 项名次未确认，未计入上面的正式总分。`));
  }
  for (const item of data.unresolved) {
    body.append(h('div.row.mt',
      h('div.warn-box', { style: 'flex:1' },
        `总分与名次数量相同：${item.schools.map((s) => s.name).join('、')}，需录入现场确认结果`),
      canWrite() ? h('button.btn.btn-primary', {
        onclick: () => openTiebreak(group, item, reload),
      }, '录入现场结果') : null));
  }
  return body;
}

function showDetail(school) {
  modal({
    title: `${school.name} · 分项目积分明细`,
    body: h('div',
      h('div.table-scroll', table([
        { label: '项目', render: (r) => categoryLabel(r) },
        { label: '参赛主体', key: 'participation_label' },
        { label: '名次', key: 'rank_no', align: 'center' },
        { label: '基础分', key: 'base_points', align: 'center' },
        { label: '倍数', key: 'multiplier', align: 'center' },
        { label: '积分', key: 'points', align: 'center' },
      ], school.details)),
      h('div.small.muted.mt',
        `合计 ${school.total} 分。集体项目按学校在该项目的成绩计一次，不按队员人数重复累计。`)),
  });
}

function openTiebreak(group, item, reload) {
  const inputs = new Map();
  const body = h('div', h('div.info-box', '按现场确认结果填写顺序（1 为在前）。'),
    ...item.schools.map((school) => {
      const input = h('input', {
        type: 'number', min: 1, value: 1, 'aria-label': `${school.name} 现场排序`,
        dataset: { field: `order_${school.school_id}` },
      });
      inputs.set(school.school_id, input);
      return h('div.row.tight.mt', h('span', { style: 'min-width:200px' }, school.name), input);
    }));
  formDialog({
    title: '录入现场确认结果',
    subtitle: group.name,
    width: 'min(520px, 94vw)',
    sections: [{ body }],
    actions: [{
      label: '保存', primary: true, busyLabel: '保存中…',
      run: async ({ close }) => {
        const pairs = [...inputs.entries()].map(([sid, input]) => [sid, Number(input.value)]);
        pairs.sort((a, b) => a[1] - b[1]);
        await api.post(`/api/groups/${group.id}/school-tiebreak`, {
          school_ids: pairs.map((p) => p[0]), note: '现场确认结果',
        });
        toast('已录入并重算名次', 'ok');
        close();
        reload();               // 局部重算，不整页刷新（Q08）
      },
    }],
  });
}

registerView({ name: 'school', label: '学校总分', roles: ['admin', 'organizer', 'recorder', 'viewer'], render });

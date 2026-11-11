import { api } from '../api.js';
import { registerView } from '../main.js';
import { h, table, textInput, selectInput, emptyState, errorState, clear, modal } from '../ui.js';

async function render({ el }) {
  let offset = 0;
  const query = textInput('', { placeholder: '赛事、学校或参赛者', 'aria-label': '搜索历史报名' });
  const scope = selectInput([['all', '全部报名'], ['live', '现有赛事'], ['deleted', '赛事已删除']], 'all');
  const results = h('div');
  el.append(h('section.panel', h('h2', '报名历史'),
    h('div.row', query, scope, h('button.btn', { onclick: () => { offset = 0; load(); } }, '查询'))), results);
  scope.addEventListener('change', () => { offset = 0; load(); });
  async function load() {
    clear(results);
    try {
      const data = await api.get(`/api/registration-history?scope=${scope.value}&q=${encodeURIComponent(query.value)}&offset=${offset}&limit=20`);
      const stats = data.statistics;
      results.append(h('section.panel', h('h3', `共 ${data.total} 条报名`),
        h('div.row', `现有赛事 ${stats.live}`, `赛事已删除 ${stats.archived}`, `退赛 ${stats.withdrawn}`),
        data.rows.length ? h('div.table-scroll', table([
          { label: '赛事', render: r => `${r.event_name}${r.event_deleted ? '（赛事已删除）' : ''}` },
          { label: '组别 / 项目', render: r => `${r.group_name} / ${r.category_name}` },
          { label: '学校', key: 'school_name' }, { label: '参赛者 / 队伍', key: 'subject_name' },
          { label: '报名状态', render: r => r.deleted_at ? '报名已删除' : r.status === 'withdrawn' ? '已退赛' : r.event_deleted ? '删除前有效' : '有效报名' },
          { label: '详情', render: r => h('button.btn.small', { onclick: async () => {
            try {
              const detail = await api.get(`/api/registration-history/${r.original_event_id}/${r.id}`);
              const item = detail.registration;
              modal({ title: item.subject_name, body: h('div.form-body',
                h('div', `${item.event_name}${item.event_deleted ? '（赛事已删除）' : ''}`),
                h('div', `${item.school_name} · ${item.group_name} · ${item.category_name}`),
                h('div', `原赛事编号 ${item.original_event_id} · 原报名编号 ${item.id}`),
                item.members?.length ? h('section', h('h4', '队员名单'), h('div.table-scroll', table([
                  { label: '姓名', key: 'name' }, { label: '号码', key: 'jersey_no' },
                  { label: '队长', render: member => member.is_captain ? '是' : '—' },
                ], item.members))) : null,
                item.results.length ? h('section', h('h4', '成绩'), h('div.table-scroll', table([
                  { label: '结果', render: result => ({ normal: '正常完成', dns: '未参加', dnf: '未完成', dsq: '取消成绩', pending: '待确认' }[result.result_status] || result.result_status) },
                  { label: '有效次数', key: 'result_value' },
                  { label: '失误次数', key: 'error_count' },
                  { label: '犯规次数', key: 'violation_count' },
                ], item.results))) : null,
                item.placements.length ? h('section', h('h4', '名次与积分'), h('div.table-scroll', table([
                  { label: '名次', key: 'rank_no' },
                  { label: '状态', render: placement => placement.status === 'confirmed' ? '已确认' : '待确认' },
                  { label: '积分', render: placement => item.points.find(point => point.participation_id === placement.participation_id)?.points ?? '—' },
                ], item.placements))) : h('div', item.event_deleted ? '删除前尚无已确认名次' : '尚无已确认名次')) });
            } catch (error) { results.append(errorState(error, load)); }
          } }, '查看') },
        ], data.rows)) : emptyState({ text: '暂无报名记录' }),
        h('div.row.mt', h('button.btn', { disabled: offset === 0, onclick: () => { offset -= 20; load(); } }, '上一页'),
          h('button.btn', { disabled: offset + 20 >= data.total, onclick: () => { offset += 20; load(); } }, '下一页'))));
    } catch (error) { results.append(errorState(error, load)); }
  }
  await load();
}
registerView({ name: 'registrationHistory', label: '报名历史', roles: ['admin'], render });

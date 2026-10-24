/* 成绩更正与导出、账号管理（设计大纲 3、8、12.3；改进方案 §13.2、§13.4）。 */
import { api, download, openHtml, newUid, captureRequestContext, recordRequestContext, validateReceipt, getToken } from '../api.js';
import { localStore } from '../store.js';
import { DEFAULT_RULES, normalizeRules, ruleForSet, rulesSummary, winner } from '../teamRules.js';
import { registerView, state, loadStructure, logoutEverywhere, SHELL_VERSION } from '../main.js';
import { openEditor as openIndividualCorrection } from './individual.js';
import {
  h, field, selectInput, numberInput, textInput, textarea, table, toast, modal, statusBadge,
  task, formDialog, promptDialog, confirmAsync, clear, loadingState, errorState, emptyState, categoryLabel,
  exportOrderControl, pageHeader, scrollableTable, clearUnintendedAutofill, bindFilterInput,
} from '../ui.js';

const canOrg = () => ['admin', 'organizer'].includes(state.user.role);
const isAdmin = () => state.user.role === 'admin';

const RESULT_STATUS = [
  ['normal', '正常完成'], ['home_forfeit', '主队弃权'], ['away_forfeit', '客队弃权'],
  ['unfinished', '未完成'], ['cancelled', '已取消'],
];

const AUDIT_LABELS = {
  backup: '下载数据库备份', configure_plan: '配置编排方案', generate_plan: '生成编排预览',
  lock_plan: '锁定方案', unlock_plan: '解锁方案', rename_pool: '修改小组名称', swiss_next_round: '生成瑞士制下一轮',
  claim_recording: '领取记录任务', transfer_recording: '转交记录任务', submit_match: '提交三人赛成绩',
  receive_candidate: '接收待复核候选', review_approve: '独立确认正式结果', review_return: '退回候选', review_withdraw: '撤回候选', review_grant: '配置复核授权', review_recuse: '声明回避', review_impact_action: '核对下游处置', correct_match: '正式更正三人赛成绩', cancel_match: '标记取消或未完成', create_reset_match: '生成决赛重赛',
  submit_individual: '提交个人赛成绩', correct_individual: '正式更正个人赛成绩',
  confirm_individual_rankings: '确认个人赛名次', confirm_pool: '确认小组名次', record_lots: '录入抽签结果',
  auto_placements: '推导项目名次', set_placement: '确认项目名次', school_tiebreak: '确认学校同分顺序',
  schedule_match: '安排场地与时间', create_match: '添加比赛', delete_match: '删除比赛', clear_stage: '清理阶段场次',
  create_manual_plan: '建立手工赛程', create_school: '新增学校', delete_school: '删除学校',
  school_registration_commit: '整批保存学校报名', save_school_draft: '保存共享报名草稿', clear_school_draft: '清除共享报名草稿',
  create_event: '新建赛事', update_event: '修改赛事信息', bootstrap_event: '建立默认赛事结构',
  enroll_team: '报名三人赛', enroll_individual: '报名个人赛', batch_enroll: '批量报名', import_enrollments: '导入报名',
  create_team: '建立代表队', delete_participation: '删除报名', create_user: '新增账号', update_user: '修改账号',
  reset_password: '重置账号密码', set_event_access: '分配账号赛事', login: '登录', change_password: '修改密码',
  logout: '退出登录', logout_all: '退出所有设备', delete_athlete: '删除运动员',
  delete_team: '删除项目名单', delete_venue: '删除比赛场地', delete_placement: '删除名次',
  clear_school_tiebreak: '清除学校同分结果', bulk_schedule: '批量安排场地',
  maintenance_cleanup: '数据保留清理', restore: '恢复数据库备份',
};
const AUDIT_OBJECTS = { match: '场次', individual: '个人赛报名', individual_result: '个人赛成绩',
  pool: '小组', plan: '方案', category: '项目', school: '学校', event: '赛事', placement: '名次',
  group: '组别', database: '赛事数据库', user: '账号', participation: '报名', team: '代表队', stage: '阶段',
  athlete: '运动员', venue: '比赛场地', school_tiebreak: '学校同分结果' };

function auditContent(row) {
  let detail = {};
  try { detail = JSON.parse(row.detail_json || '{}'); } catch { /* 完整原记录仍可展开查看。 */ }
  const summary = [];
  if (detail.reason) summary.push(`原因：${detail.reason}`);
  if (detail.before && detail.after) {
    for (const [key, label] of [['result_value', '有效次数'], ['error_count', '失误次数'], ['violation_count', '违规次数']]) {
      if (detail.before[key] !== detail.after[key]) summary.push(`${label}：${detail.before[key] ?? '—'} → ${detail.after[key] ?? '—'}`);
    }
  }
  if (detail.changes?.length) summary.push(detail.changes.join('；'));
  if (detail.scheduled_at !== undefined) summary.push(`计划时间：${detail.scheduled_at || '未安排'}`);
  if (detail.count !== undefined) summary.push(`处理 ${detail.count} 条`);
  return h('div', summary.length ? h('div.small', summary.join('；')) : null,
    h('details.small', h('summary', '查看完整记录'), h('pre', `${row.action}\n${row.detail_json}`)));
}

/* ------------------------------------------------------------------ 更正与导出 */
async function render({ el, params, signal, requestContext = captureRequestContext(), isCurrent = () => true }) {
  if (!state.eventId) throw new Error('请先在“赛事首页”中创建赛事');
  const structure = state.structure || await loadStructure();
  const cats = [];
  for (const g of structure.groups) {
    for (const c of g.categories) cats.push({ ...c, group_name: g.name });
  }
  if (!cats.length) {
    el.append(emptyState({ text: '当前赛事还没有项目', hint: '请先在“赛事设置”中添加比赛项目。' }));
    return;
  }
  const catId = Number(params.category || cats[0].id);
  const cat = cats.find((c) => c.id === catId);
  if (!cat) {
    el.append(errorState(new Error(`项目不存在或不属于本赛事（id=${catId}）`),
      () => { location.hash = '#/admin'; }));
    return;
  }

  const isIndividual = cat.kind === 'individual';
  const tabs = isAdmin()
    ? [['corrections', '成绩更正'], ['exports', '导出与打印'], ['audit', '审计日志'], ['backup', '备份与维护']]
    : [['corrections', '成绩更正'], ['exports', '导出与打印']];
  const activeTab = tabs.some(([key]) => key === params.tab) ? params.tab : 'corrections';
  const tabLink = (key) => `#/admin?tab=${key}&category=${cat.id}${params.sheet ? `&sheet=${params.sheet}` : ''}`;
  const projectSelect = selectInput(cats.map((c) => [c.id, categoryLabel(c, { withGroup: true })]), cat.id,
    { 'aria-label': '比赛项目', onchange: (e) => { location.hash = `#/admin?tab=${activeTab}&category=${e.target.value}`; } });
  el.append(pageHeader({
    crumbs: [{ label: '更正与导出' }],
    title: '更正与导出',
    badges: [statusBadge(isIndividual ? '个人赛' : '三人赛', 'info')],
    meta: [h('span', '正式更正会生成待独立复核的候选，不直接改写正式成绩；涉及已领取或已有历史的后续场次必须逐项确认处置。')],
    actions: [h('label.context-field.page-project', h('span', '比赛项目'), projectSelect)],
  }));
  el.append(h('nav.ctx-tabs', { 'aria-label': '更正与导出导航' },
    ...tabs.map(([key, label]) => h('a', {
      href: tabLink(key), class: key === activeTab ? 'active' : '', 'aria-current': key === activeTab ? 'page' : null,
    }, label))));

  const listBox = h('div');
  const exportBox = h('div');
  let exportOrder = 'asc';
  const logBox = h('div');
  const backupBox = h('div');
  const pager = h('div.row.tight.mt');
  let pageOffset = 0, pageRevision, auditScope = 'event';
  el.append(listBox, pager, exportBox, logBox, backupBox);
  await load();

  async function load() {
    clear(listBox); clear(exportBox); clear(logBox); clear(backupBox); clear(pager);
    if (activeTab === 'audit') return renderAudit();
    if (activeTab === 'backup') return renderBackup();
    listBox.append(h('div.panel', loadingState('正在加载已确认场次…')));
    try {
      const isIndividual = cat.kind === 'individual';
      const query = new URLSearchParams({ category_id: cat.id, status: 'finished', with_sets: 1, offset: pageOffset, limit: 100 });
      if (pageOffset && pageRevision != null) query.set('list_revision', pageRevision);
      const page = isIndividual ? { matches: [] } : await api.get(`/api/matches?${query}`, { signal, context: requestContext });
      if (!isCurrent()) return;
      pageRevision = page.list_revision;
      const matches = page.matches;
      clear(pager);
      if (!isIndividual) pager.append(h('span.small.muted', `共 ${page.total} 场，本页 ${matches.length} 场`),
        h('button.btn', { disabled: !pageOffset, onclick: () => { pageOffset = Math.max(0, pageOffset - 100); load(); } }, '上一页'),
        h('button.btn', { disabled: !page.has_more, onclick: () => { pageOffset += 100; load(); } }, '下一页'));
      const finished = matches.filter((m) => m.status === 'finished');
      clear(listBox);
      let individualRows = [];
      if (isIndividual) {
        const results = (await api.get(`/api/categories/${cat.id}/individual-results`)).results;
        individualRows = results.filter((r) => r.confirmed && r.result_status !== 'pending').map((r) => ({
          id: r.participation_id, subject: r.subject, display: `${r.school_short || r.school_name}·${r.subject}`, result: r,
        }));
        listBox.append(h('div.panel', h('h3', `已确认成绩（${individualRows.length}）`),
          individualRows.length ? h('div.table-scroll', table([
            { label: '学校', render: (r) => r.result.school_name },
            { label: '运动员', key: 'subject' },
            { label: '有效次数', render: (r) => r.result.result_value ?? '—' },
            { label: '结果状态', render: (r) => ({ normal: '正常完成', dns: '未参加', dnf: '未完成', dsq: '取消成绩' })[r.result.result_status] || '待确认' },
            { label: '失误 / 违规', render: (r) => `${r.result.error_count ?? '—'} / ${r.result.violation_count ?? '—'}` },
            { label: '名次', render: (r) => r.result.rank_no ? `第 ${r.result.rank_no} 名` : '待确认' },
            { label: '版本', render: (r) => r.result.version },
            { label: '更新于', render: (r) => r.result.updated_at },
            { label: '操作', render: (r) => canOrg() ? h('button.btn.small', {
              onclick: task(() => openIndividualCorrection(r, cat, load, individualRows)),
            }, '正式更正') : null },
          ], individualRows)) : emptyState({ text: '该项目暂无已确认成绩', hint: '个人赛成绩提交并确认后会显示在这里。' })));
      } else listBox.append(h('div.panel',
        h('h3', `已确认场次（${finished.length}）`),
        finished.length ? h('div.table-scroll', table([
          { label: '轮次', key: 'round_label' },
          { label: '对阵', render: (m) => `${m.home.label} vs ${m.away.label}` },
          { label: '比分', render: (m) => m.sets.map((s) => `${s.home_points}:${s.away_points}`).join(' ') },
          { label: '结果', render: (m) => m.result_status_name || m.result_status },
          { label: '版本', key: 'result_version', align: 'center' },
          { label: '更新于', key: 'updated_at' },
          {
            label: '操作',
            render: (m) => (canOrg() ? h('div.row.tight',
              h('button.btn.small', { onclick: () => openCorrection(m, load) }, '正式更正'),
              h('button.btn.small', { onclick: () => openCancel(m, load) }, '标记取消/未完成'),
              m.reset_state && m.reset_state!=='none' ? h('button.btn.small',{onclick:async()=>{
                const {openCandidateEditor}=await import('../resultCandidateEditor.js');return openCandidateEditor(m,'reset_review',load);}},'核对重置赛') : null,
              m.result_disputed ? h('button.btn.small',{onclick:async()=>{
                const {openCandidateEditor}=await import('../resultCandidateEditor.js');return openCandidateEditor(m,'resolve_dispute',load);}},'核对争议处理') : null) : null),
          },
        ], finished)) : emptyState({
          text: '该项目暂无已确认场次',
          hint: '比赛记录提交并确认后会出现在这里，可从结果详情发起正式更正。',
        })));

      if (activeTab === 'exports') renderExports(finished);
      listBox.classList.toggle('hidden', activeTab !== 'corrections');
      pager.classList.toggle('hidden', activeTab !== 'corrections');
      return individualRows;
    } catch (e) {
      if (e.cancelled || !isCurrent() || !getToken()) return;
      if (e.code === 'list_changed') { pageOffset = 0; pageRevision = null; return load(); }
      clear(listBox);
      listBox.append(h('div.panel', errorState(e, load)));
    }
  }

  /* 审计范围：赛事库（现场操作）与账号库（登录/账号/重置密码等）。 */
  async function renderAudit() {
    clear(logBox);
    logBox.append(h('div.panel', loadingState('正在加载关键操作记录…')));
    try {
      const logs = (await api.get(`/api/audit-logs?limit=60&scope=${auditScope}`)).logs;
      if (!isCurrent()) return;
      const scopeButton = (value, label) => h('button.btn.small', {
        class: auditScope === value ? 'btn-primary' : '',
        onclick: () => { if (auditScope === value) return; auditScope = value; renderAudit(); },
      }, label);
      clear(logBox);
      logBox.append(h('div.panel',
        h('div.panel-head', h('h3', '维护 · 关键操作记录（最近 60 条）'),
          h('div.row.tight', h('span.small.muted', '范围：'), scopeButton('event', '赛事'), scopeButton('registry', '账号'))),
        h('div.row.mb', h('button.btn', {
          onclick: task(() => download('/api/admin/backup')),
        }, '下载数据库备份')),
        h('div.table-scroll', table([
          { label: '时间', key: 'created_at' },
          { label: '操作人', key: 'user_name' },
          { label: '操作', render: (r) => AUDIT_LABELS[r.action] || '其他操作' },
          { label: '对象', render: (r) => `${AUDIT_OBJECTS[r.entity_type] || '对象'} ${r.entity_id ?? ''}` },
          { label: '内容', render: auditContent },
        ], logs))));
    } catch (e) {
      if (e.cancelled || !isCurrent() || !getToken()) return;
      clear(logBox);
      logBox.append(h('div.panel', errorState(e, renderAudit)));
    }
  }

  /* 导出与打印：报表 × 格式 × 排序集中在一张表里；范围写清楚，避免“当前项目却导出整届”。 */
  function renderExports(finished) {
    clear(exportBox);
    const sheetId = Number(params.sheet || (finished[0]?.id ?? 0));
    const exportStandings = (format) => task(async () => {
      const data = await api.get(`/api/categories/${cat.id}/schedule`);
      const poolIds = (data.plan?.stages || []).flatMap((stage) => stage.pools || []).map((pool) => pool.id);
      if (!poolIds.length) { toast('本项目还没有小组，无法导出小组排名', 'error'); return; }
      await download(`/api/exports/standings.${format}`, { pool_ids: poolIds.join(','), order: exportOrder });
    });
    const rows = [];
    rows.push({
      report: '项目成绩', scope: categoryLabel(cat, { withGroup: true }),
      export: [
        h('button.btn.small', { onclick: task(() => download('/api/exports/results.csv', { category_id: cat.id, order: exportOrder })) }, 'CSV'),
        h('button.btn.small', { onclick: task(() => download('/api/exports/results.xlsx', { category_id: cat.id, order: exportOrder })) }, 'XLSX'),
      ],
      print: [h('button.btn.small', {
        onclick: task(() => openHtml('/api/exports/category-notice.html', { category_id: cat.id, order: exportOrder }, '项目成绩单')),
      }, isIndividual ? '成绩单' : '名次表')],
    });
    if (!isIndividual) rows.push({
      report: '小组排名', scope: '本项目各小组',
      export: [
        h('button.btn.small', { onclick: exportStandings('csv') }, 'CSV'),
        h('button.btn.small', { onclick: exportStandings('xlsx') }, 'XLSX'),
      ],
      print: [h('button.btn.small', {
        onclick: task(() => openHtml(`/api/categories/${cat.id}/group-draw/notice.html`, {}, '小组分组表')),
      }, '分组表')],
    });
    rows.push({
      report: '学校总分', scope: cat.group_name.split('：')[0],
      export: [
        h('button.btn.small', { onclick: task(() => download('/api/exports/school-totals.csv', { group_id: cat.group_id, order: exportOrder })) }, 'CSV'),
        h('button.btn.small', { onclick: task(() => download('/api/exports/school-totals.xlsx', { group_id: cat.group_id, order: exportOrder })) }, 'XLSX'),
      ],
      print: [h('button.btn.small', {
        onclick: task(() => openHtml('/api/exports/school-notice.html', { group_id: cat.group_id, order: exportOrder }, '学校总分表')),
      }, '总分表')],
    });
    rows.push({
      report: '赛程', scope: '整届 / 本项目',
      export: [
        h('button.btn.small', { onclick: task(() => download('/api/exports/schedule.csv', { event_id: state.eventId })) }, '整届 CSV'),
        h('button.btn.small', { onclick: task(() => download('/api/exports/schedule.csv', { category_id: cat.id })) }, '本项目 CSV'),
      ],
      print: [],
    });
    if (!isIndividual) {
      const recordOptions = finished.map((m) => [m.id, `${m.round_label} ${m.home.label} vs ${m.away.label}`]);
      if (!recordOptions.length) recordOptions.push(['', '请选择场次']);
      rows.push({
        report: '记录表',
        scope: h('div', selectInput(recordOptions, sheetId || '',
          { 'aria-label': '记录表场次', onchange: (e) => { location.hash = `#/admin?tab=exports&category=${cat.id}&sheet=${e.target.value}`; } }),
          !finished.length ? h('div.small.muted', '本项目暂无可导出的场次') : null),
        export: [h('button.btn.small', { disabled: !sheetId, onclick: task(() => download('/api/exports/record-sheet.csv', { match_id: sheetId })) }, 'CSV')],
        print: [h('button.btn.small', {
          disabled: !sheetId,
          onclick: task(() => openHtml('/api/exports/record-sheet.html', { match_id: sheetId }, '藤球比赛记录表')),
        }, '记录表')],
      });
    }
    exportBox.append(h('section.panel',
      h('div.panel-head', h('h3', '导出与打印'),
        exportOrderControl((value) => { exportOrder = value; }, exportOrder)),
      h('p.small.muted', '排序只影响成绩、小组排名与学校总分的行顺序，不改变名次与积分；赛程与记录表不受排序影响。'),
      scrollableTable(h('div.table-scroll', table([
        { label: '报表', render: (row) => h('b', row.report) },
        { label: '范围', render: (row) => row.scope },
        { label: '导出', render: (row) => h('div.row.tight', ...row.export) },
        { label: '打印', render: (row) => (row.print.length ? h('div.row.tight', ...row.print) : h('span.small.muted', '—')) },
      ], rows, { responsive: true })), { hint: '横向滑动查看完整数据' })));
  }

  /* 备份与恢复入口：实际停服恢复由运维执行，页面只做下载与风险提示。 */
  function renderBackup() {
    clear(backupBox);
    backupBox.append(h('section.panel',
      h('h3', '备份与恢复'),
      h('p.small.muted', '下载的是当前数据库快照。整套备份、完整性校验与停服恢复由运维命令执行（python run.py backup / verify / restore）。'),
      h('div.row', h('button.btn.btn-primary', { onclick: task(() => download('/api/admin/backup')) }, '下载数据库备份')),
      h('div.info-box.mt', '恢复会覆盖当前数据库：请先停服并保留最近备份，恢复后核对新增候选、复核决定与权限变化，避免旧备份覆盖后丢失关键记录。'),
      h('p.small.muted.mt', '升级前请先完成一次备份；恢复与升级的完整步骤见《备份恢复与回滚演练》。')));
  }
}

/* All formal changes enter the independent candidate workflow. */
async function openCorrection(match,reload) {
  const { openCandidateEditor } = await import('../resultCandidateEditor.js');
  return openCandidateEditor(match,'correction',reload);
}
async function openCancel(match,reload) {
  const { openCandidateEditor } = await import('../resultCandidateEditor.js');
  return openCandidateEditor(match,'cancel',reload);
}

registerView({ name: 'admin', label: '更正与导出', roles: ['admin', 'organizer'], render });

/* ------------------------------------------------------------------ 账号 */
async function renderUsers({ el, signal }) {
  if (!isAdmin()) throw new Error('只有赛事管理员可以管理账号');
  const listBox = h('div');
  const countBadge = statusBadge('正在加载…', 'info');
  el.append(pageHeader({
    crumbs: [{ label: '账号管理' }],
    title: '账号管理',
    badges: [countBadge],
    meta: [h('span', '五类角色：赛事管理员、编排与成绩人员、场地记录员、成绩查看者、大屏操作员；普通账号只能访问被分配的赛事。'),
      h('span.small.muted.account-build', `界面版本 1.5.0 · ${SHELL_VERSION}`)],
    actions: [h('button.btn', { onclick: () => document.getElementById('create-account-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, '新增账号')],
  }));
  /* 本页同时存在密码输入框，浏览器的密码管理器可能把已保存的用户名自动填进
     搜索框（无 autocomplete 的文本/搜索框是常见落点）。筛选值非空会把新建账号
     过滤掉，看起来就像“新建的角色消失”。这里用状态化的筛选输入框：自动填充
     （静默赋值、自动填充伪类或替换事件）不生效且会被纠正，并显式关闭自动填充，
     把筛选状态、总数与清除入口分开呈现，避免“徽标 2 个账号、列表只剩 1 行”。 */
  const searchInput = textInput('', { type: 'search', placeholder: '搜索登录名或姓名', 'aria-label': '搜索账号',
    autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
  const roleFilter = selectInput([['', '全部角色'], ['admin', '赛事管理员'], ['organizer', '编排与成绩人员'],
    ['recorder', '场地记录员'], ['viewer', '成绩查看者'], ['display_operator', '大屏操作员']], '', { 'aria-label': '按角色筛选' });
  const statusFilter = selectInput([['', '全部状态'], ['active', '启用'], ['inactive', '停用']], '', { 'aria-label': '按状态筛选' });
  const listStatus = h('p.small.muted.account-list-status.hidden', { role: 'status', 'aria-live': 'polite' });
  const clearFiltersButton = h('button.btn.small.hidden', { type: 'button', onclick: () => clearFilters() }, '清除筛选');
  el.append(h('section.panel',
    h('div.panel-head', h('h3', '账号列表'), h('div.row.tight', listStatus, clearFiltersButton)),
    h('div.form-grid', field('搜索', searchInput), field('角色', roleFilter), field('状态', statusFilter)),
    listBox));
  el.append(renderCreateUser({ onCreated: createSucceeded, onDuplicate: duplicateAccount, signal }));
  el.append(renderMyPassword());
  let users = [];
  let loadToken = 0;
  /* 筛选状态只由真实输入事件（按键/粘贴/输入法/自动化注入文本）更新；
     密码管理器自动填充既不生效，也会在 0.5 秒内被纠正回空值。 */
  const search = bindFilterInput(searchInput, () => draw(), { initialValue: '' });
  signal?.addEventListener('abort', search.destroy, { once: true });
  roleFilter.onchange = () => draw();
  statusFilter.onchange = () => draw();
  await load();

  function filtersActive() {
    return !!(search.value().trim() || roleFilter.value || statusFilter.value);
  }
  function clearFilters() {
    search.set(''); roleFilter.value = ''; statusFilter.value = '';
    draw();
  }
  function duplicateAccount(createdUsername) {
    /* 用户名已存在：清空筛选并定位现有账号，避免用户误以为“创建失败/新账号消失”。 */
    search.set(''); roleFilter.value = ''; statusFilter.value = '';
    toast(`登录名「${createdUsername}」已存在，已清除筛选并定位到现有账号`, 'error');
    load({ focusUsername: createdUsername });
  }
  function createSucceeded(createdUsername) {
    /* 新建成功后回到“全部”视图：即使此前有筛选/自动填充值，也保证新账号立即可见。 */
    const filtered = filtersActive();
    search.set(''); roleFilter.value = ''; statusFilter.value = '';
    toast(filtered ? '已创建账号，已清除筛选以显示新账号' : '已创建账号', 'ok');
    load({ focusUsername: createdUsername });
  }
  function draw(focusUsername = null) {
    clear(listBox);
    const keyword = search.value().trim().toLowerCase();
    const visible = users.filter((user) => {
      if (keyword && !`${user.username} ${user.display_name}`.toLowerCase().includes(keyword)) return false;
      if (roleFilter.value && user.role !== roleFilter.value) return false;
      if (statusFilter.value === 'active' && !user.active) return false;
      if (statusFilter.value === 'inactive' && user.active) return false;
      return true;
    });
    const filtered = filtersActive();
    const enabled = users.filter((user) => user.active).length;
    /* 徽标继续只显示总数（口径不变）；有筛选时另起一行显示“显示 X / 共 N”，
       列表与统计始终对得上，不会再出现“徽标 2 个账号、列表只有 1 行”。 */
    listStatus.textContent = filtered ? `显示 ${visible.length} / 共 ${users.length} 个账号 · ${enabled} 个启用` : '';
    listStatus.classList.toggle('hidden', !filtered);
    clearFiltersButton.classList.toggle('hidden', !filtered);
    if (!visible.length) {
      listBox.append(h('p.muted.account-empty', users.length ? '没有符合筛选条件的账号。' : '还没有账号，请先新增。'));
      if (users.length) {
        listBox.append(h('div.row.tight.mt', h('button.btn.small', { type: 'button', onclick: () => clearFilters() }, '清除筛选显示全部账号')));
      }
      return;
    }
    const bodyRef = { current: null };
    listBox.append(h('div.table-scroll', table([
      { label: '用户名', key: 'username' },
      { label: '姓名', key: 'display_name' },
      { label: '角色', key: 'role_name' },
      { label: '所属赛事', render: (r) => (r.role === 'admin' ? '全部赛事'
        : (r.event_names?.length ? r.event_names.join('、')
          : state.events.filter((e) => r.event_ids?.includes(e.id)).map((e) => e.name).join('、')) || '尚未分配') },
      { label: '状态', render: (r) => h('div.row.tight',
        statusBadge(r.active ? '启用' : '停用', r.active ? 'ok' : 'warn'),
        r.snapshot_sync_error ? h('span.small.muted', { title: r.snapshot_sync_error }, '快照同步失败')
          : r.snapshot_sync_pending ? h('span.small.muted', '快照同步中') : null) },
      {
        label: '操作',
        render: (r) => h('div.row.tight',
          h('button.btn.small', { onclick: () => resetPassword(r) }, '重置密码'),
          h('button.btn.small', { onclick: () => editScope(r, load) }, '角色与赛事'),
          h('button.btn.small', {
            onclick: async () => {
              try {
                await api.put(`/api/users/${r.id}`, { active: !r.active });
                toast(r.active ? '已停用账号' : '已启用账号', 'ok');
                load();
              } catch (e) { toast(e.message, 'error'); }
            },
          }, r.active ? '停用' : '启用')),
      },
    ], visible, { responsive: true, bodyRef })));
    if (focusUsername) {
      const row = [...(bodyRef.current?.rows || [])]
        .find((tr) => tr.querySelector('td')?.textContent.trim() === focusUsername);
      if (row) {
        row.scrollIntoView({ block: 'center' });
        row.classList.add('flash');
      }
    }
  }

  async function load({ focusUsername = null } = {}) {
    /* 列表只认最后一次请求：新建后的新列表不能被更早发出、更晚返回的旧响应覆盖。 */
    const token = ++loadToken;
    clear(listBox);
    listBox.append(loadingState('正在加载账号…'));
    try {
      const data = await api.get('/api/users');
      if (token !== loadToken || signal?.aborted) return;
      users = data.users;
      countBadge.textContent = `共 ${users.length} 个账号 · ${users.filter((u) => u.active).length} 个启用`;
      draw(focusUsername);
    } catch (e) {
      if (token !== loadToken) return;
      if (!getToken()) return;         // 401 已由全局处理器回到登录页
      clear(listBox);
      listBox.append(errorState(e, () => load()));
    }
  }
}

async function resetPassword(user) {
  /* 用页内输入框取代 window.prompt，密码要求可以先看清楚（§9.1、Q11） */
  const pwd = await promptDialog({
    title: `重置密码 · ${user.username}`,
    label: '新密码', type: 'password', required: true, okLabel: '重置密码',
    hint: '至少 6 位；重置后请立即通知本人登录修改。',
  });
  if (!pwd) return;
  try {
    const result = await api.post(`/api/users/${user.id}/password`, { password: pwd });
    const message = result?.message || '密码已重置';
    toast(message.includes('下线') ? message : `${message}；其他设备已下线`, 'ok');
  } catch (e) { toast(e.message, 'error'); }
}

function renderCreateUser({ onCreated, onDuplicate, signal } = {}) {
  const username = textInput('', { id: 'new-account-username', name: 'new_account_username',
    placeholder: '登录名', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
  const display = textInput('', { id: 'new-account-display-name', name: 'new_account_display_name',
    placeholder: '显示名称', autocomplete: 'off' });
  const role = selectInput([['admin', '赛事管理员'], ['organizer', '编排与成绩人员'],
    ['recorder', '场地记录员'], ['viewer', '成绩查看者'], ['display_operator', '大屏操作员']], 'recorder');
  const password = h('input', { id: 'new-account-password', name: 'new_account_password',
    type: 'password', value: '', autocomplete: 'new-password', placeholder: '初始密码（至少 6 位）' });
  /* 密码管理器可能把已保存的旧凭据自动填入新建账号表单；用户未操作时点“创建”
     会得到“用户名已存在”。清理这类非用户输入，避免误提交与误解。 */
  const releaseAutofillGuard = clearUnintendedAutofill([username, display, password]);
  signal?.addEventListener('abort', releaseAutofillGuard, { once: true });
  const events = eventScopeFields([], signal);
  const errLine = h('div.field-error.hidden');
  const btn = h('button.btn.btn-primary.self-end', { type: 'submit' }, '创建');
  const resetForm = () => {
    /* 成功后完整复位：只清三个文本框会让下一个账号静默继承本次的角色与赛事范围。 */
    username.value = ''; display.value = ''; password.value = '';
    role.value = 'recorder';
    events.reset();
    errLine.textContent = '';
    errLine.classList.add('hidden');
  };
  const submit = async (event) => {
    event.preventDefault();
    btn.disabled = true;
    btn.textContent = '创建中…';
    errLine.classList.add('hidden');
    const createdUsername = username.value.trim();
    try {
      await api.post('/api/users', {
        username: createdUsername, display_name: display.value.trim(),
        role: role.value, password: password.value, event_ids: events.values(),
      });
      resetForm();
      onCreated?.(createdUsername);      // 局部刷新并定位新账号，不整页重载（Q08）
    } catch (e) {
      /* 失败保留输入（含角色与赛事选择），原因同时显示在表单内与 toast；
         用户名重复时定位到已有账号，避免“创建失败所以看不见新角色”的误解。 */
      errLine.textContent = e.message;
      errLine.classList.remove('hidden');
      if (e.code === 'duplicate' && typeof onDuplicate === 'function') onDuplicate(createdUsername);
      else toast(`创建账号失败：${e.message}`, 'error');
      username.focus();
    } finally {
      btn.disabled = false;
      btn.textContent = '创建';
    }
  };
  return h('form.panel', { id: 'create-account-form', autocomplete: 'off', onsubmit: submit },
    h('h3', '新增账号'),
    h('div.row', field('登录名', username), field('显示名称', display),
      field('角色', role), field('初始密码', password), btn),
    events.body, h('div.small.muted.mt','记录员可领取所属赛事的比赛，仅提交本人负责的记录；已提交成绩由成绩人员正式更正。管理员不受赛事范围限制。'), errLine);
}

function renderMyPassword() {
  /* 显式声明 autocomplete，避免密码管理器把已保存的用户名/密码自动填入
     其它输入框（例如账号列表的搜索框）造成“列表被意外筛选”。 */
  const oldPwd = h('input', { type: 'password', placeholder: '当前密码', autocomplete: 'current-password' });
  const newPwd = h('input', { type: 'password', placeholder: '新密码（至少 6 位）', autocomplete: 'new-password' });
  const btn = h('button.btn.btn-primary.self-end', null, '更新密码');
  btn.onclick = async () => {
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = '更新中…';
    try {
      const result = await api.post('/api/me/password', { old_password: oldPwd.value, new_password: newPwd.value });
      const revokedOthers = Number(result?.revoked_others ?? 0);
      toast(revokedOthers ? `密码已更新，其他 ${revokedOthers} 个设备已下线` : '密码已更新', 'ok');
      oldPwd.value = ''; newPwd.value = '';
    } catch (e) {
      toast(e.message, 'error');       // 失败保留输入，便于修正后重试（§9.2）
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  };
  const logoutAll = h('button.btn.btn-danger', { onclick: async () => {
    if (!await confirmAsync('退出所有设备',
      '将退出该账号在所有设备上的登录（包括本机），之后需要重新登录。\n大屏显示端使用独立凭据，不受影响。',
      '退出所有设备', { danger: true })) return;
    logoutAll.disabled = true;
    try { await logoutEverywhere(); }
    catch (e) { logoutAll.disabled = false; toast(e.message || '退出所有设备失败', 'error'); }
  } }, '退出所有设备');
  return h('div.panel', h('h3', '修改我的密码'),
    h('div.row', field('当前密码', oldPwd), field('新密码', newPwd), btn),
    h('div.small.muted.mt', '修改密码后，该账号在其他设备上的登录会立即失效。'),
    h('div.row.mt', logoutAll,
      h('span.small.muted', '退出所有设备会吊销本账号的全部登录凭据，需要重新登录；大屏设备不受影响。')));
}

const ROLE_NAMES = { admin: '赛事管理员', organizer: '编排与成绩人员', recorder: '场地记录员',
  viewer: '成绩查看者', display_operator: '大屏操作员' };

/* 显示设置：高对比主题只影响本机显示，写入 localStorage 并在下次启动继续生效。 */
function renderDisplaySettings() {
  const contrast = localStorage.getItem('stss_theme') === 'contrast';
  const box = h('input', { type: 'checkbox', checked: contrast });
  box.onchange = () => {
    const on = box.checked;
    localStorage.setItem('stss_theme', on ? 'contrast' : 'light');
    document.documentElement.dataset.theme = on ? 'contrast' : '';
    toast(on ? '已切换高对比主题' : '已恢复默认主题', 'ok');
  };
  return h('section.panel', h('h3', '显示设置'),
    h('label.row', null, box, h('span', '高对比主题（深色文字、加粗边框）')),
    h('p.small.muted', '仅影响本机浏览器显示，不改变业务数据。'));
}

function renderAccount({ el }) {
  const roleName = ROLE_NAMES[state.user?.role] || state.user?.role || '';
  const current = state.events.find((event) => event.id === state.eventId);
  el.append(pageHeader({
    crumbs: [{ label: '我的账号' }],
    title: '我的账号',
    badges: [statusBadge(roleName, 'info')],
    meta: [h('span', `登录名：${state.user?.username || ''}`),
      h('span', `当前赛事：${current?.name || '未选择'}`)],
  }));
  el.append(renderMyPassword());
  el.append(h('section.panel', h('h3', '角色与赛事'),
    h('p.small.muted', '角色与赛事范围由管理员在“账号管理 → 角色与赛事”中分配；普通账号只能访问被分配的赛事。'),
    isAdmin() ? h('a.btn', { href: '#/users' }, '前往账号管理') : null));
  el.append(renderDisplaySettings());
}

registerView({ name: 'users', label: '账号管理', roles: ['admin'], render: renderUsers });

registerView({ name: 'account', label: '我的账号', roles: ['admin', 'organizer', 'recorder', 'viewer'], render: renderAccount });

let eventScopeSequence = 0;
function eventScopeFields(selected, signal) {
  const scopeId = `event-scope-${++eventScopeSequence}`;
  const values = () => boxes.filter(({ input }) => input.checked).map(({ event }) => event.id);
  const snapshot = h('input', { type: 'hidden', dataset: { field: 'event_ids' } });
  const chosen = h('span.event-scope-value', { id: `${scopeId}-value` });
  const selectedCount = h('span.event-scope-count.hidden', { 'aria-hidden': 'true' });
  const trigger = h('button.event-scope-trigger', { type: 'button', 'aria-label': '所属赛事',
    'aria-expanded': 'false', 'aria-controls': `${scopeId}-options`,
    'aria-describedby': `${scopeId}-value`, disabled: !state.events.length }, chosen, selectedCount,
    h('span.event-scope-arrow', { 'aria-hidden': 'true' }, '▾'));
  const search = h('input', { type: 'search', placeholder: '搜索赛事名称',
    'aria-label': '搜索赛事', autocomplete: 'off' });
  const count = h('span.small.muted', { role: 'status' });
  const clearButton = h('button.btn.small', { type: 'button', onclick: () => {
    boxes.forEach(({ input }) => { input.checked = false; });
    sync();
  } }, '清空');
  const done = h('button.btn.small', { type: 'button', onclick: () => close(true) }, '完成');
  const boxes = state.events.map(event => {
    const input = h('input', { type: 'checkbox', checked: selected?.includes(event.id), onchange: sync });
    return { event, input, row: h('label.event-scope-option', input, h('span', event.name)) };
  });
  const noResults = h('div.small.muted.hidden', '没有匹配的赛事');
  const panel = h('div.event-scope-dropdown.hidden', { id: `${scopeId}-options`, role: 'group', 'aria-label': '可选赛事' },
    search, h('div.event-scope-options', ...boxes.map(({ row }) => row), noResults),
    h('div.event-scope-footer', count, h('div.row.tight', clearButton, done)));
  const body = h('div.event-scope-picker.mt', h('h4', '所属赛事'), trigger, panel, snapshot,
    h('div.small.muted.mt-xs', boxes.length ? '可多选，展开后勾选所属赛事。'
      : '请先创建赛事，稍后在“角色与赛事”中分配。'));
  let open = false, disposed = false;

  function sync() {
    const names = boxes.filter(({ input }) => input.checked).map(({ event }) => event.name);
    chosen.textContent = names.length ? names.join('、') : boxes.length ? '请选择赛事' : '暂无可选赛事';
    chosen.classList.toggle('muted', !names.length);
    selectedCount.textContent = `${names.length} 项`;
    selectedCount.classList.toggle('hidden', names.length < 2);
    trigger.title = names.length ? names.join('、') : '可选择多个赛事';
    count.textContent = `已选择 ${names.length} 项`;
    clearButton.disabled = !names.length;
    snapshot.value = JSON.stringify(values());
  }
  function filter() {
    const query = search.value.trim().toLocaleLowerCase();
    let visible = 0;
    boxes.forEach(({ event, row }) => {
      const matches = event.name.toLocaleLowerCase().includes(query);
      row.classList.toggle('hidden', !matches);
      if (matches) visible += 1;
    });
    noResults.classList.toggle('hidden', !!visible);
  }
  function close(focus = false) {
    open = false;
    panel.classList.add('hidden');
    trigger.setAttribute('aria-expanded', 'false');
    if (focus) trigger.focus();
  }
  trigger.addEventListener('click', () => {
    if (open) { close(); return; }
    search.value = '';
    filter();
    open = true;
    panel.classList.remove('hidden');
    trigger.setAttribute('aria-expanded', 'true');
  });
  search.addEventListener('input', filter);
  search.addEventListener('keydown', event => {
    if (event.key === 'Enter') event.preventDefault();
  });
  function outside(event) {
    if (open && !body.contains(event.target)) close();
  }
  function escape(event) {
    if (open && event.key === 'Escape' && body.contains(event.target)) {
      event.preventDefault();
      // 在弹窗捕获监听之前处理，Escape 先收起赛事列表。
      event.stopImmediatePropagation();
      close(true);
    }
  }
  function reset() {
    /* 新建账号成功后清空赛事选择：避免下一个账号静默继承本次的赛事范围。 */
    boxes.forEach(({ input }) => { input.checked = false; });
    search.value = '';
    close();
    filter();
    sync();
  }
  function destroy() {
    if (disposed) return;
    disposed = true;
    close();
    document.removeEventListener('pointerdown', outside);
    document.removeEventListener('keydown', escape, true);
    signal?.removeEventListener('abort', destroy);
  }
  document.addEventListener('pointerdown', outside);
  document.addEventListener('keydown', escape, true);
  if (signal?.aborted) destroy();
  else signal?.addEventListener('abort', destroy, { once: true });
  sync();
  return { body, values, destroy, reset };
}
function editScope(user, reload) {
  const scopes=eventScopeFields(user.event_ids);
  const role=selectInput([['admin','赛事管理员'],['organizer','编排与成绩人员'],['recorder','场地记录员'],['viewer','成绩查看者'],['display_operator','大屏操作员']],user.role,{dataset:{field:'role'}});
  formDialog({title:'角色与赛事 · '+user.display_name, onClose:scopes.destroy, sections:[{body:h('div',field('角色',role),scopes.body)}],actions:[{label:'保存',primary:true,run:async({close})=>{
    const saved=await api.put('/api/users/'+user.id,{role:role.value,event_ids:scopes.values()}); close(); await reload();
    if(saved?.snapshot_sync_pending)toast('角色与赛事已保存；账号快照同步中，其它设备稍后生效');else toast('角色与赛事已保存','ok');
  }}]});
}

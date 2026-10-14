/* 成绩更正与导出、账号管理（设计大纲 3、8、12.3；改进方案 §13.2、§13.4）。 */
import { api, download, openHtml, newUid, captureRequestContext, recordRequestContext, validateReceipt } from '../api.js';
import { localStore } from '../store.js';
import { registerView, state, loadStructure } from '../main.js';
import { openEditor as openIndividualCorrection } from './individual.js';
import {
  h, field, selectInput, numberInput, textInput, textarea, table, toast, modal, statusBadge,
  task, formDialog, promptDialog, clear, loadingState, errorState, emptyState, categoryLabel,
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
  correct_match: '正式更正三人赛成绩', cancel_match: '标记取消或未完成', create_reset_match: '生成决赛重赛',
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
};
const AUDIT_OBJECTS = { match: '场次', individual: '个人赛报名', individual_result: '个人赛成绩',
  pool: '小组', plan: '方案', category: '项目', school: '学校', event: '赛事', placement: '名次',
  group: '组别', database: '赛事数据库', user: '账号', participation: '报名', team: '代表队', stage: '阶段' };

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

  el.append(h('div.panel',
    h('div.panel-head',
      h('h2', '成绩更正与导出'),
      field('项目', selectInput(cats.map((c) => [c.id, categoryLabel(c, { withGroup: true })]),
        cat.id, { onchange: (e) => { location.hash = `#/admin?category=${e.target.value}`; } }))),
    h('div.small.muted', '比赛中误操作撤回与赛后正式更正分开处理：正式更正需要权限与原因，'
      + '系统保留原结果版本，并列出受影响的后续场次与需要重新确认的小组。'),
  ));

  const listBox = h('div');
  const exportBox = h('div');
  const logBox = h('div');
  const pager = h('div.row.tight.mt');
  let pageOffset = 0, pageRevision;
  el.append(listBox, pager, exportBox, logBox);
  await load();

  async function load() {
    clear(listBox);
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
              h('button.btn.small', { onclick: () => openCancel(m, load) }, '标记取消/未完成')) : null),
          },
        ], finished)) : emptyState({
          text: '该项目暂无已确认场次',
          hint: '比赛记录提交并确认后会出现在这里，可从结果详情发起正式更正。',
        })));

      /* 导出范围写在按钮上，避免“写着当前项目却导出整届”（§13.4） */
      const sheetId = Number(params.sheet || (finished[0]?.id ?? 0));
      clear(exportBox);
      exportBox.append(h('div.panel',
        h('h3', '导出与打印'),
        h('div.row',
          h('button.btn', {
            title: '导出整届赛事全部场次的赛程',
            onclick: task(() => download('/api/exports/schedule.csv', { event_id: state.eventId })),
          }, '全部赛程 CSV（整届）'),
          !isIndividual ? h('button.btn', {
            title: `只导出 ${categoryLabel(cat)} 的赛程`,
            onclick: task(() => download('/api/exports/schedule.csv', { category_id: cat.id })),
          }, '本项目赛程 CSV') : null,
          h('button.btn', {
            title: `只导出 ${categoryLabel(cat)} 的成绩`,
            onclick: task(() => download('/api/exports/results.csv', { category_id: cat.id })),
          }, '本项目成绩 CSV'),
          h('button.btn', {
            onclick: task(() => openHtml('/api/exports/category-notice.html', { category_id: cat.id }, '项目成绩单')),
          }, cat.kind === 'individual' ? '打印个人赛成绩单' : '打印三人赛名次表'),
          !isIndividual ? field('记录表场次', selectInput(
            finished.map((m) => [m.id, `${m.round_label} ${m.home.label} vs ${m.away.label}`]),
            sheetId,
            { onchange: (e) => { location.hash = `#/admin?category=${cat.id}&sheet=${e.target.value}`; } })) : null,
          !isIndividual ? h('button.btn', {
            onclick: task(() => openHtml('/api/exports/record-sheet.html', { match_id: sheetId }, '藤球比赛记录表')),
            disabled: !sheetId,
          }, '打印记录表（15 分制）') : null,
          !isIndividual ? h('button.btn', {
            onclick: task(() => download('/api/exports/record-sheet.csv', { match_id: sheetId })),
            disabled: !sheetId,
          }, '记录表 CSV') : null)));

      /* 备份与审计属于维护动作，不与现场成绩导出并列（§13.4） */
      clear(logBox);
      if (isAdmin()) {
        const logs = (await api.get('/api/audit-logs?limit=60')).logs;
        logBox.append(h('div.panel',
          h('h3', '维护 · 关键操作记录（最近 60 条）'),
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
      }
      return individualRows;
    } catch (e) {
      if (e.cancelled || !isCurrent()) return;
      if (e.code === 'list_changed') { pageOffset = 0; pageRevision = null; return load(); }
      clear(listBox);
      listBox.append(h('div.panel', errorState(e, load)));
    }
  }
}

/* 正式更正：回填原结果 → 修正值与原因 → 前后差异与影响 → 提交（§13.2） */
async function openCorrection(match, reload) {
  const context = captureRequestContext();
  const key = `${context.identity?.deployment_id}:${context.identity?.event_uuid}:correction:${match.id}`;
  let packet = await localStore.get(key);
  if (packet) packet.request_context = recordRequestContext(packet);
  let resetResolutions;
  const reason = textarea('', { placeholder: '请输入更正原因（必填）' });
  reason.dataset.field = 'reason';
  const status = selectInput(RESULT_STATUS, match.result_status || 'normal');
  const sets = [];
  const setRows = [];
  for (let i = 1; i <= 3; i += 1) {
    const exist = match.sets.find((s) => s.set_no === i) || {};
    const home = numberInput(exist.home_points ?? '', { min: 0, max: 15, style: 'width:80px' });
    const away = numberInput(exist.away_points ?? '', { min: 0, max: 15, style: 'width:80px' });
    home.dataset.field = `set${i}_home`;
    away.dataset.field = `set${i}_away`;
    sets.push({
      home, away,
      homeBefore: exist.home_points ?? null,
      awayBefore: exist.away_points ?? null,
    });
    setRows.push(h('div.row.tight.mt', h('span', { style: 'min-width:70px' }, `第${i}局`),
      field('主队', home), field('客队', away)));
  }
  const keepEvents = h('input', { type: 'checkbox', checked: true });
  const diff = h('div.small.muted.mt', '');

  /* 提交前展示前后差异（§13.2）：空值按“无该局”处理，不当成 0 分 */
  const shown = (v) => (v === '' || v === null || v === undefined ? '—' : String(v));
  function showDiff() {
    const changes = sets.map((s, i) => {
      const beforeHome = s.homeBefore === null ? '' : String(s.homeBefore);
      const beforeAway = s.awayBefore === null ? '' : String(s.awayBefore);
      return {
        no: i + 1,
        changed: beforeHome !== s.home.value.trim() || beforeAway !== s.away.value.trim(),
        before: `${shown(s.homeBefore)}:${shown(s.awayBefore)}`,
        after: `${shown(s.home.value.trim())}:${shown(s.away.value.trim())}`,
      };
    }).filter((c) => c.changed);
    clear(diff);
    if (!changes.length) { diff.append('尚未修改局分。'); return; }
    diff.append(h('b', '前后差异：'),
      ...changes.map((c) => h('div', `第${c.no}局　${c.before} → ${c.after}`)));
  }
  sets.forEach((s) => {
    s.home.addEventListener('input', showDiff);
    s.away.addEventListener('input', showDiff);
  });
  showDiff();
  if (packet?.payload) {
    reason.value = packet.payload.reason; status.value = packet.payload.result_status;
    sets.forEach((s, i) => { const found = packet.payload.sets?.find((v) => v.set_no === i + 1); s.home.value = found?.home_points ?? ''; s.away.value = found?.away_points ?? ''; });
    for (const control of [reason, status, keepEvents, ...sets.flatMap((s) => [s.home, s.away])]) control.disabled = true;
    showDiff();
  }

  formDialog({
    title: `正式更正 · ${match.round_label} 第${match.seq}场`,
    subtitle: `${match.home.label} vs ${match.away.label} · 当前结果版本 v${match.result_version}`,
    width: 'min(620px, 96vw)',
    sections: [
      { title: '修正后的局分', body: h('div', ...setRows, diff) },
      {
        title: '结果状态与原因',
        body: h('div',
          h('div.form-grid', field('结果状态', status, { name: 'result_status' })),
          h('label.row.tight.mt', { style: 'align-items:center' }, keepEvents,
            h('span', '保留原逐分过程记录（仅更正最终局分，不再补录过程）')),
          field('更正原因', reason, { required: true, name: 'reason' }),
          h('div.small.muted.mt', '更正会提升该场次结果版本；已开展或已完成的后续比赛不会被自动改写，'
            + '系统会列出需要人工处理的场次。')),
      },
    ],
    actions: [{
      label: '提交更正', primary: true, danger: true, busyLabel: '提交中…',
      run: async ({ close }) => {
        if (!reason.value.trim()) {
          throw Object.assign(new Error('请填写更正原因'),
            { detail: { fields: { reason: '请填写更正原因' } } });
        }
        const resultSets = sets.map((s, i) => ({
          set_no: i + 1,
          home_points: s.home.value === '' ? 0 : Number(s.home.value),
          away_points: s.away.value === '' ? 0 : Number(s.away.value),
        })).filter((s) => s.home_points || s.away_points)
          .map((s) => ({ ...s, winner_side: s.home_points > s.away_points ? 'home' : 'away' }));
        let res;
        try {
          const payload = packet?.payload || {
            reason: reason.value.trim(), result_status: status.value, sets: resultSets,
            events: [], request_uid: newUid('correction'), base_version: match.result_version,
            ...(resetResolutions ? { reset_resolutions: resetResolutions } : {}),
          };
          packet ||= { key, kind: 'correction', match_id: match.id, uid: payload.request_uid, payload,
            event_identity: context.identity, request_context: context, base_version: match.result_version, status: 'submitting' };
          res = await sendFormalPacket(packet, 'correction', match.id);
        } catch (e) {
          if (e.request_released) { packet = null; for (const control of [reason, status, keepEvents, ...sets.flatMap((s) => [s.home, s.away])]) control.disabled = false; }
          if (e.code === 'reset_requires_review' && e.detail?.reset_matches) {
            const why = await promptDialog({ title: '停用需要复核的重置比赛', label: '停用并保留历史的原因', required: true,
              hint: `涉及场次 ${e.detail.reset_matches.map((m) => '#' + m.id).join('、')}，原记录和审计将保留。核对后填写原因，返回原更正表再次提交。` });
            if (why) resetResolutions = e.detail.reset_matches.map((m) => ({ match_id: m.id, base_version: m.base_version, action: 'deactivate', reason: why }));
          }
          /* 版本冲突或校验不通过时保留输入，不覆盖别人的结果（§13.2） */
          if (e.detail && e.detail.errors) {
            throw Object.assign(new Error('更正未通过校验'), { detail: { message: e.detail.errors.join('；') } });
          }
          throw e;
        }
        toast('已更正并重算', 'ok');
        close();
        const notes = [];
        if (res.affected?.length) {
          notes.push(`受影响后续场次：${res.affected.map((a) => `#${a.match_id}`).join('、')}`);
        }
        if (res.stale_pools?.length) {
          notes.push(`需重新确认名次的小组：${res.stale_pools.map((p) => p.pool_name).join('、')}`);
        }
        if (notes.length) {
          modal({
            title: '更正影响 · 需重新确认的名次不能继续冒充最新正式结果',
            body: h('ul.hint-list', ...notes.map((n) => h('li', n))),
          });
        }
        reload();
      },
    }],
  });
}

async function openCancel(match, reload) {
  const context = captureRequestContext();
  const key = `${context.identity?.deployment_id}:${context.identity?.event_uuid}:cancel:${match.id}`;
  let packet = await localStore.get(key);
  if (packet) packet.request_context = recordRequestContext(packet);
  let resetResolutions;
  const reason = textarea('', { placeholder: '原因（必填）' });
  reason.dataset.field = 'reason';
  const status = selectInput([['cancelled', '已取消'], ['unfinished', '未完成']], 'cancelled');
  if (packet?.payload) { reason.value = packet.payload.reason; status.value = packet.payload.result_status; reason.disabled = status.disabled = true; }
  formDialog({
    title: `标记现场结果 · ${match.round_label} 第${match.seq}场`,
    subtitle: `${match.home.label} vs ${match.away.label}`,
    width: 'min(520px, 94vw)',
    sections: [{
      body: h('div',
        h('div.info-box', '用于临时弃权、退赛或比赛未完成：保存结果状态与现场确认信息，不自行补造比分。'),
        h('div.form-grid.mt', field('结果状态', status, { name: 'result_status' })),
        field('原因', reason, { required: true, name: 'reason' })),
    }],
    actions: [{
      label: '保存', primary: true, busyLabel: '保存中…',
      run: async ({ close }) => {
        if (!reason.value.trim()) {
          throw Object.assign(new Error('请填写原因'), { detail: { fields: { reason: '请填写原因' } } });
        }
        const payload = packet?.payload || { reason: reason.value.trim(), result_status: status.value,
          request_uid: newUid('cancel'), base_version: match.result_version,
          ...(resetResolutions ? { reset_resolutions: resetResolutions } : {}) };
        packet ||= { key, kind: 'cancel', match_id: match.id, uid: payload.request_uid, payload,
          event_identity: context.identity, request_context: context, base_version: match.result_version, status: 'submitting' };
        try { await sendFormalPacket(packet, 'cancel', match.id); }
        catch (error) {
          if (error.request_released) { packet = null; reason.disabled = status.disabled = false; }
          if (error.code === 'reset_requires_review' && error.detail?.reset_matches) {
            const why = await promptDialog({ title: '停用需要复核的重置比赛', label: '停用并保留历史的原因', required: true,
              hint: `涉及场次 ${error.detail.reset_matches.map((m) => '#' + m.id).join('、')}，填写原因后返回原表再次提交。` });
            if (why) resetResolutions = error.detail.reset_matches.map((m) => ({ match_id: m.id, base_version: m.base_version, action: 'deactivate', reason: why }));
          }
          throw error;
        }
        toast('已保存现场确认结果', 'ok');
        close();
        reload();
      },
    }],
  });
}

async function sendFormalPacket(packet, kind, subject) {
  if (packet.storage_conflict) throw new Error('此请求与其他页面冲突，请导出并核对');
  if (!(packet.generation ? await localStore.put(packet) : await localStore.begin(packet))) throw new Error('其他页面已修改此记录，请重载核对');
  const wasUnknown = !!packet.submission_unknown;
  try {
    if (wasUnknown) {
      const found = await api.get(`/api/receipts/${encodeURIComponent(packet.uid)}`, { context: packet.request_context, signal: undefined });
      if (found.found) {
        const receipt = await validateReceipt(found, packet.payload, kind, subject);
        if (!await localStore.finalize(packet, receipt)) throw new Error('收据保存失败，请保持原请求并重试');
        return { receipt };
      }
    }
    const response = await api.post(`/api/matches/${subject}/${kind}`, packet.payload, { context: packet.request_context,
      validate: (res) => validateReceipt(res, packet.payload, kind, subject) });
    if (!await localStore.finalize(packet, response.receipt)) throw new Error('正式结果已保存，收据保存失败，请重试核实');
    return response;
  } catch (error) {
    packet.status = 'failed'; packet.submission_unknown = wasUnknown || !!error.outcome_unknown;
    if (!packet.submission_unknown && error.code !== 'account_changed' && error.status >= 400 && error.status < 500) {
      if (!await localStore.remove(packet.key, packet)) throw new Error('请求已变化，请保留输入并重新核对');
      error.request_released = true; throw error;
    }
    if (!await localStore.put(packet)) throw new Error('请求本机保存冲突，请保持此页并核对恢复分支');
    throw error;
  }
}

registerView({ name: 'admin', label: '更正与导出', roles: ['admin', 'organizer'], render });

/* ------------------------------------------------------------------ 账号 */
async function renderUsers({ el, signal }) {
  if (!isAdmin()) throw new Error('只有赛事管理员可以管理账号');
  const listBox = h('div');
  el.append(h('div.panel',
    h('h2', '账号与权限'),
    h('div.small.muted', '角色：赛事管理员（全部权限）、编排与成绩人员（编排、名次、更正、导出）、'
      + '场地记录员（加载并提交成绩）、成绩查看者（只读）。记录任务按场次领取，转交由管理员或成绩人员操作。'),
  ));
  el.append(listBox);
  el.append(renderCreateUser(load, signal));
  el.append(renderMyPassword());
  await load();

  async function load() {
    clear(listBox);
    listBox.append(h('div.panel', loadingState('正在加载账号…')));
    try {
      const data = await api.get('/api/users');
      clear(listBox);
      listBox.append(h('div.panel',
        h('h3', '账号列表'),
        h('div.table-scroll', table([
          { label: '用户名', key: 'username' },
          { label: '姓名', key: 'display_name' },
          { label: '角色', key: 'role_name' },
          {label:'所属赛事',render:r=>r.role==='admin'?'全部赛事':state.events.filter(e=>r.event_ids?.includes(e.id)).map(e=>e.name).join('、') || '尚未分配'},
          { label: '状态', render: (r) => statusBadge(r.active ? '启用' : '停用', r.active ? 'ok' : 'warn') },
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
                    load();                      // 局部刷新，不整页重载（Q08）
                  } catch (e) { toast(e.message, 'error'); }
                },
              }, r.active ? '停用' : '启用')),
          },
        ], data.users))));
    } catch (e) {
      clear(listBox);
      listBox.append(h('div.panel', errorState(e, load)));
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
    await api.post(`/api/users/${user.id}/password`, { password: pwd });
    toast('密码已重置', 'ok');
  } catch (e) { toast(e.message, 'error'); }
}

function renderCreateUser(load, signal) {
  const username = textInput('', { id: 'new-account-username', name: 'new_account_username',
    placeholder: '登录名', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
  const display = textInput('', { id: 'new-account-display-name', name: 'new_account_display_name',
    placeholder: '显示名称', autocomplete: 'off' });
  const role = selectInput([['admin', '赛事管理员'], ['organizer', '编排与成绩人员'],
    ['recorder', '场地记录员'], ['viewer', '成绩查看者']], 'recorder');
  const password = h('input', { id: 'new-account-password', name: 'new_account_password',
    type: 'password', value: '', autocomplete: 'new-password', placeholder: '初始密码（至少 6 位）' });
  const events = eventScopeFields([], signal);
  const errLine = h('div.field-error.hidden');
  const btn = h('button.btn.btn-primary', { type: 'submit', style: 'align-self:flex-end' }, '创建');
  const submit = async (event) => {
    event.preventDefault();
    btn.disabled = true;
    btn.textContent = '创建中…';
    errLine.classList.add('hidden');
    try {
      await api.post('/api/users', {
        username: username.value.trim(), display_name: display.value.trim(),
        role: role.value, password: password.value, event_ids: events.values(),
      });
      toast('已创建账号', 'ok');
      username.value = ''; display.value = ''; password.value = '';
      load();                          // 局部刷新，不整页重载（Q08）
    } catch (e) {
      /* 失败保留输入，只把原因显示在表单里（§9.2） */
      errLine.textContent = e.message;
      errLine.classList.remove('hidden');
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
  const oldPwd = h('input', { type: 'password', placeholder: '当前密码' });
  const newPwd = h('input', { type: 'password', placeholder: '新密码（至少 6 位）' });
  const btn = h('button.btn.btn-primary', { style: 'align-self:flex-end' }, '更新密码');
  btn.onclick = async () => {
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = '更新中…';
    try {
      await api.post('/api/me/password', { old_password: oldPwd.value, new_password: newPwd.value });
      toast('密码已更新', 'ok');
      oldPwd.value = ''; newPwd.value = '';
    } catch (e) {
      toast(e.message, 'error');       // 失败保留输入，便于修正后重试（§9.2）
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  };
  return h('div.panel', h('h3', '修改我的密码'),
    h('div.row', field('当前密码', oldPwd), field('新密码', newPwd), btn));
}

registerView({ name: 'users', label: '账号管理', roles: ['admin'], render: renderUsers });

registerView({name:'account', label:'我的账号', roles:['admin','organizer','recorder','viewer'], render:({el})=>el.append(renderMyPassword())});

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
    h('div.small.muted', { style: 'margin-top:6px' }, boxes.length ? '可多选，展开后勾选所属赛事。'
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
  return { body, values, destroy };
}
function editScope(user, reload) {
  const scopes=eventScopeFields(user.event_ids);
  const role=selectInput([['admin','赛事管理员'],['organizer','编排与成绩人员'],['recorder','场地记录员'],['viewer','成绩查看者']],user.role,{dataset:{field:'role'}});
  formDialog({title:'角色与赛事 · '+user.display_name, onClose:scopes.destroy, sections:[{body:h('div',field('角色',role),scopes.body)}],actions:[{label:'保存',primary:true,run:async({close})=>{
    await api.put('/api/users/'+user.id,{role:role.value,event_ids:scopes.values()}); close(); await reload();
  }}]});
}

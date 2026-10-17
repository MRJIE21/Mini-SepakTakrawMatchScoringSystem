import { transferButton } from '../recordingOwner.js';
import { mountIndividualDraw } from '../individualDraw.js';
/* 个人赛成绩录入：只录最终成绩与确认名次，不记录过程（设计大纲 6.2、改进方案 §7）。

   与旧版的区别：
   - 保存后只局部刷新列表，不再 location.reload() 打断连续录入（Q08、T17）；
   - 名单、成绩与同步状态仅显示后台保存的结果，本机输入不进入列表；
   - 提交失败时编辑框保持打开、输入完整保留，不再靠 return false 约定（Q05）；
   - 不读取三人赛编排方案，个人赛没有方案也能录成绩、看名次、导出（§7.3）。 */
import { api, newUid, getApiEventContext, captureRequestContext, recordRequestContext, validateReceipt } from '../api.js';
import { registerView, state, loadStructure } from '../main.js';
import { localStore, deviceName } from '../store.js';
import { buildIndividualPayload } from '../submit.js';
import {
  h, field, selectInput, numberInput, textInput, table, toast, statusBadge, clear,
  formDialog, loadingState, errorState, emptyState, categoryLabel, task,
} from '../ui.js';

const canWrite = () => ['admin', 'organizer', 'recorder'].includes(state.user.role);
const isOfficial = (result) => result?.confirmed && result.result_status !== 'pending';
const canEdit = (row) => canWrite() && (state.user.role !== 'recorder'
  || (!row.result && (!row.recorder_id || row.recorder_id === state.user.id)));
const STATUS = [
  ['normal', '正常完成'],
  ['pending', '待确认'],
  ['dnf', '未完成'],
  ['dns', '未参加'],
  ['dsq', '取消成绩'],
];
/* 同步状态固定文案（§12.3），避免把“本机已存”说成“服务器已确认” */
const SYNC = {
  none: ['未录入', ''],
  server: ['服务器已确认', 'ok'],
  pending: ['服务器已保存，成绩待确认', 'warn'],
};

async function render({ el, params, signal, requestContext = captureRequestContext(), isCurrent = () => true }) {
  const alive = () => el.isConnected && !signal?.aborted && isCurrent();
  if (!state.eventId) throw new Error('请先在“赛事首页”中创建赛事');
  const structure = state.structure || await loadStructure();
  const cats = [];
  for (const g of structure.groups) {
    for (const c of g.categories) if (c.kind === 'individual') cats.push({ ...c, group_name: g.name });
  }
  if (!cats.length) {
    el.append(emptyState({
      text: '当前赛事没有个人赛项目',
      hint: '请先在“赛事设置”中添加个人赛项目。个人赛不依赖三人赛的编排方案。',
    }));
    return;
  }
  const catId = Number(params.category || cats[0].id);
  const cat = cats.find((c) => c.id === catId);
  const embedded = params.embedded === 'workspace';
  if (!cat) {
    /* 上下文非法时说明并给重新选择入口，不静默回退到第一个项目（§4.1） */
    el.append(errorState(new Error(`项目不存在或不属于本赛事（id=${catId}）`),
      () => { location.hash = '#/individual'; }));
    return;
  }

  if (!embedded) el.append(h('div.panel',
    h('div.panel-head',
      h('h2', categoryLabel(cat, { withGroup: true })),
      field('切换项目', selectInput(
        cats.map((c) => [c.id, categoryLabel(c, { withGroup: true })]), cat.id,
        { onchange: (e) => { location.hash = `#/individual?category=${e.target.value}`; } }))),
    h('div.small.muted', '个人赛仅录入最终成绩（有效次数或得分）、确认名次及结果状态，不保存逐次得分过程。'
      + '同成绩无法确定名次时，录入现场最终确认的排序，系统不会自动按姓名或录入顺序排名。'),
  ));
  else el.append(h('div.workspace-note',
    '仅录入最终成绩、结果状态和正式名次；同成绩时按现场确认结果录入。'));

  const drawBox = h('div');
  el.append(drawBox);
  let drawControl = null;
  const listBox = h('div');
  const panel = h('div.panel', h('h3', '成绩与名次'), listBox);
  el.append(panel);
  await load();

  async function load() {
    const identity = getApiEventContext();
    const identityKey = `${identity?.deployment_id || 'unknown'}:${identity?.event_uuid || 'unidentified'}`;
    const cacheKey = `${identityKey}:package:individual-${cat.id}`;
    clear(listBox);
    listBox.append(loadingState('正在加载名单与成绩…'));
    let data;
    let results;
    let offline = false;
    try {
      data = await api.get(`/api/categories/${cat.id}/participations`, { context: requestContext, signal });
      results = (await api.get(`/api/categories/${cat.id}/individual-results`, { context: requestContext, signal })).results;
      if (!alive()) return;
      await localStore.put({ key: cacheKey, kind: 'package', event_identity: identity, saved_at: Date.now(), data, results });
    } catch (err) {
      if (!err.offline) {
        clear(listBox); listBox.append(errorState(err, load)); return;
      }
      const cached = await localStore.get(cacheKey);
      if (!cached || !cached.data) {
        clear(listBox);
        listBox.append(errorState(err, load));
        return;
      }
      data = cached.data;
      results = cached.results || [];
      offline = true;
    }
    if (!alive()) return;
    /* 逐人抽签面板自己读取 /individual-draw/session；这里只提供报名名单与正式签表初值。 */
    if (!drawControl) drawControl = await mountIndividualDraw({ container: drawBox, category: cat,
      roster: data.participations,
      initialData: data.individual_draw || { status: 'none', revision: 0, entries: [] },
      initialOffline: offline,
      canManage: ['admin', 'organizer'].includes(state.user.role),
      requestContext, signal, isCurrent: alive, onSaved: load });
    if (data.individual_draw) await drawControl.update(data.individual_draw, offline);
    if (!alive()) return;
    const resultMap = new Map(results.map((r) => [r.participation_id, r]));
    const rows = data.participations.map((p) => ({
      ...p,
      result: resultMap.get(p.id) || null,
    }));

    clear(listBox);
    if (offline) {
      listBox.append(h('div.warn-box.mb',
        '当前离线：显示上次从后台读取的名单与成绩，未提交输入不计入列表。恢复联网后再提交当前填写的内容。'));
    }
    listBox.append(h('div.panel-head', h('h3', `${categoryLabel(cat)} · 成绩与名次（${rows.length} 人）`),
      ['admin', 'organizer'].includes(state.user.role) ? h('button.btn.btn-primary', {
        onclick: async () => {
          try {
            const res = await api.post(`/api/categories/${cat.id}/individual-rankings/confirm`);
            toast(res.message, 'ok'); await load();
          } catch (error) {
            if (error.code === 'individual_tie_pending') openIndividualLots(cat, error.detail, load);
            else toast(error.message, 'error');
          }
        },
      }, '按成绩确认项目名次') : null));
    if (!rows.length) {
      listBox.append(emptyState({
        text: '还没有运动员报名',
        hint: '个人赛可以直接在项目工作台的“报名名单”中添加参赛学校和运动员，不需要编排方案。',
      }));
      return rows;
    }
    listBox.append(h('div.table-scroll', table([
      { label: '出场序号', render: (r) => r.draw_order == null ? '未抽签'
        : `${r.draw_order}${r.draw_status === 'stale' ? '（待重抽）' : ''}${r.status !== 'active' ? '（已退出）' : ''}`, align: 'num' },
      { label: '种子', render: (r) => r.seed_no ?? '', align: 'num' },
      { label: '学校', render: (r) => r.school_short || r.school_name },
      { label: '运动员', key: 'subject' },
      {
        label: '最终成绩',
        render: (r) => {
          const display = (x) => `${x.result_value ?? '—'} ${x.result_text || ''}`.trim();
          if (r.result) return display(r.result);
          return h('span.muted', '未录入');
        },
      },
      {
        label: '结果状态',
        render: (r) => {
          const label = (st) => (STATUS.find((s) => s[0] === st) || [st, st])[1];
          const st = r.result ? r.result.result_status : 'pending';
          return statusBadge(label(st), st === 'normal' ? 'ok' : st === 'pending' ? 'warn' : 'danger');
        },
      },
      {
        label: '名次',
        render: (r) => (r.result && r.result.rank_no
          ? h('b', `第 ${r.result.rank_no} 名`) : h('span.muted', '待确认')),
      },
      {
        label: '记录员', render: (r) => (r.result?.recorder_name || r.recorder_name || '未领取')
          + (r.result?.corrector_name ? `（更正：${r.result.corrector_name}）` : ''),
      },
      {
        label: '同步状态',
        render: (r) => {
          const key = r.result ? (isOfficial(r.result) ? 'server' : 'pending') : 'none';
          const [text, kind] = SYNC[key];
          return statusBadge(text, kind);
        },
      },
      {
        label: '操作',
        render: (r) => r.status !== 'active' ? h('span.muted', '已退出')
          : r.draw_status === 'stale' && !r.result ? h('span.muted', '须先重新核对出场顺序')
          : h('div.row', !r.result ? transferButton('individual',r.id) : null, (canEdit(r)
          ? h('button.btn.small', { onclick: task(() => openEditor(r, cat, load, rows)) },
            r.result ? (isOfficial(r.result) ? '修改正式成绩' : '继续核对成绩') : '首次录入')
          : h('span.muted', canWrite() ? (r.result ? '已提交；更正请联系成绩人员' : `由 ${r.recorder_name || '其他记录员'} 负责`) : '只读'))),
      },
    ], rows)));
    return rows;
  }
}

function openIndividualLots(cat, detail, reload) {
  const inputs = new Map();
  formDialog({
    title: '个人赛并列名次 · 录入抽签结果', subtitle: categoryLabel(cat, { withGroup: true }),
    sections: detail.ties.map((group) => ({
      title: `第 ${group.rank_from}—${group.rank_to} 名`,
      body: h('div', h('p.small', '按现场抽签结果填写顺序，1 为本组第一；不能重复。'),
        ...group.members.map((member) => {
          const input = numberInput('', { min: 1, max: group.members.length, step: 1 });
          inputs.set(member.participation_id, input);
          return field(member.label, input, { name: `lot_${member.participation_id}` });
        })),
    })),
    actions: [{ label: '保存抽签并确认项目名次', primary: true, run: async ({ close }) => {
      const fields = {};
      const orders = detail.ties.map((group) => {
        const members = group.members.map((m) => ({ ...m, order: Number(inputs.get(m.participation_id).value) }));
        for (const member of members) {
          if (!Number.isInteger(member.order) || member.order < 1 || member.order > members.length
              || members.some((other) => other !== member && other.order === member.order)) {
            fields[`lot_${member.participation_id}`] = `请填写不重复的 1 至 ${members.length} 的整数`;
          }
        }
        return members.sort((a, b) => a.order - b.order).map((m) => m.participation_id);
      });
      if (Object.keys(fields).length) throw Object.assign(new Error('请核对抽签顺序'), { detail: { fields } });
      const res = await api.post(`/api/categories/${cat.id}/individual-rankings/confirm`, {
        tie_orders: orders, base_results: detail.base_results,
      });
      toast(res.message, 'ok'); close(); await reload();
    } }],
  });
}

export async function openEditor(row, cat, reload, rows) {
  if (!canEdit(row)) return;
  const result = row.result || {};
  const identity = getApiEventContext();
  const requestContext = captureRequestContext();
  const identityKey = `${identity?.deployment_id || 'unknown'}:${identity?.event_uuid || 'unidentified'}`;
  const key = `${identityKey}:individual:${row.id}`;
  const savedInput = await localStore.get(key);
  if (savedInput) savedInput.request_context = recordRequestContext(savedInput);
  // An uncertain request must be verified or replayed, never rewritten as a new input.
  if (savedInput?.payload) {
    let confirmed = false;
    try {
      const receipt = await api.get(`/api/receipts/${encodeURIComponent(savedInput.uid)}`, { context: savedInput.request_context || requestContext });
      if (receipt.found) {
        await validateReceipt(receipt, savedInput.payload, 'individual', row.id);
        confirmed = await localStore.finalize(savedInput, receipt.receipt);
      }
    } catch { /* Keep the original request when the backend cannot verify it. */ }
    if (confirmed) {
      const latestRows = await reload();
      const latestRow = latestRows?.find((r) => r.id === row.id);
      if (latestRow) return openEditor(latestRow, cat, reload, latestRows);
      return;
    }
    return formDialog({ title: '上次提交结果待核实', subtitle: categoryLabel(cat, { withGroup: true }),
      sections: [{ body: h('p', '请重试原请求核实提交结果，成功后读取后台最新成绩。') }],
      actions: [{ label: '重试提交', primary: true, run: async ({ close }) => {
        try {
          const response = await api.post('/api/scoring/individual', savedInput.payload, { context: savedInput.request_context || requestContext,
            validate: (res) => validateReceipt(res, savedInput.payload, 'individual', row.id) });
          if (!await localStore.finalize(savedInput, response.receipt)) throw new Error('成绩已保存，本机收据未能保存，请重试核实');
        } catch (error) {
          // A rejection of this retry cannot disprove an earlier commit.
          throw error;
        }
        close(); await reload(); toast('个人成绩已保存', 'ok');
      } }] });
  }
  if (!row.result) {
    try { await api.post('/api/recording/individual/' + row.id + '/claim'); }
    catch (error) { if (!error.offline || row.recorder_id !== state.user.id) throw error; }
  }
  let draft = null;
  const source = result;
  let submitted = false;
  const value = numberInput(source.result_value ?? '', { step: '1', min: '0', placeholder: '请输入有效次数' });
  value.dataset.field = 'result_value';
  const errors = numberInput(source.error_count ?? '', { step: '1', min: '0', placeholder: '请输入失误次数' });
  errors.dataset.field = 'error_count';
  const violations = numberInput(source.violation_count ?? '', { step: '1', min: '0', placeholder: '请输入违规次数' });
  violations.dataset.field = 'violation_count';
  const text = textInput(source.result_text || '', { placeholder: '请输入成绩描述（可选）' });
  text.dataset.field = 'result_text';
  const status = selectInput(STATUS, source.result_status || 'normal');
  status.dataset.field = 'result_status';
  const note = textInput(source.note || '', { placeholder: '现场说明' });
  note.dataset.field = 'note';
  const reason = textInput('', { placeholder: '请填写正式更正原因' });
  reason.dataset.field = 'reason';
  const syncLine = h('div.small.muted', syncText());

  function syncText() {
    if (draft) {
      return draft.status === 'failed'
        ? '提交结果待核实，请重试原请求。'
        : '正在提交成绩…';
    }
    return result.id ? (isOfficial(result) ? '当前状态：服务器已确认。' : '当前状态：服务器已保存，成绩待确认。') : '当前状态：尚未录入。';
  }

  // Build a transport packet only when submitting. Ordinary edits remain in this form.
  const currentRequest = () => ({
      key, kind: 'individual', participation_id: row.id, device: deviceName(),
      category_id: cat.id, event_identity: identity,
      base_version: result.version || 0, uid: newUid('ind'), status: 'submitting',
      request_context: requestContext,
      title: `${row.display}`,
      result_value: value.value === '' ? null : Number(value.value),
      error_count: errors.value === '' ? null : Number(errors.value),
      violation_count: violations.value === '' ? null : Number(violations.value),
      result_text: text.value.trim(), rank_no: null, result_status: status.value,
      note: note.value.trim(), reason: reason.value.trim(),
  });

  /* 提交失败必须抛异常，编辑框才会保留输入并保持打开（§9.2、Q05） */
  const runSubmit = async () => {
    if (row.result && !reason.value.trim()) {
      throw Object.assign(new Error('请填写正式更正原因'), { detail: { fields: { reason: '请填写正式更正原因' } } });
    }
    /* 正常完成要求有效成绩；不能用 0 分代替“未参加”（§7.2） */
    const request = draft || currentRequest();
    if (request.result_status === 'normal'
        && (request.result_value === null || request.error_count === null)) {
      throw Object.assign(new Error('正常完成时必须填写有效次数和失误次数'),
        { detail: { fields: { result_value: '请填写非负整数', error_count: '请填写非负整数' } } });
    }
    const payload = buildIndividualPayload(request);
    if (!(request.generation ? await localStore.put(request) : await localStore.begin(request, savedInput))) throw new Error('记录已被其他页面更新，请保持输入并核对');
    draft = request;
    syncLine.textContent = syncText();
    let response;
    try {
      response = await api.post('/api/scoring/individual', payload, { context: request.request_context,
        validate: (res) => validateReceipt(res, payload, 'individual', row.id) });
    } catch (e) {
      draft.status = 'failed';
      const wasUnknown = !!draft.submission_unknown;
      draft.submission_unknown = wasUnknown || !!e.outcome_unknown;
      if (!draft.submission_unknown && e.code !== 'account_changed' && e.status >= 400 && e.status < 500) {
        if (await localStore.remove(key, draft)) draft = null;
      } else await localStore.put(draft);
      syncLine.textContent = syncText();
      if (e.code === 'rank_taken') {
        throw Object.assign(new Error('该名次已被其他运动员占用，请核对现场确认的排序'),
          { detail: { fields: { rank_no: '该名次已被占用' } } });
      }
      throw e;
    }
    if (!await localStore.finalize(draft, response.receipt)) {
      draft.status = 'failed'; syncLine.textContent = syncText();
      throw new Error('成绩已保存，核实请求未能清理，请再次重试确认');
    }
    submitted = true;
    draft = null;
    toast(response.message || '个人成绩已提交', 'ok');
  };

  const submit = async () => {
    // Freeze the original request while its outcome is unknown; retries reuse its UID.
    const controls = [value, errors, violations, text, note, status, reason];
    controls.forEach((control) => { control.disabled = true; });
    try { await runSubmit(); }
    finally { controls.forEach((control) => { control.disabled = !!draft?.payload; }); }
  };

  const dlg = formDialog({
    title: `${row.display} · ${row.result ? '正式更正成绩' : '录入最终成绩'}`,
    subtitle: categoryLabel(cat, { withGroup: true }),
    width: 'min(560px, 94vw)',
    onClose: () => { if (!submitted) return reload().catch(error => {
      if (!error.cancelled) toast(error.message, 'error');
    }); },
    sections: [
      {
        title: '成绩',
        body: h('div.form-grid',
          field('有效次数', value, { name: 'result_value', hint: '必须为非负整数；0 与未录入不同' }),
          field('失误次数', errors, { name: 'error_count', hint: '同有效次数时，失误较少者在前' }),
          field('违规次数', violations, { name: 'violation_count', hint: '达到两次及以上时请选择取消成绩或待核对' }),
          field('成绩说明', text, { name: 'result_text' }),
          field('结果状态', status, { name: 'result_status', hint: '未参加/未完成按实际情况选择，不要用 0 分代替' })),
      },
      {
        title: '说明',
        body: h('div',
          h('div.form-grid', field('裁判说明', note, { name: 'note' })),
          row.result ? h('div',
            field('正式更正原因', reason, { name: 'reason', required: true }),
            h('div.warn-box.mt', '提交更正后，本项目全部名次将退回待确认，暂不计入学校积分；请重新确认项目名次。')) : null,
          h('div.small.muted.mt', '本页只提交原始成绩。项目名次在全部结果完整、并列处理完成后统一确认。'),
          syncLine),
      },
    ],
    actions: [
      {
        label: '核对并提交', primary: true, busyLabel: '正在提交…',
        run: async ({ close }) => { await submit(); close(); await reload(); },
      },
      ...(!row.result ? [{
        label: '提交并录入下一位', busyLabel: '正在提交…', keepOpen: true,
        run: async () => {
          await submit();
          const latest = await reload();
          const at = latest.findIndex((r) => r.id === row.id);
          const ordered = [...latest.slice(at + 1), ...latest.slice(0, at)];
          const next = ordered.find((r) => canWrite() && !r.result);
          closeAndOpenNext(next, cat, reload, latest, dlg);
        },
      }] : []),
    ],
  });
  /* 默认聚焦最终成绩字段（§7.2） */
  setTimeout(() => value.focus(), 0);
  return dlg;
}

function closeAndOpenNext(next, cat, reload, rows, dlg) {
  if (!next) {
    dlg.close();
    toast('本项目待录入人员已处理完成', 'ok');
    return;
  }
  dlg.close();
  openEditor(next, cat, reload, rows);
}

registerView({ name: 'individual', label: '个人赛成绩', roles: ['admin', 'organizer', 'recorder', 'viewer'], render });

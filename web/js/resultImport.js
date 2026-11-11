/* 人工结果只录入原值；解析、匹配、冲突复核全部由服务端完成。 */
import { api, captureRequestContext, download, getApiEventContext, newUid } from './api.js';
import { h, modal, clear, table, selectInput, confirmAsync } from './ui.js';
import { readPendingRequest, writePendingRequest, removePendingRequest, capturePendingRequestScope } from './pendingRequests.js';

export function openResultImport(category, onSaved, { isCurrent = () => true } = {}) {
  const context = captureRequestContext(), scope = capturePendingRequestScope();
  const path = `/api/categories/${category.id}/result-import`;
  const key = `manual-result-import:${category.id}`;
  let pending = readPendingRequest(key, scope), preview = null, packet = null, closed = false;
  const actions = {};
  const report = h('div', { 'aria-live': 'polite' });
  const file = h('input', { type: 'file', accept: '.xlsx,.xls,.csv', 'aria-label': '选择人工结果文件' });
  const partial = h('input', { type: 'checkbox', 'aria-label': '仅导入有效行' });
  const partialLabel = h('label.row', partial, '我已核对错误明细，仅导入有效行（错误行不写入）');
  function ensure() {
    if (closed || !isCurrent() || JSON.stringify(getApiEventContext()) !== JSON.stringify(context.identity)) throw new Error('页面或赛事已切换，请返回原项目核实');
  }
  file.onchange = () => { preview = null; packet = null; partial.checked = false; clear(report); dlg.setActionDisabled(1, true); };
  function renderPreview() {
    clear(report);
    report.append(h('h4', `解析预览 · ${preview.rows.length} 行 · ${preview.errors} 行错误`),
      h('p.small.muted', '冲突默认跳过；只有显式选择覆盖才改变已有结果。组员人数、跳号及并列仅作提示，不阻止保存。表格可横向滚动查看全部字段及冲突处理。'),
      h('div.table-scroll', table([
        { label: '行号', key: 'line' },
        { label: '原始行数据', render: r => JSON.stringify(r.raw) },
        { label: '匹配到的参赛人员/学校', render: r => r.person ? `${r.person.name || r.person.school_name}（报名ID ${r.participation_id}）` : '未匹配' },
        { label: `拟写入的${preview.field}`, key: 'value' },
        { label: '校验状态', render: r => `${r.status}：${r.errors.map(e => `${e.field}：${e.reason}`).concat(r.hints).join('；')}` },
        { label: '冲突处理', render: r => r.conflict && !r.errors.length ? h('div', `已有：${r.existing}`, selectInput([['skip', '跳过（默认）'], ['overwrite', '覆盖']], 'skip',
          { 'aria-label': `第${r.line}行冲突处理`, onchange: e => { actions[r.line] = e.target.value; } })) : '—' },
      ], preview.rows)), partialLabel);
  }
  async function send() {
    ensure();
    const result = await api.post(path + '/commit', pending.body, { context });
    removePendingRequest(key, scope); pending = null;
    let refreshError = '';
    try { await onSaved(); } catch (error) { refreshError = `导入已成功，但列表刷新失败：${error.message}。请关闭后刷新页面核对。`; }
    clear(report);
    report.append(h('h4', '导入结果'), h('p', `成功 ${result.success} 条，失败 ${result.failed} 条，跳过 ${result.skipped} 条`),
      h('p', result.message), ...result.failures.map(r => h('p.warn-box', `第 ${r.line} 行：${r.errors.map(e => `${e.field}：${e.reason}`).join('；')}`)));
    if (refreshError) report.append(h('p.warn-box', refreshError));
    dlg.setActionDisabled(0, true); dlg.setActionDisabled(1, true);
  }
  const dlg = modal({ title: category.kind === 'team' ? '导入人工小组分组' : '导入人工个人赛排序', width: 'min(1100px, 96vw)',
    body: h('div', h('p', '本模板用于录入人工已完成的分组/排序结果。系统不重新分组、不重新排序。'),
      h('p.small.muted', category.kind === 'team'
        ? '人员标识采用项目报名ID；当前三人赛以学校报名为分组单位，不拆分队内参赛人员。小组名称和人数以文件为准。'
        : '人员标识采用项目报名ID。排序号用于出场顺序，与成绩名次分开；允许跳号、并列及部分参赛人员不入榜。'),
      h('div.row', ...['xlsx', 'csv'].map(format => h('button.btn', { onclick: async () => {
        try { ensure(); await download(`${path}/template.${format}`, {}, `人工结果模板.${format}`, { isCurrent }); }
        catch (error) { dlg.showErrors(error); }
      } }, `下载 ${format.toUpperCase()} 模板`))),
      h('p.small.muted', '支持 .xlsx、.xls、.csv，最大 2 MB、2000 行；读取第一个工作表，首行为表头，忽略空行。'), file, report),
    buttons: [
      { label: '解析并预览', keepOpen: true, onClick: async () => {
        ensure();
        if (pending) throw new Error('请先核实原导入请求');
        const chosen = file.files?.[0];
        if (!chosen || chosen.size > 2 * 1024 * 1024) throw new Error('请选择不超过 2 MB 的文件');
        file.disabled = true;
        try {
          const bytes = new Uint8Array(await chosen.arrayBuffer());
          let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
          packet = { filename: chosen.name, file_base64: btoa(binary), event_identity: context.identity };
          preview = await api.post(path + '/preview', packet, { context });
          ensure(); Object.keys(actions).forEach(k => delete actions[k]); partial.checked = false;
          renderPreview(); dlg.setActionDisabled(1, false);
        } finally { file.disabled = false; }
      } },
      { label: pending ? '核实并重试原导入' : '确认导入', class: 'btn-primary', keepOpen: true, onClick: async () => {
        ensure();
        if (!pending) {
          if (!preview) throw new Error('请先解析并预览');
          if (preview.errors && !partial.checked) throw new Error('存在阻断性错误，请修正文件，或显式勾选仅导入有效行');
          if (!await confirmAsync('确认录入人工结果', `将按预览原值写入。${preview.errors ? `仅导入有效行，${preview.errors} 行错误不写入。` : ''}冲突行按所选覆盖/跳过处理。`, '确认写入')) return;
          ensure();
          const uid = newUid('manual-import');
          pending = { request_uid: uid, body: { ...packet, basis: preview.basis, file_hash: preview.file_hash, actions: { ...actions },
            allow_partial: partial.checked, request_uid: uid } };
          if (!writePendingRequest(key, pending, scope)) { pending = null; throw new Error('无法保存恢复请求，请检查浏览器存储'); }
        }
        file.disabled = true; partial.disabled = true;
        report.querySelectorAll('select').forEach(el => { el.disabled = true; });
        dlg.setActionDisabled(0, true);
        try { await send(); }
        catch (error) {
          if (!error.outcome_unknown) {
            removePendingRequest(key, scope); pending = null;
            preview = null; file.disabled = false; dlg.setActionDisabled(0, false); dlg.setActionDisabled(1, true);
          } else error.message = '导入结果待核实：请用同一按钮重试原导入；原请求已保存，不能另行提交。';
          throw error;
        }
      } },
    ], onClose: () => { closed = true; },
  });
  dlg.setActionDisabled(1, !pending); dlg.setActionDisabled(0, !!pending);
  if (pending) { file.disabled = true; report.append(h('p.warn-box', '有一份导入结果待核实，请重试原导入；不会再次执行已成功的写入。')); }
  return dlg;
}

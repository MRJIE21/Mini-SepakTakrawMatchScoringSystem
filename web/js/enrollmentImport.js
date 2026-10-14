/* 项目报名导入：文件或表格粘贴 → 服务端预览 → 确认导入 → 核对回执。 */
import { api, download, getApiEventContext, newUid } from './api.js';
import { h, field, textarea, formDialog, clear, table, task, toast, categoryLabel } from './ui.js';

export function openEnrollmentImport(cat, onSaved) {
  const identity = getApiEventContext();
  const source = textarea('', { rows: 8, placeholder: '粘贴含表头的报名表；支持逗号分隔的 CSV 和从 Excel 复制的表格' });
  source.dataset.field = 'csv_text';
  const file = h('input', { type: 'file', accept: '.csv,text/csv', 'aria-label': '选择报名 CSV 文件' });
  const report = h('div', { 'aria-live': 'polite' });
  let preview = null;
  let receipt = null;
  let requestUid = null;
  let fileTicket = 0;
  let closed = false;

  function ensureContext() {
    if (!identity || JSON.stringify(getApiEventContext()) !== JSON.stringify(identity)) {
      throw new Error('当前赛事已切换，请关闭此窗口并进入目标项目重新导入');
    }
  }
  function invalidate() {
    preview = null; receipt = null; requestUid = null;
    dlg.setActionDisabled(1, true);
    dlg.setActionDisabled(2, true);
    clear(report);
  }
  source.addEventListener('input', () => { fileTicket += 1; invalidate(); });
  file.addEventListener('change', async () => {
    const ticket = ++fileTicket;
    invalidate();
    const selected = file.files?.[0];
    if (!selected) return;
    try {
      if (selected.size > 2 * 1024 * 1024) throw new Error('文件超过 2 MB，请拆分后导入');
      const bytes = await selected.arrayBuffer();
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { text = new TextDecoder('gb18030', { fatal: true }).decode(bytes); }
      if (closed || ticket !== fileTicket) return;
      source.value = text;
      source.dispatchEvent(new Event('input', { bubbles: true }));
      dlg.clearErrors();
    } catch (err) { if (!closed && ticket === fileTicket) dlg.showErrors(err); }
  });

  function draw(data, imported = false) {
    clear(report);
    const summary = data.summary;
    report.append(h('h4', imported ? '导入回执' : '导入前核对'),
      h('div.stat-grid.mb',
        h('div.stat', h('b', String(summary.imported ?? summary.ready ?? 0)), imported ? '已导入' : '可导入'),
        h('div.stat', h('b', String(summary.skipped)), '已存在，跳过'),
        h('div.stat', h('b', String(summary.error)), '错误')),
      summary.error ? h('div.warn-box.mb', '请修正全部错误后重新预览；目前没有保存任何报名。') : null,
      h('div.table-scroll', table([
        { label: '原表行号', render: (r) => r.lines.join('、') },
        { label: '学校', key: 'school' }, { label: '运动员', key: 'athletes' },
        { label: '核对结果', key: 'message' },
      ], data.items)));
  }

  const dlg = formDialog({
    title: '批量导入名单与报名', subtitle: categoryLabel(cat, { withGroup: true }), width: 'min(960px, 96vw)',
    onClose: () => { closed = true; fileTicket += 1; },
    sections: [
      { title: '1. 准备报名表', body: h('div',
        h('button.btn.mb', { type: 'button', onclick: task(async () => {
          ensureContext();
          await download(`/api/categories/${cat.id}/enrollments/import-template.csv`);
        }) }, '下载本项目 CSV 模板'),
        h('div.small.muted.mb', cat.kind === 'team'
          ? '同一学校的队员放在多行，每队最多 6 人；队长栏仅一行填“是”。号码为 1—20，可留空待补充。'
          : '每行一位运动员，同校同个人项目限报 1 人。性别可填男/女；首次建档时运动员ID留空。'),
        field('选择 CSV 文件', file),
        field('报名表内容', source, { name: 'csv_text', hint: '也可从 Excel 复制含表头的表格。已报名且名单一致的项目会跳过；已有名单有差异时需先核对。' })) },
      { title: '2. 预览与核对', body: report },
    ],
    actions: [
      { label: '预览核对', busyLabel: '正在核对…', keepOpen: true, run: async () => {
        ensureContext();
        const text = source.value;
        preview = null; requestUid = null;
        dlg.setActionDisabled(1, true);
        source.disabled = true; file.disabled = true;
        try {
          const data = await api.post(`/api/categories/${cat.id}/enrollments/import-preview`,
            { csv_text: text, event_identity: identity });
          ensureContext();
          if (closed || source.value !== text) return;
          receipt = data;
          preview = { ...data, csv_text: text };
          draw(data);
          dlg.setActionDisabled(1, data.summary.error > 0 || data.summary.ready === 0);
          dlg.setActionDisabled(2, false);
        } finally { source.disabled = false; file.disabled = false; }
      } },
      { label: '确认导入', primary: true, busyLabel: '正在导入…', keepOpen: true, run: async () => {
        ensureContext();
        if (!preview || preview.csv_text !== source.value) throw new Error('请先预览并核对当前报名表');
        if (preview.summary.error || !preview.summary.ready) throw new Error('请修正错误，或核对已存在的报名');
        requestUid ||= newUid('import'); // 网络结果未知时沿用原标识和原预览，不重复写入。
        source.disabled = true; file.disabled = true;
        try {
          const data = await api.post(`/api/categories/${cat.id}/enrollments/import`, {
            csv_text: preview.csv_text, preview_hash: preview.preview_hash,
            request_uid: requestUid, event_identity: identity,
          });
          receipt = data;
          preview = null; requestUid = null;
          source.value = ''; file.value = '';
          draw(data, true);
          dlg.setActionDisabled(1, true);
          dlg.setActionDisabled(2, false);
          toast(`已导入 ${data.summary.imported} 项报名`, 'ok');
          if (JSON.stringify(getApiEventContext()) === JSON.stringify(identity)) await onSaved();
        } catch (err) {
          if (['import_preview_stale', 'import_invalid'].includes(err.code)) {
            preview = null; requestUid = null; dlg.setActionDisabled(1, true);
          }
          throw err;
        } finally { source.disabled = false; file.disabled = false; }
      } },
      { label: '下载核对回执', keepOpen: true, run: () => {
        if (!receipt) throw new Error('请先预览报名表');
        const cell = (value) => {
          const text = String(value ?? '');
          const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
          return `"${safe.replaceAll('"', '""')}"`;
        };
        const rows = [['原表行号', '学校', '运动员', '核对结果'],
          ...receipt.items.map((r) => [r.lines.join('、'), r.school, r.athletes, r.message])];
        const blob = new Blob(['\ufeff', rows.map((r) => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = h('a', { href: url, download: `报名导入回执_${cat.id}.csv` });
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
      } },
    ],
  });
  dlg.setActionDisabled(1, true);
  dlg.setActionDisabled(2, true);
  return dlg;
}

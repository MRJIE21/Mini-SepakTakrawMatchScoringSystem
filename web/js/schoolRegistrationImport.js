/* Validate imported rows before applying them to the current registration form. */
import { api, download, getApiEventContext, captureRequestContext } from './api.js';
import { h, field, textarea, formDialog, clear, table, task } from './ui.js';

export function openSchoolImport({ path, text = '', payload, onText, onApply, onConflict,
    requestContext = captureRequestContext(), signal, isCurrent = () => true }) {
  const identity = JSON.stringify(getApiEventContext());
  const source = textarea(text, { rows: 9, placeholder: '从 Excel 复制含表头的项目、运动员等列，或上传 CSV' });
  const file = h('input', { type: 'file', accept: '.csv,text/csv', 'aria-label': '学校报名 CSV 文件' });
  const report = h('div', { 'aria-live': 'polite' });
  let result = null, ticket = 0, closed = false;
  const alive = () => !closed && !signal?.aborted && isCurrent();
  const ensureContext = () => {
    if (!alive() || identity !== JSON.stringify(getApiEventContext())) throw new Error('页面已切换，请进入对应学校重新导入');
  };
  const invalidate = () => { if (!alive()) return; result = null; dlg.setActionDisabled(1, true); clear(report); onText(source.value); dlg.markClean(); };
  source.oninput = () => { ticket++; invalidate(); };
  file.onchange = async () => {
    const current = ++ticket, selected = file.files?.[0];
    result = null; dlg.setActionDisabled(1, true);
    if (!selected) return;
    try {
      if (selected.size > 2 * 1024 * 1024) throw new Error('文件超过 2 MB，请拆分');
      const bytes = await selected.arrayBuffer();
      let value;
      try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { value = new TextDecoder('gb18030', { fatal: true }).decode(bytes); }
      if (!alive() || ticket !== current) return;
      source.value = value; invalidate(); dlg.clearErrors();
    } catch (error) { if (alive() && ticket === current) dlg.showErrors(error); }
  };
  const dlg = formDialog({ title: '粘贴 / 导入学校报名表', width: 'min(960px, 96vw)',
    onClose: () => { closed = true; ticket++; },
    sections: [{ title: '准备表格', body: h('div',
      h('button.btn', { type: 'button', onclick: task(async () => { ensureContext(); await download(`${path}/registration-import-template.csv`, {}, '学校报名模板.csv', { isCurrent: alive }); }) }, '下载本校完整报名模板'),
      h('p.small.muted', '同一项目的所有队员放在多行。所列项目按表中的完整名单更新，未列项目保持原状；退出、不参加须明确填写。'),
      h('p.small.muted', '同名人员填写运动员ID复用；新增另一人时，ID留空、“同名新建确认”填是，并填写不同的区分信息。仅整理人员时项目留空。'),
      h('details.small.mt', h('summary', '表头与填写示例'),
        h('p', '常用列：学校、项目、姓名、性别、常用号码、项目号码、队长。姓名也可写“运动员”或“运动员姓名”；项目也可写“项目名称”。组别由当前学校确定，无须增加“组别”列。'),
        h('p', '三人赛：每位队员一行，项目号码填 1—20，队长只有一人填“是”。个人赛：每人一行，号码只填“常用号码”，项目号码和队长留空。'),
        h('p', '表中项目须填写本届实际项目名称；已有人员建议使用下载模板中的运动员ID。')),
      field('选择 CSV 文件', file), field('学校报名表内容', source, { name: 'csv_text' })) },
    { title: '核对导入结果', body: report }],
    actions: [{ label: '核对表格', keepOpen: true, run: async () => {
      ensureContext(); result = null; dlg.setActionDisabled(1, true);
      source.disabled = true; file.disabled = true;
      try {
        const data = await api.post(`${path}/registration-import-preview`, { ...payload, csv_text: source.value }, { context: requestContext, signal });
        if (!alive()) return;
        ensureContext(); clear(report);
        if (data.errors.length) {
          report.append(h('div.warn-box', '请修正全部错误后重新核对。当前没有修改报名表或保存正式报名。'),
            h('div.table-scroll', table([{ label: '原表行号', render: (r) => r.line ?? '整批校验' }, { label: '问题', key: 'message' }], data.errors)));
          return;
        }
        result = data;
        report.append(h('div.table-scroll', table([{ label: '原表行号', key: 'line' }, { label: '项目', key: 'project' }, { label: '人员', key: 'person' }, { label: '处理', key: 'message' }], data.items)),
          h('h4', '完整调整结果'), h('ul', ...data.review.changes.map((s) => h('li', s))));
        if (data.review.people_review.length) report.append(h('h4', '人员资料调整'), ...data.review.people_review.map((p) => h('p', `${p.name} · ${({ male: '男', female: '女', '': '性别待补' })[p.gender || '']} · 常用号码 ${p.jersey_no || '未填'} · ${p.note || '区分信息未填'}`)));
        for (const p of data.review.review) report.append(h('p', `${p.category_name}：${({ participate: '参加', unresolved: '尚未决定', withdrawn: '退出', not_participating: '不参加' })[p.choice]} · ${p.athlete_name || p.members.map((m) => `${m.name}（${m.jersey_no || '号码待补'}）`).join('、') || '无参赛名单'}${p.captain_name ? ` · 队长 ${p.captain_name}` : ''}${p.choice === 'participate' ? ` · 种子 ${p.seed_no || '未指定'} · ${p.note || '无报名备注'}` : ''}`));
        if (data.review.warnings.length) report.append(h('h4', '赛前待补充'), h('ul', ...data.review.warnings.map((w) => h('li', w.message))));
        report.append(h('p.small.muted', '应用到报名表后，请预览核对并整批提交。'));
        dlg.setActionDisabled(1, false);
      } catch (error) { if (alive()) { onConflict(error); throw error; } }
      finally { if (alive()) { source.disabled = false; file.disabled = false; } }
    } }, { label: '应用到报名表', primary: true, run: async () => {
      ensureContext(); if (!result) throw new Error('请先核对表格');
      onApply(result.model);
    } }] });
  dlg.setActionDisabled(1, true);
  return dlg;
}

/* Validate imported rows before applying them to the current registration form. */
import { api, download, getApiEventContext, captureRequestContext } from './api.js';
import { h, field, textarea, formDialog, clear, table, task } from './ui.js';

const FIELD_ROWS = [
  { column: '项目', rule: '本组别项目名称；“仅建人员”时留空；同项目每人一行', example: '男子三人赛' },
  { column: '参赛选择', rule: '参加 / 不参加 / 退出 / 尚未决定；留空等同参加', example: '参加' },
  { column: '运动员', rule: '三人赛每名队员一行（3—6 行）；个人赛一人；仅建人员必填', example: '张三' },
  { column: '性别', rule: '男 / 女；留空时按项目性别', example: '男' },
  { column: '常用号码', rule: '1—20 的整数，可留空', example: '7' },
  { column: '项目号码', rule: '1—20 的整数；仅三人赛填写', example: '7' },
  { column: '队长', rule: '只有一名队员填“是”', example: '是' },
  { column: '种子序号', rule: '三人赛可填一次正整数；个人赛不填', example: '5' }
];
const OPTIONAL_ROWS = [
  { column: '学校', rule: '可选；省略时按当前工作台学校导入', example: '中国人民大学' },
  { column: '项目ID', rule: '可选；项目名称不唯一时用', example: '1' },
  { column: '运动员ID', rule: '已有人员需精确匹配时填', example: '12' },
  { column: '同名新建确认', rule: '确认新增另一位同名人员时填“是”', example: '是' },
  { column: '区分信息', rule: '同名人员必填；用于区分不同人', example: '2 班' },
  { column: '报名备注', rule: '可选；写入项目报名备注', example: '队长兼教练' }
];
const EXAMPLE_COLUMNS = [
  { label: '项目', key: 'project' }, { label: '参赛选择', key: 'choice' }, { label: '运动员', key: 'person' },
  { label: '性别', key: 'gender' }, { label: '常用号码', key: 'usual' }, { label: '项目号码', key: 'jersey' },
  { label: '队长', key: 'captain' }, { label: '种子序号', key: 'seed' }
];
const EXAMPLE_ROWS = [
  { project: '男子三人赛', choice: '参加', person: '张三', gender: '男', usual: '7', jersey: '7', captain: '是', seed: '5' },
  { project: '男子三人赛', choice: '参加', person: '李四', gender: '男', usual: '8', jersey: '8', captain: '', seed: '' },
  { project: '男子三人赛', choice: '参加', person: '王五', gender: '男', usual: '9', jersey: '9', captain: '', seed: '' },
  { project: '男子个人赛', choice: '参加', person: '赵六', gender: '男', usual: '11', jersey: '', captain: '', seed: '' },
  { project: '女子三人赛', choice: '不参加', person: '', gender: '', usual: '', jersey: '', captain: '', seed: '' },
  { project: '女子个人赛', choice: '尚未决定', person: '', gender: '', usual: '', jersey: '', captain: '', seed: '' }
];

export function openSchoolImport({ path, text = '', payload, getPayload = () => payload, onText, onApply, onConflict,
    requestContext = captureRequestContext(), signal, isCurrent = () => true }) {
  const identity = JSON.stringify(getApiEventContext());
  const source = textarea(text, { rows: 9, placeholder: '从 Excel 复制含表头的项目、运动员等列，或上传 CSV' });
  const file = h('input', { type: 'file', accept: '.csv,text/csv', 'aria-label': '学校报名 CSV 文件' });
  const report = h('div', { 'aria-live': 'polite' });
  let result = null, reviewedPayload = null, ticket = 0, closed = false;
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
      h('div.toolbar',
        h('button.btn', { type: 'button', onclick: task(async () => { ensureContext(); await download(`${path}/registration-import-template.csv`, {}, '报名模板.csv', { isCurrent: alive }); }) }, '下载报名模板（8 列）'),
        h('button.btn', { type: 'button', onclick: task(async () => { ensureContext(); await download(`${path}/registration-import-guide.txt`, {}, '填写说明.txt', { isCurrent: alive }); }) }, '下载填写说明'),
        h('button.btn', { type: 'button', onclick: task(async () => { ensureContext(); await download(`${path}/registration-import-example.csv`, {}, '示例_报名表.csv', { isCurrent: alive }); }) }, '下载示例 CSV')),
      h('p.small.muted', '模板默认 8 列：项目、参赛选择、运动员、性别、常用号码、项目号码、队长、种子序号。三人赛一名队员一行；所列项目按表中的完整名单更新，未列项目保持原状。'),
      h('p.small.muted', '旧 14 列模板（含学校、项目ID、运动员ID、同名新建确认等）仍然兼容；示例 CSV 使用虚构人员，导入前请替换姓名或删除示例行。'),
      field('选择 CSV 文件', file), field('学校报名表内容', source, { name: 'csv_text' })) },
    { title: '字段说明（默认 8 列）', body: h('div',
      h('div.table-scroll', table([{ label: '列名', key: 'column' }, { label: '填写规则', key: 'rule' },
        { label: '示例', key: 'example' }], FIELD_ROWS)),
      h('h4', '可选的旧列'),
      h('div.table-scroll', table([{ label: '列名', key: 'column' }, { label: '填写规则', key: 'rule' },
        { label: '示例', key: 'example' }], OPTIONAL_ROWS)),
      h('h4', '填写示例'),
      h('div.table-scroll', table(EXAMPLE_COLUMNS, EXAMPLE_ROWS)),
      h('p.small.muted', '示例：三人赛张三/李四/王五各一行，队长只有一人填“是”，种子只填一次；个人赛只填常用号码；不参加与尚未决定不填人员。')) },
    { title: '核对导入结果', body: report }],
    actions: [{ label: '核对表格', keepOpen: true, run: async () => {
      ensureContext(); result = null; dlg.setActionDisabled(1, true);
      const current = ++ticket, snapshot = JSON.stringify(getPayload());
      source.disabled = true; file.disabled = true;
      try {
        const data = await api.post(`${path}/registration-import-preview`, { ...JSON.parse(snapshot), csv_text: source.value }, { context: requestContext, signal });
        if (!alive() || current !== ticket) return;
        ensureContext(); clear(report);
        if (snapshot !== JSON.stringify(getPayload())) throw new Error('报名内容已变化，请重新核对表格；当前输入已保留');
        if (data.errors.length) {
          report.append(h('div.warn-box', '请修正全部错误后重新核对。当前没有修改报名表或保存正式报名。'),
            h('div.table-scroll', table([{ label: '原表行号', render: (r) => r.line ?? '整批校验' }, { label: '问题', key: 'message' }], data.errors)));
          return;
        }
        result = data;
        reviewedPayload = snapshot;
        report.append(h('div.table-scroll', table([{ label: '原表行号', key: 'line' }, { label: '项目', key: 'project' }, { label: '人员', key: 'person' }, { label: '处理', key: 'message' }], data.items)),
          h('h4', '完整调整结果'), h('ul', ...data.review.changes.map((s) => h('li', s))));
        if (data.review.people_review.length) report.append(h('h4', '人员资料调整'), ...data.review.people_review.map((p) => h('p', `${p.name} · ${({ male: '男', female: '女', '': '性别待补' })[p.gender || '']} · 常用号码 ${p.jersey_no || '未填'} · ${p.note || '区分信息未填'}`)));
        for (const p of data.review.review) report.append(h('p', `${p.category_name}：${({ participate: '参加', unresolved: '尚未决定', withdrawn: '退出', not_participating: '不参加' })[p.choice]} · ${p.athlete_name || p.members.map((m) => `${m.name}（${m.jersey_no || '号码待补'}）`).join('、') || '无参赛名单'}${p.captain_name ? ` · 队长 ${p.captain_name}` : ''}${p.choice === 'participate' ? ` · 种子 ${p.seed_no || '未指定'} · ${p.note || '无报名备注'}` : ''}`));
        if (data.review.warnings.length) report.append(h('h4', '赛前待补充'), h('ul', ...data.review.warnings.map((w) => h('li', w.message))));
        report.append(h('p.small.muted', '应用到报名表后，请预览核对并整批提交。'));
        dlg.setActionDisabled(1, false);
      } catch (error) { if (alive() && current === ticket) { result = null; onConflict(error); throw error; } }
      finally { if (alive() && current === ticket) { source.disabled = false; file.disabled = false; } }
    } }, { label: '应用到报名表', primary: true, run: async () => {
      ensureContext(); if (!result) throw new Error('请先核对表格');
      if (reviewedPayload !== JSON.stringify(getPayload())) {
        result = null; dlg.setActionDisabled(1, true); clear(report);
        throw new Error('报名内容已变化，请重新核对表格；当前输入已保留');
      }
      onApply(result.model);
    } }] });
  dlg.setActionDisabled(1, true);
  return dlg;
}

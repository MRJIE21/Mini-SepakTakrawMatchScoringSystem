import { api, captureRequestContext } from './api.js';
import { h, field, textInput, formDialog, toast } from './ui.js';

export function normalizePersonName(value) {
  const name = String(value ?? '').trim();
  const message = !name ? '姓名不能为空，请输入 1–50 个字符'
    : [...name].length > 50 ? '姓名长度须为 1–50 个字符' : '';
  if (message) throw Object.assign(new Error(message), { detail: { fields: { name: message } } });
  return name;
}

export async function openPersonNameEditor({ id, schoolName, onSaved, requestContext = captureRequestContext(), isCurrent = () => true }) {
  // Read the current revision instead of saving against a stale list row.
  const { athlete } = await api.get(`/api/athletes/${id}`, { context: requestContext });
  if (!isCurrent()) return;
  const name = textInput(athlete.name, { placeholder: '请输入姓名', autocomplete: 'off', 'aria-label': '姓名' });
  return formDialog({
    title: '编辑人员信息', subtitle: `${schoolName} · 人员 #${athlete.id}`,
    width: 'min(520px, 94vw)',
    sections: [{ body: h('div', field('姓名', name, { name: 'name', required: true, hint: '去除首尾空格后须为 1–50 个字符' }),
      h('p.small.muted', '仅保存当前人员姓名，其他尚未提交的修改会保留。')) }],
    actions: [{ label: '保存', primary: true, busyLabel: '保存中…', run: async ({ close }) => {
      const value = normalizePersonName(name.value);
      let result;
      name.disabled = true;
      try { result = await api.put(`/api/athletes/${athlete.id}`, { name: value, base_rev: athlete.rev }, { context: requestContext }); }
      finally { name.disabled = false; }
      toast('保存成功', 'ok');
      close();
      // A successful write must not be reported as failed when a subsequent refresh fails.
      try { await onSaved(result.athlete); }
      catch (error) { if (!error.cancelled) toast(`保存成功，页面刷新失败：${error.message}。请重新读取页面。`, 'error'); }
    } }],
  });
}

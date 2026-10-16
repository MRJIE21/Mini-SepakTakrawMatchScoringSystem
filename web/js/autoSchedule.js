/* The existing schedule owns navigation and write recovery; this is its editor. */
import { h, clear, field, numberInput, dateTimeInput, table, toast, confirmAsync, loadingState } from './ui.js';

export function openAutoSchedule({ root, category, plan, venues, initialStage, event, client, previewRequest, isCurrent, onBack, onSaved }) {
  const section = h('section.auto-schedule', { 'aria-label': '自动编排赛程' }); clear(root); root.append(section);
  const alive = () => section.isConnected && isCurrent();
  let dirty = false, generating = false, saving = false, preview = null, previewInvalid = false;
  const path = `/api/categories/${category.id}/auto-schedule`;
  const canLeave = async () => !saving && (!dirty || await confirmAsync('有未保存的编排', '本次编排尚未保存。放弃修改并离开？', '放弃修改'));
  const heading = h('div.schedule-heading', h('div', h('h3', '自动编排赛程'), h('p.small.muted', '沿用已确认的阶段和分组，生成对阵并安排场地时间。')),
    h('button.btn', { onclick: async () => { if (await canLeave() && alive()) onBack(); } }, '返回赛程'));
  const steps = h('div.auto-steps', h('strong', '1　编排规则'), h('span.muted', '2　预览确认'));
  const errors = h('div.warn-box.hidden', { role: 'alert' }), body = h('div');
  section.append(heading, steps, errors, body); body.append(loadingState('正在读取编排规则…'));
  function error(message) { if (alive()) { errors.textContent = message; errors.classList.remove('hidden'); errors.scrollIntoView({ block: 'nearest' }); } }
  function clearError() { errors.textContent = ''; errors.classList.add('hidden'); }
  const stages = (plan?.stages || []).filter(s => s.params?.schedule_meta?.state === 'confirmed');
  let chosen = [], duration, rest, modeFill, modeReplan, venueEditors = [], form;
  function renderRules(config = null) {
    clearError(); clear(body); steps.replaceChildren(h('strong', '1　编排规则'), h('span.muted', '2　预览确认'));
    if (!stages.length || !venues.length) {
      body.append(h('div.panel', h('p.muted', !stages.length ? '请先确认分组并建立正式赛程阶段，再使用自动编排。' : '请先在赛事设置添加比赛场地。'))); return;
    }
    form = h('div.auto-rules');
    chosen = stages.map(s => ({ stage: s, input: h('input', { type: 'checkbox', checked: config?.stage_ids?.includes(s.id) ?? (initialStage ? initialStage === s.id : true) }) }));
    const choices = h('div.auto-choices', ...chosen.map(({ stage, input }) => h('label.auto-choice', input,
      h('span', stage.name, h('small.muted', stage.kind === 'round_robin' ? '补齐小组单循环' : '沿用已确认对阵')))));
    duration = numberInput(config?.duration_minutes ?? 30, { min: 1, max: 240, step: 1 });
    rest = numberInput(config?.rest_minutes ?? 30, { min: 1, max: 1440, step: 1 });
    const example = h('p.auto-hint');
    const clock = n => `${n >= 1440 ? '次日 ' : ''}${String(Math.floor(n / 60) % 24).padStart(2,'0')}:${String(n % 60).padStart(2,'0')}`;
    const updateExample = () => { const d = Number(duration.value), r = Number(rest.value);
      example.textContent = Number.isInteger(d) && d > 0 && Number.isInteger(r) && r > 0
        ? `09:00 开赛，预计 ${clock(540 + d)} 结束 → 同队下一场最早 ${clock(540 + d + r)} 开始。换场地也须满足休息。`
        : '预计比赛时长和最短休息必须为大于0的整数分钟。'; };
    duration.oninput = updateExample; rest.oninput = updateExample; updateExample();
    const venueBox = h('div.auto-venues'); venueEditors = [];
    const today = new Date(), date = event?.start_date || `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
    for (const venue of venues) {
      const previous = config?.windows?.filter(w => w.venue_id === venue.id);
      const checkbox = h('input', { type: 'checkbox', checked: config ? !!previous?.length : true });
      const windows = h('div.auto-windows'), entries = [];
      const editor = h('div.auto-venue');
      const add = (begin = `${date}T09:00`, end = `${date}T17:00`) => {
        const start = dateTimeInput(begin.replace(' ', 'T')), finish = dateTimeInput(end.replace(' ', 'T'));
        const entry = { start, finish }; entries.push(entry);
        const row = h('div.auto-window', field('开始时间', start), field('结束时间', finish), h('button.btn', {
          type: 'button', 'aria-label': `删除${venue.name}时段`, onclick: () => { entries.splice(entries.indexOf(entry), 1); row.remove(); dirty = true; },
        }, '删除'));
        windows.append(row);
      };
      editor.append(h('div.auto-venue-heading', h('label.auto-choice', checkbox, h('strong', venue.name)),
        h('button.btn.small', { type: 'button', onclick: () => { add(); dirty = true; } }, '添加时段')), windows);
      for (const w of previous?.length ? previous : [{ start: `${date}T09:00`, end: `${date}T17:00` }]) add(w.start, w.end);
      venueEditors.push({ venue, checkbox, entries }); venueBox.append(editor);
    }
    modeFill = h('input', { type: 'radio', name: `auto-mode-${category.id}`, checked: config?.mode !== 'replan' });
    modeReplan = h('input', { type: 'radio', name: `auto-mode-${category.id}`, checked: config?.mode === 'replan' });
    form.append(h('div.panel', h('h4', '编排范围'), choices, h('p.small.muted.mt', '阶段来源和名次范围在原阶段设置中维护，此处沿用。')),
      h('div.panel', h('h4', '比赛与休息'), h('div.form-grid', field('预计单场时长（分钟）', duration), field('同队最短休息（分钟）', rest)), example),
      h('div.panel', h('h4', '可用场地与时段'), h('p.small.muted', '每场比赛须在可用时段内完整结束；午休可分成两段设置。'), venueBox),
      h('div.panel', h('h4', '已有比赛如何处理'), h('label.auto-mode', modeFill, h('span', '保留已有安排，补齐未安排比赛', h('small.muted', '已有对阵复用；已知场地和时间保持。'))),
        h('label.auto-mode', modeReplan, h('span', '重新安排选定阶段中可调整的比赛', h('small.muted', '已领取、已开始及有成绩的比赛保持。')))),
      h('div.auto-footer', h('span.small.muted', '先生成预览，确认后才保存。单次最多500场待排，过大时请分阶段编排。'), h('button.btn.btn-primary', { onclick: generate }, '生成预览')));
    form.addEventListener('input', () => { dirty = true; }); form.addEventListener('change', () => { dirty = true; });
    body.append(form);
  }
  function values() {
    const stage_ids = chosen.filter(x => x.input.checked).map(x => x.stage.id);
    const duration_minutes = Number(duration.value), rest_minutes = Number(rest.value);
    if (!stage_ids.length) throw new Error('请选择要编排的阶段');
    if (!Number.isInteger(duration_minutes) || duration_minutes < 1 || duration_minutes > 240) throw new Error('预计单场时长须为1至240分钟');
    if (!Number.isInteger(rest_minutes) || rest_minutes < 1 || rest_minutes > 1440) throw new Error('同队最短休息须为1至1440分钟');
    const windows = venueEditors.filter(x => x.checkbox.checked).flatMap(x => x.entries.map(e => ({ venue_id: x.venue.id, start: e.start.value.replace('T',' '), end: e.finish.value.replace('T',' ') })));
    if (!windows.length) throw new Error('请勾选可用场地并填写时段');
    if (windows.some(w => !w.start || !w.end || w.end <= w.start)) throw new Error('每个时段的结束须晚于开始');
    return { stage_ids, duration_minutes, rest_minutes, windows, mode: modeReplan.checked ? 'replan' : 'fill' };
  }
  async function generate() {
    if (generating || saving) return;
    clearError(); let settings;
    try { settings = values(); } catch (e) { error(e.message); return; }
    dirty = true; generating = true;
    const buttons = [...form.querySelectorAll('button,input')]; buttons.forEach(b => { b.disabled = true; });
    const progress = h('div.auto-progress', { role: 'status' }, '正在生成对阵并核对场地、休息及晋级顺序…'); body.prepend(progress);
    try { const result = await previewRequest(path + '/preview', { settings });
      if (!alive()) return; preview = result; previewInvalid = false; renderPreview();
    } catch (e) { error(e.message); }
    finally { generating = false; progress.remove(); buttons.forEach(b => { b.disabled = false; }); }
  }
  function renderPreview() {
    clear(body); clearError(); steps.replaceChildren(h('span.muted', '1　编排规则'), h('strong', '2　预览确认'));
    const p = preview, unplaced = new Set(p.unplaced.map(r => r.id));
    body.append(h('div.panel', h('div.auto-summary', ...[
      [`${p.schedule.length - p.unplaced.length}场`, '本次已安排'], [`${p.new}场`, '新增对阵'], [`${p.kept}场`, '保留安排'], [`${p.settings.rest_minutes}分钟`, '同队最短休息'],
    ].map(([n,label]) => h('div', h('strong', n), h('span.small.muted', label)))),
    h(`div.${p.complete ? 'auto-success' : 'warn-box'}`, { role: 'status' }, p.complete ? '本次安排完整，场地、休息与晋级顺序核对通过。' : `${p.unplaced.length}场待安排：${p.reason}`),
    p.legacy_estimates ? h('p.small.muted.mt', `${p.legacy_estimates}场旧安排未标注预计时长，按本次${p.settings.duration_minutes}分钟估计占用。`) : null,
    h('p.small.muted.mt', `按预计时长编排，实际延误后可调整后续安排。预览${Math.round(p.expires_in / 60)}分钟内有效。`)));
    if (p.unplaced.length) body.append(h('div.panel', h('h4', '暂未安排的比赛'), ...p.unplaced.map(r => h('p.small', `${r.code} · ${r.stage} · ${r.home} 对 ${r.away}`)),
      h('p.small.muted', '可增加场地或可用时段，或缩小阶段范围后重新生成。休息规则不会自动缩短。')));
    body.append(h('div.panel', h('h4', '按时间核对比赛安排'), table([
      { label: '处理', render: r => `${r.action}${r.protected ? ' · 已保护' : ''}` },
      { label: '阶段', key: 'stage' }, { label: '对阵', render: r => h('div', h('b', r.code), h('div', `${r.home} 对 ${r.away}`)) },
      { label: '场地', key: 'venue' }, { label: '预计时间', render: r => unplaced.has(r.id) ? '待安排' : h('div', r.start || '待安排', h('div.small.muted', r.end ? `至 ${r.end}` : '')) },
      { label: '休息核对', render: r => unplaced.has(r.id) ? '待安排' : r.action === '保留' ? '固定占用保留' : `已预留≥${r.rest_minutes}分钟` },
    ], p.schedule, { responsive: true, class: 'auto-table' })));
    const saveButton = h('button.btn.btn-primary', { disabled: !p.complete, onclick: async () => {
      if (saving || previewInvalid) return;
      saving = true; saveButton.disabled = true; backButton.disabled = true; clearError();
      try { const result = await client.post(path + '/confirm', { preview_id: p.preview_id });
        dirty = false; if (alive()) { toast(result.message, 'ok'); onSaved(); }
      } catch (e) { if (['preview_changed','preview_expired'].includes(e.code)) previewInvalid = true; error(e.message); }
      finally { saving = false; saveButton.disabled = !p.complete || previewInvalid; backButton.disabled = false; }
    } }, p.complete ? (p.changed ? `确认并保存${p.changed}场安排` : '确认并保存编排规则') : '需调整规则后保存');
    const backButton = h('button.btn', { onclick: () => renderRules(p.settings) }, '返回修改规则');
    body.append(h('div.auto-footer', h('span.small.muted', '确认时将再次核对分组、场地占用和比赛状态。'), backButton, saveButton));
    section.scrollIntoView({ block: 'start' });
  }
  client.get(path).then(r => { if (alive()) renderRules(r.settings); }).catch(e => { if (alive()) { clear(body); error(e.message); } });
  return { canLeave, isDirty: () => dirty || saving };
}

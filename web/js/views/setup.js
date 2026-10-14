/* 赛事设置：赛事信息、参赛组别、比赛项目与场地。

   按改进方案 §3.3、§5.1 缩减职责：这里只负责“赛事 + 结构”，
   学校与名单在项目工作台的“报名名单”中维护，阶段与分组去“分组与编排”，
   不再保留第二套编辑逻辑（Q02）。首次引导只承担三件事：
   创建赛事、配置组别项目、进入首个项目，不声称此时已经可以开赛（Q01）。 */
import { api, captureRequestContext, readRequestOptions } from '../api.js';
import { registerView, state, loadStructure, reloadShell, go, replaceViewParams } from '../main.js';
import {
  h, field, textInput, selectInput, dateInput, toast, confirmAsync,
  clear, setFieldError,
} from '../ui.js';
import { PROJECT_PRESETS, existingProject, nameAfterChoice, participantLabel, setupSummary, venueOrder } from '../setupModel.js';

const canWrite = () => state.user.role === 'admin';
const SECTIONS = [
  ['event', '赛事资料'], ['structure', '组别与项目'], ['venues', '比赛场地'],
];

// 仅用于识别当前页面尚未提交的输入，不写入浏览器缓存。
const inputBaselines = new WeakMap();
const controlValue = control => ['radio', 'checkbox'].includes(control.type) ? control.checked : control.value;
function tracked(control) {
  inputBaselines.set(control, controlValue(control));
  return control;
}
function hasEdits(root) {
  return !!root && [...root.querySelectorAll('input,select,textarea')]
    .some(control => inputBaselines.has(control) && controlValue(control) !== inputBaselines.get(control));
}
function resetInput(control, value = '') {
  if (['radio', 'checkbox'].includes(control.type)) control.checked = !!value;
  else control.value = value ?? '';
  inputBaselines.set(control, controlValue(control));
}

function hierarchyStrip() {
  return h('div.hierarchy-strip', { 'aria-label': '赛事结构' },
    h('b', '赛事'), h('span', '›'), h('span', '组别'), h('span', '›'),
    h('span', '比赛项目'));
}

async function render({ el, params, refresh }) {
  if (params.action === 'new') {
    if (!canWrite()) {
      el.append(h('div.panel', h('h2', '新建赛事'),
        h('div.warn-box', '当前角色没有创建赛事的权限。')));
      return;
    }
    el.append(hierarchyStrip());
    el.append(renderCreateEvent(refresh, true));
    return;
  }
  if (!state.eventId) {
    el.append(h('div.panel', h('h2', '赛事设置'),
      h('div.info-box', '还没有赛事。请先创建赛事，再配置组别与项目。')));
    if (canWrite()) el.append(renderCreateEvent(refresh));
    else el.append(h('div.panel', h('div.small.muted', '请联系管理员创建赛事。')));
    return;
  }
  // 旧链接仍指向同一份结构维护界面，所选组别保持在地址中。
  const section = ['groups', 'categories'].includes(params.step) ? 'structure' : (params.step || 'event');
  const selectedEvent = state.eventId;
  const frozenReads = readRequestOptions();
  let structure = await loadStructure();
  if (!structure || structure.event.id !== selectedEvent) return;
  const context = captureRequestContext();
  let syncSettingsMetadata = () => {};
  const page = h('div.setup-page');
  const isCurrent = () => page.isConnected && state.eventId === selectedEvent
    && state.events.find(event => event.id === selectedEvent)?.uuid === structure.event.uuid;
  const eventName = h('span.setup-current-event', structure.event.name);
  let readQueue = Promise.resolve();
  const readStructure = () => {
    const nextRead = readQueue.then(async () => {
      if (!isCurrent()) throw Object.assign(new Error('已离开当前赛事设置'), { cancelled: true });
      const next = await api.get(`/api/events/${selectedEvent}/structure`, { ...frozenReads, context });
      if (!isCurrent()) throw Object.assign(new Error('已离开当前赛事设置'), { cancelled: true });
      if (next.event?.id !== selectedEvent || next.event?.uuid !== context.identity?.event_uuid
          || typeof next.event?.name !== 'string' || !Array.isArray(next.groups) || !Array.isArray(next.venues)
          || next.groups.some(group => !Number.isInteger(group?.id) || typeof group.name !== 'string'
            || !Array.isArray(group.categories) || group.categories.some(category => !Number.isInteger(category?.id) || typeof category.name !== 'string'))
          || next.venues.some(venue => !Number.isInteger(venue?.id) || typeof venue.name !== 'string')) {
        throw new Error('赛事设置读取不完整，请重新读取状态');
      }
      structure = next;
      state.structure = next;
      eventName.textContent = next.event.name;
      syncSettingsMetadata(next);
      return next;
    });
    readQueue = nextRead.catch(() => {});
    return nextRead;
  };
  const nav = h('nav.setup-page-nav', { 'aria-label': '赛事设置导航' });
  const sections = new Map();
  function locate(key) {
    const target = sections.get(key);
    const title = target?.querySelector('h3');
    if (!title?.isConnected) return;
    title.scrollIntoView({ block: 'start', behavior: 'auto' });
    title.focus({ preventScroll: true });
  }
  const statusNodes = new Map();
  for (const [index, [key, label]] of SECTIONS.entries()) {
    const status = h('span.setup-nav-status', { id: `setup-status-${key}` });
    statusNodes.set(key, status);
    nav.append(h('button.btn.setup-nav-choice', {
      'aria-label': label, 'aria-describedby': status.id,
      onclick: () => locate(key),
    }, h('span.setup-step-number', String(index + 1)), h('span', h('b', label), status)));
  }
  page.append(h('header.setup-page-head',
    h('div.setup-title-row', h('div', h('h2', eventName, ' · 赛事设置'),
      h('p.setup-intro', '设置赛事资料，开设比赛项目，再补充比赛场地。')),
      canWrite() ? h('button.btn', { onclick: () => go('setup', { action: 'new' }) }, '新建赛事') : null),
    h('div.setup-page-tools', nav,
      h('div.setup-page-description', canWrite()
        ? '各处单独保存，状态在编辑区显示。'
        : '赛事结构由管理员维护。'))));

  const eventPanel = renderEventStep(structure, async () => {
    const next = await readStructure();
    if (isCurrent()) await reloadShell(selectedEvent);
    return next;
  }, { context, isCurrent });
  const venuesPanel = canWrite() ? renderVenuesStep(structure, readStructure, { context, isCurrent }) : h('section.panel',
    h('h3', '3 · 比赛场地'), h('div.small.muted.mb', '场地由本赛事的所有组别和项目共用，可以后补。'),
    ...(structure.venues?.length ? structure.venues.map(venue => h('div', venue.name)) : [h('div.small.muted', '还没有场地')]));
  const structurePanel = canWrite() ? renderStructureSection(structure, params, readStructure, { context, isCurrent }) :
    h('section.panel', h('h3', '2 · 组别与项目'),
      h('p.small.muted', '各组分别报名和排名；比赛项目属于对应组别。'),
      ...structure.groups.map(group => h('section.setup-readonly-group', h('h4', group.name),
          ...(group.categories.length ? group.categories.map(category => h('div', category.name, ' · ', participantLabel(category))) : [h('div.small.muted', '该组别还没有项目')]))));
  syncSettingsMetadata = nextStructure => {
    eventPanel.updateMetadata?.(nextStructure);
    structurePanel.updateMetadata?.(nextStructure);
    venuesPanel.updateMetadata?.(nextStructure);
    const summary = setupSummary(nextStructure);
    for (const [key, status] of statusNodes) status.textContent = summary[key];
  };
  for (const [key, panel, className] of [
    ['event', eventPanel, 'setup-basic-panel'], ['venues', venuesPanel, 'setup-venues-panel'],
    ['structure', structurePanel, 'setup-structure-section'],
  ]) {
    panel.id = `setup-${key}`;
    panel.classList.add(className);
    const title = panel.querySelector('h3');
    if (title) title.tabIndex = -1;
    sections.set(key, panel);
  }
  syncSettingsMetadata(structure);
  page.append(h('div.setup-body', eventPanel, structurePanel, venuesPanel));
  el.append(page);
  if (params.step && sections.has(section)) requestAnimationFrame(() => { if (el.isConnected) locate(section); });
}

/* 写入与列表同步分开：写入确认后重试只读；未知结果先核对后台。 */
function mutationFeedback(host, isCurrent = () => host.isConnected) {
  const message = h('span');
  const retry = h('button.btn', { onclick: recover }, '重新读取状态');
  retry.hidden = true;
  const line = h('div.setup-save-feedback', { role: 'status', 'aria-live': 'polite' }, message, retry);
  host.append(line);
  let busy = false, waiting = false, task = null, response, acknowledged = false;
  function controls() {
    for (const control of task?.controls || []) control.disabled = busy || waiting;
    task?.changed?.();
  }
  function show(text, error = false) {
    message.textContent = text;
    line.classList.toggle('setup-feedback-error', error);
    line.setAttribute('role', error ? 'alert' : 'status');
    retry.hidden = !waiting;
    retry.disabled = busy;
  }
  host.addEventListener('input', () => {
    if (!busy && !waiting) show(hasEdits(host) ? '有未保存的修改' : '');
  });
  async function complete() {
    const fresh = await task.read();
    if (!isCurrent()) return;
    if (!acknowledged) {
      const found = task.reconcile?.(fresh);
      if (!found) {
        waiting = false;
        show('已重新读取，未找到本次提交结果。请核对输入后再提交。', true);
        return;
      }
      response = found === true ? {} : found;
      acknowledged = true;
    }
    await task.saved?.(response, fresh);
    waiting = false;
    show(task.success + (hasEdits(host) ? '；还有未保存的修改' : ''));
    toast(task.success, 'ok');
  }
  async function recover() {
    if (busy || !waiting || !isCurrent()) return;
    busy = true; controls(); show('正在重新读取…');
    try { await complete(); }
    catch (error) { if (isCurrent()) show(`${acknowledged ? '已保存，列表待同步' : '保存结果尚未确认'}：${error.message}`, true); }
    finally { busy = false; controls(); retry.disabled = false; }
  }
  return {
    get blocked() { return busy || waiting; },
    clear() { if (!busy && !waiting) show(''); },
    async run(nextTask) {
      if (busy || waiting || !isCurrent()) return;
      task = nextTask; busy = true; acknowledged = false; controls(); show('正在保存…');
      try {
        response = await task.request();
        acknowledged = true;
        if (!isCurrent()) { toast(task.success, 'ok'); return; }
        await complete();
      } catch (error) {
        if (!isCurrent()) return;
        waiting = acknowledged || !!error.outcome_unknown;
        show(waiting ? `${acknowledged ? '已保存，列表待同步' : '保存结果尚未确认，请先重新读取状态'}：${error.message}` : error.message, true);
      } finally { busy = false; controls(); retry.disabled = false; }
    },
  };
}

/* ------------------------------------------------------------------ 创建赛事 */
function renderCreateEvent(refresh, standalone = false) {
  const draft = { event: { name: '', start_date: '', end_date: '', location: '' },
    groups: [], venues: [] };
  const labels = ['赛事信息', '组别', '比赛项目', '比赛场地', '确认创建'];
  let step = 0;
  const root = h('div.event-wizard');
  const panel = h('div.panel',
    h('div.panel-head', h('div', h('h2', standalone ? '新建赛事' : '创建首个赛事'),
      h('div.small.muted', '按顺序完成设置，最终确认前不会创建赛事或数据库。')),
    standalone ? h('button.btn', { onclick: () => go('dashboard') }, '取消') : null), root);
  draw();
  return panel;

  function draw() {
    clear(root);
    root.append(h('ol.wizard-steps', ...labels.map((label, index) => h('li', {
      class: index === step ? 'active' : index < step ? 'done' : '',
    }, h('span', index < step ? '✓' : String(index + 1)), h('b', label)))));
    const content = h('section.wizard-content');
    root.append(content);
    if (step === 0) drawEvent(content);
    else if (step === 1) drawGroups(content);
    else if (step === 2) drawCategories(content);
    else if (step === 3) drawVenues(content);
    else drawReview(content);
  }

  function actions(next, opts = {}) {
    return h('div.wizard-actions',
      step ? h('button.btn', { onclick: () => { step -= 1; draw(); } }, '上一步') : null,
      h('button.btn.btn-primary', { onclick: next }, opts.label || '下一步'));
  }

  function errorLine() { return h('div.field-error.hidden.wizard-error'); }
  function fail(slot, message, control) {
    slot.textContent = message; slot.classList.remove('hidden');
    if (control) control.focus();
  }

  function drawEvent(content) {
    const name = textInput(draft.event.name, { placeholder: '请输入赛事名称' });
    const start = dateInput(draft.event.start_date);
    const end = dateInput(draft.event.end_date);
    const locationInput = textInput(draft.event.location, { placeholder: '请输入比赛地点（可选）' });
    const error = errorLine();
    content.append(h('h3', '第 1 步 · 赛事信息'),
      h('div.form-grid', field('赛事名称', name, { required: true }), field('开始日期', start),
        field('结束日期', end), field('比赛地点', locationInput)), error,
      actions(() => {
        if (!name.value.trim()) return fail(error, '请填写赛事名称', name);
        if (start.value && end.value && start.value > end.value) {
          return fail(error, '开始日期不能晚于结束日期', end);
        }
        draft.event = { name: name.value.trim(), start_date: start.value,
          end_date: end.value, location: locationInput.value.trim() };
        step += 1; draw();
      }));
  }

  function drawGroups(content) {
    const rows = h('div.wizard-list');
    const error = errorLine();
    const renderRows = () => {
      clear(rows);
      draft.groups.forEach((group, index) => {
        const name = textInput(group.name, { placeholder: '请输入组别名称' });
        const code = textInput(group.code, { placeholder: '请输入组别标识（可选）' });
        name.oninput = () => { group.name = name.value; };
        code.oninput = () => { group.code = code.value; };
        rows.append(h('div.wizard-row', h('b.row-number', String(index + 1)),
          field('组别名称', name, { required: true }), field('组别标识', code),
          h('button.btn.btn-danger.small', { onclick: () => { draft.groups.splice(index, 1); renderRows(); } }, '删除')));
      });
      if (!draft.groups.length) rows.append(h('div.empty-inline', '尚未添加组别'));
    };
    renderRows();
    content.append(h('h3', '第 2 步 · 组别'),
      h('div.small.muted.mb', '添加赛事包含的组别；每个组别分别配置比赛项目。'), rows,
      h('button.btn', { onclick: () => { draft.groups.push({ name: '', code: '', categories: [] }); renderRows(); } }, '添加组别'),
      error, actions(() => {
        const names = draft.groups.map((group) => group.name.trim());
        if (!names.length) return fail(error, '请至少添加一个组别');
        if (names.some((name) => !name)) return fail(error, '请填写所有组别名称');
        if (new Set(names).size !== names.length) return fail(error, '组别名称不能重复');
        draft.groups.forEach((group, index) => { group.name = group.name.trim(); group.code = group.code.trim() || `G${index + 1}`; });
        if (new Set(draft.groups.map((group) => group.code)).size !== draft.groups.length) {
          return fail(error, '组别标识不能重复');
        }
        step += 1; draw();
      }));
  }

  function drawCategories(content) {
    const list = h('div.wizard-list');
    const error = errorLine();
    const renderList = () => {
      clear(list);
      draft.groups.forEach((group) => {
        const items = h('div.project-list');
        const renderItems = () => {
          clear(items);
          group.categories.forEach((category, index) => {
            const name = textInput(category.name, { placeholder: '请输入比赛项目名称' });
            const gender = selectInput([['', '请选择性别'], ['male', '男子'], ['female', '女子']], category.gender);
            const kind = selectInput([['', '请选择项目类型'], ['team', '三人赛'], ['individual', '个人赛']], category.kind);
            name.oninput = () => { category.name = name.value; };
            gender.onchange = () => { category.gender = gender.value; };
            kind.onchange = () => { category.kind = kind.value; };
            items.append(h('div.wizard-row.project-row', field('项目名称', name, { required: true }),
              field('性别', gender, { required: true }), field('项目类型', kind, { required: true }),
              h('button.btn.btn-danger.small', { onclick: () => { group.categories.splice(index, 1); renderItems(); } }, '删除')));
          });
          if (!group.categories.length) items.append(h('div.empty-inline', '尚未添加比赛项目'));
        };
        renderItems();
        list.append(h('section.group-projects', h('div.panel-head', h('h4', group.name),
          h('button.btn.small', { onclick: () => {
            group.categories.push({ name: '', gender: '', kind: '' }); renderItems();
          } }, '添加比赛项目')), items));
      });
    };
    renderList();
    content.append(h('h3', '第 3 步 · 比赛项目'),
      h('div.small.muted.mb', '逐个组别添加项目，并明确项目名称、性别和类型。'), list, error,
      actions(() => {
        for (const group of draft.groups) {
          if (!group.categories.length) return fail(error, `请为「${group.name}」添加比赛项目`);
          if (group.categories.some((category) => !category.name.trim() || !category.gender || !category.kind)) {
            return fail(error, `请完整填写「${group.name}」的项目信息`);
          }
          const keys = group.categories.map((category) => `${category.gender}:${category.kind}`);
          if (new Set(keys).size !== keys.length) return fail(error, `「${group.name}」内同性别、同类型的项目不能重复`);
          group.categories.forEach((category) => { category.name = category.name.trim(); });
        }
        step += 1; draw();
      }));
  }

  function drawVenues(content) {
    const rows = h('div.wizard-list');
    const error = errorLine();
    const renderRows = () => {
      clear(rows);
      draft.venues.forEach((venue, index) => {
        const name = textInput(venue.name, { placeholder: '请输入比赛场地名称' });
        name.oninput = () => { venue.name = name.value; };
        rows.append(h('div.wizard-row.venue-row', h('b.row-number', String(index + 1)),
          field('比赛场地名称', name, { required: true }),
          h('button.btn.btn-danger.small', { onclick: () => { draft.venues.splice(index, 1); renderRows(); } }, '删除')));
      });
      if (!draft.venues.length) rows.append(h('div.empty-inline', '暂不设置比赛场地，可在赛事创建后补充'));
    };
    renderRows();
    content.append(h('h3', '第 4 步 · 比赛场地'),
      h('div.small.muted.mb', '比赛场地为可选项，可按实际使用数量添加。'), rows,
      h('button.btn', { onclick: () => { draft.venues.push({ name: '' }); renderRows(); } }, '添加比赛场地'),
      error, actions(() => {
        const names = draft.venues.map((venue) => venue.name.trim());
        if (names.some((name) => !name)) return fail(error, '请填写已添加的比赛场地名称');
        if (new Set(names).size !== names.length) return fail(error, '比赛场地名称不能重复');
        draft.venues.forEach((venue) => { venue.name = venue.name.trim(); });
        step += 1; draw();
      }));
  }

  function drawReview(content) {
    const error = errorLine();
    const createButton = h('button.btn.btn-primary', { onclick: create }, '确认并创建赛事');
    content.append(h('h3', '第 5 步 · 确认创建'),
      h('div.review-block', h('h4', '赛事信息'), h('b', draft.event.name),
        h('div.small.muted', [draft.event.start_date, draft.event.end_date].filter(Boolean).join(' 至 ') || '未设置日期'),
        h('div.small.muted', draft.event.location || '未设置比赛地点')),
      h('div.review-block', h('h4', '组别与比赛项目'), ...draft.groups.map((group) =>
        h('div.review-group', h('b', group.name), h('div.small', group.categories.map((category) =>
          `${category.gender === 'male' ? '男子' : '女子'} · ${category.name}`).join('、'))))),
      h('div.review-block', h('h4', '比赛场地'), h('div', draft.venues.length
        ? draft.venues.map((venue) => venue.name).join('、') : '暂未设置')),
      h('div.info-box', '确认后将创建赛事及其独立数据库。'), error,
      h('div.wizard-actions', h('button.btn', { onclick: () => { step -= 1; draw(); } }, '上一步'), createButton));

    async function create() {
      createButton.disabled = true; createButton.textContent = '正在创建…';
      try {
        const res = await api.post('/api/events/full', draft);
        await reloadShell(res.event_id);
        toast('赛事及项目结构已创建', 'ok');
        location.hash = `#/workspace?event=${res.event_id}&group=${res.group_id}&category=${res.category_id}&tab=overview`;
        refresh();
      } catch (e) {
        fail(error, e.message || '创建失败');
        createButton.disabled = false; createButton.textContent = '确认并创建赛事';
      }
    }
  }
}

/* ------------------------------------------------------------------ 1 赛事信息 */
function renderEventStep(initialStructure, reload, { context, isCurrent }) {
  let ev = initialStructure.event;
  const facts = h('dl.setup-facts');
  const summaryName = h('dd'), summaryDates = h('dd'), summaryLocation = h('dd');
  facts.append(h('div', h('dt', '赛事名称'), summaryName),
    h('div', h('dt', '比赛日期'), summaryDates), h('div', h('dt', '比赛地点'), summaryLocation));
  const editButton = canWrite() ? h('button.btn', { onclick: () => {
    editor.classList.remove('hidden'); facts.classList.add('hidden'); editButton.classList.add('hidden'); name.focus();
  } }, '修改资料') : null;
  const panel = h('section.panel',
    h('div.panel-head', h('div', h('h3', '1 · 赛事资料'),
      h('p.setup-section-hint', '说明这场赛事的名称、时间和比赛地点。')), editButton), facts);
  let editor, name, start, end, loc, feedback;
  const controls = [], keys = ['name', 'start_date', 'end_date', 'location'];
  if (canWrite()) {
    name = tracked(textInput(ev.name, { placeholder: '例如：首都高校藤球比赛', 'aria-label': '赛事名称' }));
    start = tracked(dateInput(ev.start_date)); end = tracked(dateInput(ev.end_date));
    loc = tracked(textInput(ev.location, { placeholder: '例如：学校体育馆' }));
    controls.push(name, start, end, loc);
    const nameField = field('赛事名称', name, { required: true, name: 'name' });
    const startField = field('开始日期（可选）', start, { name: 'start_date' });
    const endField = field('结束日期（可选）', end, { name: 'end_date' });
    const locationField = field('比赛地点（可选）', loc, { name: 'location', hint: '填写场馆或地点；具体的 1 号场、2 号场在“比赛场地”中设置。' });
    nameField.classList.add('setup-event-name'); locationField.classList.add('setup-event-location');
    const fields = [nameField, startField, endField, locationField];
    const cancel = h('button.btn', { onclick: async () => {
      if (feedback.blocked) return;
      if (hasEdits(editor) && !await confirmAsync('取消修改赛事资料', '放弃这次尚未保存的输入？', '放弃修改')) return;
      controls.forEach((control, index) => resetInput(control, ev[keys[index]]));
      fields.forEach(wrap => setFieldError(wrap, ''));
      editor.classList.add('hidden'); facts.classList.remove('hidden'); editButton.classList.remove('hidden');
      feedback.clear(); editButton.focus();
    } }, '取消');
    const saveButton = h('button.btn.btn-primary', { onclick: async () => {
      if (feedback.blocked) return;
      fields.forEach(wrap => setFieldError(wrap, ''));
      if (!name.value.trim()) { setFieldError(nameField, '请填写赛事名称'); name.focus(); return; }
      if (start.value && end.value && start.value > end.value) {
        setFieldError(endField, '结束日期不能早于开始日期'); end.focus(); return;
      }
      const submitted = controls.map(control => control.value);
      const payload = { name: name.value.trim(), start_date: start.value, end_date: end.value, location: loc.value.trim() };
      await feedback.run({
        controls: [saveButton, cancel],
        request: () => api.put(`/api/events/${ev.id}`, payload, { context }), read: reload,
        reconcile: next => keys.every(key => (next.event[key] || '') === payload[key]),
        saved: (_result, next) => {
          ev = next.event;
          controls.forEach((control, index) => {
            const value = ev[keys[index]] || '';
            if (control.value === submitted[index]) control.value = value;
            inputBaselines.set(control, value);
          });
          if (!hasEdits(editor)) {
            editor.classList.add('hidden'); facts.classList.remove('hidden'); editButton.classList.remove('hidden');
          }
        }, success: '赛事资料已保存',
      });
    } }, '保存赛事资料');
    editor = h('div.setup-event-editor.hidden', h('div.form-grid', ...fields), h('div.row.mt', saveButton, cancel));
    panel.append(editor);
    feedback = mutationFeedback(panel, isCurrent);
  }
  panel.updateMetadata = next => {
    ev = next.event;
    summaryName.textContent = ev.name;
    summaryDates.textContent = [ev.start_date, ev.end_date].filter(Boolean).join(' 至 ') || '待补充（可后补）';
    summaryLocation.textContent = ev.location || '待补充（可后补）';
    controls.forEach((control, index) => {
      if (control.value === inputBaselines.get(control)) resetInput(control, ev[keys[index]]);
    });
  };
  panel.updateMetadata(initialStructure);
  return panel;
}

function errorHint() {
  return h('div.warn-box', '当前赛事不在可访问列表中，请从顶栏重新选择赛事。');
}

/* ------------------------------------------------------------------ 组别与项目 */
function renderStructureSection(initialStructure, params, readStructure, { context, isCurrent }) {
  let structure = initialStructure;
  let activeId = structure.groups.find(item => item.id === Number(params.group))?.id || structure.groups[0]?.id;
  let pending = 0, projects = null;
  const choices = h('div.setup-group-choices');
  const projectHost = h('div.setup-project-host');
  const groupList = h('section.setup-group-list', { 'aria-label': '组别列表' });
  const newName = tracked(textInput('', { placeholder: '例如：甲组', 'aria-label': '组别名称' }));
  const newCode = tracked(textInput('', { placeholder: '例如：甲', 'aria-label': '组别标识' }));
  const nameField = field('组别名称', newName, { required: true });
  const codeField = field('组别标识', newCode, { required: true, hint: '用于区分组别，在本赛事内不能重复。' });
  const addForm = h('div.setup-add-form.hidden', h('h4', '添加组别'), h('div.form-grid', nameField, codeField));
  const addButton = h('button.btn.btn-primary', { onclick: addGroup }, '保存新组别');
  const cancelGroup = h('button.btn', { onclick: async () => {
    if (addFeedback.blocked) return;
    if (hasEdits(addForm) && !await confirmAsync('取消添加组别', '放弃这次尚未保存的输入？', '放弃修改')) return;
    resetInput(newName); resetInput(newCode); addForm.classList.add('hidden'); addFeedback.clear();
  } }, '取消');
  addForm.append(h('div.row.mt', addButton, cancelGroup));
  const addFeedback = mutationFeedback(addForm, isCurrent);
  groupList.append(h('div.panel-head', h('h4', '选择组别'),
    h('button.btn.small', { onclick: () => { addFeedback.clear(); addForm.classList.remove('hidden'); newName.focus(); } }, '添加组别')),
    choices, addForm);
  const root = h('section.panel', h('div.panel-head', h('div', h('h3', { tabindex: -1 }, '2 · 组别与比赛项目'),
    h('p.setup-section-hint', '先选择组别，再为该组开设比赛项目。各组分别报名、比赛和排名。'))),
    h('div.setup-structure-grid', groupList, projectHost));
  root.updateMetadata = next => {
    structure = next;
    if (!activeGroup()) { activateGroup(structure.groups[0]?.id); return; }
    drawChoices(); projects?.updateMetadata(activeGroup());
  };
  drawChoices(); activateGroup(activeId, false);
  if (Number(params.group) && Number(params.group) !== activeId && isSetupRoute()
      && new URLSearchParams(location.hash.split('?')[1] || '').get('group') === String(params.group)) {
    replaceViewParams({ group: activeId || null });
  }
  return root;

  function activeGroup() { return structure.groups.find(item => item.id === activeId); }
  function isSetupRoute() { return location.hash.replace(/^#\/?/, '').split('?')[0] === 'setup'; }
  function drawChoices() {
    clear(choices);
    for (const group of structure.groups) {
      choices.append(h('button.setup-group-choice', {
        'aria-current': group.id === activeId ? 'true' : null,
        class: group.id === activeId ? 'active' : '',
        disabled: pending > 0 || addFeedback.blocked || !!projects?.blocked(),
        onclick: () => chooseGroup(group.id),
      }, h('b', group.name), h('span.small.muted', `${group.categories.length} 个项目`)));
    }
    if (!structure.groups.length) {
      choices.append(h('p.small.muted', '还没有组别。先添加一个组别，再开设项目。'));
      addForm.classList.remove('hidden');
    }
  }
  function activateGroup(id, writeUrl = true) {
    activeId = id; clear(projectHost);
    const group = activeGroup(); projects = group ? makeProjects(group) : null;
    projectHost.append(projects ? projects.panel : h('div.setup-category-list', h('h4', '比赛项目'),
      h('p.setup-section-hint', '例如：实验赛 → 甲组 → 男子三人赛。添加组别后，即可选择该组要开设的项目。')));
    drawChoices();
    if (writeUrl && root.isConnected && isSetupRoute()) replaceViewParams({ step: 'structure', group: activeId || null });
  }
  async function chooseGroup(id) {
    if (id === activeId || !isCurrent()) return;
    if (pending || addFeedback.blocked || projects?.blocked()) { toast('请先完成保存或重新读取状态', 'error'); return; }
    if (projects && hasEdits(projects.panel) && !await confirmAsync('切换组别',
        '当前组别有尚未保存的修改。切换后将放弃这些输入，已保存的数据不受影响。', '放弃并切换')) return;
    activateGroup(id);
    choices.querySelector('[aria-current="true"]')?.focus();
  }
  async function latestStructure() { return readStructure(); }
  async function mutate(action) {
    pending += 1; drawChoices();
    try { return await action(); } finally { pending -= 1; drawChoices(); }
  }
  async function addGroup() {
    if (addFeedback.blocked) return;
    setFieldError(nameField, ''); setFieldError(codeField, '');
    if (!newName.value.trim()) { setFieldError(nameField, '请填写组别名称'); newName.focus(); return; }
    if (!newCode.value.trim()) { setFieldError(codeField, '请填写组别标识'); newCode.focus(); return; }
    const payload = { name: newName.value.trim(), code: newCode.value.trim() };
    const submitted = [newName.value, newCode.value];
    await mutate(() => addFeedback.run({
      controls: [addButton, cancelGroup, newName, newCode], changed: drawChoices,
      request: () => api.post(`/api/events/${structure.event.id}/groups`, payload, { context }), read: latestStructure,
      reconcile: next => { const found = next.groups.find(g => g.code === payload.code && g.name === payload.name); return found && { group_id: found.id }; },
      saved: result => {
        [newName, newCode].forEach((control, index) => { if (control.value === submitted[index]) resetInput(control); });
        addForm.classList.add('hidden');
        if (!projects || !hasEdits(projects.panel)) activateGroup(result.group_id);
      }, success: '组别已添加，请配置该组的比赛项目',
    }));
  }

  function makeProjects(initialGroup) {
    let group = initialGroup, selected = null, generatedName = '';
    const rows = new Map();
    const title = h('h4', `${group.name}的比赛项目`);
    const hierarchy = h('p.setup-section-hint', { 'aria-label': '赛事结构示例' });
    const groupName = tracked(textInput(group.name, { 'aria-label': '组别名称' }));
    const groupField = field('组别名称', groupName, { required: true });
    const editorTitle = h('h4', `编辑${group.name}`);
    const groupEditor = h('div.setup-group-editor.hidden', editorTitle,
      h('p.small.muted', `组别标识：${group.code}`), groupField);
    const saveGroupButton = h('button.btn.btn-primary', { onclick: saveGroup }, '保存组别名称');
    const deleteGroupButton = h('button.btn.btn-danger', { onclick: deleteGroup }, '删除组别');
    const cancelEditGroup = h('button.btn', { onclick: async () => {
      if (groupFeedback.blocked) return;
      if (hasEdits(groupEditor) && !await confirmAsync('取消编辑组别', '放弃这次尚未保存的输入？', '放弃修改')) return;
      resetInput(groupName, group.name); groupEditor.classList.add('hidden'); groupFeedback.clear();
    } }, '取消');
    groupEditor.append(h('div.row.mt', saveGroupButton, cancelEditGroup, deleteGroupButton),
      h('p.small.muted', '只有未包含项目和学校的组别才能删除。'));
    const groupFeedback = mutationFeedback(groupEditor, isCurrent);
    const addToggle = h('button.btn', { onclick: () => {
      categoryFeedback.clear();
      addForm.classList.remove('hidden'); [...presetControls.values()].find(radio => !radio.disabled)?.focus();
    } }, '添加项目');
    const panel = h('div.setup-category-list', { 'aria-label': `${group.name}比赛项目` },
      h('div.panel-head', h('div', title, hierarchy), h('div.row.tight',
        h('button.btn.small', { onclick: () => { groupEditor.classList.remove('hidden'); groupName.focus(); } }, '编辑组别'), addToggle)), groupEditor);
    const list = h('div.setup-project-list');
    const empty = h('p.setup-section-hint', '该组别还没有项目。点击“添加项目”选择要开设的比赛。');
    list.append(empty);
    const name = tracked(textInput('', { placeholder: '选择项目后自动生成，可自行修改', 'aria-label': '项目名称', disabled: true }));
    const nameField = field('项目名称', name, { required: true });
    const preview = h('p.setup-create-preview', { 'aria-live': 'polite' });
    const hint = h('p.small.muted');
    const presetControls = new Map();
    const presetLabels = new Map();
    const options = h('fieldset.setup-preset-fieldset', h('legend', '选择要开设的比赛项目'),
      h('p.setup-section-hint', '三人赛记录逐分过程；个人赛录入最终成绩。已添加的项目无需重复开设。'));
    const presetGrid = h('div.setup-preset-grid');
    for (const preset of PROJECT_PRESETS) {
      const radio = tracked(h('input', { type: 'radio', name: `setup-preset-${group.id}`, value: preset.key, 'aria-label': preset.name }));
      const detail = h('span.small.muted', preset.hint);
      const label = h('label.setup-preset-choice', radio, h('span', h('b', preset.name), detail));
      radio.addEventListener('change', () => {
        selected = preset;
        const next = nameAfterChoice(name.value, generatedName, preset);
        name.value = next.value; generatedName = next.generated;
        setFieldError(nameField, ''); updateHint();
      });
      presetControls.set(preset.key, radio); presetLabels.set(preset.key, { label, detail }); presetGrid.append(label);
    }
    options.append(presetGrid);
    const addCategoryButton = h('button.btn.btn-primary', { onclick: addCategory, disabled: true }, '确认添加项目');
    const cancelAdd = h('button.btn', { onclick: async () => {
      if (categoryFeedback.blocked) return;
      if (hasEdits(addForm) && !await confirmAsync('取消添加项目', '放弃这次尚未保存的输入？', '放弃修改')) return;
      resetComposer(); addForm.classList.add('hidden'); categoryFeedback.clear(); addToggle.focus();
    } }, '取消');
    const addForm = h('div.setup-add-form.hidden', options, nameField, preview, hint, h('div.row.mt', addCategoryButton, cancelAdd));
    panel.append(list, addForm);
    const categoryFeedback = mutationFeedback(addForm, isCurrent);
    name.addEventListener('input', updateHint);
    updateMetadata(group);
    return { panel, updateMetadata, blocked: () => groupFeedback.blocked || categoryFeedback.blocked || [...rows.values()].some(row => row.feedback.blocked) };

    function resetComposer() {
      selected = null; generatedName = ''; resetInput(name);
      for (const radio of presetControls.values()) resetInput(radio, false);
      setFieldError(nameField, ''); updateHint();
    }
    function updateHint() {
      for (const preset of PROJECT_PRESETS) {
        const hit = existingProject(group, preset), radio = presetControls.get(preset.key), parts = presetLabels.get(preset.key);
        radio.disabled = categoryFeedback.blocked || !!hit;
        parts.label.classList.toggle('selected', !!radio.checked);
        parts.label.classList.toggle('unavailable', !!hit);
        parts.detail.textContent = hit ? '已添加' : preset.hint;
      }
      const hit = selected && existingProject(group, selected);
      name.disabled = !selected || categoryFeedback.blocked;
      addCategoryButton.disabled = !selected || !!hit || categoryFeedback.blocked;
      preview.textContent = selected ? `将在「${group.name}」添加：${name.value.trim() || '请填写项目名称'}（${selected.name}）` : '请选择一种比赛项目，名称会自动生成。';
      hint.textContent = hit ? `该组别已有「${hit.name}」，不能重复创建。` : group.categories.length === 4 ? '当前组别已开设全部四种项目，可选择其他组别继续设置。' : '';
    }
    function updateMetadata(nextGroup) {
      group = nextGroup;
      panel.setAttribute('aria-label', `${group.name}比赛项目`);
      title.textContent = `${group.name}的比赛项目`; editorTitle.textContent = `编辑${group.name}`;
      hierarchy.textContent = `${structure.event.name} → ${group.name}${group.categories[0] ? ` → ${group.categories[0].name}` : ' → 添加比赛项目'}`;
      if (groupName.value === inputBaselines.get(groupName)) resetInput(groupName, group.name);
      const ids = new Set(group.categories.map(category => category.id));
      for (const [id, row] of rows) if (!ids.has(id)) { row.node.remove(); rows.delete(id); }
      for (const category of group.categories) {
        if (rows.has(category.id)) rows.get(category.id).updateMetadata(category);
        else { const row = makeCategoryRow(category); rows.set(category.id, row); list.append(row.node); }
      }
      empty.classList.toggle('hidden', rows.size > 0); updateHint();
    }
    function makeCategoryRow(initialCategory) {
      let category = initialCategory;
      const nameInput = tracked(textInput(category.name, { 'aria-label': '项目名称' }));
      const title = h('h4.setup-project-name', category.name);
      const metadata = h('div.setup-project-metadata');
      const nameField = field('项目名称', nameInput, { required: true });
      const workspace = h('button.btn.setup-text-action', { onclick: () => {
        if (isCurrent()) go('workspace', { group: group.id, category: category.id, tab: 'overview' });
      } }, '进入项目工作台');
      const edit = h('button.btn.setup-text-action', { onclick: () => { editor.classList.remove('hidden'); edit.classList.add('hidden'); nameInput.focus(); } }, '修改名称');
      const save = h('button.btn.btn-primary', { onclick: saveCategory }, '保存名称');
      const remove = h('button.btn.btn-danger', { onclick: deleteCategory }, '删除项目');
      const cancel = h('button.btn', { onclick: async () => {
        if (feedback.blocked) return;
        if (hasEdits(editor) && !await confirmAsync('取消修改项目名称', '放弃这次尚未保存的输入？', '放弃修改')) return;
        resetInput(nameInput, category.name); setFieldError(nameField, ''); editor.classList.add('hidden'); edit.classList.remove('hidden'); feedback.clear(); edit.focus();
      } }, '取消');
      const editor = h('div.setup-project-editor.hidden', nameField, h('div.row.mt', save, cancel, remove));
      const node = h('article.setup-entity-row', { dataset: { categoryId: category.id } }, title, metadata,
        h('div.setup-entity-actions', workspace, edit), editor);
      const feedback = mutationFeedback(node, isCurrent);
      updateRowMetadata(category);
      return { node, feedback, updateMetadata: updateRowMetadata };
      function updateRowMetadata(nextCategory) {
        category = nextCategory; title.textContent = category.name; clear(metadata);
        metadata.append(h('span', `${category.gender === 'male' ? '男子' : '女子'} · ${category.kind === 'team' ? '三人赛' : '个人赛'}`),
          h('span', participantLabel(category)));
        if (nameInput.value === inputBaselines.get(nameInput)) resetInput(nameInput, category.name);
      }
      async function saveCategory() {
        if (feedback.blocked) return; setFieldError(nameField, '');
        if (!nameInput.value.trim()) { setFieldError(nameField, '请填写项目名称'); nameInput.focus(); return; }
        const submitted = nameInput.value, payload = { name: submitted.trim() };
        await mutate(() => feedback.run({
          controls: [save, cancel, remove, workspace, edit], changed: drawChoices,
          request: () => api.put(`/api/categories/${category.id}`, payload, { context }), read: latestStructure,
          reconcile: next => next.groups.find(g => g.id === group.id)?.categories.some(c => c.id === category.id && c.name === payload.name),
          saved: () => {
            if (nameInput.value === submitted) nameInput.value = category.name;
            inputBaselines.set(nameInput, category.name);
            if (!hasEdits(editor)) { editor.classList.add('hidden'); edit.classList.remove('hidden'); }
          }, success: '项目名称已保存',
        }));
      }
      async function deleteCategory() {
        if (feedback.blocked || !await confirmAsync('删除项目', `「${category.name}」\n已有参赛名单或比赛的项目不能删除。`, '删除')) return;
        await mutate(() => feedback.run({ controls: [save, cancel, remove, workspace, edit], changed: drawChoices,
          request: () => api.del(`/api/categories/${category.id}`, {}, { context }), read: latestStructure,
          reconcile: next => !next.groups.some(g => g.categories.some(c => c.id === category.id)), success: '项目已删除' }));
      }
    }
    async function saveGroup() {
      if (groupFeedback.blocked) return; setFieldError(groupField, '');
      if (!groupName.value.trim()) { setFieldError(groupField, '请填写组别名称'); groupName.focus(); return; }
      const submitted = groupName.value, payload = { name: submitted.trim() };
      await mutate(() => groupFeedback.run({ controls: [saveGroupButton, cancelEditGroup, deleteGroupButton], changed: drawChoices,
        request: () => api.put(`/api/groups/${group.id}`, payload, { context }), read: latestStructure,
        reconcile: next => next.groups.some(g => g.id === group.id && g.name === payload.name),
        saved: () => { if (groupName.value === submitted) groupName.value = group.name; inputBaselines.set(groupName, group.name); }, success: '组别名称已保存' }));
    }
    async function deleteGroup() {
      if (groupFeedback.blocked || !await confirmAsync('删除组别', `「${group.name}」\n只有组别下没有项目和学校时才能删除。`, '删除')) return;
      await mutate(() => groupFeedback.run({ controls: [saveGroupButton, cancelEditGroup, deleteGroupButton], changed: drawChoices,
        request: () => api.del(`/api/groups/${group.id}`, {}, { context }), read: latestStructure,
        reconcile: next => !next.groups.some(g => g.id === group.id), success: '组别已删除' }));
    }
    async function addCategory() {
      if (categoryFeedback.blocked || !selected) return; setFieldError(nameField, '');
      if (!name.value.trim()) { setFieldError(nameField, '请填写项目名称'); name.focus(); return; }
      if (existingProject(group, selected)) { updateHint(); return; }
      const submitted = name.value, payload = { name: submitted.trim(), kind: selected.kind, gender: selected.gender };
      await mutate(() => categoryFeedback.run({ controls: [addCategoryButton, cancelAdd, name, ...presetControls.values()],
        changed: () => { updateHint(); drawChoices(); },
        request: () => api.post(`/api/groups/${group.id}/categories`, payload, { context }), read: latestStructure,
        reconcile: next => { const found = next.groups.find(g => g.id === group.id)?.categories.find(c => c.kind === payload.kind && c.gender === payload.gender && c.name === payload.name); return found && { category_id: found.id }; },
        saved: () => { resetComposer(); addForm.classList.add('hidden'); addToggle.focus(); }, success: '项目已添加' }));
    }
  }
}

/* ------------------------------------------------------------------ 比赛场地 */
function renderVenuesStep(initialStructure, readStructure, { context, isCurrent }) {
  let structure = initialStructure;
  const name = tracked(textInput('', { placeholder: '例如：体育馆 1 号场', 'aria-label': '场地名称' }));
  const seq = tracked(textInput('', { type: 'number', min: 0, step: 1, inputmode: 'numeric', placeholder: '默认排到最后', 'aria-label': '顺序' }));
  const nameField = field('场地名称', name, { required: true });
  const orderField = field('顺序', seq);
  const advanced = h('details.setup-venue-advanced', h('summary', '手动设置顺序（可选）'), orderField);
  const addButton = h('button.btn.btn-primary', { onclick: add }, '确认添加场地');
  const toggle = h('button.btn', { onclick: () => { feedback.clear(); form.classList.remove('hidden'); name.focus(); } }, '添加场地');
  const cancel = h('button.btn', { onclick: async () => {
    if (feedback.blocked) return;
    if (hasEdits(form) && !await confirmAsync('取消添加场地', '放弃这次尚未添加的场地输入？', '放弃修改')) return;
    resetInput(name); resetInput(seq); advanced.open = false;
    form.classList.add('hidden'); setFieldError(nameField, ''); setFieldError(orderField, ''); feedback.clear(); toggle.focus();
  } }, '取消');
  const box = h('div.setup-venue-list');
  const form = h('div.setup-add-form.hidden', nameField, advanced, h('div.row.mt', addButton, cancel));
  const panel = h('section.panel', h('div.panel-head', h('div',
    h('h3', '3 · 比赛场地 ', h('span.setup-optional', '可后补')),
    h('p.setup-section-hint', '场地是实际比赛区域，例如 1 号场、2 号场；本赛事的所有组别和项目共用。')), toggle),
    box, form, h('p.setup-section-hint', '具体比赛的时间与场地，在项目工作台安排。'));
  const feedback = mutationFeedback(panel, isCurrent);
  panel.updateMetadata = next => { structure = next; draw(); };
  draw();
  return panel;
  function draw() {
    clear(box);
    const venues = structure.venues || [];
    if (!venues.length) { box.append(h('p.setup-venue-empty', '还没有场地。可以先开设项目，再补充实际场地。')); return; }
    const items = h('ul.setup-venue-items');
    for (const venue of venues) {
      items.append(h('li', h('span', venue.name), h('button.btn.small.setup-venue-remove', {
        'aria-label': `删除场地 ${venue.name}`, disabled: feedback.blocked,
        onclick: async () => {
          if (feedback.blocked || !await confirmAsync('删除场地',
            `「${venue.name}」\n已安排在该场地的比赛会改为“未安排”，比赛本身不会被删除。`, '删除')) return;
          await feedback.run({ controls: [addButton, toggle, cancel], changed: draw,
            request: () => api.del(`/api/venues/${venue.id}`, {}, { context }), read: readStructure,
            reconcile: next => !next.venues.some(v => v.id === venue.id), success: '场地已删除' });
        },
      }, '删除')));
    }
    box.append(items);
  }
  async function add() {
    if (feedback.blocked) return;
    setFieldError(nameField, ''); setFieldError(orderField, '');
    if (!name.value.trim()) { setFieldError(nameField, '请填写场地名称'); name.focus(); return; }
    if (structure.venues.some(v => v.name === name.value.trim())) { setFieldError(nameField, '已有同名场地，请填写其他名称'); name.focus(); return; }
    let order;
    try { order = venueOrder(seq.value, structure.venues || []); }
    catch (error) { setFieldError(orderField, error.message); advanced.open = true; seq.focus(); return; }
    const submitted = [name.value, seq.value], payload = { name: name.value.trim(), seq: order };
    await feedback.run({ controls: [addButton, toggle, cancel], changed: draw,
      request: () => api.post(`/api/events/${structure.event.id}/venues`, payload, { context }), read: readStructure,
      reconcile: next => { const found = next.venues.find(v => v.name === payload.name && v.seq === payload.seq); return found && { venue_id: found.id }; },
      saved: () => {
        [name, seq].forEach((control, index) => { if (control.value === submitted[index]) resetInput(control); });
        if (!hasEdits(form)) { form.classList.add('hidden'); advanced.open = false; }
      }, success: '场地已添加' });
  }
}

registerView({ name: 'setup', label: '赛事设置', roles: ['admin', 'organizer', 'recorder', 'viewer'], render });

/* School registration starts from backend records; editing is effective only after commit. */
import { api, captureRequestContext, getToken } from '../api.js';
import { registerView, state, loadStructure, reloadShell, go } from '../main.js';
import { readPendingRequest, writePendingRequest, removePendingRequest, capturePendingRequestScope } from '../pendingRequests.js';
import { h, clear, field, textInput, selectInput as uiSelectInput, formDialog, confirmAsync, toast, setPageLeaveGuard } from '../ui.js';
import { clone, submission, eligibility, occupancy, jerseyOrEmpty, localIssues, errorSummary, reconcile } from '../schoolRegistrationModel.js';
import { openSchoolImport } from '../schoolRegistrationImport.js';
import { workspaceSchoolLink, resolveSchoolContext } from '../workspaceContext.js';

const genders = [{ value: '', label: '待补充' }, { value: 'male', label: '男子' }, { value: 'female', label: '女子' }];
const choices = [{ value: 'unresolved', label: '尚未决定' }, { value: 'participate', label: '参加报名' },
  { value: 'not_participating', label: '明确不参加' }, { value: 'withdrawn', label: '退出报名' }];
const selectInput = (options, value) => uiSelectInput(options.map((o) => [o.value, o.label]), value);
const genderName = (value) => genders.find((x) => x.value === value)?.label || value;
const btn = (label, click, primary = false, attrs = {}) => h(`button.btn${primary ? '.btn-primary' : ''}`, { type: 'button', onclick: click, ...attrs }, label);
const personLabel = (p) => `${p.name} · ${genderName(p.gender)}${p.note ? ` · ${p.note}` : ''}${p.key.startsWith('new:') ? ' · 待提交' : ''}`;

/* 学校报名已收敛到项目工作台：页面只负责工作台正文，换页由 workspace 统一处理。 */
const scopedClient = (requestContext, signal) => ({
  get: (path) => api.get(path, { context: requestContext, signal }),
  post: (path, body) => api.post(path, body, { context: requestContext }),
  del: (path) => api.del(path, {}, { context: requestContext }),
});

/* 学校报名详情的规范地址：工作台报名名单页签 + 目标学校。 */
async function render({ el, params, requestContext = captureRequestContext(), signal, isCurrent: routeIsCurrent = () => true }) {
  const client = scopedClient(requestContext, signal);
  if (params.event && Number(params.event) !== state.eventId) await reloadShell(Number(params.event));
  if (!el.isConnected || signal?.aborted || !routeIsCurrent()) return;
  if (!state.eventId) { el.append(h('div.panel', '请先选择赛事。')); return; }
  const embedded = params.embedded === 'workspace';
  const selectedEvent = state.eventId, selectedToken = getToken();
  const currentPage = () => el.isConnected && !signal?.aborted && routeIsCurrent()
    && state.eventId === selectedEvent && state.user?.id === requestContext.user_id && getToken() === selectedToken
    && state.events.find(event => event.id === selectedEvent)?.uuid === requestContext.identity?.event_uuid;
  const structure = state.structure || await loadStructure();
  if (!currentPage()) return;
  const schoolData = params.school ? params.initialSchoolData
    || await client.get(`/api/schools/${encodeURIComponent(params.school)}/registration-workspace`) : null;
  if (!currentPage()) return;
  const resolved = resolveSchoolContext(structure, params, schoolData);
  if (!embedded) {
    location.hash = workspaceSchoolLink({ eventId: selectedEvent, groupId: resolved.group?.id,
      categoryId: resolved.category?.id, schoolId: resolved.schoolId, profile: params.profile });
    return;
  }
  if (!params.school) return renderDirectory({ el, groupId: resolved.group?.id,
    categoryId: resolved.category?.id, requestContext, signal, isCurrent: currentPage });
  const sid = resolved.schoolId, path = `/api/schools/${sid}`;
  const storageScope = capturePendingRequestScope();
  let latest = schoolData;
  const requestKey = `school-registration:${sid}:${latest.group.id}`;
  let base = latest, model = clone(latest), pending = readPendingRequest(requestKey, storageScope), preview = null, busy = false;
  let pendingUnknown = !!pending;
  let tab = 'projects', storageOK = true, savedResult = null;
  let deletePhase = 'idle', deleteMessage = '', deleteError = false, schoolDeleted = false;
  const deleteText = h('span');
  const verifyDeleteButton = btn('核对删除结果', verifyDeletion);
  verifyDeleteButton.hidden = true;
  const deleteFeedback = h('div.school-registration-delete-feedback', { role: 'status', 'aria-live': 'polite', hidden: true }, deleteText, verifyDeleteButton);
  const deleteButton = state.user.role === 'admin' ? btn('删除学校', deleteSchool, false,
    { class: 'school-registration-delete', 'aria-describedby': 'school-delete-status' }) : null;
  deleteFeedback.id = 'school-delete-status';
  const listLink = () => workspaceSchoolLink({
    eventId: selectedEvent, groupId: latest.group.id, categoryId: resolved.category?.id, profile: params.profile,
  });
  const backButton = btn('返回学校列表', () => { location.hash = listLink(); });
  const content = h('div.school-registration-content'), tabs = h('div.school-registration-tabs', { role: 'tablist' });
  const status = h('div.small', { role: 'status' }), errors = h('div.form-errors.hidden', { role: 'alert', tabindex: '-1' });
  const summary = h('div.school-registration-summary'), footerError = h('div.small.field-error', { role: 'alert', hidden: true });
  const action = btn('预览整批变更', () => runPreview(), true, { dataset: { action: 'school-preview' } });
  const importButton = btn('粘贴 / 导入学校报名表', () => openSchoolImport({ path, text: model.importText || '', payload: currentPayload(),
    requestContext, signal, isCurrent: currentPage,
    onText: (text) => { model.importText = text; edit(); },
    onApply: (imported) => { model.people = imported.people; model.projects = imported.projects; model.importText = ''; errors.textContent = ''; errors.classList.add('hidden'); edit(); draw(); },
    onConflict: (error) => { handleError(error); draw(); } }));
  importButton.classList.add('school-registration-import');
  const discard = btn('取消未提交修改', async () => {
    if (busy || pending || deletionLocked() || !currentPage()) return;
    if (await confirmAsync('取消未提交修改', '取消当前未提交的人员和项目调整，重新读取后台报名。', '取消修改')) {
      if (currentPage()) await reload();
    }
  });
  el.append(h('div.page-head.school-registration-detail-head', h('div', h('h2', model.school.name), h('p.muted', `${model.group.name} · 本届学校报名工作台`)),
    h('div.school-registration-head-actions', backButton, deleteButton)), deleteButton ? deleteFeedback : null,
  h('p.small.muted', '页面以后台已保存的报名为准。填写人员和阵容后，预览核对并整批提交，提交成功后生效。'),
  errors, h('div.toolbar.mb', importButton), h('div.panel', tabs, content), h('div.school-registration-footer',
    h('div', summary, footerError), h('div.toolbar', status, discard, action)));

  function currentPayload() { return submission(base, model); }

  function deletionLocked() { return deletePhase !== 'idle' || schoolDeleted; }
  function updateDeleteControls() {
    if (!deleteButton) return;
    deleteButton.disabled = busy || !!pending || !!savedResult || deletionLocked();
    backButton.disabled = ['checking', 'confirming', 'deleting', 'verifying'].includes(deletePhase);
    deleteButton.textContent = deletePhase === 'checking' ? '核对学校…' : deletePhase === 'deleting' ? '正在删除…' : '删除学校';
    const blocked = busy ? '正在处理报名，请完成后再删除。' : pending ? '报名提交结果待核实，请先完成核对。'
      : savedResult ? '报名已保存，请先读取最新正式名单。' : '';
    deleteText.textContent = blocked || deleteMessage;
    deleteFeedback.hidden = !deleteText.textContent;
    deleteFeedback.setAttribute('role', deleteError ? 'alert' : 'status');
    deleteFeedback.classList.toggle('school-registration-delete-error', deleteError);
    verifyDeleteButton.hidden = !['unknown', 'verifying'].includes(deletePhase);
    verifyDeleteButton.disabled = deletePhase === 'verifying';
  }
  function deletionStatus(phase, message = '', error = false) {
    deletePhase = phase; deleteMessage = message; deleteError = error;
    if (currentPage()) updateFooter();
  }
  function completeDeletion() {
    if (!currentPage()) return;
    schoolDeleted = true;
    deletionStatus('idle');
    toast('学校已删除，正在读取学校名单', 'ok');
    location.hash = listLink();
  }
  async function deleteSchool() {
    if (!deleteButton || deleteButton.disabled || !currentPage()) return;
    let requested = false;
    deletionStatus('checking', '正在核对学校档案…');
    try {
      const detail = await client.get(`${path}/detail`);
      if (!currentPage()) return;
      if (detail.school?.id !== sid || detail.school?.event_id !== selectedEvent || typeof detail.school?.name !== 'string'
          || !Array.isArray(detail.athletes) || !Array.isArray(detail.teams) || !Array.isArray(detail.individual_entries)
          || detail.athletes.some(person => !Number.isInteger(person?.id) || person.school_id !== sid)
          || detail.teams.some(team => !Number.isInteger(team?.id) || team.school_id !== sid)) {
        throw new Error('学校档案读取不完整，请重新核对后再删除');
      }
      const impact = `学校：${detail.school.name}\n所属组别：${detail.group?.group_name || '未分组'}\n`
        + `已保存档案：${detail.athletes.length} 位人员 · ${detail.teams.length} 个三人赛项目名单\n\n`
        + '将删除该校档案及其人员、项目名单。已有参赛报名记录的学校不能删除。'
        + (changed() ? '\n\n当前尚未提交的修改将一并放弃。' : '');
      deletionStatus('confirming');
      if (!await confirmAsync('删除学校', impact, '确认删除', { danger: true, initialFocus: 'cancel' }) || !currentPage()) return;
      deletionStatus('deleting', '正在删除学校…'); requested = true;
      await client.del(path);
      completeDeletion();
    } catch (error) {
      if (!currentPage() || error.cancelled) return;
      const reasons = Array.isArray(error.detail?.reasons) ? error.detail.reasons : [];
      const reasonText = reasons.map((reason) => {
        const steps = Array.isArray(reason?.steps) && reason.steps.length
          ? ` 下一步：${reason.steps.join('；')}` : '';
        return `${reason?.message || error.message}${steps}`;
      }).join(' ');
      deletionStatus(requested && error.outcome_unknown ? 'unknown' : 'idle',
        requested && error.outcome_unknown ? `删除结果尚未确认，请先核对删除结果：${error.message}` : (reasonText || error.message), true);
    } finally {
      if (!['unknown', 'verifying'].includes(deletePhase)) deletePhase = 'idle';
      if (currentPage()) {
        updateFooter();
        if (!schoolDeleted && !deletionLocked() && !deleteButton.disabled) deleteButton.focus();
      }
    }
  }
  async function verifyDeletion() {
    if (deletePhase !== 'unknown' || !currentPage()) return;
    deletionStatus('verifying', '正在核对删除结果…');
    try {
      const result = await client.get(`/api/events/${selectedEvent}/schools`);
      if (!currentPage()) return;
      if (!Array.isArray(result.schools) || result.schools.some(school => !Number.isInteger(school?.id)
          || school.id <= 0 || school.event_id !== selectedEvent || typeof school.name !== 'string')) {
        throw new Error('学校名单读取不完整，请重新核对');
      }
      if (!result.schools.some(school => school.id === sid)) completeDeletion();
      else {
        deletionStatus('idle', '学校仍在名单，当前输入已保留。请核对后重新确认删除。');
        deleteButton.focus();
      }
    } catch (error) {
      if (!currentPage() || error.cancelled) return;
      deletionStatus('unknown', `删除结果尚未确认，核对失败：${error.message}`, true);
    } finally {
      if (deletePhase === 'verifying') deletePhase = 'unknown';
      if (currentPage()) updateFooter();
    }
  }

  function changed() {
    if (savedResult) return false;
    const p = submission(base, model);
    return p.people.length > 0 || p.projects.length > 0 || hasUnaddedPeople() || !!model.importText?.trim();
  }
  function hasUnaddedPeople() {
    return Object.values(model.newPersonForms || {}).some((v) => v.name?.trim() || v.note?.trim() || v.jersey_no?.trim());
  }
  function retainRequest() {
    storageOK = pending ? writePendingRequest(requestKey, pending, storageScope) : removePendingRequest(requestKey, storageScope);
    updateStatus();
    return storageOK;
  }
  function updateStatus() {
    if (!currentPage()) return;
    status.textContent = pending ? (storageOK ? '提交结果待核实；请用原内容重试' : '提交结果待核实，请保持页面打开并重试')
      : changed() ? '当前修改尚未提交' : '已读取后台报名';
  }
  function clearErrorNote() {
    errors.classList.add('hidden');
    errors.textContent = '';
    footerError.textContent = '';
    footerError.hidden = true;
  }
  function edit() { preview = null; savedResult = null; clearErrorNote(); updateStatus(); updateFooter(); }
  function showError(error) {
    if (!currentPage()) return;
    const summaryText = errorSummary(error);
    errors.textContent = '';
    errors.append(h('div.form-errors-title', summaryText.message));
    if (summaryText.details.length) errors.append(h('div', summaryText.details.join('；')));
    errors.classList.remove('hidden');
    footerError.textContent = summaryText.text;
    footerError.hidden = false;
    toast(summaryText.text, 'error');
    requestAnimationFrame(() => {
      if (!currentPage() || errors.classList.contains('hidden') || !errors.isConnected) return;
      try { errors.scrollIntoView({ block: 'center' }); } catch { /* 滚动失败时保留 toast 与底部摘要 */ }
      try { errors.focus({ preventScroll: true }); } catch { try { errors.focus(); } catch { /* 焦点不可用时保留摘要 */ } }
    });
  }
  function handleError(error) {
    if (!currentPage()) return;
    if (error.code === 'registration_stale' && error.detail?.latest) {
      const merged = reconcile(base, model, error.detail.latest);
      latest = error.detail.latest; base = latest; model = merged.merged; preview = null; savedResult = null;
      const conflicts = merged.conflicts || [];
      const suffix = conflicts.length
        ? `；${conflicts.length} 处本地修改与后台冲突，已采用后台版本，请核对后重新预览`
        : '；未冲突的本地修改已保留，请核对后重新预览';
      showError(new Error(`后台报名已被其他入口更新，已读取最新名单${suffix}`));
      updateStatus(); updateFooter();
      return;
    }
    showError(error);
  }
  function updateFooter() {
    if (!currentPage()) return;
    const n = latest.projects.filter((p) => p.choice === 'participate').length;
    const no = latest.projects.filter((p) => p.choice === 'not_participating').length;
    const unresolved = latest.projects.filter((p) => p.choice === 'unresolved').length;
    let gaps = 0;
    for (const p of latest.projects.filter((p) => p.choice === 'participate')) {
      const cat = latest.categories.find((c) => c.id === p.category_id);
      if (cat.kind === 'team') { gaps += Number(p.members.length < 3) + Number(!p.captain_key); }
      const keys = cat.kind === 'team' ? p.members.map((m) => m.athlete_key) : [p.athlete_key].filter(Boolean);
      gaps += keys.filter((key) => !latest.people.find((a) => a.key === key)?.gender).length;
    }
    summary.textContent = savedResult ? '报名提交成功，等待读取后台最新统计' : `后台已保存：${n} 项报名 · ${no} 项不参加 · ${unresolved} 项尚未决定 · ${gaps} 处资料待补`;
    action.textContent = busy ? '处理中…' : pending ? '核实并重试原提交' : preview ? '确认整批提交' : '预览整批变更';
    action.disabled = busy || deletionLocked() || !!savedResult || (!pending && !changed());
    discard.disabled = busy || deletionLocked() || !!pending || !!savedResult;
    importButton.disabled = busy || deletionLocked() || !!pending || !!savedResult;
    tabs.querySelectorAll('button').forEach((b) => { b.disabled = busy || deletionLocked(); });
    content.querySelectorAll('input,select,textarea,button').forEach((control) => { control.disabled = busy || deletionLocked() || !!pending || !!savedResult; });
    content.querySelectorAll('[data-action="school-reload"]').forEach((control) => { control.disabled = busy || deletionLocked(); });
    for (const cat of model.categories) {
      const card = content.querySelector(`[data-category="${cat.id}"]`);
      if (!card) continue;
      if (cat.locked_reason) card.querySelectorAll('[data-edit="entry"]').forEach((control) => { control.disabled = true; });
      if (cat.roster_locked_reason) card.querySelectorAll('[data-edit="roster"] input,[data-edit="roster"] select,[data-edit="roster"] button').forEach((control) => { control.disabled = true; });
    }
    updateDeleteControls();
  }
  setPageLeaveGuard(async () => {
    if (schoolDeleted) return true;
    if (busy || ['checking', 'confirming', 'deleting', 'verifying'].includes(deletePhase)) return false;
    if (deletePhase === 'unknown') return confirmAsync('离开学校报名',
      '删除结果尚未核实。离开后请在学校列表核对学校状态。'
      + (changed() ? '\n当前尚未提交的修改将放弃。' : ''), '离开');
    if (!changed() && !pending) return true;
    return confirmAsync('离开学校报名', pending
      ? (storageOK ? '提交结果待核实。返回此学校后将核实或重试原提交。' : '原提交尚未核实且未能保留，请继续留在此页重试。离开可能丢失提交内容。')
      : '当前修改尚未提交，离开后将放弃这些修改。下次进入将显示后台已保存的报名。', '离开');
  }, () => !schoolDeleted && (busy || deletionLocked() || (!pending && changed()) || (!!pending && !storageOK)), currentPage);

  function input(value, onChange, attrs = {}) {
    const control = textInput(value, attrs);
    control.addEventListener('input', () => { onChange(control.value); edit(); });
    return control;
  }
  function draw() {
    if (!currentPage()) return;
    clear(tabs); clear(content);
    for (const [key, label] of [['people', '人员名单'], ['projects', '项目报名'], ['review', '核对与提交']]) tabs.append(
      btn(label, () => { tab = key; draw(); }, tab === key, { role: 'tab', 'aria-selected': String(tab === key) }));
    if (savedResult) content.append(h('div.notice', '学校报名已保存，请读取后台最新名单。', btn('读取最新正式名单', async () => {
      if (busy || deletionLocked() || !currentPage()) return;
      busy = true; updateFooter();
      try { await reload(); } catch (error) { showError(error); }
      finally { busy = false; draw(); }
    }, false, { dataset: { action: 'school-reload' } })));
    else if (tab === 'people') drawPeople();
    else if (tab === 'projects') drawProjects();
    else drawReview();
    updateFooter();
  }
  function addPersonForm(cat = null) {
    const project = cat && model.projects.find((p) => p.category_id === cat.id);
    const joinProject = cat && !cat.roster_locked_reason && project.choice === 'participate'
      && (cat.kind === 'individual' || project.members.length < 6);
    const slot = cat ? String(cat.id) : 'people';
    model.newPersonForms ||= {};
    const buffer = model.newPersonForms[slot] || {};
    const name = textInput(buffer.name || '', { placeholder: '运动员姓名', 'aria-label': '新增人员姓名' });
    const gender = selectInput(genders, buffer.gender ?? cat?.gender ?? '');
    const jersey = textInput(buffer.jersey_no || '', { placeholder: '常用号码', 'aria-label': '新增人员常用号码' });
    const note = textInput(buffer.note || '', { placeholder: '班级、学号等区分信息', 'aria-label': '新增人员区分信息' });
    const verified = h('input', { type: 'checkbox' });
    const check = h('div.same-name-review.hidden');
    const names = () => model.people.filter((p) => p.name.trim().toLowerCase() === name.value.trim().toLowerCase());
    const persistInput = () => {
      model.newPersonForms[slot] = { name: name.value, gender: gender.value, jersey_no: jersey.value, note: note.value };
      edit();
    };
    const showSameNames = () => {
      verified.checked = false; clear(check);
      const same = names(); check.classList.toggle('hidden', !same.length);
      same.forEach((p) => check.append(h('div.same-name-person', personLabel(p),
        h('span.small.muted', (occupancy(model).get(p.key) || []).map((c) => c.name).join('、') || '尚未分配项目'))));
      if (same.length) check.append(h('label.row.tight', verified, '已核对全校同名人员，确认新增的是另一人'));
    };
    name.oninput = () => { persistInput(); showSameNames(); };
    note.oninput = persistInput; jersey.oninput = persistInput; gender.onchange = persistInput;
    showSameNames();
    const add = btn(cat ? (joinProject ? '添加人员并加入本项目' : '添加到学校人员名单') : '添加人员', () => {
      const same = names(), personName = name.value.trim(), personNote = note.value.trim();
      if (!personName) { showError(new Error('请填写运动员姓名')); name.focus(); return; }
      if (joinProject && gender.value && gender.value !== cat.gender) {
        showError(new Error('性别与当前项目不符，请核对性别或在人员名单中新增')); return;
      }
      if (same.length && (!verified.checked || !personNote || same.some((p) => p.note.trim().toLowerCase() === personNote.toLowerCase()))) {
        showError(new Error('同名新增需确认不同人，并填写不同的区分信息')); return;
      }
      const person = { key: `new:${crypto.randomUUID()}`, name: personName, gender: gender.value,
        jersey_no: jersey.value.trim(), note: personNote,
        same_name_candidates: base.people.filter((p) => p.name.trim().toLowerCase() === personName.toLowerCase()).map((p) => ({ id: p.id, rev: p.rev })).sort((a, b) => a.id - b.id),
        confirm_distinct_person: !!same.length && verified.checked };
      model.people.push(person);
      delete model.newPersonForms[slot];
      if (joinProject && !eligibility(person, cat, model)) {
        const p = model.projects.find((p) => p.category_id === cat.id);
        if (cat.kind === 'individual') p.athlete_key = person.key;
        else if (p.members.length < 6) p.members.push({ athlete_key: person.key, jersey_no: jerseyOrEmpty(person.jersey_no) });
      }
      errors.classList.add('hidden'); edit(); draw();
    }, true);
    return h('div.school-registration-add', cat && !joinProject ? h('p.small.muted', cat.roster_locked_reason
      ? '当前项目阵容已冻结。新增人员只加入学校人员名单。'
      : '本项目已满 6 人。新增人员先加入学校人员名单，调整阵容后可再选择。') : null,
      field('姓名', name), field('性别', gender),
      field('常用号码', jersey), field('区分信息', note), check, h('div.toolbar', add, btn('清空新增输入', () => {
        delete model.newPersonForms[slot]; errors.classList.add('hidden'); edit(); draw();
      })));
  }
  function drawPeople() {
    content.append(h('h3', '全校人员名单'), h('p.small.muted', '人员使用稳定档案 ID。同名人员分别保留，项目号码在项目报名中填写。'));
    for (const p of model.people) {
      const gender = selectInput(genders, p.gender);
      gender.onchange = () => { p.gender = gender.value; edit(); };
      const assigned = (occupancy(model).get(p.key) || []).map((c) => c.name).join('、');
      const genderConflicts = (occupancy(model).get(p.key) || [])
        .filter((c) => p.gender && c.gender && p.gender !== c.gender);
      content.append(h('div.school-registration-person', { dataset: { person: p.key } },
        field('姓名', input(p.name, (v) => { p.name = v; })), field('性别', gender),
        field('常用号码', input(p.jersey_no, (v) => { p.jersey_no = v; })),
        field('区分信息', input(p.note, (v) => { p.note = v; })),
        h('div.small.muted', assigned || '尚未分配项目'),
        genderConflicts.length ? h('div.field-error', `性别与已报名项目不符：${genderConflicts.map((c) => c.name).join('、')}`) : null,
        p.key.startsWith('new:') ? btn('移除新增人员', () => {
          if (assigned) { showError(new Error('请先从项目中移除此人员')); return; }
          model.people = model.people.filter((x) => x.key !== p.key); edit(); draw();
        }) : h('span.small.muted', `档案 #${p.id}`)));
    }
    content.append(h('details.mt', { open: !!model.newPersonForms?.people?.name }, h('summary', '＋ 新增人员'), addPersonForm()));
  }
  function drawProjects() {
    const grid = h('div.school-registration-projects');
    content.append(h('p.small.muted', '跨项目调整：先在原项目移除人员或退出，再分配到目标项目，最后统一预览提交。'), grid);
    if (!model.categories.length) content.append(h('p.notice', '本组别尚未开设项目，可先在“人员名单”整理人员，配置项目后再报名。'));
    for (const cat of model.categories) {
      const p = model.projects.find((p) => p.category_id === cat.id);
      const original = base.projects.find((x) => x.category_id === cat.id);
      const availableChoices = original?.choice === 'unresolved' ? choices : choices.filter((x) => x.value !== 'unresolved');
      const choice = selectInput(availableChoices, p.choice);
      choice.dataset.edit = 'entry';
      choice.onchange = () => {
        if (choice.value === 'unresolved') Object.assign(p, clone(original));
        else p.choice = choice.value;
        edit(); draw();
      };
      const card = h('section.school-registration-project', { dataset: { category: cat.id } },
        h('h3', cat.name), field('参赛选择', choice));
      grid.append(card);
      if (cat.edit_notice) card.append(h('p.notice.small', cat.edit_notice));
      else if (cat.roster_locked_reason || cat.locked_reason) card.append(h('p.notice.small', cat.roster_locked_reason || cat.locked_reason));
      if (p.choice !== 'participate') { card.append(h('p.small.muted', choices.find((x) => x.value === p.choice)?.label)); continue; }
      const roster = h('div.school-registration-roster', { dataset: { edit: 'roster' } });
      card.append(roster);
      const selected = new Set(cat.kind === 'team' ? p.members.map((m) => m.athlete_key) : [p.athlete_key]);
      const eligible = model.people.filter((a) => !selected.has(a.key) && !eligibility(a, cat, model));
      const picker = selectInput([{ value: '', label: cat.roster_locked_reason ? '阵容已冻结' : eligible.length ? '选择可报名人员' : '没有可报名人员，可就地新增' },
        ...eligible.map((a) => ({ value: a.key, label: personLabel(a) }))], '');
      picker.setAttribute('aria-label', `${cat.name}选人`);
      const search = textInput('', { placeholder: '按姓名或区分信息筛选', 'aria-label': `${cat.name}人员搜索` });
      search.oninput = () => {
        const q = search.value.trim().toLowerCase();
        clear(picker);
        picker.append(h('option', { value: '' }, '选择可报名人员'));
        eligible.filter((a) => personLabel(a).toLowerCase().includes(q)).forEach((a) => picker.append(h('option', { value: a.key }, personLabel(a))));
      };
      picker.onchange = () => {
        if (!picker.value) return;
        if (cat.kind === 'team') {
          if (p.members.length >= 6) { showError(new Error('三人赛每队最多 6 人')); return; }
          const a = model.people.find((a) => a.key === picker.value);
          p.members.push({ athlete_key: a.key, jersey_no: jerseyOrEmpty(a.jersey_no) });
        } else p.athlete_key = picker.value;
        edit(); draw();
      };
      roster.append(field('搜索可报名人员', search), field(cat.kind === 'team' ? `参赛队员（${p.members.length}/6）` : '参赛运动员（每校 1 人）', picker));
      const keys = cat.kind === 'team' ? p.members.map((m) => m.athlete_key) : [p.athlete_key].filter(Boolean);
      for (const key of keys) {
        const a = model.people.find((a) => a.key === key);
        if (!a) { roster.append(h('p', '人员档案已删除，请核对最新名单')); continue; }
        const reason = eligibility(a, cat, model);
        const row = h('div.school-registration-member', h('div.grow', h('strong', a.name), h('div.small.muted', personLabel(a)), reason ? h('div.field-error', reason) : null));
        if (cat.kind === 'team') {
          const m = p.members.find((m) => m.athlete_key === key);
          row.append(field('本项目号码', input(m.jersey_no, (v) => { m.jersey_no = v; }, { inputmode: 'numeric', 'aria-label': `${a.name}本项目号码` })));
        }
        row.append(btn('移除', () => {
          p.members = p.members.filter((m) => m.athlete_key !== key);
          if (p.captain_key === key) p.captain_key = '';
          if (p.athlete_key === key) p.athlete_key = '';
          edit(); draw();
        })); roster.append(row);
      }
      if (cat.kind === 'team') {
        const captain = selectInput([{ value: '', label: '队长待补充' }, ...keys.map((key) => ({ value: key, label: model.people.find((a) => a.key === key)?.name || key }))], p.captain_key);
        captain.onchange = () => { p.captain_key = captain.value; edit(); };
        roster.append(field('队长', captain));
        if (p.members.length < 3) roster.append(h('p.small.muted', '队员不足 3 人：可以先报名，赛前补齐。'));
      }
      if (cat.kind === 'individual' && !p.athlete_key) roster.append(h('p.small.muted', '请选择 1 名运动员后再预览提交。'));
      const blocked = model.people.filter((a) => !selected.has(a.key) && eligibility(a, cat, model));
      if (blocked.length) roster.append(h('details', h('summary', `查看暂不可报名人员（${blocked.length}）`),
        ...blocked.map((a) => h('div.small.mt', personLabel(a), h('div.muted', eligibility(a, cat, model))))));
      card.append(h('details.mt', { open: !!model.newPersonForms?.[cat.id]?.name }, h('summary', '＋ 就地新增人员'), addPersonForm(cat)),
        field('种子序号', input(p.seed_no || '', (v) => { p.seed_no = v || null; }, { inputmode: 'numeric', dataset: { edit: 'entry' } })),
        field('报名备注', input(p.note, (v) => { p.note = v; })));
    }
  }
  function drawReview() {
    content.append(h('h3', '核对整批变更'));
    const payload = submission(base, model);
    content.append(h('p.small.muted', `待保存 ${payload.people.length} 位人员资料、${payload.projects.length} 个项目调整。未修改的项目保持原状。`));
    if (!preview) { content.append(h('p', pending ? '原提交结果待核实。请点击“核实并重试原提交”。核实前不能更改原提交内容。' : '点击“预览整批变更”，核对资格、名额和变更明细。')); return; }
    content.append(h('ul', ...preview.changes.map((x) => h('li', x))));
    if (preview.people_review.length) content.append(h('h4', '本次保存的人员资料'),
      ...preview.people_review.map((p) => h('p', `${p.name} · ${genderName(p.gender)} · 常用号码 ${p.jersey_no || '未填'} · ${p.note || '区分信息未填'}`)));
    for (const p of preview.review) content.append(h('div.school-registration-conflict', h('strong', p.category_name),
      h('p', choices.find((x) => x.value === p.choice)?.label),
      p.choice === 'participate' ? h('div', p.athlete_name || p.members.map((m) => `${m.name}（号码 ${m.jersey_no || '待补'}）`).join('、') || '队员待补充',
        p.members.length ? h('p.small', `队长：${p.captain_name || '待补充'}`) : null,
        h('p.small.muted', `种子：${p.seed_no || '未指定'}${p.note ? ` · ${p.note}` : ''}`)) : null));
    if (preview.warnings.length) content.append(h('h4', '可以提交，赛前需补齐'),
      h('ul', ...preview.warnings.map((w) => h('li', `${model.categories.find((c) => c.id === w.category_id)?.name || ''}：${w.message}`))));
    else content.append(h('p', '当前报名资料核对通过。'));
    content.append(h('p.small.muted', '确认后，以上人员资料与项目调整将一次保存；任一项失败则整批回滚。'));
  }
  async function reload() {
    const formal = await client.get(`${path}/registration-workspace`);
    if (!currentPage()) return;
    resolveSchoolContext(structure, params, formal);
    latest = formal;
    base = latest; model = clone(latest); preview = null; pending = null; savedResult = null;
    removePendingRequest(requestKey, storageScope); status.textContent = '已读取正式报名'; clearErrorNote(); draw();
  }
  async function runPreview() {
    if (busy || deletionLocked() || !currentPage()) return;
    if (pending || preview) { await commit(); return; }
    if (hasUnaddedPeople()) { showError(new Error('请先添加新增人员，或清空尚未添加的输入，再预览提交。')); return; }
    if (model.importText?.trim()) { showError(new Error('还有尚未合入的表格，请打开导入窗口核对并合入，或清空表格输入。')); return; }
    const issues = localIssues(model);
    if (issues.length) { showError(new Error(issues.join('；'))); return; }
    busy = true; clearErrorNote(); updateFooter();
    try {
      const result = await client.post(`${path}/registration-preview`, currentPayload());
      if (!currentPage()) return;
      preview = result;
      tab = 'review';
    } catch (error) {
      handleError(error);
    } finally { busy = false; draw(); }
  }
  async function commit() {
    if (busy || deletionLocked() || !currentPage()) return;
    if (!pending) {
      pending = { ...currentPayload(), preview_hash: preview.preview_hash, request_uid: crypto.randomUUID() };
    }
    if (!retainRequest()) { showError(new Error('原提交未能保存到本机，请恢复存储后重试；当前页面保留输入。')); return; }
    const retryingUnknown = pendingUnknown;
    busy = true; clearErrorNote(); updateFooter();
    try {
      savedResult = await client.post(`${path}/registration-commit`, pending);
      pending = null; preview = null; removePendingRequest(requestKey, storageScope);
      if (!currentPage()) return;
      toast('学校报名已整批保存');
    } catch (error) {
      handleError(error);
      // HTTP validation rejection guarantees no writes; network/5xx may have committed.
      if (!retryingUnknown && error.code !== 'account_changed' && error.status >= 400 && error.status < 500) {
        pending = null; preview = null;
      }
      // Keep uncertainty outside the immutable wire packet. Recovered packets
      // always start uncertain, even if an earlier page ended mid-response.
      pendingUnknown = !!pending && (retryingUnknown || !!error.outcome_unknown);
      retainRequest();
    } finally { busy = false; }
    if (!currentPage()) return;
    if (savedResult) {
      try { await loadStructure(); if (currentPage()) await reload(); } catch (error) { showError(new Error(`报名已保存，读取最新名单失败：${error.message}`)); draw(); }
    } else draw();
  }
  status.textContent = pending ? '已读取后台报名；上次提交结果待核实' : '已读取后台报名';
  draw();
}

/* 学校名单只显示当前组别；项目筛选仅定位待补资料学校。 */
async function renderDirectory({ el, groupId = null, categoryId = null, profile = null, incomplete = [],
    requestContext = captureRequestContext(), signal, isCurrent = () => true }) {
  const eventId = state.eventId, token = getToken(), client = scopedClient(requestContext, signal);
  const alive = () => el.isConnected && !signal?.aborted && isCurrent() && state.eventId === eventId
    && state.user?.id === requestContext.user_id && getToken() === token
    && state.events.find(event => event.id === eventId)?.uuid === requestContext.identity?.event_uuid;
  const structure = state.structure || await loadStructure();
  if (!alive()) return;
  const resolved = resolveSchoolContext(structure, { event: eventId, group: groupId, category: categoryId });
  const { schools } = await client.get(`/api/events/${eventId}/schools`);
  if (!alive()) return;
  if (!Array.isArray(schools) || schools.some(school => !Number.isInteger(school.id) || school.event_id !== eventId)) {
    throw new Error('学校名单读取不完整，请重新读取');
  }
  const filtered = profile === 'incomplete' && !!categoryId;
  const gaps = new Map((incomplete || []).map(item => [item.school_id, item.gaps]));
  const visible = schools.filter(school => school.group_id === resolved.group?.id && (!filtered || gaps.has(school.id)));
  const list = h('div.school-registration-list', { role: 'list', 'aria-label': '学校报名列表' });
  const link = school => workspaceSchoolLink({ eventId, groupId: school.group_id,
    categoryId: resolved.category?.id, schoolId: school.id, profile: filtered ? profile : null });
  for (const school of visible) list.append(h('div.school-registration-item', { role: 'listitem' },
    btn([
      h('div.school-registration-school-info',
        h('div.school-registration-school-name', school.name),
        h('div.school-registration-school-meta', { id: `school-registration-meta-${school.id}` },
          h('span.badge.badge-info', school.group_name || resolved.group.name), h('span', `${school.athlete_count} 位人员`),
          filtered ? h('span.badge.badge-warn', '资料待补充') : null)),
      h('span.school-registration-school-arrow', { 'aria-hidden': 'true' }, '›'),
    ], () => { if (alive()) location.hash = link(school); }, false,
    { class: 'school-registration-school', 'aria-label': school.name, 'aria-describedby': `school-registration-meta-${school.id}` })));
  if (!visible.length) list.append(h('p.muted.school-registration-empty', filtered
    ? '当前项目没有资料待补充的学校。' : '该组别尚无学校，可以新增学校后整理报名。'));
  el.append(h('section.panel.school-registration-directory',
    h('div.school-registration-list-head', h('div', h('h3', '学校名单'),
      h('p.small.muted', '选择学校，统一整理本组别的人员与全部项目报名。')),
      btn('新增学校', () => { if (alive()) newSchool(structure, resolved, { client, eventId, alive }); }, true)),
    filtered ? h('div.notice.school-registration-filter', h('span', '仅显示当前项目资料待补充的学校'),
      h('a.btn', { href: workspaceSchoolLink({ eventId, groupId, categoryId }) }, '查看全部学校')) : null,
    h('p.small.muted', { role: 'status', 'aria-live': 'polite' }, `共 ${visible.length} 所学校`), list));
}

function newSchool(structure, resolved, { client, eventId, alive }) {
  const name = textInput(''), short = textInput('');
  const group = selectInput(structure.groups.map(item => ({ value: item.id, label: item.name })), resolved.group.id);
  formDialog({ title: '新增学校', sections: [{ body: h('div', field('学校名称', name, { required: true, name: 'name' }),
    field('简称', short, { name: 'short_name' }), field('组别', group, { name: 'group_id' })) }],
    actions: [{ label: '创建并整理报名', primary: true, run: async ({ close }) => {
      if (!alive()) return;
      const target = resolveSchoolContext(structure, { event: eventId, group: group.value,
        category: Number(group.value) === resolved.group.id ? resolved.category?.id : null });
      const result = await client.post(`/api/events/${eventId}/schools`, {
        name: name.value.trim(), short_name: short.value.trim(), group_id: target.group.id });
      if (!alive()) return;
      close();
      location.hash = workspaceSchoolLink({ eventId, groupId: target.group.id, categoryId: target.category?.id, schoolId: result.school_id });
    } }] });
}

registerView({ name: 'schoolRegistration', label: '学校报名', render, renderDirectory });

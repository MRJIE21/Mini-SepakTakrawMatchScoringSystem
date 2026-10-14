/* 组委会赛程录入：按正式分组与赛程资料添加、修改与删除比赛。 */
import { api } from '../api.js';
import { compareScheduledMatches } from '../dateTime.js';
import { registerView, state, loadStructure, go } from '../main.js';
import {
  h, field, textInput, selectInput, table, toast, confirmAsync, promptDialog,
  matchStatusBadge, clear, formDialog, dateTimeInput, loadingState, errorState, emptyState,
  categoryLabel,
} from '../ui.js';

const canWrite = () => ['admin', 'organizer'].includes(state.user.role);

/* 方案锁定后的敏感操作需要填写原因，原因随请求提交并记入审计日志。
   用页内输入框取代 window.prompt，原因可以在提交前核对（§9.1、Q11）。 */
async function askReason(title, hint) {
  const reason = await promptDialog({
    title, label: '原因', multiline: true, required: true, okLabel: '填写原因并执行',
    hint,
  });
  return reason ? reason.trim() : null;
}

async function render({ el, params, signal, requestContext, isCurrent = () => true }) {
  const eventId = requestContext?.identity?.event_id || state.eventId;
  const client = {
    get: (path) => api.get(path, { signal, context: requestContext }),
    post: (path, body) => api.post(path, body, { context: requestContext }),
    put: (path, body) => api.put(path, body, { context: requestContext }),
    del: (path, body) => api.del(path, body, { context: requestContext }),
  };
  if (!state.eventId) throw new Error('请先在“赛事首页”中创建赛事');
  const structure = state.structure || await loadStructure();
  const cats = [];
  for (const g of structure.groups) {
    for (const c of g.categories) if (c.kind === 'team') cats.push({ ...c, group_name: g.name });
  }
  if (!cats.length) {
    el.append(emptyState({ text: '当前赛事没有三人赛项目', hint: '请先在“赛事设置”中添加三人赛项目。' }));
    return;
  }
  const catId = Number(params.category || cats[0].id);
  const cat = cats.find((c) => c.id === catId);
  const embedded = params.embedded === 'workspace';
  if (!cat) {
    el.append(errorState(new Error(`项目不存在或不属于本赛事（id=${catId}）`),
      () => { location.hash = '#/matches'; }));
    return;
  }

  let statusFilter = params.status || '';
  let allMatches = [];
  let pageOffset = 0, pageRevision = null, loadGeneration = 0;
  const onStatusChange = (value) => {
    statusFilter = value;
    if (params.onStatusChange) params.onStatusChange(value);
    else history.replaceState(null, '', `#/matches?category=${cat.id}&status=${value}`);
    pageOffset = 0;
    pageRevision = null;
    load();
  };
  el.append(h('div.panel',
    h('div.panel-head',
      embedded ? h('h3', '赛程录入与核对') : h('h2', '组委会赛程录入与核对'),
      h('div.row.tight',
        embedded ? null : field('项目', selectInput(
          cats.map((c) => [c.id, categoryLabel(c, { withGroup: true })]), cat.id,
          { onchange: (e) => { location.hash = `#/matches?category=${e.target.value}`; } })),
        field('状态', selectInput([['', '全部'], ['ready', '待记录'], ['finished', '已确认'],
          ['pending', '等待前序'], ['void', '轮空/不进行']], statusFilter,
        { onchange: (e) => onStatusChange(e.target.value) }))),
    ),
    h('div.small.muted', '在这里查看比赛列表，逐场录入或调整场地、时间。也可先完成学校小组抽签，再生成并确认赛程。已有确认成绩的比赛须通过更正流程处理。'),
    canWrite() ? h('div.row.mt', h('button.btn', {
      onclick: () => params.onPlanning ? params.onPlanning() : go('scheduling', { category: cat.id }),
    }, '自动辅助编排（可选）'), h('button.btn', {
      onclick: () => params.onPlanning ? params.onPlanning(true) : go('scheduling', { category: cat.id, draw: 1 }),
    }, '小组抽签')) : null,
  ));

  const addBox = h('div');
  const listBox = h('div');
  el.append(addBox, listBox);
  await load();

  async function load(nextForm = null) {
    const generation = ++loadGeneration;
    clear(listBox);
    listBox.append(h('div.panel', loadingState('正在加载比赛列表…')));
    try {
      const query = new URLSearchParams({ category_id: cat.id, with_sets: 1, offset: pageOffset, limit: 100 });
      if (statusFilter) query.set('status', statusFilter);
      if (pageOffset && pageRevision !== null) query.set('list_revision', pageRevision);
      const [pdata, planData, vdata, page] = await Promise.all([
        canWrite() ? client.get(`/api/categories/${cat.id}/participations`) : Promise.resolve({ participations: [] }),
        client.get(`/api/categories/${cat.id}/plan?include_matches=0`),
        client.get(`/api/events/${eventId}/venues`),
        client.get(`/api/matches?${query}`),
      ]);
      if (!isCurrent() || generation !== loadGeneration) return;
      const participations = pdata.participations, plan = planData.plan, venues = vdata.venues;
      const matches = page.matches;
      allMatches = matches;
      pageRevision = page.list_revision;
      clear(addBox);
      if (canWrite() && !participations.length) {
        addBox.append(h('div.panel', h('div.info-box',
          '该项目还没有参赛主体，请先在项目工作台的“报名名单”中添加参赛学校。',
          h('div.row.mt', h('button.btn.btn-primary', {
            onclick: () => { location.hash = `#/workspace?event=${cat.event_id}&group=${cat.group_id}&category=${cat.id}&tab=registration`; },
          }, '前往报名名单')))));
      } else if (canWrite()) {
        addBox.append(renderAddForm(cat, plan, participations, venues, allMatches, load, nextForm, client));
      } else {
        addBox.append(h('div.panel', h('div.info-box',
          '当前角色只能查看比赛，添加与删除需要编排与成绩人员或管理员。')));
      }

      clear(listBox);
      listBox.append(renderList(cat, matches, load, !!statusFilter, embedded, client, page.total));
      listBox.append(h('div.row.mt',
        h('button.btn', { disabled: !pageOffset, onclick: () => { pageOffset = Math.max(0, pageOffset - 100); load(); } }, '上一页'),
        h('span.small.muted', `第 ${page.total ? pageOffset + 1 : 0}—${pageOffset + matches.length} 场，共 ${page.total} 场`),
        h('button.btn', { disabled: !page.has_more, onclick: () => { pageOffset += 100; load(); } }, '下一页')));
    } catch (e) {
      if (!isCurrent() || generation !== loadGeneration || e.code === 'navigation_cancelled') return;
      if (e.code === 'list_changed') {
        pageOffset = 0; pageRevision = null;
        clear(listBox);
        listBox.append(h('div.panel', h('div.warn-box', '比赛列表已更新，请刷新后继续查看。筛选保持不变。'),
          h('button.btn', { onclick: () => load() }, '刷新列表')));
        return;
      }
      clear(listBox);
      listBox.append(h('div.panel', errorState(e, load)));
    }
  }
}

function renderList(cat, matches, load, filtered = false, embedded = false, client = api, total = matches.length) {
  const panel = h('div.panel', h('h3', `比赛列表（共 ${total} 场，本页 ${matches.length} 场）`));
  if (!matches.length) {
    panel.append(emptyState({
      text: filtered ? '当前状态下没有比赛' : '该项目还没有比赛',
      hint: filtered ? '请选择其他状态或查看全部比赛。'
        : '可以用上方的“添加比赛”手动安排，或到“分组与编排”生成整份赛程。',
    }));
    return panel;
  }
  /* 按阶段分组列出比赛，便于整体清空 */
  const stageMap = new Map();
  for (const m of matches) {
    const key = m.stage_id || 0;
    if (!stageMap.has(key)) stageMap.set(key, []);
    stageMap.get(key).push(m);
  }
  for (const [stageId, list] of stageMap) {
    list.sort(compareScheduledMatches);
    const unstarted = list.filter((m) => m.status !== 'finished').length;
    panel.append(h('div.row.tight.mt',
      h('h4', { style: 'margin:0' }, list[0].stage_name || '未命名阶段'),
      h('span.badge', `${list.length} 场`),
      unstarted ? h('span.badge.badge-warn', `${unstarted} 场未确认`) : null,
      canWrite() && unstarted && stageId
        ? h('button.btn.small', {
          onclick: () => clearStage(stageId, unstarted, load, client),
        }, '清空未确认场次') : null));
    panel.append(h('div.table-scroll', table([
      { label: '轮次', render: (m) => m.round_label },
      {
        label: '对阵',
        render: (m) => `${m.home.label || m.home.type_name} vs ${m.away.label || m.away.type_name}`,
      },
      { label: '场地', render: (m) => m.venue_name || h('span.muted', '未安排') },
      { label: '时间', render: (m) => m.scheduled_at || h('span.muted', '未安排') },
      {
        label: '比分',
        render: (m) => ((m.sets || []).length
          ? m.sets.map((s) => `${s.home_points}:${s.away_points}`).join(' ') : ''),
      },
      { label: '状态', render: (m) => matchStatusBadge(m) },
      { label: '记录员', render: (m) => (m.recorder_name || '未领取') + (m.corrector_name ? `（更正：${m.corrector_name}）` : '') },
      {
        label: '操作',
        render: (m) => h('div.row.tight',
          state.user.role !== 'viewer' && (m.status === 'ready' || m.status === 'finished')
            ? h('button.btn.small', { onclick: () => go('scoring', { match: m.id, category: cat.id,
              ...(embedded ? { from: 'workspace' } : {}) }),
              disabled: m.status === 'ready' && m.can_score === false,
              title: m.status === 'ready' ? m.blocked_reason || '' : '' },
              m.status === 'finished' ? '查看' : m.can_score === false ? '等待方案锁定' : '记录')
            : null,
          canWrite() ? h('button.btn.small', { onclick: () => openSchedule(m, load, client, cat.event_id) }, '场地/时间') : null,
          canWrite() && m.status !== 'finished' ? h('button.btn.small.btn-danger', {
            onclick: () => removeMatch(m, load, client),
          }, '删除') : null),
      },
    ], list)));
  }
  return panel;
}

/* 清空阶段：先给出可删除/不可删除的预览，再执行（§11） */
async function clearStage(stageId, unstarted, load, client = api) {
  let summary;
  try { summary = await client.get(`/api/stages/${stageId}/summary`); }
  catch (e) { toast(e.message, 'error'); return; }
  unstarted = summary.unstarted;
  const ok = await confirmAsync('清空该阶段未确认场次',
    `将删除该阶段 ${unstarted} 场尚未确认的比赛。\n`
    + '已确认成绩的场次会保留；有后续对阵依赖的场次会跳过，结果显示实际删除与跳过数量。',
    '清空');
  if (!ok) return;
  const run = async (extra = {}) => {
    try {
      const res = await client.post(`/api/stages/${stageId}/clear`, { ...extra, list_revision: summary.list_revision });
      toast(res.message, 'ok');
      load();
    } catch (e) {
      if (e.code === 'reason_required') {
        const reason = await askReason('方案已锁定', e.message);
        if (reason) await run({ reason });
        return;
      }
      toast(e.message, 'error');
    }
  };
  await run({});
}

async function removeMatch(m, load, client = api) {
  const ok = await confirmAsync('删除比赛',
    `「${m.round_label}：${m.home.label || ''} vs ${m.away.label || ''}」\n`
    + '已有确认成绩的比赛要先更正或标记取消才能删除。', '删除');
  if (!ok) return;
  const run = async (extra = {}) => {
    try {
      await client.del(`/api/matches/${m.id}`, extra);
      toast('比赛已删除', 'ok');
      load();
    } catch (e) {
      if (e.code === 'reason_required') {
        const reason = await askReason('方案已锁定', e.message);
        if (reason) await run({ reason });
        return;
      }
      toast(e.message, 'error');
    }
  };
  await run({});
}

function renderAddForm(cat, plan, participations, venues, existing, load, nextForm = null, client = api) {
  const options = participations
    .filter((p) => p.status === 'active')
    .map((p) => [p.id, `${p.display}${p.seed_no ? `（${p.seed_no} 号种子）` : ''}`]);
  const stages = plan ? plan.stages : [];
  const stageOptions = [[0, '自定义比赛（默认）']].concat(
    stages.map((s) => [s.id, `${s.seq}. ${s.name}`]));
  const stageSelect = selectInput(stageOptions, nextForm?.stage || 0);
  const roundLabel = textInput(nextForm?.round || '', { placeholder: '请输入轮次名称' });
  const sideOptions = [['', '请选择参赛学校'], ...options];
  const home = selectInput(sideOptions, '');
  home.dataset.nextHome = '1';
  const away = selectInput(sideOptions, '');
  const venue = selectInput([[0, '暂不安排']].concat(venues.map((v) => [v.id, v.name])), nextForm?.venue || 0);
  const when = dateTimeInput('', { style: 'min-width:190px' });
  const note = textInput('', { placeholder: '备注（可选）' });
  const hint = h('div.small.muted.mt', '添加到“自定义比赛”阶段时不需要先生成整份赛程；'
    + '也可以先选择已生成的阶段，把比赛挂到该阶段下（不会改变原有对阵关系）。');
  const conflict = h('div.warn-box.hidden');

  /* 双方不能相同；同队或同场地同开始时间给出冲突提示。
     没有比赛时长数据，所以只做“同一开始时间”的冲突提示，不声称能检测时间重叠（§11）。 */
  function normalize(v) { return String(v || '').replace('T', ' ').slice(0, 16); }
  let conflictGeneration = 0;
  async function checkConflicts() {
    const generation = ++conflictGeneration;
    const messages = [];
    if (home.value && home.value === away.value) messages.push('双方不能是同一支队伍。');
    const at = normalize(when.value);
    if (at) {
      try {
        const query = new URLSearchParams({ category_id: cat.id, scheduled_at: at,
          venue_id: venue.value || 0, home_participation: home.value || 0, away_participation: away.value || 0 });
        const data = await client.get(`/api/matches/schedule-check?${query}`);
        if (generation !== conflictGeneration) return false;
        if (data.total) messages.push(`完整赛程中有 ${data.total} 场同时间安排可能冲突，请核对；保存时服务器将再次校验。`);
      } catch (e) {
        if (generation !== conflictGeneration || e.code === 'navigation_cancelled') return false;
        messages.push('暂时无法预检完整赛程；保存时服务器仍会校验冲突。');
      }
    }
    if (generation !== conflictGeneration) return false;
    clear(conflict);
    messages.forEach((m) => conflict.append(h('div', m)));
    conflict.classList.toggle('hidden', !messages.length);
    return messages.length === 0;
  }
  for (const control of [home, away, venue, when]) {
    control.addEventListener('change', checkConflicts);
  }

  const swap = () => {
    const a = home.value;
    home.value = away.value;
    away.value = a;
    checkConflicts();
  };

  const submit = async (andContinue) => {
    if (!home.value || !away.value) {
      toast('请选择本场比赛的双方学校', 'error');
      (!home.value ? home : away).focus();
      return;
    }
    if (home.value === away.value) {
      checkConflicts();
      toast('双方不能是同一支队伍', 'error');
      return;
    }
    const body = {
      category_id: cat.id,
      home_participation: Number(home.value),
      away_participation: Number(away.value),
      round_label: roundLabel.value.trim() || '自定义比赛',
      note: note.value.trim(),
    };
    if (Number(stageSelect.value)) body.stage_id = Number(stageSelect.value);
    if (Number(venue.value)) body.venue_id = Number(venue.value);
    if (when.value) body.scheduled_at = when.value.replace('T', ' ');
    const send = async (extra = {}) => {
      try {
        const res = await client.post('/api/matches', { ...body, ...extra });
        toast(andContinue
          ? `已添加 ${options.find((o) => String(o[0]) === home.value)?.[1]} vs ${options.find((o) => String(o[0]) === away.value)?.[1]}；请选择下一场双方`
          : res.message, 'ok');
        await load(andContinue ? {
          stage: stageSelect.value, round: roundLabel.value, venue: venue.value,
        } : null);
        if (andContinue) document.querySelector('select[data-next-home]')?.focus();
      } catch (e) {
        if (e.code === 'reason_required') {
          const reason = await askReason('方案已锁定', e.message);
          if (reason) await send({ reason });
          return;
        }
        toast(e.message, 'error');
      }
    };
    await send();
  };

  return h('div.panel',
    h('h3', '按组委会赛程添加比赛'),
    h('div.row',
      field('阶段', stageSelect),
      field('轮次名称', roundLabel),
      field('主队', home),
      h('button.btn', { style: 'align-self:flex-end', onclick: swap, title: '交换双方' }, '⇄'),
      field('客队', away)),
    h('div.row',
      field('场地', venue),
      field('时间', when),
      field('备注', note)),
    conflict,
    h('div.row.mt',
      h('button.btn.btn-primary', { onclick: () => submit(false) }, '添加比赛'),
      h('button.btn', { onclick: () => submit(true) }, '添加并继续')),
    hint);
}

/* 场地与时间安排：短编辑区完成，不刷新整页（§11） */
async function openSchedule(match, load, client = api, eventId = state.eventId) {
  const venues = (await client.get(`/api/events/${eventId}/venues`)).venues;
  const venue = selectInput([[0, '暂不安排']].concat(venues.map((v) => [v.id, v.name])),
    match.venue_id || 0);
  const when = dateTimeInput((match.scheduled_at || '').replace(' ', 'T').slice(0, 16));
  const note = textInput(match.manual_note ?? match.note ?? '');
  formDialog({
    title: `安排场地与时间 · ${match.round_label} 第${match.seq}场`,
    width: 'min(520px, 94vw)',
    sections: [{
      body: h('div.form-grid',
        field('场地', venue, { name: 'venue_id' }),
        field('时间', when, { name: 'scheduled_at', hint: '赛事所在时区的本地时间' }),
        field('备注', note, { name: 'note' })),
    }],
    actions: [{
      label: '保存', primary: true, busyLabel: '保存中…',
      run: async ({ close }) => {
        await client.put(`/api/matches/${match.id}`, {
          venue_id: Number(venue.value) || null,
          scheduled_at: when.value ? when.value.replace('T', ' ') : '',
          note: note.value.trim(),
        });
        toast('已更新场地与时间', 'ok');
        close();
        load();
      },
    }],
  });
}

registerView({
  name: 'matches', label: '比赛管理（增删）', roles: ['admin', 'organizer', 'recorder', 'viewer'], render,
});

/* One schedule, explicit stage sources, on-demand editors. */
import { api, download, captureRequestContext, newUid, openHtml, getToken } from '../api.js';
import { state, registerView, go, replaceViewParams } from '../main.js';
import { workspaceLink } from '../workspaceContext.js';
import { renderGroupDraw } from '../groupDraw.js';
import { renderGroupResult } from '../drawDisplay.js';
import { openAutoSchedule } from '../autoSchedule.js';
import { stageLabel, sourceLabel, rankRange } from '../scheduleStageModel.js';
import { readPendingRequest, writePendingRequest, removePendingRequest, capturePendingRequestScope } from '../pendingRequests.js';
import { h, clear, field, selectInput, textInput, numberInput, dateTimeInput, formDialog,
  modal, toast, confirmAsync, promptDialog, statusBadge, matchStatusBadge, loadingState, errorState, emptyState,
  filteredEmptyState, setPageLeaveGuard } from '../ui.js';

async function render({ el, params, signal, requestContext = captureRequestContext(), isCurrent = () => true }) {
  const alive = () => el.isConnected && !signal?.aborted && isCurrent();
  /* 401 已由全局处理器清会话并回登录页，页面内不再追加错误提示。 */
  const report = (error) => { if (alive() && getToken()) toast(error.message, 'error'); };
  const cat = state.structure?.groups.flatMap(g => g.categories.map(c => ({ ...c, group_id: g.id, event_id: state.eventId })))
    .find(c => c.id === Number(params.category));
  if (!cat) throw new Error('请先选择三人赛项目');
  const canManage = ['admin', 'organizer'].includes(state.user.role);
  const administrator = state.user.role === 'admin';
  const mode = canManage && params.view === 'groups' ? 'groups' : 'fixtures';
  const pendingKey = `schedule:${cat.id}`, pendingScope = capturePendingRequestScope();
  let pending = readPendingRequest(pendingKey, pendingScope), busy = false, autoEditor = null;
  let plan = null, venues = [], pools = [], stageId = Number(params.stage) || null;
  let sort = params.sort === 'schedule' ? 'schedule' : 'round', status = params.status || '', venue = params.venue || '', offset = 0, listRevision = null, generation = 0;
  const body = h('div'), recovery = h('div');
  const client = {
    get: path => api.get(path, { context: requestContext, signal }),
    post: (path, body) => write('post', path, body),
    put: (path, body) => write('put', path, body),
    del: (path, body) => write('del', path, body),
  };
  setPageLeaveGuard(async () => {
    if (busy) return false;
    if (autoEditor && !await autoEditor.canLeave()) return false;
    return !pending || await confirmAsync('提交结果待核实', '原请求已保存。离开后可返回此项目核实并重试，核实前不能提交另一份操作。', '离开并保留原请求');
  }, () => !!pending || busy || !!autoEditor?.isDirty(), alive);
  el.append(recovery, body);

  async function send(packet) {
    busy = true;
    try {
      const result = await api[packet.method](packet.path, packet.body, { context: {
        ...requestContext, identity: packet.body.event_identity, user_id: packet.owner_id,
      } });
      removePendingRequest(pendingKey, pendingScope); pending = readPendingRequest(pendingKey, pendingScope);
      return result;
    } catch (error) {
      if (!error.outcome_unknown) { removePendingRequest(pendingKey, pendingScope); pending = readPendingRequest(pendingKey, pendingScope); }
      else error.message = '操作结果待核实，请用页面上的“核实并重试原操作”恢复；原内容已保留。';
      throw error;
    } finally { busy = false; if (alive()) renderRecovery(); }
  }
  async function write(method, path, values = {}) {
    if (!alive()) throw new Error('页面已切换，请返回原项目核对');
    if (busy || pending) throw new Error('请先核实原操作结果，再继续修改赛程');
    const packet = { request_uid: newUid('schedule'), method, path, owner_id: requestContext.user_id,
      body: { ...values, event_identity: requestContext.identity, request_uid: newUid('stage') } };
    packet.request_uid = packet.body.request_uid;
    if (!writePendingRequest(pendingKey, packet, pendingScope)) throw new Error('无法保存恢复请求，请检查浏览器存储后重试');
    pending = packet;
    return send(packet);
  }
  function renderRecovery() {
    clear(recovery);
    if (!pending) return;
    recovery.append(h('div.panel', h('div.warn-box', '有一份赛程操作结果待核实。请核实原请求后继续。'),
      h('button.btn.mt', { disabled: busy, onclick: async () => {
        try { await send(pending); if (alive()) { toast('原操作已核实', 'ok'); await load(); } }
        catch (e) { report(e); }
      } }, '核实并重试原操作')));
  }
  async function load() {
    const gen = ++generation;
    clear(body); body.append(loadingState('正在读取赛程…'));
    try {
      const [schedule, venueData] = await Promise.all([client.get(`/api/categories/${cat.id}/schedule`), client.get(`/api/events/${cat.event_id}/venues`)]);
      if (!alive() || gen !== generation) return;
      plan = schedule.plan; venues = venueData.venues; pools = (plan?.stages || []).flatMap(s => s.pools).filter(p => p.kind === 'group');
      clear(body); renderRecovery();
      if (mode === 'groups') {
        const drawData = await client.get(`/api/categories/${cat.id}/group-draw`);
        if (!alive() || gen !== generation) return;
        body.append(renderGroupDraw(cat, drawData, draw => { if (draw?.status === 'confirmed') load(); }, { client,
            isCurrent: () => alive() && gen === generation, plan, readPlan: () => client.get(`/api/categories/${cat.id}/schedule`),
            openNotice: path => openHtml(path, {}, '小组抽签分组表', { context: requestContext, isCurrent: alive }) }));
        if (drawData.manual_result?.status === 'current' || drawData.draw?.status === 'confirmed') body.append(h('a.btn.mt', { href: workspaceLink(cat, 'schedule') }, '进入赛程'));
        return;
      }
      if (canManage && !plan?.stages.some(s => s.kind === 'round_robin')) {
        const drawData = await client.get(`/api/categories/${cat.id}/group-draw`);
        if (!alive() || gen !== generation) return;
        if (drawData.manual_result?.status === 'current' || drawData.draw?.status === 'confirmed') {
          body.append(h('div.panel', h('h3', '将确认分组用于小组赛'), h('p.muted', '建立小组赛阶段和正式成员后，按组委会赛程逐场新增比赛。'),
            h('button.btn.btn-primary', { onclick: async () => {
              try { const result = await client.post(`/api/categories/${cat.id}/schedule/stages`, { base_revision: 0,
                definition: { purpose: 'group', name: '小组赛', ...(drawData.manual_result
                  ? { manual_revision: drawData.manual_result.revision } : { draw_id: drawData.draw.id }) } });
                if (alive()) { stageId = result.stage_id; await load(); await openPreview(result.stage_id, result.revision); }
              } catch (e) { report(e); }
            } }, '建立小组赛阶段')));
        } else body.append(h('div.panel', h('p.muted', '尚未确认学校分组。可先完成分组，再建立小组赛阶段；手工比赛仍可按组委会安排录入。'),
          h('a.btn', { href: workspaceLink(cat, 'groups') }, '前往分组')));
      }
      const stages = plan?.stages || [];
      stageId = stages.some(s => s.id === stageId) ? stageId : stages[0]?.id || null;
      rememberPosition();
      const stage = stages.find(s => s.id === stageId);
      body.append(h('details.panel.schedule-group-display', h('summary', '分组显示'), renderGroupResult(cat, plan, schedule),
        h('button.btn.small', { onclick: () => load() }, '刷新分组显示')));
      body.append(h('div.schedule-heading', h('h3', '比赛赛程'),
        canManage ? h('div.row.tight', h('button.btn.btn-primary', { onclick: () => {
          if (!guardClose()) return;
          generation++;
          autoEditor = openAutoSchedule({ root: body, category: cat, plan, venues, initialStage: stageId, event: state.structure?.event,
            client, previewRequest: (path, values) => api.post(path, values, { context: requestContext, signal }), isCurrent: alive,
            onBack: () => { autoEditor = null; load(); }, onSaved: () => { autoEditor = null; sort = 'schedule'; load(); } });
        } }, '自动编排'), h('button.btn', { onclick: () => openSettings() }, '设置后续赛程'),
          h('button.btn.btn-primary', { onclick: () => openAdd() }, '新增比赛'),
          h('button.btn', { onclick: () => download('/api/exports/schedule.csv',
            { category_id: cat.id }, 'schedule.csv', { isCurrent: alive }).catch(report) }, '本项目赛程 CSV'),
          h('button.btn', { onclick: () => download('/api/exports/schedule.csv',
            { event_id: cat.event_id }, 'schedule.csv', { isCurrent: alive }).catch(report) }, '全部赛程 CSV（整届）')) : null));
      body.append(h('nav.schedule-stages', { 'aria-label': '比赛阶段' }, ...stages.map(item => h('button', {
        class: `btn${stageId === item.id ? ' active' : ''}`, onclick: () => { stageId = item.id; offset = 0; listRevision = null; load(); },
      }, stageLabel(item), item.params?.schedule_meta?.state === 'draft' ? ' · 草稿' : ''))));
      const filters = h('div.schedule-filters', field('排列方式', selectInput([['round', '按轮次'], ['schedule', '按时间']], sort,
        { onchange: e => { sort = e.target.value; resetPage(); } })),
        field('状态', selectInput([['', '全部状态'], ['pending', '等待前序'], ['ready', '待记录'], ['finished', '已确认']], status,
          { onchange: e => { status = e.target.value; resetPage(); } })),
        field('场地', selectInput([['', '全部场地'], ...venues.map(v => [v.id, v.name])], venue,
          { onchange: e => { venue = e.target.value; resetPage(); } })));
      body.append(filters);
      if (stage?.params?.schedule_meta && canManage) {
        const data = stage.params.schedule_meta;
        body.append(h('div.schedule-stage-state', statusBadge(data.state === 'draft' ? '阶段草稿' : '阶段已确认', data.state === 'draft' ? 'warn' : 'ok'),
          h('span.small.muted', data.definition.purpose === 'knockout' ? '各组前两名晋级 · 相邻组同名次首轮 · 完整决出第1—4名'
            : data.definition.purpose === 'placement' ? `各组第${data.definition.source_rank}名 · 决出第${data.definition.rank_from}—${data.definition.rank_to}名` : '逐场录入组委会赛程'),
          h('div.row.tight', data.state === 'draft' ? [data.definition.purpose !== 'group' ? h('button.btn.small', { onclick: () => openSettings(stage) }, '编辑设置') : null,
            h('button.btn.small', { onclick: () => openPreview(stage.id, data.revision) }, '核对阶段'),
            h('button.btn.small', { onclick: async () => { if (await confirmAsync('删除阶段草稿', `删除“${stage.name}”草稿？`, '删除')) {
              try { await client.del(`/api/schedule-stages/${stage.id}`, { category_id: cat.id, base_revision: data.revision }); await load(); } catch (e) { report(e); }
            } } }, '删除草稿')] : administrator ? h('button.btn.small', { onclick: () => retract(stage) }, '撤回确认') : null)));
      }
      const list = h('div.schedule-match-list'); body.append(list);
      const query = new URLSearchParams({ category_id: cat.id, offset, limit: 100, with_sets: 1, sort });
      if (stageId) query.set('stage_id', stageId);
      if (status) query.set('status', status);
      if (venue) query.set('venue_id', venue);
      if (offset && listRevision !== null) query.set('list_revision', listRevision);
      const page = await client.get(`/api/matches?${query}`);
      if (!alive() || gen !== generation) return;
      listRevision = page.list_revision;
      if (!page.matches.length) {
        if (status || venue) list.append(filteredEmptyState(() => { status = ''; venue = ''; resetPage(); }));
        else list.append(emptyState({ text: stage?.params?.schedule_meta?.state === 'draft' ? '核对并确认阶段后显示正式比赛' : '当前没有比赛',
          hint: '先在“分组”确认学校分组，再在“赛程”建立小组赛阶段并新增比赛。' }));
      } else renderMatches(list, page.matches, stage);
      if (page.total > 100) body.append(h('div.row.mt', h('button.btn', { disabled: !offset, onclick: () => { offset = Math.max(0, offset - 100); load(); } }, '上一页'),
        h('span.small.muted', `${offset + 1}—${offset + page.matches.length} / ${page.total}`), h('button.btn', { disabled: !page.has_more, onclick: () => { offset += 100; load(); } }, '下一页')));
    } catch (error) {
      if (!alive() || gen !== generation) return;
      if (!getToken()) return;         // 401 已由全局处理器回到登录页
      clear(body); body.append(errorState(error, () => { offset = 0; listRevision = null; load(); }));
    }
  }
  function resetPage() { offset = 0; listRevision = null; load(); }
  function rememberPosition() {
    if (alive()) replaceViewParams({ event: cat.event_id, group: cat.group_id, category: cat.id, tab: 'schedule',
      stage: stageId || null, sort, status: status || null, venue: venue || null });
  }
  function renderMatches(root, matches, stage) {
    const groups = new Map();
    for (const match of matches) {
      const key = sort === 'round' ? `${match.round_no} · ${match.round_label}` : match.scheduled_at?.slice(0, 10) || '时间待安排';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(match);
    }
    const grid = h(`div.${sort === 'round' && ['single_elim', 'placement'].includes(stage?.kind) ? 'schedule-rounds' : 'schedule-round-list'}`);
    for (const [label, rows] of groups) grid.append(h('section.schedule-round', h('div.schedule-round-title', h('h4', label), h('span.small.muted', `${rows.length} 场`)), ...rows.map(match => {
      const destinations = [];
      for (const target of match.destinations || []) destinations.push(`${target.source_type === 'match_winner' ? '胜者' : '负者'} → ${target.public_code}`);
      if (match.winner_rank) destinations.push(`胜者第${match.winner_rank}名 · 负者第${match.loser_rank}名`);
      return h('article.schedule-match', { 'data-match-id': match.id }, h('div.schedule-match-heading', h('strong', match.public_code), matchStatusBadge(match)),
        ...['home', 'away'].map(side => h('div.schedule-side', h('div', h('strong', match[side].label || match[side].source_label || '待确定'),
          match[side].label && match[side].source_label ? h('div.small.muted', match[side].source_label) : null),
          h('span.schedule-score', match.sets?.length ? match.sets.filter(s => s.winner_side === side).length : '—'))),
        destinations.length ? h('p.small.schedule-destinations', destinations.join('；')) : null,
        h('div.small.muted', `${match.venue_name || '场地待安排'} · ${match.scheduled_at || '时间待安排'}`),
        match.recorder_name ? h('div.small.muted', `记录员：${match.recorder_name}${match.corrector_name ? ` · 更正：${match.corrector_name}` : ''}`) : null,
        canManage ? h('div.row.tight.mt', h('button.btn.small', { onclick: () => openTime(match) }, '调整场地时间'),
          !['single_elim', 'placement'].includes(stage?.kind) && match.status !== 'finished'
            ? h('button.btn.small', { onclick: async () => { if (await confirmAsync('删除比赛', `删除 ${match.public_code}？已领取、计分或存在后续依赖时不能删除。`, '删除')) {
              try { await client.del(`/api/matches/${match.id}`, { category_id: cat.id }); await load(); } catch (e) { report(e); }
            } } }, '删除') : null) : null);
    })));
    root.append(grid);
  }
  async function retract(stage) {
    const reason = await promptDialog({ title: '撤回阶段确认', label: '撤回原因', required: true, multiline: true,
      hint: `将移除本阶段 ${stage.match_count} 场未开始比赛。有领取、计分、成绩或其他阶段依赖时不能撤回。`, okLabel: '撤回确认' });
    if (!reason || !alive()) return;
    try { await client.post(`/api/schedule-stages/${stage.id}/unconfirm`, { base_revision: stage.params.schedule_meta.revision, reason }); await load(); }
    catch (e) { report(e); }
  }
  function guardClose() { if (pending || busy) { toast('请先核实原操作结果；原请求已保留，也可刷新页面继续核实。', 'warn'); return false; } return true; }
  async function openSettings(stage = null) {
    const definition = stage?.params.schedule_meta.definition;
    const purpose = selectInput([['knockout', '淘汰赛（各组前两名）'], ['placement', '名次赛（各组同名次对阵）'], ['manual', '手工比赛阶段']], definition?.purpose || 'knockout');
    const name = textInput(definition?.name || '淘汰赛');
    const sourceRank = selectInput([[1, '各组第一名'], [2, '各组第二名'], [3, '各组第三名'], [4, '各组第四名']], definition?.source_rank || 3);
    const from = numberInput(definition?.rank_from || '', { min: 1, step: 1 }), to = numberInput(definition?.rank_to || '', { min: 1, step: 1 });
    const choices = pools.map(p => ({ p, input: h('input', { type: 'checkbox',
      checked: definition?.purpose !== 'placement' || definition.pool_ids?.includes(p.id), 'data-field': `pool-${p.id}` }) }));
    const knockout = h('div.schedule-settings-summary', h('strong', '全部小组前两名晋级'),
      h('div.schedule-settings-tags', ...pools.map(p => h('span', `${p.name}前两名`))));
    const groupChoices = h('fieldset.schedule-settings-groups', h('legend', '参赛小组'),
      h('div.schedule-pool-options', ...choices.map(({ p, input }) => h('label', input, p.name))));
    const placement = h('div.schedule-settings-placement', field('来源名次', sourceRank, { name: 'source_rank' }), groupChoices,
      h('div.form-grid', field('起始名次', from, { name: 'rank_from', required: true }), field('结束名次', to, { name: 'rank_to', required: true })));
    const manual = h('p.small.muted', '建立阶段后，按组委会赛程逐场新增比赛并安排场地和时间。');
    const warning = h('div.warn-box', { role: 'status' }, `至少需要两个已确认的正式小组。当前 ${pools.length} 个，请先在“分组”完成小组设置。`);
    let dialog, previousPurpose = purpose.value;
    const names = { knockout: '淘汰赛', placement: '名次赛', manual: '手工比赛' };
    const update = () => {
      const isPlacement = purpose.value === 'placement';
      knockout.hidden = purpose.value !== 'knockout'; placement.hidden = !isPlacement; manual.hidden = purpose.value !== 'manual';
      for (const control of placement.querySelectorAll('input,select,fieldset')) control.disabled = !isPlacement;
      warning.hidden = purpose.value === 'manual' || pools.length >= 2;
      dialog?.setActionDisabled(0, !warning.hidden);
    };
    purpose.onchange = () => {
      if (name.value === names[previousPurpose]) name.value = names[purpose.value];
      previousPurpose = purpose.value; update();
    };
    dialog = formDialog({ title: stage ? '编辑阶段设置' : '设置后续赛程', width: 'min(680px,94vw)', onBeforeClose: guardClose,
      sections: [{ body: h('div.schedule-settings', h('div.form-grid', field('阶段用途', purpose, { name: 'purpose' }), field('阶段名称', name, { name: 'name', required: true })),
        knockout, placement, manual, warning) }],
      actions: [{ label: '保存并预览', primary: true, run: async ({ close }) => {
        if (!alive()) throw new Error('页面已切换，请返回原项目核对');
        if (!name.value.trim()) throw new Error('请填写阶段名称');
        if (purpose.value !== 'manual' && pools.length < 2) throw new Error('至少需要两个已确认的正式小组');
        const value = { purpose: purpose.value, name: name.value.trim() };
        if (purpose.value === 'knockout') value.pool_ids = pools.map(p => p.id);
        if (purpose.value === 'placement') {
          const ids = choices.filter(c => c.input.checked).map(c => c.p.id);
          if (ids.length < 2) throw new Error('请成对选择至少两个相邻小组');
          for (let i = 0; i < pools.length; i += 2) {
            if (pools[i + 1] && ids.includes(pools[i].id) !== ids.includes(pools[i + 1].id)) throw new Error('请成对选择相邻小组，例如A/B或C/D');
          }
          Object.assign(value, { pool_ids: ids, source_rank: Number(sourceRank.value) }, rankRange(ids.length, Number(from.value), Number(to.value)));
        }
        const result = stage ? await client.put(`/api/schedule-stages/${stage.id}`, { base_revision: stage.params.schedule_meta.revision, definition: value })
          : await client.post(`/api/categories/${cat.id}/schedule/stages`, { base_revision: 0, definition: value });
        if (alive()) { close(); stageId = result.stage_id; await load(); await openPreview(result.stage_id, result.revision); }
      } }] });
    update();
  }
  async function openPreview(id, revision) {
    try {
      const preview = await client.post(`/api/schedule-stages/${id}/preview`, { base_revision: revision });
      if (!alive()) return;
      const graph = preview.graph;
      const byeCheck = h('input', { type: 'checkbox' });
      const detail = h('div.schedule-preview', h('p', graph.purpose === 'knockout' ? '各组前两名晋级，分别决出冠亚军和三四名。'
        : graph.purpose === 'placement' ? `本阶段决出第${graph.rank_from}—${graph.rank_to}名。` : '阶段确认后，可按组委会赛程逐场新增比赛。'),
        ...graph.matches.map(m => h('div.schedule-preview-row', h('strong', `第${m.key.slice(1)}场 · ${m.round_label}`),
          h('span', `${sourceLabel(m.home, pools)} 对 ${sourceLabel(m.away, pools)}`),
          m.winner_rank ? h('span.small.muted', `胜者第${m.winner_rank}名，负者第${m.loser_rank}名`) : null)),
        ...graph.groups?.map(p => h('p', `${p.name}：${p.members.length} 所学校`)) || [],
        graph.byes.length ? h('div.warn-box', h('strong', '请明确核对轮空安排'),
          ...graph.byes.map(b => h('p', `第${b.round_no}轮：${sourceLabel(b.source, pools)}轮空`)), h('label', byeCheck, '我已核对以上轮空位置')) : null);
      modal({ title: `核对阶段 · ${graph.name}`, body: detail, width: 'min(760px,94vw)', buttons: administrator ? [{ label: '确认正式赛程', class: 'btn-primary', onClick: async () => {
        if (graph.byes.length && !byeCheck.checked) throw new Error('请先核对并勾选轮空确认');
        await client.post(`/api/schedule-stages/${id}/confirm`, { base_revision: revision, definition_hash: preview.definition_hash,
          basis_hash: preview.basis_hash, approved_byes: graph.byes });
        if (alive()) { stageId = id; toast('阶段已确认', 'ok'); await load(); }
      } }] : [] });
    } catch (e) { report(e); }
  }
  async function openAdd() {
    const participations = (await client.get(`/api/categories/${cat.id}/participations`)).participations.filter(p => p.status === 'active');
    if (!alive()) return;
    const stages = (plan?.stages || []).filter(s => s.kind === 'custom' || s.params?.schedule_meta?.definition.purpose === 'group');
    const stage = selectInput([[0, '手工比赛'], ...stages.map(s => [s.id, s.name])], stages.find(s => s.id === stageId)?.id || 0);
    const pool = selectInput([['', '请选择小组']], '');
    const home = selectInput([['', '请选择学校']], ''), away = selectInput([['', '请选择学校']], '');
    const round = textInput('', { placeholder: '例如 小组赛第1轮' });
    const venue = selectInput([[0, '暂不安排'], ...venues.map(v => [v.id, v.name])], 0), when = dateTimeInput('');
    function updateSchools() {
      const current = stages.find(s => s.id === Number(stage.value));
      const group = current?.kind === 'round_robin'; pool.closest('label').hidden = !group;
      const members = new Set(current?.pools.find(p => p.id === Number(pool.value))?.members.map(m => m.participation_id));
      const options = participations.filter(p => !group || members.has(p.id)).map(p => [p.id, p.display]);
      for (const select of [home, away]) { clear(select); select.append(...selectInput([['', '请选择学校'], ...options], '').children); }
    }
    stage.onchange = () => { const s = stages.find(s => s.id === Number(stage.value)); clear(pool); pool.append(...selectInput([['', '请选择小组'], ...(s?.pools || []).map(p => [p.id, p.name])], '').children); updateSchools(); };
    pool.onchange = updateSchools;
    const section = h('div.form-grid', field('阶段', stage, { name: 'stage' }), field('小组', pool, { name: 'pool' }), field('轮次名称', round, { name: 'round' }),
      field('主队', home, { name: 'home', required: true }), field('客队', away, { name: 'away', required: true }), field('场地', venue, { name: 'venue' }), field('时间', when, { name: 'time' }));
    stage.onchange();
    formDialog({ title: '新增比赛', onBeforeClose: guardClose, sections: [{ body: section }], actions: [{ label: '添加比赛', primary: true, run: async () => {
      if (!home.value || !away.value || home.value === away.value) throw new Error('请选择不同的双方学校');
      const value = { category_id: cat.id, stage_id: Number(stage.value) || null, pool_id: Number(pool.value) || null,
        home_participation: Number(home.value), away_participation: Number(away.value), round_label: round.value.trim() || '手工比赛',
        venue_id: Number(venue.value) || null, scheduled_at: when.value.replace('T', ' ') };
      const result = await client.post('/api/matches', value);
      if (alive()) { stageId = result.stage_id; await load(); }
    } }] });
  }
  /* 调整场地时间：409 stale_revision 时保留输入，展示“重新读取最新安排”动作；
     重新读取后再用最新版本 + 用户原输入重开编辑框，避免用户重填。 */
  function openTime(match, preserved = null) {
    const venue = selectInput([[0, '暂不安排'], ...venues.map(v => [v.id, v.name])],
      preserved?.venue ?? match.venue_id ?? 0);
    const time = dateTimeInput((preserved?.time ?? (match.scheduled_at || '')).replace(' ', 'T'));
    const note = textInput(preserved?.note ?? match.manual_note ?? '');
    const current = () => ({ venue: venue.value, time: time.value, note: note.value });
    let dialog = null;
    const stale = h('div.warn-box.hidden.mt', { role: 'alert' },
      h('div', '比赛安排已被其他操作更新，当前保存未生效。'),
      h('div.small.muted', '请先重新读取最新安排，核对后再保存；你的输入会保留。'),
      h('button.btn.mt', { onclick: async () => {
        const kept = current();
        dialog?.close();
        try {
          await load();
          if (!alive()) return;
          const fresh = (await client.get(`/api/matches/${match.id}`)).match;
          if (!alive()) return;
          openTime(fresh, kept);
        } catch (error) { report(error); }
      } }, '重新读取最新安排'));
    dialog = formDialog({ title: `调整场地时间 · ${match.public_code}`, onBeforeClose: guardClose, width: 'min(520px,94vw)',
      sections: [{ body: h('div', h('div.form-grid',
        field('场地', venue, { name: 'venue_id' }), field('时间', time, { name: 'scheduled_at' }), field('备注', note, { name: 'note' })),
        stale) }],
      actions: [{ label: '保存安排', primary: true, keepOpen: true, run: async ({ close }) => {
        try {
          await client.put(`/api/matches/${match.id}`, { venue_id: Number(venue.value) || null,
            scheduled_at: time.value.replace('T', ' '), note: note.value.trim(), base_schedule_revision: match.schedule_revision });
        } catch (error) {
          if (error.code === 'stale_revision') {
            stale.classList.remove('hidden');
            stale.scrollIntoView({ block: 'nearest' });
            return;
          }
          throw error;
        }
        stale.classList.add('hidden');
        close();
        if (alive()) await load();
      } }] });
    return dialog;
  }
  await load();
}

registerView({ name: 'schedule', label: '比赛赛程', roles: ['admin', 'organizer', 'viewer'], render });

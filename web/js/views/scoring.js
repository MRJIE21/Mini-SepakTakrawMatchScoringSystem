import { transferButton } from '../recordingOwner.js';
import { compareScheduledMatches } from '../dateTime.js';
/* 三人赛记录页：逐分记录、撤回、本地保存、核对与提交（设计大纲 4.2、6.1、6.3）。 */
import { api, newUid, openHtml, getApiEventContext, captureRequestContext, recordRequestContext, validateReceipt } from '../api.js';
import { registerView, state, go, submitWithRetry } from '../main.js';
import { localStore, deviceName } from '../store.js';
import {
  h, field, textInput, selectInput, table, toast, modal, confirmDialog, clear, statusBadge,
  matchStatusBadge, fmtDateTime, task, categoryLabel, confirmAsync, setPageLeaveGuard,
} from '../ui.js';
import { addPoint, summarize, undoEvent, isSetOpen, SET_CAP } from '../scoring.js';
import { buildMatchPayload } from '../submit.js';
import { syncDisplaySnapshot, stopDisplaySync } from '../displaySync.js';
import { DEFAULT_RULES, normalizeRules, rulesSummary, sameRules, setsToWin } from '../teamRules.js';

const canScore = () => ['admin', 'organizer', 'recorder'].includes(state.user.role);
const DRAFT_STATUS = {
  waiting: ['等待手动开局', 'warn'],
  recording: ['记录中', 'info'],
  review: ['已结束待核对', 'warn'],
  submitting: ['提交中', 'info'],
  failed: ['提交失败待重试', 'danger'],
  submitted: ['已提交', 'ok'],
  received: ['已接收，待独立复核', 'warn'],
};

async function render({ el, params, refresh }) {
  if (!state.eventId) throw new Error('请先在“赛事概览”中创建赛事');
  /* 从“开始记录”进入时直接打开独立记录台。旧实现先画完整队列，再把记录台
     追加到页面最底部，点击后视口没有变化，看起来像按钮失效；队列请求失败还会
     连带阻止已知场次打开。 */
  if (params.match) {
    el.append(await renderConsole(Number(params.match), el, params));
    return;
  }
  const filter = { category: params.category || '' };
  const embedded = params.embedded === 'workspace';
  const query = new URLSearchParams();
  query.set('offset', '0'); query.set('limit', '100');
  if (filter.category) query.set('category_id', filter.category);
  const identity = getApiEventContext();
  const identityKey = `${identity?.deployment_id || 'unknown'}:${identity?.event_uuid || 'unidentified'}`;
  const queueKey = `${identityKey}:package:queue-${filter.category || 'all'}`;
  const uiKey = `${identityKey}:queue-ui:${filter.category || 'all'}`;
  let ui = {};
  try { ui = JSON.parse(localStorage.getItem(uiKey)) || {}; } catch { /* 使用默认筛选 */ }
  if (params.status) ui.status = params.status;
  const saveUi = () => localStorage.setItem(uiKey, JSON.stringify(ui));
  if (ui.q) query.set('q', ui.q);
  if (ui.status) query.set('status', ui.status);
  if (ui.venue) query.set('venue_id', ui.venue);
  let page = { offset: 0, total: 0, has_more: false }, filterGeneration = 0;
  let listOffline = false;
  let list;
  let lastUpdated = '';
  try {
    page = await api.get(`/api/scoring/queue?event_id=${state.eventId}&${query}`);
    list = page.matches;
    lastUpdated = new Date().toISOString();
    await localStore.put({ key: queueKey, kind: 'package', saved_at: lastUpdated, matches: list });
  } catch (err) {
    if (!err.offline) throw err;
    const cached = await localStore.get(queueKey);
    if (!cached || !cached.matches) throw err;
    list = cached.matches;
    lastUpdated = cached.saved_at || '';
    listOffline = true;
  }
  list = list.filter((m) => !filter.category || Number(m.category_id) === Number(filter.category));

  el.append(h('div.panel',
    h('div.panel-head',
      embedded ? h('h3', '待记录场次') : h('h2', '三人赛记录'),
      h('div.row.tight',
        h('button.btn', { onclick: () => refresh() }, '刷新场次'),
      )),
    h('div.small.muted', '比赛过程中逐分记录并保存在本机；单场结束后核对并提交完整得分过程和最终结果。'
      + '每场按对应项目规则计分，领取后规则固定。'),
    h('div.small.muted.mt', `列表更新于 ${fmtDateTime(lastUpdated)}`),
    listOffline ? h('div.warn-box.mt',
      '当前离线：下方为最近一次成功载入的场次列表，可继续记录，恢复联网后再提交。') : null,
  ));

  let rows = list;
  const taskRank = (m) => m.status === 'ready' ? 0 : 1;
  rows.sort((a, b) => taskRank(a) - taskRank(b)
    || compareScheduledMatches(a, b));
  let venues = [...new Map(rows.filter((m) => m.venue_id).map((m) => [m.venue_id, { id: m.venue_id, name: m.venue_name }])).values()];
  try { venues = (await api.get(`/api/events/${state.eventId}/venues`)).venues; } catch (error) { if (error.cancelled) throw error; }
  const search = textInput(ui.q || '', { type: 'search', placeholder: '搜索队伍、学校或轮次',
    'aria-label': '搜索场次' });
  const venue = selectInput([['', '全部场地'], ...venues.map((v) => [v.id, v.name])], ui.venue || '',
    { 'aria-label': '比赛场地' });
  if (!venues.some((v) => String(v.id) === String(ui.venue))) venue.value = '';
  if (!['', 'ready', 'finished'].includes(ui.status || '')) ui.status = '';
  const status = selectInput([['', '全部状态'], ['ready', '待开始'], ['finished', '已确认']], ui.status || '', { 'aria-label': '场次状态' });
  const results = h('div.match-queue-results');
  const requestContext = captureRequestContext();
  const pager = h('div.row.tight.mt');
  const update = async (fetchPage = false, offset = 0) => {
    ui = { ...ui, q: search.value, venue: venue.value, status: status.value };
    saveUi();
    if (fetchPage) {
      const generation = ++filterGeneration;
      const params = new URLSearchParams({ event_id: state.eventId, offset, limit: 100 });
      if (filter.category) params.set('category_id', filter.category);
      if (ui.q) params.set('q', ui.q);
      if (ui.venue) params.set('venue_id', ui.venue);
      if (ui.status) params.set('status', ui.status);
      if (offset && page.list_revision != null) params.set('list_revision', page.list_revision);
      try {
        const response = await api.get(`/api/scoring/queue?${params}`, { context: requestContext });
        if (generation !== filterGeneration || !results.isConnected) return;
        page = response; rows = response.matches; listOffline = false;
      } catch (error) {
        if (error.code === 'list_changed') return update(true, 0);
        if (!error.cancelled) toast(error.message, 'error'); return;
      }
    }
    const shown = rows;
    clear(results);
    if (!shown.length) {
      results.append(h('div.info-box', '当前筛选条件没有匹配的场次。',
        h('button.btn.small.mt', { onclick: () => {
          search.value = ''; venue.value = ''; status.value = ''; update(true);
        } }, '清除筛选')));
      clear(pager); return;
    }
    results.append(h('h3', `场次列表（本页 ${shown.length} / 共 ${page.total || rows.length}）`),
      h('div.table-scroll.match-queue-scroll', table([
    {
      label: '比赛对阵', cellClass: 'match-queue-opponents',
      render: (m) => h('div.match-queue-subject',
        h('b', `${m.home.label || m.home.type_name} vs ${m.away.label || m.away.type_name}`),
        h('span.small.muted', `${m.group_name} · ${categoryLabel(m)} · ${m.round_label}（第${m.seq}场）`)),
    },
    { label: '时间与场地', cellClass: 'match-queue-schedule', render: (m) => h('div.match-queue-subject',
      h('span', m.scheduled_at ? fmtDateTime(m.scheduled_at) : '时间未安排'),
      h('span.small.muted', m.venue_name || '场地未安排')) },
    { label: '记录状态', cellClass: 'match-queue-status', render: (m) => h('div.match-queue-subject',
      matchStatusBadge(m), h('span.small.muted', m.recorder_name ? `记录员：${m.recorder_name}` : '记录员未领取'),
      m.status === 'ready' && m.can_score === false ? h('span.small.muted', m.blocked_reason || '暂不可记录') : null) },
    {
      label: '操作', cellClass: 'match-queue-actions',
      render: (m) => h('button.btn.small' + (m.status === 'ready' ? '.btn-primary' : ''), {
        disabled: m.status === 'ready' && m.can_score === false,
        title: m.status === 'ready' ? m.blocked_reason || '' : '',
        onclick: () => {
          ui.scrollY = window.scrollY; saveUi();
          go('scoring', { match: m.id, category: filter.category,
            ...(embedded ? { from: 'workspace' } : {}) });
        },
      }, m.status === 'ready' && m.can_score === false ? '暂不可记录'
        : m.status === 'ready' && m.recorder_id && m.recorder_id !== state.user.id ? '查看任务'
          : m.status === 'finished' ? '查看成绩' : '开始记录'),
    },
  ], shown, { class: 'scoring-match-table', responsive: true })));
    clear(pager);
    pager.append(h('button.btn', { disabled: !page.offset, onclick: () => update(true, Math.max(0, page.offset - 100)) }, '上一页'),
      h('button.btn', { disabled: !page.has_more, onclick: () => update(true, page.offset + 100) }, '下一页'));
  };
  let searchTimer;
  for (const control of [search, venue, status]) {
    control.addEventListener(control === search ? 'input' : 'change', () => {
      clearTimeout(searchTimer); searchTimer = setTimeout(() => update(true), control === search ? 180 : 0);
    });
  }
  el.append(h('div.panel.match-queue-panel',
    h('div.match-queue-filters', field('查找场次', search), field('场地', venue), field('状态', status)), results, pager));
  update();
  if (!embedded && ui.scrollY) requestAnimationFrame(() => window.scrollTo(0, ui.scrollY));

}

/* ------------------------------------------------------------------ 记录台 */
async function renderConsole(matchId, container, params) {
  const requestContext = captureRequestContext();
  const identity = getApiEventContext();
  const identityKey = `${identity?.deployment_id || 'unknown'}:${identity?.event_uuid || 'unidentified'}`;
  const panel = h('div.panel');
  let pkg = null;
  let offline = false;
  try {
    pkg = await api.get(`/api/scoring/match/${matchId}`);
    await localStore.put({ key: `${identityKey}:package:${matchId}`, kind: 'package', event_identity: identity, saved_at: Date.now(), pkg });
  } catch (err) {
    if (!err.offline) throw err;
    const cached = await localStore.get(`${identityKey}:package:${matchId}`);
    if (!cached || !cached.pkg) throw err;
    pkg = cached.pkg;
    offline = true;
  }
  let match = pkg.match;
  const key = `${identityKey}:match:${matchId}`;
  let draft = await localStore.get(key);
  if (draft) draft.request_context = recordRequestContext(draft);
  let recoveryNotice = '';
  if (draft && (draft.status === 'submitting' || draft.submission_unknown)) {
    draft.status = 'failed';
    draft.submission_unknown = true;
    recoveryNotice = '上次提交结果尚未核实。可以重试原提交，服务器会避免重复保存。';
    try {
      const found = await api.get(`${draft.payload?.payload_schema===3?'/api/candidate-receipts/':'/api/receipts/'}${encodeURIComponent(draft.uid)}`, { context: draft.request_context || requestContext });
      if (found.found && draft.payload) {
        const receipt = await validateReceipt(found, draft.payload, 'match', matchId);
        match = (await api.get(`/api/scoring/match/${matchId}`)).match;
        if (await localStore.finalize(draft, receipt)) {
          if(receipt.receipt_kind!=='candidate_received')draft=null;
          toast(receipt.receipt_kind==='candidate_received'?'已核实候选接收，原件只读保留':'已核实上次正式回执', 'ok');
        }
      }
    } catch { /* Preserve the original packet when its receipt cannot be verified. */ }
  }
  if (match.status !== 'finished' && (match.can_score === false || draft?.receipt?.receipt_kind==='candidate_received')) {
    const candidateId=match.candidate_id||draft?.receipt?.candidate_id;
    return h('div.panel', h('h3', `${match.home.label} vs ${match.away.label}`),
      h('div.warn-box', match.blocked_reason || '原件已接收并只读保留。请查看候选处理状态；退回后的修订须建立新候选。'),
      candidateId ? h('button.btn.btn-primary.mt', { onclick:()=>go('resultReview',{candidate:candidateId,category:match.category_id}) }, match.candidate_id?'查看待复核候选':'查看候选处理状态') : null,
      draft?.payload ? h('button.btn.mt',{onclick:()=>go('review')},'待核实提交与导出原件') : null,
      ['admin', 'organizer'].includes(state.user.role) ? h('button.btn.mt', {
        onclick: () => go('workspace', { event: state.eventId, category: match.category_id, tab: 'schedule' }),
      }, '核对编排方案') : null);
  }
  if(draft?.protocol_schema===3&&draft.claim_epoch!==match.claim_epoch&&match.status!=='finished')
    return h('div.panel',h('div.warn-box','任务归属版本已变化，旧原包只读保留。请核对转交与原回执。'),
      h('button.btn',{onclick:()=>go('review')},'待核实提交与导出原件'));
  if (match.status === 'ready' && !offline) {
    if (!match.recorder_id || match.recorder_id === state.user.id) {
      const claim = await api.post('/api/recording/match/' + matchId + '/claim');
      Object.assign(match, claim);
      pkg.match = match;
      await localStore.put({key: identityKey + ':package:' + matchId, kind:'package', event_identity:identity, pkg});
    }
    if (match.recorder_id !== state.user.id) return h('div.panel',
      h('h3', match.home.label + ' vs ' + match.away.label),
      h('div.info-box', '记录员：' + match.recorder_name + '。该场次已被领取，可查看结果；换班请联系成绩人员转交。'),
      transferButton('match',matchId));
  }
  if (offline && match.status === 'ready' && match.recorder_id !== state.user.id) throw new Error('此场次尚未由本账号领取，请联网领取后再记录');
  const lineup = { home: match.home.participation_id, away: match.away.participation_id };

  // A cached record can never hide a finished match returned by the backend.
  if (match.status === 'finished') {
    return renderFinishedView(match, offline, params);
  }
  if (!draft) {
    draft = {
      key, kind: 'match', match_id: matchId, device: deviceName(),
      /* 记录项目归属，赛后核对页才能按项目过滤本机待提交记录（§12.4） */
      category_id: match.category_id, event_identity: identity,
      protocol_schema:3, claim_epoch:match.claim_epoch??0,
      live_base_epoch:match.live_stream_epoch??0,
      plan_version: match.plan_version, base_version: match.base_version,
      lineup, status: 'recording', result_status: 'normal', events: [],
      rules: normalizeRules(match.rules || DEFAULT_RULES), rules_hash: match.rules_hash,
      active_set: null,
      uid: newUid('match'),
      request_context: requestContext,
      title: `${match.group_name}/${categoryLabel(match)} ${match.round_label} 第${match.seq}场`,
    };
    if (offline) throw new Error('本机没有此场次草稿，请联网核对并开始记录');
    if (!await localStore.begin(draft)) throw new Error('此记录已由其他页面建立，请重载后核对');
  } else {
    draft.request_context = recordRequestContext(draft);
    draft.lineup = draft.lineup || lineup;
    if (match.base_version !== draft.base_version) draft.version_conflict = true;
  }
  /* 兼容升级前的草稿：正在计分的未结束局保持开启；空白草稿或两局之间等待手动开局。 */
  if (!Object.prototype.hasOwnProperty.call(draft, 'active_set')) {
    const oldSum = summarize(draft.events, draft.rules || DEFAULT_RULES);
    const current = oldSum.sets.find((set) => set.set_no === oldSum.currentSet);
    draft.active_set = current && !current.winner_side && (current.home_points || current.away_points)
      ? oldSum.currentSet : null;
  }
  if (!summarize(draft.events, draft.rules || DEFAULT_RULES).matchOver && !['failed', 'submitting'].includes(draft.status)) {
    draft.status = draft.active_set ? 'recording' : 'waiting';
  }
  const rulesChanged = !sameRules(draft.rules || DEFAULT_RULES, match.rules || DEFAULT_RULES)
    || (!!draft.rules_hash && draft.rules_hash !== match.rules_hash);
  const lineupChanged = draft.lineup.home !== lineup.home || draft.lineup.away !== lineup.away;

  const message = h('div.info-box.hidden');
  if (offline) {
    message.style.display = '';
    message.className = 'warn-box';
    message.textContent = '当前离线：使用本机已下载的场次数据继续记录，恢复联网后提交前请再次核对双方与轮次。';
  } else if (rulesChanged) {
    message.style.display = ''; message.className = 'warn-box';
    message.textContent = '本机记录与正式场次规则不一致，已暂停记录和提交。请导出恢复副本并联网核对，输入不会自动换规则。';
  } else if (lineupChanged) {
    message.style.display = '';
    message.className = 'warn-box';
    message.textContent = '对阵双方已发生变化：本机的记录是针对旧对阵的，不能直接提交。'
      + '请导出留档或放弃本地记录后按新对阵重新记录。';
  }
  const board = h('div.score-board');
  const sideCol = (side, participation, cls) => h(`div.side.${cls}`,
    h('div.team-side-label', cls === 'home' ? '主队' : '客队'),
    h('div.name', participation.label || participation.type_name),
    h('div.players', (match.players[side] || []).map((p) => `${p.jersey_no ? `${p.jersey_no} ` : ''}${p.name}`).join('、')),
    h('div.points', { dataset: { role: `points-${cls}` } }, '0'),
    h('button.add-btn', {
      class: cls,
      onclick: () => pushPoint(side),
    }, `＋ ${cls === 'home' ? '主队' : '客队'}得 1 分`),
  );
  const setStrip = h('div.set-strip');
  const matchScore = h('div.match-score',
    h('span.match-score-value.home', { dataset: { role: 'sets-home' } }, '0'),
    h('span.match-score-separator', ':'),
    h('span.match-score-value.away', { dataset: { role: 'sets-away' } }, '0'));
  const setControl = h('div.set-control');
  const statusLine = h('div.status-line', { 'aria-live': 'polite' });
  const eventList = h('div.event-list');
  const storageNotice = h('div.warn-box.mt.hidden', { role: 'alert' });
  /* 抬头与移动端操作条里需要随记录状态刷新的节点，先建好再由 draw() 更新。 */
  const headerStatus = h('span', { 'aria-live': 'polite' });
  const dockScore = h('b', '0 : 0');
  const dockState = h('span.record-dock-state', '本机记录');
  let saving = false;
  let storageFailed = false;
  let lastSavedAt = draft.updated_at || '';
  const editBlocked = () => saving || storageFailed || draft.storage_conflict || draft.submission_unknown
    || draft.status === 'submitting' || rulesChanged || summarize(draft.events, draft.rules || DEFAULT_RULES).errors.length || lineupChanged || !canScore() || match.status !== 'ready';

  const draw = () => {
    const sum = summarize(draft.events, draft.rules || DEFAULT_RULES);
    board.querySelector('[data-role=points-home]').textContent = sum.liveScore[0];
    board.querySelector('[data-role=points-away]').textContent = sum.liveScore[1];
    board.querySelector('[data-role=sets-home]').textContent = sum.winners.home;
    board.querySelector('[data-role=sets-away]').textContent = sum.winners.away;
    clear(setStrip);
    for (let i = 1; i <= sum.rules.max_sets; i += 1) {
      const s = sum.sets.find((x) => x.set_no === i);
      const cls = s && s.winner_side ? 'done' : (sum.currentSet === i ? 'live' : '');
      setStrip.append(h(`div.set-pill ${cls}`,
        s ? `第${i}局 ${s.home_points}:${s.away_points}` : `第${i}局 -:-`));
    }
    clear(statusLine);
    const [text, kind] = DRAFT_STATUS[draft.status] || [draft.status, ''];
    statusLine.append(
      statusBadge(text, kind),
      h('span.small.muted', `局分 ${sum.winners.home}:${sum.winners.away}`),
      sum.matchOver ? statusBadge('比赛结束', 'ok')
        : statusBadge(isSetOpen(sum, draft.active_set) ? `第 ${sum.currentSet} 局进行中` : `第 ${sum.currentSet} 局待开始`,
          isSetOpen(sum, draft.active_set) ? 'info' : 'warn'),
      saving ? statusBadge('正在保存本机记录', 'warn')
        : storageFailed ? statusBadge('当前记录尚未保存', 'danger')
          : h('span.small.muted', `本地保存于 ${fmtDateTime(lastSavedAt)}`),
      h('span.small.muted', draft.device),
    );
    const homeBtn = board.querySelector('.add-btn.home');
    const awayBtn = board.querySelector('.add-btn.away');
    const blocked = sum.matchOver || !isSetOpen(sum, draft.active_set)
      || editBlocked();
    homeBtn.disabled = blocked;
    awayBtn.disabled = blocked;
    board.classList.toggle('finished', !!sum.matchOver);
    board.classList.toggle('set-paused', !sum.matchOver && !isSetOpen(sum, draft.active_set));
    clear(setControl);
    if (sum.matchOver) {
      setControl.append(h('div.set-finished-banner',
        `比赛结束 · 局分 ${sum.winners.home}:${sum.winners.away}`));
    } else if (isSetOpen(sum, draft.active_set)) {
      setControl.append(h('div.set-live-banner',
        h('span.recording-dot', { 'aria-hidden': 'true' }),
        h('b', `第 ${sum.currentSet} 局记录中`),
        h('span.small', editBlocked() ? '记录操作已暂停，请处理下方提示' : '得分按钮已启用')));
    } else {
      setControl.append(
        h('div.set-waiting-copy',
          h('b', `第 ${sum.currentSet} 局尚未开始`),
          h('span.small.muted', '请核对对阵双方和当前局次，再手动开启记录。')),
        h('button.btn.btn-primary.btn-lg.start-set-btn', {
          disabled: editBlocked(),
          onclick: () => startSet(sum.currentSet),
        }, `开始第 ${sum.currentSet} 局记录`));
    }
    clear(eventList);
    const reversed = [...draft.events].reverse().slice(0, 60);
    for (const e of reversed) {
      const who = e.kind === 'undo' ? `撤回第 ${e.ref_seq} 次记分`
        : `${e.side === 'home' ? (match.home.label || '主队') : (match.away.label || '客队')} 得分 → ${e.home_after}:${e.away_after}`;
      eventList.append(h('div', `#${e.seq} 第${e.set_no}局 ${who}`));
    }
    drawReview();
    storageNotice.classList.toggle('hidden', !storageFailed);
    clear(storageNotice);
    if (storageFailed) storageNotice.append(
      h('b', '本机保存失败，已暂停后续记分。当前页面仍保留最新记录。'),
      h('div.small.mt', '请先重试保存或导出当前记录；直接刷新或关闭可能丢失尚未保存的内容。'),
      h('button.btn.mt', { disabled: saving, onclick: () => persist() }, '重试保存'),
      h('button.btn.mt', { onclick: () => exportCurrentDraft(draft) }, '导出当前记录'));
    const [headerText, headerKind] = DRAFT_STATUS[draft.status] || [draft.status, ''];
    clear(headerStatus);
    headerStatus.append(statusBadge(headerText, headerKind));
    dockScore.textContent = `${sum.liveScore[0]} : ${sum.liveScore[1]}`;
    dockState.textContent = storageFailed ? '本机保存失败'
      : saving ? '正在保存…' : `已保存 ${lastSavedAt ? fmtDateTime(lastSavedAt) : ''}`;
    dockState.classList.toggle('is-danger', !!storageFailed);
  };

  let saveChain = Promise.resolve(), saveCount = 0;
  const persist = () => {
    const snapshot = structuredClone(draft);
    saving = true; saveCount++; draw();
    const work = saveChain.then(async () => {
      snapshot.revision = draft.revision;
      let saved = null, threw = false;
      try { saved = await localStore.put(snapshot); } catch (error) { threw = true; toast(error.message, 'error'); }
      storageFailed = !saved;
      if (saved) {
        draft.revision = saved.revision;
        draft.updated_at = saved.updated_at;
        lastSavedAt = saved.updated_at;
        syncDisplaySnapshot(draft, match);
      }
      else if (!threw) {
        // A failed write alone does not prove another page changed this draft.
        // Keep transient failures retryable, while retaining the CAS fence.
        try {
          const current = await localStore.get(snapshot.key);
          if (!current || current.generation !== snapshot.generation
            || current.revision !== snapshot.revision || current.uid !== snapshot.uid
            || current.storage_conflict) draft.storage_conflict = true;
        } catch { /* Storage is still unavailable; preserve the unsaved page for retry/export. */ }
      }
      return !!saved;
    });
    saveChain = work.catch(() => false);
    return work.finally(() => { saving = --saveCount > 0; draw(); });
  };

  const pushPoint = async (side) => {
    if (editBlocked()) return;
    const sum = summarize(draft.events, draft.rules || DEFAULT_RULES);
    if (!isSetOpen(sum, draft.active_set)) {
      toast(`请先点击“开始第 ${sum.currentSet} 局记录”`, 'error');
      return;
    }
    const e = addPoint(draft.events, side, sum);
    if (!e) { toast('该局已结束或比赛已结束', 'error'); return; }
    draft.events.push(e);
    draft.payload = null;      // 内容变了，重试时必须重新构造提交包
    const after = summarize(draft.events, draft.rules || DEFAULT_RULES);
    if (after.matchOver) {
      draft.status = 'review';
      draft.active_set = null;
    } else if (after.currentSet !== sum.currentSet) {
      /* 本局结束后停在局间状态，不能把下一局自动开启。 */
      draft.status = 'waiting';
      draft.active_set = null;
    } else {
      draft.status = 'recording';
    }
    await persist();
  };

  const startSet = async (setNo) => {
    if (editBlocked()) return;
    const sum = summarize(draft.events, draft.rules || DEFAULT_RULES);
    if (sum.matchOver || Number(setNo) !== Number(sum.currentSet)) return;
    draft.active_set = sum.currentSet;
    draft.status = 'recording';
    draft.payload = null;
    if (await persist()) toast(`第 ${sum.currentSet} 局已开始，可以记录得分`, 'ok');
  };

  const doUndo = async () => {
    if (editBlocked()) return;
    const e = undoEvent(draft.events);
    if (!e) { toast('没有可撤回的记分', 'error'); return; }
    draft.events.push(e);
    draft.payload = null;
    const sum = summarize(draft.events, draft.rules || DEFAULT_RULES);
    draft.active_set = sum.matchOver ? null : sum.currentSet;
    draft.status = sum.matchOver ? 'review' : 'recording';
    await persist();
  };

  const eventName = state.events.find((item) => item.id === state.eventId)?.name || '';
  const recordHeader = h('header.record-head',
    h('nav.record-crumbs', { 'aria-label': '当前位置' },
      h('span', eventName),
      h('span.record-crumb-sep', { 'aria-hidden': 'true' }, '›'),
      h('span', categoryLabel(match)),
      h('span.record-crumb-sep', { 'aria-hidden': 'true' }, '›'),
      h('span.current', '记录台')),
    h('div.record-head-row',
      h('div.record-head-main',
        h('h1.record-title', `${match.home.label || '主队'} vs ${match.away.label || '客队'}`),
        h('div.record-badges',
          headerStatus,
          statusBadge(rulesSummary(draft.rules || DEFAULT_RULES), 'info'))),
      h('div.record-actions',
        h('button.btn', { onclick: () => returnToQueue(match, params) }, '返回列表'),
        h('button.btn', { onclick: () => showRecordSheet(matchId) }, '打印记录表'),
        match.status === 'ready' ? transferButton('match', matchId) : null)),
    h('div.record-meta',
      h('span', `项目：${categoryLabel(match)}`),
      h('span', `轮次：${match.round_label}（第 ${match.seq} 场）`),
      h('span', `场地：${match.venue_name || '未安排'}`),
      h('span', `时间：${match.scheduled_at ? fmtDateTime(match.scheduled_at) : '未安排'}`),
      h('span', `记录员：${match.recorder_name || '未领取'}`),
      h('span', `方案版本：v${match.plan_version} · 结果版本：${match.base_version}`)));
  panel.append(
    recordHeader,
    message,
    h('p.small.muted.record-note', '当前记录为待提交输入；提交成功前不计入正式成绩、名次或统计。'),
    recoveryNotice ? h('div.warn-box.mt', recoveryNotice) : null,
    storageNotice,
  );

  board.append(
    sideCol('home', match.home, 'home'),
    h('div.vs',
      h('div.match-format', rulesSummary(draft.rules || DEFAULT_RULES)),
      h('div.match-score-label', '大比分'),
      matchScore,
      h('div.current-set-label', '各局比分'),
      setStrip),
    sideCol('away', match.away, 'away'),
  );
  panel.append(board, setControl, statusLine);

  /* 操作与核对 */
  const review = h('div.panel.mt-sm');
  const drawReview = () => {
    clear(review);
    const sum = summarize(draft.events, draft.rules || DEFAULT_RULES);
    const homeName = match.home.label || '主队';
    const awayName = match.away.label || '客队';
    const status = draft.result_status;
    const statusName = {
      normal: '正常完成', home_forfeit: '主队弃权', away_forfeit: '客队弃权',
      unfinished: '未完成', cancelled: '取消',
    }[status] || status;
    const winner = status === 'home_forfeit' ? awayName
      : status === 'away_forfeit' ? homeName
        : status === 'normal' && sum.matchOver
          ? (sum.winners.home > sum.winners.away ? homeName : awayName) : '未分出胜方';
    const reason = status === 'normal' && !sum.matchOver
      ? `正常完成须先记录到一方赢得${setsToWin(draft.rules || DEFAULT_RULES)}局，当前不可提交。`
      : status === 'cancelled' && sum.sets.length
        ? '取消的比赛不能包含已记录局分；请撤回记分或选择实际结果状态。'
        : '';
    const statusSelect = selectInput([
      ['normal', '正常完成'], ['home_forfeit', '主队弃权'], ['away_forfeit', '客队弃权'],
      ['unfinished', '未完成'], ['cancelled', '取消'],
    ], status, {
      disabled: editBlocked(),
      onchange: (e) => { draft.result_status = e.target.value; draft.payload = null; persist(); },
    });
    review.append(
      h('h3', '赛后核对'),
      h('div.row.review-toolbar',
        field('结果状态', statusSelect),
        h('button.btn', { onclick: doUndo, disabled: editBlocked() }, '撤回上一次记分'),
        h('button.btn', {
          disabled: saving || draft.status === 'submitting' || !canScore(),
          onclick: () => confirmDialog('放弃本地记录', '本地未提交的记录将被清除，确认继续？', async () => {
            if (!await localStore.remove(key, draft)) throw new Error('记录已被其他页面更新，请核对后重试');
            storageFailed = false;
            toast('本地记录已清除', 'ok');
            returnToQueue(match, params);
          }, '放弃'),
        }, '放弃本地记录'),
      ),
      h('div.info-box.mt', `${homeName} vs ${awayName} · 局分 ${sum.winners.home}:${sum.winners.away} · 结果：${statusName} · 胜方：${winner}`),
      table([
        { label: '局次', render: (s) => `第${s.set_no}局` },
        { label: '主队', key: 'home_points', align: 'center' },
        { label: '客队', key: 'away_points', align: 'center' },
        { label: '胜方', render: (s) => s.winner_side === 'home' ? homeName
          : s.winner_side === 'away' ? awayName : '进行中 / 未分出胜方' },
      ], sum.sets.filter((s) => s.home_points || s.away_points)),
      reason ? h('div.warn-box.mt', reason) : null,
      h('div.row.mt',
        h('button.btn.btn-primary.btn-lg', {
          disabled: saving || storageFailed || draft.status === 'submitting' || !canScore()
            || (match.status !== 'ready' && !draft.submission_unknown) || rulesChanged || sum.errors.length || lineupChanged || !!reason,
          onclick: async () => submitMatch(match, draft, draw, persist, params),
        }, draft.status === 'failed' ? '重试原包提交' : '核对无误，提交待复核'),
        h('span.small.muted', draft.status === 'failed'
          ? '提交失败，记录仍保存在本机。核对后可重试。'
          : '提交成功仅表示已接收待复核；本机原包仍保留，独立确认后才成为正式成绩。'),
      ),
      match.status === 'finished' ? h('div.info-box.mt',
        `该场次已确认（结果版本 ${match.base_version}）。如需更正，请到“更正与导出”页面由编排与成绩人员操作。`) : null,
    );
  };

  const recordDock = h('div.record-dock',
    h('div.record-dock-score', h('span.small.muted', '本局比分'), dockScore),
    dockState,
    h('button.btn.btn-primary', {
      onclick: () => review.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    }, '赛后核对'));
  panel.append(review, h('div.panel', h('h3', '得分过程'), eventList), recordDock);
  setPageLeaveGuard(async () => {
    if (saving || draft.status === 'submitting') return false;
    if (!storageFailed) return true;
    return confirmAsync('当前记录尚未保存', '请先重试保存或导出当前记录。仍要离开并放弃尚未保存的内容吗？', '放弃并离开');
  }, () => storageFailed || saving);
  await persist();
  return panel;
}

async function submitMatch(match, draft, draw, persist, params) {
  const sum = summarize(draft.events, draft.rules || DEFAULT_RULES);
  if (draft.result_status === 'normal' && !sum.matchOver) {
    toast(`正常完成须先记录到一方赢得${setsToWin(draft.rules || DEFAULT_RULES)}局`, 'error');
    return;
  }
  if (sum.errors.length || !sameRules(draft.rules || DEFAULT_RULES, match.rules || DEFAULT_RULES)) {
    toast('记录过程或比赛规则需要核对，请保留输入', 'error'); return;
  }
  const payload = buildMatchPayload(draft, sum);
  draft.status = 'submitting';
  if (!await persist()) { draft.status = 'failed'; draw(); return; }
  const wasUnknown = !!draft.submission_unknown;
  const res = await submitWithRetry(payload.payload_schema===3?'/api/result-candidates':'/api/scoring/submit', payload, { context: draft.request_context });
  if (res.ok) {
    if (!await localStore.finalize(draft, res.result.receipt)) {
      draft.status = 'failed';
      draft.submission_unknown = true;
      stopDisplaySync();
      await persist();
      toast('服务器已接收，本机清理失败；请重试确认', 'error');
      return;
    }
    draft.status = payload.payload_schema===3?'received':'submitted';
    stopDisplaySync();
    toast(res.result.message || (payload.payload_schema===3?'已接收，待独立复核':'已核实原提交'), 'ok');
    if (res.result.affected && res.result.affected.length) {
      modal({
        title: '提交成功，但有需要人工处理的后续场次',
        body: h('ul.hint-list',
          h('li', '以下场次的参赛双方与已记录结果不一致，请人工核对：'),
          ...res.result.affected.map((a) => h('li', `场次 ${a.match_id}：${a.reason}`))),
      });
    }
    if (res.result.stale_pools && res.result.stale_pools.length) {
      toast('有小组名次需要重新确认，请到“小组与项目成绩”处理', 'error');
    }
    returnToQueue(match, params);
    return;
  }
  draft.status = 'failed';
  draft.submission_unknown = wasUnknown || !!res.error?.outcome_unknown;
  if (res.error && res.error.code === 'version_conflict') {
    draft.version_conflict = true;
    draft.server_conflict = res.error.detail || null;
  }
  if (res.error && res.error.code === 'lineup_changed') {
    modal({
      title: '对阵已变化，本记录不能提交',
      body: h('div',
        h('div.warn-box', res.message),
        h('p.small.mt', `记录时的对阵：${res.error.detail.recorded.join(' vs ')}`),
        h('p.small', `当前对阵：${res.error.detail.current.join(' vs ')}`),
        h('p.small.mt', '请导出本机记录留档，或放弃后按新对阵重新记录。')),
    });
  }
  await persist();
  toast(res.message, 'error');
}

/* 已完成场次的只读查看：展示正式结果与过程，不提供新建草稿 */
function returnToQueue(match, params) {
  const categoryId = Number(params.category || match.category_id);
  if (params.from === 'workspace') {
    const group = state.structure?.groups.find((item) => item.categories.some((c) => c.id === categoryId));
    if (group) {
      go('workspace', { event: state.eventId, group: group.id, category: categoryId, tab: 'matches' });
      return;
    }
  }
  go('scoring', { category: params.category || '' });
}

function renderFinishedView(match, offline, params) {
  const panel = h('div.panel');
  panel.append(
    h('div.panel-head',
      h('h3', `已确认结果 · ${match.group_name} / ${categoryLabel(match)} / ${match.round_label}`),
      h('div.row.tight', h('button.btn', { onclick: () => returnToQueue(match, params) }, '返回列表'),
        h('span.badge.badge-ok', `结果版本 ${match.base_version}`))),
    offline ? h('div.warn-box.mb', '当前离线，展示的是本机缓存的场次信息。') : null,
    h('p.small.muted', rulesSummary(match.rules || DEFAULT_RULES)),
    h('div.row.small.muted',
      h('span', `${match.home.label || '主队'} vs ${match.away.label || '客队'}`),
      h('span', `结果：${match.result_status_name || match.result_status}`),
      h('span', `场地：${match.venue_name || '未安排'}`), h('span', `记录员：${match.recorder_name || '历史记录未标注'}`), match.corrector_name ? h('span', `更正人：${match.corrector_name}`) : null),
    table([
      { label: '局次', render: (s) => `第${s.set_no}局` },
      { label: '主队', key: 'home_points', align: 'center' },
      { label: '客队', key: 'away_points', align: 'center' },
      {
        label: '胜方',
        render: (s) => (s.winner_side === 'home' ? (match.home.label || '主队')
          : s.winner_side === 'away' ? (match.away.label || '客队') : '未分出胜方'),
      },
    ], match.sets || []),
    h('div.row.mt',
      state.user.role !== 'recorder' ? h('button.btn', { onclick: () => showRecordSheet(match.id) }, '打印记录表') : null,
      h('span.small.muted', '如需修改，请到“更正与导出”由编排与成绩人员正式更正。')),
  );
  return panel;
}

/* 打印记录表：走带令牌的请求取 HTML，再写入新窗口（令牌不出现在 URL） */
const showRecordSheet = task((matchId) => openHtml(
  '/api/exports/record-sheet.html', { match_id: matchId }, '藤球比赛记录表'));

/* ------------------------------------------------------------------ 备份 */
function exportCurrentDraft(draft) {
  const data = { kind: 'stss-drafts', exported_at: new Date().toISOString(), drafts: [structuredClone(draft)] };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = h('a', { href: url, download: `当前记录_${draft.match_id}.json` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

registerView({
  name: 'scoring', label: '三人赛记录', roles: ['admin', 'organizer', 'recorder', 'viewer'], render,
});

/* Recover interrupted submissions and export preserved conflict branches for review. */
import { api, getApiEventContext, recordRequestContext, validateReceipt } from '../api.js';
import { registerView, state, go, submitWithRetry } from '../main.js';
import { localStore } from '../store.js';
import {
  h, field, selectInput, table, toast, modal, statusBadge, fmtDateTime,
  clear, emptyState, loadingState, errorState, categoryLabel,
} from '../ui.js';
import { summarize } from '../scoring.js';
import { DEFAULT_RULES, rulesSummary } from '../teamRules.js';

const canScore = () => ['admin', 'organizer', 'recorder'].includes(state.user.role);
/* 同步状态固定文案，区分“本机已存”和“服务器已确认”（§12.3、Q18） */
const STATUS = {
  submitting: ['正在提交，请稍候', 'info'],
  failed: ['提交中断，待重试', 'danger'],
  submitted: ['服务器已确认', 'ok'],
};

async function render({ el }) {
  if (!state.eventId) throw new Error('请先在“赛事首页”中创建赛事');
  const structure = state.structure;
  const cats = [];
  for (const g of (structure ? structure.groups : [])) {
    for (const c of g.categories) cats.push({ ...c, group_name: g.name });
  }

  el.append(h('div.panel',
    h('div.panel-head', h('h2', '提交重试')),
    h('div.small.muted', '仅用于核实中断的提交请求。报名、成绩和统计以后台保存的结果为准。'),
  ));

  const filter = h('div.panel');
  const listBox = h('div');
  const recentBox = h('div');
  el.append(filter, listBox, recentBox);

  const ui = { category: '' };
  const catSelect = selectInput([['', '全部项目'], ...cats.map((c) => [c.id, categoryLabel(c, { withGroup: true })])],
    '', { onchange: (e) => { ui.category = e.target.value; drawDrafts(); } });
  filter.append(h('div.row', field('按项目过滤', catSelect),
    h('span.small.muted', { style: 'align-self:center' }, '按本机记录里保存的项目归属过滤。')));

  let drafts = [];
  await load();

  async function load() {
    clear(listBox);
    listBox.append(h('div.panel', loadingState('正在读取本机记录…')));
    const identity = getApiEventContext();
    drafts = (await localStore.all()).filter((draft) =>
      ['match', 'individual'].includes(draft.kind)
      && (draft.storage_conflict || draft.payload && ['submitting', 'failed'].includes(draft.status))
      && draft.event_identity?.deployment_id === identity?.deployment_id
      && draft.event_identity?.event_uuid === identity?.event_uuid);
    drawDrafts();
    await loadRecent();
  }

  function drawDrafts() {
    clear(listBox);
    const wanted = ui.category ? Number(ui.category) : null;
    const known = drafts.filter((d) => (wanted ? Number(d.category_id) === wanted : true));
    /* Legacy requests without category IDs are kept separate from category filtering. */
    const unidentified = wanted ? drafts.filter((d) => !d.category_id) : [];
    if (!known.length && !unidentified.length) {
      listBox.append(h('div.panel', emptyState({
        text: wanted ? '该项目没有需要重试的提交' : '没有需要重试的提交',
        hint: '需要开始新记录时，请进入“现场任务”选择比赛项目。',
        action: h('button.btn.btn-primary', { onclick: () => go('field') }, '前往现场任务'),
      })));
      return;
    }
    for (const draft of known) listBox.append(draftCard(draft, load));
    if (unidentified.length) {
      listBox.append(h('div.panel',
        h('h3', '需要核实项目归属的请求'),
        h('div.small.muted.mb', '这些记录没有保存项目信息，不计入上面的项目过滤结果。'),
        ...unidentified.map((d) => draftCard(d, load))));
    }
  }

  async function loadRecent() {
    clear(recentBox);
    recentBox.append(h('div.panel', loadingState('正在读取服务器已确认场次…')));
    const recent = [];
    let recentOffline = false;
    try {
      recent.push(...(await api.get(`/api/matches?event_id=${state.eventId}&status=finished&sort=recent&offset=0&limit=30&with_sets=1`)).matches);
    } catch (err) {
      if (!err.offline) {
        clear(recentBox);
        recentBox.append(h('div.panel', errorState(err, loadRecent)));
        return;
      }
      recentOffline = true;
    }
    recent.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    const panel = h('div.panel', h('h3', '服务器已确认的场次（最近 30 条）'));
    clear(recentBox);
    recentBox.append(panel);
    if (recentOffline) {
      panel.append(h('div.warn-box', '当前离线，无法读取服务器已确认场次；中断的提交请求可在恢复联网后重试。'));
      return;
    }
    if (!recent.length) {
      panel.append(h('div.muted.small', '暂无已确认场次'));
      return;
    }
    panel.append(h('div.table-scroll', table([
      { label: '更新时间', key: 'updated_at' },
      { label: '大组别', key: 'group_name' },
      { label: '项目', render: (m) => categoryLabel(m) },
      { label: '轮次', key: 'round_label' },
      { label: '对阵', render: (m) => `${m.home.label} vs ${m.away.label}` },
      { label: '比分', render: (m) => m.sets.map((s) => `${s.home_points}:${s.away_points}`).join(' ') },
      {
        label: '',
        render: (m) => h('button.btn.small', { onclick: () => showSubmissions(m.id) }, '提交记录'),
      },
    ], recent.slice(0, 30))));
  }
}

function draftCard(draft, reload) {
  const [text, kind] = STATUS[draft.status] || [draft.status, ''];
  const card = h('div.draft-card' + (draft.status === 'failed' ? '.failed' : ''),
    h('div.row',
      h('b', draft.title || draft.key),
      statusBadge(text, kind),
      h('span.small.muted', `设备 ${draft.device || ''}`),
      h('span.small.muted', `更新于 ${fmtDateTime(draft.updated_at)}`)));
  card.append(h('button.btn.small', { onclick: () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' }));
    const a = h('a', { href: url, download: `记录恢复-${draft.uid || 'branch'}.json` }); a.click(); setTimeout(() => URL.revokeObjectURL(url), 4000);
  } }, '导出恢复副本'));
  if (draft.storage_conflict) {
    card.append(h('div.warn-box.mt', '此副本与其他页面冲突，已暂停提交；请导出并核对正式成绩和权威草稿。'));
    return h('div.panel', card);
  }
  if (draft.kind === 'match') {
    const sum = summarize(draft.events || [], draft.rules || DEFAULT_RULES);
    card.append(h('div.small.muted', rulesSummary(draft.rules || DEFAULT_RULES)));
    card.append(h('div.small',
      `局分 ${sum.winners.home}:${sum.winners.away} · `,
      sum.sets.filter((s) => s.home_points || s.away_points)
        .map((s) => `第${s.set_no}局 ${s.home_points}:${s.away_points}`).join('　')));
    card.append(h('div.row.tight.mt',
      h('button.btn.small', { onclick: () => go('scoring', { match: draft.match_id }) }, '查看明细'),
      canScore() ? h('button.btn.small.btn-primary', {
        onclick: () => retryMatch(draft, card, reload),
      }, '重试提交') : null));
  } else {
    card.append(h('div.small', `成绩 ${draft.result_value ?? '—'} · 名次 ${draft.rank_no ?? '待确认'}`));
    card.append(h('div.row.tight.mt',
      canScore() ? h('button.btn.small.btn-primary', {
        onclick: async () => {
          await retryMatch(draft, card, reload);
        },
      }, '重试提交') : null));
  }
  return h('div.panel', card);
}

async function retryMatch(draft, card, reload) {
  if (card.dataset.busy) return;
  card.dataset.busy = '1';
  try {
  draft.status = 'submitting';
  draft.request_context = recordRequestContext(draft);
  if (!await localStore.put(draft)) throw new Error('此记录已被其他页面更新，请核对恢复副本');
  const payload = draft.payload;
  const path = draft.kind === 'individual' ? '/api/scoring/individual' : '/api/scoring/submit';
  let res;
  try {
    const found = await api.get(`/api/receipts/${encodeURIComponent(draft.uid)}`, { context: draft.request_context });
    if (found.found) { await validateReceipt(found, payload, draft.kind, draft.match_id || draft.participation_id); res = { ok: true, result: found }; }
  } catch { /* Keep the original packet and allow an explicit same-UID replay. */ }
  res ||= await submitWithRetry(path, payload, { context: draft.request_context });
  if (res.ok) {
    if (!await localStore.finalize(draft, res.result.receipt)) throw new Error('服务器已确认，本机收据保存失败，请重试核实');
    toast('服务器已确认', 'ok');
    reload();
    return;
  }
  draft.status = 'failed';
  draft.submission_unknown = true;
  if (!await localStore.put(draft)) throw new Error('记录保存冲突，请保留此页并导出');
  toast(res.message, 'error');
  card.classList.add('failed');
  reload();
  } catch (error) { toast(error.message, 'error'); }
  finally { delete card.dataset.busy; }
}

async function showSubmissions(matchId) {
  const subs = (await api.get(`/api/matches/${matchId}/submissions`)).submissions;
  modal({
    title: `场次 ${matchId} 提交记录`,
    body: h('div.table-scroll', table([
      { label: '提交标识', key: 'uid' },
      { label: '设备', key: 'device' },
      { label: '提交人', key: 'user_name' },
      { label: '时间', key: 'received_at' },
      { label: '状态', key: 'status' },
      { label: '版本', render: (r) => `${r.base_version} → ${r.base_version + 1}` },
    ], subs)),
  });
}

registerView({ name: 'review', label: '提交重试', roles: ['admin', 'organizer', 'recorder', 'viewer'], render });

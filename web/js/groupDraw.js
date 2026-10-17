/* 学校抽签面板：揭晓进度以服务器为准，失败重试沿用同一请求标识。 */
import { api, newUid, openHtml } from './api.js';
import { groupName } from './groupNames.js';
import { h, clear, field, selectInput, textInput, numberInput, table, statusBadge, toast, confirmAsync, promptDialog, categoryLabel } from './ui.js';

const METHOD_LABELS = { random: '完全随机', seeded: '种子分档', cycle: '循环落位' };
const methodLabel = (value) => METHOD_LABELS[value] || value || '';
const STATUS = { drawing: ['抽签进行中', 'info'], complete: ['已抽完 · 待确认', 'warn'], confirmed: ['分组已确认', 'ok'], cancelled: ['已撤销', ''] };
const ROLL_INTERVAL_MS = 125; /* 每秒最多 8 次，避免闪动 */

export function renderGroupDraw(cat, initial, onChange, { client = api, isCurrent = () => true,
  openNotice = path => openHtml(path, {}, '小组抽签分组表') } = {}) {
  const panel = h('section.panel.group-draw', { id: 'group-draw', 'aria-label': '学校小组抽签' });
  panel.addEventListener('fullscreenchange', () => {
    const button = panel.querySelector('[data-fullscreen]');
    if (button) button.textContent = document.fullscreenElement === panel ? '退出全屏' : '全屏展示';
  });
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || document.fullscreenElement !== panel) return;
    event.preventDefault();
    leaveFullscreen().catch(() => {
      if (document.fullscreenElement === panel) toast('退出全屏失败，请使用“退出全屏”按钮重试', 'error');
    });
  });
  let data = initial;
  let busy = false;
  const retries = new Map();
  let groups = initial.draw?.capacities.length || Math.min(2, Math.max(1, initial.roster.length));
  let method = initial.draw?.method || 'cycle';
  let sizesText = '';
  const errorBox = h('div.warn-box.hidden', { role: 'alert' });
  /* 滚动揭晓只做过程呈现：句柄由组件持有，停止、响应到达、重绘、撤销与卸载时统一清理 */
  let rollFrame = 0;
  let rollTick = 0;
  let rollIndex = 0;
  let rollPool = [];
  let rollNameEl = null;
  /* 手动起止的揭晓状态：idle 待揭晓 / rolling 滚动中 / picking 已停止待结果 / revealed 已定格 */
  let revealState = 'idle';
  let pendingResult = null;
  let awaitingResult = false;
  const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;

  function stopRoll() {
    if (rollFrame) cancelAnimationFrame(rollFrame);
    rollFrame = 0;
    rollTick = 0;
  }

  function clearRoll() {
    stopRoll();
    rollNameEl = null;
    rollPool = [];
    pendingResult = null;
    awaitingResult = false;
    revealState = 'idle';
  }

  /* 尚未揭晓的候选学校：滚动只展示它们，不参与结果决定 */
  function rollCandidates() {
    const taken = new Set((data.draw?.steps || []).map((step) => step.school_name));
    return data.roster.filter((school) => !taken.has(school.school_name)).map((school) => school.school_name);
  }

  function startRoll(pool) {
    stopRoll();
    rollPool = pool.filter(Boolean);
    if (!rollPool.length || reducedMotion() || document.hidden) {
      /* 候选为空、减少动态效果或页面隐藏时不循环姓名，显示稳定提示 */
      if (rollNameEl) rollNameEl.textContent = reducedMotion() ? '已按“减少动态效果”停用姓名滚动，待揭晓' : '正在抽签…';
      return;
    }
    rollIndex = 0;
    const tick = (now) => {
      rollFrame = 0;
      if (!rollNameEl?.isConnected || document.hidden) return;
      if (!rollTick || now - rollTick >= ROLL_INTERVAL_MS) {
        rollTick = now;
        rollNameEl.textContent = rollPool[rollIndex % rollPool.length];
        rollIndex += 1;
      }
      rollFrame = requestAnimationFrame(tick);
    };
    rollFrame = requestAnimationFrame(tick);
  }

  /* 用户点“开始抽签”：进入滚动并发起该次抽签请求 */
  async function startReveal() {
    if (busy || !isCurrent() || (revealState !== 'idle' && revealState !== 'revealed')) return;
    const draw = data.draw;
    if (!draw || draw.status !== 'drawing' || draw.stale || data.blocked_reason) return;
    clearRoll();
    revealState = 'rolling';
    awaitingResult = true;
    panel.dataset.drawRolling = 'true';
    drawPanel();
    startRoll(rollCandidates());
    await mutate('next');
  }

  /* 用户点“停止并揭晓”：停止滚动；结果已到就立即定格，未到则等待 */
  function stopReveal() {
    if (revealState !== 'rolling') return;
    stopRoll();
    if (pendingResult) {
      applyPendingResult();
      return;
    }
    if (!awaitingResult) {
      /* 请求已结束但没有结果（失败/失效）：回到稳定态并保留既有错误提示 */
      clearRoll();
      drawPanel();
      return;
    }
    revealState = 'picking';
    drawPanel();
  }

  function applyPendingResult() {
    const result = pendingResult;
    pendingResult = null;
    awaitingResult = false;
    revealState = 'revealed';
    delete panel.dataset.drawRolling;
    rollNameEl = null;
    if (result) { data = result; onChange(data.draw); }
    drawPanel();
  }

  document.addEventListener('visibilitychange', onVisibility);

  function onVisibility() {
    /* 标签隐藏时停止滚动；回到页面处于稳定态，由用户重新开始，不自动抽签 */
    if (document.hidden && revealState === 'rolling') {
      stopRoll();
      revealState = awaitingResult ? 'picking' : 'idle';
      drawPanel();
    }
  }

  function cleanup() {
    clearRoll();
    document.removeEventListener('visibilitychange', onVisibility);
  }

  async function leaveFullscreen() {
    if (document.fullscreenElement === panel) await document.exitFullscreen();
  }

  async function reload() {
    data = await client.get(`/api/categories/${cat.id}/group-draw`);
    if (!isCurrent()) return;
    drawPanel();
    onChange(data.draw);
  }

  async function mutate(action, values = {}) {
    if (busy || !isCurrent()) return;
    busy = true;
    errorBox.classList.add('hidden');
    const previous = data.draw;
    const body = action === 'start' ? { ...values, roster_hash: data.roster_hash }
      : { draw_id: previous.id, base_rev: previous.rev, ...values };
    const key = JSON.stringify([action, body]);
    const uid = retries.get(key) || newUid('draw');
    retries.set(key, uid);
    const reveal = action === 'next';
    try {
      const path = `/api/categories/${cat.id}/group-draw${action === 'start' ? '' : `/${action}`}`;
      await client.post(path, { ...body, request_uid: uid });
      const fresh = await client.get(`/api/categories/${cat.id}/group-draw`);
      if (!isCurrent()) return;
      retries.delete(key);
      if (reveal && (revealState === 'rolling' || revealState === 'picking')) {
        /* 手动起止：结果先保存，等用户点“停止并揭晓”才定格 */
        pendingResult = fresh;
        awaitingResult = false;
        if (revealState === 'picking') applyPendingResult();
        else drawPanel();
      } else {
        data = fresh;
        onChange(data.draw);
        drawPanel();
      }
      if (action === 'confirm') toast('抽签分组已确认，可在比赛赛程建立小组赛阶段', 'ok');
      if (action === 'cancel') toast('已撤销本次抽签，原记录保留', 'ok');
    } catch (error) {
      errorBox.textContent = error.status === 0
        ? '操作结果待核实。请刷新抽签状态，或用原操作重试。' : error.message;
      errorBox.classList.remove('hidden');
    } finally {
      busy = false;
      if (reveal) {
        /* 请求结束但用户仍在滚动：保留滚动，等用户停止；用户已停止则立刻定格 */
        awaitingResult = false;
        if (revealState === 'picking' && pendingResult) applyPendingResult();
        else if (isCurrent()) drawPanel();
      } else if (isCurrent()) {
        drawPanel();
      }
    }
  }

  function capacities() {
    if (!Number.isInteger(groups) || groups < 1) throw new Error('小组数量须为正整数');
    if (groups > data.roster.length) throw new Error('小组数量不能超过已报名学校数');
    const values = sizesText.trim() ? sizesText.trim().split(/[,，、\s]+/).map(Number)
      : Array.from({ length: groups }, (_, i) => Math.floor(data.roster.length / groups) + Number(i < data.roster.length % groups));
    if (values.length !== groups || values.some((n) => !Number.isInteger(n) || n < 1)
      || values.reduce((sum, n) => sum + n, 0) !== data.roster.length) {
      throw new Error(`各组人数须为正整数，请为 ${groups} 组填写共 ${data.roster.length} 所学校的名额`);
    }
    if (method === 'seeded' && Math.max(...values) - Math.min(...values) > 1) {
      throw new Error('种子分档时各组人数最多相差 1');
    }
    return values;
  }

  function drawPanel() {
    clear(panel);
    const draw = data.draw;
    const active = draw && draw.status !== 'cancelled';
    const header = h('div.panel-head', h('div', h('h3', '学校小组抽签'),
      h('div.small.muted', `${categoryLabel(cat, { withGroup: true })} · ` + (active
        ? `本次 ${draw.total} 所学校 · ${draw.capacities.length} 个小组` : `当前已报名 ${data.roster.length} 所学校`))),
    h('div.row.tight', active ? statusBadge(...STATUS[draw.status]) : null,
      h('button.btn.small', { onclick: async () => {
        if (busy || !isCurrent()) return;
        try { await reload(); } catch (error) { toast(error.message, 'error'); }
      } }, '刷新抽签状态')));
    panel.append(header, errorBox);
    if (data.blocked_reason) panel.append(h('div.info-box', data.blocked_reason));
    if (active && draw.stale) panel.append(h('div.warn-box', '参赛学校或种子序号已变化。本次结果已失效，请撤销后重新核对名单并抽签。'));
    if (!active) {
      panel.append(h('div.small.muted.mb', '核对学校名单和各组名额后开始。抽签进度自动保存，可刷新或换设备继续。'));
      const preview = h('div.draw-capacities', { 'aria-live': 'polite' });
      const start = h('button.btn.btn-primary', { disabled: !!data.blocked_reason,
        onclick: async () => {
          try { await mutate('start', { method, capacities: capacities() }); }
          catch (error) { errorBox.textContent = error.message; errorBox.classList.remove('hidden'); }
        } }, '开始小组抽签');
      const update = () => {
        clear(preview);
        try {
          const values = capacities();
          const seeds = data.roster.map((school) => school.seed_no);
          if (method === 'seeded' && (seeds.some((seed) => !Number.isInteger(seed) || seed < 1) || new Set(seeds).size !== seeds.length)) {
            throw new Error('请先到报名名单为每所学校填写唯一的种子序号');
          }
          preview.append(...values.map((size, i) => h('span.chip', `${groupName(i)} ${size} 校`)));
          start.disabled = !!data.blocked_reason;
        } catch (error) { preview.append(h('span.small', error.message)); start.disabled = true; }
      };
      panel.append(h('div.form-grid',
        field('抽签方式', selectInput([['cycle', '循环落位'], ['random', '完全随机'], ['seeded', '种子分档']], method, {
          'aria-label': '抽签方式',
          disabled: !!data.blocked_reason, onchange: (event) => { method = event.target.value; update(); },
        })),
        field('小组数量', numberInput(groups, { 'aria-label': '小组数量', min: 1, step: 1, disabled: !!data.blocked_reason,
          oninput: (event) => { groups = Number(event.target.value); update(); } })),
        field('各组人数（可选）', textInput(sizesText, { 'aria-label': '各组人数（可选）', placeholder: '例如 4,4,3；留空按人数均分', disabled: !!data.blocked_reason,
          oninput: (event) => { sizesText = event.target.value; update(); } }), { hint: '按 A、B、C…组的顺序填写' })), preview,
        h('p.small.muted', '循环落位：每签先从剩余学校中随机抽一所，再按 A、B、C… 顺序依次落组，某组满员后跳过。'),
        h('p.small.muted', '完全随机：学校与组内位置都随机；种子分档：按种子序号分档，每档内抽签，每组每档最多一校。'),
        h('details.draw-roster', h('summary', `核对参赛学校与种子（${data.roster.length} 校）`),
          h('div.table-scroll', table([{ label: '学校', key: 'school_name' }, { label: '种子序号', render: (p) => p.seed_no || '未设置' }], data.roster))),
        h('div.row.mt', start));
      update();
    } else {
      const rolling = revealState === 'rolling';
      const picking = revealState === 'picking';
      panel.append(h('div.draw-progress', h('span', `${draw.revealed} / ${draw.total} 所学校已揭晓`),
        h('span.small.muted', `${methodLabel(draw.method)} · 开始于 ${draw.created_at}`)));
      const board = h('div.draw-board');
      const latest = draw.steps.at(-1);
      const reveal = h('div.draw-reveal', { 'aria-live': 'polite', 'aria-atomic': 'true' });
      if (rolling || picking) {
        /* 滚动只展示尚未揭晓的候选；结果已在后台保存，等用户点“停止并揭晓”才定格 */
        reveal.append(h('div.draw-school-roll-label', rolling
          ? `正在滚动 · 第 ${draw.revealed + 1} 签`
          : `正在揭晓 · 第 ${draw.revealed + 1} 签`));
        rollNameEl = h('div.draw-school.draw-school-rolling', rollPool[0] || '正在抽签…');
        reveal.append(rollNameEl,
          h('div.draw-destination', rolling ? '点“停止并揭晓”完成本次抽签' : '已停止，等待结果…'));
        if (!picking) startRoll(rollPool);
      } else {
        reveal.append(
          h('div.small.muted', latest ? `第 ${latest.number} 签${latest.pot ? ` · 第 ${latest.pot} 档` : ''}` : '准备揭晓'),
          h('div.draw-school', latest?.school_name || '等待第一所学校'),
          h('div.draw-destination', latest ? `进入 ${groupName(latest.group)}` : '点击“开始抽签”后滚动，再点“停止并揭晓”'));
      }
      board.append(reveal);
      board.append(h('div.draw-groups', ...draw.groups.map((group) => h('section.draw-group',
        h('div.panel-head', h('h4', group.name), h('span.small.muted', `${group.members.length} / ${group.capacity}`)),
        h('ol', ...Array.from({ length: group.capacity }, (_, i) => {
          const member = group.members[i];
          return h(`li${member ? '' : '.draw-empty'}`, member ? h('span', member.school_name) : '待抽签',
            member?.pot ? h('span.small.muted', `第${member.pot}档`) : null);
        }))))));
      panel.append(board);
      const actions = h('div.row.mt');
      /* 滚动/等待揭晓期间冻结抽签相关按钮：面板会随滚动重绘，必须在这里重新套用禁用状态 */
      const locked = !!data.blocked_reason || draw.stale || busy || rolling || picking;
      if (draw.status === 'drawing') actions.append(
        rolling
          ? h('button.btn.btn-primary', { onclick: () => stopReveal() }, '停止并揭晓')
          : h('button.btn.btn-primary', { disabled: locked, onclick: () => startReveal() },
            draw.revealed ? '开始抽签（下一所）' : '开始抽签'),
        h('button.btn', { disabled: locked, onclick: () => mutate('complete') }, '一键完成抽签'));
      if (draw.status === 'complete') actions.append(h('button.btn.btn-primary', { disabled: locked,
        onclick: async () => {
          await leaveFullscreen();
          if (await confirmAsync('确认抽签分组', '确认后在比赛赛程引用此分组，重新抽签须填写撤销原因。', '确认分组')) await mutate('confirm');
        } }, '确认抽签分组'));
      if (draw.status === 'confirmed') {
        panel.append(h('div.info-box.mt', `已由 ${draw.confirmed_by_name} 于 ${draw.confirmed_at} 确认。比赛赛程可引用这份分组。`));
        actions.append(h('button.btn', { disabled: draw.stale, onclick: async () => {
          try { await openNotice(`/api/categories/${cat.id}/group-draw/notice.html`); }
          catch (error) { toast(error.message, 'error'); }
        } }, '打印分组表'));
      }
      actions.append(h('button.btn', { dataset: { fullscreen: 'true' }, onclick: async () => {
        try {
          if (document.fullscreenElement === panel) await leaveFullscreen();
          else await panel.requestFullscreen();
        } catch { toast('当前浏览器无法切换全屏，请使用浏览器全屏功能', 'error'); }
      } }, document.fullscreenElement === panel ? '退出全屏' : '全屏展示'));
      if (!data.blocked_reason) actions.append(h('button.btn.btn-ghost', { onclick: async () => {
        await leaveFullscreen();
        const reason = await promptDialog({ title: '撤销本次抽签', label: '撤销原因', required: true, multiline: true,
          hint: '原结果和已揭晓过程会保留；已用于正式赛程时须先处理后续依赖。', okLabel: '撤销抽签' });
        if (reason) await mutate('cancel', { reason });
      } }, '撤销本次抽签'));
      panel.append(actions, h('details.draw-log.mt', h('summary', '查看抽签过程'),
        h('div.table-scroll', table([{ label: '签次', key: 'number' }, { label: '学校', key: 'school_name' },
          { label: '小组', render: (step) => groupName(step.group) },
          { label: '档位', render: (step) => step.pot ? `第${step.pot}档` : '—' }], draw.steps))));
    }
    if (data.history.length) panel.append(h('details.draw-history.mt', h('summary', '已撤销的抽签记录'),
      ...data.history.map((old) => h('details.mt', h('summary', `抽签 ${old.id} · ${old.created_at} · ${old.revealed}/${old.total} 校已揭晓`),
        h('p.small', `撤销原因：${old.cancel_reason}`),
        ...old.groups.map((group) => h('p.small', `${group.name}：${group.members.map((p) => p.school_name).join('、') || '尚未揭晓'}`))))));
  }
  drawPanel();
  return panel;
}

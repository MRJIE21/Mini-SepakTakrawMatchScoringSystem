/* 个人赛逐人抽签面板（DESIGN_V3 模块「抽签面板和动画」）。

   与旧版一次性预览的区别：开始滚动 → 停止并揭晓 → 后台在这一刻才真正抽一人 →
   逐人揭晓 → 全部抽完才允许确认正式出场顺序。界面动画只呈现过程，不决定结果。

   不变量：
   - 状态机 idle / starting / rolling / picking / revealed / complete / confirming / recovering / blocked；
   - 每个变更原包都先用 localStore.begin 落盘，落盘失败不发 HTTP；
   - 结果只以服务端回执与 GET /session 为准；回执不符、响应丢失、超时一律保留原包待核实，
     用同一 request_uid 查 /session/requests/{uid} 精确核实，不生成新 UID；
   - 滚动只展示「尚未抽到」的候选，requestAnimationFrame 按时间节流（≤8 次/秒），不闪背景；
   - 页面隐藏、项目/账号/赛事切换或组件卸载时取消 rAF 与监听器，迟到结果不渲染到新项目。
*/
import { api, captureRequestContext, newUid, payloadHash } from './api.js';
import { localStore } from './store.js';
import { drawPool } from './drawDisplayModel.js';
import { drawFlowNavigation } from './drawDisplay.js';
import { openResultImport } from './resultImport.js';
import {
  h, clear, table, toast, confirmAsync, setPageLeaveGuard, setRouterBlockGuard, errorState, statusBadge,
  categoryLabel,
} from './ui.js';

const ROLL_INTERVAL_MS = 125; /* 每秒最多 8 次，避免闪动 */
export const DRAW_PHASES = ['idle', 'starting', 'rolling', 'picking', 'revealed', 'complete',
  'confirming', 'recovering', 'blocked'];

export async function mountIndividualDraw({ container, category, roster: initialRoster = null,
  initialData = null, initialOffline = false, canManage = false,
  requestContext = captureRequestContext(), signal, isCurrent = () => true, onSaved = async () => {} }) {
  const alive = () => container.isConnected && !signal?.aborted && isCurrent();
  const path = `/api/categories/${category.id}/individual-draw`;
  const sessionPath = `${path}/session`;
  const identity = requestContext.identity;
  const identityKey = `${identity?.deployment_id || 'unknown'}:${identity?.event_uuid || 'unidentified'}`;
  /* 新流程与旧一次性预览各自一个键：旧键只用于识别旧 kind 的 pending，不静默丢包 */
  const sessionKey = `${identityKey}:individual-draw-session:${category.id}`;
  const legacyKey = `${identityKey}:individual-draw:${category.id}`;
  const cacheKey = `${identityKey}:individual-draw:${category.id}:official`;

  let official = initialData || null;
  let session = null;
  let roster = Array.isArray(initialRoster) ? [...initialRoster]
    : (Array.isArray(initialData?.roster) ? [...initialData.roster] : null);
  let phase = 'idle';
  let pending = null;
  let legacyPending = false;
  let offline = !!initialOffline;
  let cachedAt = '';
  let errorMessage = '';
  let readFailure = '', poolAllowed = canManage;
  let notice = '';
  let busy = false;
  let lastRevealedId = null;
  let mounted = false;
  let lastSessionAt = 0;
  let raf = 0;
  let rollIndex = 0;
  let lastTick = 0;
  let rollNameEl = null;
  let rollSchoolEl = null;
  let fullscreenMessage = '';
  let fullscreenButtonEl = null;
  let panelElement = null;
  let activeSection = null;

  const options = () => ({ context: requestContext, signal });
  const postOptions = () => ({ context: requestContext });
  const schoolOf = (row) => row?.school_name || row?.school_short || '学校未填';
  const personOf = (row) => row?.name || row?.subject || row?.athlete_name || '姓名待补充';
  const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  const rows = (value) => (Array.isArray(value) ? value.filter(Boolean) : []);

  /* ---------------------------------------------------------------- 全屏显示 */
  const fullscreenActive = () => Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  const fullscreenSupported = () => Boolean(document.fullscreenEnabled
    && typeof panelElement?.requestFullscreen === 'function');

  /* 按钮只在文案或状态变化时原地更新，避免为了换文案重建节点、丢失焦点。 */
  function syncFullscreenButton() {
    if (!fullscreenButtonEl) return;
    const label = fullscreenActive() ? '退出全屏' : '全屏显示';
    const pressed = fullscreenActive() ? 'true' : 'false';
    if (fullscreenButtonEl.textContent !== label) fullscreenButtonEl.textContent = label;
    if (fullscreenButtonEl.getAttribute('aria-pressed') !== pressed) {
      fullscreenButtonEl.setAttribute('aria-pressed', pressed);
    }
  }

  /* 请求被拒绝时会同时触发 Promise 拒绝与 fullscreenerror：只处理一次，
     否则同一提示会连续重绘两次，把正在点击的按钮从 DOM 上换掉。 */
  function setFullscreenMessage(text) {
    if (fullscreenMessage === text) return;
    fullscreenMessage = text;
    if (alive()) draw();
  }

  async function toggleFullscreen() {
    if (busy) return;
    if (fullscreenActive()) {
      /* 只走浏览器原生退出路径，且在确实处于全屏时才调用。 */
      try {
        await (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.());
      } catch (error) {
        setFullscreenMessage(`退出全屏失败：${error?.message || '浏览器未允许'}。可按 Esc 退出。`);
      }
      return;
    }
    if (!fullscreenSupported() || !panelElement) {
      setFullscreenMessage('当前浏览器或页面不允许全屏显示，可继续在普通页面完成抽签。');
      return;
    }
    fullscreenMessage = '';
    try {
      /* 必须在用户点击的同一事件里发起请求，否则浏览器会以缺少用户手势拒绝。 */
      await panelElement.requestFullscreen();
    } catch (error) {
      setFullscreenMessage(`无法进入全屏：${error?.message || '浏览器拒绝了全屏请求'}。`
        + '可继续在普通页面完成抽签。');
    }
  }

  function onFullscreenChange() {
    if (!alive()) return;
    if (!fullscreenActive() && phase === 'rolling') {
      /* 全屏切换时停止滚动，回到稳定态；不自动抽人。 */
      stopRoll();
      phase = pickedCount() > 0 ? 'revealed' : 'idle';
      draw();
      return;
    }
    syncFullscreenButton();
  }

  function onFullscreenError() {
    setFullscreenMessage('浏览器拒绝了全屏请求，可继续在普通页面完成抽签。');
  }

  /* ---------------------------------------------------------------- 派生状态 */
  const revealedRows = () => rows(session?.revealed);
  const candidateRows = () => !poolAllowed ? [] : drawPool(session ? rows(session.candidates) : (roster || []))
    .map(row => ({ ...row, name: personOf(row) }));
  const sessionTotal = () => rows(session?.session_roster || session?.roster).length;
  const totalCount = () => {
    if (session) return sessionTotal() || (Number(session.picked || 0) + Number(session.remaining || 0));
    return roster !== null && poolAllowed ? drawPool(roster).length : rows(official?.entries).length;
  };
  const pickedCount = () => (session ? Number(session.picked || revealedRows().length || 0) : 0);
  const blockedReason = () => (session && (session.stale || session.block_reason)
    ? (session.block_reason || '报名名单或正式签表已变化，本轮抽取已失效，请核对后撤销并重新开始')
    : '');
  /* 服务端 GET /individual-draw 已下发 can_draw/block_reason（有领取/成绩时锁定）；
     面板必须据此禁用不可用操作，而不是等 POST 后 409 才发现。 */
  const officialLocked = () => !session && rows(official?.entries).length > 0
    && official?.can_draw === false;
  const lockReason = () => (session ? blockedReason()
    : (official && official.can_draw === false
      ? (official.block_reason || '已有成绩或记录任务领取，不能重新抽签') : ''));
  const canAct = () => canManage && poolAllowed && !readFailure && !offline && !busy && !pending
    && !(!session && official?.can_draw === false);

  function applySession(next, { revealId = null } = {}) {
    session = next || null;
    if (revealId !== null && revealId !== undefined) lastRevealedId = revealId;
    if (!session) { if (phase !== 'recovering') phase = 'idle'; return; }
    if (session.stale || session.block_reason) { phase = 'blocked'; return; }
    if (session.status === 'complete') { phase = 'complete'; return; }
    phase = pickedCount() > 0 ? 'revealed' : 'idle';
  }

  /* ---------------------------------------------------------------- 滚动动画 */
  function stopRoll() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    lastTick = 0;
  }

  function startRoll() {
    stopRoll();
    if (!alive() || phase !== 'rolling' || document.hidden || reducedMotion()) return;
    const pool = candidateRows();
    if (!pool.length) return;
    rollIndex = 0;
    const tick = (now) => {
      raf = 0;
      if (!alive() || phase !== 'rolling' || document.hidden) return;
      /* 只换文字，不换背景：按时间节流到 ≤8 次/秒 */
      if (!lastTick || now - lastTick >= ROLL_INTERVAL_MS) {
        lastTick = now;
        const item = pool[rollIndex % pool.length];
        rollIndex += 1;
        if (rollNameEl?.isConnected) rollNameEl.textContent = item.name || '';
        if (rollSchoolEl?.isConnected) rollSchoolEl.textContent = schoolOf(item);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  /* ---------------------------------------------------------------- 读取后台 */
  async function readOfficial() {
    try {
      const result = await api.get(path, options());
      if (!alive()) return;
      if (!result.draw || result.draw.category_id !== category.id || !Array.isArray(result.draw.entries)
          || !['none', 'current', 'stale'].includes(result.draw.status) || !Number.isSafeInteger(result.draw.revision)
          || result.draw.revision < 0) throw new Error('正式出场顺序读取不完整或项目不一致');
      official = result.draw;
      offline = false;
      cachedAt = new Date().toLocaleString();
      await localStore.cachePut({ key: cacheKey, data: { ...official, cached_at: cachedAt } }).catch(() => null);
    } catch (error) {
      if (!alive()) return;
      if (!error.offline) throw error;
      const cached = await localStore.get(cacheKey).catch(() => null);
      offline = true;
      if (cached?.data) { official = cached.data; cachedAt = cached.data.cached_at || cachedAt || '上次'; }
      else cachedAt = cachedAt || official?.cached_at || '上次';
    }
  }

  async function refreshSession({ quiet = false } = {}) {
    if (!canManage || offline) return true;
    try {
      const result = await api.get(sessionPath, options());
      if (!alive()) return;
      if (!Object.hasOwn(result, 'session') || result.session && (!Number.isSafeInteger(result.session.session_id)
          || !Array.isArray(result.session.candidates) || !Array.isArray(result.session.revealed))) throw new Error('抽取进度读取不完整');
      lastSessionAt = Date.now();
      /* 有待核实原包时不覆盖 recovering，避免把未确认请求当成没发生过 */
      if (!pending) applySession(result?.session || null);
      return true;
    } catch (error) {
      if (!alive()) return;
      if (error.offline) offline = true;
      if (error.status === 403 || error.status === 401) {
        session = null; roster = null; poolAllowed = false; phase = pending ? 'recovering' : 'idle';
      }
      readFailure = `抽取进度读取失败：${error.message}。请刷新状态后重试。`;
      return false;
    }
  }

  async function loadRemote({ quiet = false } = {}) {
    readFailure = '';
    try { await readOfficial(); }
    catch (error) { if (alive()) readFailure = `出场顺序读取失败：${error.message}。当前保留上次成功读取的内容，请重试。`; }
    if (!alive()) return;
    await refreshSession({ quiet });
    if (canManage && poolAllowed && !offline && !session) await loadRoster(true);
  }

  async function loadRoster(force = false) {
    if (!canManage || !poolAllowed || offline || roster && !force) return;
    try {
      const result = await api.get(`/api/categories/${category.id}/participations`, options());
      if (!alive()) return;
      drawPool(result.participations);
      roster = result.participations;
    } catch (error) {
      if (alive()) readFailure = `抽签池读取失败：${error.message}。请刷新状态后重试。`;
    }
  }

  /* ---------------------------------------------------------------- 回执校验 */
  function mismatch(message) {
    /* 回执不可信时不能当作「未提交」：服务端可能已经生效，必须保留原包核实 */
    return Object.assign(new Error(message), { outcome_unknown: true, receipt_mismatch: true });
  }

  function sameIdentity(value) {
    return !!value && ['event_id', 'event_uuid', 'deployment_id']
      .every((key) => String(value[key] ?? '') === String(identity?.[key] ?? ''));
  }

  /* 回执校验只认「与原包同一份请求」；进度一致性以服务端返回的 session 形状为准
     （start 的 base_revision 是正式修订、会话 revision 从 1 开始；cancel 不改会话修订，
     所以不能一律用 revision === base+1 判断）。 */
  async function verifyReceipt(receipt, packet, op, result = null) {
    if (!receipt || receipt.request_uid !== packet.request_uid) throw mismatch('回执与请求标识不符，原请求已保留待核实');
    if (receipt.op && receipt.op !== op) throw mismatch('回执操作类型不符，原请求已保留待核实');
    if (receipt.event_identity && !sameIdentity(receipt.event_identity)) throw mismatch('回执赛事身份不符，原请求已保留待核实');
    if (packet.session_id != null && receipt.session_id != null && receipt.session_id !== packet.session_id) {
      throw mismatch('回执抽取会话不符，原请求已保留待核实');
    }
    if (receipt.revision != null && !(Number.isInteger(receipt.revision) && receipt.revision >= 1)) {
      throw mismatch('回执修订号无效，原请求已保留待核实');
    }
    const next = result?.replayed ? null : (result?.session || null);
    if (op === 'stop' && next) {
      /* 停止并揭晓必须恰好推进一位，且新抽中者只能出现在已抽名单末尾 */
      if (Number(next.revision) !== packet.base_revision + 1
          || Number(next.picked) !== rows(next.order).length) {
        throw mismatch('抽取进度未按一步推进，原请求已保留待核实');
      }
      if (receipt.picked_id != null) {
        const order = rows(next.order).map(Number);
        const at = order.indexOf(Number(receipt.picked_id));
        if (at < 0 || at !== order.length - 1) throw mismatch('回执抽中者与已抽名单不符，原请求已保留待核实');
      }
    }
    if (op === 'confirm' && receipt.order_hash && session?.order) {
      /* 确认回执必须与界面累计揭晓顺序是同一排列 */
      if (receipt.order_hash !== await payloadHash(session.order.map(Number))) {
        throw mismatch('确认回执与界面揭晓顺序不符，原请求已保留待核实');
      }
    }
    return receipt;
  }

  /* ---------------------------------------------------------------- 请求发送 */
  function packetFor(op, uid) {
    if (op === 'start') return { event_identity: identity, request_uid: uid };
    return { event_identity: identity, request_uid: uid,
      session_id: session?.session_id ?? null, base_revision: Number(session?.revision ?? 0) };
  }

  async function beginPacket(op) {
    const uid = newUid('individual-draw');
    const packet = packetFor(op, uid);
    const draft = {
      key: sessionKey, kind: 'individual_draw_session', uid, op, payload: packet,
      event_identity: identity, base_version: op === 'start' ? Number(official?.revision ?? 0)
        : Number(session?.revision ?? 0),
      category_id: category.id, session_id: session?.session_id ?? null,
    };
    return { packet, draft };
  }

  async function perform(op) {
    if (!alive() || busy) return false;
    if (readFailure) { errorMessage = '请先刷新抽签状态并完成读取，再继续操作。'; draw(); return false; }
    if (offline) { errorMessage = '当前离线：抽取与确认已禁用，恢复联网后再继续。'; draw(); return false; }
    if (op !== 'start' && (!session || session.session_id == null)) {
      errorMessage = '抽取过程已不存在，请刷新状态后重新开始。'; draw(); return false;
    }
    busy = true;
    errorMessage = '';
    notice = '';
    const { packet, draft } = await beginPacket(op);
    let saved = null;
    try {
      /* 原包先落盘；落盘失败绝不发 HTTP */
      saved = await localStore.begin(draft);
    } catch (error) {
      busy = false;
      /* 回到最近一个稳定状态：滚动停止，错误可读，用户可再次决定是否继续 */
      phase = pickedCount() > 0 ? 'revealed' : 'idle';
      errorMessage = `本机恢复记录写入失败，未发送任何请求：${error.message}`;
      draw();
      return false;
    }
    if (!saved) {
      busy = false;
      phase = pickedCount() > 0 ? 'revealed' : 'idle';
      errorMessage = '另一页面已有待核实的抽签请求，请先核实后再继续。';
      draw();
      return false;
    }
    pending = saved;
    legacyPending = false;
    phase = op === 'start' ? 'starting' : op === 'stop' ? 'picking' : op === 'confirm' ? 'confirming' : phase;
    draw();
    try {
      const result = await api.post(`${sessionPath}/${op}`, packet, postOptions());
      if (!alive()) return false;
      await verifyReceipt(result?.receipt, packet, op, result);
      await settleReceipt(op, result || {});
      return true;
    } catch (error) {
      if (!alive()) return false;
      await handleFailure(error, op);
      return false;
    } finally {
      busy = false;
      if (alive()) draw();
    }
  }

  async function settleReceipt(op, result, { recovery = false } = {}) {
    const receipt = result?.receipt || {};
    const cleared = await localStore.remove(sessionKey, pending);
    if (!cleared) throw mismatch('抽取已在后台生效，本机核实记录未能更新，请再次核实');
    pending = null;
    legacyPending = false;
    errorMessage = '';
    if (op === 'cancel') {
      session = result?.session || null;
      phase = 'idle';
      notice = '本轮抽取已撤销；原正式出场顺序保持不变。';
      return;
    }
    if (op === 'confirm') {
      const drawn = rows(session?.order).map(Number);
      session = null;
      phase = 'idle';
      notice = '个人赛出场顺序已保存。';
      await loadRemote({ quiet: true });
      /* 正式签表必须与界面累计揭晓顺序是同一排列，否则不当作成功 */
      const saved = rows(official?.entries).map((row) => Number(row.id ?? row.participation_id));
      if (drawn.length && saved.length === drawn.length
          && drawn.some((id, index) => id !== saved[index])) {
        errorMessage = '正式签表与界面累计揭晓顺序不一致，请核对后台数据后再继续。';
      }
      if (alive()) { toast('个人赛出场顺序已保存', 'ok'); await onSaved(); }
      return;
    }
    if (result?.session) applySession(result.session, { revealId: receipt.picked_id ?? null });
    else await loadRemote({ quiet: true });
    if (op === 'start') {
      phase = blockedReason() ? 'blocked' : 'rolling';
      notice = `抽取过程已建立：共 ${totalCount()} 人，逐人揭晓。`;
    } else if (!recovery) {
      notice = `第 ${pickedCount()} 位已揭晓。`;
    }
  }

  async function handleFailure(error, op) {
    if (error?.cancelled) return;
    const rejected = error?.not_committed
      || (Number(error?.status) >= 400 && Number(error?.status) < 500 && !error.outcome_unknown);
    if (rejected) {
      /* 明确未提交：原包不再保留，读取后台现状后由用户继续 */
      if (pending && await localStore.remove(sessionKey, pending).catch(() => false)) pending = null;
      errorMessage = error.message || '抽签请求被拒绝，请核对后重试';
      await loadRemote({ quiet: true });
      return;
    }
    /* 响应丢失、超时、回执不符：保留原包，进入待核实 */
    phase = 'recovering';
    errorMessage = `${error?.message || '网络不可用'}；原请求已保留，请先核实结果再继续。`;
  }

  async function recoverPending() {
    if (!pending || busy || !alive()) return;
    if (legacyPending) { await verifyLegacyPending(); return; }
    busy = true;
    errorMessage = '';
    draw();
    try {
      const found = await api.get(`${sessionPath}/requests/${encodeURIComponent(pending.uid)}`, options());
      if (!alive()) return;
      if (found?.found) {
        await verifyReceipt(found.receipt, pending.payload, pending.op);
        await settleReceipt(pending.op, { receipt: found.receipt, session: null }, { recovery: true });
        await loadRemote({ quiet: true });
        notice = '原抽取请求已在后台生效，已读取最新进度（不重复抽取）。';
      } else {
        errorMessage = '后台没有这条请求的回执，说明它没有提交成功。'
          + '可用「重试原请求」按原包重试（沿用同一请求标识，不会重复抽取）。';
      }
    } catch (error) {
      errorMessage = `核实失败：${error.message}；原请求已保留，可再次核实或按原包重试。`;
    } finally {
      busy = false;
      if (alive()) draw();
    }
  }

  async function retryPending() {
    if (!pending || busy || !alive() || legacyPending) return;
    busy = true;
    errorMessage = '';
    notice = '';
    phase = pending.op === 'stop' ? 'picking' : pending.op === 'start' ? 'starting' : phase;
    draw();
    try {
      const result = await api.post(`${sessionPath}/${pending.op}`, pending.payload, postOptions());
      if (!alive()) return;
      await verifyReceipt(result?.receipt, pending.payload, pending.op, result);
      await settleReceipt(pending.op, result || {});
    } catch (error) {
      if (alive()) await handleFailure(error, pending?.op);
    } finally {
      busy = false;
      if (alive()) draw();
    }
  }

  /* 旧一次性预览的 pending：先查旧回执，命中仍按原结果完成核实；未命中由用户明确放弃 */
  async function verifyLegacyPending() {
    if (!pending) return;
    busy = true;
    errorMessage = '';
    draw();
    try {
      const found = await api.get(`${path}/requests/${encodeURIComponent(pending.uid)}`, options());
      if (!alive()) return;
      if (found?.found) {
        const receipt = found.receipt || {};
        if (!sameIdentity(receipt.event_identity) || Number(receipt.category_id) !== Number(category.id)) {
          errorMessage = '旧回执与当前项目不符，原请求已保留，请核对后再处理。';
        } else {
          if (!await localStore.remove(legacyKey, pending)) throw new Error('旧回执已生效，本机记录未能清理');
          pending = null;
          legacyPending = false;
          await loadRemote({ quiet: true });
          notice = `旧版一次性预览的保存结果已核实（正式修订 ${receipt.revision}）。`;
          toast('原抽签保存已核实', 'ok');
          await onSaved();
        }
      } else {
        errorMessage = '后台没有这条旧请求的回执，它没有提交成功。旧一次性预览已停用，'
          + '请确认放弃旧预览后改用逐人抽签。';
      }
    } catch (error) {
      errorMessage = `核实旧请求失败：${error.message}；原请求已保留。`;
    } finally {
      busy = false;
      if (alive()) draw();
    }
  }

  async function discardLegacyPending() {
    if (!pending) return;
    const ok = await confirmAsync('放弃旧版抽签预览',
      '旧版一次性预览已停用。放弃后本机不再保留这份未确认请求，正式出场顺序不受影响，可改用逐人抽签。',
      '放弃旧预览', { danger: true });
    if (!ok || !alive()) return;
    try {
      if (!await localStore.remove(legacyKey, pending)) throw new Error('本机记录已变化，请刷新后重试');
      pending = null;
      legacyPending = false;
      errorMessage = '';
      notice = '已放弃旧版未确认预览，可以开始逐人抽签。';
      await loadRemote({ quiet: true });
    } catch (error) {
      errorMessage = error.message;
    }
    if (alive()) draw();
  }

  /* ---------------------------------------------------------------- 操作入口 */
  function beginRoll() {
    if (!alive() || busy || offline || pending) return;
    if (!candidateRows().length) { errorMessage = '没有尚未抽取的候选，不能继续滚动。'; draw(); return; }
    errorMessage = '';
    notice = '';
    phase = 'rolling';
    draw();
  }

  async function stopAndReveal() {
    await perform('stop');
  }

  async function startRound() {
    await perform('start');
  }

  async function confirmOrder() {
    if (!session || session.status !== 'complete') {
      errorMessage = '还有运动员未抽完，不能确认正式出场顺序。';
      draw();
      return;
    }
    await perform('confirm');
  }

  async function askCancel() {
    if (!alive() || busy) return;
    const ok = await confirmAsync('放弃本轮抽取',
      '放弃后本轮已揭晓的名单不再作为正式顺序，原正式出场顺序保持不变。关闭本页不会自动撤销本轮抽取。',
      '放弃本轮抽取', { danger: true });
    if (!ok || !alive()) return;
    await perform('cancel');
  }

  /* ---------------------------------------------------------------- 渲染 */
  function mainLabel(total, picked) {
    const next = Math.min(picked + 1, Math.max(total, 1));
    if (readFailure) return '读取失败，请刷新状态';
    if (!canManage) return '出场顺序显示';
    if (!total) return '当前没有有效报名，不能抽签';
    if (officialLocked() && phase === 'idle') return '正式出场顺序已确认';
    if (phase === 'starting') return '正在建立抽取过程…';
    if (phase === 'rolling') return `正在抽第 ${next} 位`;
    if (phase === 'picking') return `正在揭晓第 ${next} 位…`;
    if (phase === 'confirming') return '正在保存正式出场顺序…';
    if (phase === 'recovering') return '抽取结果待核实';
    if (phase === 'blocked') return '本轮抽取已失效或被锁定';
    if (phase === 'complete') return `全部 ${total} 位已抽完，待确认正式顺序`;
    if (phase === 'revealed') return `第 ${picked} 位已揭晓`;
    return session ? `等待揭晓第 ${next} 位` : `等待开始：共 ${total} 人`;
  }

  function liveText(total, picked) {
    if (!canManage) return official?.status === 'stale' ? '旧出场顺序已失效，请重新核对。'
      : rows(official?.entries).length ? `正式出场顺序已保存，共 ${official.entries.length} 位参赛人员。` : '尚未保存正式出场顺序。';
    if (phase === 'revealed' || phase === 'complete') {
      const latest = revealedRows().at(-1);
      if (latest) return `第 ${latest.draw_order} 位已揭晓：${latest.name}（${schoolOf(latest)}）；已抽 ${picked} / ${total} 人`;
    }
    if (phase === 'blocked') return blockedReason();
    if (phase === 'recovering') return '抽签结果待核实，已暂停继续抽取。';
    return `已抽 ${picked} / ${total} 人`;
  }

  function orderTable(entries) {
    return table([
      { label: '出场序号', key: 'draw_order', align: 'num' },
      { label: '学校', render: (row) => row.school_short || row.school_name },
      { label: '运动员', key: 'name' },
    ], [...rows(entries)].sort((a, b) => (a.draw_order ?? Infinity) - (b.draw_order ?? Infinity)));
  }

  function draw() {
    if (!alive()) return;
    const manual = official?.source === 'manual';
    stopRoll();
    rollNameEl = null;
    rollSchoolEl = null;
    const total = totalCount();
    const picked = pickedCount();
    const next = Math.min(picked + 1, Math.max(total, 1));
    const candidates = candidateRows();
    const revealed = revealedRows();
    /* 面板节点必须跨重绘保持同一个：它就是全屏元素，一旦被换成新节点，
       浏览器会立刻退出全屏（全屏元素从文档移除会结束全屏）。 */
    let existing = container.querySelector(':scope > .individual-draw');
    if (!existing || panelElement !== existing) {
      clear(container);
      existing = h('section.panel.individual-draw', { 'aria-label': '个人赛出场顺序' });
      container.append(existing);
    } else {
      clear(existing);
    }
    const panel = existing;
    panelElement = panel;
    const locked = officialLocked();
    activeSection ||= session ? 'process' : official?.entries?.length || !canManage ? 'result' : 'pool';
    panel.dataset.drawPhase = phase;
    panel.dataset.drawPicked = String(picked);
    panel.dataset.drawTotal = String(total);
    panel.dataset.drawLock = locked ? 'true' : 'false';
    fullscreenButtonEl = null;

    panel.append(h('div.panel-head',
      h('div', h('h3', manual ? `人工出场顺序（${official.entries.length} 人 · 第 ${official.revision} 版）` : locked
          ? official.status === 'stale' ? '出场顺序已失效，请重新核对' : `正式出场顺序已确认（${total} 人 · 第 ${official.revision} 版）`
          : '个人赛出场顺序'),
        h('div.small.muted', `${categoryLabel(category, { withGroup: true })} · 共 ${total || '—'} 人`)),
      h('div.row.tight',
        canManage && activeSection !== 'pool' ? h('button.btn.small', { disabled: busy || !!pending || offline,
          onclick: () => openResultImport(category, async () => { await onRefreshClick(); await onSaved(); }, { isCurrent: alive }) }, '导入') : null,
        official?.entries?.length ? statusBadge(`${official.status === 'stale' ? '旧签表 · 已失效' : '正式签表'} · 第 ${official.revision} 版`, official.status === 'stale' ? 'warn' : 'ok') : statusBadge('尚未保存正式顺序', ''),
        fullscreenButtonEl = h('button.btn.small', {
          disabled: busy,
          dataset: { drawFullscreen: 'true' },
          'aria-pressed': fullscreenActive() ? 'true' : 'false',
          onclick: toggleFullscreen,
        }, fullscreenActive() ? '退出全屏' : '全屏显示'),
        h('button.btn.small', { disabled: busy, onclick: onRefreshClick }, '刷新状态'))));
    const navigation = drawFlowNavigation(panel, '个人赛抽签环节', [
      ...(poolAllowed ? [{ key: 'pool', label: '抽签池' }, { key: 'process', label: '抽签过程' }] : []),
      { key: 'result', label: '出场顺序显示' },
    ], activeSection, key => { activeSection = key; draw(); });
    panel.append(navigation);
    if (official?.source === 'manual') panel.append(h('p.small.muted', '本次为人工排序结果，排序号原值保留；本次写入行按文件行序展示，未修改的原记录随后保留。同号不判定先后，系统未做二次调整。'));

    /* 操作区固定在进度条正下方、所有可变内容之前：状态提示与名单只在它之后变化，
       因此从开始抽签到确认全程按钮停在同一条水平线上。 */
    panel.append(h('div.draw-progress',
      h('span.draw-progress-count', { dataset: { drawCount: String(picked) } },
        manual ? `已录入 ${official.entries.length} 人` : !canManage ? official?.status === 'stale' ? '旧顺序已失效' : rows(official?.entries).length ? `已保存 ${official.entries.length} 人` : '尚未保存正式顺序'
          : locked ? `已确认 ${total} 人` : `已抽 ${picked} / ${total} 人`),
      h('span.small.muted', manual ? `人工结果 · ${Math.max(total - official.entries.length, 0)} 人未入榜` : locked
        ? `第 ${official.revision} 版 · 已有成绩不可重抽`
        : canManage ? `未抽候选 ${Math.max(total - picked, 0)} 人` : '只读查看正式结果')));

    const actions = h('div.row.tight.draw-actions.mt', { dataset: { drawActions: 'true' } });
    if (canManage && !manual) {
      if (phase === 'idle' && session) {
        actions.append(h('button.btn.btn-primary', { disabled: !canAct() || candidateRows().length === 0,
          onclick: () => beginRoll() }, '开始抽签'));
      } else if (phase === 'idle') {
        actions.append(h('button.btn.btn-primary', {
          disabled: !canAct() || !total,
          title: lockReason() || null,
          onclick: () => startRound(),
        }, locked ? '重新抽签（已有成绩不可重抽）' : (rows(official?.entries).length ? '重新抽签' : '开始抽签')));
      } else if (phase === 'rolling') {
        actions.append(h('button.btn.btn-primary', { disabled: busy || offline || !!pending || !!readFailure,
          onclick: () => stopAndReveal() }, '停止并揭晓'));
      } else if (phase === 'revealed') {
        actions.append(h('button.btn.btn-primary', {
          disabled: !canAct() || session?.can_pick === false || candidateRows().length === 0,
          onclick: () => beginRoll(),
        }, '抽下一位'));
      } else if (phase === 'picking') {
        actions.append(h('button.btn.btn-primary', { disabled: true }, '正在揭晓…'));
      } else if (phase === 'starting') {
        actions.append(h('button.btn.btn-primary', { disabled: true }, '正在建立抽取过程…'));
      } else if (phase === 'complete') {
        actions.append(h('button.btn.btn-primary', {
          disabled: !canAct() || session?.can_confirm === false,
          onclick: () => confirmOrder(),
        }, '确认保存出场顺序'));
      } else if (phase === 'confirming') {
        actions.append(h('button.btn.btn-primary', { disabled: true }, '正在保存…'));
      } else if (phase === 'blocked') {
        actions.append(h('button.btn', { disabled: true }, '抽取已禁用'));
      }
      if (session && phase !== 'picking' && phase !== 'starting' && phase !== 'confirming') {
        actions.append(h('button.btn.btn-ghost', { disabled: busy || offline || !!pending || !!readFailure,
          onclick: () => askCancel() }, '放弃本次抽取'));
      }
    }
    if (actions.childElementCount) panel.append(actions);
    if (fullscreenMessage) {
      panel.append(h('div.warn-box.mb', { dataset: { drawFullscreenNotice: 'true' } }, fullscreenMessage));
    }

    if (pending) {
      panel.append(h('div.warn-box', { dataset: { drawPending: legacyPending ? 'legacy' : 'session' } },
        legacyPending
          ? '检测到旧版一次性预览的未确认请求，原请求已保留。核实前不能开始逐人抽签。'
          : '有一份抽签请求的结果待核实，原请求已保留。核实前不能继续抽取。',
        h('div.row.tight.mt',
          h('button.btn.btn-primary.small', { disabled: busy || offline, onclick: () => recoverPending() },
            legacyPending ? '核实旧请求' : '核实原请求'),
          !legacyPending && phase === 'recovering'
            ? h('button.btn.small', { disabled: busy || offline, onclick: () => retryPending() }, '重试原请求') : null,
          legacyPending ? h('button.btn.btn-ghost.small', { disabled: busy, onclick: () => discardLegacyPending() }, '放弃旧预览') : null)));
    }
    if (blockedReason()) {
      panel.append(h('div.warn-box.mb', { dataset: { drawBlocked: 'true' } },
        blockedReason(),
        h('div.small.muted', '抽取与确认已禁用。请核对报名名单；如确认本轮作废，可“放弃本次抽取”后重新开始。')));
    }
    /* 只读角色不显示锁定横幅（它们本来就没有操作按钮）；有管理权限时说明为何不能操作。
       can_draw=false 但没有正式签表（先领取/先有成绩）时也显示原因，避免按钮无故禁用。 */
    if (canManage && !manual && !session && !offline && lockReason()) {
      panel.append(h('div.warn-box.mb', { dataset: { drawLocked: 'true' } },
        locked
          ? `正式出场顺序已确认（第 ${official.revision} 版），已有成绩不可重抽。`
          : '当前状态已锁定，不能开始抽签。',
        lockReason() ? h('div.small.muted', lockReason()) : null));
    }
    if (offline) {
      panel.append(h('div.warn-box.mb', { dataset: { drawOffline: 'true' } },
        `当前离线：显示 ${cachedAt ? `${cachedAt} ` : ''}读取的只读缓存，抽取与确认已禁用。`
        + '恢复联网后会先核实待确认请求与最新进度。'));
    }

    const body = h('div.draw-body', { 'data-draw-section': 'process' });
    const card = h('div.draw-main-card');
    card.append(h('div.draw-main-label', { dataset: { drawMainLabel: 'true' } }, mainLabel(total, picked)));
    if (phase === 'rolling') {
      if (reducedMotion()) {
        card.append(h('div.draw-roll-static', `正在抽第 ${next} 位，待揭晓`),
          h('div.small.muted', '已按“减少动态效果”设置停用姓名滚动；抽取仍由后台完成。'));
      } else {
        const first = candidates[(rollIndex + 0) % Math.max(candidates.length, 1)];
        rollNameEl = h('div.draw-roll-name', first ? first.name : '等待候选');
        rollSchoolEl = h('div.draw-roll-school', first ? schoolOf(first) : '');
        card.append(h('div.draw-roll', { dataset: { drawRolling: 'true' } },
          rollNameEl, rollSchoolEl,
          h('div.small.muted', '滚动只展示尚未抽到的候选，出场顺序由后台抽取决定。')));
      }
    } else if (phase === 'picking') {
      card.append(h('div.draw-wait', { role: 'status' }, '正在揭晓…'));
    } else if (phase === 'starting') {
      card.append(h('div.draw-wait', '正在建立抽取过程…'));
    } else if (phase === 'confirming') {
      card.append(h('div.draw-wait', '正在保存正式出场顺序…'));
    } else if (phase === 'revealed' || phase === 'complete') {
      const latest = revealed.at(-1);
      if (latest) {
        card.append(h('div.draw-reveal', { dataset: { drawReveal: String(latest.draw_order) } },
          h('div.draw-reveal-order', `出场序号 ${latest.draw_order}`),
          h('div.draw-reveal-name', latest.name),
          h('div.draw-reveal-school', schoolOf(latest))));
      }
    } else if (phase === 'blocked') {
      card.append(h('div.small.muted', '本轮抽取已失效或被锁定，不能继续抽取或确认。'));
    } else if (phase === 'recovering') {
      card.append(h('div.small.muted', '结果待核实：请先用原请求核实，核实前不会继续抽取。'));
    } else {
      card.append(h('div.small.muted', readFailure ? '读取失败不代表没有报名或没有正式结果，请重试。' : !canManage
        ? '此处仅展示已保存的正式出场顺序；未保存正式顺序不代表没有有效报名。' : total
        ? (locked
          ? `共 ${total} 位运动员的出场顺序已确认（第 ${official.revision} 版）。已有成绩或记录任务领取，不能重新抽签。`
          : lockReason()
            ? `当前状态已锁定：${lockReason()}`
            : `尚未开始：共 ${total} 位运动员，点击“开始抽签”后逐人揭晓，出场顺序以后台抽取结果为准。`)
        : '当前没有有效报名，不能抽签。'));
    }
    body.append(card);

    const lists = h('div.draw-columns');
    const poolRows = poolAllowed ? drawPool(roster || rows(session?.session_roster || session?.roster)) : [];
    const pickedIds = new Set(revealed.map(row => row.id));
    const poolSection = h('section.draw-card.mt', { 'data-draw-section': 'pool', 'aria-label': '个人赛抽签池' },
      h('div.panel-head', h('h4', '抽签池'), h('span.small.muted', `有效报名 ${poolRows.length} 人`)),
      readFailure || blockedReason() ? h('div.warn-box.mb', readFailure || blockedReason())
        : offline ? h('div.warn-box.mb', '当前离线，显示上次读取的名单。') : null,
      poolRows.length ? h('div.table-scroll', table([
        { label: '选手', render: personOf },
        { label: '学校', render: schoolOf },
        { label: '报名编号', key: 'id' },
        { label: '抽取状态', render: row => pickedIds.has(row.id) ? '已抽取' : '未抽取' },
      ], poolRows, { class: 'draw-pool-table', responsive: true })) : h('p.muted', readFailure ? '抽签池读取失败，请刷新状态。' : '暂无有效报名'));
    if (poolAllowed) panel.append(poolSection);
    lists.append(h('section.draw-card',
      h('div.panel-head', h('h4', `已抽名单（${revealed.length}）`)),
      revealed.length
        ? h('ol.draw-revealed', ...revealed.map((row) => h('li', {
          dataset: { drawOrder: String(row.draw_order),
            drawNew: String(row.id) === String(lastRevealedId) ? 'true' : 'false' },
        },
        h('span.draw-order', `第 ${row.draw_order} 位`),
        h('span.draw-person', row.name || ''),
        h('span.small.muted', schoolOf(row)))))
        : h('p.small.muted', '尚未揭晓：不显示完整排序，避免把名单顺序当成正式出场顺序。')));
    body.append(lists);
    if (poolAllowed) {
      if (manual) panel.append(
        h('section.mt', { 'data-draw-section': 'process' }, h('h4', '人工结果录入'), h('p.small.muted', '结果由人工在线下确定，本次未执行系统抽签；维护结果请使用“导入”。')));
      else panel.append(body);
    }

    const live = h('div.draw-live', { 'aria-live': 'polite', 'aria-atomic': 'true' },
      h('div.draw-live-status', liveText(total, picked)),
      readFailure ? h('div.warn-box', { role: 'alert', 'data-draw-read-error': 'true' }, readFailure) : null,
      errorMessage ? h('div.warn-box', { dataset: { drawError: 'true' } }, errorMessage) : null,
      notice ? h('div.info-box', { dataset: { drawNotice: 'true' } }, notice) : null);
    panel.append(live);

    const resultSection = h('section.draw-result.mt', { 'data-draw-section': 'result', 'aria-label': '出场顺序显示' }, h('h3', '出场顺序显示'));
    resultSection.dataset.resultStatus = readFailure ? 'read-failed' : offline ? 'cached' : official?.status || 'unknown';
    panel.append(resultSection);
    if (rows(official?.entries).length) {
      resultSection.append(h('details.draw-official.mt', {
        open: phase === 'idle' && !rows(session?.revealed).length ? '' : null,
      }, h('summary', `正式签表（${rows(official.entries).length} 人 · 第 ${official.revision} 版`
        + `${official.confirmed_at ? ` · ${official.confirmed_at}` : ''}）`),
      h('div.table-scroll', orderTable(official.entries)),
      official.status === 'stale'
        ? h('div.warn-box.mt', '报名名单已变化，这份正式顺序基于旧名单；新加入的运动员尚未抽签。') : null));
    } else if (readFailure) resultSection.append(h('p.muted', '正式出场顺序尚未读取成功，请刷新状态。'));

    for (const child of [...panel.children].slice([...panel.children].indexOf(navigation) + 1)) {
      child.classList.toggle('hidden', child === poolSection ? activeSection !== 'pool'
        : child === resultSection ? activeSection !== 'result' : activeSection !== 'process');
    }
    if (phase === 'rolling' && activeSection === 'process') startRoll();
  }

  async function onRefreshClick() {
    if (busy) return;
    if (pending) { await recoverPending(); return; }
    busy = true;
    errorMessage = '';
    notice = '';
    /* 恢复联网先核实 pending 与最新状态 */
    offline = false;
    await loadRemote({ quiet: true });
    busy = false;
    if (alive()) draw();
  }

  /* ---------------------------------------------------------------- 生命周期 */
  function onVisibility() {
    if (!alive()) return;
    /* 隐藏或返回都只显示已保存进度：不自动抽人、不发请求 */
    if (phase === 'rolling') phase = pickedCount() > 0 ? 'revealed' : 'idle';
    stopRoll();
    draw();
    if (!document.hidden && !offline && !pending && canManage) {
      loadRemote().then(() => { if (alive()) draw(); }).catch(() => {});
    }
  }

  async function onOnline() {
    if (!alive()) return;
    offline = false;
    if (pending) await recoverPending();
    else await loadRemote({ quiet: true });
    if (alive()) draw();
  }

  function onOffline() {
    if (!alive()) return;
    offline = true;
    stopRoll();
    if (phase === 'rolling') phase = pickedCount() > 0 ? 'revealed' : 'idle';
    draw();
  }

  let observer = null;
  function cleanup() {
    stopRoll();
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
    document.removeEventListener('fullscreenerror', onFullscreenError);
    document.removeEventListener('webkitfullscreenerror', onFullscreenError);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    observer?.disconnect();
    observer = null;
    if (canManage) setPageLeaveGuard(null);
    setRouterBlockGuard(null, alive);
    /* 离开页面时不把浏览器留在全屏：只走原生退出路径，失败也不阻塞卸载。 */
    if (fullscreenActive()) {
      try { document.exitFullscreen?.()?.catch?.(() => {}); } catch { /* 已不在全屏 */ }
    }
  }
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);
  document.addEventListener('fullscreenerror', onFullscreenError);
  document.addEventListener('webkitfullscreenerror', onFullscreenError);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  signal?.addEventListener('abort', cleanup, { once: true });
  const host = container.closest('#content') || document.body;
  if (globalThis.MutationObserver) {
    observer = new MutationObserver(() => { if (!container.isConnected) cleanup(); });
    observer.observe(host, { childList: true });
  }
  if (canManage) {
    setPageLeaveGuard(async () => {
      /* 全屏时关闭页面：先讨论清全屏，避免浏览器把离开提醒与全屏退出混在一起。 */
      if (fullscreenActive()) {
        try { await document.exitFullscreen?.(); } catch { /* 继续关闭 */ }
        return true;
      }
      if (busy) return false;
      return confirmAsync('离开个人赛抽签',
        '本轮进度已保存在后台，返回本项目可以继续。关闭本页不会撤销本轮抽取，放弃本轮须在页面中明确操作。',
        '保留进度并关闭');
    }, () => busy || !!pending || phase === 'rolling', alive);
  }
  /* 站内切换菜单：全屏时先提示退出全屏（否则新页面仍停留在全屏视图里），
     抽取/确认请求进行中（busy）时短暂拦住，其余情况直接放行。 */
  setRouterBlockGuard(async () => {
    if (fullscreenActive()) {
      await confirmAsync('退出全屏后继续',
        '当前页面处于全屏显示。切换菜单前会先退出全屏，抽取进度保留在后台。',
        '退出全屏并继续');
      return true;
    }
    return !busy;
  }, alive);

  /* ---------------------------------------------------------------- 启动 */
  let stored = null;
  try {
    if (canManage) {
      stored = await localStore.get(sessionKey);
      if (!stored?.payload) {
        const legacy = await localStore.get(legacyKey).catch(() => null);
        if (legacy?.payload) { stored = legacy; legacyPending = true; }
      }
    }
  } catch (error) {
    if (alive()) container.append(errorState(error));
    return { update() {}, refresh: async () => {}, destroy: cleanup };
  }
  if (!alive()) return { update() {}, refresh: async () => {}, destroy: cleanup };
  if (stored?.payload) { pending = stored; phase = 'recovering'; }
  mounted = true;
  if (offline) {
    const cached = await localStore.get(cacheKey).catch(() => null);
    if (cached?.data) { official = cached.data; cachedAt = cached.data.cached_at || cachedAt; }
    cachedAt = cachedAt || official?.cached_at || '上次';
  } else {
    await loadRemote({ quiet: true });
  }
  if (!alive()) return { update() {}, refresh: async () => {}, destroy: cleanup };
  draw();

  async function update(next, cached = false) {
    if (!alive()) return;
    if (next) {
      official = next;
      if (cached) { offline = true; cachedAt = next.cached_at || cachedAt || '上次'; }
    }
    draw();
    /* 本视图重复加载时顺带核对后台最新进度；刚读过则不重复请求 */
    if (canManage && !offline && !pending && !busy && Date.now() - lastSessionAt > 2000) {
      await refreshSession({ quiet: true });
      if (alive()) draw();
    }
  }

  return { update, refresh: async () => { await loadRemote({ quiet: true }); if (alive()) draw(); },
    destroy: cleanup };
}

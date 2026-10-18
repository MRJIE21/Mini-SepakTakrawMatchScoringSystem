/* 体育馆大屏：只读展示，按管理员推送的布局与实时快照渲染。 */
const TOKEN_KEY = 'stss_display_token';
const SECRET_KEY = 'stss_display_secret';
const STATUS_TEXT = {
  live: '进行中', upcoming: '待开始', finished: '已结束', stale: '数据暂未同步',
  unassigned: '未指定', missing: '场次不存在', void: '轮空',
};
const MAX_FAILURES = 2;
const EVENT_ID_PATTERN = /^\d+$/;
const query = new URLSearchParams(location.search);
const previewMode = query.get('preview') === '1';
const previewEventId = query.get('event_id') || '';
const previewUrlVersion = Number.parseInt(query.get('v') || '', 10);
const previewDirty = query.get('dirty') === '1';
const ADMIN_TOKEN_KEY = 'stss_token';

const pairing = document.getElementById('pairing');
const screen = document.getElementById('screen');
const grid = document.getElementById('grid');
const codeEl = document.getElementById('pair-code');
const pairStatus = document.getElementById('pair-status');
const pairRefresh = document.getElementById('pair-refresh');
const reconnect = document.getElementById('reconnect');
const previewBadge = document.getElementById('preview-badge');
const previewVersionEl = document.getElementById('pv-version');
const previewDirtyEl = document.getElementById('pv-dirty');
const overlay = document.getElementById('overlay');
const ovEyebrow = document.getElementById('ov-eyebrow');
const ovTitle = document.getElementById('ov-title');
const ovText = document.getElementById('ov-text');
const ovHint = document.getElementById('ov-hint');

let token = localStorage.getItem(TOKEN_KEY) || '';
let deviceSecret = localStorage.getItem(SECRET_KEY) || '';
let pairId = null;
let revision = null;
let stateVersion = null;
let failCount = 0;
let stateTimer = null;
let pairTimer = null;
let lastMode = '';
let pollMs = 500;
let backAction = null;
let previewStopped = false;

function fit() {
  const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  document.documentElement.style.fontSize = Math.max(10, Math.min(36, scale * 16)) + 'px';
}

function ensureSecret() {
  if (!deviceSecret) {
    deviceSecret = globalThis.crypto?.randomUUID?.()
      || `display-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(SECRET_KEY, deviceSecret);
  }
  return deviceSecret;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function showPairing() {
  screen.classList.add('hidden');
  pairing.classList.remove('hidden');
}

function showScreen() {
  pairing.classList.add('hidden');
  screen.classList.remove('hidden');
  fit();
}

function clearTimers() {
  clearTimeout(stateTimer);
  clearTimeout(pairTimer);
  stateTimer = null;
  pairTimer = null;
}

function setReconnect(visible) {
  reconnect.classList.toggle('hidden', !visible);
}

function setPreviewVersion(value) {
  if (!previewVersionEl) return;
  const revision = Number(value);
  previewVersionEl.textContent = `v${Number.isInteger(revision) && revision >= 0 ? revision : 0}`;
}

function setupPreviewChrome() {
  if (!previewMode) return;
  document.body.classList.add('preview');
  if (!previewBadge) return;
  setPreviewVersion(previewUrlVersion);
  previewDirtyEl?.classList.toggle('hidden', !previewDirty);
  previewBadge.classList.remove('hidden');
}

function returnToConsole() {
  // 预览多由控制台 window.open 打开；若当前窗口不允许 close（如手动输入 URL），退回控制台首页。
  window.close();
  if (!window.closed) location.href = '/';
}

function previewBlocked(message, options = {}) {
  // 预览失败后不再自动轮询：可见性恢复/定时器都不能把“连接中断”重新带回来。
  previewStopped = true;
  clearTimers();
  showPairing();
  codeEl.textContent = '预览';
  pairStatus.textContent = message;
  if (options.back) {
    backAction = returnToConsole;
    pairRefresh.textContent = '返回控制台';
    pairRefresh.classList.remove('hidden');
  } else {
    backAction = null;
    pairRefresh.textContent = '换一个配对码';
    pairRefresh.classList.add('hidden');
  }
}

function invalidateToken() {
  token = '';
  revision = null;
  stateVersion = null;
  localStorage.removeItem(TOKEN_KEY);
  clearTimers();
  startPairing();
}

async function startPairing() {
  token = '';
  revision = null;
  stateVersion = null;
  failCount = 0;
  setReconnect(false);
  showPairing();
  codeEl.textContent = '------';
  pairStatus.textContent = '正在生成配对码…';
  try {
    const response = await fetchWithTimeout('/api/display/pair/start', {
      method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_secret: ensureSecret() }),
    }, 5000);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || '配对码生成失败');
    pairId = data.id;
    codeEl.textContent = data.code;
    pairStatus.textContent = '等待管理员确认…';
    pairTimer = setTimeout(pollPair, 1000);
  } catch (error) {
    pairStatus.textContent = error.message || '配对服务暂不可用，正在重试…';
    pairTimer = setTimeout(startPairing, 2000);
  }
}

async function pollPair() {
  if (!pairId) { pairTimer = setTimeout(startPairing, 1000); return; }
  try {
    const response = await fetchWithTimeout(
      `/api/display/pair/status?id=${encodeURIComponent(pairId)}&device_secret=${encodeURIComponent(ensureSecret())}`,
      { cache: 'no-store' }, 4000);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || '配对状态读取失败');
    if (data.status === 'claimed' && data.token) {
      token = data.token;
      localStorage.setItem(TOKEN_KEY, token);
      pairStatus.textContent = '配对成功，正在进入展示…';
      showScreen();
      pollState();
      return;
    }
    if (data.status === 'expired') { startPairing(); return; }
    pairTimer = setTimeout(pollPair, 1000);
  } catch {
    pairTimer = setTimeout(pollPair, 1500);
  }
}

async function pollState() {
  if (previewMode && previewStopped) return;
  const adminToken = previewMode ? (localStorage.getItem(ADMIN_TOKEN_KEY) || '') : '';
  if (previewMode && (!adminToken || !EVENT_ID_PATTERN.test(previewEventId))) {
    previewBlocked('预览需要管理员登录，请从大屏控制台打开', { back: true });
    return;
  }
  if (!previewMode && !token) return;
  clearTimeout(stateTimer);
  try {
    const response = await fetchWithTimeout(
      previewMode
        ? `/api/display/preview?event_id=${encodeURIComponent(previewEventId)}`
        : '/api/display/state',
      {
        cache: 'no-store',
        headers: { Authorization: previewMode ? `Bearer ${adminToken}` : `Display ${token}` },
      }, 4000);
    if (previewMode && (response.status === 400 || response.status === 404)) {
      // 赛事不存在/参数非法：停止轮询并给出具体原因与返回入口，避免无限“连接中断”。
      const payload = await response.json().catch(() => ({}));
      previewBlocked(String(payload.message || '赛事不存在或预览参数无效'), { back: true });
      return;
    }
    if (response.status === 401 || response.status === 403) {
      if (previewMode) {
        previewBlocked('预览凭据已失效或账号无权查看该赛事，请重新登录控制台');
        return;
      }
      invalidateToken();
      return;
    }
    if (!response.ok) throw new Error('state unavailable');
    const data = await response.json();
    if (previewMode) {
      const serverRevision = Number(data.config_revision);
      if (Number.isInteger(serverRevision)) setPreviewVersion(serverRevision);
    }
    failCount = 0;
    setReconnect(false);
    const configured = Number(data.poll_ms);
    if (Number.isFinite(configured)) {
      pollMs = Math.min(1000, Math.max(100, Math.round(configured)));
    }
    // state_version also covers live->stale, match deletion, void and mode changes;
    // fall back to the legacy revision for older servers.
    const nextVersion = data.state_version || data.revision;
    const changed = nextVersion !== stateVersion || data.mode !== lastMode;
    stateVersion = nextVersion;
    revision = data.revision;
    lastMode = data.mode;
    if (changed) render(data);
    stateTimer = setTimeout(pollState, data.mode === 'score' ? pollMs : 2000);
  } catch {
    failCount += 1;
    if (failCount >= MAX_FAILURES) setReconnect(true);
    stateTimer = setTimeout(pollState, 1000);
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function tileNode(tile) {
  const article = el('article', `tile status-${tile.status}`);
  const top = el('div', 'tile-top');
  const court = el('span', 'court', tile.court || '');
  if (tile.round) court.append(el('span', 'round', tile.round));
  top.append(court, el('span', `chip ${tile.status}`, STATUS_TEXT[tile.status] || tile.status));
  article.append(top);

  const board = el('div', 'board');
  board.append(teamNode(tile.home, 'home'), midNode(tile), teamNode(tile.away, 'away'));
  article.append(board);
  return article;
}

function teamNode(team, side) {
  const box = el('div', `team ${side}`);
  box.append(el('div', 'name', team?.name || '—'));
  const points = team?.points;
  box.append(el('div', 'points', points === null || points === undefined ? '–' : points));
  return box;
}

function midNode(tile) {
  const mid = el('div', 'mid');
  const series = el('div', 'series');
  if (tile.status === 'live' || tile.status === 'finished' || tile.status === 'stale') {
    series.append(
      el('span', 'val home', tile.home?.sets ?? 0),
      el('span', 'sep', ':'),
      el('span', 'val away', tile.away?.sets ?? 0),
    );
  } else {
    series.append(el('span', 'val', '–'), el('span', 'sep', ':'), el('span', 'val', '–'));
  }
  mid.append(series);
  let label = '';
  if (tile.status === 'live') label = tile.current_set ? `第 ${tile.current_set} 局` : '进行中';
  else if (tile.status === 'finished') label = '已结束';
  else if (tile.status === 'stale') label = '数据暂未同步';
  else if (tile.status === 'upcoming') label = tile.scheduled_at ? String(tile.scheduled_at).slice(11, 16) : '待开始';
  else if (tile.status === 'void') label = '轮空';
  else if (tile.status === 'missing') label = '场次不存在';
  else label = '未选择';
  mid.append(el('div', 'setlabel', label));
  if (tile.status === 'live' || tile.status === 'finished' || tile.status === 'stale') {
    const sets = el('div', 'sets');
    for (const item of tile.sets || []) {
      sets.append(el('div', `set-pill ${item.state || ''}`, item.label));
    }
    if (sets.childNodes.length) mid.append(sets);
  }
  return mid;
}

function renderOverlay(data) {
  const title = data.announcement?.title || '';
  const body = data.announcement?.body || '';
  const standby = data.mode === 'standby';
  overlay.classList.toggle('hidden', data.mode === 'score');
  if (data.mode === 'score') return;
  ovEyebrow.classList.toggle('hidden', standby);
  ovText.classList.toggle('hidden', standby);
  ovHint.classList.add('hidden');
  ovEyebrow.textContent = '赛事公告';
  ovTitle.textContent = standby ? '比赛即将开始' : (title || '赛事公告');
  ovText.textContent = body;
  ovHint.textContent = '';
}

function render(data) {
  const layout = [1, 2, 3, 4, 8].includes(Number(data.layout)) ? Number(data.layout) : 8;
  grid.dataset.layout = String(layout);
  grid.innerHTML = '';
  const tiles = (data.slots || []).filter((tile) => tile.visible);
  if (!tiles.length) {
    grid.classList.add('empty');
    grid.append(el('div', '', '当前没有显示窗口，请在控制台选择场次并推送。'));
  } else {
    grid.classList.remove('empty');
    for (const tile of tiles) grid.append(tileNode(tile));
  }
  renderOverlay(data);
  fit();
}

pairRefresh.addEventListener('click', () => {
  if (backAction) { const action = backAction; backAction = null; action(); return; }
  pairId = null;
  startPairing();
});
window.addEventListener('resize', fit);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (previewMode && localStorage.getItem(ADMIN_TOKEN_KEY)) pollState();
  else if (!previewMode && token) pollState();
});

fit();
setupPreviewChrome();
if (previewMode) {
  if (!previewEventId) previewBlocked('预览缺少赛事参数，请从大屏控制台打开', { back: true });
  else if (!EVENT_ID_PATTERN.test(previewEventId)) {
    previewBlocked('预览参数无效（event_id 必须是数字），请从大屏控制台打开', { back: true });
  } else if (!localStorage.getItem(ADMIN_TOKEN_KEY)) {
    previewBlocked('预览需要管理员登录，请从大屏控制台打开', { back: true });
  } else { showScreen(); pollState(); }
} else if (token) {
  showScreen();
  pollState();
} else {
  startPairing();
}

/* 应用入口：登录、导航、路由与全局状态。 */
import { api, ApiError, getToken, setToken, setApiEventContext, setApiUser, setApiReadScope, captureRequestContext, validateReceipt } from './api.js';
import { clear, h, toast, prepareNavigation, setPageLeaveGuard } from './ui.js';
import { canView } from './permissions.js';
import { setStoreUser } from './store.js';
import { setPendingRequestScope } from './pendingRequests.js';

export const state = {
  user: null,
  roles: {},
  events: [],
  eventId: null,
  deploymentId: '',
  structure: null,
  views: {},
  offline: false,      // 本次会话是否正在使用本机缓存运行
};

/* 一级导航（改进方案 §3.1）：日常项目任务统一进入工作台，维护类靠后。 */
const NAV = [
  { group: '赛事管理', items: ['dashboard', 'setup'] },
  { group: '比赛管理', items: ['schoolRegistration', 'workspace'] },
  { group: '比赛执行', items: ['field', 'scoring'] },
  { group: '成绩', items: ['school'] },
  { group: '系统维护', items: ['admin', 'users'] },
  { group: '个人', items: ['account'] },
];

export function registerView(def) {
  state.views[def.name] = def;
}

export function currentEvent() {
  return state.events.find((e) => e.id === state.eventId) || null;
}

export function go(name, params = {}) {
  const query = new URLSearchParams(params).toString();
  location.hash = `#/${name}${query ? `?${query}` : ''}`;
}

/* ------------------------------------------------------------------ 登录 */
function renderLogin(message) {
  activeReadScope?.controller.abort();
  activeReadScope = null;
  routeGeneration++;
  setApiReadScope(null);
  setApiUser(null);
  document.getElementById('app').classList.add('hidden');
  const box = document.getElementById('login-screen') || h('div.login-screen', { id: 'login-screen' });
  clear(box);
  const username = h('input', { id: 'login-username', name: 'username', type: 'text', value: '',
    placeholder: '请输入用户名', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', autofocus: true });
  const password = h('input', { id: 'login-password', name: 'password', type: 'password', value: '',
    placeholder: '请输入密码', autocomplete: 'current-password' });
  const err = h('div.small', { style: 'color:#c0392b;min-height:18px' }, message || '');
  const submit = async () => {
    try {
      const res = await api.post('/api/login', { username: username.value, password: password.value });
      setToken(res.token);
      state.user = res.user;
      setApiUser(state.user);
      state.roles = res.roles || {};
      writeSessionCache(res);
      box.remove();
      document.getElementById('app').classList.remove('hidden');
      await boot();
    } catch (e) {
      err.textContent = e.message;
    }
  };
  box.append(
    h('form.login-card', { autocomplete: 'off', onsubmit: (event) => { event.preventDefault(); submit(); } },
      h('div.brand-login', h('span.logo', '藤'), h('div', h('div.title', '藤球比赛计分系统'),
        h('div.small.muted', '赛事计分与成绩管理'))),
      h('label.field', '用户名', username),
      h('label.field', '密码', password),
      err,
      h('button.btn.btn-primary', { type: 'submit', style: 'width:100%;margin-top:6px' }, '登录'),
      h('div.small.muted.mt', '使用管理员分配的账号登录；管理员首次启动时的初始密码见服务端启动输出。'),
    ),
  );
  document.body.append(box);
}

/* ------------------------------------------------------------------ 外壳 */
function renderShell() {
  setStoreUser(state.user);
  const nav = document.getElementById('sidenav');
  clear(nav);
  for (const group of NAV) {
    const items = group.items.map((name) => state.views[name]).filter(Boolean)
      .filter((v) => canView(state.user.role, v.name) && !(state.user.role === 'recorder' && ['workspace','scoring'].includes(v.name)));
    if (!items.length) continue;
    nav.append(h('div.nav-group', group.group));
    for (const view of items) {
      nav.append(h('a', { href: `#/${view.name}`, dataset: { view: view.name } }, view.label));
    }
  }
  const select = document.getElementById('event-select');
  clear(select);
  for (const ev of state.events) {
    select.append(h('option', { value: ev.id, selected: ev.id === state.eventId }, ev.name));
  }
  if (!state.events.length) select.append(h('option', { value: '' }, '（尚未创建赛事）'));
  select.onchange = async () => {
    const nextEventId = Number(select.value);
    location.hash = `#/workspace?event=${nextEventId}`;
  };
  const newEvent = document.getElementById('btn-new-event');
  const canCreateEvent = state.user.role === 'admin';
  newEvent.classList.toggle('hidden', !canCreateEvent);
  newEvent.onclick = canCreateEvent ? () => go('setup', { action: 'new' }) : null;
  document.getElementById('user-line').textContent =
    `${state.user.display_name}（${state.user.role_name}）`;
  document.getElementById('btn-logout').onclick = async () => {
    try { await api.post('/api/logout'); } catch { /* 忽略 */ }
    setToken('');
    location.reload();
  };
  const ev = currentEvent();
  document.getElementById('event-line').textContent = ev
    ? `${ev.name}${ev.location ? ` · ${ev.location}` : ''}` : '尚未创建赛事';
}

/* ------------------------------------------------------------------ 路由 */
/* 导航串行化：hash 变化与启动流程可能同时触发渲染，
   并发渲染会把同一页面追加两次，这里合并成一次只渲染最新目标。 */
let routeChain = Promise.resolve();
let routeQueued = false;
let skipNextHashRoute = false;
let renderedHash = '';
let routeGeneration = 0;
let activeReadScope = null;
const scopeCurrent = (scope) => !scope || scope.id === routeGeneration;
function assertScope(scope) { if (!scopeCurrent(scope)) { const error = new Error('旧页面已取消'); error.cancelled = true; throw error; } }

/* 同页选择只更新地址中的界面上下文；同步离页取消时的返回地址，不重新渲染表单。 */
export function replaceViewParams(params = {}) {
  const [name, query] = location.hash.replace(/^#\/?/, '').split('?');
  const next = new URLSearchParams(query || '');
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') next.delete(key);
    else next.set(key, String(value));
  }
  const suffix = next.toString();
  history.replaceState(null, '', `#/${name || 'dashboard'}${suffix ? `?${suffix}` : ''}`);
  renderedHash = location.hash;
}

async function route(force = false) {
  if (force && !await prepareNavigation()) return;
  activeReadScope?.controller.abort();
  const controller = new AbortController();
  const hash = location.hash;
  const query = hash.split('?')[1] || '';
  const requested = Number(new URLSearchParams(query).get('event') || state.eventId);
  const event = state.events.find((ev) => ev.id === requested);
  const context = captureRequestContext();
  const scope = { id: ++routeGeneration, controller, signal: controller.signal,
    context: { ...context, identity: event ? { event_id: event.id, event_uuid: event.uuid, deployment_id: state.deploymentId } : context.identity }, hash };
  activeReadScope = scope;
  routeQueued = true;
  routeChain = routeChain.catch(() => {}).then(async () => {
    if (!routeQueued || !scopeCurrent(scope)) return;
    routeQueued = false;
    setApiReadScope(scope);
    await renderRoute(false, scope);
  });
  return routeChain;
}

async function renderRoute(force = false, scope = null) {
  if (force && !await prepareNavigation()) return;
  setPageLeaveGuard(null);
  const raw = (scope?.hash || location.hash).replace(/^#\/?/, '') || 'dashboard';
  const [name, query] = raw.split('?');
  const params = Object.fromEntries(new URLSearchParams(query || ''));
  const view = state.views[name] || state.views.dashboard;
  if (!canView(state.user.role, view.name)) { location.hash = roleHome(); return; }
  document.querySelectorAll('.sidenav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.view === view.name);
  });
  const host = document.getElementById('content');
  const content = h('div.route-content');
  clear(host); host.append(content);
  if (!state.events.length && state.user.role !== 'admin' && view.name !== 'account') {
    content.append(h('div.panel', h('h3', '尚未分配赛事'),
      h('p', '请联系管理员在“账号管理 → 角色与赛事”中分配所属赛事。')));
    return;
  }
  try {
    await view.render({ el: content, params, state, refresh: () => scopeCurrent(scope) && route(true), force,
      signal: scope?.signal, requestContext: scope?.context, isCurrent: () => scopeCurrent(scope) });
  } catch (err) {
    if (err.cancelled || !scopeCurrent(scope)) return;
    clear(content);
    content.append(h('div.panel',
      h('h3', '页面加载失败'),
      h('div', err.message),
      err instanceof ApiError && err.status === 401
        ? h('button.btn.btn-primary.mt', { onclick: () => location.reload() }, '重新登录')
        : err.offline
          ? h('div.warn-box.mt', '当前离线：本页需要联网读取数据。三人赛与个人赛记录页可用本机缓存继续记录。')
          : null,
      h('button.btn.mt', { onclick: () => route(true) }, '重试')));
  }
  if (scopeCurrent(scope)) renderedHash = location.hash;
}

/* ------------------------------------------------------------------ 启动 */
async function loadEvents() {
  const scope = activeReadScope;
  try {
    const res = await api.get('/api/events');
    assertScope(scope);
    state.events = res.events;
    state.deploymentId = res.deployment_id || state.deploymentId;
    state.offline = false;
  } catch (err) {
    if (!err.offline) throw err;
    const cached = readContextCache();
    if (!cached || !cached.events) throw err;
    assertScope(scope);
    state.events = cached.events;
    state.deploymentId = cached.deploymentId || '';
    state.offline = true;
  }
  const saved = Number(localStorage.getItem('stss_event') || 0);
  state.eventId = state.events.some((e) => e.id === saved)
    ? saved : (state.events[0]?.id ?? null);
  const event = state.events.find((item) => item.id === state.eventId);
  setApiEventContext(event ? { ...event, deployment_id: state.deploymentId } : null);
}

export async function loadStructure() {
  const scope = activeReadScope;
  const selected = state.eventId;
  if (!state.eventId) { state.structure = null; return null; }
  try {
    const structure = await api.get(`/api/events/${selected}/structure`);
    assertScope(scope);
    if (state.eventId !== selected) return state.structure;
    state.structure = structure;
    writeContextCache();
  } catch (err) {
    if (!err.offline) throw err;
    const cached = readContextCache();
    let structure = null;
    try { structure = JSON.parse(localStorage.getItem(structureCacheKey())); } catch { /* 尝试旧缓存 */ }
    const event = currentEvent();
    if (!structure && cached?.structure?.event?.id === state.eventId
        && cached.structure.event.uuid === event?.uuid) structure = cached.structure;
    if (!structure || structure.event.id !== state.eventId || structure.event.uuid !== event?.uuid) throw err;
    assertScope(scope); state.structure = structure;
    state.offline = true;
  }
  return state.structure;
}

/* 新建或切换赛事后同步顶栏与外壳，不必整页刷新（Q08）。
   调用方在 await 之后拿到的 state.structure 就是最新结构。 */
export async function reloadShell(eventId) {
  const scope = activeReadScope;
  if (eventId) {
    state.eventId = eventId;
    localStorage.setItem('stss_event', String(eventId));
  }
  await loadEvents();
  assertScope(scope);
  const event = state.events.find((item) => item.id === state.eventId);
  setPendingRequestScope(state.user, event ? { ...event, deployment_id: state.deploymentId } : null);
  await loadStructure();
  assertScope(scope);
  renderShell();
  updateNetBadge();
  return state.structure;
}

/* 会话与上下文本机缓存：用于断网后仍能打开应用与记录页 */
const SESSION_KEY = 'stss_session_cache';
const CONTEXT_KEY = 'stss_context_cache';

function writeSessionCache(me) {
  setStoreUser(me.user);
  localStorage.setItem(SESSION_KEY, JSON.stringify({ user: me.user, roles: me.roles || {} }));
}
function readSessionCache() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}
function writeContextCache() {
  if (!state.events || !state.structure) return;
  localStorage.setItem(`${CONTEXT_KEY}:${state.user.id}:${state.user.role}`, JSON.stringify({
    deploymentId: state.deploymentId, events: state.events, structure: state.structure, saved_at: Date.now(),
  }));
  localStorage.setItem(structureCacheKey(), JSON.stringify(state.structure));
}
function structureCacheKey() {
  return `stss_structure:${state.user.id}:${state.user.role}:${state.deploymentId}:${currentEvent()?.uuid || ''}`;
}
function readContextCache() {
  try { return JSON.parse(localStorage.getItem(`${CONTEXT_KEY}:${state.user.id}:${state.user.role}`)); } catch { return null; }
}

export async function ensureEvent() {
  if (!state.eventId) throw new Error('请先在“赛事概览”中创建赛事');
  return state.eventId;
}

export function eventId() { return state.eventId; }

export function needRole(...roles) {
  if (!roles.includes(state.user.role)) throw new Error('当前角色没有该操作权限');
}

async function boot() {
  await loadEvents();
  /* 重试请求按账号、部署和赛事 UUID 隔离。 */
  const event = state.events.find((item) => item.id === state.eventId);
  setPendingRequestScope(state.user, event ? { ...event, deployment_id: state.deploymentId } : null);
  await loadStructure();
  renderShell();
  updateNetBadge();
  if (!location.hash) {
    skipNextHashRoute = true;      // 这次 hash 变化由下面的 route() 渲染，避免重复加载
    location.hash = roleHome();
  }
  await route();
}

/* 角色默认落地页（§12.1）：记录员直接进现场，查看者进成绩总览 */
function roleHome() {
  const role = state.user ? state.user.role : '';
  if (role === 'recorder') return '#/field';
  if (role === 'viewer') return '#/school';
  return '#/dashboard';
}

/* 网络状态徽标：浏览器离线、或服务器不可达而在用本机缓存时，都提示为离线 */
function updateNetBadge() {
  const badge = document.getElementById('net-badge');
  if (!badge) return;
  const online = navigator.onLine && !state.offline;
  badge.className = `badge ${online ? 'badge-ok' : 'badge-danger'}`;
  badge.textContent = online ? '在线' : '离线（本地记录中）';
}

/* 断网后恢复：区分“网络仍不可达”与“登录已失效”，前者继续用本机缓存，后者回到登录页 */
async function recoverIfOffline() {
  if (!state.offline) return false;
  const scope = activeReadScope;
  let me;
  try {
    me = await api.get('/api/me');
  } catch (err) {
    if (err.cancelled) throw err;
    if (err.status === 401 || err.code === 'account_changed') {
      setToken('');
      renderLogin('登录状态已失效，请重新登录。');
    }
    else if (!err.offline) toast(err.message, 'error');
    return false;
  }
  assertScope(scope);
  state.user = me.user;
  setApiUser(state.user);
  state.roles = me.roles || {};
  writeSessionCache(me);
  state.offline = false;
  await loadEvents();
  await loadStructure();
  renderShell();
  updateNetBadge();
  toast('已恢复联网，页面数据已刷新', 'ok');
  return true;
}

function watchNetwork() {
  window.addEventListener('online', async () => {
    updateNetBadge();
    try { if (await recoverIfOffline()) await route(true); }
    catch (error) { if (!error.cancelled) toast(error.message, 'error'); }
  });
  window.addEventListener('offline', updateNetBadge);
  updateNetBadge();
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* 离线缓存不可用时忽略 */ });
  }
}

export async function submitWithRetry(path, payload, options = {}) {
  try {
    const kind = path.endsWith('/individual') ? 'individual' : 'match';
    const subject = payload.match_id || payload.participation_id;
    return { ok: true, result: await api.post(path, payload, { ...options,
      validate: (result) => validateReceipt(result, payload, kind, subject) }) };
  } catch (err) {
    if (err.outcome_unknown) return { ok: false, message: '提交结果待核实，原内容已保留，请恢复连接后重试', error: err };
    return { ok: false, message: err.message, error: err };
  }
}

window.addEventListener('error', (e) => {
  if (e.message) toast(`页面错误：${e.message}`, 'error');
});

/* 载入各页面模块（注册到 state.views） */
async function loadViews() {
  await Promise.all([
    import('./views/dashboard.js'),
    import('./views/setup.js'),
    import('./views/catalog.js'),
    import('./views/workspace.js'),
    import('./views/schoolRegistration.js'),
    import('./views/field.js'),
    import('./views/scheduling.js'),
    import('./views/scoring.js'),
    import('./views/matchAdmin.js'),
    import('./views/individual.js'),
    import('./views/review.js'),
    import('./views/results.js'),
    import('./views/bracket.js'),
    import('./views/school.js'),
    import('./views/admin.js'),
  ]);
}

(async function start() {
  watchNetwork();
  registerServiceWorker();
  await loadViews();
  window.addEventListener('hashchange', async () => {
    if (skipNextHashRoute) { skipNextHashRoute = false; return; }
    if (!await prepareNavigation()) {
      if (renderedHash) history.replaceState(null, '', renderedHash);
      const select = document.getElementById('event-select');
      if (select) select.value = state.eventId ?? '';
      return;
    }
    try { await recoverIfOffline(); await route(); }
    catch (error) { if (!error.cancelled) toast(error.message, 'error'); }
  });
  if (!getToken()) { renderLogin(); return; }
  let me = null;
  try {
    me = await api.get('/api/me');
  } catch (err) {
    if (err.offline) {
      const cached = readSessionCache();
      if (cached && cached.user) {
        state.user = cached.user;
        setApiUser(state.user);
        setStoreUser(state.user);
        state.roles = cached.roles || {};
        state.offline = true;
        await boot();
        return;
      }
      renderLogin('当前离线且本机没有可用会话，请恢复联网后登录。');
      return;
    }
    setToken('');
    renderLogin();
    return;
  }
  state.user = me.user;
  setApiUser(state.user);
  state.roles = me.roles || {};
  state.offline = false;
  writeSessionCache(me);
  await boot();
})();

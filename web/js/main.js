/* 应用入口：登录、导航、路由与全局状态。 */
import { api, ApiError, getToken, setToken, setApiEventContext, setApiUser, setApiReadScope, captureRequestContext, validateReceipt, setUnauthorizedHandler } from './api.js';
import { clear, h, toast, prepareNavigation, setPageLeaveGuard, markPageLeaveGuardPending, settlePageLeaveGuard } from './ui.js';
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

/* 一级导航（改进方案 §3.1）：日常项目任务统一进入工作台，维护类靠后。
   学校报名与三人赛记录统一从工作台进入，记录员从现场任务进入。 */
const NAV = [
  { group: '赛事管理', items: ['dashboard', 'setup'] },
  { group: '比赛管理', items: ['workspace'] },
  { group: '比赛执行', items: ['field', 'display'] },
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
      sessionInvalidHandled = false;
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

/* 会话失效统一处理：api.js 遇到非登录接口 401 时单飞回调到这里，清会话并回登录页。 */
let sessionInvalidHandled = false;
export function handleSessionInvalid() {
  if (sessionInvalidHandled) return;
  sessionInvalidHandled = true;
  setToken('');
  setApiUser(null);
  state.user = null;
  if (!document.getElementById('login-screen')) renderLogin('登录状态已失效，请重新登录。');
  toast('登录状态已失效，请重新登录', 'error');
}
setUnauthorizedHandler(handleSessionInvalid);

/* 退出所有设备：吊销本账号全部令牌后清除本机会话并回到登录页。
   大屏设备使用独立凭据，不受影响。 */
export async function logoutEverywhere() {
  const result = await api.post('/api/me/logout-all');
  const revoked = Number(result?.revoked ?? 0);
  sessionInvalidHandled = true;      // 本次为主动退出，reload 前的任何 401 不再重复跳转
  toast(`已退出 ${revoked} 个设备`, 'ok');
  setToken('');
  setApiUser(null);
  state.user = null;
  /* 先让“已退出 N 个设备”的提示可见，再整页重载回登录页。 */
  await new Promise((resolve) => setTimeout(resolve, 600));
  location.reload();
}

/* ------------------------------------------------------------------ 外壳 */
function navigationView(name) {
  if (name === 'scoring') return state.user.role === 'recorder' ? 'field' : 'workspace';
  // 旧 teamRules 链接是赛事设置的渲染别名，侧栏高亮赛事设置。
  if (name === 'teamRules') return 'setup';
  return name;
}

/* 顶栏用户信息：显示名与角色名相同或为空时只显示一次，避免“赛事管理员（赛事管理员）”。
   空显示名回退 username；连 username 也没有时只显示角色名。数组/对象先转字符串再 trim。 */
function userLabel(user) {
  if (!user) return '';
  const role = String(user.role_name ?? '').trim();
  const name = String(user.display_name ?? '').trim() || String(user.username ?? '').trim();
  if (!name) return role;
  if (!role || name === role) return name;
  return `${name}（${role}）`;
}

function renderShell() {
  setStoreUser(state.user);
  const nav = document.getElementById('sidenav');
  clear(nav);
  const activeView = navigationView(location.hash.replace(/^#\/?/, '').split('?')[0]);
  for (const group of NAV) {
    const items = group.items.map((name) => state.views[name]).filter(Boolean)
      .filter((v) => canView(state.user.role, v.name) && !(state.user.role === 'recorder' && ['workspace','scoring'].includes(v.name)));
    if (!items.length) continue;
    nav.append(h('div.nav-group', group.group));
    for (const view of items) {
      nav.append(h('a', { href: `#/${view.name}`, dataset: { view: view.name }, class: view.name === activeView ? 'active' : '' }, view.label));
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
    const [currentView, query] = location.hash.replace(/^#\/?/, '').split('?');
    const params = new URLSearchParams(query || '');
    if (currentView === 'setup' || currentView === 'teamRules') {
      // 设置页内切换赛事保留当前合法分区；旧别名切到统一设置的第 4 个分区。
      const step = currentView === 'teamRules' ? 'rules' : params.get('step');
      const next = { event: nextEventId };
      if (['event', 'structure', 'venues', 'rules'].includes(step)) next.step = step;
      go('setup', next);
      return;
    }
    go('workspace', { event: nextEventId });
  };
  const newEvent = document.getElementById('btn-new-event');
  const canCreateEvent = state.user.role === 'admin';
  newEvent.classList.toggle('hidden', !canCreateEvent);
  newEvent.onclick = canCreateEvent ? () => go('setup', { action: 'new' }) : null;
  document.getElementById('user-line').textContent = userLabel(state.user);
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

/* URL 赛事参数单源解析（REQ-018）：在构造读作用域前把 state/API 上下文切到同一赛事。
   无 event 深链沿用当前赛事；非法/不可见值用 replaceState 保留其余参数回填当前赛事并提示；
   合法切换走 reloadShell（写回 stss_event、结构、顶栏）；403/404 一次性回退，标记防循环。 */
let routeEventFallbackUsed = false;

function replaceEventParam(eventId) {
  const [name, query] = location.hash.replace(/^#\/?/, '').split('?');
  const next = new URLSearchParams(query || '');
  if (eventId === null || eventId === undefined) next.delete('event');
  else next.set('event', String(eventId));
  const suffix = next.toString();
  history.replaceState(null, '', `#/${name || 'dashboard'}${suffix ? `?${suffix}` : ''}`);
}

async function resolveRouteEvent(params, isCurrent = () => true) {
  const raw = params.get('event');
  if (raw === null || raw === '') return state.eventId;   // 无 event：沿用当前赛事
  const requested = /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
  const target = Number.isSafeInteger(requested) && requested > 0
    ? state.events.find((event) => event.id === requested) : null;
  if (!target) {
    if (!isCurrent()) return state.eventId;
    replaceEventParam(state.eventId);
    toast('赛事参数无效，已回到当前赛事');
    return state.eventId;
  }
  if (target.id === state.eventId) return state.eventId;
  const previousId = state.eventId;
  try {
    await reloadShell(target.id);
  } catch (error) {
    if (error.cancelled || !isCurrent()) return state.eventId;
    const recoverable = error instanceof ApiError && [403, 404].includes(error.status);
    if (!recoverable || routeEventFallbackUsed) throw error;
    if (previousId === null || !state.events.some((event) => event.id === previousId)) throw error;
    routeEventFallbackUsed = true;                       // 每次切换失败最多回退一次，避免循环
    await reloadShell(previousId);
    if (!isCurrent()) return state.eventId;
    replaceEventParam(state.eventId);
    toast('无权访问该赛事，已回到当前赛事', 'warn');
    routeEventFallbackUsed = false;
    return state.eventId;
  }
  routeEventFallbackUsed = false;
  if (!isCurrent()) return state.eventId;
  if (state.eventId !== target.id) {
    // 赛事列表已刷新但目标已不可见：按非法参数回退，避免地址与状态不一致。
    replaceEventParam(state.eventId);
    toast('赛事参数无效，已回到当前赛事');
    return state.eventId;
  }
  toast(`已切换到「${currentEvent()?.name || target.name}」`);
  return state.eventId;
}

async function route(force = false) {
  if (force && !await prepareNavigation()) return;
  if (!state.user) return;             // 401 已登出（登录页已渲染），不再渲染业务路由
  /* 先取消旧页面读取；解析 URL 赛事期间不沿用旧读作用域，否则 reloadShell 的 GET 会被旧信号取消。 */
  activeReadScope?.controller.abort();
  setApiReadScope(null);
  const controller = new AbortController();
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const scope = { id: ++routeGeneration, controller, signal: controller.signal,
    context: captureRequestContext(), hash: location.hash };
  activeReadScope = scope;
  routeQueued = true;
  routeChain = routeChain.catch(() => {}).then(async () => {
    if (!routeQueued || !scopeCurrent(scope)) return;
    routeQueued = false;
    try {
      await resolveRouteEvent(params, () => scopeCurrent(scope));
    } catch (error) {
      if (error.cancelled || !scopeCurrent(scope)) return;
      toast(error.message || '赛事切换失败', 'error');
    }
    if (!scopeCurrent(scope)) return;
    scope.hash = location.hash;                          // 可能已被 replaceState 回填
    const context = captureRequestContext();
    const event = currentEvent();
    /* 读作用域 identity 与 state 单一来源一致：列表、草稿与 GET 使用同一赛事。 */
    scope.context = { ...context, identity: event
      ? { event_id: event.id, event_uuid: event.uuid, deployment_id: state.deploymentId }
      : context.identity };
    setApiReadScope(scope);
    await renderRoute(false, scope);
  });
  return routeChain;
}

async function renderRoute(force = false, scope = null) {
  if (force && !await prepareNavigation()) return;
  markPageLeaveGuardPending();
  /* 无论渲染成功、报错还是被更新的导航取代，都必须结束这次换页：
     否则旧守卫会冻结，用户再点离开时既没人拦、也没人清。 */
  try {
    const raw = (scope?.hash || location.hash).replace(/^#\/?/, '') || 'dashboard';
    const [name, query] = raw.split('?');
    const params = Object.fromEntries(new URLSearchParams(query || ''));
    const view = state.views[name] || state.views.dashboard;
    if (!canView(state.user.role, view.name)) { location.hash = roleHome(); return; }
    const activeView = navigationView(view.name);
    document.querySelectorAll('.sidenav a').forEach((a) => {
      a.classList.toggle('active', a.dataset.view === activeView);
    });
    const host = document.getElementById('content');
    const content = h('div.route-content');
    /* 旧页面在这里才真正退场，此时清空守卫不会留下“界面未保存、守卫已失效”的空窗。 */
    clear(host); host.append(content);
    // The old DOM is now gone: release its guard before awaiting the new view.
    settlePageLeaveGuard();
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
      /* 401 已由 handleSessionInvalid 清理会话并显示登录页，不再渲染错误页造成双提示。 */
      if (err instanceof ApiError && err.status === 401 && !getToken()) return;
      if (err instanceof ApiError && err.status === 403) {
        toast(err.message || '当前角色不能查看该部分', 'error');
        const home = roleHome();
        if (location.hash !== home) location.hash = home;
        return;
      }
      clear(content);
      content.append(h('div.panel',
        h('h3', '页面加载失败'),
        h('div', err.message),
        err instanceof ApiError && err.status === 401
          ? h('button.btn.btn-primary.mt', { onclick: () => location.reload() }, '重新登录')
          : err.offline
            ? h('div.warn-box.mt', '当前离线：本页需要联网读取数据。三人赛与个人赛记录页可用本机缓存继续记录。')
            : null,
        h('div.row.mt',
          h('button.btn.mt', { onclick: () => route(true) }, '重试'),
          h('button.btn.mt', { onclick: () => { location.hash = roleHome(); } }, '返回可用首页'))));
    }
    if (scopeCurrent(scope)) renderedHash = location.hash;
  } finally {
    settlePageLeaveGuard();
  }
}

/* ------------------------------------------------------------------ 启动 */
/* preferredEventId 来自启动地址的 ?event=，用于避免“先按 stss_event 加载、路由时再切换”的重复读取；
   仅在目标赛事对当前账号可见时采用，URL 非法值仍交给 resolveRouteEvent 回退并提示。 */
async function loadEvents(preferredEventId = null) {
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
  const visible = (id) => Number.isSafeInteger(id) && state.events.some((event) => event.id === id);
  const preferred = Number(preferredEventId);
  state.eventId = visible(preferred) ? preferred : visible(saved) ? saved : (state.events[0]?.id ?? null);
  if (state.eventId !== null) {
    try {
      if (Number(localStorage.getItem('stss_event') || 0) !== state.eventId) {
        localStorage.setItem('stss_event', String(state.eventId));
      }
    } catch { /* 存储不可用时仍按内存状态运行 */ }
  }
  const event = state.events.find((item) => item.id === state.eventId);
  setApiEventContext(event ? { ...event, deployment_id: state.deploymentId } : null);
}

export async function loadStructure() {
  const scope = activeReadScope;
  const selected = state.eventId;
  if (!state.eventId) { state.structure = null; return null; }
  // reloadShell may select a newly created event while the creating view still
  // owns the read scope. Read its business DB with the new identity, retaining
  // the scope's cancellation and generation checks.
  const context = captureRequestContext();
  try {
    const structure = await api.get(`/api/events/${selected}/structure`, { context, signal: scope?.signal });
    assertScope(scope);
    if (state.eventId !== selected) return state.structure;
    if (structure.event?.id !== selected || structure.event.uuid !== context.identity?.event_uuid) {
      throw new Error('赛事结构与目标赛事不一致，请重新读取');
    }
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
  /* 启动地址带 ?event= 时优先按它加载赛事，避免启动后路由再 reloadShell 重复读取。
     非法或不可见的值不在这里提示，交给 route() 的 resolveRouteEvent 统一回退。 */
  const query = location.hash.split('?')[1] || '';
  const preferredRaw = new URLSearchParams(query).get('event');
  const preferred = preferredRaw !== null && /^\d+$/.test(preferredRaw.trim()) ? Number(preferredRaw) : null;
  const savedBefore = Number(localStorage.getItem('stss_event') || 0);
  await loadEvents(preferred);
  /* 重试请求按账号、部署和赛事 UUID 隔离。 */
  const event = state.events.find((item) => item.id === state.eventId);
  setPendingRequestScope(state.user, event ? { ...event, deployment_id: state.deploymentId } : null);
  await loadStructure();
  renderShell();
  updateNetBadge();
  if (preferred !== null && state.eventId === preferred && preferred !== savedBefore) {
    toast(`已切换到「${currentEvent()?.name || event?.name || ''}」`);
  }
  if (!location.hash) {
    skipNextHashRoute = true;      // 这次 hash 变化由下面的 route() 渲染，避免重复加载
    location.hash = roleHome();
  }
  await route().catch((error) => {
    if (!error.cancelled) toast(error.message || '页面加载失败', 'error');
  });
}

/* 角色默认落地页（§12.1）：记录员直接进现场，查看者进成绩总览 */
function roleHome() {
  const role = state.user ? state.user.role : '';
  if (role === 'recorder') return '#/field';
  if (role === 'viewer') return '#/school';
  if (role === 'display_operator') return '#/display';
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
    /* 401 已由 handleSessionInvalid 回到登录页，这里不再重复渲染登录页覆盖失效提示。 */
    if ((err.status === 401 || err.code === 'account_changed') && !getToken()) return false;
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
    catch (error) { if (!error.cancelled && getToken()) toast(error.message, 'error'); }
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
    import('./views/schedule.js'),
    import('./views/scoring.js'),
    import('./views/matchAdmin.js'),
    import('./views/individual.js'),
    import('./views/review.js'),
    import('./views/results.js'),
    import('./views/bracket.js'),
    import('./views/school.js'),
    import('./views/admin.js'),
    import('./views/displayAdmin.js'),
  ]);
}

(async function start() {
  watchNetwork();
  registerServiceWorker();
  await loadViews();
  window.addEventListener('hashchange', async () => {
    if (skipNextHashRoute) { skipNextHashRoute = false; return; }
    if (!await prepareNavigation()) {
      /* 用户选择留在当前页：hash 已经变了，必须把地址改回真正渲染的那一页，
         否则刷新、复制链接或后退都会跑到“看起来没进去”的目标页。 */
      const restore = renderedHash || `#/${roleHome().replace(/^#\/?/, '')}`;
      if (location.hash !== restore) history.replaceState(null, '', restore);
      const select = document.getElementById('event-select');
      if (select) select.value = state.eventId ?? '';
      return;
    }
    try { await recoverIfOffline(); if (!getToken()) return; await route(); }
    catch (error) { if (!error.cancelled && getToken()) toast(error.message, 'error'); }
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
    /* 401 已由全局处理器清令牌并渲染登录页（带“登录状态已失效”说明），不要覆盖提示。 */
    if (!getToken() && document.getElementById('login-screen')) return;
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

/* Execute real modules under a minimal DOM; browser tests cover layout and HTTP flows. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

/* ------------------------------------------------------------------ 最小 DOM */
class FakeNode {
  constructor(name) {
    this.nodeName = String(name).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this._listeners = new Map();
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node === null || node === undefined || node === false) continue;
      const child = node instanceof FakeNode ? node : new FakeText(String(node));
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
      this._onConnect?.();
    }
  }
  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) { this.childNodes.splice(index, 1); child.parentNode = null; }
    return child;
  }
  remove() { this.parentNode?.removeChild(this); }
  get firstChild() { return this.childNodes[0] || null; }
  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    const list = this._listeners.get(type) || [];
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }
  dispatch(type) { for (const handler of [...(this._listeners.get(type) || [])]) handler({ type, target: this }); }
  setAttribute(key, value) { this[key] = String(value); }
  getAttribute(key) { return this[key] ?? null; }
  removeAttribute(key) { delete this[key]; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(value) { this.childNodes = []; if (value !== '' && value !== null) this.append(new FakeText(String(value))); }
  get innerText() { return this.textContent; }
  set innerText(value) { this.textContent = value; }
  get isConnected() { let node = this; while (node.parentNode) node = node.parentNode; return node === document.body; }
  focus() {}
  scrollIntoView() {}
}
class FakeText extends FakeNode {
  constructor(text) { super('#text'); this._text = text; }
  get textContent() { return this._text; }
  set textContent(value) { this._text = String(value); }
}
class FakeElement extends FakeNode {
  constructor(tag) {
    super(tag);
    this.style = { setProperty() {}, removeProperty() {} };
    this.dataset = {};
    this._classes = new Set();
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.checked = false;
    const self = this;
    this.classList = {
      add: (...names) => names.forEach((n) => self._classes.add(n)),
      remove: (...names) => names.forEach((n) => self._classes.delete(n)),
      contains: (name) => self._classes.has(name),
      toggle: (name, force) => {
        const want = force === undefined ? !self._classes.has(name) : !!force;
        if (want) self._classes.add(name); else self._classes.delete(name);
        return want;
      },
    };
  }
  get className() { return [...this._classes].join(' '); }
  set className(value) { this._classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  matches(selector) { return selector.split(',').some(s=>matchesSelector(this,s.trim())); }
  hasAttribute(key) { return this.getAttribute(key)!==null; }
  querySelector(selector) { return this._find((node) => matchesSelector(node, selector)); }
  querySelectorAll(selector) { return this._collect((node) => matchesSelector(node, selector)); }
  _find(predicate) { for (const child of this.childNodes) { if (child instanceof FakeElement) { if (predicate(child)) return child; const nested = child._find(predicate); if (nested) return nested; } } return null; }
  _collect(predicate, out = []) { for (const child of this.childNodes) if (child instanceof FakeElement) { if (predicate(child)) out.push(child); child._collect(predicate, out); } return out; }
}
/* 只支持本测试用到的选择器：标签、.class、[data-x]、[data-x="v"]。 */
function matchesSelector(node, selector) {
  const attr = selector.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
  if (attr) {
    const value = node.dataset?.[attr[1].replace(/^data-/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase())]
      ?? node.getAttribute(attr[1]);
    return attr[2] === undefined ? value !== undefined && value !== null : String(value) === attr[2];
  }
  if (selector.startsWith('.')) return node.classList.contains(selector.slice(1));
  return node.nodeName === selector.toUpperCase();
}
const byId = new Map();
const document = {
  body: new FakeElement('body'),
  documentElement: new FakeElement('html'),
  createElement: (tag) => new FakeElement(tag),
  createTextNode: (text) => new FakeText(String(text)),
  addEventListener() {}, removeEventListener() {},
  getElementById: (id) => {
    if (!byId.has(id)) {
      const el = new FakeElement('div');
  document.body.append(el);
      el.id = id;
      byId.set(id, el);
      document.body.append(el);
    }
    return byId.get(id);
  },
  querySelector: () => null,
  querySelectorAll: (selector) => (selector.startsWith('.')
    ? document.body._collect((node) => node.classList.contains(selector.slice(1)))
    : []),
};
document.body._onConnect = () => {};
for (const id of ['app', 'sidenav', 'content', 'event-select', 'event-line', 'user-line',
  'btn-logout', 'btn-new-event', 'net-badge']) {
  const el = new FakeElement('div');
  document.body.append(el);
  el.id = id;
  document.body.append(el);
}

/* ------------------------------------------------------------------ 全局环境 */
const store = new Map();
const localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
const listeners = new Map();
const window = {
  addEventListener(type, handler) {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(handler);
  },
  removeEventListener() {},
  scrollTo() {},
  location: { hash: '#/workspace', protocol: 'file:', reload() {} },
  history: { replaceState: (_s, _t, hash) => { if (hash) location.hash = hash; } },
  navigator: { onLine: true, serviceWorker: undefined },
  localStorage,
  requestAnimationFrame: (fn) => fn(),
};
const location = window.location;
/* 只覆盖本测试需要的最小全局：Node 自带 navigator 等只读属性，必须用 defineProperty。 */
for (const [key, value] of Object.entries({
  document, window, location, localStorage, history: window.history,
  navigator: window.navigator, requestAnimationFrame: window.requestAnimationFrame,
  Element: FakeElement, Node: FakeNode, HTMLElement: FakeElement,
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
})) {
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
}

/* ------------------------------------------------------------------ 假服务端 */
const SCHOOLS = [
  { id: 11, name: '甲组第一中学', group_id: 6, group_name: '甲组', athlete_count: 4, event_id: 5 },
  { id: 12, name: '甲组第二中学', group_id: 6, group_name: '甲组', athlete_count: 3, event_id: 5 },
  { id: 13, name: '乙组实验中学', group_id: 7, group_name: '乙组', athlete_count: 2, event_id: 5 },
];
const requested = [];
const responses = {
  /* main.js 启动时若本机还留着令牌，会自己走一遍会话恢复；这里给出泊位响应，
     避免后台流程产生与本次整合无关的未处理拒绝。 */
  '/api/me': { user: { id: 3, username: 'organizer1', role: 'organizer', display_name: '编排员' }, roles: {} },
  '/api/events': { events: [{ id: 5, uuid: 'uuid-5', name: '2026 年市赛' }], deployment_id: 'dep-1' },
  '/api/events/5/structure': { event: { id: 5, uuid: 'uuid-5', name: '2026 年市赛' }, groups: [] },
  '/api/categories/7/participations': {
    category: { id: 7, name: '男子三人赛', kind: 'team', gender: 'male', group_id: 6 },
    participations: [],
  },
  '/api/events/5/schools': { schools: SCHOOLS },
  '/api/schools/11/registration-workspace': {
    school: { id: 11, name: '甲组第一中学', event_id: 5 },
    group: { id: 6, name: '甲组' },
    categories: [{ id: 7, name: '男子三人赛', kind: 'team', gender: 'male',
      locked_reason: '', roster_locked_reason: '', edit_notice: '' }],
    people: [{ id: 21, key: 'a:21', name: '张一', gender: 'male', jersey_no: '7', note: '' }],
    projects: [{ category_id: 7, choice: 'participate', members: [], captain_key: '',
      athlete_key: '', seed_no: null, note: '', participation_id: null }],
    warnings: [], base_hash: 'hash-1',
    event_identity: { event_id: 5, event_uuid: 'uuid-5', deployment_id: 'dep-1' },
  },
};
globalThis.fetch = async (path) => {
  requested.push(path);
  if (!(path in responses)) throw new Error(`未预置的接口：${path}`);
  return { ok: true, status: 200, text: async () => JSON.stringify(responses[path]) };
};

/* ------------------------------------------------------------------ 真实模块 */
const main = await import('../web/js/main.js');
await import('../web/js/views/workspace.js');
await import('../web/js/views/schoolRegistration.js');

main.state.user = { id: 3, username: 'organizer1', role: 'organizer', display_name: '编排员' };
const apiModule = await import('../web/js/api.js');
apiModule.setApiUser(main.state.user);
apiModule.setApiEventContext({ id: 5, uuid: 'uuid-5', deployment_id: 'dep-1' });
main.state.roles = {};
main.state.eventId = 5;
main.state.deploymentId = 'dep-1';
main.state.events = [{ id: 5, uuid: 'uuid-5', name: '2026 年市赛' }];
main.state.structure = {
  event: { id: 5, uuid: 'uuid-5', name: '2026 年市赛' },
  groups: [
    { id: 6, name: '甲组', categories: [{ id: 7, name: '男子三人赛', kind: 'team', gender: 'male' }] },
    { id: 7, name: '乙组', categories: [] },
  ],
};

const content = () => document.getElementById('content');
const texts = (node) => node.textContent;
const classes = (node, name, out = []) => {
  if (node instanceof FakeElement && node.classList.contains(name)) out.push(node);
  for (const child of node.childNodes) classes(child, name, out);
  return out;
};

test('报名名单页签直接渲染学校列表，默认只显示当前组别', async () => {
  const host = new FakeElement('div');
  const el = new FakeElement('div');
  document.body.append(el);
  document.body.append(host); host.append(el);
  await main.state.views.workspace.render({
    el, params: { event: '5', group: '6', category: '7', tab: 'registration' }, state: main.state,
  });
  assert.ok(!texts(el).includes('页面加载失败'), `工作台渲染失败：${texts(el).slice(0, 300)}`);
  const items = classes(el, 'school-registration-item');
  assert.equal(items.length, 2, '甲组应有 2 所学校，不能把乙组的学校一起列出来');
  assert.ok(texts(items[0]).includes('甲组第一中学'));
  assert.ok(!texts(el).includes('乙组实验中学'), '默认组别之外学校不应出现');
  assert.ok(texts(el).includes('统一整理本组别'), '原学校模式明确范围');
  assert.ok(!texts(el).includes('当前项目名单'));
});

test('选择学校后正文渲染该校详情（统一编辑与整批核对），仍留在工作台', async () => {
  const el = new FakeElement('div');
  document.body.append(el);
  const params = { event: '5', group: '6', tab: 'registration', school: '11' };
  await main.state.views.workspace.render({ el, params, state: main.state });
  assert.equal(params.school, '11', '渲染不应改写调用方参数');
  assert.ok(requested.includes('/api/schools/11/registration-workspace'),
    `嵌入时必须用学校自己的报名工作台接口，实际请求：${JSON.stringify(requested)}`);
  const text = texts(el);
  for (const label of ['统一编辑', '整批核对', '学校人员', '本校全部项目']) {
    assert.ok(text.includes(label), `缺少统一编辑分区：${label}；正文：${text.slice(0, 200)}`);
  }
});

test('未开设项目的组别仍可从工作台进入报名名单', async () => {
  const el = new FakeElement('div');
  document.body.append(el);
  await main.state.views.workspace.render({
    el, params: { event: '5', group: '7', tab: 'registration' }, state: main.state,
  });
  const items = classes(el, 'school-registration-item');
  assert.equal(items.length, 1, '乙组只列出本组学校');
  assert.ok(texts(items[0]).includes('乙组实验中学'));
  assert.ok(!texts(el).includes('甲组第一中学'));
});

test('工作台注册的学校视图暴露可复用的名单渲染器', () => {
  const view = main.state.views.schoolRegistration;
  assert.equal(typeof view.renderDirectory, 'function', 'renderDirectory 必须能从注册表取到');
  assert.equal(typeof view.render, 'function');
});

test('整个赛事无项目且未指定组别时，使用解析后的默认组别渲染学校', async () => {
  const previous = main.state.structure;
  try {
    main.state.structure = { ...previous, groups: [previous.groups[1]] };
    const el = new FakeElement('div'); document.body.append(el);
    await main.state.views.workspace.render({ el, params: { event: '5', tab: 'registration' } });
    assert.equal(classes(el, 'school-registration-item').length, 1);
    assert.ok(texts(el).includes('乙组实验中学'));
  } finally { main.state.structure = previous; }
});

/* 换页顺序回归：旧页面还挂在屏幕上时，守卫不能被清空。
   这正是“界面显示未提交修改、离开却不再确认”的成因。 */
const { setPageLeaveGuard, prepareNavigation, markPageLeaveGuardPending, settlePageLeaveGuard } =
  await import('../web/js/ui.js');

test('旧页面退场前守卫不被清空；退场后才轮到新页面接管', async () => {
  settlePageLeaveGuard();
  let asked = 0;
  setPageLeaveGuard(async () => { asked += 1; return false; }, () => true);

  markPageLeaveGuardPending();
  setPageLeaveGuard(null);                     // 换页开始：旧页面仍在屏幕上
  assert.equal(await prepareNavigation(), false, '换页过程中仍必须触发未提交确认');
  assert.equal(asked, 1);

  setPageLeaveGuard(async () => true);         // 新视图登记自己的守卫
  settlePageLeaveGuard();
  assert.equal(await prepareNavigation(), true, '新页面接管后应放行');
});

test('旧 DOM 退场后非表单页面不继承旧守卫，迟到视图不能重装守卫', async () => {
  let current = true, asked = 0;
  setPageLeaveGuard(async () => { asked++; return false; }, () => true, () => current);
  markPageLeaveGuardPending(); settlePageLeaveGuard();
  assert.equal(await prepareNavigation(), true);
  current = false;
  setPageLeaveGuard(async () => { asked++; return false; }, () => true, () => current);
  assert.equal(await prepareNavigation(), true); assert.equal(asked, 0);
});

test('被替换的目录和详情不会向旧 DOM 写入或安装离页守卫', async () => {
  for (const params of [{ event: '5', group: '6', tab: 'registration' },
    { event: '5', school: '11', tab: 'registration' }]) {
    const el = new FakeElement('div'); document.body.append(el);
    await main.state.views.workspace.render({ el, params, isCurrent: () => false });
    assert.equal(el.textContent, '');
    assert.equal(await prepareNavigation(), true);
  }
});

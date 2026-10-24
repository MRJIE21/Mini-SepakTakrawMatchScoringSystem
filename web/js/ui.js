/* 轻量 UI 工具：DOM 构建、提示、弹窗、统一表单编辑器、表格与表单控件。

   表单交互遵循改进方案第 9 节：
   - §9.1 编辑器结构固定为“标题与对象 → 基本字段 → 可选字段 → 错误摘要 → 底部操作”；
   - §9.2 提交状态由编辑器自己管理，回调**抛异常即失败**，失败保留输入、定位错误、不关闭；
          只有回调正常返回才算成功（keepOpen 的动作除外，用于“保存并继续添加”）；
   - §9.3 离开有修改的表单时确认是否放弃；提交失败保留当前输入。
*/
export { categoryLabel } from './labels.js';

/* 原生 append(null) 会插入文本 "null"，页面里大量使用“条件 ? 元素 : null”的写法，
   这里统一过滤掉 null / undefined / false，避免出现多余的 "null" 文本。 */
const nativeAppend = Element.prototype.append;
Element.prototype.append = function patchedAppend(...nodes) {
  const flat = nodes.flat(4).filter((n) => n !== null && n !== undefined && n !== false);
  return nativeAppend.apply(this, flat);
};

export function h(tag, attrs = null, ...children) {
  const parts = tag.split('.');
  const el = document.createElement(parts[0] || 'div');
  if (parts.length > 1) el.className = parts.slice(1).join(' ');
  if (attrs && typeof attrs === 'object' && !(attrs instanceof Node) && !Array.isArray(attrs)) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = `${el.className} ${v}`.trim();
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
      else el.setAttribute(k, v);
    }
  } else if (attrs !== null && attrs !== undefined) {
    children.unshift(attrs);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

export function table(columns, rows, opts = {}) {
  const columnClass = (c) => `${c.align || ''} ${c.cellClass || ''}`.trim();
  /* 固定列能力：列定义 sticky:'left'|'right' 时在 th/td 上写 data-sticky，
     scrollableTable 会按表头实际宽度计算左侧偏移，不依赖列宽常量。 */
  const stickyAttrs = (c, index) => (c.sticky
    ? { 'data-sticky': c.sticky, 'data-sticky-index': String(index) } : null);
  const thead = h('thead', h('tr', ...columns.map((c, index) => h('th', {
    class: columnClass(c), scope: 'col', ...(stickyAttrs(c, index) || {}),
  }, c.label))));
  const tbody = h('tbody', ...rows.map((row, index) => h('tr', ...columns.map((c, colIndex) => {
    const v = c.render ? c.render(row, index) : row[c.key];
    return h('td', { class: columnClass(c),
      'data-label': opts.responsive ? c.label : null,
      ...(stickyAttrs(c, colIndex) || {}),
    }, v === undefined || v === null ? '' : v);
  }))));
  const el = h(`table.tbl${opts.class ? `.${opts.class}` : ''}`, thead, tbody);
  if (opts.bodyRef) opts.bodyRef.current = tbody;
  return el;
}

/* 可横向滚动的表格容器：仅在 scrollWidth 超出时显示提示，并按实际列宽固定左右列。
   返回包装节点（容器 + 提示），调用方把它当作原 .table-scroll 使用即可。 */
const scrollTableSyncs = new Set();
let scrollTableResizeBound = false;
function syncScrollTables() {
  for (const sync of [...scrollTableSyncs]) sync();
}
export function scrollableTable(container, { hint = '横向滚动查看完整数据' } = {}) {
  const wrap = h('div.table-scroll-wrap');
  wrap.append(container);
  const hintEl = h('div.table-scroll-hint', { role: 'note', hidden: true }, hint);
  wrap.append(hintEl);
  const applySticky = () => {
    const cells = container.querySelectorAll('[data-sticky]');
    if (!cells.length) return;
    const headerCells = [...container.querySelectorAll('thead th')];
    const leftOffsets = new Map();
    let offset = 0;
    for (const th of headerCells) {
      if (th.dataset.sticky === 'left' && !leftOffsets.has(th.dataset.stickyIndex)) {
        leftOffsets.set(th.dataset.stickyIndex, offset);
        offset += th.getBoundingClientRect().width;
      }
    }
    for (const cell of cells) {
      if (cell.dataset.sticky === 'left') {
        const left = leftOffsets.get(cell.dataset.stickyIndex);
        if (left !== undefined) cell.style.left = `${left}px`;
      } else if (cell.dataset.sticky === 'right') {
        cell.style.right = '0px';
      }
    }
  };
  const sync = () => {
    if (!container.isConnected) {
      /* 页面重绘后旧表已卸载：解除监听，避免反复重建表格时累积监听器。 */
      scrollTableSyncs.delete(sync);
      observer.disconnect();
      return;
    }
    applySticky();
    hintEl.hidden = container.scrollWidth <= container.clientWidth + 1;
  };
  const observer = new ResizeObserver(sync);
  observer.observe(container);
  scrollTableSyncs.add(sync);
  if (!scrollTableResizeBound) {
    window.addEventListener('resize', syncScrollTables, { passive: true });
    scrollTableResizeBound = true;
  }
  wrap.scrollHintSync = sync;
  wrap.scrollHintObserver = observer;
  requestAnimationFrame(sync);
  return wrap;
}

let fieldLabelSequence=0;
export function field(label, control, opts = {}) {
  /* name 会写成控件的 data-field，供 formDialog 按字段定位错误（§9.1） */
  if (opts.name && control instanceof Element && !control.dataset.field) {
    control.dataset.field = opts.name;
  }
  const labelId=`field-label-${++fieldLabelSequence}`;
  if(control instanceof Element && control.matches('input,select,textarea')
      && !control.hasAttribute('aria-label') && !control.hasAttribute('aria-labelledby')) control.setAttribute('aria-labelledby',labelId);
  const wrap = h('label.field',
    h('span', {id:labelId}, label, opts.required ? h('span.req', { 'aria-hidden': 'true' }, ' *') : null),
    control);
  if (opts.hint) wrap.append(h('span.field-hint', opts.hint));
  /* 错误提示挂在字段容器内，紧邻控件（§9.1） */
  wrap.append(h('div.field-error.hidden'));
  /* 不能叫 control：HTMLLabelElement.control 是只读属性，赋值会抛错 */
  wrap.fieldControl = control;
  return wrap;
}

export function setFieldError(fieldWrap, message) {
  if (!fieldWrap) return;
  const slot = fieldWrap.querySelector('.field-error');
  const control = fieldWrap.fieldControl || fieldWrap.querySelector('input,select,textarea');
  if (slot) {
    slot.textContent = message || '';
    slot.classList.toggle('hidden', !message);
  }
  if (control) {
    control.classList.toggle('invalid', !!message);
    if (message) control.setAttribute('aria-invalid', 'true');
    else control.removeAttribute('aria-invalid');
  }
}

export function textInput(value, attrs = {}) {
  /* 默认关闭浏览器自动填充：页面同时存在密码框时，密码管理器可能把已保存的
     用户名自动填进任意文本/搜索框，造成列表被意外筛选（“新建后看不到”）。
     调用方仍可用 attrs.autocomplete 显式覆盖（如 new-password / current-password）。 */
  return h('input', { type: 'text', value: value ?? '', autocomplete: 'off', ...attrs });
}

/* 浏览器密码管理器/自动填充可能在页面渲染后把已保存的用户名、密码写进输入框，
   而用户并没有操作（Chrome/Edge 的凭据自动填充通常不触发 input 事件）。搜索框被
   填入用户名时列表会被意外过滤（看起来像“新建的账号没更新/消失”）；新建账号表单
   被填入旧凭据时点击创建会得到重复用户名错误。
   这里持续清理“没有用户编辑痕迹”的非空值；一旦出现真实的点击、按键、粘贴或输入法
   开始，就不再干预，正常筛选与输入不受影响。注意不能把 focus 当作编辑痕迹：自动
   填充可能在页面加载后给输入框聚焦，若据此停止清理，值会留在框里并在点击时生效。 */
export function clearUnintendedAutofill(inputs, onChange = null) {
  const list = (Array.isArray(inputs) ? inputs : [inputs]).filter(Boolean);
  if (!list.length) return () => {};
  let userActed = false;
  const mark = () => { userActed = true; };
  const events = ['pointerdown', 'keydown', 'paste', 'compositionstart'];
  const bound = [];
  for (const input of list) {
    const handler = () => mark();
    for (const name of events) {
      input.addEventListener(name, handler, { passive: true });
      bound.push([input, name, handler]);
    }
    /* 真实输入（键盘、输入法、自动化注入文本）会触发 input；自动填充通常不触发，
       或被标记为 insertReplacementText。前者视为用户在编辑，停止清理以保留输入。 */
    const onInput = (event) => { if (!isAutofillInputEvent(event)) mark(); };
    const onBeforeInput = (event) => { if (isAutofillInputEvent(event)) event.preventDefault(); };
    input.addEventListener('input', onInput);
    input.addEventListener('beforeinput', onBeforeInput);
    bound.push([input, 'input', onInput], [input, 'beforeinput', onBeforeInput]);
  }
  const check = () => {
    if (userActed) return;
    const live = list.filter((input) => input.isConnected);
    if (!live.length) { clearInterval(pollTimer); return; }
    let changed = false;
    for (const input of live) {
      if (input.value) { input.value = ''; changed = true; }
    }
    if (changed && typeof onChange === 'function') onChange();
  };
  let timers = [];
  // 自动填充既可能在渲染后立即发生，也可能晚于首屏计时，因此保留一个轻量轮询。
  const pollTimer = setInterval(check, 500);
  const schedule = () => {
    timers.forEach((timer) => clearTimeout(timer));
    timers = [0, 150, 400, 900, 1600, 2600, 4000, 6000].map((delay) => setTimeout(check, delay));
  };
  /* BFCache 返回页面时浏览器可能再次自动填充：恢复时重新核对。 */
  const onShow = (event) => { if (event.persisted) schedule(); };
  window.addEventListener('pageshow', onShow);
  schedule();
  return () => {
    userActed = true;
    clearInterval(pollTimer);
    timers.forEach((timer) => clearTimeout(timer));
    window.removeEventListener('pageshow', onShow);
    bound.forEach(([input, name, handler]) => input.removeEventListener(name, handler));
  };
}

/* 自动填充不保证提供特定 inputType；还要核对浏览器标记的真实填充状态。
   分别查询标准与厂商伪类，避免旧浏览器不认识其中一个选择器时整组判断失效。 */
export function isAutofillInputEvent(event) {
  if (event?.inputType === 'insertReplacementText') return true;
  for (const selector of [':autofill', ':-webkit-autofill']) {
    try { if (event?.target?.matches?.(selector)) return true; }
    catch { /* 当前浏览器不支持此伪类，继续检查另一个。 */ }
  }
  return false;
}

/* 列表筛选输入框：筛选状态以本对象为准，浏览器自动填充（静默赋值、
   自动填充伪类或替换事件）既不会生效，也会被持续纠正回应用的筛选值。
   真实输入（按键/粘贴/输入法、自动化工具注入文本）仍会触发 onChange。 */
export function bindFilterInput(input, onChange = null, { initialValue = input.value ?? '' } = {}) {
  let state = String(initialValue ?? '');
  const sync = () => { if (input.value !== state) input.value = state; };
  // 先同步调用方的筛选初值，再接收事件；不能把绑定前的凭据填充收编为状态。
  sync();
  const accept = () => {
    state = input.value;
    if (typeof onChange === 'function') onChange(state);
  };
  const onInput = (event) => {
    if (isAutofillInputEvent(event)) { sync(); return; }
    accept();
  };
  const onBeforeInput = (event) => {
    if (isAutofillInputEvent(event)) event.preventDefault();
  };
  const onAutofillAnimation = (event) => {
    if (event?.animationName === 'stss-autofill-detect') sync();
  };
  input.addEventListener('input', onInput);
  input.addEventListener('beforeinput', onBeforeInput);
  input.addEventListener('animationstart', onAutofillAnimation);
  const timer = setInterval(() => {
    if (!input.isConnected) { clearInterval(timer); return; }
    sync();
  }, 500);
  const onShow = (event) => { if (event.persisted) sync(); };
  window.addEventListener('pageshow', onShow);
  return {
    input,
    value: () => state,
    set(value) { state = String(value ?? ''); sync(); },
    sync,
    destroy() {
      clearInterval(timer);
      window.removeEventListener('pageshow', onShow);
      input.removeEventListener('input', onInput);
      input.removeEventListener('beforeinput', onBeforeInput);
      input.removeEventListener('animationstart', onAutofillAnimation);
    },
  };
}

export function numberInput(value, attrs = {}) {
  return h('input', { type: 'number', value: value ?? '', ...attrs });
}

/* 日期与日期时间统一用原生控件，不再让用户手打格式（§9.1、Q11） */
export function dateInput(value, attrs = {}) {
  return h('input', { type: 'date', value: value ?? '', ...attrs });
}

export function dateTimeInput(value, attrs = {}) {
  return h('input', { type: 'datetime-local', value: value ?? '', ...attrs });
}

/* 种子序号等整数输入：只接受正整数，空值表示未指定（§6.2） */
export function integerInput(value, attrs = {}) {
  const el = h('input', { type: 'number', step: '1', inputmode: 'numeric',
    value: value === null || value === undefined ? '' : value, ...attrs });
  if (!attrs.min) el.min = '1';
  return el;
}

export function textarea(value, attrs = {}) {
  return h('textarea', { rows: 3, ...attrs }, value ?? '');
}

export function selectInput(options, value, attrs = {}) {
  const el = h('select', attrs);
  for (const opt of options) {
    const [v, label] = Array.isArray(opt) ? opt : [opt, opt];
    el.append(h('option', { value: v, selected: String(v) === String(value ?? '') }, label));
  }
  el.value = value ?? '';
  return el;
}

/* 成绩类导出的正/倒序选择；默认正序，切换只影响当前导出区域。 */
export function exportOrderControl(onChange, value = 'asc') {
  const control = selectInput([['asc', '正序'], ['desc', '倒序']], value, {
    'aria-label': '导出排序',
    onchange: (e) => onChange(e.target.value),
  });
  return h('label.small.row.tight', null,
    h('span', '排序'), control);
}

export function checkbox(label, checked, attrs = {}) {
  const input = h('input', { type: 'checkbox', checked, ...attrs });
  const wrap = h('label.row.tight', null, input, h('span', label));
  wrap.input = input;
  return wrap;
}

/* 可搜索选择器：长名单（学校、参赛主体、签位来源）用它替代原生 select（§9.1）
   options: [{ value, label, hint, disabled }] */
export function searchSelect(options, value, opts = {}) {
  const wrap = h('div.search-select');
  const input = h('input', {
    type: 'text', role: 'combobox', autocomplete: 'off',
    'aria-autocomplete': 'list', 'aria-expanded': 'false',
    placeholder: opts.placeholder || '输入关键字搜索',
  });
  const list = h('div.ss-list.hidden', { role: 'listbox' });
  const hidden = h('input', { type: 'hidden', value: value ?? '' });
  let items = options;
  let active = -1;

  const labelOf = (v) => (items.find((o) => String(o.value) === String(v)) || {}).label || '';

  function render(filter = '') {
    clear(list);
    active = -1;
    const kw = filter.trim().toLowerCase();
    const shown = kw ? items.filter((o) => `${o.label} ${o.hint || ''} ${(o.aliases || []).join(' ')}`.toLowerCase().includes(kw)) : items;
    if (!shown.length) {
      list.append(h('div.ss-empty', opts.emptyText || '没有匹配项'));
    }
    shown.forEach((o) => {
      const row = h('div.ss-item', {
        role: 'option', 'aria-selected': String(o.value) === String(hidden.value),
        class: o.disabled ? 'disabled' : '', dataset: { value: o.value },
      }, h('span', o.label), o.hint ? h('span.ss-hint', o.hint) : null);
      row.onmousedown = (e) => e.preventDefault();
      row.onclick = (e) => { e.preventDefault(); e.stopPropagation(); if (!o.disabled) pick(o); };
      list.append(row);
    });
    if (opts.onCreate && kw && !items.some((o) =>
      [o.label, ...(o.aliases || [])].some((name) => name.trim().toLowerCase() === kw))) {
      const name = filter.trim();
      const row = h('div.ss-item.ss-create', { role: 'option', 'aria-selected': 'false' },
        `＋ 新建“${name}”`);
      row.onmousedown = (e) => e.preventDefault();
      row.onclick = (e) => { e.preventDefault(); e.stopPropagation(); close(); opts.onCreate(name); };
      list.append(row);
    }
  }

  function pick(o) {
    hidden.value = o.value;
    input.value = o.label;
    input.classList.toggle('invalid', false);
    close();
    wrap.dispatchEvent(new CustomEvent('change', { detail: { value: o.value, option: o } }));
    if (opts.onchange) opts.onchange(o.value, o);
  }

  function open() {
    render(input.value === labelOf(hidden.value) ? '' : input.value);
    list.classList.remove('hidden');
    input.setAttribute('aria-expanded', 'true');
  }
  function close() {
    list.classList.add('hidden');
    input.setAttribute('aria-expanded', 'false');
  }

  input.addEventListener('focus', open);
  input.addEventListener('input', () => {
    hidden.value = '';
    opts.onInput?.(input.value);
    open();
  });
  input.addEventListener('blur', () => {
    /* 失焦时回填已选文本，避免留下没匹配上的半个关键字 */
    setTimeout(() => {
      if (!wrap.contains(document.activeElement)) { input.value = labelOf(hidden.value); close(); }
    }, 120);
  });
  input.addEventListener('keydown', (e) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && list.classList.contains('hidden')) open();
    const rows = [...list.querySelectorAll('.ss-item:not(.disabled)')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.classList.contains('hidden')) open();
      if (!rows.length) return;
      active = e.key === 'ArrowDown' ? (active + 1) % rows.length
        : (active - 1 + rows.length) % rows.length;
      rows.forEach((r, i) => r.classList.toggle('active', i === active));
      rows[active].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      if (active >= 0 && rows[active]) {
        e.preventDefault();
        rows[active].click();
      }
    } else if (e.key === 'Escape') {
      input.value = labelOf(hidden.value);
      close();
    }
  });

  wrap.append(input, list, hidden);
  if (value !== undefined && value !== null && value !== '') input.value = labelOf(value);
  wrap.setOptions = (next) => {
    items = next;
    if (!list.classList.contains('hidden')) render(input.value);
  };
  Object.defineProperty(wrap, 'value', {
    get: () => hidden.value,
    set: (v) => { hidden.value = v ?? ''; input.value = labelOf(v); },
  });
  return wrap;
}

export function toast(message, kind = '') {
  const box = document.getElementById('toast');
  box.className = `toast show ${kind}`;
  box.textContent = message;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { box.className = 'toast'; }, kind === 'error' ? 6000 : 3000);
}

/* ------------------------------------------------------------------ 弹窗 */
/* 每次调用创建独立遮罩层，因此表单里再弹确认框不会互相顶掉（§9.3）。 */
let modalDepth = 0;
const activeModals = [];
let pageLeaveGuard = null;
let pageHasUnsaved = null;
/* 站内路由守卫：只用于“正在进行、必须等结果”的操作（如后台抽取/保存请求）。
   应用内切换菜单时，route() 在 abort 旧视图之前先询问这里，因此绝不能在这里弹确认框：
   那会拦下每一次菜单跳转；离开页面的提醒由上方 pageLeaveGuard/beforeunload 负责。 */
let routerBlockGuard = null;

/* 路由在重新渲染前会清空旧守卫。但旧页面此刻仍然挂在屏幕上（新页面还要等接口），
   这时清掉守卫就会出现“界面还显示未提交修改、离开确认却不再触发”的空窗。
   渲染流程先声明即将换页：只忽略这一次清空，旧守卫保持到新视图接管为止。 */
let pendingNavigation = false;

export function markPageLeaveGuardPending() {
  pendingNavigation = true;
}

export function settlePageLeaveGuard() {
  if (pendingNavigation) { pageLeaveGuard = null; pageHasUnsaved = null; routerBlockGuard = null; }
  pendingNavigation = false;
}

export function setPageLeaveGuard(guard, hasUnsaved = null, isCurrent = null) {
  if (isCurrent && !isCurrent()) return;
  if (guard === null && pendingNavigation) return;
  pendingNavigation = false;
  pageLeaveGuard = guard && (async () => !isCurrent || isCurrent() ? guard() : true);
  pageHasUnsaved = hasUnsaved && (() => (!isCurrent || isCurrent()) && hasUnsaved());
}

/* 返回 false 才拦下站内路由；未设置时站内跳转不受影响。 */
export function setRouterBlockGuard(guard = null, isCurrent = null) {
  if (isCurrent && !isCurrent()) return;
  if (guard === null && pendingNavigation) return;
  routerBlockGuard = guard && ((() => (!isCurrent || isCurrent()) && guard()));
}
window.addEventListener('beforeunload', (event) => {
  if (pageHasUnsaved?.()) { event.preventDefault(); event.returnValue = ''; }
});

/* 路由切换与浏览器前进/后退统一经过当前弹窗的离开保护。
   站内跳转只受 routerBlockGuard（进行中的请求）限制，不弹离开确认；
   有未保存输入时由 formDialog 自己先让用户选择。 */
export async function prepareNavigation() {
  const top = activeModals[activeModals.length - 1];
  if (top && !await top.requestClose()) return false;
  if (routerBlockGuard) {
    const allowed = await routerBlockGuard();
    if (allowed === false) return false;
    return true;
  }
  return pageLeaveGuard ? pageLeaveGuard() : true;
}

function focusables(root) {
  return [...root.querySelectorAll(
    'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
  )].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

export function modal({ title, body, buttons = [], width, onClose, dismissible = true, initialFocus }) {
  const previousFocus = document.activeElement;
  modalDepth += 1;
  const backdrop = h('div.modal-backdrop', { style: `z-index:${58 + modalDepth * 2}` });
  const errorBox = h('div.form-errors.hidden', { role: 'alert' });
  const bodyWrap = h('div.modal-body', errorBox, body);
  const footEl = h('div.modal-foot');
  const panel = h('div.modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '提示' },
    h('div.modal-head', h('h3', title || '提示'),
      dismissible ? h('button.btn.btn-ghost', { 'aria-label': '关闭', onclick: () => requestClose() }, '✕') : null),
    bodyWrap, footEl);
  if (width) panel.style.width = width;
  backdrop.append(panel);

  let closed = false;
  let busyNow = false;
  function close() {
    if (closed) return;
    closed = true;
    modalDepth = Math.max(0, modalDepth - 1);
    backdrop.remove();
    document.removeEventListener('keydown', onKeydown, true);
    const index = activeModals.indexOf(handle);
    if (index >= 0) activeModals.splice(index, 1);
    if (previousFocus && previousFocus.isConnected) previousFocus.focus();
    if (onClose) onClose();
  }

  const actionButtons = [];
  function setBusy(busy, activeBtn) {
    busyNow = busy;
    actionButtons.forEach((b) => {
      b.el.disabled = busy || b.disabled;
      b.el.textContent = busy && b.el === activeBtn ? (b.busyLabel || '处理中…') : b.label;
    });
  }

  function showErrors(err) {
    const fields = (err && err.detail && err.detail.fields) || null;
    clear(errorBox);
    /* 跨字段或整体错误进摘要区；字段错误同时挂到控件旁（§9.1） */
    bodyWrap.querySelectorAll('.field-error').forEach((slot) => {
      slot.textContent = ''; slot.classList.add('hidden');
    });
    bodyWrap.querySelectorAll('.invalid').forEach((el) => {
      el.classList.remove('invalid'); el.removeAttribute('aria-invalid');
    });
    let located = null;
    if (fields) {
      for (const [name, message] of Object.entries(fields)) {
        const control = bodyWrap.querySelector(`[data-field="${name}"]`);
        if (!control) continue;
        const wrap = control.closest('label.field') || control.closest('.field');
        setFieldError(wrap, message);
        if (!located) located = control;
      }
    }
    errorBox.append(h('div', err && err.message ? err.message : '操作失败，请修正后重试'));
    errorBox.classList.remove('hidden');
    if (located) located.focus();
    else errorBox.scrollIntoView({ block: 'nearest' });
  }

  function clearErrors() {
    errorBox.classList.add('hidden');
    clear(errorBox);
  }

  for (const btn of buttons) {
    const el = h('button', { class: `btn ${btn.class || (btn.primary ? 'btn-primary' : '')}`.trim() });
    el.textContent = btn.label;
    const entry = { el, label: btn.label, busyLabel: btn.busyLabel, disabled: false };
    actionButtons.push(entry);
    el.onclick = async () => {
      if (el.disabled) return;             // 保存中防重复点击（§9.2、T05）
      clearErrors();
      setBusy(true, el);
      try {
        await (btn.onClick || btn.run)({ close, showErrors });
        setBusy(false, el);
        if (!btn.keepOpen) close();
      } catch (err) {
        setBusy(false, el);
        showErrors(err);                     // 失败停留在弹窗并保留输入（Q05）
        if (btn.onError) btn.onError(err);
      }
    };
    footEl.append(el);
  }
  const cancelButton = dismissible ? h('button.btn', { onclick: () => requestClose() }, '取消') : null;
  if (cancelButton) footEl.append(cancelButton);

  function onKeydown(e) {
    if (e.key === 'Escape' && dismissible) { e.preventDefault(); e.stopPropagation(); requestClose(); return; }
    if (e.key !== 'Tab') return;
    const items = focusables(panel);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* 有未保存修改时先走离开保护（§9.3）；由 guardClose 注入 */
  let onBeforeClose = null;
  async function requestClose() {
    if (busyNow) return false;
    if (onBeforeClose && !await onBeforeClose()) return false;
    close();
    return true;
  }

  if (dismissible) {
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) requestClose(); });
  }
  document.addEventListener('keydown', onKeydown, true);
  document.body.append(backdrop);
  const auto = initialFocus === 'cancel' && cancelButton ? cancelButton : focusables(bodyWrap)[0] || actionButtons[0]?.el;
  if (auto) setTimeout(() => { if (!closed && auto.isConnected) auto.focus(); }, 0);

  const handle = {
    close,
    requestClose,
    root: panel,
    body: bodyWrap,
    showErrors,
    clearErrors,
    setActionDisabled: (index, disabled) => {
      const entry = actionButtons[index];
      if (entry) { entry.disabled = !!disabled; entry.el.disabled = busyNow || entry.disabled; }
    },
    guardClose(fn) { onBeforeClose = fn; },
  };
  activeModals.push(handle);
  return handle;
}

export function confirmDialog(title, text, onOk, okLabel = '确认') {
  return modal({
    title,
    body: h('div.pre-line', text),
    buttons: [{ label: okLabel, class: 'btn-primary', onClick: onOk }],
  });
}

/* Promise 版确认框：用于 await 之后再继续删除等危险操作（§8.6）。
   关闭、取消都算“未确认”，只有点确认才 resolve(true)。 */
export function confirmAsync(title, text, okLabel = '确认', { danger = false, initialFocus } = {}) {
  return new Promise((resolve) => {
    let decided = false;
    const decide = (v) => { if (!decided) { decided = true; resolve(v); } };
    modal({
      title,
      body: h('div.pre-line', text),
      buttons: [{ label: okLabel, class: danger ? 'btn-danger' : 'btn-primary', onClick: () => decide(true) }],
      initialFocus,
      onClose: () => decide(false),
    });
  });
}

/* 页内输入框，取代 window.prompt：内容可在提交前核对（§9.1、Q11） */
export function promptDialog({ title, label, value = '', type = 'text', required = false,
                               multiline = false, hint = '', okLabel = '确定', min, max }) {
  return new Promise((resolve) => {
    let settled = false;
    const control = multiline ? textarea(value)
      : type === 'integer' ? integerInput(value, { min, max })
        : h('input', { type, value: value ?? '', ...(type === 'password' ? { autocomplete: 'new-password' } : {}) });
    control.dataset.field = 'value';
    const dlg = modal({
      title,
      body: h('div', field(label, control, { required, hint })),
      buttons: [{
        label: okLabel, class: 'btn-primary',
        onClick: () => {
          const raw = control.value.trim();
          if (required && !raw) throw Object.assign(new Error(`请填写${label}`), { detail: { fields: { value: `请填写${label}` } } });
          if (type === 'integer' && raw) {
            const n = Number(raw);
            if (!Number.isInteger(n) || (min !== undefined && n < min) || (max !== undefined && n > max)) {
              throw Object.assign(new Error(`${label}必须是${min !== undefined ? `不小于 ${min} 的` : ''}整数`),
                { detail: { fields: { value: `${label}必须是整数` } } });
            }
          }
          settled = true;
          resolve(type === 'integer' && raw ? Number(raw) : raw);
        },
      }],
      onClose: () => { if (!settled) resolve(null); },
    });
    setTimeout(() => { control.focus(); control.select?.(); }, 0);
    return dlg;
  });
}

/* ------------------------------------------------------------------ 统一表单编辑器 */
/* §9.1 结构：标题与对象 → 基本字段 → 可选字段 → 错误摘要 → 固定底部操作。
   动作回调抛异常即失败：modal 负责渲染错误摘要、按 data-field 定位、保留输入、不关闭。
   正常返回即成功并关闭；keepOpen 的动作（“保存并继续添加”）成功后留在原地。 */
export function formDialog({ title, subtitle, sections = [], actions = [], width,
                             onBeforeClose, onClose, onDiscard, dismissible = true }) {
  const sectionEls = sections.map((s) => h('section.form-section',
    s.title ? h('h4.form-section-title', s.title) : null,
    s.body));
  const bodyEl = h('div.form-body', ...sectionEls);
  if (subtitle) bodyEl.prepend(h('div.form-subtitle', subtitle));

  const controls = () => [...bodyEl.querySelectorAll('[data-field]')];

  function values() {
    const out = {};
    for (const el of controls()) {
      out[el.dataset.field] = el.type === 'checkbox' ? el.checked : el.value;
    }
    return out;
  }

  const dlg = modal({
    title, body: bodyEl, width, dismissible, onClose,
    buttons: actions.map((a) => ({
      label: a.label,
      class: a.class || (a.danger ? 'btn-danger' : a.primary ? 'btn-primary' : ''),
      busyLabel: a.busyLabel || (a.primary ? '保存中…' : '处理中…'),
      keepOpen: a.keepOpen,
      onClick: async (ctx) => {
        await a.run({ close: ctx.close, values, reset, markField });
      },
    })),
  });

  function markField(name, message) {
    const control = bodyEl.querySelector(`[data-field="${name}"]`);
    if (!control) return;
    setFieldError(control.closest('label.field') || control.closest('.field'), message);
  }

  /* “保存并继续添加”：只保留上下文，清空本条业务输入（§6.3、§8.2） */
  function reset(keep = []) {
    for (const el of controls()) {
      if (keep.includes(el.dataset.field)) continue;
      if (el.type === 'checkbox') el.checked = false;
      else el.value = '';
    }
    dlg.clearErrors();
    const first = controls().find((el) => !keep.includes(el.dataset.field));
    if (first) first.focus();
  }

  /* 未保存内容保护：关闭前统一处理（§4.2、§9.3） */
  let initial = values();
  const markClean = () => { initial = values(); };
  const isDirty = () => JSON.stringify(values()) !== JSON.stringify(initial);
  dlg.guardClose(async () => {
    if (onBeforeClose && !await onBeforeClose()) return false;
    if (!isDirty()) return true;
    return new Promise((resolve) => {
      let decided = false;
      const decide = (v) => { if (!decided) { decided = true; resolve(v); } };
      modal({
        title: '有未保存的修改',
        body: h('div', '当前修改尚未提交。关闭后将放弃这些修改，重新打开时显示后台已保存的内容。'),
        buttons: [
          {
            label: '放弃修改', class: 'btn-danger',
            onClick: async () => {
              if (onDiscard) await onDiscard();
              decide(true);
            },
          },
          { label: '继续编辑', onClick: () => decide(false) },
        ].filter(Boolean),
        onClose: () => decide(false),
      });
    });
  });

  // Open with the caller's backend values; cached inputs are never restored into the form.

  return { ...dlg, values, reset, markField, isDirty, markClean };
}

/* ------------------------------------------------------------------ 更多菜单 */
/* 次要和危险操作收进“更多”，避免与主操作混排（§6.1、Q13）。
   只注册一个 document 监听器，列表反复重绘不会累积。 */
const openMenus = new Set();
document.addEventListener('click', () => {
  for (const menu of [...openMenus]) menu.close();
});

export function moreMenu(items, label = '更多') {
  const wrap = h('div.more-menu');
  const list = h('div.more-list.hidden', { role: 'menu' });
  const self = {
    close() {
      list.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
      openMenus.delete(self);
    },
  };
  const btn = h('button.btn.small', {
    'aria-haspopup': 'true', 'aria-expanded': 'false',
    onclick: (e) => {
      e.stopPropagation();
      const willOpen = list.classList.contains('hidden');
      for (const menu of [...openMenus]) menu.close();
      if (willOpen) {
        list.classList.remove('hidden');
        btn.setAttribute('aria-expanded', 'true');
        openMenus.add(self);
      }
    },
  }, label, ' ▾');
  for (const item of items) {
    if (!item) continue;
    list.append(h('button.more-item', {
      class: item.danger ? 'danger' : '',
      role: 'menuitem',
      disabled: item.disabled,
      onclick: async (e) => {
        e.stopPropagation();
        self.close();
        await item.onClick();
      },
    }, item.label));
  }
  wrap.append(btn, list);
  return wrap;
}

/* ------------------------------------------------------------------ 页面状态 */
/* §14.3：区分首次加载、真正为空、筛选为空、加载失败、无权限、状态限制 */
export function loadingState(text = '正在加载…') {
  return h('div.page-state', h('div.spinner', { 'aria-hidden': 'true' }), h('div', text));
}

export function emptyState({ text, hint, action }) {
  return h('div.page-state', h('div.page-state-text', text),
    hint ? h('div.small.muted', hint) : null,
    action ? h('div.mt', action) : null);
}

export function filteredEmptyState(onClear) {
  return h('div.page-state', h('div.page-state-text', '没有符合条件的记录'),
    h('div.small.muted', '当前筛选条件下没有匹配项，不代表没有数据。'),
    onClear ? h('div.mt', h('button.btn', { onclick: onClear }, '清除筛选')) : null);
}

export function errorState(err, onRetry) {
  return h('div.page-state',
    h('div.page-state-text', '加载失败'),
    h('div.small.muted', err && err.message ? err.message : String(err)),
    err && err.offline ? h('div.warn-box.mt', '当前离线：本页需要联网读取数据。') : null,
    onRetry ? h('div.mt', h('button.btn.btn-primary', { onclick: onRetry }, '重试')) : null);
}

export function deniedState(text = '当前角色没有该操作权限，页面为只读。') {
  return h('div.page-state', h('div.page-state-text', '只读'), h('div.small.muted', text));
}

/* ------------------------------------------------------------------ 其它 */
export { fmtDateTime } from './dateTime.js';

export function statusBadge(text, kind) {
  return h(`span.badge${kind ? `.badge-${kind}` : ''}`, text);
}

export function matchStatusBadge(match) {
  const map = {
    pending: ['等待前序结果', 'warn'],
    ready: ['待记录', 'info'],
    finished: ['已确认', 'ok'],
    void: ['轮空/不进行', ''],
  };
  const [text, kind] = map[match.status] || [match.status, ''];
  const extra = match.result_status && match.result_status !== 'normal'
    ? `（${match.result_status_name || match.result_status}）` : '';
  return statusBadge(text + extra, kind);
}

/* 页面标题区（交付物3 L-01）：面包屑 + 唯一 H1 + 状态徽标 + 主操作。
   页面只传数据，不再各自拼标题结构，避免同一系统出现三种页头。 */
export function pageHeader({ crumbs = [], title = '', badges = [], meta = [], actions = [] } = {}) {
  const crumbNodes = [];
  crumbs.forEach((item, index) => {
    if (index) crumbNodes.push(h('span.page-crumb-sep', { 'aria-hidden': 'true' }, '›'));
    const last = index === crumbs.length - 1;
    crumbNodes.push(item.href && !last
      ? h('a.page-crumb', { href: item.href }, item.label)
      : h('span.page-crumb', { class: last ? 'current' : '' }, item.label));
  });
  return h('header.page-head',
    crumbNodes.length ? h('nav.page-crumbs', { 'aria-label': '当前位置' }, crumbNodes) : null,
    h('div.page-head-row',
      h('div.page-head-main',
        h('h1.page-title', title),
        badges.length ? h('div.page-badges', ...badges) : null),
      actions.length ? h('div.page-actions', ...actions) : null),
    meta.length ? h('div.page-meta', ...meta) : null);
}

export function need(condition, message) {
  if (!condition) throw new Error(message || '参数不完整');
}

export function canWrite(role, allow = ['admin', 'organizer']) {
  return allow.includes(role);
}

/* 包装异步按钮回调：自动捕获异常并弹出错误提示 */
export function task(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      toast(e.message || '操作失败', 'error');
      return undefined;
    }
  };
}

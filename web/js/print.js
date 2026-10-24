/* 稳定打印页：/print.html?type=category-notice|school-notice&...&order=asc|desc

   安全边界：URL 只带业务参数，登录令牌与赛事上下文从同源 localStorage 读取，
   请求时用 Authorization + X-Event-ID 头（与主应用一致），令牌不进入地址栏/历史。
   失败路径：401 请登录、403 无权限、404 数据不存在、网络失败给重试，均提供返回入口，
   不显示空白 about:blank 页面。 */
const TYPES = {
  'category-notice': '项目成绩单',
  'school-notice': '学校团体总分表',
};
const params = new URLSearchParams(window.location.search);
const type = (params.get('type') || '').trim();
const order = params.get('order') === 'desc' ? 'desc' : 'asc';
const eventId = (params.get('event') || localStorage.getItem('stss_event') || '').trim();
const categoryId = (params.get('category_id') || '').trim();
const groupId = (params.get('group_id') || '').trim();
const titleEl = document.getElementById('print-title');
const messageEl = document.getElementById('print-message');
const actionsEl = document.getElementById('print-actions');
const statusEl = document.getElementById('print-status');

function returnLink() {
  if (type === 'category-notice' && categoryId) {
    return { href: `/#/results?category=${encodeURIComponent(categoryId)}`, label: '返回成绩页' };
  }
  if (type === 'school-notice' && groupId) {
    return { href: `/#/school?group=${encodeURIComponent(groupId)}`, label: '返回学校总分页' };
  }
  return { href: '/', label: '返回系统' };
}

function renderBlocked({ code, title, message, retry = false }) {
  statusEl.dataset.printError = code;
  statusEl.dataset.printErrorCode = code;
  titleEl.textContent = title;
  messageEl.textContent = message;
  messageEl.className = 'muted';
  actionsEl.hidden = false;
  actionsEl.textContent = '';
  if (retry) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'primary';
    button.dataset.printRetry = 'true';
    button.textContent = '重试';
    button.addEventListener('click', () => window.location.reload());
    actionsEl.append(button);
  }
  const link = document.createElement('a');
  link.href = returnLink().href;
  link.dataset.printBack = 'true';
  link.textContent = returnLink().label;
  actionsEl.append(link);
}

function readToken() {
  try { return localStorage.getItem('stss_token') || ''; } catch { return ''; }
}

async function run() {
  if (!Object.prototype.hasOwnProperty.call(TYPES, type)) {
    renderBlocked({ code: 'params', title: '打印参数无效',
      message: '打印类型必须是项目成绩单（category-notice）或学校团体总分表（school-notice），请从成绩页面重新打开打印。' });
    return;
  }
  document.title = TYPES[type];
  const token = readToken();
  if (!token) {
    renderBlocked({ code: '401', title: '请登录',
      message: '登录已失效或尚未登录，请返回系统登录后重新打开打印。' });
    return;
  }
  if (!eventId) {
    renderBlocked({ code: 'params', title: '缺少赛事上下文',
      message: '无法确定要打印的赛事，请从成绩页面重新打开打印。' });
    return;
  }
  const query = new URLSearchParams({ order });
  if (type === 'category-notice') {
    if (!categoryId) {
      renderBlocked({ code: 'params', title: '打印参数无效',
        message: '缺少项目编号，请从项目成绩页面重新打开打印。' });
      return;
    }
    query.set('category_id', categoryId);
  } else {
    if (!groupId) {
      renderBlocked({ code: 'params', title: '打印参数无效',
        message: '缺少组别编号，请从学校总分页面重新打开打印。' });
      return;
    }
    query.set('group_id', groupId);
  }
  let response;
  try {
    response = await fetch(`/api/exports/${type}.html?${query.toString()}`, {
      method: 'GET',
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, 'X-Event-ID': eventId },
    });
  } catch {
    renderBlocked({ code: 'network', retry: true, title: '网络不可用',
      message: '无法连接服务器，请检查网络连接后点击“重试”。' });
    return;
  }
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json()).message || ''; } catch { /* 非 JSON 错误体 */ }
    if (response.status === 401) {
      renderBlocked({ code: '401', title: '请登录',
        message: detail || '登录已失效或尚未登录，请返回系统重新登录后再打印。' });
    } else if (response.status === 403) {
      renderBlocked({ code: '403', title: '无权限',
        message: detail || '当前账号没有打印该项目/组别成绩的权限。' });
    } else if (response.status === 404) {
      renderBlocked({ code: '404', title: '数据不存在',
        message: detail || '要打印的项目或组别不存在（可能已被删除），请返回成绩页面重新选择。' });
    } else {
      renderBlocked({ code: 'http', retry: true, title: `打印失败（HTTP ${response.status}）`,
        message: detail || '服务器暂时无法生成打印内容，请稍后重试。' });
    }
    return;
  }
  const html = await response.text();
  /* 用服务端渲染的完整成绩单替换当前页面，地址栏保持为可刷新的 /print.html?...。
     打印/另存为 PDF 入口由服务端打印模板自带的工具栏提供（button onclick="window.print()"）。 */
  document.open();
  document.write(html);
  document.close();
}

run();

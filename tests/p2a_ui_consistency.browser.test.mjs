/* P2-A UI 与赛事上下文一致性真实浏览器回归（REQ-013/014/015/016/017/018）。

   独立 mkdtemp 数据目录 + 随机端口；不接触产品 data/，不依赖其它套件的数据。
   覆盖：账号页 5 角色权限说明、顶栏同名/不同名、赛程筛选空态清除、学校总分空态、
   新建向导一键常用四项、URL ?event= 单源解析（合法切换/非法回退/无 event 深链/
   启动优先 event/403·404 一次性回退）与 X-Event-ID 身份一致性。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scheduleFixture } from './helpers/schedule_fixture.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const data = await mkdtemp(path.join(tmpdir(), 'p2a-ui-consistency-'));
const artifacts = process.env.STSS_BROWSER_ARTIFACTS || path.join(data, 'artifacts');
await mkdir(artifacts, { recursive: true });
const child = spawn(process.env.STSS_PYTHON || 'python', ['-B', '-u', '-c', `
import json
from app import db, security
from app.http_server import Handler, load_routes, create_server
db.init_db()
conn = db.connect()
security.ensure_default_users(conn)
conn.close()
load_routes()
class Quiet(Handler):
    def log_message(self, *args): pass
server = create_server(('127.0.0.1', 0), Quiet)
print(json.dumps({'port': server.server_port}), flush=True)
server.serve_forever()
`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
  STSS_DATA_DIR: data, STSS_DB: path.join(data, 'registry.db'), STSS_EVENTS_DIR: path.join(data, 'events'),
  STSS_ADMIN_PASSWORD: 'UiConsistency123', PYTHONUTF8: '1' } });

let browser;
let serverErrors = '';
let token = '';
let identity = null;
let page;
const contexts = [];
const checks = [];
const failures = [];
const pageErrors = [];
child.stderr.on('data', (chunk) => { serverErrors += chunk; });
const check = async (name, action) => {
  try { await action(); checks.push(name); console.log('PASS ' + name); }
  catch (error) {
    failures.push({ name, message: error.stack || error.message });
    console.error('FAIL ' + name + ': ' + error.message);
    try { if (page) await page.screenshot({ path: path.join(artifacts, `failure-${failures.length}.png`), fullPage: true }); } catch {}
  }
};

try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(serverErrors || 'Startup timeout')), 15000);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Server ${code}: ${serverErrors}`)));
    let text = '';
    child.stdout.on('data', (chunk) => {
      text += chunk;
      try { const info = JSON.parse(text.split('\n')[0]); clearTimeout(timer); resolve(info.port); } catch {}
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json',
      'X-Client-Protocol': '2', ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(identity ? { 'X-Event-ID': String(identity.event_id), 'X-Event-UUID': identity.event_uuid,
        'X-Deployment-ID': identity.deployment_id } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    assert.ok(response.ok, `${method} ${url} -> ${response.status} ${JSON.stringify(result)}`);
    return result;
  };
  token = (await api('POST', '/api/login', { username: 'admin', password: 'UiConsistency123' })).token;
  const adminToken = token;
  const deployment = (await api('GET', '/api/events')).deployment_id;
  const identityOf = (event) => ({ event_id: event.event_id, event_uuid: event.event_uuid,
    deployment_id: deployment });
  const useIdentity = async (next, action) => {
    const previous = identity;
    identity = next;
    try { return await action(); } finally { identity = previous; }
  };
  const loginToken = async (username, password) => {
    const response = await fetch(base + '/api/login', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Protocol': '2' },
      body: JSON.stringify({ username, password }) });
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result.token;
  };
  const createFullEvent = async (name) => {
    const created = await api('POST', '/api/events/full', { event: { name },
      groups: [{ name: `${name}组`, code: 'G', categories: [{ name: '男子三人赛', kind: 'team', gender: 'male' }] }],
      venues: [] });
    return { ...created, identity: identityOf(created) };
  };

  /* ---------- 夹具：赛事 A/B（切换）、C（赛程筛选）、账号 ---------- */
  const A = await createFullEvent('甲赛事A');
  const B = await createFullEvent('乙赛事B');
  const cCreated = await api('POST', '/api/events', { name: '赛程筛选C' });
  const C = identityOf(cCreated);
  await useIdentity(C, () => api('POST', `/api/events/${C.event_id}/bootstrap`, {}));
  const cStructure = await useIdentity(C, () => api('GET', `/api/events/${C.event_id}/structure`));
  const cGroup = cStructure.groups[0];
  const cTeam = cGroup.categories.find((category) => category.kind === 'team' && category.gender === 'male');
  const cEmptyTeam = cGroup.categories.find((category) => category.kind === 'team' && category.gender === 'female');
  for (let index = 1; index <= 2; index += 1) {
    await useIdentity(C, () => api('POST', `/api/categories/${cTeam.id}/enrollments`, {
      school: { name: `赛程筛选学校${index}` },
      members: [1, 2, 3].map((n) => ({ name: `筛选队员${index}-${n}`, gender: 'male', jersey_no: String(n) })),
      captain_index: 0,
    }));
  }
  identity = C;
  await scheduleFixture(api, C, cTeam.id, { confirmed: true });
  identity = null;
  await api('POST', '/api/users', { username: 'viewer-diff', display_name: '张小三', role: 'viewer',
    password: 'UiConsistency123', event_ids: [A.event_id] });
  await api('POST', '/api/users', { username: 'admin-trim', display_name: '  赛事管理员  ', role: 'admin',
    password: 'UiConsistency123', event_ids: [] });
  const viewerToken = await loginToken('viewer-diff', 'UiConsistency123');
  const trimToken = await loginToken('admin-trim', 'UiConsistency123');

  browser = await chromium.launch({ headless: true, executablePath: process.env.STSS_BROWSER_PATH });
  const openPage = async ({ authToken, eventId = null, hash = '/#/dashboard', prepare = null } = {}) => {
    const context = await browser.newContext({ viewport: { width: 1365, height: 1000 }, locale: 'zh-CN',
      serviceWorkers: 'block' });
    await context.addInitScript(({ value, event }) => {
      localStorage.setItem('stss_token', value);
      if (event !== null) localStorage.setItem('stss_event', String(event));
    }, { value: authToken, event: eventId });
    const tab = await context.newPage();
    tab.setDefaultTimeout(15000);
    tab.on('pageerror', (error) => pageErrors.push(error.message));
    if (prepare) prepare(tab);
    await tab.goto(base + hash);
    contexts.push(context);
    return tab;
  };
  const moduleState = (tab) => tab.evaluate(async () => {
    const apiModule = await import('/js/api.js');
    const mainModule = await import('/js/main.js');
    return { identity: apiModule.getApiEventContext(), stateEvent: mainModule.state.eventId,
      stored: localStorage.getItem('stss_event'), hash: location.hash };
  });
  const apiRequestLog = (tab) => {
    const entries = [];
    const record = (request) => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) return;
      entries.push({ path: url.pathname, event: request.headers()['x-event-id'] || null });
    };
    tab.on('request', record);
    return { entries, stop: () => tab.off('request', record) };
  };

  /* ---------- REQ-013 账号页权限说明 5 角色 ---------- */
  page = await openPage({ authToken: adminToken, eventId: A.event_id });
  await check('REQ-013 账号页权限说明覆盖全部 5 个角色', async () => {
    /* 1.5.0 账号页重做（web/js/views/admin.js:317-336）：页头标题为“账号管理”，
       权限口径收敛为页头 meta 一行（五类角色 + 赛事范围说明），逐角色的菜单级只读说明
       移到 README 角色表；页面以“按角色筛选”和“新增账号角色”下拉承载五类角色。 */
    await page.goto(base + '/#/users');
    await page.getByRole('heading', { name: '账号管理', exact: true }).waitFor();
    const text = await page.locator('.page-meta').innerText();
    const expectedRoles = ['赛事管理员', '编排与成绩人员', '场地记录员', '成绩查看者', '大屏操作员'];
    for (const role of expectedRoles) {
      assert.ok(text.includes(role), `页头权限说明缺少角色：${role}`);
    }
    assert.ok(text.includes('普通账号只能访问被分配的赛事'), '页头应说明普通账号的赛事范围');
    const roleFilterOptions = await page.getByLabel('按角色筛选', { exact: true })
      .evaluate((select) => [...select.options].map((option) => option.textContent.trim()));
    for (const role of expectedRoles) {
      assert.ok(roleFilterOptions.includes(role), `角色筛选缺少：${role}`);
    }
    const roleOptions = await page.locator('#create-account-form select').first()
      .evaluate((select) => [...select.options].map((option) => option.textContent.trim()));
    for (const role of expectedRoles) {
      assert.ok(roleOptions.includes(role), `账号角色下拉缺少：${role}`);
    }
  });

  /* ---------- REQ-014 顶栏显示名去重 ---------- */
  await check('REQ-014 显示名=角色名时顶栏只显示一次（含刷新）', async () => {
    await page.goto(base + '/#/dashboard');
    await page.waitForFunction(() => document.getElementById('user-line')?.textContent === '赛事管理员');
    const text = (await page.locator('#user-line').textContent()).trim();
    assert.equal(text, '赛事管理员');
    assert.ok(!text.includes('（'), '相同名称不应出现括号');
    await page.reload();
    await page.waitForFunction(() => document.getElementById('user-line')?.textContent === '赛事管理员');
  });

  const trimPage = await openPage({ authToken: trimToken, eventId: A.event_id });
  await check('REQ-014 trim 后显示名与角色名相同也不重复', async () => {
    await trimPage.waitForFunction(() => document.getElementById('user-line')?.textContent === '赛事管理员');
    const text = (await trimPage.locator('#user-line').textContent()).trim();
    assert.equal(text, '赛事管理员', '首尾空格 trim 后同名只显示一次');
    assert.ok(!text.includes('（'));
  });

  const viewerPage = await openPage({ authToken: viewerToken, eventId: A.event_id, hash: '/#/account' });
  await check('REQ-014 显示名与角色名不同时显示“显示名（角色名）”', async () => {
    await viewerPage.getByRole('heading', { name: '修改我的密码', exact: true }).waitFor();
    await viewerPage.waitForFunction(() => document.getElementById('user-line')?.textContent === '张小三（成绩查看者）');
    const nav = await viewerPage.locator('#sidenav').innerText();
    assert.ok(nav.includes('赛事设置'), '查看者应保留赛事设置只读入口');
  });

  /* ---------- REQ-015 赛程筛选空态清除 ---------- */
  const schedulePage = await openPage({ authToken: adminToken, eventId: C.event_id,
    hash: `/#/workspace?event=${C.event_id}&category=${cTeam.id}&tab=schedule` });
  await check('REQ-015 状态筛选 0 行显示清除筛选并恢复完整列表', async () => {
    await schedulePage.getByRole('heading', { name: '比赛赛程', exact: true }).waitFor();
    await schedulePage.locator('.schedule-match').first().waitFor();
    const before = await schedulePage.locator('.schedule-match').count();
    assert.ok(before >= 1, '夹具应至少有一场比赛');
    await schedulePage.getByLabel('状态', { exact: false }).selectOption('finished');
    await schedulePage.getByText('没有符合条件的记录', { exact: true }).waitFor();
    const clearButton = schedulePage.getByRole('button', { name: '清除筛选', exact: true });
    assert.equal(await clearButton.isVisible(), true);
    await schedulePage.waitForFunction(() => location.hash.includes('status=finished'));
    await clearButton.click();
    await schedulePage.locator('.schedule-match').first().waitFor();
    assert.equal(await schedulePage.locator('.schedule-match').count(), before);
    assert.equal(await schedulePage.getByLabel('状态', { exact: false }).inputValue(), '');
    assert.equal(await schedulePage.getByLabel('场地', { exact: false }).inputValue(), '');
    await schedulePage.waitForFunction(() => !location.hash.includes('status=') && !location.hash.includes('venue='));
  });
  await check('REQ-015 无筛选且无比赛时保留原空态', async () => {
    await schedulePage.goto(base + `/#/workspace?event=${C.event_id}&category=${cEmptyTeam.id}&tab=schedule`);
    await schedulePage.getByText('当前没有比赛', { exact: true }).waitFor();
    assert.equal(await schedulePage.getByRole('button', { name: '清除筛选', exact: true }).count(), 0);
  });

  /* ---------- REQ-017 学校总分空态（与 build-results 的实现同文件覆盖） ---------- */
  const emptyEvent = await api('POST', '/api/events', { name: '空赛事D' });
  const schoolPage = await openPage({ authToken: adminToken, eventId: emptyEvent.event_id, hash: '/#/school' });
  await check('REQ-017 空赛事学校总分显示暂无组别/学校与设置入口', async () => {
    await schoolPage.locator('.page-state-text', { hasText: '暂无组别/学校' }).waitFor();
    const settingLink = schoolPage.getByRole('link', { name: '去赛事设置', exact: true });
    assert.ok((await settingLink.getAttribute('href')).includes('#/setup'), '空赛事应给出赛事设置入口');
  });
  const schoolTotalsPage = await openPage({ authToken: adminToken, eventId: C.event_id, hash: '/#/school' });
  await check('REQ-017/REQ-008 未开赛组显示未开赛且不显示待确认警告', async () => {
    await schoolTotalsPage.getByRole('heading', { name: '学校团体总分', exact: true }).waitFor();
    await schoolTotalsPage.getByRole('heading', { name: /甲组.*总分榜/ }).waitFor();
    await schoolTotalsPage.getByText('本组别尚未开赛/无成绩，名次不计入。', { exact: true }).waitFor();
    assert.ok(await schoolTotalsPage.getByText('未开赛/无成绩', { exact: true }).first().isVisible());
    const headers = await schoolTotalsPage.locator('.table-scroll th').allTextContents();
    assert.ok(headers.includes('名次') && headers.includes('团体总分'), `总分表关键列缺失：${headers.join(',')}`);
    assert.equal((await schoolTotalsPage.locator('#content').innerText()).includes('项名次未确认'), false,
      '未开赛组不应显示待确认警告');
  });
  await check('REQ-017 有组别但无学校时显示暂无学校/暂无成绩与报名入口', async () => {
    /* 1.5.0 起学校总分页的大组别切换改为“大组别”下拉（web/js/views/school.js:36），不再是按钮。
       默认 bootstrap 组名为“甲组：央属高校 / 乙组：市属高校 / 丙组：高职高专”，按前缀匹配。 */
    const yiGroup = cStructure.groups.find((group) => group.name.startsWith('乙组'));
    assert.ok(yiGroup, `夹具应包含乙组：${JSON.stringify(cStructure.groups.map((group) => group.name))}`);
    const groupSelect = schoolTotalsPage.getByLabel('大组别', { exact: true });
    await groupSelect.selectOption(String(yiGroup.id));
    await schoolTotalsPage.waitForFunction((id) => location.hash.includes(`group=${id}`), yiGroup.id);
    /* 各组别独立汇总也会出现“暂无学校/暂无成绩”，这里只锁总分榜的空态行。 */
    await schoolTotalsPage.locator('.page-state-text', { hasText: '暂无学校/暂无成绩' }).waitFor();
    const registerLink = schoolTotalsPage.getByRole('link', { name: '去学校报名', exact: true });
    assert.ok((await registerLink.getAttribute('href')).includes('tab=registration'), '空组应给出报名入口');
    assert.equal(await groupSelect.inputValue(), String(yiGroup.id), '组别切换保留');
    assert.ok(await schoolTotalsPage.getByRole('button', { name: /导出.*CSV/ }).count() >= 1, '导出按钮保留');
    assert.equal(await schoolTotalsPage.getByRole('button', { name: '打印总分表', exact: true }).count(), 1);
  });

  /* ---------- REQ-016 向导一键添加常用四项 ---------- */
  const wizardPage = await openPage({ authToken: adminToken, eventId: A.event_id, hash: '/#/setup?action=new' });
  await check('REQ-016 向导一键常用四项、重复不增、可编辑删除并创建成功', async () => {
    const expected = [
      { name: '男子三人赛', gender: 'male', kind: 'team' },
      { name: '女子三人赛', gender: 'female', kind: 'team' },
      { name: '男子个人赛', gender: 'male', kind: 'individual' },
      { name: '女子个人赛', gender: 'female', kind: 'individual' },
    ];
    const expectedKeys = expected.map((preset) => `${preset.gender}:${preset.kind}`);
    const readRows = () => wizardPage.locator('.project-row').evaluateAll((rows) => rows.map((row) => ({
      name: row.querySelector('input')?.value ?? '',
      gender: row.querySelectorAll('select')[0]?.value ?? '',
      kind: row.querySelectorAll('select')[1]?.value ?? '',
    })));
    const expectRows = async (wanted) => {
      await wizardPage.waitForFunction((count) => document.querySelectorAll('.project-row').length === count,
        wanted.length);
      assert.deepEqual(await readRows(), wanted);
    };
    await wizardPage.getByRole('heading', { name: '第 1 步 · 赛事信息', exact: true }).waitFor();
    await wizardPage.getByLabel('赛事名称', { exact: false }).fill('一键四项回归赛事');
    await wizardPage.getByRole('button', { name: '下一步', exact: true }).click();
    await wizardPage.getByRole('button', { name: '添加组别', exact: true }).click();
    await wizardPage.getByLabel('组别名称', { exact: false }).fill('甲组');
    await wizardPage.getByRole('button', { name: '下一步', exact: true }).click();
    await wizardPage.getByRole('heading', { name: '第 3 步 · 比赛项目', exact: true }).waitFor();
    const addAll = wizardPage.getByRole('button', { name: '一键添加常用四项', exact: true });
    assert.equal(await addAll.count(), 1, '每个组别应有一个一键添加按钮');
    await addAll.click();
    await expectRows(expected);
    await addAll.click();
    await expectRows(expected);                                     // 重复点击不新增
    const rows = wizardPage.locator('.project-row');
    await rows.nth(3).getByRole('button', { name: '删除', exact: true }).click();
    assert.equal(await rows.count(), 3, '一键生成的项目可删除');
    await wizardPage.getByRole('button', { name: '添加比赛项目', exact: true }).click();
    assert.equal(await rows.count(), 4, '手填路径保留');
    const last = rows.nth(3);
    await last.getByLabel('项目名称', { exact: false }).fill('女子个人赛');
    await last.getByLabel('性别', { exact: false }).selectOption('female');
    await last.getByLabel('项目类型', { exact: false }).selectOption('individual');
    await addAll.click();
    await expectRows(expected);                                     // 已存在的 gender:kind 不重复追加
    await wizardPage.getByRole('button', { name: '下一步', exact: true }).click();
    await wizardPage.getByRole('heading', { name: '第 4 步 · 比赛场地', exact: true }).waitFor();
    await wizardPage.getByRole('button', { name: '下一步', exact: true }).click();
    await wizardPage.getByRole('heading', { name: '第 5 步 · 确认创建', exact: true }).waitFor();
    const responsePromise = wizardPage.waitForResponse((response) =>
      response.url().endsWith('/api/events/full') && response.request().method() === 'POST');
    await wizardPage.getByRole('button', { name: '确认并创建赛事', exact: true }).click();
    const response = await responsePromise;
    assert.equal(response.status(), 200);
    const created = await response.json();
    const categories = response.request().postDataJSON().groups[0].categories;
    assert.equal(categories.length, 4);
    assert.deepEqual(categories.map((category) => `${category.gender}:${category.kind}`), expectedKeys);
    assert.deepEqual(categories.map((category) => category.name), expected.map((preset) => preset.name));
    const keys = categories.map((category) => `${category.gender}:${category.kind}`);
    assert.equal(new Set(keys).size, keys.length, '创建载荷不得出现重复 gender:kind');
    await wizardPage.locator('.ctx-bar').waitFor();
    token = adminToken;
    identity = identityOf(created);
    const structure = await api('GET', `/api/events/${created.event_id}/structure`);
    const stored = structure.groups.find((group) => group.name === '甲组').categories;
    assert.deepEqual(stored.map((category) => `${category.gender}:${category.kind}`).sort(), expectedKeys.slice().sort());
    assert.equal(new Set(stored.map((category) => `${category.gender}:${category.kind}`)).size, 4);
    identity = null;
  });

  /* ---------- REQ-018 URL 赛事上下文单源解析 ---------- */
  await check('REQ-018 ?event= 合法不一致：reloadShell 切换 + toast + 身份一致', async () => {
    await page.goto(base + '/#/dashboard');
    await page.waitForFunction((id) => document.getElementById('event-select')?.value === String(id), A.event_id);
    const log = apiRequestLog(page);
    try {
      await page.goto(base + `/#/workspace?event=${B.event_id}&group=${B.group_id}&category=${B.category_id}&tab=overview`);
      await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('已切换到'));
      const toastText = await page.locator('#toast').textContent();
      assert.ok(toastText.includes('已切换到「乙赛事B」'), `切换提示不正确：${toastText}`);
      await page.getByRole('heading', { name: '项目进度', exact: true }).waitFor();
      await page.waitForFunction((id) => document.getElementById('event-select')?.value === String(id), B.event_id);
      const info = await moduleState(page);
      assert.equal(info.stateEvent, B.event_id);
      assert.equal(info.identity?.event_id, B.event_id);
      assert.equal(info.identity?.event_uuid, B.event_uuid);
      assert.equal(info.stored, String(B.event_id));
      assert.ok(info.hash.includes(`event=${B.event_id}`));
      /* /api/events 是 registry 作用域列表接口，服务端不按 X-Event-ID 取库；
         结构、工作台等业务读写的 X-Event-ID 必须全部属于目标赛事。 */
      const eventScoped = log.entries.filter((entry) => entry.event && entry.path !== '/api/events');
      assert.ok(eventScoped.length > 0, '切换后应发出带赛事身份的业务请求');
      assert.deepEqual(eventScoped.filter((entry) => entry.event !== String(B.event_id)), [],
        '切换后所有业务请求的 X-Event-ID 必须与 UI 当前赛事一致');
      const structureRead = log.entries.find((entry) => entry.path === `/api/events/${B.event_id}/structure`);
      assert.ok(structureRead, '切换时必须读取目标赛事结构');
      assert.equal(structureRead.event, String(B.event_id));
      const workspaceRead = log.entries.find((entry) => entry.path === `/api/categories/${B.category_id}/workspace`);
      assert.ok(workspaceRead, '列表/工作台读取应发生在切换后');
      assert.equal(workspaceRead.event, String(B.event_id));
    } finally { log.stop(); }
  });

  await check('REQ-018 ?event= 非法/不可见：回退当前赛事且保留其它 query', async () => {
    await page.goto(base + '/#/dashboard?event=999999&tab=keep-me');
    await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('赛事参数无效，已回到当前赛事'));
    await page.waitForFunction((id) => location.hash.includes(`event=${id}`), B.event_id);
    assert.ok(!page.url().includes('999999'), '无效赛事参数必须被替换');
    assert.ok(page.url().includes('tab=keep-me'), '回退时必须保留其它 query 参数');
    assert.equal(await page.locator('#event-select').inputValue(), String(B.event_id));
    await page.getByRole('heading', { name: '乙赛事B', exact: true }).waitFor();
    await page.goto(base + '/#/dashboard?event=abc&sort=keep');
    await page.waitForFunction((id) => location.hash.includes(`event=${id}`), B.event_id);
    assert.ok(!page.url().includes('event=abc'), '非整数 event 必须被替换');
    assert.ok(page.url().includes('sort=keep'));
    assert.equal(await page.locator('#event-select').inputValue(), String(B.event_id));
  });

  await check('REQ-018 无 event 深链沿用当前赛事，不发起跨赛事读取', async () => {
    const log = apiRequestLog(page);
    try {
      await page.goto(base + `/#/workspace?group=${B.group_id}&category=${B.category_id}&tab=overview`);
      await page.getByRole('heading', { name: '项目进度', exact: true }).waitFor();
      await page.waitForFunction((id) => document.getElementById('event-select')?.value === String(id), B.event_id);
      const info = await moduleState(page);
      assert.equal(info.stateEvent, B.event_id);
      assert.equal(info.identity?.event_id, B.event_id);
      const withHeader = log.entries.filter((entry) => entry.event);
      assert.ok(withHeader.length > 0);
      assert.deepEqual(withHeader.filter((entry) => entry.event !== String(B.event_id)), []);
    } finally { log.stop(); }
  });

  const bootLog = [];
  const bootPage = await openPage({ authToken: adminToken, eventId: A.event_id,
    hash: `/#/workspace?event=${B.event_id}&group=${B.group_id}&category=${B.category_id}&tab=overview`,
    prepare: (tab) => tab.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/')) {
        bootLog.push({ path: url.pathname, event: request.headers()['x-event-id'] || null });
      }
    }) });
  await check('REQ-018 启动优先读取地址 event，避免重复加载', async () => {
    await bootPage.waitForFunction(() => document.getElementById('toast')?.textContent.includes('已切换到'));
    await bootPage.getByRole('heading', { name: '项目进度', exact: true }).waitFor();
    await bootPage.waitForFunction((id) => document.getElementById('event-select')?.value === String(id), B.event_id);
    const structureReads = bootLog.filter((entry) => entry.path === `/api/events/${B.event_id}/structure`);
    assert.equal(structureReads.length, 1, '启动已按 URL event 加载，路由不应重复读取结构');
    assert.equal(structureReads[0].event, String(B.event_id));
    assert.equal(bootLog.filter((entry) => entry.path === `/api/events/${A.event_id}/structure`).length, 0,
      '启动不应先按 stss_event 读取其它赛事结构');
    const info = await moduleState(bootPage);
    assert.equal(info.stateEvent, B.event_id);
    assert.equal(info.identity?.event_id, B.event_id);
    assert.equal(info.stored, String(B.event_id));
    const toastText = await bootPage.locator('#toast').textContent();
    assert.ok(toastText.includes('已切换到「乙赛事B」'), toastText);
  });

  await check('REQ-018 启动地址 event 非法时回退当前赛事', async () => {
    await bootPage.goto(base + '/#/dashboard?event=abc&tab=keep-boot');
    await bootPage.waitForFunction(() => document.getElementById('toast')?.textContent.includes('赛事参数无效，已回到当前赛事'));
    await bootPage.waitForFunction((id) => location.hash.includes(`event=${id}`), B.event_id);
    assert.ok(!bootPage.url().includes('event=abc'));
    assert.ok(bootPage.url().includes('tab=keep-boot'));
    assert.equal(await bootPage.locator('#event-select').inputValue(), String(B.event_id));
    await bootPage.getByRole('heading', { name: '乙赛事B', exact: true }).waitFor();
  });

  await check('REQ-018 reloadShell 403/404 一次性回退且不循环', async () => {
    await page.goto(base + '/#/dashboard');
    await page.getByRole('heading', { name: '乙赛事B', exact: true }).waitFor();
    for (const status of [403, 404]) {
      let hits = 0;
      const pattern = `**/api/events/${A.event_id}/structure`;
      const deny = async (route) => {
        hits += 1;
        await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({
          ok: false, code: status === 403 ? 'forbidden' : 'not_found',
          message: status === 403 ? '无权访问该赛事' : '赛事不存在' }) });
      };
      await page.route(pattern, deny);
      try {
        await page.goto(base + `/#/dashboard?event=${A.event_id}`);
        await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('无权访问该赛事，已回到当前赛事'));
        await page.waitForFunction((id) => location.hash.includes(`event=${id}`), B.event_id);
        assert.equal(await page.locator('#event-select').inputValue(), String(B.event_id));
        await page.getByRole('heading', { name: '乙赛事B', exact: true }).waitFor();
        assert.equal(hits, 1, `${status} 回退只尝试一次，不应循环重试`);
      } finally { await page.unroute(pattern, deny); }
    }
  });

  assert.deepEqual(pageErrors, []);
  console.log(`PASS: P2-A UI 一致性 ${checks.length} 项检查全部通过`);
} finally {
  await writeFile(path.join(artifacts, 'p2a-ui-consistency-report.json'), JSON.stringify({ checks, failures, pageErrors, serverErrors }, null, 2));
  for (const context of contexts) { try { await context.close(); } catch {} }
  if (browser) { try { await browser.close(); } catch {} }
  child.kill();
}
assert.deepEqual(failures, [], 'P2-A UI 一致性回归必须全部通过');

/* 新建账号/人员可见性回归：筛选态新建必须立即可见、表单状态必须复位、
   刷新后仍在，以及“待核实提交被确定性 4xx 拒绝后必须解锁”（2026-10-24 修复）。
   独立临时数据目录 + 随机端口，不接触产品 data/。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const dataDir = path.join(tmpdir(), `stss-account-person-${Date.now()}-${process.pid}`);
const artifacts = process.env.STSS_BROWSER_ARTIFACTS || path.join(tmpdir(), 'stss-account-person-artifacts');
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
class QuietHandler(Handler):
    def log_message(self, *args): pass
server = create_server(('127.0.0.1', 0), QuietHandler)
print(json.dumps({'port': server.server_port}), flush=True)
server.serve_forever()
`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, STSS_DATA_DIR: dataDir, STSS_DB: path.join(dataDir, 'registry.db'),
    STSS_EVENTS_DIR: path.join(dataDir, 'events'), STSS_ADMIN_PASSWORD: 'VisibilityTest123',
    PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' } });

let serverErrors = '', browser, context, page;
child.stderr.on('data', (chunk) => { serverErrors += chunk; });
const artifactsDir = artifacts;
const shot = async (name) => { try { await page.screenshot({ path: path.join(artifactsDir, name), fullPage: true }); } catch {} };

try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(serverErrors || 'Server timeout')), 15000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${serverErrors}`)); });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      try { const result = JSON.parse(output.split('\n')[0]); clearTimeout(timer); resolve(result.port); } catch { /* wait */ }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  let token = '';
  let identity = null;
  const api = async (method, url, body) => {
    const response = await fetch(base + url, { method,
      headers: { 'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(identity ? { 'X-Event-ID': String(identity.event_id), 'X-Event-UUID': identity.event_uuid,
          'X-Deployment-ID': identity.deployment_id } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    assert.equal(response.ok, true, `${method} ${url}: ${JSON.stringify(data)}`);
    return data;
  };

  token = (await api('POST', '/api/login', { username: 'admin', password: 'VisibilityTest123' })).token;
  identity = await api('POST', '/api/events', { name: '可见性回归赛事' });
  identity.deployment_id = (await api('GET', '/api/events')).deployment_id;
  const groupId = (await api('POST', `/api/events/${identity.event_id}/groups`, {
    name: '甲组', code: '甲', seq: 1 })).group_id;
  const categoryId = (await api('POST', `/api/groups/${groupId}/categories`, {
    name: '男子三人赛', kind: 'team', gender: 'male' })).category_id;
  const schoolId = (await api('POST', `/api/events/${identity.event_id}/schools`, {
    name: '可见性测试大学', group_id: groupId })).school_id;

  browser = await chromium.launch({ headless: true, executablePath: process.env.STSS_BROWSER_PATH || undefined });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
  await context.addInitScript(({ token: savedToken, eventId }) => {
    localStorage.setItem('stss_token', savedToken);
    localStorage.setItem('stss_event', String(eventId));
  }, { token, eventId: identity.event_id });
  page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  /* ---------------------------------------------------------------- 账号管理 */
  await page.goto(base + '/#/users', { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '账号列表', exact: true }).waitFor();
  // 侧栏底部与页面标题区显示外壳版本，便于现场核对浏览器是否已加载新版（旧缓存不会再伪装成“已修复”）。
  assert.match(await page.locator('.nav-build').innerText(), /stss-shell-v99/);
  assert.match(await page.locator('.account-build').innerText(), /stss-shell-v99/);
  const form = page.locator('#create-account-form');
  const search = page.locator('input[aria-label="搜索账号"]');
  const status = page.locator('.account-list-status');

  // 真实浏览器自动填充状态不保证携带 insertReplacementText：使用浏览器的
  // :autofill 伪类复现普通 input / insertText，不能把保存的凭据当作搜索。
  const savedUsername = (await api('GET', '/api/users')).users[0].username;
  const autofillSession = await context.newCDPSession(page);
  await autofillSession.send('DOM.enable');
  await autofillSession.send('CSS.enable');
  const { root: documentNode } = await autofillSession.send('DOM.getDocument');
  const { nodeId: searchNodeId } = await autofillSession.send('DOM.querySelector', {
    nodeId: documentNode.nodeId, selector: 'input[aria-label="搜索账号"]',
  });
  try {
    for (const inputType of ['', 'insertText']) {
      await page.evaluate((value) => {
        document.querySelector('input[aria-label="搜索账号"]').value = value;
      }, savedUsername);
      await autofillSession.send('CSS.forcePseudoState', {
        nodeId: searchNodeId, forcedPseudoClasses: ['autofill'],
      });
      assert.equal(await search.evaluate((node) => node.matches(':autofill')), true,
        '夹具必须进入浏览器的自动填充状态');
      await page.evaluate((type) => {
        const node = document.querySelector('input[aria-label="搜索账号"]');
        node.dispatchEvent(type ? new InputEvent('input', { inputType: type, bubbles: true })
          : new Event('input', { bubbles: true }));
      }, inputType);
      await page.waitForFunction(() => document.querySelector('input[aria-label="搜索账号"]')?.value === '',
        null, { timeout: 4000 });
      assert.equal(await status.isHidden(), true, '自动填充不得激活筛选统计');
    }
    await autofillSession.send('CSS.forcePseudoState', {
      nodeId: searchNodeId, forcedPseudoClasses: [],
    });
    await search.pressSequentially('无匹配关键词');
    assert.equal(await search.inputValue(), '无匹配关键词', '正常键入应更新搜索');
    await page.evaluate((value) => {
      document.querySelector('input[aria-label="搜索账号"]').value = value;
    }, savedUsername);
    await autofillSession.send('CSS.forcePseudoState', {
      nodeId: searchNodeId, forcedPseudoClasses: ['autofill'],
    });
    await page.evaluate(() => {
      document.querySelector('input[aria-label="搜索账号"]')
        .dispatchEvent(new InputEvent('input', { inputType: 'insertText', bubbles: true }));
    });
    assert.equal(await search.inputValue(), '无匹配关键词', '自动填充应恢复用户已有的筛选值');
    assert.equal(await status.innerText(), '显示 0 / 共 1 个账号 · 1 个启用');
  } finally {
    await autofillSession.send('CSS.forcePseudoState', {
      nodeId: searchNodeId, forcedPseudoClasses: [],
    });
    await autofillSession.detach();
  }
  await search.fill('');

  // 浏览器也可能在绑定筛选逻辑之前填值；筛选初值必须来自调用方的应用状态。
  const initialFilter = await page.evaluate(async (value) => {
    const { bindFilterInput } = await import('/js/ui.js');
    const input = document.createElement('input');
    input.value = value;
    document.body.append(input);
    let changes = 0;
    const binding = bindFilterInput(input, () => { changes += 1; }, { initialValue: '' });
    const result = { stateEmpty: binding.value() === '', domEmpty: input.value === '', changes };
    binding.destroy(); input.remove();
    return result;
  }, savedUsername);
  assert.deepEqual(initialFilter, { stateEmpty: true, domEmpty: true, changes: 0 },
    '绑定前的自动填充值不能成为应用的筛选初值');

  // 0) 模拟浏览器/密码管理器自动填充：静默赋值与 insertReplacementText 事件都不得过滤列表，
  //    新建表单被填入旧凭据也必须被清理（否则点创建会得到重复用户名错误）。
  await page.evaluate(() => {
    document.querySelector('input[aria-label="搜索账号"]').value = 'admin';
    document.querySelector('#new-account-username').value = 'admin';
    document.querySelector('#new-account-display-name').value = 'admin';
    document.querySelector('#new-account-password').value = 'saved-password';
  });
  await page.waitForFunction(() => document.querySelector('input[aria-label="搜索账号"]')?.value === ''
    && document.getElementById('new-account-username')?.value === ''
    && document.getElementById('new-account-display-name')?.value === ''
    && document.getElementById('new-account-password')?.value === '', null, { timeout: 8000 });
  assert.equal(await page.locator('.account-list-status').isHidden(), true, '自动填充的搜索值不得触发筛选');
  assert.equal(await page.locator('tbody tr').count(), 1, '自动填充清理后应显示全部账号（仅 admin）');

  // 用户点击输入框后浏览器再应用自动填充（insertReplacementText）同样不能触发筛选。
  await page.evaluate(() => {
    const node = document.querySelector('input[aria-label="搜索账号"]');
    node.focus();
    node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    node.value = 'admin';
    node.dispatchEvent(new InputEvent('input', { inputType: 'insertReplacementText', bubbles: true, data: 'admin' }));
  });
  await page.waitForFunction(() => document.querySelector('input[aria-label="搜索账号"]')?.value === '', null, { timeout: 4000 });
  assert.equal(await page.locator('.account-list-status').isHidden(), true, '点击后的自动填充不得触发筛选');
  assert.equal(await page.locator('tbody tr').count(), 1, '点击后的自动填充不应隐藏账号');

  // 1) 筛选态下新建：成功创建后必须清空筛选、定位新账号，徽标与列表口径一致
  await search.fill('admin');
  await page.waitForFunction(() => document.querySelector('.account-list-status')?.textContent.startsWith('显示 1 /'));
  await form.getByLabel('登录名', { exact: true }).fill('VIS1');
  await form.getByLabel('显示名称', { exact: true }).fill('可见性一');
  await form.getByLabel('初始密码', { exact: true }).fill('Visible123');
  await form.getByRole('button', { name: '创建', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('input[aria-label="搜索账号"]')?.value === '');
  await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'VIS1', exact: true }) }).waitFor();
  assert.equal(await search.inputValue(), '', '新建成功后应清空搜索筛选');
  assert.equal(await status.isHidden(), true, '无筛选时不显示筛选统计行');
  assert.equal(await page.locator('.toast').innerText(), '已创建账号，已清除筛选以显示新账号');
  assert.equal(await page.locator('tbody tr.flash').count(), 1, '新账号行应高亮定位');
  await shot('account-after-create.png');

  // 2) 成功创建后角色与所属赛事必须复位，不能静默继承到下一个账号
  await form.locator('.event-scope-trigger').click();
  await form.locator('.event-scope-option input').check();
  await form.locator('.event-scope-picker').getByRole('button', { name: '完成', exact: true }).click();
  await form.locator('select').selectOption('viewer');
  await form.getByLabel('登录名', { exact: true }).fill('VIS2');
  await form.getByLabel('显示名称', { exact: true }).fill('可见性二');
  await form.getByLabel('初始密码', { exact: true }).fill('Visible123');
  await form.getByRole('button', { name: '创建', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('new-account-username')?.value === ''
    && document.querySelector('input[data-field="event_ids"]').value === '[]');
  const formState = await form.evaluate((node) => ({
    role: node.querySelector('select').value,
    eventIds: node.querySelector('input[data-field="event_ids"]').value,
    trigger: node.querySelector('.event-scope-trigger').textContent,
  }));
  assert.equal(formState.role, 'recorder', '新建成功后角色应复位为默认值');
  assert.equal(formState.eventIds, '[]', '新建成功后所属赛事应清空');
  assert.ok(formState.trigger.includes('请选择赛事'), '赛事选择器应回到未选择状态');
  const vis2 = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'VIS2', exact: true }) });
  await vis2.waitFor();
  assert.ok((await vis2.innerText()).includes('成绩查看者'), 'VIS2 应保存创建时选择的角色');
  assert.ok((await vis2.innerText()).includes('可见性回归赛事'), 'VIS2 应保存创建时选择的赛事范围');
  const vis1 = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'VIS1', exact: true }) });
  await vis1.waitFor();
  assert.ok((await vis1.innerText()).includes('场地记录员'), 'VIS1 应保持创建时的角色');
  assert.ok((await vis1.innerText()).includes('尚未分配'), 'VIS1 未选择赛事应显示尚未分配');

  // 3) 刷新后两个账号仍在且无重复
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '账号列表', exact: true }).waitFor();
  await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'VIS1', exact: true }) }).waitFor();
  await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'VIS2', exact: true }) }).waitFor();
  assert.equal(await page.getByRole('cell', { name: 'VIS1', exact: true }).count(), 1, '刷新后账号不应重复');
  await shot('account-after-reload.png');

  // 4) 用户名重复时：创建失败必须可见，并清空筛选、定位到现有账号（不能表现为“新角色消失”）
  await search.fill('admin');
  await page.waitForFunction(() => document.querySelector('.account-list-status')?.textContent.startsWith('显示 1 /'));
  await form.getByLabel('登录名', { exact: true }).fill('VIS1');
  await form.getByLabel('初始密码', { exact: true }).fill('Visible123');
  await form.getByRole('button', { name: '创建', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#create-account-form .field-error:not(.hidden)')?.textContent.includes('已存在'));
  await page.waitForFunction(() => document.querySelector('input[aria-label="搜索账号"]')?.value === '');
  await page.waitForFunction(() => document.querySelector('.account-list-status')?.classList.contains('hidden'));
  assert.equal(await page.locator('.account-list-status').isHidden(), true, '重复用户名时应清除筛选');
  await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'VIS1', exact: true }) }).waitFor();
  assert.match(await page.locator('.toast').innerText(), /已存在/, '重复用户名应给出明确提示');
  await shot('account-duplicate-recovered.png');

  /* ---------------------------------------------------------------- 学校报名人员 */
  const schoolUrl = `${base}/#/workspace?event=${identity.event_id}&tab=registration&group=${groupId}&category=${categoryId}&school=${schoolId}`;
  await page.goto(schoolUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '学校人员', exact: true }).waitFor();
  const personSearch = page.locator('input[aria-label="搜索学校人员"]');
  // 自动填充的搜索值同样不得把人员列表意外过滤（用户并未筛选）。
  await page.evaluate(() => {
    const node = document.querySelector('input[aria-label="搜索学校人员"]');
    if (node) node.value = 'admin';
  });
  await page.waitForFunction(() => document.querySelector('input[aria-label="搜索学校人员"]')?.value === '', null, { timeout: 8000 });
  await personSearch.fill('不存在的人');
  await page.waitForFunction(() => document.body.innerText.includes('显示 0 / 全校 0 位人员'));
  await page.locator('details summary', { hasText: '新增人员' }).first().click();
  await page.locator('input[aria-label="新增人员姓名"]').fill('可见人员');
  await page.getByRole('button', { name: '添加人员', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('input[aria-label="搜索学校人员"]')?.value === '');
  await page.locator('[data-person] summary', { hasText: '可见人员' }).waitFor();
  assert.equal(await personSearch.inputValue(), '', '新增人员后应清空“查找人员”筛选');
  assert.equal(await page.locator('.school-registration-unsaved').count(), 1, '未提交修改应有明确提示');
  await shot('person-after-add.png');

  /* 4) 待核实提交被确定性 4xx（registration_stale）拒绝后必须解锁 */
  await page.getByRole('button', { name: '预览整批变更', exact: true }).first().click();
  await page.getByRole('button', { name: '确认整批提交', exact: true }).first().waitFor();
  const latest = await api('GET', `/api/schools/${schoolId}/registration-workspace`);
  let commits = 0;
  await page.route('**/registration-commit', async (route) => {
    commits += 1;
    if (commits === 1) await route.abort('failed');
    else if (commits === 2) {
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({
        ok: false, code: 'registration_stale', outcome: 'not_committed',
        message: '赛事报名或赛程已变化，请核对最新名单后重新预览。当前输入已保留。',
        detail: { latest } }) });
    } else await route.continue();
  });
  await page.getByRole('button', { name: '确认整批提交', exact: true }).first().click();
  await page.waitForFunction(() => document.querySelector('[data-action="school-preview"]')?.textContent === '核实并重试原提交');
  await page.getByRole('button', { name: '核实并重试原提交', exact: true }).first().click();
  await page.waitForFunction(() => document.querySelector('[data-action="school-preview"]')?.textContent === '预览整批变更');
  await page.waitForFunction(() => document.querySelector('.form-errors')?.textContent.includes('后台报名已被其他入口更新'));
  assert.equal(await page.locator('.school-registration-person input').first().isEnabled(), true,
    '确定性拒绝后编辑必须恢复可用（不能永久锁定）');
  await page.locator('[data-person] summary', { hasText: '可见人员' }).waitFor();
  await shot('pending-released.png');
  await page.unroute('**/registration-commit');
  await page.getByRole('button', { name: '预览整批变更', exact: true }).first().click();
  await page.getByRole('button', { name: '确认整批提交', exact: true }).first().waitFor();
  await page.getByRole('button', { name: '确认整批提交', exact: true }).first().click();
  await page.waitForFunction(() => document.body.innerText.includes('学校报名已整批保存'));
  const saved = await api('GET', `/api/schools/${schoolId}/registration-workspace`);
  assert.equal(saved.people.filter((person) => person.name === '可见人员').length, 1, '解锁后应能正常整批提交');
  await shot('person-saved.png');

  assert.deepEqual(pageErrors, [], '页面不应有未捕获脚本错误');
  console.log('PASS: 筛选态新建账号/人员立即可见、表单状态复位、刷新不丢失、待核实 4xx 解锁可重试');
} finally {
  try { await context?.close(); } catch {}
  try { await browser?.close(); } catch {}
  child.kill();
  if (serverErrors && !serverErrors.includes('INFO')) console.error(serverErrors.slice(-2000));
}

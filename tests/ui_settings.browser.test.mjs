import { scheduleFixture } from './helpers/schedule_fixture.mjs';
import { installLegacyRosterFixture } from './helpers/legacy_roster_fixture.mjs';
/* 设置分区、种子编辑与记录队列的真实浏览器回归；只使用独立临时服务。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const dataDir = path.join(tmpdir(), `stss-ui-settings-${Date.now()}-${process.pid}`);
const artifacts = process.env.STSS_BROWSER_ARTIFACTS || path.join(tmpdir(), 'stss-ui-settings-artifacts');
await mkdir(artifacts, { recursive: true });
const child = spawn(process.env.STSS_PYTHON || 'python', ['-u', '-c', `
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
    STSS_EVENTS_DIR: path.join(dataDir, 'events'), STSS_ADMIN_PASSWORD: 'UiSettingsTest123', PYTHONUTF8: '1' },
});
let serverErrors = '', browser, page;
child.stderr.on('data', chunk => { serverErrors += chunk; });
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(serverErrors || 'Server timeout')), 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${serverErrors}`)); });
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      try { const result = JSON.parse(output.split('\n')[0]); clearTimeout(timer); resolve(result.port); } catch {}
    });
  });
  const base = `http://127.0.0.1:${port}`;
  let token = '', identity;
  const api = async (method, url, body) => {
    const response = await fetch(base + url, { method,
      headers: { 'Content-Type': 'application/json', 'X-Client-Protocol': '2', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(identity ? { 'X-Event-ID': String(identity.event_id), 'X-Event-UUID': identity.event_uuid } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.ok, true, JSON.stringify(data));
    return data;
  };
  token = (await api('POST', '/api/login', { username: 'admin', password: 'UiSettingsTest123' })).token;
  identity = await api('POST', '/api/events', { name: '首都高校藤球比赛 · 设置布局回归' });
  identity.deployment_id = (await api('GET', '/api/events')).deployment_id;
  const groups = [];
  for (const [index, name] of ['甲组', '乙组'].entries()) {
    const id = (await api('POST', `/api/events/${identity.event_id}/groups`, {
      name, code: name[0], seq: index + 1,
    })).group_id;
    const categories = [];
    for (const kind of ['team', 'individual']) {
      const categoryId = (await api('POST', `/api/groups/${id}/categories`, {
        name: kind === 'team' ? '男子三人赛' : '男子个人赛', kind, gender: 'male',
      })).category_id;
      categories.push({ id: categoryId, kind, gender: 'male', group_id: id });
    }
    groups.push({ id, name, categories });
  }
  const [groupA, groupB] = groups;
  const team = groupA.categories.find(category => category.kind === 'team');
  const personal = groupA.categories.find(category => category.kind === 'individual');
  const schoolNames = ['中国人民大学', '清华大学', '北京科技大学', '北京北大方正软件职业技术学院'];
  for (const [index, name] of schoolNames.entries()) {
    const school = (await api('POST', `/api/events/${identity.event_id}/schools`, {
      name, group_id: groupA.id,
    })).school_id;
    await api('POST', `/api/categories/${team.id}/enrollments`, { school_id: school, captain_index: 0,
      members: [1, 2, 3].map(number => ({ name: `匿名队员${index + 1}-${number}`, gender: 'male', jersey_no: String(number) })),
    });
    await api('POST', `/api/categories/${personal.id}/enrollments/individual`, { school_id: school,
      athlete: { name: `匿名个人选手${index + 1}`, gender: 'male' },
    });
  }
  const venueIds = [];
  for (const name of ['体育馆一号场', '体育馆二号场']) {
    venueIds.push((await api('POST', `/api/events/${identity.event_id}/venues`, { name })).venue_id);
  }
  await api('POST', '/api/users', { username: 'settings-organizer', display_name: '设置只读账号', role: 'organizer',
    password: 'OrganizerSettings123', event_ids: [identity.event_id] });
  const readOnlyToken = (await api('POST', '/api/login', { username: 'settings-organizer', password: 'OrganizerSettings123' })).token;
  browser = await chromium.launch({ headless: true, executablePath: process.env.STSS_BROWSER_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, locale: 'zh-CN' });
  await context.addInitScript(({ token, event }) => {
    localStorage.setItem('stss_token', token); localStorage.setItem('stss_event', String(event));
  }, { token, event: identity.event_id });
  page = await context.newPage();
  await installLegacyRosterFixture(page);
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const route = async suffix => {
    await page.goto(`${base}/?test_nav=${Date.now()}#/${suffix}`);
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => !document.querySelector('.content .spinner'));
  };
  const registration = category => `legacyRosterTest?event=${identity.event_id}&group=${category.group_id}&category=${category.id}&tab=registration`;
  const setupNav = () => page.getByRole('navigation', { name: '赛事设置导航', exact: true });
  const chosenGroup = () => page.locator('.setup-group-choice[aria-current="true"]');
  const screenshot = async name => {
    await page.waitForFunction(() => !document.querySelector('#toast.show'));
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await page.screenshot({ path: path.join(artifacts, name), fullPage: true });
  };
  const assertBounds = async label => {
    const geometry = await page.evaluate(() => {
      const outside = [...document.querySelectorAll('.content *')].filter(element => {
        if (!element.getClientRects().length || element.closest('.ctx-tabs,.ss-list')) return false;
        // 桌面宽表可以在自己的容器中滚动；窄屏卡片的所有实际内容仍必须在屏幕内。
        if (element.closest('.table-scroll') && (innerWidth > 760 || !element.closest('.roster-scroll,.match-queue-scroll'))) return false;
        if (innerWidth <= 760 && element.closest('.roster-table thead,.scoring-match-table thead')) return false;
        const box = element.getBoundingClientRect();
        return box.width > 0 && (box.right > innerWidth + 1 || box.left < -1);
      }).slice(0, 5).map(element => ({ tag: element.tagName, class: element.className, text: element.textContent.slice(0, 50) }));
      return { width: innerWidth, pageWidth: document.documentElement.scrollWidth, outside };
    });
    assert.ok(geometry.pageWidth <= geometry.width + 1, `${label}: ${JSON.stringify(geometry)}`);
    assert.deepEqual(geometry.outside, [], `${label}: 所有控件在屏幕范围内`);
  };

  // 同页的三个区域同时显示；定位只改变焦点，不发请求或替换未提交表单。
  const eventSection = () => page.locator('#setup-event');
  const structureSection = () => page.locator('#setup-structure');
  const venueSection = () => page.locator('#setup-venues');
  const eventName = () => eventSection().getByLabel('赛事名称');
  const venueName = () => venueSection().getByLabel('场地名称', { exact: true });
  const newGroupForm = () => structureSection().locator('.setup-group-list .setup-add-form');
  const projectRows = () => structureSection().locator('.setup-entity-row');
  const newProjectForm = () => structureSection().locator('.setup-category-list .setup-add-form');
  const openEvent = async () => { if (!await eventName().isVisible()) await eventSection().getByRole('button', { name: '修改资料', exact: true }).click(); };
  const openVenue = async () => { if (!await venueName().isVisible()) await venueSection().getByRole('button', { name: '添加场地', exact: true }).click(); };
  const openProject = async index => { const row = projectRows().nth(index); if (!await row.getByLabel('项目名称').isVisible()) await row.getByRole('button', { name: '修改名称', exact: true }).click(); };
  const openComposer = async () => { if (!await newProjectForm().isVisible()) await structureSection().getByRole('button', { name: '添加项目', exact: true }).click(); };

  const assertAllSettings = async () => {
    for (const section of [eventSection(), structureSection(), venueSection()]) {
      assert.equal(await section.count(), 1);
      assert.equal(await section.isVisible(), true, '三个设置区域始终显示');
    }
  };
  await route('setup');
  await assertAllSettings();
  assert.deepEqual(await setupNav().getByRole('button').evaluateAll(buttons => buttons.map(b => b.getAttribute('aria-label'))), ['赛事资料', '组别与项目', '比赛场地']);
  assert.equal(await page.locator('.wizard-steps').count(), 0);
  assert.equal(await page.getByRole('heading', { name: /第\s*\d+\s*步/ }).count(), 0);
  await openEvent(); await openVenue();
  const initialEventName = await eventName().inputValue();
  const savedEventName = `${initialEventName}（已保存）`;
  await openEvent(); await eventName().fill(savedEventName);
  await openVenue(); await venueName().fill('同页新增第三号场');
  await structureSection().getByRole('button', { name: '添加组别', exact: true }).click();
  await newGroupForm().getByLabel('组别名称').fill('丙组');
  await newGroupForm().getByLabel('组别标识').fill('丙');
  await page.evaluate(() => {
    document.querySelector('#setup-event input').dataset.testIdentity = 'event-kept';
    document.querySelector('#setup-venues input').dataset.testIdentity = 'venue-kept';
  });
  const setupRequests = [];
  const watchSettingsRequests = request => {
    if (request.url().startsWith(`${base}/api/`)) setupRequests.push(request.url());
  };
  page.on('request', watchSettingsRequests);
  const beforeNavUrl = page.url();
  for (const [name, targetId] of [['组别与项目', 'setup-structure'], ['比赛场地', 'setup-venues'], ['赛事资料', 'setup-event']]) {
    await setupNav().getByRole('button', { name, exact: true }).click();
    assert.equal(page.url(), beforeNavUrl, '页内定位不改变地址');
    assert.equal(await page.evaluate(id => document.activeElement?.tagName === 'H3'
      && document.activeElement.closest(`#${id}`) !== null, targetId), true, `${name} 定位到该区域标题`);
    await assertAllSettings();
  }
  assert.deepEqual(setupRequests, [], '页内定位不访问后台');
  page.off('request', watchSettingsRequests);
  assert.equal(await eventName().getAttribute('data-test-identity'), 'event-kept');
  assert.equal(await venueName().getAttribute('data-test-identity'), 'venue-kept');
  await page.locator('.setup-group-choice').filter({ hasText: groupB.name }).click();
  await chosenGroup().filter({ hasText: groupB.name }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0, '左侧新增组别输入不会妨碍切换项目上下文');
  assert.equal(await eventName().inputValue(), savedEventName, '切组保留基本信息输入');
  assert.equal(await venueName().inputValue(), '同页新增第三号场', '切组保留场地输入');
  assert.equal(await newGroupForm().getByLabel('组别名称').inputValue(), '丙组');
  assert.match(page.url(), new RegExp(`group=${groupB.id}`));
  assert.match(await page.locator('.content').innerText(), /本赛事.*所有组别和项目.*共用/);
  const addedVenue = page.waitForResponse(response => response.url().endsWith(`/events/${identity.event_id}/venues`)
    && response.request().method() === 'POST');
  await venueSection().getByRole('button', { name: '确认添加场地', exact: true }).click();
  assert.equal((await addedVenue).ok(), true);
  await venueSection().getByText('同页新增第三号场', { exact: true }).waitFor();
  assert.equal(await eventName().inputValue(), savedEventName, '添加场地不清空赛事名称');
  assert.equal(await eventName().getAttribute('data-test-identity'), 'event-kept', '场地保存不替换基本信息区域');
  await openVenue(); await venueName().fill('另一分区尚未提交的场地');
  const savedEvent = page.waitForResponse(response => response.url().endsWith(`/events/${identity.event_id}`)
    && response.request().method() === 'PUT');
  await openEvent(); await eventSection().getByRole('button', { name: '保存赛事资料', exact: true }).click();
  assert.equal((await savedEvent).ok(), true);
  await page.waitForFunction(name => document.querySelector('#event-line')?.textContent === name, savedEventName);
  assert.equal(await page.locator('#event-select option:checked').innerText(), savedEventName, '保存后顶栏赛事名称同步');
  assert.equal(await venueName().inputValue(), '另一分区尚未提交的场地', '保存基本信息不清空另一分区输入');
  assert.equal(await venueName().getAttribute('data-test-identity'), 'venue-kept');
  assert.equal(await newGroupForm().getByLabel('组别名称').inputValue(), '丙组');
  await openVenue(); await venueName().fill('');
  await newGroupForm().getByLabel('组别名称').fill('');
  await newGroupForm().getByLabel('组别标识').fill('');

  // 原来的设置链接仍进入同页，并定位对应区域及有效组别。
  for (const [step, targetId] of [['event', 'setup-event'], ['venues', 'setup-venues'],
    ['groups', 'setup-structure'], ['categories', 'setup-structure'], ['structure', 'setup-structure']]) {
    await route(`setup?step=${step}&group=${groupB.id}`);
    await assertAllSettings();
    assert.match(await chosenGroup().innerText(), /乙组/);
    assert.equal(await page.evaluate(id => document.activeElement?.tagName === 'H3'
      && document.activeElement.closest(`#${id}`) !== null, targetId), true, `${step} 旧链接定位对应区域`);
  }
  await route('setup?step=categories&group=999999');
  assert.match(await chosenGroup().innerText(), /甲组/, '失效的组别链接回退有效组别');
  await page.locator('.setup-group-choice').filter({ hasText: groupB.name }).click();
  await openProject(1); await projectRows().nth(1).getByLabel('项目名称').fill('个人项目尚未保存');
  await openComposer(); await newProjectForm().getByRole('radio', { name: '女子三人赛', exact: true }).check();
  await newProjectForm().getByLabel('项目名称').fill('女子项目尚未添加');
  await structureSection().getByRole('button', { name: '添加组别', exact: true }).click();
  await newGroupForm().getByLabel('组别名称').fill('丙组');
  await newGroupForm().getByLabel('组别标识').fill('丙');
  await page.getByRole('button', { name: '编辑组别', exact: true }).click();
  const groupEditor = page.locator('.setup-group-editor');
  await groupEditor.getByLabel('组别名称').fill('乙组（已保存）');
  const renamed = page.waitForResponse(response => response.url().endsWith(`/groups/${groupB.id}`)
    && response.request().method() === 'PUT');
  await groupEditor.getByRole('button', { name: '保存组别名称', exact: true }).click();
  assert.equal((await renamed).ok(), true);
  await chosenGroup().filter({ hasText: '乙组（已保存）' }).waitFor();
  assert.equal((await api('GET', `/api/events/${identity.event_id}/structure`)).groups.find(group => group.id === groupB.id).name,
    '乙组（已保存）');
  assert.equal(await projectRows().nth(1).getByLabel('项目名称').inputValue(), '个人项目尚未保存', '修改组别名称不清空项目编辑');
  assert.equal(await newProjectForm().getByLabel('项目名称').inputValue(), '女子项目尚未添加');
  const categoryRow = projectRows().first();
  await openProject(0); await categoryRow.getByLabel('项目名称').fill('男子三人赛（已保存）');
  const renamedCategory = page.waitForResponse(response => response.url().endsWith(`/categories/${groupB.categories[0].id}`)
    && response.request().method() === 'PUT');
  await categoryRow.getByRole('button', { name: '保存名称', exact: true }).click();
  assert.equal((await renamedCategory).ok(), true);
  await projectRows().first().locator('.setup-project-name').filter({ hasText: '男子三人赛（已保存）' }).waitFor();
  await page.waitForFunction(() => document.querySelector('.setup-entity-row input')?.value === '男子三人赛（已保存）');
  assert.equal((await api('GET', `/api/events/${identity.event_id}/structure`)).groups.find(group => group.id === groupB.id).categories[0].name,
    '男子三人赛（已保存）');
  assert.equal(await projectRows().nth(1).getByLabel('项目名称').inputValue(), '个人项目尚未保存', '只保存目标项目，不丢其他项目的编辑');
  assert.equal(await newProjectForm().getByLabel('项目名称').inputValue(), '女子项目尚未添加');
  assert.equal(await newProjectForm().getByRole('radio', { name: '女子三人赛', exact: true }).isChecked(), true);
  assert.equal(await newGroupForm().getByLabel('组别名称').inputValue(), '丙组');

  // 右侧仍有编辑时，新建左侧组别不强制切换；取消切组保留，确认只丢弃目标区。
  const createdGroup = page.waitForResponse(response => response.url().endsWith(`/events/${identity.event_id}/groups`)
    && response.request().method() === 'POST');
  await newGroupForm().getByRole('button', { name: '保存新组别', exact: true }).click();
  assert.equal((await createdGroup).ok(), true);
  await page.locator('.setup-group-choice').filter({ hasText: '丙组' }).waitFor();
  assert.match(await chosenGroup().innerText(), /乙组（已保存）/, '右侧未提交时，新建组别保留当前上下文');
  assert.equal(await projectRows().nth(1).getByLabel('项目名称').inputValue(), '个人项目尚未保存');
  assert.equal(await newProjectForm().getByLabel('项目名称').inputValue(), '女子项目尚未添加');
  await openVenue(); await venueName().fill('切换组别时保留的场地');
  await page.locator('.setup-group-choice').filter({ hasText: groupA.name }).click();
  const switching = page.getByRole('dialog', { name: '切换组别', exact: true });
  await switching.waitFor();
  await switching.getByRole('button', { name: '关闭', exact: true }).click();
  assert.match(await chosenGroup().innerText(), /乙组（已保存）/);
  assert.equal(await projectRows().nth(1).getByLabel('项目名称').inputValue(), '个人项目尚未保存', '取消切组保留原输入');
  assert.equal(await newProjectForm().getByLabel('项目名称').inputValue(), '女子项目尚未添加');
  await page.locator('.setup-group-choice').filter({ hasText: groupA.name }).click();
  await switching.waitFor();
  await switching.getByRole('button', { name: '放弃并切换', exact: true }).click();
  await chosenGroup().filter({ hasText: groupA.name }).waitFor();
  assert.equal(await projectRows().nth(1).getByLabel('项目名称').inputValue(), '男子个人赛', '确认切组只采用新组选中的后台项目');
  assert.equal(await venueName().inputValue(), '切换组别时保留的场地');
  assert.equal(await eventName().inputValue(), savedEventName);
  await openVenue(); await venueName().fill('');
  await page.locator('.setup-group-choice').filter({ hasText: '乙组（已保存）' }).click();
  await chosenGroup().filter({ hasText: '乙组（已保存）' }).waitFor();

  // 真正刷新后，未提交内容不覆盖后端保存的数据。
  await openEvent(); await eventName().fill('刷新时应丢弃的赛事编辑');
  await openVenue(); await venueName().fill('刷新时应丢弃的场地编辑');
  await openProject(0); await projectRows().first().getByLabel('项目名称').fill('刷新时应丢弃的项目编辑');
  await page.reload();
  await openEvent(); await eventName().waitFor();
  assert.equal(await eventName().inputValue(), savedEventName, '刷新从后台读取基本信息，不恢复未提交浏览器输入');
  assert.equal(await venueName().inputValue(), '');
  assert.equal(await projectRows().first().getByLabel('项目名称').inputValue(), '男子三人赛（已保存）');

  for (const width of [2539, 1365, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await assertAllSettings();
    await assertBounds(`统一设置 ${width}`);
    const [eventBox, venueBox, structureBox] = await Promise.all([eventSection().boundingBox(), venueSection().boundingBox(), structureSection().boundingBox()]);
    if (width >= 1365) {
      const headerBox = await page.locator('.setup-page-head').boundingBox();
      assert.ok(headerBox.height < 240, `页首保留足够空间展示设置表单 ${width}: ${headerBox.height}`);
    }
    assert.ok(structureBox.y >= eventBox.y + eventBox.height - 1, `组别项目接在资料后 ${width}`);
    assert.ok(venueBox.y >= structureBox.y + structureBox.height - 1, `场地接在项目后 ${width}`);
    if (width === 2539) {
      const settingsBox = await page.locator('.setup-page').boundingBox();
      const contentBox = await page.locator('.content').boundingBox();
      assert.ok(settingsBox.width <= 1440, `超宽屏表单仍保持易读宽度: ${settingsBox.width}`);
      assert.ok(Math.abs(settingsBox.x + settingsBox.width / 2 - contentBox.x - contentBox.width / 2) < 3,
        '超宽屏设置区域在主内容内居中');
    }
    await screenshot(`setup-unified-${width}.png`);
  }
  await page.setViewportSize({ width: 1365, height: 900 });
  // 另一位管理员删除当前空组别后，重新读取后台必须回到有效组别。
  const externalGroup = (await api('GET', `/api/events/${identity.event_id}/structure`)).groups.find(group => group.name === '丙组');
  await page.locator('.setup-group-choice').filter({ hasText: '丙组' }).click();
  await chosenGroup().filter({ hasText: '丙组' }).waitFor();
  await openVenue(); await venueName().fill('后台删组时保留的场地输入');
  await api('DELETE', `/api/groups/${externalGroup.id}`);
  await openEvent(); await eventSection().getByRole('button', { name: '保存赛事资料', exact: true }).click();
  await chosenGroup().filter({ hasText: groupA.name }).waitFor();
  assert.equal(await page.locator('.setup-group-choice').filter({ hasText: '丙组' }).count(), 0);
  assert.equal(await page.locator('.setup-category-list').getAttribute('aria-label'), `${groupA.name}比赛项目`);
  assert.equal(await venueName().inputValue(), '后台删组时保留的场地输入');
  assert.match(page.url(), new RegExp(`group=${groupA.id}`));
  await openVenue(); await venueName().fill('');
  await page.locator('.setup-group-choice').filter({ hasText: '乙组（已保存）' }).click();
  await chosenGroup().filter({ hasText: '乙组（已保存）' }).waitFor();

  // 新增组别响应延迟期间离开设置页，旧响应不能改动新页面的地址。
  await structureSection().getByRole('button', { name: '添加组别', exact: true }).click();
  await newGroupForm().getByLabel('组别名称').fill('丁组');
  await newGroupForm().getByLabel('组别标识').fill('丁');
  const groupUrl = `${base}/api/events/${identity.event_id}/groups`;
  let releaseGroupResponse, groupRequestArrived;
  const groupArrived = new Promise(resolve => { groupRequestArrived = resolve; });
  const groupRelease = new Promise(resolve => { releaseGroupResponse = resolve; });
  await page.route(groupUrl, async handler => {
    const response = await handler.fetch(); groupRequestArrived();
    await groupRelease; await handler.fulfill({ response });
  });
  await newGroupForm().getByRole('button', { name: '保存新组别', exact: true }).click();
  await groupArrived;
  await page.getByRole('link', { name: '赛事首页', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#setup-structure'));
  const destinationUrl = page.url();
  releaseGroupResponse();
  await page.getByRole('status').filter({ hasText: /组别已添加/ }).waitFor();
  assert.equal(page.url(), destinationUrl, '设置页已离开时，旧响应不能修改新页面地址');
  await page.unroute(groupUrl);
  await route(`setup?step=structure&group=${groupB.id}`);
  await chosenGroup().filter({ hasText: '乙组（已保存）' }).waitFor();
  await projectRows().first().getByRole('button', { name: '进入项目工作台', exact: true }).click();
  await page.getByRole('navigation', { name: '项目工作台导航', exact: true }).waitFor();
  assert.match(page.url(), new RegExp(`group=${groupB.id}.*category=${groupB.categories[0].id}`));
  await route('setup?action=new');
  assert.equal(await page.locator('.wizard-steps > li').count(), 5);
  await page.getByLabel('赛事名称').fill('只测试向导，不创建');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('heading', { name: /第 2 步/ }).waitFor();
  assert.equal((await api('GET', '/api/events')).events.length, 1, '向导未确认前不创建后台赛事');

  // 种子保存只提交一次；失败和原生数字坏输入均恢复后台值。
  await route(registration(team));
  const roster = page.locator('.roster-table');
  await roster.waitFor();
  assert.equal(await roster.locator('thead th').first().innerText(), '参赛学校');
  const target = (await api('GET', `/api/categories/${team.id}/participations`)).participations.find(part => part.school_name === schoolNames[0]);
  const seed = () => page.getByLabel(`种子序号 ${target.subject}`, { exact: true });
  assert.equal(await seed().getAttribute('placeholder'), '未指定');
  assert.equal(await seed().evaluate(input => input.validity.valid), true, '未指定种子不显示无效状态');
  const seedUrl = `${base}/api/participations/${target.id}`;
  const seedRequests = [];
  page.on('request', request => {
    if (request.url() === seedUrl && request.method() === 'PUT') seedRequests.push(request);
  });
  let releaseSavedResponse, arrivedResolve;
  const arrived = new Promise(resolve => { arrivedResolve = resolve; });
  const release = new Promise(resolve => { releaseSavedResponse = resolve; });
  await page.route(seedUrl, async handler => {
    const response = await handler.fetch(); arrivedResolve();
    await release; await handler.fulfill({ response });
  });
  await seed().fill('1'); await seed().press('Enter'); await arrived;
  assert.equal(await seed().evaluate(input => input.readOnly), true, '保存中保持焦点并禁止再次编辑');
  await seed().press('Tab'); releaseSavedResponse();
  await page.getByRole('status').filter({ hasText: /^已保存$/ }).waitFor();
  await page.unroute(seedUrl);
  assert.equal(seedRequests.length, 1, '回车后的失焦不重复提交');
  assert.equal((await api('GET', `/api/categories/${team.id}/participations`)).participations.find(part => part.id === target.id).seed_no, 1);
  await page.reload(); await roster.waitFor();
  assert.equal(await seed().inputValue(), '1', '刷新显示后端保存的种子');
  for (const bad of ['-', '1e']) {
    const requestCount = seedRequests.length;
    await seed().fill(''); await seed().pressSequentially(bad);
    assert.equal(await seed().evaluate(input => input.validity.badInput), true, `${bad} 为真实键盘坏输入`);
    await seed().press('Tab');
    await page.getByRole('status').filter({ hasText: /已恢复后台值/ }).waitFor();
    assert.equal(await seed().inputValue(), '1', `${bad} 不会被当作清空种子`);
    assert.equal(seedRequests.length, requestCount);
    assert.equal(await seed().evaluate(input => input.validity.valid), true);
  }
  await page.route(seedUrl, handler => handler.fulfill({ status: 500, contentType: 'application/json',
    body: JSON.stringify({ message: '模拟保存失败', code: 'test_failure' }) }));
  await seed().fill('2'); await seed().press('Enter');
  await page.getByRole('status').filter({ hasText: /保存失败，已恢复后台(?:读取)?值/ }).waitFor();
  assert.equal(await seed().inputValue(), '1');
  assert.equal(await seed().evaluate(input => input.validity.valid && !input.classList.contains('invalid')), true);
  await page.unroute(seedUrl);
  const freshTarget = (await api('GET', `/api/categories/${team.id}/participations`)).participations.find(part => part.id === target.id);
  await api('PUT', `/api/participations/${target.id}`, { seed_no: 3, base_rev: freshTarget.rev });
  await seed().fill('2'); await seed().press('Enter');
  await page.waitForFunction(label => document.querySelector(`input[aria-label="${label}"]`)?.value === '3', `种子序号 ${target.subject}`);
  assert.equal(await seed().inputValue(), '3', '版本冲突时重新载入最新后台值');

  // 学校与对阵是首要信息；窄屏同一表格转换为卡片，不依靠横向滚动查看操作。
  for (const width of [1365, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await assertBounds(`学校报名 ${width}`);
    if (width > 760) {
      assert.equal(await roster.locator('th.roster-seed').evaluate(element => getComputedStyle(element).textAlign), 'center');
      const center = await roster.locator('tbody tr').filter({ hasText: schoolNames[0] }).locator('td.roster-seed').evaluate(cell => {
        const cellBox = cell.getBoundingClientRect(), inputBox = cell.querySelector('input').getBoundingClientRect();
        return Math.abs((cellBox.left + cellBox.width / 2) - (inputBox.left + inputBox.width / 2));
      });
      assert.ok(center < 2, `种子输入与列标题居中 ${width}`);
    } else {
      assert.ok(await page.locator('.roster-scroll').evaluate(element => element.scrollWidth <= element.clientWidth + 1));
      assert.equal(await roster.locator('tbody tr').first().evaluate(element => getComputedStyle(element).display), 'grid');
    }
    if (width === 320) {
      const session = await context.newCDPSession(page);
      const { nodes } = await session.send('Accessibility.getFullAXTree');
      assert.ok(nodes.some(node => node.role?.value === 'columnheader' && node.name?.value === '种子序号'),
        '卡片布局保留可访问列标题');
      assert.ok(nodes.some(node => node.role?.value === 'spinbutton' && node.name?.value === `种子序号 ${target.subject}`),
        '窄屏种子控件仍通过学校名称区分');
      await session.detach();
    }
    await screenshot(`registration-${width}.png`);
    await route(registration(personal));
    await page.locator('.roster-table').waitFor();
    assert.equal(await page.locator('.roster-table thead th').first().innerText(), '学校');
    await assertBounds(`个人报名 ${width}`);
    await route(registration(team)); await roster.waitFor();
  }
  await page.setViewportSize({ width: 1365, height: 900 });
  const plan = (await scheduleFixture(api, identity, team.id)).plan_id;
  // 浏览器仍持有原来的可编辑页面，在锁定竞态中也必须采用最新后台状态。
  await seed().fill('4'); await seed().press('Enter');
  await page.locator('.seed-readonly').first().waitFor();
  assert.equal(await page.locator('.roster-table input[aria-label^="种子序号"]').count(), 0);
  assert.equal((await api('GET', `/api/categories/${team.id}/participations`)).participations.find(part => part.id === target.id).seed_no, 3);
  await page.reload(); await page.locator('.seed-readonly').first().waitFor();
  assert.match(await page.locator('.content').innerText(), /报名与种子只读/);

  const matches = (await api('GET', `/api/matches?category_id=${team.id}`)).matches;
  assert.equal(matches.length, 6);
  for (const [index, match] of matches.entries()) {
    await api('PUT', `/api/matches/${match.id}`, { venue_id: venueIds[index % 2], scheduled_at: `2026-10-11 ${String(9 + index).padStart(2, '0')}:00` });
  }
  await api('POST', '/api/scoring/submit', { submission_uid: crypto.randomUUID(), match_id: matches[0].id,
    event_identity: identity, base_version: matches[0].result_version,
    plan_version: matches[0].plan_version, home_participation: matches[0].home.participation_id,
    away_participation: matches[0].away.participation_id, device: '界面布局回归', result_status: 'away_forfeit', sets: [], events: [],
  });
  await route('scoring'); await page.locator('.scoring-match-table').waitFor();
  const queueRows = () => page.locator('.scoring-match-table tbody tr');
  assert.equal(await page.locator('.scoring-match-table thead th').count(), 4);
  assert.equal(await queueRows().count(), 6);
  await page.getByLabel('搜索场次', { exact: true }).fill(schoolNames[0]);
  await page.waitForFunction(() => document.querySelectorAll('.scoring-match-table tbody tr').length === 3);
  assert.equal(await queueRows().count(), 3);
  assert.ok((await queueRows().allTextContents()).every(text => text.includes(schoolNames[0])));
  await page.getByLabel('搜索场次', { exact: true }).fill('');
  await page.getByLabel('比赛场地', { exact: true }).selectOption({ label: '体育馆二号场' });
  await page.waitForFunction(() => [...document.querySelectorAll('.scoring-match-table tbody tr')].length === 3
    && [...document.querySelectorAll('.scoring-match-table tbody tr')].every(row => row.textContent.includes('体育馆二号场')));
  assert.equal(await queueRows().count(), 3);
  assert.ok((await queueRows().allTextContents()).every(text => text.includes('体育馆二号场')));
  await page.getByLabel('比赛场地', { exact: true }).selectOption('');
  await page.getByLabel('场次状态', { exact: true }).selectOption('finished');
  await page.waitForFunction(() => document.querySelectorAll('.scoring-match-table tbody tr').length === 1);
  assert.equal(await queueRows().count(), 1);
  assert.equal(await page.getByRole('button', { name: '查看成绩', exact: true }).count(), 1);
  await page.getByLabel('搜索场次', { exact: true }).fill('不存在的学校');
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.scoring-match-table tbody tr').length === 6);
  assert.equal(await page.getByLabel('搜索场次', { exact: true }).inputValue(), '');
  assert.equal(await page.getByLabel('比赛场地', { exact: true }).inputValue(), '');
  assert.equal(await page.getByLabel('场次状态', { exact: true }).inputValue(), '');
  assert.equal(await queueRows().count(), 6);
  for (const width of [1365, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const gap = await page.evaluate(() => document.querySelector('.match-queue-results > h3').getBoundingClientRect().top
      - document.querySelector('.match-queue-filters').getBoundingClientRect().bottom);
    assert.ok(gap >= 20, `筛选区与列表标题间距 ${width}: ${gap}`);
    await assertBounds(`记录队列 ${width}`);
    if (width <= 760) {
      assert.ok(await page.locator('.match-queue-scroll').evaluate(element => element.scrollWidth <= element.clientWidth + 1));
      assert.equal(await queueRows().first().evaluate(element => getComputedStyle(element).display), 'grid');
      const first = queueRows().first();
      assert.equal(await first.locator('.match-queue-opponents').isVisible(), true);
      const button = first.locator('.match-queue-actions button');
      await button.scrollIntoViewIfNeeded();
      const bounds = await button.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, '记录入口完整可见');
    }
    if (width === 320) {
      const session = await context.newCDPSession(page);
      const { nodes } = await session.send('Accessibility.getFullAXTree');
      assert.ok(nodes.some(node => node.role?.value === 'columnheader' && node.name?.value === '比赛对阵'));
      assert.ok(nodes.some(node => node.role?.value === 'button' && node.name?.value === '开始记录'));
      await session.detach();
    }
    await screenshot(`scoring-queue-${width}.png`);
    await route(`setup?step=structure&group=${groupB.id}`);
    await assertBounds(`设置结构 ${width}`);
    await screenshot(`setup-structure-${width}.png`);
    await route('scoring'); await page.locator('.scoring-match-table').waitFor();
  }
  const readOnlyContext = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: 'zh-CN' });
  await readOnlyContext.addInitScript(({ token, event }) => {
    localStorage.setItem('stss_token', token); localStorage.setItem('stss_event', String(event));
  }, { token: readOnlyToken, event: identity.event_id });
  const readOnlyPage = await readOnlyContext.newPage();
  readOnlyPage.setDefaultTimeout(10000);
  readOnlyPage.on('pageerror', error => errors.push(error.message));
  await readOnlyPage.goto(`${base}/#/setup?step=structure&group=${groupB.id}`);
  await readOnlyPage.getByText('赛事结构由管理员维护。', { exact: true }).waitFor();
  for (const id of ['setup-event', 'setup-venues', 'setup-structure']) {
    assert.equal(await readOnlyPage.locator(`#${id}`).isVisible(), true, `只读角色也显示 ${id}`);
  }
  const readOnlyNav = readOnlyPage.getByRole('navigation', { name: '赛事设置导航', exact: true });
  assert.deepEqual(await readOnlyNav.getByRole('button').evaluateAll(buttons => buttons.map(b => b.getAttribute('aria-label'))), ['赛事资料', '组别与项目', '比赛场地']);
  const readOnlyUrl = readOnlyPage.url();
  await readOnlyNav.getByRole('button', { name: '比赛场地', exact: true }).click();
  assert.equal(readOnlyPage.url(), readOnlyUrl, '只读定位同样保留页面与地址');
  assert.equal(await readOnlyPage.locator('.content input,.content select,.content textarea').count(), 0);
  assert.equal(await readOnlyPage.getByRole('button', { name: /保存|添加|删除|新建赛事/ }).count(), 0);
  assert.match(await readOnlyPage.locator('.content').innerText(), /乙组（已保存）/);
  await readOnlyPage.goto(`${base}/#/setup?action=new`);
  await readOnlyPage.getByText('当前角色没有创建赛事的权限。', { exact: true }).waitFor();
  assert.equal(await readOnlyPage.locator('.wizard-steps').count(), 0);
  await readOnlyContext.close();

  // 回归完成后，仅清理隔离服务的场地，检查用户截图中的空场地布局。
  const finalVenues = (await api('GET', `/api/events/${identity.event_id}/venues`)).venues;
  for (const venue of finalVenues) await api('DELETE', `/api/venues/${venue.id}`);
  await route(`setup?group=${groupA.id}`);
  await venueSection().getByText('还没有场地。可以先开设项目，再补充实际场地。', { exact: true }).waitFor();
  for (const width of [2539, 1365, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await assertAllSettings();
    await assertBounds(`空场地设置 ${width}`);
    await screenshot(`setup-empty-venues-${width}.png`);
    if (width === 1365) await page.screenshot({ path: path.join(artifacts, 'setup-empty-1365-viewport.png') });
  }
  assert.deepEqual(errors, []);
  console.log('PASS: 设置同页三区与无请求定位、独立保存及输入保留、切组保护、刷新后台为准、五种设置宽度及超宽居中、精简页首和空场地布局、独立创建向导和只读权限、种子保存/坏输入/失败/冲突/锁定、队列筛选及四种屏幕宽度');
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(artifacts, 'ui-settings-failure.png'), fullPage: true });
    console.error((await page.locator('body').innerText()).slice(0, 3000));
  }
  throw error;
} finally { if (browser) await browser.close(); child.kill(); }

/* 使用独立数据库检查主要页面、报名布局和窄屏溢出；实际赛事不参与测试。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const artifacts = process.env.STSS_BROWSER_ARTIFACTS || path.join(tmpdir(), 'stss-ui-layout-artifacts');
const dataDir = path.join(tmpdir(), `stss-ui-layout-${Date.now()}`);
const auditOnly = process.env.STSS_UI_AUDIT_ONLY === '1';
await mkdir(artifacts, { recursive: true });
const serverCode = `
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
`;
const child = spawn(process.env.STSS_PYTHON || 'python', ['-u', '-c', serverCode], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, STSS_DATA_DIR: dataDir, STSS_DB: path.join(dataDir, 'registry.db'),
    STSS_EVENTS_DIR: path.join(dataDir, 'events'), STSS_ADMIN_PASSWORD: 'LayoutTest123', PYTHONUTF8: '1' },
});
let serverErrors = '', browser;
child.stderr.on('data', chunk => { serverErrors += chunk; });
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(serverErrors || 'Server timeout')), 10000);
    child.once('error', reject);
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      try { const first = JSON.parse(output.split('\n')[0]); clearTimeout(timer); resolve(first.port); } catch {}
    });
  });
  const base = `http://127.0.0.1:${port}`;
  let token = '', event;
  const api = async (method, url, body) => {
    const response = await fetch(base + url, { method,
      headers: { 'Content-Type': 'application/json', 'X-Client-Protocol': '2', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(event ? { 'X-Event-ID': String(event.event_id), 'X-Event-UUID': event.event_uuid } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.ok, true, JSON.stringify(data));
    return data;
  };
  token = (await api('POST', '/api/login', { username: 'admin', password: 'LayoutTest123' })).token;
  event = await api('POST', '/api/events', { name: '首都高校第十八届藤球比赛 · 界面验证', start_date: '2026-10-10' });
  await api('POST', `/api/events/${event.event_id}/bootstrap`, {});
  const structure = await api('GET', `/api/events/${event.event_id}/structure`);
  const schoolNames = [
    ['中国政法大学', '清华大学', '中国人民大学', '北京科技大学', '华北电力大学', '北京林业大学', '中国劳动关系学院'],
    ['北京工业大学', '首都经济贸易大学', '北京建筑大学', '北京工商大学', '北京信息科技大学', '北京石油化工学院', '北京物资学院', '北京联合大学', '北京城市学院'],
    ['北京北大方正软件职业技术学院', '北京交通运输职业学院', '北京经济管理职业技术学院', '北京劳动保障职业学院'],
  ];
  let personNo = 0;
  for (const [index, group] of structure.groups.entries()) {
    await api('PUT', `/api/groups/${group.id}`, { name: ['甲组', '乙组', '丙组'][index] });
    for (const name of schoolNames[index]) {
      const school = await api('POST', `/api/events/${event.event_id}/schools`, { name, group_id: group.id });
      for (const category of group.categories) {
        const person = jersey => ({ name: `匿名人员${String(++personNo).padStart(3, '0')}`, gender: category.gender,
          jersey_no: String(jersey), note: '虚构人员，报名占位' });
        const body = { school_id: school.school_id };
        if (category.kind === 'team') {
          body.members = [person(1), person(2), person(3)]; body.captain_index = 0;
        } else body.athlete = person(1);
        await api('POST', `/api/categories/${category.id}/enrollments${category.kind === 'individual' ? '/individual' : ''}`, body);
      }
    }
  }
  await api('POST', `/api/events/${event.event_id}/venues`, { name: '体育馆一号比赛场地', seq: 1 });
  const schools = (await api('GET', `/api/events/${event.event_id}/schools`)).schools;
  const group = structure.groups[0];
  const team = group.categories.find(c => c.kind === 'team' && c.gender === 'male');
  const individual = group.categories.find(c => c.kind === 'individual' && c.gender === 'male');
  const parts = (await api('GET', `/api/categories/${team.id}/participations`)).participations;
  const match = await api('POST', '/api/matches', {
    category_id: team.id, home_participation: parts[0].id, away_participation: parts[1].id, round_label: '小组赛第一轮',
  });
  browser = await chromium.launch({ headless: true, executablePath: process.env.STSS_BROWSER_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, locale: 'zh-CN' });
  await context.addInitScript(({ token, eventId }) => {
    localStorage.setItem('stss_token', token); localStorage.setItem('stss_event', String(eventId));
  }, { token, eventId: event.event_id });
  const page = await context.newPage(), pageErrors = [], report = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => pageErrors.push(error.message));
  const workspace = (cat, tab) => `workspace?event=${event.event_id}&group=${group.id}&category=${cat.id}&tab=${tab}`;
  const routes = [
    ['schools', 'schoolRegistration'], ['dashboard', 'dashboard'], ['setup-event', 'setup'],
    ['setup-groups', 'setup?step=groups'], ['setup-projects', 'setup?step=categories'], ['setup-venues', 'setup?step=venues'],
    ['event-wizard', 'setup?action=new'], ['workspace-direct', 'workspace'],
    ...['overview', 'registration', 'schedule', 'matches', 'results'].map(tab => [`team-${tab}`, workspace(team, tab)]),
    ...['overview', 'registration', 'entry', 'results'].map(tab => [`individual-${tab}`, workspace(individual, tab)]),
    ['field', 'field'], ['scoring-list', 'scoring'], ['scoring-console', `scoring?match=${match.match_id}`],
    ['review', 'review'], ['school-totals', 'school'], ['admin', 'admin'], ['users', 'users'], ['account', 'account'],
    ['school-projects', `schoolRegistration?event=${event.event_id}&school=${schools[0].id}`],
  ];
  const navigate = async route => {
    if (route === 'workspace') await page.evaluate(eventId => localStorage.removeItem(`stss_workspace_last:admin:${eventId}`), event.event_id);
    await page.goto(`${base}/#/${route}`);
    await page.waitForLoadState('networkidle');
    await page.locator('.content').getByRole('heading').first().waitFor();
    await page.waitForFunction(() => !document.querySelector('.content .spinner'));
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const audit = async (name, width) => {
    const geometry = await page.evaluate(() => {
      const viewport = innerWidth;
      const outside = [...document.querySelectorAll('.content *')].filter(el => {
        if (el.closest('.table-scroll,.ss-list,.bk-canvas,.bracket,.ctx-tabs')) return false;
        if (!el.getClientRects().length) return false;
        const box = el.getBoundingClientRect();
        return box.width > 0 && (box.right > viewport + 1 || box.left < -1);
      }).slice(0, 5).map(el => ({ tag: el.tagName, class: el.className, text: el.textContent.slice(0, 45) }));
      return { viewport, pageWidth: document.documentElement.scrollWidth, outside };
    });
    report.push({ name, width, ...geometry });
  };
  const snapshots = new Set(['schools', 'dashboard', 'setup-projects', 'team-registration', 'team-schedule',
    'individual-entry', 'school-totals', 'users', 'school-projects', 'scoring-console']);
  for (const viewport of [{ width: 1365, height: 900 }, { width: 900, height: 1024 }, { width: 390, height: 844 },
    { width: 320, height: 568 }, { width: 2539, height: 1081 }]) {
    await page.setViewportSize(viewport);
    for (const [name, route] of routes) {
      await navigate(route);
      assert.equal(await page.getByRole('button', { name: /保存.*草稿|读取.*草稿|清除.*草稿|导出未提交记录|导入记录/ }).count(), 0, `${name} 不应有草稿操作入口`);
      if ((snapshots.has(name) && [1365, 390].includes(viewport.width)) || (name === 'schools' && viewport.width === 2539)) {
        await page.screenshot({ path: path.join(artifacts, `${name}-${viewport.width}.png`), fullPage: true });
      }
      await audit(name, viewport.width);
      if (!auditOnly && name === 'school-totals' && viewport.width === 390) {
        const totals = page.locator('.table-scroll').first();
        assert.ok(await totals.evaluate(el => el.scrollWidth > el.clientWidth), '宽表格在自己的容器内滚动');
        await totals.evaluate(el => { el.scrollLeft = 180; });
        assert.ok(await totals.evaluate(el => el.scrollLeft > 0), '总分表可横向查看后面的列');
      }
    }
    await page.getByRole('tab', { name: '人员名单', exact: true }).click();
    await audit('school-people', viewport.width);
    if ([1365, 390].includes(viewport.width)) await page.screenshot({ path: path.join(artifacts, `school-people-${viewport.width}.png`), fullPage: true });
    await navigate('schoolRegistration');
    await page.getByRole('button', { name: '新增学校', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    const box = await dialog.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, '新增学校弹窗位于屏幕内');
    if (!auditOnly) {
      const fields = dialog.locator('label.field');
      const firstField = await fields.nth(0).boundingBox(), secondField = await fields.nth(1).boundingBox();
      assert.ok(secondField.y - firstField.y - firstField.height >= 14, '弹窗字段之间留出间距');
    }
    await dialog.screenshot({ path: path.join(artifacts, `school-dialog-${viewport.width}.png`) });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
  }
  await writeFile(path.join(artifacts, 'layout-report.json'), JSON.stringify({ pageErrors, pages: report }, null, 2));
  const overflowing = report.filter(row => row.pageWidth > row.viewport + 1 || row.outside.length);
  if (auditOnly) {
    console.log(JSON.stringify({ pages: report.length, pageErrors, overflowing }, null, 2));
  } else {
    assert.deepEqual(pageErrors, [], '页面没有脚本错误');
    assert.deepEqual(overflowing, [], '主要页面不能出现整页横向溢出或控件越界');
    await page.setViewportSize({ width: 1365, height: 900 });
    await navigate('schoolRegistration');
    const cards = page.locator('.school-registration-school');
    await page.waitForFunction(() => document.querySelectorAll('.school-registration-school').length === 7);
    assert.equal(await cards.count(), 7, '默认只显示当前组别');
    const selector = page.getByLabel('大组别', { exact: true });
    assert.equal(await selector.count(), 1, '工作台只保留一处组别选择');
    const addBox = await page.getByRole('button', { name: '新增学校', exact: true }).boundingBox();
    const first = await cards.first().boundingBox();
    assert.ok(first.y - addBox.y - addBox.height >= 16, '操作与学校卡片留出间距');
    assert.ok((await cards.first().textContent()).includes('8 位人员'));
    await selector.selectOption(String(structure.groups[1].id));
    await page.waitForFunction(() => document.querySelectorAll('.school-registration-school').length === 9);
    assert.equal(await cards.count(), 9, '组别切换进入该组学校列表');
    await cards.first().click();
    await page.getByRole('tab', { name: '人员名单', exact: true }).waitFor();
    console.log(`PASS: ${report.length} 个页面与尺寸组合、学校筛选与进入、弹窗边界、工具栏间距和卡片信息；无脚本错误或整页横向溢出`);
  }
} finally {
  if (browser) await browser.close();
  child.kill();
}

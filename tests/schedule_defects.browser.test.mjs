/* Exact regressions for complete event creation and purpose-specific schedule fields. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scheduleFixture } from './helpers/schedule_fixture.mjs';
const { chromium } = createRequire(import.meta.url)(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const data = await mkdtemp(path.join(tmpdir(), 'schedule-defects-'));
const artifacts = process.env.STSS_BROWSER_ARTIFACTS || path.join(data, 'artifacts');
await mkdir(artifacts, { recursive: true });
const phase = process.env.STSS_DEFECT_PHASE || 'browser';
const child = spawn(process.env.STSS_PYTHON || 'python', ['-B', '-u', '-c', `
import json
from app import db,security
from app.http_server import Handler,load_routes,create_server
db.init_db(); db.init_db()
c=db.connect(); security.ensure_default_users(c); c.close(); load_routes()
class Quiet(Handler):
    def log_message(self,*args): pass
s=create_server(('127.0.0.1',0),Quiet)
print(json.dumps({'port':s.server_port}),flush=True); s.serve_forever()
`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
  STSS_DATA_DIR: data, STSS_DB: path.join(data, 'registry.db'), STSS_EVENTS_DIR: path.join(data, 'events'),
  STSS_ADMIN_PASSWORD: 'DefectTest123', PYTHONUTF8: '1' } });
let browser, serverErrors = '', token = '', identity, page;
const checks = [], failures = [], pageErrors = [], structureReads = [];
child.stderr.on('data', c => { serverErrors += c; });
const check = async (name, action) => {
  try { await action(); checks.push(name); console.log('PASS ' + name); }
  catch (e) { failures.push({ name, message: e.message }); console.error('FAIL ' + name + ': ' + e.message);
    await page?.screenshot({ path: path.join(artifacts, `failure-${failures.length}.png`), fullPage: true }); }
};
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(serverErrors || 'Startup timeout')), 10000);
    child.once('error', reject); child.once('exit', code => reject(new Error(`Server ${code}: ${serverErrors}`)));
    let text = ''; child.stdout.on('data', c => { text += c; try { const r = JSON.parse(text.split('\n')[0]); clearTimeout(timer); resolve(r.port); } catch {} });
  });
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Client-Protocol': '2',
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(identity ? { 'X-Event-ID': String(identity.event_id), 'X-Event-UUID': identity.event_uuid } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  };
  token = (await api('POST', '/api/login', { username: 'admin', password: 'DefectTest123' })).token;
  browser = await chromium.launch({ headless: true, executablePath: process.env.STSS_BROWSER_PATH });
  const context = await browser.newContext({ viewport: { width: 1365, height: 1000 }, locale: 'zh-CN', serviceWorkers: 'block' });
  await context.addInitScript(token => localStorage.setItem('stss_token', token), token);
  page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('request', r => { if (/\/api\/events\/\d+\/structure$/.test(r.url())) structureReads.push({ path: new URL(r.url()).pathname,
    event: r.headers()['x-event-id'] || null, uuid: r.headers()['x-event-uuid'] || null }); });
  const eventBody = name => ({ event: { name }, groups: [{ name: name + '组别', code: 'G',
    categories: [{ name: '男子三人赛', kind: 'team', gender: 'male' }] }], venues: [] });
  const useEvent = async event => {
    identity = { event_id: event.event_id, event_uuid: event.event_uuid, deployment_id: (await api('GET', '/api/events')).deployment_id };
    return api('GET', `/api/events/${event.event_id}/structure`);
  };
  const workspace = (event, group, cat, tab = 'overview') => `${base}/#/workspace?event=${event}&group=${group}&category=${cat}&tab=${tab}`;
  const next = () => page.getByRole('button', { name: '下一步', exact: true }).click();
  const fillWizard = async name => {
    await page.locator('#btn-new-event').click();
    await page.getByLabel('赛事名称', { exact: false }).fill(name); await next();
    await page.getByRole('button', { name: '添加组别', exact: true }).click();
    await page.getByLabel('组别名称', { exact: false }).fill(name + '组别'); await next();
    await page.getByRole('button', { name: '添加比赛项目', exact: true }).click();
    await page.getByLabel('项目名称', { exact: false }).fill('男子三人赛');
    await page.getByLabel('性别', { exact: false }).selectOption('male');
    await page.getByLabel('项目类型', { exact: false }).selectOption('team'); await next(); await next();
    await page.getByRole('heading', { name: '第 5 步 · 确认创建', exact: true }).waitFor();
  };
  const createWizard = async name => {
    await fillWizard(name);
    const response = page.waitForResponse(r => r.url().endsWith('/api/events/full') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '确认并创建赛事', exact: true }).click();
    return (await response).json();
  };
  const assertLanding = async event => {
    await page.waitForFunction(() => document.querySelector('.ctx-bar')
      || document.querySelector('.wizard-error:not(.hidden)') && !document.querySelector('.wizard-actions .btn-primary')?.disabled
      || [...document.querySelectorAll('h3')].some(e => e.textContent === '页面加载失败'));
    assert.equal(await page.locator('.ctx-bar').isVisible(), true, 'new event must land in its valid workspace');
    assert.equal(await page.locator('#event-select').inputValue(), String(event.event_id));
    assert.ok(page.url().includes(`event=${event.event_id}`));
    const reads = structureReads.filter(r => r.path === `/api/events/${event.event_id}/structure`);
    assert.ok(reads.length); assert.ok(reads.every(r => r.event === String(event.event_id) && r.uuid === event.event_uuid), JSON.stringify(reads));
  };
  let first;
  if (phase !== 'fields') {
    await page.goto(base);
    await page.getByRole('button', { name: '开始创建赛事', exact: true }).waitFor();
    await check('完整创建首个赛事直接进入新赛事工作台', async () => {
      first = await createWizard('首次创建回归'); await assertLanding(first);
      await page.reload(); await page.locator('.ctx-bar').waitFor();
      assert.equal(await page.locator('#event-select').inputValue(), String(first.event_id));
    });
    if (phase !== 'repro' && first) {
      const structure = await useEvent(first); const group = structure.groups[0], cat = group.categories[0];
      await page.goto(workspace(first.event_id, group.id, cat.id)); await page.locator('.ctx-bar').waitFor();
      await check('已有赛事下创建第二赛事、刷新和切换无串项目', async () => {
        const second = await createWizard('第二赛事回归'); await assertLanding(second);
        await page.reload(); await page.locator('.ctx-bar').waitFor();
        await page.locator('#event-select').selectOption(String(first.event_id));
        await page.waitForFunction(id => document.querySelector('.ctx-path')?.textContent.includes('首次创建回归')
          && document.querySelector('#event-select')?.value === String(id), first.event_id);
        await page.locator('#event-select').selectOption(String(second.event_id));
        await page.waitForFunction(() => document.querySelector('.ctx-path')?.textContent.includes('第二赛事回归'));
      });
      await check('创建成功后结构读取失败只重试进入，不重复POST', async () => {
        await fillWizard('读取重试赛事');
        let count = 0, block = true, created;
        const watch = r => { if (r.url().endsWith('/api/events/full') && r.method() === 'POST') count++; };
        page.on('request', watch);
        const gate = async route => block ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '测试结构读取暂不可用', outcome: 'not_committed' }) }) : route.continue();
        await page.route('**/api/events/*/structure', gate);
        const response = page.waitForResponse(r => r.url().endsWith('/api/events/full') && r.request().method() === 'POST');
        await page.getByRole('button', { name: '确认并创建赛事', exact: true }).click(); created = await (await response).json();
        await page.getByRole('button', { name: '重试进入工作台', exact: true }).waitFor();
        assert.ok((await page.locator('.wizard-error').textContent()).includes('赛事已创建'));
        block = false; await page.getByRole('button', { name: '重试进入工作台', exact: true }).click();
        await assertLanding(created); assert.equal(count, 1); page.off('request', watch); await page.unroute('**/api/events/*/structure', gate);
      });
      await check('非法项目深链接仍拒绝', async () => {
        await page.goto(workspace(first.event_id, group.id, 987654321));
        await page.getByRole('heading', { name: '页面加载失败', exact: true }).waitFor();
        assert.ok((await page.locator('#content').textContent()).includes('链接中的项目不属于当前赛事'));
      });
      await check('创建成功响应迟到时不把已离开的页面切回', async () => {
        await page.goto(workspace(first.event_id, group.id, cat.id)); await page.locator('.ctx-bar').waitFor();
        await fillWizard('迟到创建回归');
        let arrived, release, delivered;
        const ready = new Promise(r => { arrived = r; }), held = new Promise(r => { release = r; });
        const done = new Promise(r => { delivered = r; });
        const gate = async route => { const response = await route.fetch(); arrived(); await held;
          await route.fulfill({ response }).catch(() => {}); delivered(); };
        await page.route('**/api/events/full', gate);
        await page.getByRole('button', { name: '确认并创建赛事', exact: true }).click(); await ready;
        await page.locator('.sidenav a[data-view="dashboard"]').click();
        await page.waitForFunction(() => location.hash === '#/dashboard');
        const target = page.url(); release(); await done;
        await page.waitForLoadState('networkidle');
        assert.equal(page.url(), target); assert.equal(await page.locator('.event-wizard').count(), 0);
        await page.unroute('**/api/events/full', gate);
      });
      await check('旧赛事结构迟到读取不覆盖新导航', async () => {
        await page.goto(workspace(first.event_id, group.id, cat.id)); await page.reload(); await page.locator('.ctx-bar').waitFor();
        const others = (await api('GET', '/api/events')).events.filter(e => e.id !== first.event_id);
        const target = others[0];
        let arrived, release, delivered;
        const ready = new Promise(r => { arrived = r; }), held = new Promise(r => { release = r; });
        const done = new Promise(r => { delivered = r; });
        const pattern = `**/api/events/${target.id}/structure`;
        const gate = async route => { const response = await route.fetch(); arrived(); await held;
          await route.fulfill({ response }).catch(() => {}); delivered(); };
        await page.route(pattern, gate);
        await page.locator('#event-select').selectOption(String(target.id)); await ready;
        await page.locator('.sidenav a[data-view="dashboard"]').click();
        await page.waitForFunction(() => location.hash === '#/dashboard');
        const current = page.url(); release(); await done; await page.waitForLoadState('networkidle');
        assert.equal(page.url(), current); assert.equal(await page.getByRole('heading', { name: '页面加载失败', exact: true }).count(), 0);
        await page.unroute(pattern, gate);
      });
    }
  }
  if (phase !== 'events') {
    const fixtures = new Map();
    const fixture = async count => {
      if (fixtures.has(count)) return fixtures.get(count);
      const event = await api('POST', '/api/events/full', eventBody(`${count}组设置回归`));
      const structure = await useEvent(event), group = structure.groups[0], cat = group.categories[0];
      if (count) {
        for (let i = 1; i <= Math.max(4, count * 4); i++) {
          const school = await api('POST', `/api/events/${event.event_id}/schools`, { group_id: group.id, name: `${count}组第${i}校` });
          const team = await api('POST', `/api/categories/${cat.id}/teams`, { school_id: school.school_id, name: '代表队' });
          await api('POST', `/api/categories/${cat.id}/participations`, { team_id: team.team_id, seed_no: i });
        }
        await scheduleFixture(api, identity, cat.id, { groupCount: count });
      }
      const result = { event, group, cat }; fixtures.set(count, result); return result;
    };
    const openSettings = async count => {
      const f = await fixture(count);
      await page.goto(workspace(f.event.event_id, f.group.id, f.cat.id, 'schedule').replace('/#/', `/?fixture=${count}#/`));
      // Fixtures created through the API must be loaded into the shell event list.
      await page.reload();
      await page.getByRole('heading', { name: '比赛赛程', exact: true }).waitFor();
      await page.getByRole('button', { name: '设置后续赛程', exact: true }).click();
      return { ...f, dialog: page.getByRole('dialog', { name: '设置后续赛程', exact: true }) };
    };
    await check('淘汰赛实际隐藏第三/第四名和名次范围', async () => {
      const { dialog } = await openSettings(4);
      for (const label of ['来源名次', '起始名次', '结束名次']) assert.equal(await dialog.getByLabel(label, { exact: false }).isVisible(), false, label + ' must be visually hidden');
      assert.equal(await dialog.getByRole('checkbox').count(), 0, 'knockout has all groups, not selectable subsets');
      assert.ok((await dialog.textContent()).includes('第1—4名'));
    });
    // Additional exact behavior and responsive checks run after the initial red evidence.
    if (phase !== 'repro') {
      await page.reload();
      for (const count of [0, 1, 2, 4]) await check(`${count}组：用途切换、前置条件和真实布局`, async () => {
        const { dialog } = await openSettings(count);
        const purpose = dialog.getByLabel('阶段用途', { exact: false });
        for (const value of ['placement', 'knockout', 'manual', 'placement', 'knockout']) {
          await purpose.selectOption(value);
          const placement = value === 'placement';
          for (const label of ['来源名次', '起始名次', '结束名次']) {
            const control = dialog.getByLabel(label, { exact: false });
            assert.equal(await control.isVisible(), placement); assert.equal(await control.isDisabled(), !placement);
          }
          assert.equal(await dialog.getByRole('button', { name: '保存并预览', exact: true }).isDisabled(), value !== 'manual' && count < 2);
          const rendered = await dialog.locator('input,select').evaluateAll(es => es.filter(e => e.getClientRects().length).map(e => e.dataset.field));
          if (!placement) assert.ok(!rendered.some(f => ['source_rank', 'rank_from', 'rank_to'].includes(f)));
        }
        for (const value of ['knockout', 'placement', 'manual']) {
          await purpose.selectOption(value);
          for (const width of [320, 390, 768, 1365]) {
            await page.setViewportSize({ width, height: 1000 });
            const size = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
            assert.ok(size.scroll <= width + 1, JSON.stringify(size));
            const outside = await dialog.locator('input,select,button').evaluateAll(es => es.filter(e => e.getClientRects().length).filter(e => {
              const r = e.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1;
            }).map(e => e.dataset.field || e.textContent));
            assert.deepEqual(outside, []);
            await page.screenshot({ path: path.join(artifacts, `actual-${count}-${value}-${width}.png`), fullPage: true });
          }
        }
        await page.setViewportSize({ width: 1365, height: 1000 });
        // Cancel after changing a purpose must preserve the existing leave guard.
        await dialog.getByRole('button', { name: '取消', exact: true }).click();
        const discard = page.getByRole('dialog', { name: '有未保存的修改', exact: true });
        if (await discard.isVisible()) await discard.getByRole('button', { name: '放弃修改', exact: true }).click();
      });
      for (const count of [2, 4]) await check(`${count}组：用途载荷、用户范围、保存预览与编辑一致`, async () => {
        const { dialog, event, cat } = await openSettings(count);
        const purpose = dialog.getByLabel('阶段用途', { exact: false });
        await purpose.selectOption('placement');
        const rankFrom = count === 2 ? 5 : 9, rankTo = rankFrom + count - 1;
        await dialog.getByLabel('起始名次', { exact: false }).fill(String(rankFrom));
        await dialog.getByLabel('结束名次', { exact: false }).fill(String(rankTo));
        await purpose.selectOption('knockout');
        await dialog.getByLabel('起始名次', { exact: false }).evaluate(el => el.focus());
        assert.notEqual(await page.evaluate(() => document.activeElement?.dataset.field), 'rank_from');
        await purpose.selectOption('manual'); await purpose.selectOption('placement');
        assert.equal(await dialog.getByLabel('起始名次', { exact: false }).inputValue(), String(rankFrom));
        assert.equal(await dialog.getByLabel('结束名次', { exact: false }).inputValue(), String(rankTo));
        await dialog.getByLabel('阶段名称', { exact: false }).fill(`${count}组自主名次`);
        let writes = 0;
        const endpoint = `/api/categories/${cat.id}/schedule/stages`;
        const watch = r => { if (r.url().endsWith(endpoint) && r.method() === 'POST') writes++; };
        page.on('request', watch);
        await dialog.getByLabel('结束名次', { exact: false }).fill(String(rankTo + 1));
        await dialog.getByRole('button', { name: '保存并预览', exact: true }).click();
        await dialog.locator('.form-errors:not(.hidden)').waitFor(); assert.equal(writes, 0);
        await dialog.getByLabel('结束名次', { exact: false }).fill(String(rankTo));
        if (count === 4) {
          await dialog.getByRole('checkbox', { name: 'B组', exact: true }).uncheck();
          await dialog.getByRole('button', { name: '保存并预览', exact: true }).click();
          await dialog.getByText('请成对选择相邻小组，例如A/B或C/D', { exact: true }).waitFor(); assert.equal(writes, 0);
          await dialog.getByRole('checkbox', { name: 'B组', exact: true }).check();
        }
        const request = page.waitForRequest(r => r.url().endsWith(endpoint) && r.method() === 'POST');
        await dialog.getByRole('button', { name: '保存并预览', exact: true }).click();
        const payload = (await request).postDataJSON();
        assert.equal(payload.definition.purpose, 'placement'); assert.equal(payload.definition.source_rank, 3);
        assert.equal(payload.definition.rank_from, rankFrom); assert.equal(payload.definition.rank_to, rankTo);
        assert.equal(payload.definition.pool_ids.length, count);
        let preview = page.getByRole('dialog', { name: `核对阶段 · ${count}组自主名次`, exact: true });
        await preview.waitFor(); assert.ok((await preview.textContent()).includes(`本阶段决出第${rankFrom}—${rankTo}名`));
        assert.ok((await preview.textContent()).includes('A组第3名 对 B组第3名'));
        await preview.getByRole('button', { name: '取消', exact: true }).click(); page.off('request', watch);
        await page.getByRole('button', { name: '编辑设置', exact: true }).click();
        const editor = page.getByRole('dialog', { name: '编辑阶段设置', exact: true });
        assert.equal(await editor.getByLabel('起始名次', { exact: false }).inputValue(), String(rankFrom));
        await editor.getByLabel('阶段名称', { exact: false }).fill('取消离页仍保留');
        const original = page.url();
        // Browser/address navigation is possible while a modal covers the
        // sidebar; do not click through the intentionally blocking backdrop.
        await page.evaluate(() => { location.hash = '#/dashboard'; });
        const leave = page.getByRole('dialog', { name: '有未保存的修改', exact: true }); await leave.waitFor();
        await leave.getByRole('button', { name: '继续编辑', exact: true }).click();
        assert.equal(page.url(), original); assert.equal(await editor.getByLabel('阶段名称', { exact: false }).inputValue(), '取消离页仍保留');
        await editor.getByRole('button', { name: '取消', exact: true }).click();
        await page.getByRole('dialog', { name: '有未保存的修改', exact: true }).getByRole('button', { name: '放弃修改', exact: true }).click();
        await page.getByRole('button', { name: '设置后续赛程', exact: true }).click();
        const knockout = page.getByRole('dialog', { name: '设置后续赛程', exact: true });
        const knockoutRequest = page.waitForRequest(r => r.url().endsWith(endpoint) && r.method() === 'POST');
        await knockout.getByRole('button', { name: '保存并预览', exact: true }).click();
        const definition = (await knockoutRequest).postDataJSON().definition;
        assert.equal(definition.purpose, 'knockout'); assert.equal(definition.pool_ids.length, count);
        for (const field of ['source_rank', 'rank_from', 'rank_to']) assert.equal(field in definition, false);
        preview = page.getByRole('dialog', { name: '核对阶段 · 淘汰赛', exact: true }); await preview.waitFor();
        assert.ok((await preview.textContent()).includes('A组第1名 对 B组第1名'));
        assert.ok((await preview.textContent()).includes('胜者第1名，负者第2名'));
        assert.ok((await preview.textContent()).includes('胜者第3名，负者第4名'));
        await preview.getByRole('button', { name: '取消', exact: true }).click();
      });
      await check('赛程排列方式刷新后保持在地址指定位置', async () => {
        const { dialog } = await openSettings(2);
        await dialog.getByRole('button', { name: '取消', exact: true }).click();
        await page.getByLabel('排列方式', { exact: false }).selectOption('schedule');
        await page.waitForFunction(() => location.hash.includes('sort=schedule'));
        const original = page.url(); await page.reload();
        await page.getByLabel('排列方式', { exact: false }).waitFor();
        assert.equal(await page.getByLabel('排列方式', { exact: false }).inputValue(), 'schedule');
        assert.equal(page.url(), original);
      });
      for (const count of [0, 1]) await check(`${count}组仍可建立手工阶段，载荷不含来源或名次`, async () => {
        const { dialog, cat } = await openSettings(count);
        await dialog.getByLabel('阶段用途', { exact: false }).selectOption('manual');
        const request = page.waitForRequest(r => r.url().endsWith(`/api/categories/${cat.id}/schedule/stages`) && r.method() === 'POST');
        await dialog.getByRole('button', { name: '保存并预览', exact: true }).click();
        assert.deepEqual((await request).postDataJSON().definition, { purpose: 'manual', name: '手工比赛' });
        const preview = page.getByRole('dialog', { name: '核对阶段 · 手工比赛', exact: true }); await preview.waitFor();
        await preview.getByRole('button', { name: '取消', exact: true }).click();
      });
    }
  }
  assert.deepEqual(pageErrors, []);
} finally {
  await writeFile(path.join(artifacts, 'schedule-defects-report.json'), JSON.stringify({ checks, failures, structureReads, pageErrors }, null, 2));
  if (browser) await browser.close(); child.kill();
}
assert.deepEqual(failures, [], 'Exact UI regressions must all pass');

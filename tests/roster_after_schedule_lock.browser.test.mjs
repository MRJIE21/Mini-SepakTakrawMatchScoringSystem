import { scheduleFixture } from './helpers/schedule_fixture.mjs';
/* Real HTTP + browser; isolated test databases, never the running event. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const artifacts = process.env.STSS_BROWSER_ARTIFACTS || path.join(tmpdir(), 'stss-roster-lock-artifacts');
const dataDir = path.join(tmpdir(), `stss-roster-lock-data-${Date.now()}`);
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
`], {
  cwd: root,
  env: { ...process.env, STSS_DATA_DIR: dataDir, STSS_DB: path.join(dataDir, 'registry.db'),
    STSS_EVENTS_DIR: path.join(dataDir, 'events'), STSS_ADMIN_PASSWORD: 'BrowserTest123', PYTHONUTF8: '1' },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let serverErrors = '', browser;
child.stderr.on('data', chunk => { serverErrors += chunk; });
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server timeout: ${serverErrors}`)), 10000);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Server exited ${code}: ${serverErrors}`)));
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      try { const data = JSON.parse(output.split('\n')[0]); clearTimeout(timer); resolve(data.port); } catch {}
    });
  });
  const base = `http://127.0.0.1:${port}`;
  let token = '', identity;
  const api = async (method, url, body) => {
    const response = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', 'X-Client-Protocol': '2', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(identity ? { 'X-Event-ID': String(identity.event_id), 'X-Event-UUID': identity.event_uuid } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    assert.equal(response.ok, true, JSON.stringify(data));
    return data;
  };
  token = (await api('POST', '/api/login', { username: 'admin', password: 'BrowserTest123' })).token;
  identity = await api('POST', '/api/events', { name: '确认赛程后补录人员回归' });
  await api('POST', `/api/events/${identity.event_id}/bootstrap`, {});
  const group = (await api('GET', `/api/events/${identity.event_id}/structure`)).groups[0];
  const category = group.categories.find(c => c.gender === 'male' && c.kind === 'team');
  for (const name of ['待补录大学', '对手大学', '其他大学']) {
    await api('POST', `/api/categories/${category.id}/enrollments`, {
      school: { name }, members: [1, 2, 3].map(i => ({ name: `${name}队员${i}`, gender: 'male', jersey_no: String(i), is_captain: i === 1 })),
    });
  }
  const school = (await api('GET', `/api/events/${identity.event_id}/schools`)).schools.find(s => s.name === '待补录大学');
  const drawPath = `/api/categories/${category.id}/group-draw`;
  let draw = (await api('POST', drawPath, { method: 'random', capacities: [3],
    roster_hash: (await api('GET', drawPath)).roster_hash, request_uid: crypto.randomUUID() })).draw;
  for (const action of ['complete', 'confirm']) draw = (await api('POST', `${drawPath}/${action}`, {
    draw_id: draw.id, base_rev: draw.rev, request_uid: crypto.randomUUID(),
  })).draw;
  const plan = (await scheduleFixture(api, identity, category.id, { drawId: draw.id })).plan_id;
  const before = await api('GET', `/api/plans/${plan}`);
  const formal = await api('GET', `/api/schools/${school.id}/registration-workspace`);
  const entry = formal.projects.find(p => p.category_id === category.id);
  browser = await chromium.launch({ executablePath: process.env.STSS_BROWSER_PATH, headless: true });
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
  await context.addInitScript(({ token, event }) => {
    localStorage.setItem('stss_token', token); localStorage.setItem('stss_event', String(event));
  }, { token, event: identity.event_id });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/#/schoolRegistration?event=${identity.event_id}&school=${school.id}`);
  await page.getByRole('heading', { name: school.name, exact: true }).waitFor();
  assert.deepEqual(errors, [], 'registration rendering errors');
  assert.equal(await page.locator('[data-category]').count(), 1, await page.locator('body').innerText());
  assert.equal(await page.locator('.school-registration-catalog button').count(),group.categories.length);
  const card = () => page.locator(`[data-category="${category.id}"]`);
  const submit = () => page.locator('[data-action="school-preview"]');
  const people = async () => (await api('GET', `/api/schools/${school.id}/athletes`)).athletes;
  assert.equal(await card().getByLabel('参赛选择').isDisabled(), true);
  assert.equal(await card().getByLabel('种子序号', { exact: true }).isDisabled(), true);
  assert.equal(await card().getByLabel(`${category.name}选人`, { exact: true }).isEnabled(), true);
  await card().getByText('＋ 就地新增人员', { exact: true }).click();
  await card().getByLabel('新增人员姓名', { exact: true }).fill('赛前新替补');
  await card().getByLabel('新增人员常用号码', { exact: true }).fill('4');
  await card().getByRole('button', { name: '添加人员并加入本项目', exact: true }).click();
  assert.equal((await people()).length, 3, 'editing is not yet a saved registration');
  const addedKey = await card().getByLabel('队长').locator('option').filter({ hasText: '赛前新替补' }).getAttribute('value');
  await card().getByLabel('队长').selectOption(addedKey);
  for (const width of [1365, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(artifacts, `locked-roster-editable-${width}.png`), fullPage: true });
  }
  await submit().click(); await page.getByRole('button', { name: '确认整批提交', exact: true }).waitFor();
  assert.equal((await people()).length, 3, 'preview must not persist');
  await submit().click(); await page.getByRole('button', { name: '预览整批变更', exact: true }).waitFor();
  const saved = await api('GET', `/api/schools/${school.id}/registration-workspace`);
  const savedEntry = saved.projects.find(p => p.category_id === category.id);
  assert.equal((await people()).length, 4);
  assert.equal(savedEntry.members.length, 4);
  assert.equal(savedEntry.participation_id, entry.participation_id);
  assert.equal(saved.people.find(p => p.key === savedEntry.captain_key).name, '赛前新替补');
  assert.deepEqual(await api('GET', `/api/plans/${plan}`), before, 'roster edit must preserve the schedule');
  assert.deepEqual((await api('GET', drawPath)).draw, draw, 'roster edit must preserve the confirmed draw');
  await page.reload();
  await card().locator('.school-registration-member strong').filter({ hasText: '赛前新替补' }).waitFor();
  const match = (await api('GET', `/api/matches?category_id=${category.id}`)).matches.find(m => [m.home.participation_id, m.away.participation_id].includes(entry.participation_id));
  assert.ok(match, 'the saved entrant must still have scheduled matches');
  await api('POST', `/api/recording/match/${match.id}/claim`, {});
  await page.reload();
  await card().getByText(/该校场次已领取记录/).waitFor();
  assert.equal(await card().getByLabel(`${category.name}选人`, { exact: true }).isDisabled(), true);
  assert.equal(await card().getByLabel('队长').isDisabled(), true);
  await card().getByText('＋ 就地新增人员', { exact: true }).click();
  await card().getByLabel('新增人员姓名', { exact: true }).fill('名单外新人员');
  await card().getByRole('button', { name: '添加到学校人员名单', exact: true }).click();
  await submit().click(); await page.getByRole('button', { name: '确认整批提交', exact: true }).waitFor();
  await submit().click(); await page.getByRole('button', { name: '预览整批变更', exact: true }).waitFor();
  assert.equal((await people()).length, 5);
  const frozen = (await api('GET', `/api/schools/${school.id}/registration-workspace`)).projects.find(p => p.category_id === category.id);
  assert.deepEqual(frozen, savedEntry, 'a new school profile must not enter the frozen lineup');
  await page.screenshot({ path: path.join(artifacts, 'recording-roster-frozen-390.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: 赛程确认后就地补录、后台提交、原对阵和抽签保留、领取后冻结阵容但可新增学校人员、1365/390 布局');
} finally { if (browser) await browser.close(); child.kill(); }


/* G0 基线截图脚本（需要 Playwright；当前工作区未安装，发布流水线/本地运行）。
   用法：
     STSS_PLAYWRIGHT_MODULE=/path/to/playwright node tools/capture_baseline.mjs
     BASE_URL=http://127.0.0.1:8213 OUT_DIR=docs/baseline/screens-2026-10-23 node tools/capture_baseline.mjs
   前置：服务已启动、管理员密码通过 STSS_ADMIN_PASSWORD 提供（默认 test12345）。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8213').replace(/\/$/, '');
const USER = process.env.STSS_ADMIN_USER || 'admin';
const PASS = process.env.STSS_ADMIN_PASSWORD || 'test12345';
const OUT = process.env.OUT_DIR || path.join('docs', 'baseline', `screens-${new Date().toISOString().slice(0, 10)}`);
const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '834', width: 834, height: 1112 },
  { name: '390', width: 390, height: 844 },
];

async function loginToken() {
  const response = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client-Protocol': '3' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (!response.ok) throw new Error(`登录失败 HTTP ${response.status}`);
  const data = await response.json();
  return data.token;
}

async function main() {
  const token = await loginToken();
  /* 未安装 Playwright 自带浏览器时可用本机 Edge/Chrome：设置 STSS_EDGE_PATH 或默认 Edge 路径。 */
  const edgePath = process.env.STSS_EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const hasEdge = await fs.access(edgePath).then(() => true).catch(() => false);
  const browser = await chromium.launch(hasEdge ? { executablePath: edgePath } : {});
  try {
    for (const viewport of VIEWPORTS) {
      const dir = path.join(OUT, viewport.name);
      await fs.mkdir(dir, { recursive: true });
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      await context.addInitScript((value) => localStorage.setItem('stss_token', value), token);
      const page = await context.newPage();
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(800);
      const routes = await page.evaluate(() => {
        const ev = Number(localStorage.getItem('stss_event') || 1);
        return [
          '#/dashboard',
          `#/workspace?event=${ev}&group=1&category=1&tab=registration`,
          `#/workspace?event=${ev}&group=1&category=1&tab=schedule`,
          '#/scoring?match=2&category=1',
          '#/resultReview?category=1',
          '#/results?category=1',
          '#/school?group=1',
          '#/admin?tab=exports&category=1',
        ];
      });
      for (const [index, route] of routes.entries()) {
        await page.goto(`${BASE}/${route}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(700);
        const name = String(index + 1).padStart(2, '0') + '-' + route.replace(/^#\//, '').replace(/[?&=]/g, '_').slice(0, 60);
        await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
        console.log(`captured ${viewport.name} ${route}`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`基线截图已输出到 ${OUT}`);
}

main().catch((error) => { console.error(error); process.exit(1); });

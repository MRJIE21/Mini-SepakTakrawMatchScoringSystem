/* P2-A REQ-012 真实浏览器检查：
   - /favicon.svg 与 /favicon.ico 均 200，ICO 为合法 32×32 单图标；
   - index.html / display.html 带 rel=icon 与 alternate icon，index 带 manifest；
   - manifest.webmanifest 的 icons 非空且每个地址可访问；
   - sw.js 缓存升到 stss-shell-v77，SHELL 含两个图标且每一项都 200；
   - 真实浏览器加载首页与 display.html 期间 favicon 请求零 >=400、零 requestfailed。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const python = process.env.STSS_PYTHON || 'python';
const helper = path.join(process.cwd(), 'tests/helpers/display_server.py');
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'stss-p2a-resources-'));
const artifacts = process.env.STSS_BROWSER_ARTIFACTS || path.join(dataDir, 'artifacts');
await mkdir(dataDir, { recursive: true });
await mkdir(artifacts, { recursive: true });

const child = spawn(python, ['-B', helper], {
  env: { ...process.env, STSS_DISPLAY_DATA: dataDir, PYTHONDONTWRITEBYTECODE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
const ready = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('display server timeout\n' + stderr)), 20000);
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    try {
      const payload = JSON.parse(line);
      if (payload.port) { clearTimeout(timer); lines.close(); resolve(payload); }
    } catch { /* ignore non-JSON logs */ }
  });
  child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`display server exit ${code}\n${stderr}`)); });
});

const base = `http://127.0.0.1:${ready.port}`;

async function fetchText(pathname) {
  const response = await fetch(base + pathname);
  assert.equal(response.status, 200, `${pathname} must be 200, got ${response.status}`);
  return { response, text: await response.text() };
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STSS_BROWSER_PATH || undefined,
});

try {
  // ---------- 静态资源：favicon.svg / favicon.ico ----------
  const svg = await fetchText('/favicon.svg');
  assert.match(svg.response.headers.get('content-type') || '', /svg/,
    `favicon.svg content-type: ${svg.response.headers.get('content-type')}`);
  const svgBody = svg.text.trim();
  assert.ok(svgBody.startsWith('<svg'), 'favicon.svg must be an inline SVG document');
  assert.ok(svgBody.includes('viewBox="0 0 32 32"'), 'favicon.svg must declare a 32x32 viewBox');

  const icoResponse = await fetch(base + '/favicon.ico');
  assert.equal(icoResponse.status, 200, 'favicon.ico must not 404');
  const icoType = icoResponse.headers.get('content-type') || '';
  assert.match(icoType, /icon|x-icon|octet-stream/, `favicon.ico content-type: ${icoType}`);
  const ico = new Uint8Array(await icoResponse.arrayBuffer());
  assert.ok(ico.length > 100, `favicon.ico looks too small: ${ico.length} bytes`);
  assert.deepEqual([...ico.slice(0, 4)], [0, 0, 1, 0], 'favicon.ico must start with the ICO header');
  assert.equal(ico[4] | (ico[5] << 8), 1, 'favicon.ico must contain exactly one image');
  assert.equal(ico[6], 32, 'favicon.ico image width must be 32');
  assert.equal(ico[7], 32, 'favicon.ico image height must be 32');

  // ---------- 页面 link 与 manifest ----------
  const index = await fetchText('/index.html');
  const display = await fetchText('/display.html');
  for (const [name, html] of [['index.html', index.text], ['display.html', display.text]]) {
    assert.ok(/rel="icon"/.test(html), `${name} must declare rel="icon"`);
    assert.ok(html.includes('/favicon.svg'), `${name} must reference /favicon.svg`);
    assert.ok(/rel="alternate icon"/.test(html), `${name} must declare rel="alternate icon"`);
    assert.ok(html.includes('/favicon.ico'), `${name} must reference /favicon.ico`);
  }
  assert.ok(index.text.includes('rel="manifest"'), 'index.html must link the web manifest');

  const manifest = JSON.parse((await fetchText('/manifest.webmanifest')).text);
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2,
    `manifest icons must not be empty, got ${JSON.stringify(manifest.icons)}`);
  const iconTypes = new Set(manifest.icons.map((icon) => icon.type));
  assert.ok(iconTypes.has('image/svg+xml'), 'manifest must list the SVG icon');
  assert.ok(iconTypes.has('image/x-icon'), 'manifest must list the ICO icon');
  const iconSizes = new Map(manifest.icons.map((icon) => [icon.src, icon.sizes]));
  assert.equal(iconSizes.get('/favicon.ico'), '32x32', 'manifest ICO must declare 32x32');
  for (const icon of manifest.icons) {
    const response = await fetch(base + icon.src);
    assert.equal(response.status, 200, `manifest icon ${icon.src} must be reachable, got ${response.status}`);
  }

  // ---------- sw.js：缓存版本 + SHELL 全 200 ----------
  const sw = await fetchText('/sw.js');
  assert.ok(sw.text.includes("const CACHE = 'stss-shell-v77'"),
    'sw.js must bump the cache to stss-shell-v77');
  const shellMatch = sw.text.match(/const SHELL = \[([\s\S]*?)\];/);
  assert.ok(shellMatch, 'sw.js must declare the SHELL cache list');
  const shell = [...shellMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.ok(shell.includes('/favicon.svg'), 'SHELL must cache /favicon.svg');
  assert.ok(shell.includes('/favicon.ico'), 'SHELL must cache /favicon.ico');
  assert.ok(shell.includes('/display.html'), 'SHELL must keep /display.html');
  for (const entry of shell) {
    const response = await fetch(base + entry);
    assert.equal(response.status, 200, `SW SHELL entry ${entry} must be 200, got ${response.status}`);
  }

  // ---------- 真实浏览器：首页 / display 的 favicon 请求零失败 ----------
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const faviconFailures = [];
  const faviconRequestFailures = [];
  const faviconConsoleErrors = [];
  page.on('response', (response) => {
    if (response.url().includes('favicon') && response.status() >= 400) {
      faviconFailures.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on('requestfailed', (request) => {
    if (request.url().includes('favicon')) faviconRequestFailures.push(request.url());
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().toLowerCase().includes('favicon')) {
      faviconConsoleErrors.push(message.text());
    }
  });

  await page.goto(base + '/', { waitUntil: 'load' });
  await page.waitForSelector('#login-username', { timeout: 15000 });
  const indexLinks = await page.evaluate(() => [...document.querySelectorAll(
    'link[rel="icon"], link[rel="alternate icon"], link[rel="manifest"]')]
    .map((link) => ({ rel: link.getAttribute('rel'), href: link.href })));
  assert.ok(indexLinks.some((link) => link.rel === 'icon' && link.href.endsWith('/favicon.svg')),
    `index icon links: ${JSON.stringify(indexLinks)}`);
  assert.ok(indexLinks.some((link) => link.rel === 'alternate icon' && link.href.endsWith('/favicon.ico')),
    `index alternate icon links: ${JSON.stringify(indexLinks)}`);
  assert.ok(indexLinks.some((link) => link.rel === 'manifest' && link.href.endsWith('/manifest.webmanifest')),
    'index manifest link must resolve');
  await page.waitForTimeout(600);

  await page.goto(base + '/display.html', { waitUntil: 'load' });
  await page.waitForSelector('#pairing:not(.hidden)', { timeout: 15000 });
  const displayLinks = await page.evaluate(() => [...document.querySelectorAll(
    'link[rel="icon"], link[rel="alternate icon"]')]
    .map((link) => ({ rel: link.getAttribute('rel'), href: link.href })));
  assert.ok(displayLinks.some((link) => link.rel === 'icon' && link.href.endsWith('/favicon.svg')),
    `display icon links: ${JSON.stringify(displayLinks)}`);
  await page.waitForTimeout(800);

  assert.deepEqual(faviconFailures, [], `favicon responses >=400: ${faviconFailures.join(', ')}`);
  assert.deepEqual(faviconRequestFailures, [], `failed favicon requests: ${faviconRequestFailures.join(', ')}`);
  assert.deepEqual(faviconConsoleErrors, [], `favicon console errors: ${faviconConsoleErrors.join(', ')}`);

  await page.screenshot({ path: path.join(artifacts, 'p2a-resources-display-pairing.png') });
  await context.close();

  console.log('p2a_resources: favicon.svg/.ico, manifest icons, sw.js v77 SHELL and zero favicon failures passed');
} finally {
  await browser.close();
  child.kill();
}

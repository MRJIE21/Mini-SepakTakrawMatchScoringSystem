import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const CSS = read('web/css/app.css');
const MAIN = read('web/js/main.js');
const INDEX = read('web/index.html');

test('G1 令牌：间距/字号/控件高度已定义', () => {
  for (const token of ['--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--space-7',
    '--text-12', '--text-13', '--text-14', '--text-16', '--text-18', '--text-20', '--text-24',
    '--control-sm', '--control-md', '--control-lg', '--control-xl', '--touch']) {
    assert.match(CSS, new RegExp(`${token}:`), `缺少令牌 ${token}`);
  }
});

test('G1 令牌：关键组件使用令牌而不是裸数值', () => {
  assert.match(CSS, /\.btn\.small \{ min-height: var\(--control-sm\)/);
  assert.match(CSS, /\.btn-primary, \.btn-lg, \.modal-foot \.btn, \.btn\.touch \{ min-height: var\(--control-xl\)/);
  assert.match(CSS, /\.content \{ flex: 1; padding: var\(--space-5\)/);
  assert.match(CSS, /\.badge \{[\s\S]*?font-size: var\(--text-12\)/);
  assert.match(CSS, /table\.tbl \{ width: 100%; border-collapse: collapse; font-size: var\(--text-13\)/);
  assert.match(CSS, /h2 \{ font-size: var\(--text-18\)/);
});

test('G1 可访问性：跳转主内容与 aria-current', () => {
  assert.match(INDEX, /class="skip-link" href="#content"/);
  assert.match(INDEX, /<main class="content" id="content" tabindex="-1"/);
  assert.match(CSS, /\.skip-link\s*\{[\s\S]*?position: absolute/);
  assert.match(CSS, /\.skip-link:focus \{ top: var\(--space-2\); \}/);
  assert.match(MAIN, /'aria-current': active \? 'page' : null/);
  assert.match(MAIN, /a\.setAttribute\('aria-current', 'page'\)/);
});

test('G1 可访问性：移动端次要按钮不小于 36px', () => {
  assert.match(CSS, /@media \(max-width: 620px\) \{[\s\S]*?\.btn\.small \{ min-height: var\(--control-md\); \}/);
});

test('G1 令牌：视图不再使用引号内联样式（动态模板样式除外）', () => {
  const dirs = ['web/js', 'web/js/views'];
  const hits = [];
  for (const dir of dirs) {
    for (const name of fs.readdirSync(new URL(`../${dir}/`, import.meta.url))) {
      if (!name.endsWith('.js')) continue;
      const text = fmtRead(`${dir}/${name}`);
      const lines = text.split('\n');
      lines.forEach((line, index) => {
        if (/style:\s*['"]/.test(line)) hits.push(`${dir}/${name}:${index + 1}: ${line.trim()}`);
      });
    }
  }
  assert.deepEqual(hits, [], `仍有引号内联样式：\n${hits.join('\n')}`);
});

test('G1 可访问性：页签/阶段/步骤同步 aria-current', () => {
  assert.ok(read('web/js/views/workspace.js').includes("'aria-current': 'page'"),
    '工作台页签缺少 aria-current');
  assert.match(read('web/js/views/schedule.js'), /'aria-current': stageId === item\.id \? 'true' : null/);
  assert.match(read('web/js/views/setup.js'), /'aria-current': index === step \? 'step' : null/);
  assert.match(read('web/js/views/admin.js'), /'aria-current': key === activeTab \? 'page' : null/);
});

function fmtRead(relative) {
  return fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
}

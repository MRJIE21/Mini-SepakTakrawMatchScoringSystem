/* 学校抽签面板：揭晓进度以服务器为准，失败重试沿用同一请求标识。 */
import { api, newUid, openHtml } from './api.js';
import { groupName } from './schedulingFlow.js';
import { h, clear, field, selectInput, textInput, numberInput, table, statusBadge, toast, confirmAsync, promptDialog, categoryLabel } from './ui.js';

const STATUS = { drawing: ['抽签进行中', 'info'], complete: ['已抽完 · 待确认', 'warn'], confirmed: ['分组已确认', 'ok'], cancelled: ['已撤销', ''] };

export function renderGroupDraw(cat, initial, onChange) {
  const panel = h('section.panel.group-draw', { id: 'group-draw', 'aria-label': '学校小组抽签' });
  panel.addEventListener('fullscreenchange', () => {
    const button = panel.querySelector('[data-fullscreen]');
    if (button) button.textContent = document.fullscreenElement === panel ? '退出全屏' : '全屏展示';
  });
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || document.fullscreenElement !== panel) return;
    event.preventDefault();
    leaveFullscreen().catch(() => {
      if (document.fullscreenElement === panel) toast('退出全屏失败，请使用“退出全屏”按钮重试', 'error');
    });
  });
  let data = initial;
  let busy = false;
  const retries = new Map();
  let groups = initial.draw?.capacities.length || Math.min(2, Math.max(1, initial.roster.length));
  let method = initial.draw?.method || 'random';
  let sizesText = '';
  const errorBox = h('div.warn-box.hidden', { role: 'alert' });

  async function leaveFullscreen() {
    if (document.fullscreenElement === panel) await document.exitFullscreen();
  }

  async function reload() {
    data = await api.get(`/api/categories/${cat.id}/group-draw`);
    drawPanel();
    onChange(data.draw);
  }

  async function mutate(action, values = {}) {
    if (busy) return;
    busy = true;
    errorBox.classList.add('hidden');
    const previous = data.draw;
    const body = action === 'start' ? { ...values, roster_hash: data.roster_hash }
      : { draw_id: previous.id, base_rev: previous.rev, ...values };
    const key = JSON.stringify([action, body]);
    const uid = retries.get(key) || newUid('draw');
    retries.set(key, uid);
    const controls = [...panel.querySelectorAll('button,input,select')];
    const disabled = controls.map((control) => control.disabled);
    controls.forEach((control) => { control.disabled = true; });
    try {
      const path = `/api/categories/${cat.id}/group-draw${action === 'start' ? '' : `/${action}`}`;
      await api.post(path, { ...body, request_uid: uid });
      await reload();
      retries.delete(key);
      if (action === 'confirm') toast('抽签分组已确认，可保存并生成赛程预览', 'ok');
      if (action === 'cancel') toast('已撤销本次抽签，原记录保留', 'ok');
    } catch (error) {
      errorBox.textContent = error.status === 0
        ? '操作结果待核实。请刷新抽签状态，或用原操作重试。' : error.message;
      errorBox.classList.remove('hidden');
    } finally {
      busy = false;
      controls.forEach((control, i) => { if (control.isConnected) control.disabled = disabled[i]; });
    }
  }

  function capacities() {
    if (!Number.isInteger(groups) || groups < 1) throw new Error('小组数量须为正整数');
    if (groups > data.roster.length) throw new Error('小组数量不能超过已报名学校数');
    const values = sizesText.trim() ? sizesText.trim().split(/[,，、\s]+/).map(Number)
      : Array.from({ length: groups }, (_, i) => Math.floor(data.roster.length / groups) + Number(i < data.roster.length % groups));
    if (values.length !== groups || values.some((n) => !Number.isInteger(n) || n < 1)
      || values.reduce((sum, n) => sum + n, 0) !== data.roster.length) {
      throw new Error(`各组人数须为正整数，请为 ${groups} 组填写共 ${data.roster.length} 所学校的名额`);
    }
    if (method === 'seeded' && Math.max(...values) - Math.min(...values) > 1) {
      throw new Error('种子分档时各组人数最多相差 1');
    }
    return values;
  }

  function drawPanel() {
    clear(panel);
    const draw = data.draw;
    const active = draw && draw.status !== 'cancelled';
    const header = h('div.panel-head', h('div', h('h3', '学校小组抽签'),
      h('div.small.muted', `${categoryLabel(cat, { withGroup: true })} · ` + (active
        ? `本次 ${draw.total} 所学校 · ${draw.capacities.length} 个小组` : `当前已报名 ${data.roster.length} 所学校`))),
    h('div.row.tight', active ? statusBadge(...STATUS[draw.status]) : null,
      h('button.btn.small', { onclick: async () => {
        if (busy) return;
        try { await reload(); } catch (error) { toast(error.message, 'error'); }
      } }, '刷新抽签状态')));
    panel.append(header, errorBox);
    if (data.blocked_reason) panel.append(h('div.info-box', data.blocked_reason));
    if (active && draw.stale) panel.append(h('div.warn-box', '参赛学校或种子序号已变化。本次结果已失效，请撤销后重新核对名单并抽签。'));
    if (!active) {
      panel.append(h('div.small.muted.mb', '核对学校名单和各组名额后开始。抽签进度自动保存，可刷新或换设备继续。'));
      const preview = h('div.draw-capacities', { 'aria-live': 'polite' });
      const start = h('button.btn.btn-primary', { disabled: !!data.blocked_reason,
        onclick: async () => {
          try { await mutate('start', { method, capacities: capacities() }); }
          catch (error) { errorBox.textContent = error.message; errorBox.classList.remove('hidden'); }
        } }, '开始小组抽签');
      const update = () => {
        clear(preview);
        try {
          const values = capacities();
          const seeds = data.roster.map((school) => school.seed_no);
          if (method === 'seeded' && (seeds.some((seed) => !Number.isInteger(seed) || seed < 1) || new Set(seeds).size !== seeds.length)) {
            throw new Error('请先到报名名单为每所学校填写唯一的种子序号');
          }
          preview.append(...values.map((size, i) => h('span.chip', `${groupName(i)} ${size} 校`)));
          start.disabled = !!data.blocked_reason;
        } catch (error) { preview.append(h('span.small', error.message)); start.disabled = true; }
      };
      panel.append(h('div.form-grid',
        field('抽签方式', selectInput([['random', '完全随机'], ['seeded', '种子分档']], method, {
          'aria-label': '抽签方式',
          disabled: !!data.blocked_reason, onchange: (event) => { method = event.target.value; update(); },
        })),
        field('小组数量', numberInput(groups, { 'aria-label': '小组数量', min: 1, step: 1, disabled: !!data.blocked_reason,
          oninput: (event) => { groups = Number(event.target.value); update(); } })),
        field('各组人数（可选）', textInput(sizesText, { 'aria-label': '各组人数（可选）', placeholder: '例如 4,4,3；留空按人数均分', disabled: !!data.blocked_reason,
          oninput: (event) => { sizesText = event.target.value; update(); } }), { hint: '按 A、B、C…组的顺序填写' })), preview,
        h('p.small.muted', '种子分档：按种子序号从小到大，每档包含与小组数量相同的学校，每组每档最多一校；最后一档可不足。'),
        h('details.draw-roster', h('summary', `核对参赛学校与种子（${data.roster.length} 校）`),
          h('div.table-scroll', table([{ label: '学校', key: 'school_name' }, { label: '种子序号', render: (p) => p.seed_no || '未设置' }], data.roster))),
        h('div.row.mt', start));
      update();
    } else {
      panel.append(h('div.draw-progress', h('span', `${draw.revealed} / ${draw.total} 所学校已揭晓`),
        h('span.small.muted', `${draw.method === 'seeded' ? '种子分档' : '完全随机'} · 开始于 ${draw.created_at}`)));
      const board = h('div.draw-board');
      const latest = draw.steps.at(-1);
      board.append(h('div.draw-reveal', { 'aria-live': 'polite', 'aria-atomic': 'true' },
        h('div.small.muted', latest ? `第 ${latest.number} 签${latest.pot ? ` · 第 ${latest.pot} 档` : ''}` : '准备揭晓'),
        h('div.draw-school', latest?.school_name || '等待第一所学校'),
        h('div.draw-destination', latest ? `进入 ${groupName(latest.group)}` : '点击“抽下一所学校”开始')));
      board.append(h('div.draw-groups', ...draw.groups.map((group) => h('section.draw-group',
        h('div.panel-head', h('h4', group.name), h('span.small.muted', `${group.members.length} / ${group.capacity}`)),
        h('ol', ...Array.from({ length: group.capacity }, (_, i) => {
          const member = group.members[i];
          return h(`li${member ? '' : '.draw-empty'}`, member ? h('span', member.school_name) : '待抽签',
            member?.pot ? h('span.small.muted', `第${member.pot}档`) : null);
        }))))));
      panel.append(board);
      const actions = h('div.row.mt');
      const disabled = !!data.blocked_reason || draw.stale;
      if (draw.status === 'drawing') actions.append(
        h('button.btn.btn-primary', { disabled, onclick: () => mutate('next') }, '抽下一所学校'),
        h('button.btn', { disabled, onclick: () => mutate('complete') }, '一键完成抽签'));
      if (draw.status === 'complete') actions.append(h('button.btn.btn-primary', { disabled,
        onclick: async () => {
          await leaveFullscreen();
          if (await confirmAsync('确认抽签分组', '确认后按此分组生成赛程，重新抽签须填写撤销原因。', '确认分组')) await mutate('confirm');
        } }, '确认抽签分组'));
      if (draw.status === 'confirmed') {
        panel.append(h('div.info-box.mt', `已由 ${draw.confirmed_by_name} 于 ${draw.confirmed_at} 确认。下方编排将使用这份分组。`));
        actions.append(h('button.btn', { disabled: draw.stale, onclick: async () => {
          try { await openHtml(`/api/categories/${cat.id}/group-draw/notice.html`, {}, '小组抽签分组表'); }
          catch (error) { toast(error.message, 'error'); }
        } }, '打印分组表'));
      }
      actions.append(h('button.btn', { dataset: { fullscreen: 'true' }, onclick: async () => {
        try {
          if (document.fullscreenElement === panel) await leaveFullscreen();
          else await panel.requestFullscreen();
        } catch { toast('当前浏览器无法切换全屏，请使用浏览器全屏功能', 'error'); }
      } }, document.fullscreenElement === panel ? '退出全屏' : '全屏展示'));
      if (!data.blocked_reason) actions.append(h('button.btn.btn-ghost', { onclick: async () => {
        await leaveFullscreen();
        const reason = await promptDialog({ title: '撤销本次抽签', label: '撤销原因', required: true, multiline: true,
          hint: '原结果和已揭晓过程会保留；已生成的预览需重新保存并生成。', okLabel: '撤销抽签' });
        if (reason) await mutate('cancel', { reason });
      } }, '撤销本次抽签'));
      panel.append(actions, h('details.draw-log.mt', h('summary', '查看抽签过程'),
        h('div.table-scroll', table([{ label: '签次', key: 'number' }, { label: '学校', key: 'school_name' },
          { label: '小组', render: (step) => groupName(step.group) },
          { label: '档位', render: (step) => step.pot ? `第${step.pot}档` : '—' }], draw.steps))));
    }
    if (data.history.length) panel.append(h('details.draw-history.mt', h('summary', '已撤销的抽签记录'),
      ...data.history.map((old) => h('details.mt', h('summary', `抽签 ${old.id} · ${old.created_at} · ${old.revealed}/${old.total} 校已揭晓`),
        h('p.small', `撤销原因：${old.cancel_reason}`),
        ...old.groups.map((group) => h('p.small', `${group.name}：${group.members.map((p) => p.school_name).join('、') || '尚未揭晓'}`))))));
  }
  drawPanel();
  return panel;
}

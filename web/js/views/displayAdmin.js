/* 大屏控制台：单屏、8 个手动槽位、布局切换、推送与配对。 */
import { api } from '../api.js';
import { registerView, state } from '../main.js';
import { h, clear, toast, statusBadge, fmtDateTime, pageHeader } from '../ui.js';

const LAYOUTS = [1, 2, 3, 4, 8];
const MODE_NAMES = { score: '比分', announce: '公告', standby: '待机' };

async function render({ el }) {
  if (!state.eventId) {
    el.append(h('div.panel', h('div.info-box', '请先在“赛事设置”中创建或选择赛事。')));
    return;
  }
  const box = h('div');
  el.append(box);
  const ctx = { draft: null, config: null, screens: [], matches: [], dirty: false, busy: false, pushMessage: null };
  let screenTimer = null;
  let screenRefreshing = false;
  let pollError = null;
  let pushButton = null;
  let pushHint = null;
  let versionBadge = null;
  let dirtyBadge = null;
  let deviceBadge = null;
  await load();
  screenTimer = setInterval(refreshScreenStatus, 5000);
  window.addEventListener('beforeunload', () => clearInterval(screenTimer));

  async function load() {
    clear(box);
    box.append(h('div.panel', h('div.small.muted', '正在加载大屏配置…')));
    try {
      const [consoleData, matchesPage] = await Promise.all([
        api.get(`/api/display/console?event_id=${state.eventId}`),
        api.get('/api/matches?kind=team&limit=500&sort=schedule'),
      ]);
      ctx.config = consoleData.config;
      ctx.screens = consoleData.screens || [];
      ctx.matches = (matchesPage.matches || []).sort((a, b) => {
        const rank = (m) => m.status === 'ready' ? 0 : m.status === 'finished' ? 1 : 2;
        return rank(a) - rank(b) || a.id - b.id;
      });
      ctx.draft = normalise(ctx.config);
      ctx.dirty = false;
      draw();
    } catch (error) {
      clear(box);
      box.append(h('div.panel', h('div.warn-box', error.message || '大屏配置加载失败'),
        h('button.btn.mt', { onclick: load }, '重试')));
    }
  }

  function normalise(config) {
    const slots = Array.from({ length: 8 }, (_, index) => {
      const value = config?.slots?.[index];
      return value && value.match_id ? { match_id: Number(value.match_id), label: value.label || '' } : null;
    });
    return {
      layout: LAYOUTS.includes(Number(config?.layout)) ? Number(config.layout) : 8,
      mode: ['score', 'announce', 'standby'].includes(config?.mode) ? config.mode : 'score',
      slots,
      visible_slots: Array.isArray(config?.visible_slots) && config.visible_slots.length
        ? config.visible_slots.map(Number) : listRange(8),
      announcement_title: config?.announcement_title || '',
      announcement_body: config?.announcement_body || '',
      poll_ms: clampPoll(config?.poll_ms),
    };
  }

  function listRange(n) { return Array.from({ length: n }, (_, index) => index); }
  function clampPoll(value) {
    const number = Math.round(Number(value));
    return Number.isFinite(number) && number >= 100 && number <= 1000 ? number : 500;
  }

  function relativeTime(value) {
    if (!value) return '';
    const time = new Date(String(value).replace(' ', 'T')).getTime();
    if (!Number.isFinite(time)) return value;
    const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
    if (seconds < 5) return '刚刚';
    if (seconds < 60) return `${seconds} 秒前`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
    return fmtDateTime(value);
  }

  async function refreshScreenStatus() {
    if (!document.body.contains(box)) {
      clearInterval(screenTimer);
      screenTimer = null;
      return;
    }
    if (screenRefreshing) return;
    screenRefreshing = true;
    try {
      const data = await api.get(`/api/display/console?event_id=${state.eventId}`);
      ctx.screens = data.screens || [];
      refreshDevicePanel();
    } catch { /* keep the last known status on transient failure */ }
    finally { screenRefreshing = false; }
  }

  function refreshDevicePanel() {
    const old = box.querySelector('.display-device-panel');
    updateDeviceBadge();
    if (!old) return;
    const active = ctx.screens.some((item) => !item.revoked_at);
    if (!active && old.querySelector('input')) return;
    old.replaceWith(devicePanel());
  }

  function updateDeviceBadge() {
    if (!deviceBadge) return;
    const paired = ctx.screens.filter((item) => !item.revoked_at);
    const online = paired.filter((item) => item.online).length;
    deviceBadge.textContent = paired.length ? `设备 ${online}/${paired.length} 在线` : '尚未配对';
    deviceBadge.className = `badge ${paired.length ? (online ? 'badge-ok' : 'badge-warn') : 'badge-warn'}`;
  }

  function matchById(id) { return ctx.matches.find((item) => Number(item.id) === Number(id)) || null; }

  function markDirty() {
    ctx.dirty = true;
    updateStatus();
  }

  function sortedMatches() {
    return [...ctx.matches].sort((a, b) => {
      const live = (m) => (m.status === 'ready' ? 0 : m.status === 'finished' ? 1 : 2);
      return live(a) - live(b) || a.id - b.id;
    });
  }

  function draw(options = {}) {
    const { preserveScroll = true } = options;
    const scrollY = window.scrollY;
    clear(box);
    const paired = ctx.screens.filter((item) => !item.revoked_at);
    const online = paired.filter((item) => item.online).length;
    versionBadge = statusBadge(`已推送 v${ctx.config?.revision || 0}`, 'ok');
    dirtyBadge = statusBadge(ctx.dirty ? '有未推送修改' : '与已推送一致', ctx.dirty ? 'warn' : '');
    deviceBadge = statusBadge(paired.length ? `设备 ${online}/${paired.length} 在线` : '尚未配对',
      paired.length ? (online ? 'ok' : 'warn') : 'warn');
    box.append(pageHeader({
      crumbs: [{ label: '大屏' }],
      title: '大屏控制台',
      badges: [versionBadge, dirtyBadge, deviceBadge],
      meta: [h('span', '单屏 · 8 个手动窗口 · 编辑后点“推送”才上屏；大屏不显示标题栏、页脚、主客队标签与队员名。')],
      actions: [
        h('button.btn', {
          onclick: () => {
            const revision = Number(ctx.config?.revision || 0);
            const dirty = ctx.dirty ? 1 : 0;
            window.open(`/display.html?preview=1&event_id=${state.eventId}&v=${revision}&dirty=${dirty}`,
              '_blank', 'noopener');
          },
        }, '预览当前大屏'),
        h('button.btn', { onclick: load }, '刷新配置'),
      ],
    }));
    const workspace = h('div.display-admin-workspace');
    const controls = h('div.display-admin-controls'); controls.append(layoutPanel(), modePanel());
    const main = h('div.display-admin-main'); main.append(slotsPanel());
    const center = h('div.display-admin-center'); center.append(controls, main);
    const side = h('div.display-admin-side'); side.append(devicePanel(), pushPanel());
    workspace.append(center, side);
    box.append(workspace);
    // 重绘后同步原地校验状态（刷新间隔/窗口数/重复场次），避免按钮与错误提示滞后。
    syncPushState();
    if (preserveScroll) {
      requestAnimationFrame(() => window.scrollTo(0, scrollY));
    }
  }

  function devicePanel() {
    const screens = ctx.screens.filter((item) => !item.revoked_at);
    const card = h('div.panel.display-device-panel');
    card.append(h('h3', '大屏设备'), h('div.small.muted', '在线状态每 5 秒自动刷新'));
    if (!screens.length) {
      card.append(h('div.info-box', '尚未配对。请让体育馆大屏打开 /display.html，把屏幕上的 6 位配对码输入这里。'));
      const code = h('input.input', { type: 'text', placeholder: '6 位配对码', inputmode: 'numeric', maxlength: '6' });
      const name = h('input.input', { type: 'text', placeholder: '大屏名称（如 1 号屏）', value: '体育馆大屏' });
      const claim = h('button.btn.btn-primary', {
        onclick: async () => {
          try {
            await api.post('/api/display/pair/claim', {
              code: code.value.trim(), event_id: state.eventId, name: name.value.trim() || '体育馆大屏',
            });
            toast('大屏已配对', 'ok');
            await load();
          } catch (error) { toast(error.message, 'error'); }
        },
      }, '确认配对');
      card.append(h('div.row.mt', code, name, claim));
    } else {
      for (const screen of screens) {
        card.append(h('div.row.tight.mt',
          statusBadge(screen.online ? '在线' : '离线', screen.online ? 'ok' : 'warn'),
          h('b', screen.name),
          h('span.small.muted',
            { title: screen.last_seen_at || '' },
            screen.last_seen_at ? `最后确认 ${relativeTime(screen.last_seen_at)}` : '尚未上线'),
          h('button.btn.small', {
            onclick: async () => {
              try {
                await api.post('/api/display/revoke', { screen_id: screen.id });
                toast('已撤销大屏凭据', 'ok');
                await load();
              } catch (error) { toast(error.message, 'error'); }
            },
          }, '撤销/重新配对')));
      }
    }
    return card;
  }

  function layoutPanel() {
    const card = h('div.panel');
    card.append(h('h3', '布局'));
    const row = h('div.row.tight');
    for (const layout of LAYOUTS) {
      row.append(h('button.btn', {
        class: ctx.draft.layout === layout ? 'btn btn-primary' : 'btn',
        onclick: () => {
          ctx.draft.layout = layout;
          if (layout === 8) ctx.draft.visible_slots = listRange(8);
          else if (ctx.draft.visible_slots.length !== layout) {
            ctx.draft.visible_slots = listRange(layout);
          } else {
            ctx.draft.visible_slots = [...ctx.draft.visible_slots].sort((a, b) => a - b);
          }
          markDirty();
          draw();
        },
      }, `${layout} 窗口`));
    }
    card.append(row, h('div.small.muted.mt', '1–4 窗口时，在下方勾选要显示的槽位；8 窗口固定显示全部。'));
    return card;
  }

  function modePanel() {
    const card = h('div.panel');
    card.append(h('h3', '画面'));
    const row = h('div.row.tight');
    for (const mode of ['score', 'announce', 'standby']) {
      row.append(h('button.btn', {
        class: ctx.draft.mode === mode ? 'btn btn-primary' : 'btn',
        onclick: () => { ctx.draft.mode = mode; markDirty(); draw(); },
      }, MODE_NAMES[mode]));
    }
    card.append(row);
    const poll = h('input.input', {
      type: 'number', min: '100', max: '1000', step: '50',
      value: String(ctx.draft.poll_ms),
      oninput: (event) => {
        // 只做就地校验，不重绘（重绘会丢焦点）；推送按钮与错误提示在此同步。
        const raw = String(event.target.value).trim();
        const value = raw === '' ? NaN : Number(raw);
        ctx.draft.poll_ms = Number.isInteger(value) ? value : NaN;
        markDirty();
        syncPushState();
      },
    });
    pollError = h('div.field-error.hidden', '刷新间隔需为 100–1000 的整数毫秒');
    card.append(h('div.field.mt', h('label', '比分刷新间隔（100–1000ms）'), poll, pollError,
      h('div.small.muted', '默认 500ms；仅比分模式生效，公告/待机固定 2 秒。')));
    const title = h('input.input', {
      value: ctx.draft.announcement_title, placeholder: '公告标题',
      oninput: (event) => { ctx.draft.announcement_title = event.target.value; markDirty(); },
    });
    const body = h('textarea.textarea', {
      placeholder: '公告正文', rows: '3',
      oninput: (event) => { ctx.draft.announcement_body = event.target.value; markDirty(); },
    });
    body.value = ctx.draft.announcement_body;
    card.append(h('div.field.mt', h('label', '公告标题'), title),
      h('div.field', h('label', '公告正文'), body));
    return card;
  }

  function slotsPanel() {
    const card = h('div.panel.display-slots-panel');
    const assigned = ctx.draft.slots.filter(Boolean).length;
    card.append(h('div.panel-head',
      h('h3', '8 个窗口（手动指定比赛）'),
      h('span.badge', `已指定 ${assigned} / 8`)),
      h('div.small.muted', '同一场比赛不能占用两个窗口；标签默认取场地的名称，可修改。'));
    const grid = h('div.display-slots');
    for (let index = 0; index < 8; index += 1) {
      grid.append(slotCard(index));
    }
    card.append(grid);
    return card;
  }

  function slotCard(index) {
    const slot = ctx.draft.slots[index];
    const card = h('div.slot-card');
    const visible = h('input', {
      type: 'checkbox',
      checked: ctx.draft.visible_slots.includes(index),
      onchange: () => {
        if (ctx.draft.layout === 8) { visible.checked = true; return; }
        if (visible.checked) {
          if (ctx.draft.visible_slots.length >= ctx.draft.layout) {
            visible.checked = false;
            toast(`当前布局只能勾选 ${ctx.draft.layout} 个窗口`, 'error');
            return;
          }
          ctx.draft.visible_slots.push(index);
        } else {
          ctx.draft.visible_slots = ctx.draft.visible_slots.filter((item) => item !== index);
        }
        ctx.draft.visible_slots.sort((a, b) => a - b);
        markDirty();
      },
    });
    const label = h('input.input.small', {
      value: slot?.label || '', placeholder: `${index + 1} 号场`,
      oninput: (event) => {
        ctx.draft.slots[index] = { ...(ctx.draft.slots[index] || { match_id: null }), label: event.target.value };
        markDirty();
      },
    });
    const select = h('select.select');
    select.append(h('option', { value: '' }, '未指定比赛'));
    const used = new Set(ctx.draft.slots.filter((item, slotIndex) => item?.match_id && slotIndex !== index)
      .map((item) => Number(item.match_id)));
    for (const match of sortedMatches()) {
      if (used.has(Number(match.id))) continue;
      const labelText = `${match.public_code || `M${match.id}`} · ${match.home?.label || '主队'} vs ${match.away?.label || '客队'}`
        + ` · ${match.round_label || ''}${match.status === 'finished' ? '（已结束）' : ''}`;
      select.append(h('option', { value: String(match.id) }, labelText));
    }
    select.value = slot?.match_id ? String(slot.match_id) : '';
    select.onchange = () => {
      const value = Number(select.value);
      if (!value) {
        ctx.draft.slots[index] = null;
      } else {
        const match = matchById(value);
        ctx.draft.slots[index] = {
          match_id: value,
          label: label.value || match?.venue_name || `${index + 1} 号场`,
        };
        label.value = ctx.draft.slots[index].label;
      }
      markDirty();
      draw();
    };
    card.append(h('div.slot-card-head', h('b', `${index + 1} 号窗口`),
      h('label.small', visible, ' 显示')));
    card.append(select, label);
    return card;
  }

  function validity() {
    const layout = ctx.draft.layout;
    const visible = layout === 8 ? listRange(8) : [...ctx.draft.visible_slots];
    const pollValid = Number.isInteger(ctx.draft.poll_ms)
      && ctx.draft.poll_ms >= 100 && ctx.draft.poll_ms <= 1000;
    const assigned = ctx.draft.slots.filter(Boolean);
    const noDup = new Set(assigned.map((item) => item.match_id)).size === assigned.length;
    return {
      visible,
      pollValid,
      noDup,
      visibleOk: visible.length === layout,
      valid: visible.length === layout && pollValid && noDup,
    };
  }

  function pushHintText(check) {
    if (check.valid) return '推送后大屏会在 1 秒内应用。';
    if (!check.pollValid) return '请先修正刷新间隔（100–1000 的整数毫秒）。';
    return '请先按布局勾选正确数量的窗口，并避免重复场次。';
  }

  function syncPushState() {
    const check = validity();
    if (pollError) pollError.classList.toggle('hidden', check.pollValid);
    if (pushButton) {
      pushButton.disabled = ctx.busy || !check.valid;
      pushButton.textContent = ctx.busy ? '推送中…' : '推送到大屏';
    }
    if (pushHint) pushHint.textContent = pushHintText(check);
    updateStatus();
  }

  function pushPanel() {
    const row = h('div.panel.display-push-panel');
    const check = validity();
    pushButton = h('button.btn.btn-primary.btn-lg', {
      disabled: ctx.busy || !check.valid,
      onclick: push,
    }, ctx.busy ? '推送中…' : '推送到大屏');
    pushHint = h('span.small.muted', pushHintText(check));
    row.append(h('div.panel-head', h('h3', '推送到大屏'),
      h('span.small.muted', `已推送 v${ctx.config?.revision || 0}`)),
      h('div.row.tight', pushButton, pushHint));
    if (ctx.pushMessage) {
      row.append(h('div.small.mt',
        { class: ctx.pushMessage.kind === 'error' ? 'field-error' : '' },
        ctx.pushMessage.text));
    }
    return row;
  }

  async function push() {
    if (ctx.busy) return;
    const check = validity();
    if (!check.valid) {
      ctx.pushMessage = {
        kind: 'error',
        text: check.pollValid ? '请先按布局勾选正确数量的窗口，并避免重复场次。'
          : '刷新间隔需为 100–1000 的整数毫秒',
      };
      draw();
      return;
    }
    ctx.busy = true;
    ctx.pushMessage = { kind: 'info', text: '正在推送…' };
    draw();
    try {
      const visible = ctx.draft.layout === 8 ? listRange(8) : [...ctx.draft.visible_slots].sort((a, b) => a - b);
      const result = await api.post('/api/display/publish', {
        event_id: state.eventId,
        layout: ctx.draft.layout,
        mode: ctx.draft.mode,
        slots: ctx.draft.slots,
        visible_slots: visible,
        poll_ms: ctx.draft.poll_ms,
        announcement_title: ctx.draft.announcement_title,
        announcement_body: ctx.draft.announcement_body,
      });
      ctx.config = result.config;
      ctx.dirty = false;
      ctx.busy = false;
      ctx.pushMessage = { kind: 'ok', text: `已推送 v${result.config.revision}` };
      toast(`已推送 v${result.config.revision}`, 'ok');
      await load();
    } catch (error) {
      ctx.busy = false;
      ctx.pushMessage = { kind: 'error', text: `推送失败：${error.message}` };
      toast(error.message, 'error');
      draw();
    }
  }

  function updateStatus() {
    if (!ctx.config) return;
    const published = ctx.config.revision || 0;
    if (versionBadge) versionBadge.textContent = `已推送 v${published}`;
    if (dirtyBadge) {
      dirtyBadge.textContent = ctx.dirty ? '有未推送修改' : '与已推送一致';
      dirtyBadge.className = `badge${ctx.dirty ? ' badge-warn' : ''}`;
    }
  }
}

registerView({ name: 'display', label: '大屏', roles: ['admin', 'organizer', 'display_operator'], render });

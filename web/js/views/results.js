/* 小组与项目成绩页：小组排名（积分/C 值/Z 值/抽签）、名次确认与项目名次（设计大纲 7、8）。

   改进方案 §7.3、§13.1：个人赛不依赖三人赛的编排方案，没有方案也能查看成绩、名次、积分与导出（T16）。
   名次一律标注来源，列表排序不冒充正式名次。 */
import { api, download, openHtml, captureRequestContext } from '../api.js';
import { registerView, state, loadStructure, go } from '../main.js';
import { workspaceLink } from '../workspaceContext.js';
import {
  h, field, selectInput, textInput, table, toast, modal, confirmDialog, confirmAsync, clear,
  statusBadge, task, formDialog, searchSelect, emptyState, errorState, loadingState,
  categoryLabel,
} from '../ui.js';

const canWrite = () => ['admin', 'organizer'].includes(state.user.role);
const SOURCE_TEXT = {
  auto: '比赛推导', standings: '已确认小组排名', manual: '现场确认', individual: '个人赛成绩',
};

function scopedClient(context = captureRequestContext(), signal) {
  return {
    get: (path) => api.get(path, { context, signal }),
    post: (path, body) => api.post(path, body, { context }),
    del: (path, body) => api.del(path, body, { context }),
  };
}

async function render({ el, params, refresh, signal, requestContext, isCurrent = () => true }) {
  const client = scopedClient(requestContext, signal);
  if (!state.eventId) throw new Error('请先在“赛事首页”中创建赛事');
  const structure = state.structure || await loadStructure();
  const cats = [];
  for (const g of structure.groups) {
    for (const c of g.categories) cats.push({ ...c, group_name: g.name });
  }
  if (!cats.length) {
    el.append(emptyState({ text: '当前赛事还没有项目', hint: '请先在“赛事设置”中添加比赛项目。' }));
    return;
  }
  const catId = Number(params.category || cats[0].id);
  const cat = cats.find((c) => c.id === catId);
  const embedded = params.embedded === 'workspace';
  if (!cat) {
    /* 上下文非法时说明并给重新选择入口，不静默回退到第一个项目（§4.1） */
    el.append(errorState(new Error(`项目不存在或不属于本赛事（id=${catId}）`),
      () => { location.hash = '#/results'; }));
    return;
  }

  if (!embedded) el.append(h('div.panel',
    h('div.panel-head',
      h('h2', `${categoryLabel(cat, { withGroup: true })} · 成绩与名次`),
      field('切换项目', selectInput(
        cats.map((c) => [c.id, categoryLabel(c, { withGroup: true })]), cat.id,
        { onchange: (e) => { location.hash = `#/results?category=${e.target.value}`; } }))),
    h('div.row.tight',
      /* 导出范围写在按钮上（§13.4） */
      canWrite() ? h('button.btn', {
        title: `只导出 ${categoryLabel(cat)} 的成绩`,
        onclick: task(() => download('/api/exports/results.csv', { category_id: cat.id })),
      }, '导出本项目成绩 CSV') : null,
      canWrite() ? h('button.btn', {
        onclick: task(() => openHtml('/api/exports/category-notice.html', { category_id: cat.id }, '项目成绩单')),
      }, cat.kind === 'individual' ? '打印个人赛成绩单' : '打印三人赛名次表') : null,
      h('span.small.muted', cat.kind === 'team'
        ? '小组排名依次比较：积分（胜 2、负 1、弃权 0）→ C 值（胜局/负局）→ Z 值（得分/失分）→ 现场抽签。计算使用精确比值。'
        : '个人赛只录入最终成绩与名次，不依赖三人赛的编排方案。')),
  ));
  else el.append(h('div.workspace-toolbar',
    h('div.small.muted.grow', cat.kind === 'team'
      ? '排名依次比较积分、C 值、Z 值和现场抽签；正式名次以确认状态为准。'
      : '个人赛成绩与名次独立展示，不依赖三人赛编排方案。'),
    canWrite() ? h('button.btn', {
      title: `只导出 ${categoryLabel(cat)} 的成绩`,
      onclick: task(() => download('/api/exports/results.csv', { category_id: cat.id })),
    }, '导出本项目 CSV') : null,
    canWrite() ? h('button.btn', {
      onclick: task(() => openHtml('/api/exports/category-notice.html', { category_id: cat.id }, '项目成绩单')),
    }, cat.kind === 'individual' ? '打印个人赛成绩单' : '打印三人赛名次表') : null));

  const standingsBox = h('div');
  const placementBox = h('div');
  el.append(standingsBox, placementBox);
  let focusPool = params.pool;
  await load();

  async function load() {
    clear(standingsBox);
    clear(placementBox);
    if (cat.kind === 'team') {
      standingsBox.append(h('div.panel', loadingState('正在计算小组排名…')));
    }
    placementBox.append(h('div.panel', loadingState('正在加载项目名次…')));
    try {
      if (cat.kind === 'team') await drawTeamStandings(standingsBox, cat, load, params, client);
      else clear(standingsBox);
      if (!isCurrent()) return;
      await drawPlacements(placementBox, cat, load, refresh, client);
      if (!isCurrent()) return;
      if (focusPool) {
        const block = standingsBox.querySelector(`#pool-${Number(focusPool)}`);
        focusPool = null;
        if (block) requestAnimationFrame(() => { block.scrollIntoView({ block: 'start' }); block.focus({ preventScroll: true }); });
      }
    } catch (e) {
      if (!isCurrent() || e.code === 'navigation_cancelled') return;
      clear(placementBox);
      placementBox.append(h('div.panel', errorState(e, load)));
    }
  }
}

/* ------------------------------------------------------------------ 三人赛小组排名 */
async function drawTeamStandings(container, cat, reload, params, client = scopedClient()) {
  const plan = (await client.get(`/api/categories/${cat.id}/plan`)).plan;
  clear(container);
  const panel = h('div.panel', h('h3', '小组排名'));
  container.append(panel);
  if (!plan) {
    panel.append(emptyState({
      text: '该项目尚未编排方案',
      hint: '小组排名来自编排生成的小组。请先到“分组与编排”保存配置并生成预览。',
      action: canWrite() ? h('button.btn.btn-primary', {
        onclick: () => params.embedded === 'workspace'
          ? (location.hash = workspaceLink({ ...cat, event_id: state.eventId }, 'schedule', { view: 'planning' }))
          : go('scheduling', { category: cat.id }),
      }, '前往分组与编排') : null,
    }));
    return;
  }
  if (!plan.stages.some((s) => s.pools.some((p) => p.kind !== 'bracket'))) {
    panel.append(h('div.info-box', '本项目没有循环赛排名。淘汰赛按晋级、决赛及名次赛结果确定名次，请在下方核对项目名次。'));
    return;
  }
  for (const stage of plan.stages) {
    for (const pool of stage.pools) {
      if (pool.kind === 'bracket') continue;
      if (state.user.role === 'viewer' && pool.status !== 'confirmed') continue;
      const block = h('div.stage-block', { id: `pool-${pool.id}`, tabindex: '-1' },
        h('div.row.tight',
          h('h4', `${stage.name} / ${pool.name}`),
          poolBadge(pool),
          pool.rank_from ? h('span.badge.badge-info', `目标名次 第${pool.rank_from}—${pool.rank_to}名`) : null));
      const box = h('div');
      block.append(box);
      panel.append(block);
      // 确认会更新小组状态、后续晋级名单和项目名次，需要重新读取整个成绩区。
      await drawPool(box, pool, reload, client);
    }
  }
}

async function drawPool(box, pool, redraw, client = scopedClient()) {
  const data = await client.get(`/api/pools/${pool.id}/standings`);
  clear(box);
  if (data.needs_reconfirm) {
    box.append(h('div.warn-box.mb', '成绩变化后小组名次与已确认快照不一致，请重新确认名次。'));
  }
  box.append(h('div.table-scroll', table([
    { label: '名次', render: (r) => rowRank(r) },
    { label: '参赛主体', key: 'label' },
    { label: '场次', key: 'played', align: 'center' },
    { label: '胜', key: 'wins', align: 'center' },
    { label: '负', key: 'losses', align: 'center' },
    { label: '弃权', key: 'forfeits', align: 'center' },
    { label: '积分', key: 'points', align: 'center' },
    { label: '胜局', key: 'sets_won', align: 'center' },
    { label: '负局', key: 'sets_lost', align: 'center' },
    { label: 'C 值', key: 'c_text', align: 'center' },
    { label: '得分', key: 'points_won', align: 'center' },
    { label: '失分', key: 'points_lost', align: 'center' },
    { label: 'Z 值', key: 'z_text', align: 'center' },
    {
      label: '说明',
      render: (r) => h('span.small',
        r.status === 'tie_pending'
          ? h('span.badge.badge-warn', `需抽签（第${r.rank_from}—${r.rank_to}名）`)
          : (r.by_lot ? h('span.badge.badge-info', '抽签确定') : (r.ratio_note || ''))),
    },
  ], data.rows)));
  if (data.excluded.length) {
    box.append(h('div.small.muted.mt',
      `未计入排名的场次：${data.excluded.map((e) => `#${e.match_id}（${e.reason}）`).join('；')}`));
  }
  if (data.unresolved.length && canWrite()) {
    for (const group of data.unresolved) {
      box.append(h('div.row.mt',
        h('div.warn-box', { style: 'flex:1' },
          `第${group.rank_from}—${group.rank_to}名并列：${group.members.map((m) => m.label).join('、')}，需录入抽签结果`),
        h('button.btn.btn-primary', { onclick: () => openLots(pool, group, redraw, data.base_results, client) }, '录入抽签')));
    }
  }
  if (!canWrite()) return;

  /* 阻断原因直接写在按钮旁，不只给一个点了才报错的按钮（§13.1） */
  const blockers = [];
  if (data.unresolved.length) blockers.push(`${data.unresolved.length} 组并列名次未抽签`);
  const incomplete = (data.incomplete_matches || []).length;
  if (incomplete) blockers.push(`${incomplete} 场未完成`);

  const doConfirm = async (extra = {}) => {
    try {
      const res = await client.post(`/api/pools/${pool.id}/confirm`, { ...extra,
        base_results: data.base_results, base_confirmation: data.base_confirmation });
      toast(res.message, 'ok');
      if (res.affected.length) {
        modal({
          title: '需要人工处理的后续场次',
          body: h('ul.hint-list', ...res.affected.map((a) => h('li', `${a.reason}（场次 ${a.match_id}）`))),
        });
      }
      await redraw();
    } catch (e) {
      if (e.code === 'matches_incomplete') { askForceConfirm(e.detail || {}); return; }
      toast(e.code === 'tie_pending' ? '存在并列名次未抽签，请先录入抽签结果' : e.message, 'error');
    }
  };

  function askForceConfirm(detail) {
  const reason = textInput('', { placeholder: '请输入确认原因' });
    reason.dataset.field = 'reason';
    formDialog({
      title: '该小组还有未完成的场次',
      width: 'min(520px, 94vw)',
      sections: [{
        body: h('div',
          h('div.warn-box', `未完成场次：${(detail.matches || [])
            .map((m) => `#${m.match_id} ${m.round_label}`).join('、') || '（未列出）'}`),
          h('p.small.mt', '强制确认会按当前已完成的成绩锁定晋级签位，之后补打的场次不会自动改写签位。'
            + '原因将记入操作日志。'),
          field('强制确认原因', reason, { required: true, name: 'reason' })),
      }],
      actions: [{
        label: '强制确认名次', primary: true, busyLabel: '确认中…',
        run: async ({ close }) => {
          if (!reason.value.trim()) {
            throw Object.assign(new Error('请填写强制确认的原因'),
              { detail: { fields: { reason: '请填写强制确认的原因' } } });
          }
          close();
          await doConfirm({ force: true, reason: reason.value.trim() });
        },
      }],
    });
  }

  box.append(h('div.row.mt',
    h('button.btn.btn-primary', {
      onclick: () => confirmDialog('确认小组名次',
        '确认后写入名次快照，用于解析后续对阵（小组第 N 名）与项目名次。并列未抽签的名次不能确认。',
        () => doConfirm({}), '确认名次'),
    }, pool.status === 'confirmed' ? '重新确认名次' : '确认小组名次'),
    canWrite() ? h('button.btn', {
      onclick: task(() => download('/api/exports/standings.csv', { pool_ids: pool.id })),
    }, '导出该小组') : null,
    blockers.length ? h('span.small.muted', `待处理：${blockers.join('；')}`) : null));
}

function rowRank(r) {
  if (r.status === 'tie_pending') return h('span.badge.badge-warn', '待确认');
  return h('b', { class: r.rank === 1 ? 'rank-1' : '' }, r.project_rank ? `第 ${r.project_rank} 名` : r.rank);
}

function poolBadge(pool) {
  const map = {
    pending: ['未开始', ''], running: ['进行中', 'info'], finished: ['已完成待确认', 'warn'],
    confirmed: ['名次已确认', 'ok'],
  };
  const [text, kind] = map[pool.status] || [pool.status, ''];
  return statusBadge(text, kind);
}

function openLots(pool, group, after, baseResults, client = scopedClient()) {
  const inputs = new Map();
  const preview = h('div.info-box.mt', '填写所有顺序后显示最终名次预览。');
  const body = h('div',
    h('div.info-box', `并列队伍：${group.members.map((m) => m.label).join('、')}。`
      + '请按现场抽签结果填写各队顺序（1 为先，名次靠前）。'),
    ...group.members.map((member) => {
      const input = h('input', {
        type: 'number', min: 1, max: group.members.length, value: '',
        'aria-label': `${member.label} 抽签顺序`,
        dataset: { field: `lot_${member.participation_id}` },
      });
      input.addEventListener('input', updatePreview);
      inputs.set(member.participation_id, input);
      return field(member.label, input, { name: `lot_${member.participation_id}` });
    }), preview);
  function checkedOrder() {
    const pairs = group.members.map((member) => ({
      ...member, raw: inputs.get(member.participation_id).value.trim(),
    }));
    const size = pairs.length;
    const errors = {};
    for (const p of pairs) {
      if (!/^[1-9]\d*$/.test(p.raw) || Number(p.raw) > size) {
        errors[`lot_${p.participation_id}`] = `请填写 1 至 ${size} 的整数`;
      }
    }
    for (const p of pairs) {
      if (p.raw && pairs.some((other) => other !== p && other.raw === p.raw)) {
        errors[`lot_${p.participation_id}`] = '该顺序与另一支队伍重复';
      }
    }
    if (Object.keys(errors).length) throw Object.assign(new Error('请核对每支队伍的抽签顺序'),
      { detail: { fields: errors } });
    return pairs.sort((a, b) => Number(a.raw) - Number(b.raw));
  }
  function updatePreview() {
    try {
      const order = checkedOrder();
      preview.textContent = order.map((p, i) => `第 ${group.rank_from + i} 名：${p.label}`).join('；');
    } catch (e) { preview.textContent = e.message; }
  }
  formDialog({
    title: `${pool.name} · 第${group.rank_from}—${group.rank_to}名抽签`,
    width: 'min(520px, 94vw)',
    sections: [{ body }],
    actions: [{
      label: '保存', primary: true, busyLabel: '保存中…',
      run: async ({ close }) => {
        const order = checkedOrder();
        await client.post(`/api/pools/${pool.id}/lots`, { order: order.map((p) => p.participation_id), base_results: baseResults });
        toast('抽签结果已保存', 'ok');
        close();
        after();
      },
    }],
  });
}

/* ------------------------------------------------------------------ 项目名次 */
async function drawPlacements(container, cat, reload, refresh, client = scopedClient()) {
  const panel = h('div.panel', h('h3', `${categoryLabel(cat)} · 项目名次与积分`));
  clear(container);
  container.append(panel);
  const pdata = await client.get(`/api/categories/${cat.id}/placements`);
  const prows = pdata.placements.map((p) => ({ ...p,
    display: cat.kind === 'team' ? p.school_name : `${p.school_name}·${p.subject}` }));
  if (!prows.length) {
    panel.append(emptyState({
      text: '尚未录入任何名次',
      hint: cat.kind === 'team'
        ? '确认小组名次后可按比赛结果推导项目名次，也可手工录入现场确认名次。'
        : '个人赛名次来自成绩录入页；未确认名次不计入学校团体总分。',
    }));
  } else {
    panel.append(h('div.table-scroll', table([
      {
        label: '名次', render: (p) => (p.status === 'confirmed'
          ? `第 ${p.rank_no} 名` : h('span.badge.badge-warn', '待确认')),
      },
      { label: '参赛主体', key: 'display' },
      { label: '基础分', key: 'base_points', align: 'center' },
      { label: '倍数', key: 'multiplier', align: 'center' },
      { label: '计入积分', key: 'points', align: 'center' },
      {
        /* 每个名次都标来源，不用列表排序冒充正式名次（§13.1） */
        label: '来源', render: (p) => h('span.small',
          statusBadge(SOURCE_TEXT[p.source] || p.source, p.status === 'confirmed' ? 'ok' : 'warn'),
          p.note ? ` · ${p.note}` : ''),
      },
      {
        label: '操作',
        render: (p) => (canWrite() ? h('button.btn.small.btn-danger', {
          onclick: async () => {
            const ok = await confirmAsync('删除名次',
              `确认删除 ${p.display} 的第 ${p.rank_no} 名？\n删除后会重算学校积分。`, '删除');
            if (!ok) return;
            try {
              await client.del(`/api/placements/${p.id}`);
              toast('已删除并重算积分', 'ok');
              reload();
            } catch (e) { toast(e.message, 'error'); }
          },
        }, '删除') : h('span.muted', '只读')),
      },
    ], prows)));
    const pending = prows.filter((p) => p.status !== 'confirmed');
    if (pending.length) {
      panel.append(h('div.warn-box.mt',
        `${pending.length} 项名次待确认，不计入学校团体总分。`));
    }
  }
  if (!canWrite()) return;
  panel.append(h('div.row.mt',
    cat.kind === 'team' ? h('button.btn.btn-primary', {
      onclick: async () => {
        try {
          const res = await client.post(`/api/categories/${cat.id}/placements/auto`, {});
          toast(`已按已确认结果写入 ${res.saved} 个名次`, 'ok');
          if (res.conflicts && res.conflicts.length) {
            modal({
              title: '部分名次未自动覆盖',
              body: h('ul.hint-list', ...res.conflicts.map((c) => h('li', `第${c.rank_no}名：${c.reason}`))),
            });
          }
          if (res.notes && res.notes.length) {
            modal({ title: '推导说明', body: h('ul.hint-list', ...res.notes.map((n) => h('li', n))) });
          }
          reload();
        } catch (e) { toast(e.message, 'error'); }
      },
    }, '按比赛结果推导名次') : null,
    cat.kind === 'team'
      ? h('button.btn', { onclick: () => openManualPlacement(cat, pdata.placements, reload, client) },
        '手工录入现场确认名次')
      : h('button.btn.btn-primary', { onclick: () => go('individual', { category: cat.id }) },
        '前往个人赛成绩录入'),
    h('div.small.muted', '系统不会为未完成比赛或未确认名次补造结果。')));
}

/* 手工录入名次：从有效报名名单里选，不再靠名称模糊匹配（§13.1） */
async function openManualPlacement(cat, existing, reload, client = scopedClient()) {
  const parts = (await client.get(`/api/categories/${cat.id}/participations`)).participations
    .filter((p) => p.status === 'active');
  if (!parts.length) {
    toast('该项目还没有有效报名，无法录入名次', 'error');
    return;
  }
  const pick = searchSelect(parts.map((p) => ({
    value: p.id, label: p.display, hint: p.seed_no ? `${p.seed_no} 号种子` : '',
  })), '', { placeholder: '搜索并选择参赛主体' });
  pick.dataset.field = 'participation_id';
  const rank = h('input', { type: 'number', min: 1, placeholder: '名次' });
  rank.dataset.field = 'rank_no';
  const note = textInput('', { placeholder: '请输入确认说明（可选）' });
  note.dataset.field = 'note';
  formDialog({
    title: '手工录入现场确认名次',
    subtitle: categoryLabel(cat, { withGroup: true }),
    width: 'min(560px, 94vw)',
    sections: [{
      body: h('div',
      h('div.info-box', '用于比赛结果无法自动决定、需要现场确认的名次。'
          + '录入并确认后即计入学校团体总分。'),
        existing.length ? h('div.small.muted.mt',
          `已录入：${existing.map((p) => `第${p.rank_no ?? '?'}名 ${cat.kind === 'team'
            ? p.school_name : `${p.school_name}·${p.subject}`}`).join('；')}`) : null,
        h('div.form-grid.mt',
          field('参赛主体', pick, { required: true, name: 'participation_id' }),
          field('名次', rank, { required: true, name: 'rank_no', hint: '并列名次需现场确认后再填' }),
          field('说明', note, { name: 'note' }))),
    }],
    actions: [{
      label: '保存并确认', primary: true, busyLabel: '保存中…',
      run: async ({ close }) => {
        if (!pick.value) {
          throw Object.assign(new Error('请选择参赛主体'),
            { detail: { fields: { participation_id: '请选择参赛主体' } } });
        }
        const rankNo = Number(rank.value);
        if (!Number.isInteger(rankNo) || rankNo < 1) {
          throw Object.assign(new Error('名次必须是不小于 1 的整数'),
            { detail: { fields: { rank_no: '名次必须是不小于 1 的整数' } } });
        }
        await client.post(`/api/categories/${cat.id}/placements`, {
          participation_id: Number(pick.value), rank_no: rankNo,
          note: note.value.trim(), confirm: true,
        });
        toast('名次已保存并计入积分', 'ok');
        close();
        reload();
      },
    }],
  });
}

registerView({ name: 'results', label: '小组与项目成绩', roles: ['admin', 'organizer', 'recorder', 'viewer'], render });

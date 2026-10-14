/* 自动辅助编排：仅在组委会需要系统协助时使用，不作为官方赛程的默认来源。 */
import { api } from '../api.js';
import { defaultFlow, flowPreview, flowStages, inferFlow, groupName } from '../schedulingFlow.js';
import { renderGroupDraw } from '../groupDraw.js';
import { registerView, state, go, loadStructure } from '../main.js';
import {
  h, field, textInput, numberInput, selectInput, checkbox, table, toast, modal,
  confirmDialog, confirmAsync, formDialog, promptDialog, clear, statusBadge, matchStatusBadge,
  categoryLabel,
} from '../ui.js';

const SOURCE_TYPES = [
  ['pool_rank', '某小组第 N 名'],
  ['match_winner', '某场胜者'],
  ['match_loser', '某场负者'],
  ['stage_round_winner', '某轮次全部胜者'],
  ['stage_round_loser', '某轮次全部负者'],
  ['bye', '轮空'],
  ['participations', '本项目全部参赛主体'],
];

const canWrite = () => ['admin', 'organizer'].includes(state.user.role);
const isAdmin = () => state.user.role === 'admin';

const STATUS_TEXT = {
  draft: ['待生成预览', 'warn'], previewed: ['预览待核对', 'info'], locked: ['已锁定', 'ok'],
  running: ['执行中', 'ok'], archived: ['已归档', ''],
};

async function render({ el, params }) {
  if (!state.eventId) throw new Error('请先在“赛事概览”中创建赛事');
  const structure = await loadStructure();
  const teamCats = [];
  for (const g of structure.groups) {
    for (const c of g.categories) if (c.kind === 'team') teamCats.push({ ...c, group_name: g.name });
  }
  if (!teamCats.length) throw new Error('当前赛事没有三人赛项目');
  const catId = Number(params.category || teamCats[0].id);
  const cat = teamCats.find((c) => c.id === catId) || teamCats[0];
  const embedded = params.embedded === 'workspace';
  const refreshView = () => {
    clear(el);
    render({ el, params }).catch(error => toast(error.message, 'error'));
  };
  const [data, registrations] = await Promise.all([
    api.get(`/api/categories/${cat.id}/plan`), api.get(`/api/categories/${cat.id}/participations`),
  ]);

  el.append(h('div.panel',
    h('div.panel-head',
      h(embedded ? 'h3' : 'h2', '小组抽签与辅助编排'),
      embedded ? null : h('div.row.tight', field('项目', selectInput(
        teamCats.map((c) => [c.id, `${categoryLabel(c, { withGroup: true })} · 参赛 ${c.participants}`]),
        cat.id, {
          onchange: (e) => { location.hash = `#/scheduling?category=${e.target.value}`; },
        }))),
    ),
    h('div.info-box', '可先抽签并确认学校分组，再生成赛程预览。锁定前请核对比赛流程、晋级路径及场地时间。'),
  ));

  let editor;
  let drawData;
  if (canWrite()) {
    drawData = await api.get(`/api/categories/${cat.id}/group-draw`);
    el.append(renderGroupDraw(cat, drawData, (draw) => editor?.applyDraw(draw)));
  }

  if (data.plan) {
    el.append(await renderPlanPanel(cat, data, refreshView, params));
  } else if (!canWrite()) {
    el.append(h('div.panel', h('div.info-box', '该项目尚未编排方案，请联系编排人员或管理员。')));
  }
  if (canWrite() && !['locked', 'running'].includes(data.plan?.status)) {
    editor = renderEditor({ ...cat, participants: registrations.participations.filter((p) => p.status === 'active').length }, data, drawData, refreshView);
    el.append(editor);
  }
  if (params.draw) el.querySelector('#group-draw')?.scrollIntoView({ block: 'start' });
  if (params.stage) {
    const block = el.querySelector(`#stage-${Number(params.stage)}`);
    if (block) requestAnimationFrame(() => { block.scrollIntoView({ block: 'start' }); block.focus({ preventScroll: true }); });
  }
}

/* ------------------------------------------------------------------ 方案 */
async function renderPlanPanel(cat, data, refreshView, params) {
  const plan = data.plan;
  const [text, kind] = STATUS_TEXT[plan.status] || [plan.status, ''];
  const panel = h('div.panel',
    h('div.panel-head',
      h('h3', `${plan.name}（v${plan.version}）`),
      h('div.row.tight',
        statusBadge(text, kind),
        plan.locked_at ? h('span.small.muted', `锁定于 ${plan.locked_at}`) : null)),
  );
  const acts = h('div.row');
  if (!isAdmin() && plan.status === 'previewed') panel.append(h('div.info-box.mb', '赛程预览待赛事管理员确认；确认前不能领取自动编排的比赛记录任务。'));
  if (canWrite() && ['draft', 'previewed'].includes(plan.status)) {
    acts.append(h('button.btn.btn-primary', {
      onclick: async () => {
        try {
          const res = await api.post(`/api/plans/${plan.id}/generate`);
          toast(`已生成 ${res.matches_total} 场（待前序结果 ${res.matches_pending} 场）`, 'ok');
          if (res.warnings.length) {
            modal({ title: '编排提示（请在锁定前核对）', body: h('ul.hint-list', ...res.warnings.map((w) => h('li', w))) });
          }
          refreshView();
        } catch (e) { toast(e.message, 'error'); }
      },
    }, '生成 / 重新生成赛程'));
  }
  if (isAdmin() && ['previewed', 'draft'].includes(plan.status)) {
    acts.append(h('button.btn.btn-primary', {
      onclick: () => confirmDialog('锁定方案',
        '锁定后记录员只能按已安排场次录入成绩，不能改变赛制、分组或晋级路径。确认锁定？',
        async () => {
          /* 失败要抛出去，确认框才会保持打开（§9.2） */
          await api.post(`/api/plans/${plan.id}/lock`);
          toast('方案已锁定', 'ok');
          refreshView();
        }, '锁定方案'),
    }, '锁定方案'));
  }
  if (isAdmin() && ['locked', 'running'].includes(plan.status)) {
    acts.append(h('button.btn', {
      onclick: async () => {
        const impact = await api.get(`/api/plans/${plan.id}/impact`);
        const rows = impact.dependency.flatMap((d) => d.downstream);
        modal({
          title: '解锁方案',
          body: h('div',
            h('div.warn-box', '已有比赛结果时解锁会保留原版本并提升版本号；已完成的后续场次需要人工处理，不会被自动改写。'),
            h('h4.mt', `受影响场次（${rows.length}）`),
            rows.length ? h('div.table-scroll', table([
              { label: '场次', key: 'match_id' },
              { label: '轮次', key: 'round_label' },
              { label: '状态', render: (r) => r.status },
            ], rows)) : h('div.small.muted', '暂无依赖已确认结果的后续场次')),
          buttons: [{
            label: '确认解锁', class: 'btn-danger',
            onClick: async () => {
              /* 解锁原因用页内输入框，可核对后再提交（§9.1、Q11） */
              const reason = await promptDialog({
                title: '解锁原因', label: '原因', value: '调整分组',
                required: true, multiline: true, okLabel: '解锁并归档原版本',
                hint: '原因会记入操作日志。',
              });
              if (!reason) return;
              await api.post(`/api/plans/${plan.id}/unlock`, { force: true, reason });
              toast('已解锁并归档原版本', 'ok');
              refreshView();
            },
          }],
        });
      },
    }, '解锁 / 变更影响'));
  }
  panel.append(acts);

  /* 阶段与场次 */
  for (const stage of plan.stages) {
    const block = h('div.stage-block', { id: `stage-${stage.id}`, tabindex: '-1' },
      h('div.row.tight',
        h('h4', `${stage.seq}. ${stage.name}`),
        statusBadge(stage.kind_name, 'info'),
        h('span.small.muted', `场次 ${stage.matches.length}`)),
    );
    if (stage.note) block.append(h('div.small.muted', stage.note));
    const generatedRound = Math.max(0, ...stage.matches.map(m => Number(m.round_no)));
    if (canWrite() && ['locked', 'running'].includes(plan.status) && stage.kind === 'swiss'
      && generatedRound > 0 && generatedRound < Number(stage.params.rounds || 0)
      && stage.matches.filter(m => m.round_no === generatedRound).every(m => ['finished', 'void'].includes(m.status))) {
      block.append(h('div.row.mt', h('span.small.muted', `已确认第 ${generatedRound} 轮，共 ${stage.params.rounds} 轮`),
        h('button.btn.btn-primary', { onclick: () => confirmDialog('生成下一轮对阵',
          `${stage.name} 第 ${generatedRound} 轮已完成。按已确认成绩生成第 ${generatedRound + 1} 轮配对？`,
          async () => {
            await api.post(`/api/stages/${stage.id}/next-round`);
            toast(`已生成第 ${generatedRound + 1} 轮对阵`, 'ok'); refreshView();
          }, '生成对阵') }, `生成第 ${generatedRound + 1} 轮对阵`)));
    }
    for (const pool of stage.pools) {
      const poolMatches = stage.matches.filter((m) => m.pool_id === pool.id);
      block.append(h('div.pool-card',
        h('h4', `${pool.name} · ${pool.status === 'confirmed' ? '名次已确认' : pool.status === 'finished' ? '已完成' : '进行中'}`),
        h('div.row.tight', ...pool.members.map((m) => h('span.chip',
          `${m.seed_no ? `${m.seed_no}. ` : ''}${m.display}`))),
        poolMatches.length ? h('div.table-scroll', table([
          { label: '轮次', key: 'round_label' },
          { label: '主队/选手', render: (m) => sideText(m.home) },
          { label: '客队/选手', render: (m) => sideText(m.away) },
          { label: '状态', render: (m) => matchStatusBadge(m) },
          {
            label: '比分', render: (m) => (m.sets.length
              ? m.sets.map((s) => `${s.home_points}:${s.away_points}`).join(' ') : ''),
          },
          {
            label: '',
            render: (m) => (m.status === 'ready' || m.status === 'finished'
              ? h('button.btn.small', { onclick: () => go('scoring', { match: m.id, category: cat.id,
                ...(params.embedded === 'workspace' ? { from: 'workspace' } : {}) }),
                disabled: m.status === 'ready' && m.can_score === false,
                title: m.status === 'ready' ? m.blocked_reason || '' : '' },
              m.status === 'finished' ? '查看成绩' : m.can_score === false ? '等待方案锁定' : '记录')
              : null),
          },
        ], poolMatches)) : h('div.small.muted', '暂无场次'),
      ));
    }
    panel.append(block);
  }
  return panel;
}

function sideText(side) {
  if (side.type === 'bye') return h('span.muted', '轮空');
  if (side.label) return side.label;
  const byType = {
    pool_rank: () => `小组第${side.source_rank}名`,
    match_winner: () => '前场胜者',
    match_loser: () => '前场负者',
  };
  const text = (byType[side.type] || (() => '待定'))();
  return h('span.muted', { title: side.reason || '' }, `${text}（待定）`);
}

/* ------------------------------------------------------------------ 编辑器 */
function renderEditor(cat, data, drawData, refreshView) {
  const catalog = data.available_formats;
  const stages = data.plan?.params?.stages ? JSON.parse(JSON.stringify(data.plan.params.stages)) : [];
  const count = Number(cat.participants || 0);
  let flow = inferFlow(stages, count) || defaultFlow(count);
  let advanced = stages.length > 0 && !inferFlow(stages, count);
  let confirmedDraw = drawData?.draw?.status === 'confirmed' && !drawData.draw.stale ? drawData.draw : null;
  const panel = h('div.panel', h('h3', '比赛流程设置'),
    h('div.small.muted.mb', `已报名 ${count} 支队伍。设置比赛流程后查看赛程预览，核对后再锁定。`));
  const listBox = h('div');
  const guidedBox = h('div.schedule-flow');
  const advancedBox = h('div',
    h('div.info-box.mb', '高级自定义：按比赛顺序设置阶段，再为后续阶段指定参赛来源。'), listBox);

  const drawStages = () => {
    clear(listBox);
    stages.forEach((st, idx) => {
      const meta = catalog.find((c) => c.kind === st.kind) || { params: [] };
      const box = h('div.stage-item');
      const kindSelect = selectInput(catalog.map((c) => [c.kind, c.name]), st.kind, {
        onchange: (e) => { st.kind = e.target.value; drawStages(); },
      });
      const nameInput = textInput(st.name || '', {
        placeholder: '阶段名称', oninput: (e) => { st.name = e.target.value; },
      });
      box.append(h('div.row.tight',
        h('span.badge', `第 ${idx + 1} 阶段`), field('类型', kindSelect), field('名称', nameInput),
        h('button.btn.small.btn-danger', {
          onclick: () => { stages.splice(idx, 1); drawStages(); },
        }, '删除阶段')));

      /* 参数 */
      st.params = st.params || {};
      const paramRow = h('div.row.tight.mt');
      for (const p of meta.params) {
        // 只跳过当前赛制下方已有专用控件的参数；评次赛等仍使用通用控件。
        const dedicated = st.kind === 'round_robin' ? ['pool_count', 'assign', 'legs']
          : st.kind === 'swiss' ? ['pool_count', 'assign', 'rounds'] : [];
        if (dedicated.includes(p.key)) continue;
        if (p.type === 'bool') {
          paramRow.append(checkbox(p.label, !!st.params[p.key], {
            onchange: (e) => { st.params[p.key] = e.target.checked; },
          }));
        } else if (p.type === 'select') {
          paramRow.append(field(p.label, selectInput(p.options.map((o) => [o, optionText(o)]),
            st.params[p.key] ?? p.default, {
              onchange: (e) => { st.params[p.key] = e.target.value; },
            })));
        } else {
          paramRow.append(field(p.label, numberInput(st.params[p.key] ?? p.default, {
            style: 'width:110px',
            oninput: (e) => { st.params[p.key] = Number(e.target.value); },
          })));
        }
      }

      /* 循环赛的小组配置 */
      if (st.kind === 'round_robin' || st.kind === 'swiss') {
        const fixed = !!st.params.draw_id;
        const poolCount = numberInput(st.params.pool_count ?? 1, {
          style: 'width:90px', min: 1, disabled: fixed,
          oninput: (e) => { st.params.pool_count = Number(e.target.value); drawStages(); },
        });
        const assign = selectInput([['snake', '蛇形均衡'], ['balanced', '人数均衡'], ['sequential', '顺序切分']],
          st.params.assign || 'snake', { disabled: fixed, onchange: (e) => { st.params.assign = e.target.value; } });
        paramRow.append(field('小组数量', poolCount), field('分组方式', assign));
        const members = st.params.members_text || '';
        const membersInput = textInput(members, {
        placeholder: '可选：用逗号分隔组内序号，用分号分隔不同小组',
          style: 'min-width:340px',
          disabled: fixed,
          oninput: (e) => { st.params.members_text = e.target.value; },
        });
        paramRow.append(field('自定义分组（留空按人数自动）', membersInput));
        if (fixed) paramRow.append(h('div.info-box', '使用上方已确认的抽签分组；调整分组须先撤销抽签。'));
      }
      if (st.kind === 'round_robin') {
        paramRow.append(field('循环次数', selectInput([[1, '单循环'], [2, '双循环']],
          st.params.legs ?? 1, { onchange: (e) => { st.params.legs = Number(e.target.value); } })));
      }
      if (st.kind === 'swiss') {
        paramRow.append(field('轮次数', numberInput(st.params.rounds ?? 5, {
          style: 'width:90px', oninput: (e) => { st.params.rounds = Number(e.target.value); },
        })));
      }
      if (paramRow.childNodes.length) box.append(paramRow);

      /* 签位来源 */
      if (idx > 0) {
        box.append(h('h4.mt', '签位来源（按顺序为 1 号、2 号…… 种子）'));
        const srcBox = h('div');
        st.params.sources = st.params.sources || [];
        const drawSources = () => {
          clear(srcBox);
          st.params.sources.forEach((src, si) => {
            const typeSelect = selectInput(SOURCE_TYPES, src.type, {
              onchange: (e) => { src.type = e.target.value; drawSources(); },
            });
            const row = h('div.src-row',
              h('div.small.muted', `第 ${si + 1} 号`),
              typeSelect,
            );
            if (src.type === 'pool_rank' || src.type === undefined || src.type === '') {
              row.append(
                numberInput(src.stage ?? 1, { placeholder: '阶段', min: 1, oninput: (e) => { src.stage = Number(e.target.value); } }),
                numberInput(src.pool ?? 0, { placeholder: '第几组(0起)', min: 0, oninput: (e) => { src.pool = Number(e.target.value); } }),
                numberInput(src.rank ?? 1, { placeholder: '名次', min: 1, oninput: (e) => { src.rank = Number(e.target.value); } }),
              );
            } else if (src.type === 'match_winner' || src.type === 'match_loser') {
              row.append(
                numberInput(src.stage ?? 1, { placeholder: '阶段', min: 1, oninput: (e) => { src.stage = Number(e.target.value); } }),
                numberInput(src.round ?? 1, { placeholder: '轮次', min: 1, oninput: (e) => { src.round = Number(e.target.value); } }),
                numberInput(src.index ?? 0, { placeholder: '第几场(0起)', min: 0, oninput: (e) => { src.index = Number(e.target.value); } }),
              );
            } else if (src.type === 'stage_round_winner' || src.type === 'stage_round_loser') {
              row.append(
                numberInput(src.stage ?? 1, { placeholder: '阶段', min: 1, oninput: (e) => { src.stage = Number(e.target.value); } }),
                numberInput(src.round ?? 1, { placeholder: '轮次', min: 1, oninput: (e) => { src.round = Number(e.target.value); } }),
              );
            } else if (src.type === 'bye') {
              row.append(h('div.small.muted', '轮空签位，不计实际比赛'));
            } else {
              row.append(h('div.small.muted', '本项目全部参赛主体（按种子顺序）'));
            }
            row.append(h('button.btn.small', {
              onclick: () => { st.params.sources.splice(si, 1); drawSources(); },
            }, '×'));
            srcBox.append(row);
          });
          srcBox.append(h('div.row.tight.mt',
            h('button.btn.small', {
              onclick: () => { st.params.sources.push({ type: 'pool_rank', stage: 1, pool: 0, rank: 1 }); drawSources(); },
            }, '+ 单个来源'),
            h('button.btn.small', {
              onclick: () => batchAdd(st, drawSources),
            }, '+ 批量：各小组同名次'),
            h('button.btn.small', {
              onclick: () => batchRound(st, 'stage_round_loser', drawSources),
            }, '+ 批量：某轮次全部负者（评次赛）'),
            h('button.btn.small', {
              onclick: () => batchRound(st, 'stage_round_winner', drawSources),
            }, '+ 批量：某轮次全部胜者'),
          ));
        };
        drawSources();
        box.append(srcBox);
      }
      listBox.append(box);
    });
    listBox.append(h('div.row.tight.mt',
      h('button.btn', {
        onclick: () => {
          stages.push({ kind: 'round_robin', name: `阶段${stages.length + 1}`, params: { legs: 1, pool_count: 1, assign: 'snake' } });
          drawStages();
        },
      }, '+ 添加阶段'),
      h('button.btn', {
        onclick: () => {
          stages.push({ kind: 'placement', name: `评次赛${stages.length + 1}`, params: { format: 'round_robin', rank_from: 1, rank_to: 2 } });
          drawStages();
        },
      }, '+ 添加评次赛'),
    ));
  };

  /* 签位来源用页内表单选择阶段与小组名称，不再用 window.prompt 让用户填内部序号
     （§9.1、§10.2、Q11） */
  const stageOptions = () => stages
    .map((s, i) => [i + 1, `第 ${i + 1} 阶段 · ${s.name || s.kind}`])
    .filter(([n]) => n < stages.length);

  function poolOptionsOf(stageNo) {
    const st = stages[stageNo - 1];
    if (!st) return [];
    const params = st.params || {};
    if (params.pools && params.pools.length) {
      return params.pools.map((p, i) => [i, p.name || `第 ${i + 1} 组`]);
    }
    const count = Number(params.pool_count || 1);
    return Array.from({ length: count }, (_, i) => [i, groupName(i, '小组')]);
  }

  const batchAdd = (st, after) => {
    const stageSel = selectInput(stageOptions(), stages.length - 1);
    const poolSel = selectInput(poolOptionsOf(Number(stageSel.value)) || [[0, '第 1 组']], 0);
    const allPools = checkbox('该阶段所有小组的同一名次都加入', true);
    const rank = numberInput(1, { min: 1, style: 'width:90px' });
    rank.dataset.field = 'rank';
    stageSel.onchange = () => {
      const opts = poolOptionsOf(Number(stageSel.value));
      clear(poolSel);
      for (const [v, label] of opts) poolSel.append(h('option', { value: v }, label));
      poolSel.value = opts[0]?.[0] ?? 0;
    };
    formDialog({
      title: '批量添加签位来源 · 各小组同名次',
      width: 'min(520px, 94vw)',
      sections: [{
        body: h('div.form-grid',
          field('来源阶段', stageSel, { name: 'stage' }),
          field('小组', poolSel, { name: 'pool', hint: '勾选“所有小组”时按该阶段全部小组生成' }),
          field('名次', rank, { required: true, name: 'rank' }),
          allPools),
      }],
      actions: [{
        label: '添加', primary: true,
        run: async ({ close }) => {
          const stageNo = Number(stageSel.value);
          const rankNo = Number(rank.value);
          if (!Number.isInteger(rankNo) || rankNo < 1) {
            throw Object.assign(new Error('名次必须是不小于 1 的整数'),
              { detail: { fields: { rank: '名次必须是不小于 1 的整数' } } });
          }
          const pools = allPools.input.checked
            ? poolOptionsOf(stageNo).map(([v]) => v)
            : [Number(poolSel.value)];
          for (const pool of pools) {
            st.params.sources.push({ type: 'pool_rank', stage: stageNo, pool, rank: rankNo });
          }
          close();
          toast(`已添加 ${pools.length} 个“小组第 ${rankNo} 名”来源`, 'ok');
          after();
        },
      }],
    });
  };

  const batchRound = (st, type, after) => {
    const stageSel = selectInput(stageOptions(), stages.length - 1);
    const round = numberInput(1, { min: 1, style: 'width:90px' });
    round.dataset.field = 'round';
    formDialog({
      title: type === 'stage_round_winner' ? '批量添加来源 · 某轮次全部胜者' : '批量添加来源 · 某轮次全部负者',
      width: 'min(480px, 94vw)',
      sections: [{
        body: h('div.form-grid',
          field('来源阶段', stageSel, { name: 'stage' }),
          field('轮次', round, { required: true, name: 'round', hint: '第一轮为 1' })),
      }],
      actions: [{
        label: '添加', primary: true,
        run: async ({ close }) => {
          const roundNo = Number(round.value);
          if (!Number.isInteger(roundNo) || roundNo < 1) {
            throw Object.assign(new Error('轮次必须是不小于 1 的整数'),
              { detail: { fields: { round: '轮次必须是不小于 1 的整数' } } });
          }
          st.params.sources.push({ type, stage: Number(stageSel.value), round: roundNo });
          close();
          toast('已添加轮次来源', 'ok');
          after();
        },
      }],
    });
  };

  drawStages();
  const modeButton = h('button.btn', { onclick: async () => {
    if (!advanced) {
      try {
        const next = flowStages(flow, count);
        if (stages.length === next.length) next.forEach((stage, i) => {
          if (stage.kind === stages[i].kind && stages[i].name) stage.name = stages[i].name;
        });
        stages.splice(0, stages.length, ...next);
        drawStages();
      } catch { /* 未满足常用流程条件时，仍可进入高级配置。 */ }
      advanced = true;
    } else {
      const inferred = inferFlow(serializeStages(stages), count);
      if (!inferred && stages.length && !await confirmAsync('切换到常用流程',
        '当前阶段包含自定义设置。切换后将用常用流程替换这些设置；保存前不会修改已存方案。', '切换')) return;
      flow = inferred || defaultFlow(count);
      advanced = false;
      drawFlow();
    }
    showMode();
  } }, '高级自定义');

  function showMode() {
    guidedBox.classList.toggle('hidden', advanced);
    advancedBox.classList.toggle('hidden', !advanced);
    modeButton.textContent = advanced ? '返回常用流程' : '高级自定义';
  }

  function drawFlow() {
    clear(guidedBox);
    const summary = h('div.schedule-summary', { 'aria-live': 'polite' });
    const updatePreview = () => {
      clear(summary);
      try {
        const preview = flowPreview(flow, count);
        if (flow.format === 'groups') {
          summary.append(h('p', preview.sizes.every((size) => size === preview.sizes[0])
            ? `${flow.groups} 组，每组 ${preview.sizes[0]} 队；每组前 ${flow.qualifiers} 名晋级，共 ${preview.advancing} 队。`
            : `各组队数：${preview.sizes.join('、')}；每组前 ${flow.qualifiers} 名晋级，共 ${preview.advancing} 队。`));
        }
        if (preview.pairs.length) summary.append(
          h('h4.form-section-title', flow.format === 'groups' ? '晋级后的首轮对阵' : '首轮对阵'),
          h('div.schedule-pairs', ...preview.pairs.map(([left, right]) => h('div.schedule-pair',
            h('span', left), h('span.small.muted', '对'), h('span', right)))));
        summary.append(h('p', `预计 ${preview.total} 场比赛` + (flow.format === 'groups'
          ? `：小组赛 ${preview.roundRobin} 场＋淘汰赛 ${preview.knockout} 场。` : '。')));
        if (flow.format !== 'league') summary.append(h('div.small.muted', preview.bronze
          ? '胜者逐轮晋级，决赛争夺冠军；半决赛负者参加三、四名决赛。'
          : '胜者逐轮晋级，直至决出冠军。'));
      } catch (error) { summary.append(h('div.warn-box', error.message)); }
    };
    const format = selectInput([['groups', '小组赛＋淘汰赛'], ['league', '仅循环赛'], ['knockout', '直接淘汰赛']], flow.format, {
      onchange: (event) => { flow.format = event.target.value; drawFlow(); },
    });
    guidedBox.append(field('比赛流程', format));
    if (flow.format !== 'knockout') {
      const fields = h('div.form-grid');
      if (flow.format === 'groups') {
        fields.append(field('分组数量', numberInput(flow.groups, {
          'aria-label': '分组数量',
          min: 1, step: 1,
          disabled: !!flow.draw_id,
          oninput: (event) => { flow.groups = Number(event.target.value); updatePreview(); },
        })));
        fields.append(field('每组晋级', selectInput([[1, '前 1 名'], [2, '前 2 名']], flow.qualifiers, {
          onchange: (event) => { flow.qualifiers = Number(event.target.value); updatePreview(); },
        })));
        if (flow.draw_id) fields.append(h('div.info-box', `使用已确认抽签 ${flow.draw_id}：各组 ${flow.draw_sizes.join('、')} 所学校。`));
        else fields.append(field('分组方式', selectInput([['snake', '按种子均衡分组'], ['balanced', '按顺序均分队伍'], ['sequential', '按顺序定额分组']], flow.assign, {
          onchange: (event) => { flow.assign = event.target.value; updatePreview(); },
        })));
      }
      fields.append(field('比赛方式', selectInput([[1, '单循环（组内各交手一次）'], [2, '双循环（组内各交手两次）']], flow.legs, {
        onchange: (event) => { flow.legs = Number(event.target.value); updatePreview(); },
      })));
      guidedBox.append(h('section.form-section', h('h4.form-section-title', flow.format === 'groups' ? '小组赛' : '循环赛'), fields));
    }
    if (flow.format !== 'league') {
      guidedBox.append(h('section.form-section', h('h4.form-section-title', '淘汰赛'),
        h('div.small.muted', flow.format === 'groups' ? '自动交叉对阵，具体配对见下方预览。' : '按已报名队伍的种子顺序配对，不足完整签位时自动轮空。'),
        checkbox('安排三、四名决赛（至少 4 队进入淘汰赛时生效）', flow.third, {
          onchange: (event) => { flow.third = event.target.checked; updatePreview(); },
        })));
    }
    guidedBox.append(summary);
    updatePreview();
  }
  panel.applyDraw = (draw) => {
    confirmedDraw = draw?.status === 'confirmed' && !draw.stale ? draw : null;
    delete flow.draw_id;
    delete flow.draw_sizes;
    for (const stage of stages) {
      if (stage.params) { delete stage.params.draw_id; delete stage.params.draw_sizes; }
    }
    if (confirmedDraw) {
      if (!advanced) flow.format = 'groups';
      flow.draw_id = confirmedDraw.id;
      flow.draw_sizes = confirmedDraw.capacities;
      flow.groups = confirmedDraw.capacities.length;
      const first = stages[0];
      if (first?.kind === 'round_robin' && !first.params?.sources) {
        first.params = { ...first.params, draw_id: confirmedDraw.id, draw_sizes: confirmedDraw.capacities,
          pool_count: confirmedDraw.capacities.length };
        delete first.params.pools;
        delete first.params.members_text;
      }
    }
    drawStages();
    drawFlow();
  };
  panel.applyDraw(confirmedDraw);
  showMode();
  panel.append(guidedBox, advancedBox, h('div.row.mt', modeButton));

  /* 保存与生成。主操作是“保存并生成预览”：先保存当前编辑，保存失败就不生成，
     避免用界面上还没落库的配置去生成（§10.5、Q06）。 */
  const savePlan = async () => {
    const next = advanced ? serializeStages(stages) : flowStages(flow, count);
    if (!advanced && stages.length === next.length) next.forEach((stage, i) => {
      if (stage.kind === stages[i].kind && stages[i].name) stage.name = stages[i].name;
    });
    const payload = { name: data.plan?.name || `${cat.name}方案`, stages: next };
    return api.post(`/api/categories/${cat.id}/plan`, payload);
  };

  const saveBtn = h('button.btn.btn-primary', { onclick: () => runSave() },
    '保存并查看赛程预览');

  async function runSave() {
    const actor = saveBtn;
    const label = actor.textContent;
    actor.disabled = true;
    saveBtn.disabled = true;
    guidedBox.inert = true;
    advancedBox.inert = true;
    modeButton.disabled = true;
    actor.textContent = '保存并生成中…';
    try {
      const saved = await savePlan();
      /* 用刚保存下来的方案生成，不用界面上的旧 plan id */
      const planId = saved.plan_id || data.plan?.id;
      const res = await api.post(`/api/plans/${planId}/generate`);
      toast(`已保存并生成 ${res.matches_total} 场（待前序结果 ${res.matches_pending} 场）`, 'ok');
      if (res.warnings.length) {
        modal({
          title: '编排提示（请在锁定前核对）',
          body: h('ul.hint-list', ...res.warnings.map((w) => h('li', w))),
        });
      }
      refreshView();
    } catch (e) {
      toast(e.message, 'error');       // 保存失败不生成，配置保留在界面上（§10.5）
    } finally {
      actor.disabled = false;
      saveBtn.disabled = false;
      guidedBox.inert = false;
      advancedBox.inert = false;
      modeButton.disabled = false;
      actor.textContent = label;
    }
  }

  panel.append(h('div.row.mt', saveBtn,
    h('div.small.muted', '修改后请重新生成赛程预览；预览不会自动锁定方案。')));
  return panel;
}

function serializeStages(stages) {
  return stages.map((st) => {
    const params = { ...(st.params || {}) };
    if (params.members_text) {
      const parts = String(params.members_text).split(';').map((s) => s.trim()).filter(Boolean);
      if (parts.length > 1) {
        params.pools = parts.map((p, i) => ({
          name: groupName(i, '小组'),
          members: p.split(',').map((x) => Number(x.trim()) - 1).filter((n) => !Number.isNaN(n)),
        }));
      }
    }
    delete params.members_text;
    if (params.sources) {
      params.sources = params.sources.filter((s) => s.type);
    }
    return { kind: st.kind, name: st.name, params };
  });
}

function optionText(value) {
  const map = {
    snake: '蛇形均衡', balanced: '人数均衡', sequential: '顺序切分',
    fold: '上下半区对折', adjacent: '相邻配对', none: '不授予', win: '记胜（2 分）',
    round_robin: '循环', single_elim: '淘汰',
  };
  return map[value] || String(value);
}

registerView({ name: 'scheduling', label: '分组与编排', roles: ['admin', 'organizer', 'recorder', 'viewer'], render });

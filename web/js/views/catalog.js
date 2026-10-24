/* 学校与人员：档案维护 + 各项目报名名单（改进方案 §3.3、§6、§8）。

   与旧版的区别：
   - 档案入口的主按钮写“保存档案”，不冒充报名（§6.4）；
   - 三人赛以学校为参赛单位，内部阵容记录不作为独立档案暴露；
   - 队长由用户显式单选，成员排序不再决定队长（§6.2、Q12）；
   - 种子序号行内编辑，不再用 window.prompt（Q11）；
   - 危险操作收进“更多”菜单，列表以浏览为主（§6.1、Q13）；
   - 所有保存都走统一编辑器：失败保留输入并定位错误，成功后只局部刷新（Q05、Q08）。 */
import { api } from '../api.js';
import { athletePicker } from '../athletePicker.js';
import { registerView, state, loadStructure, go } from '../main.js';
import {
  h, field, textInput, selectInput, searchSelect, integerInput, textarea, table, toast,
  formDialog, confirmAsync, clear, statusBadge, moreMenu, emptyState, filteredEmptyState,
  errorState, loadingState, categoryLabel,
} from '../ui.js';

const GENDER = { male: '男子', female: '女子' };
const KIND = { team: '三人赛', individual: '个人赛' };
const canWrite = () => ['admin', 'organizer'].includes(state.user.role);
const isAdmin = () => state.user.role === 'admin';

function newUid(prefix = 'req') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function render({ el, params }) {
  if (!state.eventId) throw new Error('请先在“赛事首页”中创建赛事');
  const structure = state.structure || await loadStructure();
  if (!structure.groups.length) {
    el.append(emptyState({
      text: '还没有组别',
      hint: '报名名单按组别组织。请先在“赛事设置”中添加组别与项目。',
    }));
    return;
  }
  const groupId = Number(params.group || structure.groups[0]?.id);
  const group = structure.groups.find((g) => g.id === groupId) || structure.groups[0];

  el.append(h('div.panel',
    h('div.panel-head', h('h2', '学校与人员'),
      h('div.row.tight', ...structure.groups.map((g) => h('button.btn', {
        class: g.id === group.id ? 'btn-primary' : '',
        onclick: () => { location.hash = `#/catalog?group=${g.id}`; },
      }, g.name.split('：')[0])))),
    h('div.small.muted', `${group.name} · 学校是唯一参赛单位；先维护学校与运动员，再在下方为具体项目选择参赛学校和名单。`),
  ));

  const schoolBox = h('div');
  el.append(schoolBox);
  await renderSchoolPanel(schoolBox, group);

  const partBox = h('div');
  el.append(partBox);
  await renderParticipationPanel(partBox, group);
}

/* ------------------------------------------------------------------ 学校列表 */
async function renderSchoolPanel(box, group) {
  const ui = { q: '', loading: true, error: null, schools: [] };
  const panel = h('div.panel');
  /* 工具条只建一次：搜索输入触发的重绘只换列表，不重建输入框，
     否则每敲一个字焦点和滚动位置都会丢（Q08） */
  const search = textInput('', {
    type: 'search', placeholder: '搜索学校名称或简称', 'aria-label': '搜索学校',
    oninput: (e) => { ui.q = e.target.value; drawList(); },
  });
  const listArea = h('div');
  panel.append(h('div.panel-head', h('div', h('h3', '学校与人员档案'),
    h('div.small.muted', '学校只需建立一次；运动员统一归入所属学校，项目报名只从这里选择。'))),
    h('div.list-toolbar',
      h('div.grow', search),
      canWrite() ? h('button.btn.btn-primary', {
        onclick: () => openSchoolEditor({ group, onSaved: load }),
      }, '新增学校') : h('span.small.muted', '当前角色只读')),
    listArea);
  clear(box);
  box.append(panel);

  async function load() {
    ui.loading = true; ui.error = null; drawList();
    try {
      ui.schools = (await api.get(`/api/events/${state.eventId}/schools?group_id=${group.id}`)).schools;
      ui.loading = false;
    } catch (e) { ui.loading = false; ui.error = e; }
    drawList();
  }

  function visible() {
    const kw = ui.q.trim().toLowerCase();
    if (!kw) return ui.schools;
    return ui.schools.filter((s) => `${s.name} ${s.short_name}`.toLowerCase().includes(kw));
  }

  function drawList() {
    clear(listArea);
    if (ui.loading) { listArea.append(loadingState('正在加载学校…')); return; }
    if (ui.error) { listArea.append(errorState(ui.error, load)); return; }
    if (!ui.schools.length) {
      listArea.append(emptyState({
        text: `${group.name}还没有学校`,
        hint: '学校加入组别后，才能维护运动员并报名该组别的项目。',
        action: canWrite() ? h('button.btn.btn-primary', {
          onclick: () => openSchoolEditor({ group, onSaved: load }),
        }, '新增第一所学校') : null,
      }));
      return;
    }
    const rows = visible();
    if (!rows.length) {
      listArea.append(filteredEmptyState(() => { ui.q = ''; search.value = ''; drawList(); }));
      return;
    }
    listArea.append(h('div.table-scroll', table([
      {
        label: '学校', render: (r) => h('a', {
          href: '#',
          onclick: (e) => { e.preventDefault(); openSchoolDetail(r, group, load); },
        }, r.name),
      },
      { label: '简称', key: 'short_name' },
      { label: '运动员', key: 'athlete_count', align: 'num' },
      { label: '三人赛项目', key: 'team_count', align: 'num' },
      {
        label: '操作', render: (r) => h('div.row.tight',
          canWrite() ? h('button.btn.small.btn-primary', {
            onclick: () => openAthleteEditor({ school: r, group, onSaved: load }),
          }, '添加人员') : null,
          h('button.btn.small', { onclick: () => openSchoolDetail(r, group, load) }, '详情'),
          canWrite() ? moreMenu([
            { label: '编辑学校', onClick: () => openSchoolEditor({ group, school: r, onSaved: load }) },
            isAdmin() ? { label: '删除学校', danger: true, onClick: () => removeSchool(r, load) } : null,
          ]) : null),
      },
    ], rows)));
  }

  load();
  return panel;
}

async function removeSchool(school, reload) {
  /* 删除档案要显示影响范围（§8.6）；有参赛引用时服务端会拒绝并说明原因 */
  let detail = null;
  try { detail = await api.get(`/api/schools/${school.id}/detail`); } catch { /* 拿不到就只给通用说明 */ }
  const impact = detail
    ? `将删除该校档案：${detail.athletes.length} 名运动员、${detail.teams.length} 个三人赛项目名单。\n已进入参赛名单的学校不能被删除。`
    : '将删除该校档案及其运动员、项目名单。';
  if (!await confirmAsync('删除学校', `${school.name}\n${impact}`, '确认删除')) return;
  await api.del(`/api/schools/${school.id}`);
  toast('已删除学校档案', 'ok');
  reload();
}

/* ------------------------------------------------------------------ 学校编辑 */
function openSchoolEditor({ group, school, onSaved }) {
  const name = textInput(school ? school.name : '', { placeholder: '学校全称' });
  const short = textInput(school ? school.short_name : '', { placeholder: '简称（成绩页显示）' });
  const note = textarea(school ? school.note : '');
  return formDialog({
    title: school ? '编辑学校' : '新增学校',
    subtitle: `${group.name} · 档案入口：保存后立即可在各项目中使用`,
    width: 'min(560px, 94vw)',
    sections: [{
      body: h('div.form-grid',
        field('学校名称', name, { required: true, name: 'name' }),
        field('简称', short, { name: 'short_name', hint: '成绩页与对阵图显示' }),
        field('备注', note, { name: 'note' })),
    }],
    actions: [{
      label: '保存档案', primary: true, busyLabel: '保存中…',
      run: async ({ close }) => {
        const payload = {
          name: name.value.trim(),
          short_name: short.value.trim() || name.value.trim(),
          note: note.value,
        };
        if (school) {
          await api.put(`/api/schools/${school.id}`, { ...payload, base_rev: school.rev });
          toast('已保存学校档案，尚未报名', 'ok');
        } else {
          await api.post(`/api/events/${state.eventId}/schools`, { ...payload, group_id: group.id });
          /* 文案区分“已保存档案”与“已报名”（§6.4） */
          toast('已保存学校档案，尚未报名；请在项目报名名单中选择该校', 'ok');
        }
        close();
        onSaved();
      },
    }],
  });
}

/* ------------------------------------------------------------------ 学校详情 */
async function openSchoolDetail(school, group, reload) {
  const body = h('div', loadingState('正在加载学校详情…'));
  const dlg = formDialog({
    title: school.name,
    subtitle: `${group.name} · 档案与各项目报名情况`,
    width: 'min(780px, 96vw)',
    sections: [{ body }],
    actions: canWrite() ? [{
      label: '编辑学校档案', primary: true,
      run: async ({ close }) => { close(); openSchoolEditor({ group, school, onSaved: reload }); },
    }] : [],
  });
  const refreshAll = async () => {
    try {
      const d = await api.get(`/api/schools/${school.id}/detail`);
      clear(body);
      body.append(...detailSections(d, group, reload, refreshAll));
    } catch (e) { clear(body); body.append(errorState(e, refreshAll)); }
    reload();
  };
  try {
    const d = await api.get(`/api/schools/${school.id}/detail`);
    clear(body);
    body.append(...detailSections(d, group, reload, refreshAll));
  } catch (e) {
    clear(body);
    body.append(errorState(e));
  }
  return dlg;
}

function detailSections(d, group, reload, refreshAll) {
  return [
    h('div.row.tight.small.muted',
      h('span', `简称：${d.school.short_name || '—'}`),
      d.group ? h('span.badge.badge-info', d.group.group_name) : null),
    athleteSection(d, group, refreshAll),
    teamSection(d, group, reload, refreshAll),
    individualSection(d),
  ];
}

function athleteSection(d, group, refreshAll) {
  const box = h('div');
  const title = h('h4.form-section-title', `运动员（${d.athletes.length}）`);
  const draw = () => {
    title.textContent = `运动员（${d.athletes.length}）`;
    clear(box);
    if (!d.athletes.length) {
      box.append(emptyState({
        text: '还没有运动员',
        hint: '运动员用于个人赛报名与三人赛队员名单。',
        action: canWrite() ? h('button.btn.btn-primary', {
          onclick: () => openAthleteEditor({ school: d.school, group, onSaved: refreshAll }),
        }, '新增运动员') : null,
      }));
      return;
    }
    box.append(h('div.table-scroll', table([
      { label: '姓名', key: 'name' },
      {
        label: '性别', render: (a) => (a.gender
          ? statusBadge(GENDER[a.gender], a.gender === 'male' ? 'info' : '')
          : statusBadge('未填性别', 'warn')),
      },
      { label: '常用号码', key: 'jersey_no' },
      {
        label: '操作', render: (a) => (canWrite() ? h('div.row.tight',
          h('button.btn.small', {
            onclick: () => openAthleteEditor({ school: d.school, group, athlete: a, onSaved: refreshAll }),
          }, '编辑'),
          moreMenu([{ label: '删除运动员', danger: true, onClick: () => removeAthlete(a, refreshAll) }])) : '—'),
      },
    ], d.athletes)));
    if (canWrite()) {
      box.append(h('div.row.mt', h('button.btn', {
        onclick: () => openAthleteEditor({ school: d.school, group, onSaved: refreshAll }),
      }, '新增运动员')));
    }
  };
  draw();
  return h('section.form-section', title, box);
}

async function removeAthlete(a, after) {
  const ok = await confirmAsync('删除运动员',
    `${a.name}\n将从档案中删除该运动员。\n已进入参赛名单或某支队伍名单的运动员不能被删除。`, '确认删除');
  if (!ok) return;
  await api.del(`/api/athletes/${a.id}`);
  toast('已删除运动员', 'ok');
  after();
}

function teamSection(d, group, reload, refreshAll) {
  const box = h('div');
  if (!d.teams.length) {
    box.append(emptyState({
      text: '尚未参加三人赛项目',
      hint: '请在下方“报名名单（按项目）”中选择该校，并设置项目队员名单。',
    }));
  } else {
    for (const t of d.teams) {
      box.append(h('div.pool-card',
        h('div.row.tight',
          h('b', categoryLabel(t, { withGroup: true })),
          t.participation
            ? statusBadge(t.participation.status === 'active' ? '已报名' : '已退出',
              t.participation.status === 'active' ? 'ok' : 'warn')
            : statusBadge('未报名', ''),
          t.profile_gaps.length ? statusBadge(t.profile_gaps.join('、'), 'warn') : null),
        h('div.small.muted.mt', t.members.length
          ? `队员：${t.members.map((m) => `${m.name}${m.jersey_no ? `（${m.jersey_no}）` : ''}`).join('、')}`
          : '队员：待补充'),
        h('div.small.muted', t.captain_name ? `队长：${t.captain_name}` : '队长：待指定'),
        canWrite() ? h('div.row.tight.mt',
          h('button.btn.small', {
            onclick: () => openTeamEditor({
              group, school: d.school,
              category: { id: t.category_id, name: t.category_name, kind: t.kind, gender: t.gender, group_id: group.id },
              team: t, onSaved: refreshAll,
            }),
          }, '编辑项目名单'),
          t.participation ? null : h('button.btn.small.btn-primary', {
            onclick: async () => {
              try {
                await api.post(`/api/categories/${t.category_id}/participations`, { team_id: t.id });
                toast(`已报名「${categoryLabel(t)}」`, 'ok');
                refreshAll();
                reload();
              } catch (e) { toast(e.message, 'error'); }
            },
          }, '报名')) : null));
    }
  }
  return h('section.form-section', h('h4.form-section-title', `三人赛项目（${d.teams.length}）`), box);
}

function individualSection(d) {
  if (!d.individual_entries.length) return null;
  return h('section.form-section', h('h4.form-section-title', '个人赛报名情况'),
    h('div.table-scroll', table([
      { label: '组别', render: (r) => r.group_name.split('：')[0] },
      { label: '项目', render: (r) => categoryLabel(r) },
      { label: '运动员', key: 'athlete_name' },
      { label: '种子', render: (r) => r.seed_no ?? '—', align: 'num' },
      {
        label: '状态', render: (r) => statusBadge(r.status === 'active' ? '已报名' : '已退出',
          r.status === 'active' ? 'ok' : 'warn'),
      },
    ], d.individual_entries)));
}

/* ------------------------------------------------------------------ 运动员编辑 */
function openAthleteEditor({ school, group, athlete, onSaved }) {
  const name = textInput(athlete ? athlete.name : '', { placeholder: '姓名' });
  const gender = selectInput([['', '未填'], ['male', '男子'], ['female', '女子']],
    athlete ? athlete.gender : '');
  const jersey = textInput(athlete ? athlete.jersey_no : '', { placeholder: '常用号码' });
  const note = textarea(athlete ? athlete.note : '');
  const reuseGender = checkboxLike('连续添加时沿用本次性别');

  const save = async () => {
    const payload = {
      name: name.value.trim(), gender: gender.value,
      jersey_no: jersey.value.trim(), note: note.value,
    };
    if (athlete) {
      await api.put(`/api/athletes/${athlete.id}`, { ...payload, base_rev: athlete.rev });
      toast('已保存运动员档案，尚未报名', 'ok');
    } else {
      const res = await api.post(`/api/schools/${school.id}/athletes`, payload);
      /* 同名只作候选提示，不自动合并（§8.2） */
      if (res.same_name_candidates && res.same_name_candidates.length) {
        toast(`已保存档案；该校已有 ${res.same_name_candidates.length} 名同名运动员，请核对是否重复`, 'ok');
      } else {
        toast('已保存运动员档案，尚未报名', 'ok');
      }
    }
    onSaved();
    return payload;
  };

  const actions = [{
    label: '保存档案', primary: true, busyLabel: '保存中…',
    run: async ({ close }) => { await save(); close(); },
  }];
  if (!athlete) {
    actions.push({
      label: '保存并继续添加', busyLabel: '保存中…', keepOpen: true,
      run: async ({ reset: resetForm }) => {
        const payload = await save();
        /* §8.2：保留学校；姓名、号码、备注清空；性别只在用户明确开启时沿用 */
        const keepGender = reuseGender.input.checked && payload.gender;
        resetForm([]);
        gender.value = keepGender ? payload.gender : '';
        reuseGender.input.checked = keepGender;
        name.focus();
      },
    });
  }

  return formDialog({
    title: athlete ? `编辑运动员 · ${athlete.name}` : '新增运动员',
    subtitle: `${school.name} · ${group.name} · 档案入口`,
    width: 'min(520px, 94vw)',
    sections: [{
      body: h('div.form-grid',
        field('姓名', name, { required: true, name: 'name' }),
        field('性别', gender, { name: 'gender', hint: '未知性别不会被自动改写，请按需补齐' }),
        field('常用号码', jersey, { name: 'jersey_no', hint: '具体项目的报名号码可在项目名单中调整' }),
        field('备注', note, { name: 'note' }),
        athlete ? null : reuseGender),
    }],
    actions,
  });
}

/* checkbox 需要暴露内部 input 给“沿用性别”逻辑读取 */
function checkboxLike(label) {
  const input = h('input', { type: 'checkbox' });
  const wrap = h('label.row.tight', null, input, h('span', label));
  wrap.input = input;
  return wrap;
}

/* ------------------------------------------------------------------ 三人赛项目名单编辑（内部仍使用 team 记录兼容赛程） */
async function openTeamEditor({ group, school, category, team, onSaved }) {
  const teamCats = category ? [category] : group.categories.filter((c) => c.kind === 'team');
  if (!teamCats.length) {
    toast(`${group.name}还没有三人赛项目，请先在“赛事设置”中添加`, 'error');
    return null;
  }
  const cat = teamCats[0];
  const displayName = school.short_name || school.name;
  const noteInput = textarea(team ? team.note : '');
  const enrolled = team ? team.participation : null;
  const seedInput = integerInput(enrolled ? enrolled.seed_no : '', { placeholder: '留空表示未指定' });

  const memberBox = h('div');
  const captainBox = h('div');
  let athletes = [];
  const picked = new Map();          // athlete_id -> { jersey, checked }
  let captainId = team ? (team.captain_id ?? null) : null;
  /* 请求标识在打开时生成、成功后才更换：超时重试才能命中同一次提交（§15.3、T05） */
  let uid = newUid();

  async function loadAthletes() {
    athletes = (await api.get(`/api/schools/${school.id}/athletes`)).athletes;
    for (const a of athletes) {
      if (!picked.has(a.id)) picked.set(a.id, { jersey: a.jersey_no || '', checked: false });
    }
    if (team && team.members) {
      for (const m of team.members) picked.set(m.id, { jersey: m.jersey_no ?? '', checked: true });
    }
    drawMembers();
  }

  function drawMembers() {
    clear(memberBox);
    const list = athletes.filter((a) => !a.gender || a.gender === cat.gender);
    const skipped = athletes.length - list.length;
    if (!list.length) {
      memberBox.append(emptyState({
        text: '该校还没有可选队员',
        hint: '请先在本页上方的学校档案中添加运动员；性别与项目不符的运动员不会出现在这里。',
      }));
      drawCaptain();
      return;
    }
    for (const a of list) {
      const entry = picked.get(a.id);
      const box = h('input', { type: 'checkbox', checked: entry.checked, 'aria-label': `选择 ${a.name}` });
      /* 本队报名号码：预填常用号码，修改不回写运动员档案（§6.2） */
      const jersey = textInput(entry.jersey, {
        class: 'jersey-input', placeholder: '号码', 'aria-label': `${a.name} 本队号码`,
        oninput: (e) => { entry.jersey = e.target.value; },
      });
      box.onchange = () => {
        entry.checked = box.checked;
        if (!box.checked && captainId === a.id) {
          /* 删除当前队长后清空并要求重新指定（§6.5） */
          captainId = null;
          toast('已移除队长，请重新指定', 'error');
        }
        drawCaptain();
      };
      memberBox.append(h('label.row.tight.member-row', box,
        h('span.grow', `${a.name}${a.gender ? '' : '（性别未填）'}`),
        a.jersey_no ? h('span.small.muted.nowrap', `常用 ${a.jersey_no}`) : null,
        jersey));
    }
    if (skipped > 0) {
      memberBox.append(h('div.small.muted.mt', `另有 ${skipped} 名运动员性别与本项目不符，未列出。`));
    }
    memberBox.append(h('div.small.muted.mt', '人员档案统一在本页上方维护。'));
    drawCaptain();
  }

  function drawCaptain() {
    clear(captainBox);
    const selected = athletes.filter((a) => (picked.get(a.id) || {}).checked);
    if (!selected.length) {
      captainBox.append(h('div.small.muted', '尚未选择队员，无法指定队长。名单未齐也可以先保存，开赛前补齐。'));
      return;
    }
    for (const a of selected) {
      const radio = h('input', {
        type: 'radio', name: `captain-team-${team ? team.id : 'new'}`, value: a.id,
        checked: captainId === a.id, 'aria-label': `队长 ${a.name}`,
      });
      radio.onchange = () => { captainId = Number(radio.value); drawCaptain(); };
      captainBox.append(h('label.row.tight', null, radio, h('span', a.name)));
    }
    if (captainId === null) {
      captainBox.append(h('div.warn-box.mt', '尚未指定队长。可以先保存，开赛前补齐。'));
    }
  }

  const dialog = formDialog({
    title: team ? `编辑项目名单 · ${school.name}` : `设置项目名单 · ${school.name}`,
    subtitle: `${group.name} · ${categoryLabel(cat)} · 参赛单位为学校`,
    width: 'min(640px, 96vw)',
    sections: [
      {
        title: '参赛信息',
        body: h('div.form-grid',
          field('项目', textInput(categoryLabel(cat), { disabled: true }), { hint: '每个项目单独维护该校参赛名单' }),
          field('参赛学校', textInput(school.name, { disabled: true }),
            { hint: '学校名称同时用于赛程、计分与成绩展示，无需另设队名' })),
      },
      {
        title: '队员信息',
        body: h('div', memberBox, h('h4.form-section-title.mt', '队长'), captainBox,
          h('div.small.muted', '队长从已选队员中单选；调整成员顺序不会改变队长。')),
      },
      {
        title: '可选信息',
        body: h('div.form-grid',
          /* 种子属于报名记录，不属于学校档案：只有已报名时才可在这里改（§6.2） */
          enrolled ? field('种子序号', seedInput, { name: 'seed_no', hint: '正整数，留空表示未指定' }) : null,
          field('备注', noteInput, { name: 'note' })),
      },
    ],
    actions: [{
      label: '保存项目名单', primary: true, busyLabel: '保存中…',
      run: async ({ close }) => {
        const members = athletes
          .filter((a) => (picked.get(a.id) || {}).checked)
          .map((a) => ({ athlete_id: a.id, jersey_no: (picked.get(a.id) || {}).jersey || '' }));
        let teamId = team ? team.id : null;
        if (team) {
          const res = await api.put(`/api/teams/${team.id}`, {
            name: displayName, note: noteInput.value,
            members, captain_id: captainId, base_rev: team.rev,
          });
          if (res.captain_cleared) toast('原队长已不在名单中，请重新指定队长', 'error');
          else toast('已保存该校的项目名单', 'ok');
          if (enrolled && seedInput.value.trim() !== String(enrolled.seed_no ?? '')) {
            await api.put(`/api/participations/${enrolled.id}`, {
              seed_no: seedInput.value.trim() === '' ? null : Number(seedInput.value.trim()),
              base_rev: enrolled.rev,
            });
          }
        } else {
          const res = await api.post(`/api/categories/${cat.id}/teams`, {
            school_id: school.id, name: displayName, note: noteInput.value,
            members, captain_id: captainId, request_uid: uid,
          });
          teamId = res.team_id;
          uid = newUid();               // 成功后换新标识，下一次提交是新的业务项
          toast('已保存该校的项目名单；请在项目报名名单中确认报名', 'ok');
        }
        close();
        onSaved(teamId);
      },
    }],
  });
  await loadAthletes();
  return dialog;
}

/* ------------------------------------------------------------------ 报名名单 */
async function renderParticipationPanel(box, group) {
  const panel = h('div.panel', h('h3', '报名名单（按项目）'));
  clear(box);
  box.append(panel);
  if (!group.categories.length) {
    panel.append(emptyState({ text: '该组别还没有项目', hint: '请先在“赛事设置”中添加比赛项目。' }));
    return;
  }
  const cats = group.categories;
  const catSelect = selectInput(cats.map((c) => [c.id, categoryLabel(c)]), cats[0]?.id);
  const inner = h('div');
  panel.append(h('div.row', field('项目', catSelect)), inner);
  catSelect.onchange = () => loadCategory(Number(catSelect.value));
  await loadCategory(cats[0].id);

  async function loadCategory(catId) {
    clear(inner);
    inner.append(loadingState('正在加载报名名单…'));
    try {
      const data = await api.get(`/api/categories/${catId}/participations`);
      clear(inner);
      inner.append(rosterView(data.category, data.participations, () => loadCategory(catId)));
    } catch (e) {
      clear(inner);
      inner.append(errorState(e, () => loadCategory(catId)));
    }
  }
}

export function rosterView(cat, rows, reload, remembered = null, onState = null) {
  const ui = remembered || { q: '', status: 'all', profile: 'all' };
  const wrap = h('div');
  const search = textInput('', {
    type: 'search', placeholder: '搜索学校或运动员', 'aria-label': '搜索报名名单',
    oninput: (e) => { ui.q = e.target.value; onState?.(ui); draw(); },
  });
  const statusSel = selectInput([['all', '全部报名状态'], ['active', '已报名'], ['withdrawn', '已退出']], 'all',
    { onchange: (e) => { ui.status = e.target.value; onState?.(ui); draw(); } });
  const profileSel = selectInput([['all', '全部资料状态'], ['complete', '资料完整'], ['incomplete', '待补充']], 'all',
    { onchange: (e) => { ui.profile = e.target.value; onState?.(ui); draw(); } });
  search.value = ui.q || '';
  statusSel.value = ui.status || 'all';
  profileSel.value = ui.profile || 'all';
  const stats = h('div.stat-grid.mb');
  const list = h('div');

  function visible() {
    const kw = ui.q.trim().toLowerCase();
    return rows.filter((r) => {
      if (ui.status !== 'all' && r.status !== ui.status) return false;
      if (ui.profile !== 'all' && r.profile_status !== ui.profile) return false;
      if (kw && !`${r.school_name} ${r.school_short} ${r.subject} ${r.member_summary}`.toLowerCase().includes(kw)) return false;
      return true;
    });
  }

  function draw() {
    /* 三类状态分别统计，不混成一个“完成度”（§6.6、Q17） */
    const active = rows.filter((r) => r.status === 'active');
    clear(stats);
    stats.append(
      h('div.stat', h('b', String(active.length)), '已报名'),
      h('div.stat', h('b', String(rows.length - active.length)), '已退出'),
      h('div.stat', h('b', String(active.filter((r) => r.profile_status === 'incomplete').length)), '资料待补充'),
    );
    clear(list);
    const shown = visible();
    if (!rows.length) {
      list.append(emptyState({
        text: cat.kind === 'team' ? '还没有学校报名' : '还没有运动员报名',
        hint: cat.kind === 'team'
          ? '选择参赛学校并设置该项目的队员名单；名单未齐也可以先报名，开赛前补齐。'
          : '从上方维护好的学校与人员档案中选择运动员报名。',
      }));
      return;
    }
    if (!shown.length) {
      list.append(filteredEmptyState(() => {
        ui.q = ''; ui.status = 'all'; ui.profile = 'all';
        search.value = ''; statusSel.value = 'all'; profileSel.value = 'all';
        onState?.(ui);
        draw();
      }));
      return;
    }
    list.append(h('div.table-scroll.roster-scroll', table([
      { label: cat.kind === 'team' ? '参赛学校' : '学校', cellClass: 'roster-school',
        render: (r) => h('b', r.school_short || r.school_name) },
      { label: '种子序号', render: (r) => seedCell(r, cat, reload), align: 'center', cellClass: 'roster-seed' },
      cat.kind === 'individual' ? { label: '运动员', key: 'subject' } : null,
      cat.kind === 'team' ? { label: '队员', render: (r) => r.member_summary || h('span.muted', '待补充') } : null,
      cat.kind === 'team' ? { label: '队长', render: (r) => r.captain_name || h('span.muted', '待指定') } : null,
      {
        label: '报名状态', render: (r) => statusBadge(r.status === 'active' ? '已报名' : '已退出',
          r.status === 'active' ? 'ok' : 'warn'),
      },
      {
        label: '资料状态', render: (r) => (r.profile_gaps.length
          ? statusBadge(r.profile_gaps.join('、'), 'warn')
          : statusBadge('资料完整', 'ok')),
      },
      {
        label: '任务可用性', render: (r) => statusBadge(r.task_status || '待核对',
          r.task_status_kind || ''),
      },
      {
        label: '操作', cellClass: 'roster-actions', render: (r) => h('div.row.tight',
          /* 行内直接给“编辑报名”；档案编辑与危险操作进更多菜单（§6.1、Q13） */
          canWrite() ? h('button.btn.small', { onclick: () => openRosterEditor(cat, r, reload) }, '编辑') : null,
          canWrite() ? moreMenu([
            { label: '学校报名工作台', onClick: () => go('workspace', {
              event: state.eventId, group: cat.group_id, tab: 'registration', school: r.school_id,
            }) },
            cat.kind === 'team' && r.team_id ? {
              label: '编辑项目名单', onClick: () => openTeamProfile(cat, r, reload),
            } : null,
            cat.kind === 'individual' && r.athlete_id ? {
              label: '编辑运动员档案', onClick: () => openAthleteProfile(cat, r, reload),
            } : null,
            { label: r.status === 'active' ? '退出报名' : '恢复报名', disabled: !!cat.registration_locked_reason,
              onClick: () => toggleStatus(r, reload) },
            { label: '移除报名', danger: true, onClick: () => removeParticipation(r, reload) },
          ]) : null),
      },
    ].filter(Boolean), shown, { class: 'roster-table', responsive: true })));
  }

  wrap.append(stats,
    h('div.list-toolbar',
      h('div.grow', search), statusSel, profileSel,
      canWrite() ? h('button.btn.btn-primary', { disabled: !!cat.registration_locked_reason,
        onclick: () => openEnrollEditor(cat, reload) },
        cat.kind === 'team' ? '添加参赛学校' : '添加参赛运动员') : null,
    ),
    list,
    h('div.small.muted.mt', cat.registration_locked_reason
      ? `报名与种子只读：${cat.registration_locked_reason}。人员资料仍可在学校报名工作台维护。`
      : '种子序号可选，用于种子签位与蛇形分组。留空表示未指定；输入后按回车或离开输入框保存到后台。'));
  draw();
  return wrap;
}

/* 种子序号行内编辑（§6.1、Q11） */
function seedCell(r, cat, reload) {
  if (!canWrite() || cat.registration_locked_reason) {
    return h('span.seed-readonly', r.seed_no ?? '未指定');
  }
  const input = integerInput(r.seed_no ?? '', { placeholder: '未指定',
    'aria-label': `种子序号 ${r.subject}` });
  const feedback = h('span.seed-feedback', { role: 'status', 'aria-live': 'polite' });
  const wrap = h('span.inline-edit.seed-editor', input, feedback);
  let saving = false;
  const save = async () => {
    if (saving) return;
    const raw = input.value.trim();
    const next = raw === '' ? null : Number(raw);
    if (!input.validity.valid || (next !== null && (!Number.isSafeInteger(next) || next <= 0))) {
      input.value = r.seed_no ?? '';
      feedback.textContent = '请填正整数；已恢复后台值';
      return;
    }
    if (next === (r.seed_no ?? null)) return;
    saving = true;
    input.readOnly = true;
    wrap.setAttribute('aria-busy', 'true');
    feedback.textContent = '保存中…';
    try {
      const res = await api.put(`/api/participations/${r.id}`, { seed_no: next, base_rev: r.rev });
      r.seed_no = next;
      r.rev = res.rev;
      feedback.textContent = '已保存';
      toast(next === null ? '已清除种子序号' : `已设为 ${next} 号种子`, 'ok');
    } catch (e) {
      /* 失败时回到服务器值，不把错误的输入留在界面上 */
      input.value = r.seed_no ?? '';
      feedback.textContent = e.offline ? '保存结果未确认，显示上次读取值'
        : `保存失败，已恢复后台读取值：${e.message}`;
      toast(e.message, 'error');
      if (['stale_revision', 'plan_locked', 'registration_in_use'].includes(e.code)) await reload();
    } finally {
      input.readOnly = false;
      saving = false;
      wrap.removeAttribute('aria-busy');
    }
  };
  input.addEventListener('input', () => { feedback.textContent = ''; });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  input.addEventListener('blur', save);
  return wrap;
}

async function toggleStatus(r, reload) {
  const withdrawing = r.status === 'active';
  if (withdrawing) {
    /* 退出报名要显示影响范围，不自动判定弃权比分（§8.6） */
    const ok = await confirmAsync('退出报名',
      `${r.display}\n保留报名记录与历史引用，停止后续正常参赛。\n已进入对阵的场次不会被自动改判为弃权。`);
    if (!ok) return;
  }
  await api.put(`/api/participations/${r.id}`,
    { status: withdrawing ? 'withdrawn' : 'active', base_rev: r.rev });
  toast(withdrawing ? '已标记退出' : '已恢复报名', 'ok');
  reload();
}

async function removeParticipation(r, reload) {
  const ok = await confirmAsync('移除报名',
    `${r.display}\n只删除尚未被比赛、名次或成绩引用的报名记录；学校与人员档案保留。\n已有关联时会被拒绝并说明原因。`,
    '确认移除');
  if (!ok) return;
  await api.del(`/api/participations/${r.id}`);
  toast('已移除报名记录', 'ok');
  reload();
}

/* 编辑报名记录本身：种子、备注（§6.5）。档案修改走另外的入口。 */
function openRosterEditor(cat, r, reload) {
  const seed = integerInput(r.seed_no ?? '', { placeholder: '留空表示未指定',
    disabled: !!cat.registration_locked_reason });
  const note = textarea(r.note || '');
  const gaps = r.profile_gaps || [];
  formDialog({
    title: `编辑报名 · ${r.display}`,
    subtitle: categoryLabel(cat, { withGroup: true }),
    width: 'min(500px, 94vw)',
    sections: [{
      body: h('div',
        gaps.length ? h('div.warn-box.mb',
          `资料待补充：${gaps.join('、')}。名单未齐不影响已建立的报名，开赛前补齐即可。`) : null,
        h('div.form-grid',
          field('种子序号', seed, { name: 'seed_no', hint: cat.registration_locked_reason || '正整数，留空表示未指定' }),
          field('备注', note, { name: 'note' }))),
    }],
    actions: [{
      label: '保存', primary: true, busyLabel: '保存中…',
      run: async ({ close }) => {
        const raw = seed.value.trim();
        await api.put(`/api/participations/${r.id}`, {
          seed_no: raw === '' ? null : Number(raw), note: note.value, base_rev: r.rev,
        });
        toast('已保存报名记录', 'ok');
        close();
        reload();
      },
    }],
  });
}

/* 已报名学校的项目名单修改：先检查方案与比赛影响，再决定怎么改（§6.5、§15.2） */
async function openTeamProfile(cat, r, reload) {
  const school = { id: r.school_id, name: r.school_name, short_name: r.school_short };
  const detail = await api.get(`/api/schools/${school.id}/detail`);
  const team = detail.teams.find((t) => t.id === r.team_id);
  if (!team) { toast('没有找到该校的项目名单，请刷新后重试', 'error'); return; }
  let impact = null;
  try { impact = await api.get(`/api/teams/${team.id}/impact`); } catch { /* 取不到影响不阻断编辑 */ }
  if (impact && (impact.matches || impact.placements)) {
    const proceed = await confirmAsync('修改已参赛学校的名单',
      `「${school.name}」已被引用：${impact.matches} 场对阵、${impact.placements} 条名次记录。\n`
      + '赛前补齐队员资料不会改变学校身份、分组或对阵。\n'
      + '比赛开始后的阵容变更属于受控变更，请谨慎操作。',
      '继续编辑');
    if (!proceed) return;
  }
  const group = state.structure.groups.find((g) => g.id === cat.group_id)
    || { id: cat.group_id, name: cat.group_name, categories: [] };
  openTeamEditor({ group, school, category: cat, team, onSaved: reload });
}

async function openAthleteProfile(cat, r, reload) {
  const detail = await api.get(`/api/schools/${r.school_id}/detail`);
  const athlete = detail.athletes.find((a) => a.id === r.athlete_id);
  if (!athlete) { toast('没有找到该运动员档案，请刷新后重试', 'error'); return; }
  const group = state.structure.groups.find((g) => g.id === cat.group_id)
    || { id: cat.group_id, name: cat.group_name, categories: [] };
  openAthleteEditor({ school: detail.school, group, athlete, onSaved: reload });
}

/* ------------------------------------------------------------------ 添加报名 */
export async function openEnrollEditor(cat, reload) {
  if (cat.kind === 'team') return openTeamEnroll(cat, reload);
  return openIndividualEnroll(cat, reload);
}

/* 三人赛：选择学校 → 设置项目名单 → 一次提交完成报名。 */
async function openTeamEnroll(cat, reload) {
  const allSchools = (await api.get('/api/events/' + state.eventId + '/schools')).schools;
  const schools = [...new Map(allSchools.map((school) => [school.id, school])).values()];
  const options = schools.map((school) => ({
    value: school.id, label: school.name,
    aliases: [school.short_name || school.name],
    hint: school.group_id && school.group_id !== cat.group_id
      ? '属于' + school.group_name : '已有学校',
    disabled: !!school.group_id && school.group_id !== cat.group_id,
  }));
  const forms = new Map();
  let revision = 0;
  let submitSelection = null;
  const status = h('div.small.muted', { role: 'status' }, '搜索学校；没有匹配的学校时，可直接新建。');
  const detailBox = h('div');
  const edits = h('input', { type: 'hidden', dataset: { field: 'school_edits' } });
  const schoolSel = searchSelect(options, '', {
    placeholder: '搜索或新建学校',
    onInput: () => {
      revision++;
      submitSelection = null;
      clear(detailBox);
      status.textContent = '请选择搜索结果中的学校，或新建学校。';
      dlg.setActionDisabled(0, true);
    },
    onCreate: (name) => {
      const value = 'new:' + name;
      if (!options.some((o) => o.value === value)) {
        options.push({ value, label: name, hint: '新学校 · 待报名保存' });
        schoolSel.setOptions(options);
      }
      schoolSel.value = value;
      showSchool({ id: null, name, short_name: name });
    },
  });
  const dlg = formDialog({
    title: '添加项目报名',
    subtitle: categoryLabel(cat, { withGroup: true }),
    width: 'min(680px, 96vw)',
    sections: [
      { title: '参赛学校', body: field('学校', schoolSel, { required: true, name: 'school_id' }) },
      { title: '项目报名', body: h('div', status, detailBox, edits) },
    ],
    actions: [{
      label: '确认报名', primary: true, busyLabel: '提交中…',
      run: async ({ close }) => {
        if (!submitSelection) throw new Error('请先选择学校并等待名单加载完成');
        dlg.body.inert = true;
        let result;
        try { result = await submitSelection(); }
        finally { dlg.body.inert = false; }
        const gaps = result.profile_gaps || [];
        toast(gaps.length ? '报名成功（' + gaps.join('、') + '）' : '报名成功', 'ok');
        close();
        reload();
      },
    }],
  });
  dlg.setActionDisabled(0, true);
  schoolSel.addEventListener('change', (e) => {
    if (!e.detail?.option) return;
    const value = e.detail.value;
    const school = schools.find((s) => String(s.id) === String(value));
    showSchool(school || { id: null, name: e.detail.option.label, short_name: e.detail.option.label });
  });

  async function showSchool(school) {
    const current = ++revision;
    submitSelection = null;
    dlg.setActionDisabled(0, true);
    dlg.clearErrors();
    clear(detailBox);
    status.textContent = '正在加载报名信息…';
    try {
      const [teamResult, partResult] = school.id ? await Promise.all([
        api.get('/api/categories/' + cat.id + '/teams'),
        api.get('/api/categories/' + cat.id + '/participations'),
      ]) : [{ teams: [] }, { participations: [] }];
      if (current !== revision || !dlg.root.isConnected) return;
      const team = teamResult.teams.find((t) => t.school_id === school.id);
      const part = team && partResult.participations.find((p) => p.team_id === team.id);
      if (team) {
        status.textContent = part
          ? (part.status === 'active' ? '该校已报名本项目，可查看或编辑名单。' : '该校已退出本项目，可查看报名记录。')
          : '该校已有项目名单，确认报名即可加入本项目。';
        detailBox.append(h('button.btn.mt', {
          onclick: () => {
            dlg.close();
            if (part) openRosterEditor(cat, part, reload);
            else {
              const group = state.structure.groups.find((g) => g.id === cat.group_id);
              openTeamEditor({ group, school, category: cat, team, onSaved: reload });
            }
          },
        }, part ? '查看 / 编辑报名' : '编辑项目名单'));
        if (!part) {
          submitSelection = () => api.post('/api/categories/' + cat.id + '/participations', { team_id: team.id });
          dlg.setActionDisabled(0, false);
        }
        return;
      }
      const key = school.id || 'new:' + school.name;
      if (!forms.has(key)) {
        const form = createTeamEnrollmentForm({ cat, school });
        const remember = () => {
          edits.value = JSON.stringify([...forms].map(([id, value]) => [id, value.snapshot()]));
        };
        form.body.addEventListener('input', remember);
        form.body.addEventListener('change', remember);
        form.body.addEventListener('click', remember);
        forms.set(key, form);
      }
      const form = forms.get(key);
      try { await form.ready; } catch (error) { forms.delete(key); throw error; }
      if (current !== revision || !dlg.root.isConnected) return;
      status.textContent = school.id ? '设置参赛名单后确认报名。'
        : '新学校将在确认报名时一并保存。';
      detailBox.append(form.body);
      submitSelection = form.submit;
      dlg.setActionDisabled(0, false);
    } catch (error) {
      if (current !== revision || !dlg.root.isConnected) return;
      status.textContent = '';
      detailBox.append(errorState(error, () => showSchool(school)));
    }
  }
  return dlg;
}

/* 添加参赛学校：内部一次性建立学校、人员、项目名单与参赛记录。 */
function createTeamEnrollmentForm({ cat, school }) {
  const displayName = school.short_name || school.name;
  const shortInput = textInput('', { placeholder: '简称（可留空）' });
  const seedInput = integerInput('', { placeholder: '留空表示未指定' });
  seedInput.dataset.field = 'seed_no';
  const noteInput = textarea('');
  noteInput.dataset.field = 'note';

  let athletes = [];                 // 该校已有运动员档案
  const chosen = new Map();          // rowKey -> { jersey }
  const pending = [];
  let captainKey = null;
  let pendingSeq = 0;

  const memberBox = h('div');
  const captainBox = h('div');

  function rows() {
    const existing = athletes
      .filter((a) => !a.gender || a.gender === cat.gender)
      .map((a) => ({
        key: `a${a.id}`, name: a.name, athleteId: a.id,
        usual: a.jersey_no || '', gender: a.gender, extra: a.gender ? '' : '（性别未填）',
      }));
    return [...existing, ...pending.map((p) => ({
      key: p.key, name: p.name, athleteId: null, usual: '', gender: p.gender,
      extra: p.note ? `（${p.note}）` : '', pending: p,
    }))];
  }

  async function loadAthletes() {
    athletes = school.id
      ? (await api.get(`/api/schools/${school.id}/athletes`)).athletes
      : [];
    drawMembers();
  }

  function jerseyOf(row) {
    const state = chosen.get(row.key);
    if (!state) return row.usual || '';
    return state.jersey;
  }

  function drawMembers() {
    clear(memberBox);
    const list = rows();
    const skipped = athletes.length - list.filter((r) => r.athleteId).length;
    if (!list.length) {
      memberBox.append(h('div.warn-box',
        `该校还没有符合${GENDER[cat.gender]}项目性别的运动员，可在下方就地新增。`));
    }
    for (const row of list) {
      const box = h('input', {
        type: 'checkbox', checked: chosen.has(row.key), 'aria-label': `选择 ${row.name}`,
      });
      const jersey = textInput(jerseyOf(row), {
        class: 'jersey-input', placeholder: '号码', 'aria-label': `${row.name} 本队号码`,
      });
      box.onchange = () => {
        if (box.checked) {
          if (!chosen.has(row.key)) chosen.set(row.key, { jersey: jerseyOf(row) });
        } else {
          chosen.delete(row.key);
          if (captainKey === row.key) {
            /* 取消当前队长后清空并要求重新指定（§6.5） */
            captainKey = null;
            toast('已移除队长，请重新指定', 'error');
          }
        }
        drawMembers();
      };
      jersey.oninput = (e) => {
        const state = chosen.get(row.key);
        if (state) state.jersey = e.target.value;
      };
      memberBox.append(h('label.row.tight.member-row', box,
        h('span.grow', row.name + row.extra),
        row.usual ? h('span.small.muted.nowrap', `常用 ${row.usual}`) : null,
        jersey));
    }
    if (skipped > 0) {
      memberBox.append(h('div.small.muted.mt', `另有 ${skipped} 名运动员性别与本项目不符，未列出。`));
    }
    memberBox.append(buildNewAthleteRow());
    drawCaptain();
  }

  function buildNewAthleteRow() {
    const name = textInput('', { placeholder: '姓名' });
    const gender = selectInput([[cat.gender, GENDER[cat.gender]]], cat.gender);
    const jersey = textInput('', { placeholder: '号码', class: 'jersey-input' });
    const note = textInput('', { placeholder: '班级、学号等区分信息' });
    const confirmed = h('input', { type: 'checkbox' });
    const review = h('div.same-name-review.hidden');
    const sameNames = () => [...athletes, ...pending].filter((p) => p.name.trim().toLowerCase() === name.value.trim().toLowerCase());
    name.oninput = () => {
      clear(review); confirmed.checked = false;
      const same = sameNames(); review.classList.toggle('hidden', !same.length);
      for (const p of same) review.append(h('div.same-name-person', `${p.name} · ${GENDER[p.gender] || '性别未填'} · ${p.note || '备注未填'}`));
      if (same.length) review.append(h('label.row.tight', confirmed, '已核对全校同名人员，确认新增的是另一人'));
    };
    const add = h('button.btn.small.self-end', null, '加入名单');
    add.onclick = () => {
      const value = name.value.trim();
      if (!value) { toast('请填写姓名', 'error'); name.focus(); return; }
      const same = sameNames();
      if (same.length && (!confirmed.checked || !note.value.trim() || same.some((p) => (p.note || '').trim().toLowerCase() === note.value.trim().toLowerCase()))) {
        toast('同名新增需核对不同人，并填写不同的区分信息', 'error'); return;
      }
      const key = `p${++pendingSeq}`;
      pending.push({ key, name: value, gender: gender.value, jersey_no: jersey.value.trim(), note: note.value.trim(),
        confirm_distinct_person: !!same.length && confirmed.checked,
        same_name_candidates: athletes.filter((p) => p.name.trim().toLowerCase() === value.toLowerCase()).map((p) => ({ id: p.id, rev: p.rev })).sort((a, b) => a.id - b.id) });
      chosen.set(key, { jersey: jersey.value.trim() });
      name.value = ''; jersey.value = ''; drawMembers();
    };
    return h('div.mt', h('h4.form-section-title', '新增人员'),
      h('div.row.tight', field('姓名', name), field('性别', gender), field('号码', jersey), add), field('区分信息', note), review);
  }

  function drawCaptain() {
    clear(captainBox);
    const selected = rows().filter((r) => chosen.has(r.key));
    if (!selected.length) {
      captainBox.append(h('div.small.muted', '尚未选择队员。名单未齐也可以先报名，开赛前补齐。'));
      return;
    }
    if (captainKey && !selected.some((r) => r.key === captainKey)) captainKey = null;
    for (const row of selected) {
      const radio = h('input', {
        type: 'radio', name: 'captain-enroll', checked: captainKey === row.key,
        'aria-label': `队长 ${row.name}`,
      });
      radio.onchange = () => { captainKey = row.key; drawCaptain(); };
      captainBox.append(h('label.row.tight', null, radio,
        h('span', row.name)));
    }
    if (captainKey === null) {
      captainBox.append(h('div.warn-box.mt', '尚未指定队长，可开赛前补齐。'));
    }
  }

  function buildPayload() {
    const picked = rows().filter((r) => chosen.has(r.key));
    const members = picked.map((r) => (r.pending
      ? { name: r.pending.name, gender: r.pending.gender, jersey_no: chosen.get(r.key).jersey, note: r.pending.note,
          same_name_candidates: r.pending.same_name_candidates, confirm_distinct_person: r.pending.confirm_distinct_person }
      : { athlete_id: r.athleteId, jersey_no: chosen.get(r.key).jersey }));
    const raw = seedInput.value.trim();
    return {
      ...(school.id && school.group_id !== null
        ? { school_id: school.id }
        : { school: { name: school.name, short_name: shortInput.value.trim() || school.short_name } }),
      team_name: displayName,
      note: noteInput.value,
      members,
      captain_index: captainKey === null ? null : picked.findIndex((r) => r.key === captainKey),
      seed_no: raw === '' ? null : Number(raw),
      request_uid: uid,
    };
  }

  // 同一次报名重试沿用请求标识，避免响应丢失后重复提交。
  const uid = newUid();
  const snapshot = h('input', { type: 'hidden', dataset: { field: 'enrollment' } });
  const body = h('div.enrollment-fields', snapshot,
    !school.id ? field('学校简称', shortInput, { hint: '可留空，默认使用学校全称' }) : null,
    h('h4.form-section-title.mt', '队员信息'), memberBox,
    h('h4.form-section-title.mt', '队长'), captainBox,
    h('h4.form-section-title.mt', '可选信息'),
    h('div.form-grid',
      field('种子序号', seedInput, { name: 'seed_no', hint: '正整数，留空表示未指定' }),
      field('备注', noteInput, { name: 'note' })));
  const sync = () => { snapshot.value = JSON.stringify(buildPayload()); };
  body.addEventListener('input', sync);
  body.addEventListener('change', sync);
  body.addEventListener('click', sync);
  return {
    body,
    snapshot: () => snapshot.value,
    ready: loadAthletes().then(sync),
    submit: () => api.post('/api/categories/' + cat.id + '/enrollments', buildPayload()),
  };
}

/* 个人赛：以学校为入口，复用符合资格的人员档案，一次完成报名。 */
async function openIndividualEnroll(cat, reload) {
  const allSchools = (await api.get('/api/events/' + state.eventId + '/schools')).schools;
  const schools = [...new Map(allSchools.map(s => [s.id, s])).values()];
  const options = schools.map(s => ({value:s.id, label:s.name, aliases:[s.short_name || s.name],
    disabled:!!s.group_id && s.group_id !== cat.group_id,
    hint:s.group_id && s.group_id !== cat.group_id ? '属于' + s.group_name : ''}));
  const detail = h('div');
  const status = h('div.small.muted', {role:'status'}, '每所学校在本个人项目限报 1 人。请先选择学校。');
  let school = null, personPicker = null, revision = 0;
  const seed = integerInput('', {placeholder:'留空表示未指定'});
  const jersey = textInput('', {placeholder:'号码（可选）'});
  const uid = newUid();
  const schoolSel = searchSelect(options, '', {
    placeholder:'搜索或新建学校',
    onInput:() => {revision++; school=null; personPicker?.destroy(); personPicker=null; clear(detail); dlg.setActionDisabled(0,true); status.textContent='请选择学校。';},
    onchange:value => showSchool(schools.find(s => String(s.selection || s.id) === String(value))),
    onCreate:name => {
      const item={id:null,name}; const value='new:'+name;
      item.selection=value; schools.push(item);
      options.push({value,label:name}); schoolSel.setOptions(options); schoolSel.value=value; showSchool(item);
    },
  });
  const dlg = formDialog({
    title:'添加项目报名', subtitle:categoryLabel(cat,{withGroup:true}), width:'min(680px, 96vw)',
    sections:[
      {title:'参赛学校',body:field('学校',schoolSel,{required:true,name:'school_id'})},
      {title:'参赛运动员',body:h('div',status,detail)},
    ],
    actions:[{label:'确认报名',primary:true,busyLabel:'提交中…',run:async({close}) => {
      if(!school || !personPicker) throw new Error('请先选择学校和运动员');
      const source=personPicker.getPayload();
      const payload={...(school.id && school.group_id !== null ? {school_id:school.id} : {school:{name:school.name}}),
        athlete:source.athlete_id ? source : {...source,gender:cat.gender,athlete_jersey_no:jersey.value.trim()},
        seed_no:seed.value.trim() === '' ? null : Number(seed.value),request_uid:uid};
      dlg.body.inert=true;
      try {await api.post('/api/categories/'+cat.id+'/enrollments/individual',payload);}
      catch(error) {
        if(error.code==='same_name_changed') {
          try {
            const updated=await api.get('/api/categories/'+cat.id+'/enrollment-candidates');
            personPicker.refreshCandidates(updated.candidates.filter(c=>c.school_id===school.id));
          } catch {
            const updated=(error.detail?.same_name_candidates || []).map(c=>({...c,subject_id:c.id,
              subject:c.name,school_name:school.name,action:'needs_review',reason:'资格将在提交时再次核对'}));
            personPicker.refreshCandidates(updated);
          }
        }
        throw error;
      }
      finally {dlg.body.inert=false;}
      toast('报名成功','ok');close();await reload();
    }}],
    onClose:()=>personPicker?.destroy(),
  });
  dlg.setActionDisabled(0,true);
  async function showSchool(chosen) {
    const current=++revision; school=chosen; personPicker?.destroy();personPicker=null; clear(detail);dlg.clearErrors();dlg.setActionDisabled(0,true);
    if(!chosen) return;
    seed.value='';jersey.value='';status.textContent='正在核对学校名额和运动员资格…';
    try {
      const [candidatesData,partsData]=await Promise.all([
        api.get('/api/categories/'+cat.id+'/enrollment-candidates'),
        api.get('/api/categories/'+cat.id+'/participations'),
      ]);
      if(current!==revision || !dlg.root.isConnected) return;
      const enrolled=chosen.id && partsData.participations.find(p=>p.school_id===chosen.id && p.status==='active');
      if(enrolled) {
        status.textContent='该校已报名：'+enrolled.display+'。本项目每校限报 1 人。';
        detail.append(h('button.btn.mt',{onclick:()=>{dlg.close();openAthleteProfile(cat,enrolled,reload);}},'编辑已报名运动员资料'));
        return;
      }
      const candidates=chosen.id ? candidatesData.candidates.filter(c=>c.school_id===chosen.id) : [];
      let previousExisting = false;
      personPicker=athletePicker({candidates,
        placeholder:'搜索或填写运动员姓名',
        onchange:(ready,selected)=>{
          jersey.disabled=!!selected?.subject_id;
          if(selected?.subject_id) jersey.value=selected.jersey_no || '';
          else if(previousExisting) jersey.value='';
          previousExisting=!!selected?.subject_id;
          dlg.setActionDisabled(0,!ready);
        },
      });
      status.textContent='每校限报 1 人；已有人员显示报名资格，同名不同人可在这里核对新增。';
      detail.append(personPicker.body,
        h('div.form-grid.mt',field('号码',jersey,{name:'athlete_jersey_no',hint:'选择已有人员时保留档案号码'}),field('种子序号',seed,{name:'seed_no'})));
    } catch(error) {
      if(current!==revision) return;
      status.textContent='资格信息加载失败，请重试。';detail.append(errorState(error,()=>showSchool(chosen)));
    }
  }
  return dlg;
}

/* 该模块只向项目工作台提供学校、人员及参赛编辑能力，不再注册独立页面。 */

/* 报名内搜索、复用和同名核对。Tom Select 文件随站点提供，断网时也可加载。 */
import { h, field, textInput, clear } from './ui.js';

const genderLabel = { male: '男子', female: '女子' };
const normalized = (name) => String(name || '').trim().toLowerCase();
const selectable = (person) => ['addable', 'needs_review'].includes(person.action);
const info = (person) => [person.school_name, genderLabel[person.gender] || '性别未填',
  person.jersey_no ? `常用号码 ${person.jersey_no}` : '号码未填',
  person.note || '备注未填', person.reason || '可报名'].filter(Boolean).join(' · ');

export function athletePicker({ candidates, placeholder, onchange }) {
  let people = candidates, selected = null, sequence = 0;
  const select = h('select', h('option', { value: '' }));
  const summary = h('div.small.muted', { role: 'status' });
  const review = h('div.same-name-review.hidden');
  const note = textInput('', { placeholder: '例如：二年级 3 班，或学号', maxlength: 200,
    dataset: { field: 'athlete_note' } });
  const noteField = field('人员备注', note, { hint: '随人员档案保存，便于以后核对。' });
  noteField.classList.add('hidden');
  const confirmed = h('input', { type: 'checkbox', dataset: { field: 'distinct_person' } });
  const snapshot = h('input', { type: 'hidden', dataset: { field: 'athlete_selection' } });
  const blocked = h('details.athlete-blocked');
  const createButton = h('button.btn.small', { type: 'button', onclick: () => {
    const name = picker.control_input.value.trim();
    if (name) picker.createItem(name); else picker.focus();
  } }, '＋ 新增人员');
  const body = h('div.athlete-picker', field('运动员姓名', select, { required: true }),
    createButton, summary, blocked, review, noteField, snapshot);
  const matches = () => selected && !selected.subject_id
    ? people.filter((person) => normalized(person.subject) === normalized(selected.name)) : [];
  const snapshotOf = (rows) => rows.map((person) => ({ id: person.subject_id, rev: person.rev }))
    .sort((a, b) => a.id - b.id);
  const options = () => people.filter(selectable).map((person) => ({ value: String(person.subject_id), name: person.subject,
    info: info(person), disabled: false }));
  const picker = new window.TomSelect(select, {
    options: options(), valueField: 'value', labelField: 'name', searchField: ['name', 'info'],
    maxItems: 1, maxOptions: null, placeholder, closeAfterSelect: true, createOnBlur: false,
    create: (name) => ({ value: `new:${++sequence}`, name: name.trim(), newPerson: true }),
    createFilter: (name) => !!name.trim(),
    render: {
      option: (data) => h('div', { class: data.disabled ? 'disabled' : '',
        'aria-disabled': data.disabled ? 'true' : 'false' },
        h('strong', data.name), h('div.small.muted', data.info || '新增人员 · 待报名保存')),
      item: (data) => h('div', data.name),
      option_create: (data) => h('div.create', { role: 'option', 'aria-selected': 'false' }, people.some((person) => normalized(person.subject) === normalized(data.input))
        ? `＋ 新增另一位同名人员“${data.input.trim()}”` : `＋ 新建“${data.input.trim()}”`),
      no_results: () => h('div.small.muted', '没有匹配的已有人员，可新建。'),
    },
    onChange(value) {
      const option = this.options[value];
      selected = option?.newPerson ? { name: option.name }
        : people.find((person) => String(person.subject_id) === String(value)) || null;
      confirmed.checked = false;
      note.value = '';
      draw();
    },
  });
  picker.control_input.dataset.field = 'athlete';
  picker.control_input.setAttribute('aria-label', '运动员姓名');
  // 原生 input 立即清除旧身份，避免 Tom Select 搜索节流期间仍可提交旧人员。
  picker.control_input.addEventListener('input', () => {
    if (!selected) return;
    picker.clear(true);
    selected = null;
    confirmed.checked = false;
    draw();
  });

  function sync() {
    const same = matches();
    const ready = !!selected && (selected.subject_id ? selectable(selected)
      : !same.length || (confirmed.checked && !!note.value.trim()));
    snapshot.value = JSON.stringify({ selected, note: note.value, confirmed: confirmed.checked,
      reviewed: snapshotOf(same) });
    onchange(ready, selected);
  }
  function draw() {
    clear(blocked);
    const unavailable = people.filter((person) => !selectable(person));
    blocked.classList.toggle('hidden', !unavailable.length);
    blocked.append(h('summary', `查看暂不可报名人员（${unavailable.length}）`),
      ...unavailable.map((person) => h('div.small.mt', h('strong', person.subject), h('div.muted', info(person)))));
    clear(review);
    review.classList.add('hidden');
    noteField.classList.toggle('hidden', !selected || !!selected.subject_id);
    noteField.querySelector('span').textContent = '人员备注';
    if (!selected) summary.textContent = '选择已有人员，或直接新建。报名资格会在提交时再次核对。';
    else if (selected.subject_id) summary.textContent = `${selected.subject} · ${info(selected)}`;
    else {
      const same = matches();
      summary.textContent = same.length ? `该校已有 ${same.length} 位同名人员，请核对后选择。`
        : '确认报名时一并保存人员资料，性别按当前项目设置。';
      if (same.length) {
        review.classList.remove('hidden');
        noteField.querySelector('span').textContent = '区分信息（必填）';
        for (const person of same) {
          review.append(h('div.same-name-person', h('div.grow', h('strong', person.subject),
            h('div.small.muted', info(person))), h('button.btn.small', { type: 'button',
              disabled: !selectable(person), onclick: () => picker.setValue(String(person.subject_id)),
            }, '使用这位人员')));
        }
        review.append(h('label.row.tight.mt', confirmed,
          h('span', '已核对以上人员，确认新增的是另一位同名人员')));
      }
    }
    sync();
  }
  note.addEventListener('input', sync);
  confirmed.addEventListener('change', sync);
  draw();
  return {
    body,
    getPayload() {
      if (!selected) throw new Error('请选择运动员或新建人员');
      if (selected.subject_id) return { athlete_id: selected.subject_id };
      const same = matches();
      if (same.length && (!confirmed.checked || !note.value.trim())) {
        throw new Error('请填写区分信息，并确认新增的是另一位同名人员');
      }
      return { name: selected.name, note: note.value.trim(),
        same_name_candidates: snapshotOf(same), confirm_distinct_person: same.length ? confirmed.checked : false };
    },
    refreshCandidates(updated) {
      people = updated;
      confirmed.checked = false;
      const validIds = new Set(people.filter(selectable).map((person) => String(person.subject_id)));
      for (const [value, option] of Object.entries(picker.options)) {
        if (value && !option.newPerson && !validIds.has(value)) picker.removeOption(value, true);
      }
      for (const option of options()) {
        if (picker.options[option.value]) picker.updateOption(option.value, option);
        else picker.addOption(option);
      }
      if (selected?.subject_id) selected = people.find((person) => person.subject_id === selected.subject_id) || null;
      draw();
    },
    destroy: () => picker.destroy(),
  };
}

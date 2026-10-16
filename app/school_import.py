"""Convert a school CSV/Excel paste into the existing school change package.

No writes. Listed projects describe complete rosters; omitted projects are retained.
"""
import csv
import io
import uuid
from copy import deepcopy

from .errors import ApiError, bad_request

HEADERS = ['学校', '项目', '项目ID', '参赛选择', '运动员', '性别', '常用号码',
           '项目号码', '队长', '种子序号', '报名备注', '区分信息', '运动员ID', '同名新建确认']
ALIASES = {'姓名': '运动员', '运动员姓名': '运动员', '项目名称': '项目', '备注': '区分信息'}
CHOICES = {'': 'participate', '参加': 'participate', '报名': 'participate', '参加报名': 'participate',
           '不参加': 'not_participating', '明确不参加': 'not_participating',
           '退出': 'withdrawn', '退出报名': 'withdrawn', '尚未决定': 'unresolved'}
GENDERS = {'': '', '男': 'male', '男子': 'male', 'male': 'male', '女': 'female', '女子': 'female', 'female': 'female'}


def read_rows(text):
    if not isinstance(text, str) or not text.strip():
        raise bad_request('请上传 CSV 或从 Excel 粘贴包含表头的报名表')
    if len(text.encode('utf-8')) > 2 * 1024 * 1024:
        raise bad_request('报名表超过 2 MB，请拆分')
    text = text.lstrip('\ufeff')
    delimiter = '\t' if '\t' in text.splitlines()[0] else ','
    try:
        reader = csv.DictReader(io.StringIO(text, newline=''), delimiter=delimiter, strict=True)
        fields = [ALIASES.get(s.strip(), s.strip()) for s in (reader.fieldnames or [])]
        if len(fields) != len(set(fields)):
            raise bad_request('表头不能重复（姓名与运动员属于同一列）')
        if '运动员' not in fields or not ({'项目', '项目ID'} & set(fields)):
            raise bad_request('表头至少包含“项目”和“运动员”，仅建人员时项目留空')
        unknown = set(fields) - set(HEADERS)
        if unknown:
            raise bad_request('无法识别表头：' + '、'.join(sorted(unknown)))
        reader.fieldnames = fields
        rows = []
        for row in reader:
            if None in row or any(v is None for v in row.values()):
                raise bad_request(f'第 {reader.line_num} 行列数与表头不一致')
            clean = {k: v.strip() for k, v in row.items()}
            if not any(clean.values()):
                continue
            rows.append(dict(clean, line=reader.line_num))
            if len(rows) > 1000:
                raise bad_request('一次最多导入 1000 行')
        if not rows:
            raise bad_request('没有可导入的人员或项目选择')
        return rows
    except csv.Error as exc:
        raise bad_request(f'表格格式不正确：{exc}') from exc


def truth(value, label):
    value = value.lower()
    if value in ('是', '1', 'yes', 'true', '√'):
        return True
    if value in ('', '否', '0', 'no', 'false'):
        return False
    raise bad_request(f'{label}请填写“是”或“否”')


def number(value, label, maximum=None):
    if value and (len(value) > 10 or not value.isascii() or not value.isdigit() or str(int(value)) != value or int(value) < 1 or int(value) > (maximum or 2147483647)):
        raise bad_request(f'{label}必须为 1—{maximum} 的整数' if maximum else f'{label}必须为正整数')
    return value


def escaped_match(raw, value):
    """Accept the safe CSV export representation only for a known field value."""
    return raw == value or (value[:1] in ('=', '+', '-', '@', '\t', '\r') and raw == "'" + value)


def person_values(p):
    return {k: p.get(k, '') for k in ('key', 'name', 'gender', 'jersey_no', 'note')}


def project_values(p):
    return {'category_id': p['category_id'], 'choice': p['choice'], 'members': p.get('members', []),
            'captain_key': p.get('captain_key') or '', 'athlete_key': p.get('athlete_key') or '',
            'seed_no': p.get('seed_no') or None, 'note': p.get('note') or ''}


def model_from_changes(snapshot, payload):
    model = deepcopy(snapshot)
    people = {p['key']: p for p in model['people']}
    seen = set()
    for item in payload['people']:
        if not isinstance(item, dict) or not isinstance(item.get('key'), str) or item['key'] in seen:
            raise bad_request('当前报名表中的人员标识无效')
        seen.add(item['key'])
        if any(not isinstance(item.get(k, ''), str) for k in ('name', 'gender', 'jersey_no', 'note')) or item.get('gender', '') not in GENDERS.values():
            raise bad_request('当前报名表中的人员资料无效')
        if item['key'] in people:
            people[item['key']].update(item)
        elif item['key'].startswith('new:'):
            p = dict(item)
            p.pop('id', None)
            p.pop('rev', None)
            model['people'].append(p)
            people[p['key']] = p
        else:
            raise bad_request('当前报名表人员不属于本校')
    projects = {p['category_id']: p for p in model['projects']}
    seen = set()
    for item in payload['projects']:
        if not isinstance(item, dict) or type(item.get('category_id')) is not int or item['category_id'] not in projects or item['category_id'] in seen:
            raise bad_request('当前报名表项目不属于学校当前组别')
        seen.add(item['category_id'])
        if not isinstance(item.get('members', []), list) or any(not isinstance(m, dict) or not isinstance(m.get('athlete_key'), str) or not isinstance(m.get('jersey_no', ''), str) for m in item.get('members', [])):
            raise bad_request('当前报名表队员格式无效')
        if any(not isinstance(item.get(k, ''), str) for k in ('athlete_key', 'captain_key', 'note')):
            raise bad_request('当前报名表报名字段无效')
        if item.get('seed_no') is not None and type(item['seed_no']) not in (int, str):
            raise bad_request('当前报名表种子格式无效')
        projects[item['category_id']].update(item)
    return model


def changes_from_model(snapshot, model):
    before = {p['key']: p for p in snapshot['people']}
    people = []
    for p in model['people']:
        old = before.get(p['key'])
        if old and person_values(p) == person_values(old):
            continue
        item = person_values(p)
        if old:
            item['base_rev'] = old['rev']
        for key in ('same_name_candidates', 'confirm_distinct_person'):
            if key in p:
                item[key] = p[key]
        people.append(item)
    original = {p['category_id']: project_values(p) for p in snapshot['projects']}
    projects = [project_values(p) for p in model['projects'] if project_values(p) != original[p['category_id']]]
    return {'event_identity': snapshot['event_identity'], 'base_hash': snapshot['base_hash'], 'people': people, 'projects': projects}


def convert(snapshot, initial, text):
    model = model_from_changes(snapshot, initial)
    rows = read_rows(text)
    errors, items, listed = [], [], {}
    cats = {c['id']: c for c in snapshot['categories']}
    projects = {p['category_id']: p for p in model['projects']}
    profile_specs, new_profiles = {}, {}
    original_people = snapshot['people']

    def athlete(row, cat):
        name = row.get('运动员', '')
        if not name:
            raise bad_request('参加报名或仅建人员时必须填写运动员姓名')
        gender = GENDERS.get(row.get('性别', '').lower())
        if gender is None:
            raise bad_request('性别请填写男、女，或留空')
        gender = gender or (cat['gender'] if cat else '')
        create = truth(row.get('同名新建确认', ''), '同名新建确认')
        raw_id = row.get('运动员ID', '')
        matches = [p for p in model['people'] if p['name'].strip().lower() == name.lower()]
        if raw_id:
            if create:
                raise bad_request('复用运动员ID时不能同时确认同名新建')
            key = raw_id if raw_id.startswith('new:') else 'a:' + number(raw_id, '运动员ID')
            p = next((p for p in model['people'] if p['key'] == key), None)
            if not p or not escaped_match(name, p['name']):
                raise bad_request('运动员ID不存在、不属于本校，或与姓名不符')
        elif not create:
            if len(matches) > 1:
                raise bad_request('全校存在同名人员，请填写运动员ID明确复用，或确认新建不同人')
            p = matches[0] if matches else None
        else:
            p = None
        # A repeated explicitly new identity uses the same key; duplicate roster is rejected below.
        spec = (name.lower(), row.get('区分信息', ''))
        if create and spec in new_profiles:
            p = new_profiles[spec]
        if p and p.get('gender') and gender and p['gender'] != gender:
            raise bad_request('运动员档案性别与表格不符，请先在人员名单中核对')
        if cat and gender and gender != cat['gender']:
            raise bad_request('性别与所报项目不符')
        usual = number(row.get('常用号码', ''), '常用号码', 20)
        note = row.get('区分信息', '')
        if not p:
            if matches and (not create or not note or any(p.get('note', '').strip().lower() == note.lower() for p in matches)):
                raise bad_request('同名新建必须确认不同人，并填写与已有人员不同的区分信息')
            key = 'new:' + str(uuid.uuid4())
            reviewed = sorted([{'id': p['id'], 'rev': p['rev']} for p in original_people if p['name'].strip().lower() == name.lower()], key=lambda p: p['id'])
            p = {'key': key, 'name': name, 'gender': gender, 'jersey_no': usual, 'note': note,
                 'same_name_candidates': reviewed, 'confirm_distinct_person': create}
            model['people'].append(p)
            if create:
                new_profiles[spec] = p
            for k, v in {'gender': gender, 'jersey_no': usual, 'note': note}.items():
                if v:
                    profile_specs[(p['key'], k)] = v
        else:
            # Nonempty optional profile cells supplement the profile; blanks retain it.
            incoming = {k: v for k, v in {'gender': gender, 'jersey_no': usual, 'note': note}.items() if v}
            for k, v in incoming.items():
                if k == 'note' and escaped_match(v, p.get(k, '')):
                    v = p.get(k, '')
                signature = (p['key'], k)
                if signature in profile_specs and profile_specs[signature] != v:
                    raise bad_request('同一人员的性别、常用号码或区分信息在多行中不一致')
                profile_specs[signature] = v
                p[k] = v
        return p

    for row in rows:
        try:
            if row.get('学校') and not escaped_match(row['学校'], snapshot['school']['name']):
                raise bad_request('学校与当前工作台不一致，请进入对应学校导入')
            label, cid = row.get('项目', ''), row.get('项目ID', '')
            cat = None
            if cid:
                cat = cats.get(int(number(cid, '项目ID')))
                if not cat or (label and not escaped_match(label, cat['name'])):
                    raise bad_request('项目ID不属于本校当前组别，或与项目名称不符')
            elif label:
                matches = [c for c in cats.values() if c['name'] == label]
                if len(matches) != 1:
                    raise bad_request('项目名称不存在或不唯一，请填写当前组别的项目ID')
                cat = matches[0]
            choice = CHOICES.get(row.get('参赛选择', ''))
            if choice is None:
                raise bad_request('参赛选择请填写参加、不参加、退出或尚未决定')
            if not cat:
                if choice != 'participate' or any(row.get(k) for k in ('项目号码', '队长', '种子序号', '报名备注')):
                    raise bad_request('仅建人员时项目留空，不填写项目号码、队长或参赛选择')
                p = athlete(row, None)
                items.append({'line': row['line'], 'project': '人员资料', 'person': p['name'], 'message': '添加人员'})
                continue
            if choice == 'unresolved':
                if any(row.get(k) for k in ('运动员', '运动员ID', '项目号码', '队长', '种子序号')):
                    raise bad_request('尚未决定的行不能填写参赛人员，请改为参加或清空名单')
                items.append({'line': row['line'], 'project': cat['name'], 'person': '', 'message': '尚未决定，保持原状'})
                continue
            if cat['id'] not in listed:
                old = projects[cat['id']]
                listed[cat['id']] = {'category_id': cat['id'], 'choice': choice, 'members': [], 'captain_key': '', 'athlete_key': '',
                                    'seed_no': old.get('seed_no'), 'note': old.get('note', ''), 'lines': [], 'seed_input': '', 'note_input': ''}
            project = listed[cat['id']]
            if project['choice'] != choice:
                raise bad_request('同一项目的参加、不参加、退出选择不能混用')
            project['lines'].append(row['line'])
            if choice != 'participate':
                if any(row.get(k) for k in ('运动员', '运动员ID', '项目号码', '队长', '种子序号')):
                    raise bad_request('不参加或退出的项目不能同时填写参赛名单')
            else:
                seed = number(row.get('种子序号', ''), '种子序号')
                note = row.get('报名备注', '')
                if escaped_match(note, projects[cat['id']].get('note', '')):
                    note = projects[cat['id']].get('note', '')
                for k, value in (('seed_input', seed), ('note_input', note)):
                    if value and project[k] and value != project[k]:
                        raise bad_request('同一项目的种子序号或报名备注不一致')
                    if value:
                        project[k] = value
                if seed:
                    project['seed_no'] = int(seed)
                if note:
                    project['note'] = note
                if cat['kind'] == 'team' and not row.get('运动员'):
                    if any(row.get(k) for k in ('运动员ID', '性别', '常用号码', '项目号码', '队长', '区分信息', '同名新建确认')) or project['members']:
                        raise bad_request('空阵容行不能填写队员资料或与队员行混用')
                    project['empty_row'] = True
                    items.append({'line': row['line'], 'project': cat['name'], 'person': '', 'message': '报名，队员待补充'})
                    continue
                if project.get('empty_row'):
                    raise bad_request('空阵容行不能与队员行混用')
                p = athlete(row, cat)
                captain = truth(row.get('队长', ''), '队长')
                jersey = number(row.get('项目号码', ''), '项目号码', 20)
                if cat['kind'] == 'individual':
                    if project['athlete_key']:
                        raise bad_request('同一学校在同一个人项目最多报名 1 人（也不能重复同一行）')
                    if captain or jersey:
                        raise bad_request('个人赛不填写队长或项目号码，号码请填写常用号码')
                    project['athlete_key'] = p['key']
                else:
                    if any(m['athlete_key'] == p['key'] for m in project['members']):
                        raise bad_request('同一项目队员重复，请核对人员ID')
                    if len(project['members']) >= 6:
                        raise bad_request('三人赛每队最多 6 人')
                    old_member = next((m for m in projects[cat['id']]['members'] if m['athlete_key'] == p['key']), None)
                    jersey = jersey or (old_member['jersey_no'] if old_member else p.get('jersey_no', ''))
                    project['members'].append({'athlete_key': p['key'], 'jersey_no': jersey})
                    if captain:
                        if project['captain_key']:
                            raise bad_request('每队只能指定一位队长')
                        project['captain_key'] = p['key']
            items.append({'line': row['line'], 'project': cat['name'], 'person': row.get('运动员', ''),
                          'message': {'participate': '按本表完整名单更新项目', 'not_participating': '明确不参加', 'withdrawn': '明确退出'}[choice]})
        except ApiError as exc:
            errors.append({'line': row['line'], 'message': exc.message})
    if errors:
        return {'errors': errors, 'items': items, 'model': None, 'payload': None}
    for cid, project in listed.items():
        projects[cid].update(project_values(project))
    if len(model['people']) > 500:
        return {'errors': [{'line': None, 'message': '本次学校人员数量超过 500，请拆分'}], 'items': items, 'model': None, 'payload': None}
    return {'errors': [], 'items': items, 'model': model, 'payload': changes_from_model(snapshot, model)}

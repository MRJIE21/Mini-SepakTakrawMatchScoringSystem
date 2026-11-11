"""Organizer school workspace: projected validation, atomic commit and retries."""
from copy import deepcopy

from .. import db, idempotency, registration, security
from ..errors import ApiError, bad_request, conflict, invalid_fields
from ..http_server import route
from .common import get_or_404, category_context
from .catalog import (normalize_members, write_members, parse_seed, bump_rev,
                      expect_rev, _confirm_same_name_creation, normalized_athlete_name)

ORG = ('admin', 'organizer')


def school_context(conn, school_id):
    school = dict(get_or_404(conn, 'schools', school_id, '学校'))
    entries = db.q(conn, 'SELECT g.* FROM groups g JOIN school_entries se ON se.group_id=g.id WHERE se.school_id=?', (school_id,))
    if len(entries) != 1 or entries[0]['event_id'] != school['event_id']:
        raise bad_request('学校工作台目前要求学校属于本届赛事的一个组别')
    return school, dict(entries[0])


def fingerprint(conn):
    # Event databases are isolated. Include new rows, occupancy and scheduling/results,
    # rather than relying only on existing revisions. Conservative event-wide conflict.
    tables = ('events', 'groups', 'categories', 'schools', 'school_entries', 'athletes',
              'teams', 'team_members', 'participations', 'school_registration_choices',
              'plans', 'matches', 'placements', 'individual_results')
    state = {t: [dict(r) for r in db.q(conn, f'SELECT * FROM {t} ORDER BY id')] for t in tables}
    # A recording task may be claimed between roster preview and commit.
    state['recording_assignments'] = [dict(r) for r in db.q(conn,
        "SELECT k,v FROM settings WHERE k LIKE 'recording:%' ORDER BY k")]
    return idempotency.content_hash(state)


def workspace(conn, school_id):
    school, group = school_context(conn, school_id)
    people = [dict(r, key=f"a:{r['id']}") for r in db.q(conn, 'SELECT * FROM athletes WHERE school_id=? ORDER BY id', (school_id,))]
    cats, projects, warnings = [], [], []
    for row in db.q(conn, 'SELECT * FROM categories WHERE group_id=? ORDER BY seq,id', (group['id'],)):
        cat = dict(row)
        try:
            registration.guard_change(conn, cat['id'])
            cat['locked_reason'] = ''
        except ApiError as exc:
            cat['locked_reason'] = exc.message
        team = db.q1(conn, 'SELECT * FROM teams WHERE category_id=? AND school_id=?', (cat['id'], school_id))
        parts = db.q(conn, """SELECT p.* FROM participations p LEFT JOIN teams t ON t.id=p.team_id
            LEFT JOIN athletes a ON a.id=p.athlete_id WHERE p.category_id=?
            AND p.deleted_at IS NULL AND (t.school_id=? OR a.school_id=?) ORDER BY p.id""",
                     (cat['id'], school_id, school_id))
        active = next((p for p in parts if p['status'] == 'active'), None)
        part = active or (parts[-1] if parts else None)
        cat['roster_locked_reason'] = cat['locked_reason']
        if cat['kind'] == 'team' and active:
            try:
                registration.guard_team_roster(conn, team['id'])
                cat['roster_locked_reason'] = ''
            except ApiError as exc:
                cat['roster_locked_reason'] = exc.message
        cat['edit_notice'] = ('赛程已确认：仍可补录本队人员和号码；参赛学校与种子顺序已固定。'
                              if cat['locked_reason'] and not cat['roster_locked_reason'] else '')
        cats.append(cat)
        decision = db.q1(conn, 'SELECT choice FROM school_registration_choices WHERE school_id=? AND category_id=?', (school_id, cat['id']))
        choice = 'participate' if active else (decision['choice'] if decision else ('withdrawn' if part else 'unresolved'))
        members = db.q(conn, 'SELECT * FROM team_members WHERE team_id=? ORDER BY id', (team['id'],)) if team else []
        project = {'category_id': cat['id'], 'choice': choice,
                   'members': [{'athlete_key': f"a:{m['athlete_id']}", 'jersey_no': m['jersey_no']} for m in members],
                   'captain_key': next((f"a:{m['athlete_id']}" for m in members if m['is_captain']), ''),
                   'athlete_key': f"a:{part['athlete_id']}" if part and part['athlete_id'] else '',
                   'seed_no': part['seed_no'] if part else None, 'note': part['note'] if part else '',
                   'participation_id': part['id'] if part else None}
        projects.append(project)
        if active and team:
            if len(members) < 3:
                warnings.append({'category_id': cat['id'], 'message': '队员不足 3 人，赛前需补齐'})
        if active:
            aids = [m['athlete_id'] for m in members] if team else [part['athlete_id']]
            for aid in aids:
                a = db.q1(conn, 'SELECT name,gender FROM athletes WHERE id=?', (aid,))
                if a and not a['gender']:
                    warnings.append({'category_id': cat['id'], 'message': f"{a['name']}性别待补充"})
    event = dict(get_or_404(conn, 'events', school['event_id'], '赛事'))
    deployment = db.q1(conn, "SELECT v FROM settings WHERE k='deployment_id'")
    return {'school': school, 'group': group, 'categories': cats, 'people': people,
            'projects': projects, 'warnings': warnings, 'base_hash': fingerprint(conn),
            'event_identity': {'event_id': event['id'], 'event_uuid': event['uuid'],
                               'deployment_id': deployment['v'] if deployment else ''}}


@route('GET', r'/api/schools/(?P<school_id>\d+)/registration-workspace', roles=ORG)
def get_workspace(ctx):
    # A coherent snapshot even when another request edits a roster between reads.
    with db.tx(ctx.conn):
        return workspace(ctx.conn, int(ctx.params['school_id']))


def checked_payload(ctx, school_id):
    body = ctx.body
    if not isinstance(body, dict) or not isinstance(body.get('people', []), list) or not isinstance(body.get('projects', []), list):
        raise bad_request('人员和项目变更必须是数组')
    if len(body.get('people', [])) > 500 or len(body.get('projects', [])) > 50:
        raise bad_request('单次变更数量过多')
    school, group = school_context(ctx.conn, school_id)
    event = get_or_404(ctx.conn, 'events', school['event_id'], '赛事')
    deployment = db.q1(ctx.conn, "SELECT v FROM settings WHERE k='deployment_id'")
    expected_identity = {'event_id': event['id'], 'event_uuid': event['uuid'], 'deployment_id': deployment['v'] if deployment else ''}
    if body.get('event_identity') != expected_identity:
        raise conflict('提交包赛事身份不一致，请返回本届学校工作台', code='event_identity_mismatch')
    result = {'school_id': school_id, 'group_id': group['id'], 'user_id': ctx.user['id'],
            'event_identity': expected_identity, 'base_hash': body.get('base_hash'),
            'people': deepcopy(body.get('people', [])), 'projects': deepcopy(body.get('projects', []))}
    if 'shared_draft_rev' in body:
        # Preserve the hash of an old in-flight request for idempotent replay after upgrade.
        # This legacy field no longer gates preview/commit or reads any shared draft.
        result['shared_draft_rev'] = deepcopy(body['shared_draft_rev'])
    return result


def check_base(conn, payload):
    if payload['base_hash'] != fingerprint(conn):
        latest = workspace(conn, payload['school_id'])
        raise conflict('赛事报名或赛程已变化，请核对最新名单后重新预览。当前输入已保留。',
                       code='registration_stale', detail={'latest': latest})


def apply_changes(conn, payload):
    school, group = school_context(conn, payload['school_id'])
    people = payload['people']
    projects = payload['projects']
    if any(not isinstance(x, dict) for x in people + projects):
        raise bad_request('每一项变更必须为对象')
    keys = {f"a:{r['id']}": r['id'] for r in db.q(conn, 'SELECT id FROM athletes WHERE school_id=?', (school['id'],))}
    touched, seen_people, seen_cats, changes = set(), set(), set(), []
    # Validate all reviewed existing same-name candidates before inserting any draft people.
    for person in people:
        key = person.get('key')
        if not isinstance(key, str) or not key or key in seen_people:
            raise invalid_fields('人员标识缺失或重复', {'people': '人员标识缺失或重复'})
        seen_people.add(key)
        if key not in keys:
            if not key.startswith('new:'):
                raise invalid_fields('人员不属于该学校', {'people': '人员不属于该学校'})
            _confirm_same_name_creation(conn, school['id'], deepcopy(person))
    new_people = []
    for person in people:
        key = person['key']
        name = normalized_athlete_name(person.get('name'))
        gender = person.get('gender') or ''
        if not name or gender not in ('male', 'female', ''):
            raise invalid_fields('请填写姓名并核对性别', {'people': '姓名或性别无效'})
        fields = {'name': name, 'gender': gender, 'jersey_no': str(person.get('jersey_no') or '').strip(), 'note': str(person.get('note') or '').strip()}
        if key in keys:
            aid = keys[key]
            expect_rev(conn, person, 'athletes', aid, '运动员')
            old = dict(get_or_404(conn, 'athletes', aid, '运动员'))
            cats = registration.athlete_categories(conn, aid)
            touched.update(cats)
            if fields['name'] != old['name'] or fields['gender'] != old['gender']:
                registration.guard_athlete_identity(conn, aid)
            if any(fields[k] != old[k] for k in fields):
                db.update(conn, 'athletes', aid, fields)
                bump_rev(conn, 'athletes', aid)
                changes.append(f"更新人员：{name}")
        else:
            same_draft = [p for p in new_people if p['name'].strip().lower() == name.lower()]
            if same_draft and (person.get('confirm_distinct_person') is not True or not fields['note'] or any(p['note'].lower() == fields['note'].lower() for p in same_draft)):
                raise invalid_fields('本次填写中已有同名人员，请确认不同人并填写不同的区分信息', {'people': '同名人员未核对'})
            aid = db.insert(conn, 'athletes', dict(fields, school_id=school['id'], group_id=group['id']))
            keys[key] = aid
            new_people.append(fields)
            changes.append(f"新增人员：{name}")
    def resolve(key):
        if not isinstance(key, str) or key not in keys:
            raise invalid_fields('请选择该校已有或本次新增人员', {'projects': '人员标识无效'})
        return keys[key]

    cats, preserved_entries = {}, {}
    for project in projects:
        cid = project.get('category_id')
        if type(cid) is not int or cid in seen_cats:
            raise invalid_fields('项目标识无效或重复', {'projects': '项目标识无效或重复'})
        seen_cats.add(cid)
        cat = category_context(conn, cid)
        if cat['group_id'] != group['id']:
            raise invalid_fields('项目不属于学校所在组别', {'projects': '项目组别不符'})
        if project.get('choice') not in ('participate', 'not_participating', 'withdrawn'):
            raise invalid_fields('请选择报名、不参加或退出', {'projects': '项目选择无效'})
        cats[cid] = cat
        touched.add(cid)
        active = db.q1(conn, """SELECT p.* FROM participations p LEFT JOIN teams t ON t.id=p.team_id
            LEFT JOIN athletes a ON a.id=p.athlete_id WHERE p.category_id=? AND p.status='active'
            AND p.deleted_at IS NULL
            AND (t.school_id=? OR a.school_id=?)""", (cid, school['id'], school['id']))
        # Keeping the same entrant and seed changes no draw, slot or opponent.
        if (active and project['choice'] == 'participate'
                and parse_seed(project.get('seed_no')) == active['seed_no']
                and (cat['kind'] == 'team' or resolve(project.get('athlete_key')) == active['athlete_id'])):
            preserved_entries[cid] = active
            continue
        registration.guard_change(conn, cid)
        # Withdraw all affected entries first; additions are validated only in final state.
        db.run(conn, """UPDATE participations SET status='withdrawn',rev=rev+1
            WHERE category_id=? AND status='active' AND deleted_at IS NULL
              AND (team_id IN (SELECT id FROM teams WHERE school_id=?)
              OR athlete_id IN (SELECT id FROM athletes WHERE school_id=?))""", (cid, school['id'], school['id']))

    for project in projects:
        cid, choice = project['category_id'], project['choice']
        cat = cats[cid]
        if choice == 'participate':
            if cat['kind'] == 'team':
                raw = project.get('members', [])
                if not isinstance(raw, list) or any(not isinstance(m, dict) for m in raw):
                    raise invalid_fields('队员名单格式无效', {'members': '队员名单格式无效'})
                requested = [{'athlete_id': resolve(m.get('athlete_key')), 'jersey_no': str(m.get('jersey_no') or '').strip()} for m in raw]
                captain = resolve(project['captain_key']) if project.get('captain_key') else None
                if captain and captain not in {m['athlete_id'] for m in requested}:
                    raise invalid_fields('队长必须是已选队员之一', {'captain_key': '队长不在队员名单中'})
                team = db.q1(conn, 'SELECT * FROM teams WHERE school_id=? AND category_id=?', (school['id'], cid))
                tid = team['id'] if team else db.insert(conn, 'teams', {'category_id': cid, 'school_id': school['id'], 'name': school['short_name'] or school['name']})
                old_members = sorted((m['athlete_id'], m['jersey_no'], m['is_captain'])
                                     for m in db.q(conn, 'SELECT * FROM team_members WHERE team_id=?', (tid,)))
                new_members = sorted((m['athlete_id'], m['jersey_no'], int(m['athlete_id'] == captain)) for m in requested)
                if old_members != new_members:
                    members, captain = normalize_members(conn, {'members': requested, 'captain_id': captain}, school['id'], cat)
                    registration.guard_team_roster(conn, tid)
                    write_members(conn, tid, members, captain)
                    if team:
                        bump_rev(conn, 'teams', tid)
                subject_key, subject_id = 'team_id', tid
            else:
                subject_key, subject_id = 'athlete_id', resolve(project.get('athlete_key'))
            part = db.q1(conn, f'''SELECT * FROM participations
                WHERE category_id=? AND {subject_key}=? AND deleted_at IS NULL''',
                         (cid, subject_id))
            fields = {'status': 'active', 'seed_no': parse_seed(project.get('seed_no')), 'note': str(project.get('note') or '')}
            if cid in preserved_entries:
                if fields['note'] != part['note']:
                    db.update(conn, 'participations', part['id'], {'note': fields['note']})
                    bump_rev(conn, 'participations', part['id'])
            elif part:
                db.update(conn, 'participations', part['id'], fields)
                bump_rev(conn, 'participations', part['id'])
            else:
                db.insert(conn, 'participations', dict(fields, category_id=cid, event_id=school['event_id'], **{subject_key: subject_id}))
        if cid not in preserved_entries:
            db.run(conn, """INSERT INTO school_registration_choices(school_id,category_id,choice) VALUES(?,?,?)
                ON CONFLICT(school_id,category_id) DO UPDATE SET choice=excluded.choice,rev=rev+1""", (school['id'], cid, choice))
        changes.append(f"{cat['name']}：" + ('调整名单 / 备注' if cid in preserved_entries else
            {'participate': '报名 / 调整阵容', 'not_participating': '明确不参加', 'withdrawn': '退出'}[choice]))
    registration.validate_categories(conn, touched)
    result = workspace(conn, school['id'])
    names = {p['key']: p['name'] for p in result['people']}
    review = []
    for project in result['projects']:
        cat = next(c for c in result['categories'] if c['id'] == project['category_id'])
        review.append({'category_name': cat['name'], 'choice': project['choice'],
            'athlete_name': names.get(project['athlete_key'], ''),
            'members': [{'name': names.get(m['athlete_key'], ''), 'jersey_no': m['jersey_no']} for m in project['members']],
            'captain_name': names.get(project['captain_key'], ''), 'seed_no': project['seed_no'], 'note': project['note']})
    people_review = []
    for person in people:
        row = next(p for p in result['people'] if p['id'] == keys[person['key']])
        people_review.append({k: row[k] for k in ('name', 'gender', 'jersey_no', 'note')})
    return {'changes': changes, 'review': review, 'people_review': people_review, 'warnings': result['warnings'], 'summary': {
        'participating': sum(p['choice'] == 'participate' for p in result['projects']),
        'not_participating': sum(p['choice'] == 'not_participating' for p in result['projects']),
        'unresolved': sum(p['choice'] == 'unresolved' for p in result['projects']),
        'profile_gaps': len(result['warnings'])}, 'people_ids': keys}


@route('POST', r'/api/schools/(?P<school_id>\d+)/registration-preview', roles=ORG)
def preview(ctx):
    payload = checked_payload(ctx, int(ctx.params['school_id']))
    check_base(ctx.conn, payload)
    ctx.conn.execute('SAVEPOINT school_preview')
    try:
        result = apply_changes(ctx.conn, payload)
    finally:
        ctx.conn.execute('ROLLBACK TO school_preview')
        ctx.conn.execute('RELEASE school_preview')
    result.pop('people_ids', None)  # preview IDs are temporary, never expose them as identities
    result['preview_hash'] = idempotency.content_hash(payload)
    return result


@route('POST', r'/api/schools/(?P<school_id>\d+)/registration-commit', roles=ORG)
def commit(ctx):
    sid = int(ctx.params['school_id'])
    payload = checked_payload(ctx, sid)
    uid = idempotency.extract_uid(ctx.body)
    if not uid:
        raise bad_request('整批提交必须提供请求标识')

    def save():
        check_base(ctx.conn, payload)
        if ctx.body.get('preview_hash') != idempotency.content_hash(payload):
            raise conflict('报名内容已变化，请重新预览后确认', code='registration_preview_changed')
        result = apply_changes(ctx.conn, payload)
        security.audit(ctx.conn, ctx.user, 'school_registration_commit', 'school', sid,
                       {'changes': result['changes'], 'request_uid': uid})
        return dict(result, message='学校报名已整批保存')

    return idempotency.replay_or_run(ctx.conn, ctx.user, uid,
        {'payload': payload, 'preview_hash': ctx.body.get('preview_hash')}, save, scope=f'school-registration:{sid}')

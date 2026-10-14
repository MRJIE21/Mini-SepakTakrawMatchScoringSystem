"""School table import previews share the same projected registration validation."""
from .. import db, school_import
from ..errors import ApiError
from ..http_server import route
from .school_registration import (ORG, workspace, checked_payload, check_base,
                                  apply_changes)
from .exports import _csv_response


@route('GET', r'/api/schools/(?P<school_id>\d+)/registration-import-template.csv', roles=ORG)
def template(ctx):
    with db.tx(ctx.conn):
        snapshot = workspace(ctx.conn, int(ctx.params['school_id']))
    people = {p['key']: p for p in snapshot['people']}
    categories = {c['id']: c for c in snapshot['categories']}
    labels = {'participate': '参加', 'not_participating': '不参加', 'withdrawn': '退出', 'unresolved': '尚未决定'}
    genders = {'male': '男', 'female': '女', '': ''}
    rows, assigned = [school_import.HEADERS], set()

    def row(cat=None, project=None, key='', jersey=''):
        person = people.get(key, {})
        return [snapshot['school']['name'], cat['name'] if cat else '', cat['id'] if cat else '',
                labels[project['choice']] if project else '', person.get('name', ''), genders.get(person.get('gender', ''), ''),
                person.get('jersey_no', ''), jersey, '是' if project and key and key == project['captain_key'] else '',
                project['seed_no'] if project and project['choice'] == 'participate' else '',
                project['note'] if project else '', person.get('note', ''), person.get('id', ''), '']

    for project in snapshot['projects']:
        cat = categories[project['category_id']]
        members = project['members'] if cat['kind'] == 'team' else [{'athlete_key': project['athlete_key'], 'jersey_no': ''}]
        members = [m for m in members if m['athlete_key'] in people] if project['choice'] == 'participate' else []
        for member in members:
            rows.append(row(cat, project, member['athlete_key'], member['jersey_no']))
            assigned.add(member['athlete_key'])
        if not members:
            rows.append(row(cat, project))
    for key in people:
        if key not in assigned:
            rows.append(row(key=key))
    return _csv_response(rows, f'school_{snapshot["school"]["id"]}_registration.csv')


@route('POST', r'/api/schools/(?P<school_id>\d+)/registration-import-preview', roles=ORG)
def preview_table(ctx):
    payload = checked_payload(ctx, int(ctx.params['school_id']))
    check_base(ctx.conn, payload)
    snapshot = workspace(ctx.conn, payload['school_id'])
    result = school_import.convert(snapshot, payload, ctx.body.get('csv_text'))
    if result['errors']:
        return result
    projected = dict(payload, **{k: result['payload'][k] for k in ('people', 'projects')})
    ctx.conn.execute('SAVEPOINT school_table_preview')
    try:
        result['review'] = apply_changes(ctx.conn, projected)
        result['review'].pop('people_ids', None)
    except ApiError as exc:
        result.update(errors=[{'line': None, 'message': exc.message, 'code': exc.code}], model=None, payload=None)
    finally:
        ctx.conn.execute('ROLLBACK TO school_table_preview')
        ctx.conn.execute('RELEASE school_table_preview')
    return result

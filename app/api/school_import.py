"""School table import previews share the same projected registration validation.

The same module also serves the downloadable import artifacts: the minimal 8-column
template, a printable filling guide and an editable example CSV.
"""
from datetime import datetime

from .. import db, school_import
from ..errors import ApiError
from ..http_server import Response, route
from .exports import _csv_response, _download_disposition
from .school_registration import (ORG, workspace, checked_payload, check_base,
                                  apply_changes)

TEMPLATE_HEADERS = ['项目', '参赛选择', '运动员', '性别', '常用号码', '项目号码', '队长', '种子序号']
CHOICE_LABELS = {'participate': '参加', 'not_participating': '不参加',
                 'withdrawn': '退出', 'unresolved': '尚未决定'}
GENDER_LABELS = {'male': '男', 'female': '女', '': ''}
_UNSAFE_FILENAME_CHARS = '\\/:*?"<>|'


def _date_stamp():
    return datetime.now().strftime('%Y%m%d')


def _safe_filename_part(text):
    cleaned = ''.join('_' if ch in _UNSAFE_FILENAME_CHARS or ord(ch) < 32 else ch
                      for ch in str(text or '学校')).strip()
    return cleaned[:60] or '学校'


def _download_name(school, label, extension):
    return f'{_safe_filename_part(school["name"])}_{label}_{_date_stamp()}.{extension}'


def _people_by_key(snapshot):
    return {person['key']: person for person in snapshot['people']}


def _person_cells(person):
    return [person.get('name', ''), GENDER_LABELS.get(person.get('gender', ''), ''),
            person.get('jersey_no', '')]


def _template_rows(snapshot):
    """One row per listed person; team projects need one row per player."""
    people = _people_by_key(snapshot)
    categories = {category['id']: category for category in snapshot['categories']}
    rows = [list(TEMPLATE_HEADERS)]
    assigned = set()
    for project in snapshot['projects']:
        category = categories[project['category_id']]
        label = CHOICE_LABELS[project['choice']]
        if project['choice'] != 'participate':
            rows.append([category['name'], label, '', '', '', '', '', ''])
            continue
        seed = project.get('seed_no') if project.get('seed_no') is not None else ''
        if category['kind'] == 'team':
            members = [member for member in project['members'] if member['athlete_key'] in people]
            if not members:
                rows.append([category['name'], label, '', '', '', '', '', seed])
                continue
            for index, member in enumerate(members):
                person = people[member['athlete_key']]
                assigned.add(member['athlete_key'])
                rows.append([category['name'], label, *_person_cells(person), member.get('jersey_no', ''),
                             '是' if member['athlete_key'] == project.get('captain_key') else '',
                             seed if index == 0 else ''])
        else:
            person = people.get(project.get('athlete_key'))
            if not person:
                rows.append([category['name'], CHOICE_LABELS['unresolved'], '', '', '', '', '', ''])
                continue
            assigned.add(person['key'])
            rows.append([category['name'], label, *_person_cells(person), '', '', seed])
    for person in snapshot['people']:
        if person['key'] not in assigned:
            rows.append(['', '', *_person_cells(person), '', '', ''])
    return rows


def _example_rows(snapshot):
    """Fictional rows covering team, individual and person-only shapes."""
    rows = [list(TEMPLATE_HEADERS)]
    for project in snapshot['projects']:
        category = next(item for item in snapshot['categories'] if item['id'] == project['category_id'])
        gender = GENDER_LABELS.get(category['gender'], '男')
        if category['kind'] == 'team':
            for index in range(3):
                rows.append([category['name'], '参加', f'示例{category["id"]}号队员{index + 1}', gender,
                             str(index + 1), str(index + 1), '是' if index == 0 else '',
                             '1' if index == 0 else ''])
        else:
            rows.append([category['name'], '参加', f'示例{category["id"]}号运动员', gender, '11', '', '', ''])
    rows.append(['', '', '示例人员（仅建人员）', '男', '12', '', '', ''])
    return rows


def _guide_text(snapshot):
    school = snapshot['school']
    categories = {category['id']: category for category in snapshot['categories']}
    project_names = [categories[project['category_id']]['name'] for project in snapshot['projects']]
    lines = [
        f'学校报名表填写说明 - {school["name"]}',
        f'生成日期：{_date_stamp()}',
        '',
        '一、文件结构',
        '1. 模板为 UTF-8 CSV（带 BOM），可直接用 Excel 打开；保存时请保持 CSV 格式与表头。',
        '2. 默认 8 列：' + '、'.join(TEMPLATE_HEADERS) + '。',
        '3. 本项目可用项目：' + ('、'.join(project_names) if project_names else '（尚未配置项目）') + '。',
        '4. 旧 14 列模板（含学校、项目ID、运动员ID、同名新建确认、区分信息等）仍然兼容，可继续使用。',
        '',
        '二、字段说明',
        '项目：填写上面列出的项目名称；只维护人员、不报名时留空。',
        '参赛选择：参加 / 不参加 / 退出 / 尚未决定；留空等同“参加”。',
        '运动员：三人赛每名队员一行（3—6 行），个人赛一行；只建人员时必填。',
        '性别：男 / 女；留空时按项目性别处理。',
        '常用号码：1—20 的整数，可留空，作为人员档案号码。',
        '项目号码：1—20 的整数，仅三人赛填写；个人赛不填。',
        '队长：只有一名队员填“是”，其他人留空。',
        '种子序号：三人赛可填一次正整数；个人赛不填。',
        '',
        '三、填写规则',
        '1. 三人赛按“一名队员一行”填写，每行重复项目与参赛选择；同一项目的种子只会采用一次。',
        '2. 个人赛每校限报 1 人，只填运动员、性别、常用号码；不填项目号码和队长。',
        '3. 不参加或退出的项目：只填项目与参赛选择，不要填写任何人员字段。',
        '4. 尚未决定：只填项目与“尚未决定”，保持后台原状。',
        '5. 只建人员不报名：项目与参赛选择留空，填写运动员、性别、常用号码（区分信息等旧列可选）。',
        '6. 同一项目内队员不得重复，每队最多 6 人；同一运动员不得跨项目兼项。',
        '7. 已有人员同名时：填写“运动员ID”复用原档案；确属另一人时才用旧列“同名新建确认=是”并填写不同的区分信息。',
        '8. 号码超出 1—20、队长重复、个人赛多人等情况会被整批拒绝并提示行号。',
        '',
        '四、示例（虚构数据，导入前请替换姓名或删除示例行）',
    ]
    for row in _example_rows(snapshot):
        lines.append(','.join(str(cell) for cell in row))
    lines += [
        '',
        '五、常见错误',
        '1. 三人赛只写一行：会只登记 1 名队员，请按实际人数增加行。',
        '2. 把项目号码填到个人赛：个人赛号码请填“常用号码”。',
        '3. 同一项目多行填了不同种子：整批会拒绝，请只保留一个种子。',
        '4. 未替换示例姓名就导入：会建立“示例…”人员，请先改成真实姓名。',
        '',
        '填好后可在报名页“粘贴 / 导入学校报名表”中核对，预览通过后再整批提交。',
    ]
    return '\n'.join(lines) + '\n'


def _workspace_snapshot(conn, school_id):
    return workspace(conn, school_id)


@route('GET', r'/api/schools/(?P<school_id>\d+)/registration-import-template.csv', roles=ORG)
def template(ctx):
    with db.tx(ctx.conn):
        snapshot = _workspace_snapshot(ctx.conn, int(ctx.params['school_id']))
    return _csv_response(_template_rows(snapshot), _download_name(snapshot['school'], '报名表', 'csv'))


@route('GET', r'/api/schools/(?P<school_id>\d+)/registration-import-guide.txt', roles=ORG)
def guide(ctx):
    with db.tx(ctx.conn):
        snapshot = _workspace_snapshot(ctx.conn, int(ctx.params['school_id']))
    text = _guide_text(snapshot)
    return Response(text.encode('utf-8'), 200, 'text/plain; charset=utf-8',
                    {'Content-Disposition': _download_disposition(_download_name(snapshot['school'], '填写说明', 'txt'))})


@route('GET', r'/api/schools/(?P<school_id>\d+)/registration-import-example.csv', roles=ORG)
def example(ctx):
    with db.tx(ctx.conn):
        snapshot = _workspace_snapshot(ctx.conn, int(ctx.params['school_id']))
    return _csv_response(_example_rows(snapshot),
                         '示例_' + _download_name(snapshot['school'], '报名表', 'csv'))


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

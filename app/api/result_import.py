"""人工分组/出场顺序导入：只读预览、显式冲突处理、整批事务与幂等回执。"""
import json
import re
from collections import Counter

from .. import db, idempotency, manual_results, security
from ..errors import bad_request, conflict
from ..http_server import route
from ..result_import_files import parse_file
from .common import category_context
from .exports import _csv_response, _xlsx_response
from .xlsx import workbook_bytes

ORG = ('admin', 'organizer')
NOTICE = '本次导入为人工分组/排序结果，系统未做二次调整'


def context(ctx):
    cat = category_context(ctx.conn, int(ctx.params['category_id']))
    identity = ctx.body.get('event_identity')
    if identity is not None:
        event = db.q1(ctx.conn, 'SELECT uuid FROM events WHERE id=?', (cat['event_id'],))
        deployment = db.q1(ctx.conn, "SELECT v FROM settings WHERE k='deployment_id'")
        if identity != {'event_id': cat['event_id'], 'event_uuid': event['uuid'], 'deployment_id': deployment['v']}:
            raise conflict('赛事身份已变化，请返回当前项目核对', code='event_identity_mismatch')
    elif ctx.path.endswith('/commit'):
        raise bad_request('缺少赛事身份')
    return cat


def roster(conn, cat):
    from .group_draw import roster_for
    from ..individual_draw_store import roster as individuals
    return roster_for(conn, cat['id']) if cat['kind'] == 'team' else individuals(conn, cat['id'])


@route('GET', r'/api/categories/(?P<category_id>\d+)/result-import/template\.(?P<format>csv|xlsx)', roles=ORG)
def template(ctx):
    cat = context(ctx)
    target = '小组名称' if cat['kind'] == 'team' else '排序号'
    headers = ['人员标识', '参赛人员/学校', target, '字段说明']
    explanation = ('本模板用于录入人工已完成的分组/排序结果。人员标识为当前项目报名ID；'
                   + ('三人赛以学校报名为分组单位，不拆分队内人员。小组名称原样保存，人数不限。' if cat['kind'] == 'team'
                      else '个人赛为出场顺序，不是成绩名次。排序号为正整数，允许跳号、并列、部分参赛人员不入榜。')
                   + '删除不录入的行，填写第三列；首行表头不变。')
    rows = [[p['id'], p.get('name', p['school_name']), '', explanation] for p in roster(ctx.conn, cat)]
    if ctx.params['format'] == 'xlsx':
        return _xlsx_response(workbook_bytes(headers, rows, '人工结果'), f'manual_result_{cat["id"]}.xlsx')
    return _csv_response([headers, *rows], f'manual_result_{cat["id"]}.csv')


def preview_data(ctx, cat):
    manual_results.guard(ctx.conn, cat)
    extension, headers, rows = parse_file(ctx.body)
    target = '小组名称' if cat['kind'] == 'team' else '排序号'
    aliases = ('小组名称', '小组编号') if cat['kind'] == 'team' else ('排序号', '名次')
    targets = [h for h in aliases if h in headers]
    if '人员标识' not in headers or len(targets) != 1:
        raise bad_request(f'缺少或含歧义表头：必须包含“人员标识”和“{target}”，请下载模板')
    target = targets[0]
    people = roster(ctx.conn, cat)
    by_id = {str(p['id']): p for p in people}
    names = {}
    for person in people:
        names.setdefault(person.get('name', person['school_name']), []).append(person)
    previous = manual_results.existing(ctx.conn, cat)
    for row in rows:
        raw = row['raw']
        errors, hints = [], []
        key = raw['人员标识'].strip()
        person = by_id.get(key) if re.fullmatch(r'[0-9]+', key) else None
        if not person and not re.fullmatch(r'[0-9]+', key):
            matched = names.get(key, [])
            if len(matched) == 1:
                person = matched[0]
        if not key:
            errors.append({'field': '人员标识', 'reason': '必填字段为空'})
        elif person is None:
            errors.append({'field': '人员标识', 'reason': '无法唯一匹配当前项目有效报名；请使用模板中的报名ID'})
        value = raw[target] if cat['kind'] == 'team' else raw[target].strip()
        if not value.strip():
            errors.append({'field': target, 'reason': '必填字段为空'})
        elif cat['kind'] == 'individual':
            if len(value) > 10 or not re.fullmatch(r'[0-9]+', value) or not 1 <= int(value) <= 2147483647:
                errors.append({'field': target, 'reason': '必须是 1—2147483647 的整数；允许并列或跳号'})
            else:
                value = int(value)
        elif len(value) > 120 or value.startswith('#无法解析') or any(ord(c) < 32 for c in value):
            errors.append({'field': target, 'reason': '小组名称必须是 1—120 字符的文本，不能含控制符或公式错误'})
        pid = person['id'] if person else None
        row.update(person=person, participation_id=pid, value=value, errors=errors, hints=hints,
                   conflict=pid in previous, existing=previous.get(pid))
    duplicates = Counter(r['participation_id'] for r in rows if r['participation_id'])
    counts = Counter(str(r['value']) for r in rows if not r['errors'])
    ranks = {r['value'] for r in rows if not r['errors']} if cat['kind'] == 'individual' else set()
    for row in rows:
        if duplicates.get(row['participation_id'], 0) > 1:
            row['errors'].append({'field': '人员标识', 'reason': '同一报名在文件中重复出现，所有重复行均需核对'})
        if not row['errors']:
            if cat['kind'] == 'team':
                row['hints'].append(f'本文件该小组 {counts[str(row["value"])]} 所学校；人数由人工决定，不拦截')
            else:
                if counts[str(row['value'])] > 1:
                    row['hints'].append('并列排序号，按人工结果保存')
                if ranks and (min(ranks) != 1 or len(ranks) != max(ranks)):
                    row['hints'].append('排序号不连续，按人工结果保存')
        row['status'] = '错误' if row['errors'] else '提示' if row['hints'] or row['conflict'] else '正常'
    return {'rows': rows, 'file_type': extension, 'field': target,
            'basis': manual_results.basis(ctx.conn, cat),
            'file_hash': idempotency.content_hash({'filename': ctx.body['filename'], 'file_base64': ctx.body['file_base64']}),
            'errors': sum(bool(r['errors']) for r in rows), 'notice': NOTICE}


@route('POST', r'/api/categories/(?P<category_id>\d+)/result-import/preview', roles=ORG)
def preview(ctx):
    with db.tx(ctx.conn):
        return preview_data(ctx, context(ctx))


@route('POST', r'/api/categories/(?P<category_id>\d+)/result-import/commit', roles=ORG)
def commit(ctx):
    cat = context(ctx)
    uid = idempotency.extract_uid(ctx.body)
    if not uid or len(uid) > 120:
        raise bad_request('缺少有效请求标识')
    payload = {'path': ctx.path, 'user_id': ctx.user['id'], 'body': idempotency.payload_without_uid(ctx.body)}

    def apply():
        data = preview_data(ctx, cat)
        if ctx.body.get('basis') != data['basis'] or ctx.body.get('file_hash') != data['file_hash']:
            raise conflict('文件、报名或已有结果已变化，请重新解析预览', code='manual_result_changed')
        partial = ctx.body.get('allow_partial') is True
        if data['errors'] and not partial:
            raise bad_request('存在阻断性错误，未写入任何数据；修正文件或显式确认仅导入有效行', detail={'rows': data['rows']})
        actions = ctx.body.get('actions', {})
        if not isinstance(actions, dict) or any(v not in ('overwrite', 'skip') for v in actions.values()):
            raise bad_request('冲突处理只能选择覆盖或跳过')
        written, skipped, failures = [], [], []
        old = manual_results.existing(ctx.conn, cat)
        values = dict(old)
        for row in data['rows']:
            if row['errors']:
                failures.append({'line': row['line'], 'errors': row['errors']})
            elif row['conflict'] and actions.get(str(row['line']), 'skip') != 'overwrite':
                skipped.append(row['line'])
            else:
                values[row['participation_id']] = row['value']
                written.append(row['line'])
        if written:
            active = roster(ctx.conn, cat)
            active_ids = {p['id'] for p in active}
            # 未出现在文件中的原记录保持原值；只有显式覆盖的行改变。首次导入允许部分名单。
            saved = db.q1(ctx.conn, 'SELECT revision FROM manual_result_sets WHERE category_id=?', (cat['id'],))
            conn = ctx.conn
            revision = (saved['revision'] if saved else 0) + 1
            conn.execute('''INSERT INTO manual_result_sets(category_id,revision,roster_json,imported_by) VALUES(?,?,?,?)
                ON CONFLICT(category_id) DO UPDATE SET revision=excluded.revision,roster_json=excluded.roster_json,
                imported_by=excluded.imported_by,imported_at=datetime('now','localtime')''',
                         (cat['id'], revision, json.dumps(active, ensure_ascii=False), ctx.user['id']))
            conn.execute('DELETE FROM manual_result_rows WHERE category_id=?', (cat['id'],))
            # 本次实际写入行保持文件行序；跳过/未涉及的原记录保留原先次序及原值。
            ordered = {r['participation_id']: r['value'] for r in data['rows'] if r['line'] in written}
            ordered.update({pid: value for pid, value in values.items() if pid not in ordered})
            for seq, (pid, value) in enumerate(ordered.items(), 1):
                if pid in active_ids:
                    conn.execute('INSERT INTO manual_result_rows VALUES(?,?,?,?,?)',
                                 (cat['id'], pid, value if cat['kind'] == 'team' else None,
                                  value if cat['kind'] == 'individual' else None, seq))
        result = {'success': len(written), 'failed': len(failures), 'skipped': len(skipped),
                  'failures': failures, 'skipped_lines': skipped, 'category_id': cat['id'], 'message': NOTICE}
        security.audit(ctx.conn, ctx.user, 'manual_result_import', 'category', cat['id'],
                       {**result, 'file_type': data['file_type'], 'file_hash': data['file_hash'],
                        'overwritten_lines': [r['line'] for r in data['rows'] if r['conflict'] and r['line'] in written],
                        'changes': [{'line': r['line'], 'participation_id': r['participation_id'],
                                     'previous': r['existing'], 'value': r['value']} for r in data['rows'] if r['line'] in written],
                        'allow_partial': partial})
        return result
    with db.tx(ctx.conn):
        return idempotency.replay_or_run(ctx.conn, ctx.user, uid, payload, apply, scope='manual_result_import', strict=True)

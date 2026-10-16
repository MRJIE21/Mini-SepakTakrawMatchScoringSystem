"""Pure finite scheduling: intervals, source identities and hard rest constraints."""
from __future__ import annotations

import copy
from datetime import datetime, timedelta
from functools import lru_cache
import time

MAX_MATCHES = 2000
MAX_WINDOWS = 1000


def integer(value, label, low=1, high=10000):
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f'{label}须为{low}至{high}的整数')
    return value


def stamp(value):
    try:
        result = datetime.fromisoformat(str(value).strip())
        if result.tzinfo is not None or result.microsecond:
            raise ValueError
        return result
    except (ValueError, TypeError):
        raise ValueError('日期时间格式无效，请使用本地日期及时间') from None


def text_time(value):
    return value.isoformat(sep=' ', timespec='seconds' if value.second else 'minutes')


def settings(raw):
    if not isinstance(raw, dict):
        raise ValueError('请填写编排规则')
    stages = raw.get('stage_ids')
    if not isinstance(stages, list) or not 1 <= len(stages) <= 128:
        raise ValueError('请选择1至128个阶段')
    stages = sorted(integer(s, '阶段ID') for s in stages)
    if len(set(stages)) != len(stages):
        raise ValueError('不能重复选择阶段')
    duration = integer(raw.get('duration_minutes'), '预计单场时长', 1, 240)
    rest = integer(raw.get('rest_minutes'), '最短休息', 1, 1440)
    mode = raw.get('mode', 'fill')
    if mode not in ('fill', 'replan'):
        raise ValueError('请选择补齐或重新编排')
    windows = raw.get('windows')
    if not isinstance(windows, list) or not 1 <= len(windows) <= MAX_WINDOWS:
        raise ValueError(f'请设置1至{MAX_WINDOWS}个可用场地时段')
    normalized = []
    for item in windows:
        if not isinstance(item, dict):
            raise ValueError('场地时段格式无效')
        venue = integer(item.get('venue_id'), '场地ID')
        begin, end = stamp(item.get('start')), stamp(item.get('end'))
        if end <= begin:
            raise ValueError('可用时段的结束须晚于开始')
        normalized.append({'venue_id': venue, 'start': text_time(begin), 'end': text_time(end)})
    normalized.sort(key=lambda w: (w['venue_id'], stamp(w['start']), stamp(w['end'])))
    merged = []
    for item in normalized:
        if merged and item['venue_id'] == merged[-1]['venue_id'] and stamp(item['start']) <= stamp(merged[-1]['end']):
            merged[-1]['end'] = text_time(max(stamp(item['end']), stamp(merged[-1]['end'])))
        else:
            merged.append(dict(item))
    return {'stage_ids': stages, 'duration_minutes': duration, 'rest_minutes': rest, 'mode': mode, 'windows': merged}


def round_robin(members):
    """Circle pairing, including an implicit idle round for odd rosters."""
    if len(members) != len(set(members)):
        raise ValueError('小组成员重复')
    order = list(members)
    if len(order) % 2:
        order.append(None)
    result = []
    for rnd in range(max(0, len(order) - 1)):
        for i in range(len(order) // 2):
            a, b = order[i], order[-1-i]
            if a is not None and b is not None:
                result.append((rnd + 1, a, b))
        order = [order[0], order[-1], *order[1:-1]] if order else []
    return result


def source(row, side):
    pid = row.get(side + '_actual') or row.get(side + '_participation')
    if pid:
        return ('p', pid)
    kind = row.get(side + '_source_type')
    if kind == 'pool_rank':
        return ('r', row[side + '_source_pool'], row[side + '_source_rank'])
    if kind in ('match_winner', 'match_loser'):
        return ('w' if kind == 'match_winner' else 'l', row[side + '_source_match'])
    if kind == 'bye':
        return ('bye',)
    raise ValueError('比赛的参赛来源缺失，请先核对阶段')


class Sources:
    def __init__(self, rows, pools):
        self.rows = {r['id']: r for r in rows}
        self.pools = pools
        self.pool_matches = {}
        for row in rows:
            if row.get('pool_id'):
                self.pool_matches.setdefault(row['pool_id'], set()).add(row['id'])
        self.sides = {k: (source(r, 'home'), source(r, 'away')) for k, r in self.rows.items()}
        self.deps = {}
        for key, row in self.rows.items():
            deps = set()
            for side in ('home', 'away'):
                # Keep ordering even after a source has resolved to an actual team.
                kind = row.get(side + '_source_type')
                if kind in ('match_winner', 'match_loser'):
                    deps.add(row.get(side + '_source_match'))
                elif kind == 'pool_rank':
                    deps.update(self.pool_matches.get(row.get(side + '_source_pool'), ()))
            if key in deps or None in deps or not deps <= self.rows.keys():
                raise ValueError('前序比赛引用无效')
            self.deps[key] = deps
        visiting, done = set(), set()
        def visit(key):
            if key in visiting:
                raise ValueError('晋级关系存在循环')
            if key in done:
                return
            visiting.add(key)
            for parent in self.deps[key]:
                visit(parent)
            visiting.remove(key); done.add(key)
        for key in self.rows:
            visit(key)
        # Cache belongs to this one snapshot, not every previous HTTP request.
        self.possible = lru_cache(maxsize=32768)(self.possible)
        self.overlap = lru_cache(maxsize=65536)(self.overlap)

    def possible(self, src):
        if src[0] == 'p':
            return frozenset([src[1]])
        if src[0] == 'r':
            if src[1] not in self.pools or len(self.pools[src[1]]) < src[2]:
                raise ValueError('小组名次来源不足')
            return frozenset(self.pools[src[1]])
        if src[0] in ('w', 'l'):
            if src[1] not in self.sides:
                raise ValueError('前序比赛不存在')
            a, b = self.sides[src[1]]
            return self.possible(a) | self.possible(b)
        return frozenset()

    def overlap(self, a, b):
        if not self.possible(a).intersection(self.possible(b)):
            return False
        if a == b:
            return True
        if a[0] == b[0] == 'r' and a[1] == b[1] and a[2] != b[2]:
            return False
        if a[0] in ('w', 'l') and b[0] in ('w', 'l') and a[1] == b[1] and a[0] != b[0]:
            return False
        if a[0] in ('w', 'l'):
            return any(self.overlap(s, b) for s in self.sides[a[1]])
        if b[0] in ('w', 'l'):
            return any(self.overlap(a, s) for s in self.sides[b[1]])
        return True

    def share(self, a, b):
        return any(self.overlap(x, y) for x in self.sides[a] for y in self.sides[b])


def interval(row):
    if not row.get('scheduled_at'):
        return None
    begin = stamp(row['scheduled_at'])
    return begin, begin + timedelta(minutes=row['duration_minutes'])


def violations(rows, pools, windows=None, affected=None):
    """Independent final interval verification, also used for manual changes."""
    model = Sources(rows, pools)
    by_id = {r['id']: r for r in rows}
    spans = {k: interval(r) for k, r in by_id.items()}
    selected = set(by_id) if affected is None else set(affected)
    errors = []
    for key in selected:
        row, span = by_id[key], spans[key]
        if not span:
            continue
        if windows is not None and not any(w['venue_id'] == row.get('venue_id') and stamp(w['start']) <= span[0] and span[1] <= stamp(w['end']) for w in windows):
            errors.append(f'场次{key}不在可用场地时段内')
        for parent in model.deps[key]:
            prior = spans[parent]
            if not prior:
                errors.append(f'场次{key}的前序{parent}尚未安排时间')
            elif span[0] < prior[1] + timedelta(minutes=max(row['rest_minutes'], by_id[parent]['rest_minutes'])):
                errors.append(f'场次{key}与前序{parent}之间休息不足')
    keys = list(by_id)
    for i, key in enumerate(keys):
        a = by_id[key]; sa = spans[key]
        if not sa:
            continue
        for other in keys[i+1:]:
            if key not in selected and other not in selected:
                continue
            b = by_id[other]; sb = spans[other]
            if not sb:
                continue
            if a.get('venue_id') and a.get('venue_id') == b.get('venue_id') and sa[0] < sb[1] and sb[0] < sa[1]:
                errors.append(f'场次{key}与{other}场地时间重叠')
            rest = timedelta(minutes=max(a['rest_minutes'], b['rest_minutes']))
            if model.share(key, other) and not (sa[1] + rest <= sb[0] or sb[1] + rest <= sa[0]):
                errors.append(f'场次{key}与{other}同队休息不足')
            for child, parent in ((key, other), (other, key)):
                if parent in model.deps[child] and spans[child][0] < spans[parent][1] + rest:
                    errors.append(f'场次{child}须在前序{parent}结束并休息后开始')
    return list(dict.fromkeys(errors))


def arrange(rows, pools, config, *, seconds=5, max_nodes=100000):
    if len(rows) > MAX_MATCHES:
        raise ValueError('单次相关比赛超过2000场，请分阶段编排')
    rows = copy.deepcopy(rows)
    model = Sources(rows, pools)
    for sides in model.sides.values():
        for src in sides:
            model.possible(src)
    lookup = {r['id']: r for r in rows}
    todo = [r['id'] for r in rows if r.get('movable')]
    assigned = {r['id']: r for r in rows if not r.get('movable')}
    best = dict(assigned)
    nodes, limited = 0, False
    deadline = time.monotonic() + seconds
    windows = config['windows']
    def acceptable(candidate):
        key = candidate['id']; start, end = interval(candidate)
        for pid in model.deps[key]:
            prior = assigned.get(pid)
            if not prior or not interval(prior):
                return False
            if start < interval(prior)[1] + timedelta(minutes=max(candidate['rest_minutes'], prior['rest_minutes'])):
                return False
        for other, row in assigned.items():
            span = interval(row)
            if not span:
                continue
            rest = timedelta(minutes=max(candidate['rest_minutes'], row['rest_minutes']))
            if row.get('venue_id') == candidate['venue_id'] and start < span[1] and span[0] < end:
                return False
            if model.share(key, other) and not (end + rest <= span[0] or span[1] + rest <= start):
                return False
            if key in model.deps[other] and end + rest > span[0]:
                return False
        return True
    def choices(row):
        values = set()
        for window in windows:
            if row.get('fixed_venue') and row['fixed_venue'] != window['venue_id']:
                continue
            begin, finish = stamp(window['start']), stamp(window['end'])
            starts = {begin}
            if row.get('fixed_start'):
                starts = {stamp(row['fixed_start'])}
            else:
                for other in assigned.values():
                    span = interval(other)
                    if span:
                        starts.add(span[1])
                        starts.add(span[1] + timedelta(minutes=max(row['rest_minutes'], other['rest_minutes'])))
            for start in starts:
                if begin <= start and start + timedelta(minutes=row['duration_minutes']) <= finish:
                    values.add((start, window['venue_id']))
        return sorted(values)
    def search(left):
        nonlocal best, nodes, limited
        if len(assigned) > len(best):
            best = dict(assigned)
        if not left:
            return True
        if nodes >= max_nodes or time.monotonic() >= deadline:
            limited = True
            return False
        ready = [k for k in left if model.deps[k] <= assigned.keys()]
        if not ready:
            return False
        key = min(ready, key=lambda k: (not bool(lookup[k].get('fixed_start')), lookup[k].get('round_no', 1), lookup[k].get('stage_id', 0), k))
        row = lookup[key]
        for start, venue in choices(row):
            nodes += 1
            if nodes >= max_nodes or time.monotonic() >= deadline:
                limited = True
                return False
            candidate = {**row, 'scheduled_at': text_time(start), 'venue_id': venue}
            if acceptable(candidate):
                assigned[key] = candidate
                if search(left - {key}):
                    return True
                assigned.pop(key)
                if limited:
                    return False
        return False
    # Iterative depth protection is explicit rather than crashing on huge scopes.
    if len(todo) > 500:
        raise ValueError('本次待排比赛超过500场，请按阶段分批编排')
    complete = search(set(todo))
    solution = assigned if complete else best
    changes = [solution[k] for k in todo if k in solution]
    final = [solution.get(r['id'], r) for r in rows]
    checks = violations(final, pools, windows, {r['id'] for r in changes})
    fixed_checks = {r['id'] for r in final if r.get('validate_fixed')}
    if fixed_checks:
        checks.extend(violations(final, pools, affected=fixed_checks))
    if checks:
        raise ValueError('固定安排不满足当前规则，请选择重排或调整规则：' + '；'.join(checks[:3]))
    return {'complete': complete, 'status': 'complete' if complete else 'search_limit' if limited else 'unplaced',
            'changes': changes, 'unplaced': [k for k in todo if k not in solution], 'nodes': nodes,
            'reason': '搜索达到计算预算，请缩小阶段范围或增加可用时段' if limited else '可用时段、固定安排、队伍休息或前序时间约束不足，请调整规则'}

"""Explicit competition stages. No general format catalogue or seed ordering."""
from __future__ import annotations

import copy

PURPOSES = ('group', 'knockout', 'placement', 'manual')


def integer(value, label, minimum=1, maximum=10000):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f'{label}须为{minimum}至{maximum}的整数')
    return value


def group_entries(pools, ranks):
    """Rank-major order, adjacent groups; odd final group has an explicit BYE."""
    entries, slots, required = [], [], []
    for rank in ranks:
        offset = len(entries)
        for pool in pools:
            if len(pool['members']) < rank:
                raise ValueError(f"{pool['name']}没有第{rank}名，请调整参赛来源")
            entries.append({'type': 'pool_rank', 'pool_id': pool['id'], 'rank': rank})
        for index in range(0, len(pools), 2):
            left = offset + index
            if index + 1 < len(pools):
                slots.extend((left, left + 1))
                required.append([left, left + 1])
            else:
                slots.extend((left, None))
    return entries, slots, required


def compile_stage(definition):
    """Pure finite graph; all BYEs are returned for explicit user confirmation."""
    data = copy.deepcopy(definition)
    purpose = data.get('purpose')
    if purpose not in PURPOSES:
        raise ValueError('请选择小组赛、淘汰赛、名次赛或手工比赛')
    name = data.get('name')
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 80:
        raise ValueError('阶段名称须为1至80个字符')
    result = {'purpose': purpose, 'name': name.strip(), 'matches': [], 'awards': [], 'byes': []}
    if purpose in ('group', 'manual'):
        if data.get('entries') or data.get('bracket_slots'):
            raise ValueError('小组赛和手工阶段请逐场新增比赛')
        return result
    entries = data.get('entries')
    if not isinstance(entries, list) or not 2 <= len(entries) <= 128:
        raise ValueError('阶段须有2至128个有效参赛来源')
    if purpose == 'knockout' and len(entries) < 4:
        raise ValueError('完整决出前四名至少需要4支队伍')
    seen = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError('参赛来源格式无效')
        kind = entry.get('type')
        if kind == 'pool_rank':
            key = (kind, integer(entry.get('pool_id'), '小组ID'), integer(entry.get('rank'), '小组名次'))
        elif kind == 'participation':
            key = (kind, integer(entry.get('participation_id'), '参赛ID'))
        elif kind in ('match_winner', 'match_loser'):
            key = (kind, integer(entry.get('match_id'), '前场ID'))
        else:
            raise ValueError('阶段初始来源无效；轮空须在签位中单独确认')
        if key in seen:
            raise ValueError('阶段参赛来源重复')
        seen.add(key)
    slots = data.get('bracket_slots', list(range(len(entries))))
    if not isinstance(slots, list) or not 2 <= len(slots) <= 256 or len(slots) % 2:
        raise ValueError('首轮签位须成对；请明确处理落单来源或轮空')
    actual = [integer(index, '签位下标', 0, len(entries) - 1) for index in slots if index is not None]
    if sorted(actual) != list(range(len(entries))):
        raise ValueError('首轮签位必须恰好包含每个参赛来源一次')
    initial_pairs = {frozenset(slots[i:i + 2]) for i in range(0, len(slots), 2) if None not in slots[i:i + 2]}
    for pair in data.get('required_pairs', []):
        if frozenset(pair) not in initial_pairs:
            raise ValueError('首轮必须保留相邻组同名次对阵，不能按种子重排')
    bye = {'type': 'bye'}
    first = [copy.deepcopy(entries[index]) if index is not None else bye for index in slots]

    def add(a, b, round_no, label, role='round', winner=None, loser=None):
        key = 'n' + str(len(result['matches']) + 1)
        result['matches'].append({'key': key, 'round_no': round_no, 'round_label': label,
                                  'home': a, 'away': b, 'role': role,
                                  'winner_rank': winner, 'loser_rank': loser})
        return {'type': 'match_winner', 'key': key}, {'type': 'match_loser', 'key': key}

    def layer(nodes, round_no, label):
        winners, losers = [], []
        for index in range(0, len(nodes), 2):
            a, b = nodes[index:index + 2]
            if a['type'] == 'bye' and b['type'] == 'bye':
                continue
            if a['type'] == 'bye' or b['type'] == 'bye':
                source = b if a['type'] == 'bye' else a
                result['byes'].append({'round_no': round_no, 'source': source})
                winners.append(source)
            else:
                win, lose = add(a, b, round_no, label)
                winners.append(win)
                losers.append(lose)
        return winners, losers

    def balanced(nodes):
        size = 1 << (len(nodes) - 1).bit_length()
        missing = size - len(nodes)
        if not missing:
            return nodes
        cut = len(nodes) - missing
        return nodes[:cut] + [item for node in nodes[cut:] for item in (node, bye)]

    if purpose == 'knockout':
        current, round_no = first, 1
        semifinal_losers = []
        while len([node for node in current if node['type'] != 'bye']) > 1:
            count = len([node for node in current if node['type'] != 'bye'])
            label = '冠亚军赛' if count == 2 else '半决赛' if count == 4 and len(current) == 4 else f'淘汰赛第{round_no}轮'
            winners, losers = layer(current, round_no, label)
            if count == 4 and len(current) == 4:
                semifinal_losers = losers
            if count == 2:
                final = result['matches'][-1]
                final.update(role='final', winner_rank=1, loser_rank=2)
            current, round_no = balanced(winners), round_no + 1
        if len(semifinal_losers) != 2:
            raise ValueError('当前签位不能完整产生两场半决赛，请调整轮空位置')
        add(*semifinal_losers, round_no - 1, '三四名决赛', role='bronze', winner=3, loser=4)
        result.update(rank_from=1, rank_to=4)
    else:
        start = integer(data.get('rank_from'), '起始名次')
        end = integer(data.get('rank_to'), '结束名次')
        if end - start + 1 != len(entries):
            raise ValueError('名次范围须与本阶段参赛来源数量一致')

        def classify(nodes, low, round_no, first_round=False):
            nodes = [node for node in nodes if node['type'] != 'bye'] if not first_round else nodes
            active = [node for node in nodes if node['type'] != 'bye']
            if len(active) == 1:
                result['awards'].append({'rank': low, 'source': active[0]})
                return
            if not active:
                return
            pair_nodes = nodes if first_round else balanced(nodes)
            if len(active) == 2 and len(pair_nodes) == 2:
                add(*pair_nodes, round_no, f'第{low}—{low + 1}名', role='placement', winner=low, loser=low + 1)
                return
            wins, losses = layer(pair_nodes, round_no, f'第{low}—{low + len(active) - 1}名首轮')
            classify(wins, low, round_no + 1)
            classify(losses, low + len(wins), round_no + 1)

        classify(first, start, 1, True)
        result.update(rank_from=start, rank_to=end)
    # Explicit final outputs must determine exactly the declared range, once each.
    ranks = [row['rank'] for row in result['awards']]
    for match in result['matches']:
        ranks.extend(rank for rank in (match['winner_rank'], match['loser_rank']) if rank is not None)
    if sorted(ranks) != list(range(result['rank_from'], result['rank_to'] + 1)):
        raise ValueError('决位关系不完整或正式名次重复')
    return result

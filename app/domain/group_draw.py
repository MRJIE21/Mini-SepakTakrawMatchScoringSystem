"""学校小组抽签：随机洗牌、按种子分档，生成一次固定的揭晓顺序。"""
from __future__ import annotations

import secrets


def draw_groups(roster: list[dict], method: str, capacities: list[int], rng=None) -> list[dict]:
    if method not in ("random", "seeded"):
        raise ValueError("请选择完全随机或种子分档")
    count, groups = len(roster), len(capacities)
    if groups < 1:
        raise ValueError("请至少设置 1 个小组")
    if any(type(n) is not int or n < 1 for n in capacities) or sum(capacities) != count:
        raise ValueError("各组人数须为正整数，合计须等于已报名学校数")
    if count > 1000 or len({p['id'] for p in roster}) != count:
        raise ValueError("参赛学校名单无效或超过 1000 所")
    rng = rng or secrets.SystemRandom()
    if method == "random":
        entrants = list(roster)
        slots = [group for group, capacity in enumerate(capacities) for _ in range(capacity)]
        rng.shuffle(entrants)
        rng.shuffle(slots)
        return [{"participation_id": p['id'], "group": group, "pot": None}
                for p, group in zip(entrants, slots)]
    seeds = [p.get('seed_no') for p in roster]
    if any(type(n) is not int or n < 1 for n in seeds) or len(set(seeds)) != count:
        raise ValueError("种子分档需要为每所学校设置唯一的正整数种子序号，请先到报名名单补齐")
    if max(capacities) - min(capacities) > 1:
        raise ValueError("种子分档时各组人数最多相差 1，才能保证每组每档最多一校")
    entrants = sorted(roster, key=lambda p: p['seed_no'])
    used = [0] * groups
    steps = []
    for start in range(0, count, groups):
        pot = entrants[start:start + groups]
        rng.shuffle(pot)
        eligible = [group for group, capacity in enumerate(capacities) if used[group] < capacity]
        rng.shuffle(eligible)
        for p, group in zip(pot, eligible):
            steps.append({"participation_id": p['id'], "group": group, "pot": start // groups + 1})
            used[group] += 1
    return steps

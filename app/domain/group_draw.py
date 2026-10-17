"""学校小组抽签：随机洗牌、按种子分档、按小组顺序循环落位，生成一次固定的揭晓顺序。"""
from __future__ import annotations

import secrets

METHODS = ("random", "seeded", "cycle")
METHOD_LABELS = {"random": "完全随机", "seeded": "种子分档", "cycle": "循环落位"}


def method_label(method: str) -> str:
    """方式中文名的唯一来源；未知值回退为原始值，避免历史记录被改写。"""
    return METHOD_LABELS.get(method, method or '')


def draw_groups(roster: list[dict], method: str, capacities: list[int], rng=None) -> list[dict]:
    if method not in METHODS:
        raise ValueError("请选择完全随机、种子分档或循环落位")
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
    if method == "cycle":
        # 每签先从剩余学校中随机抽一所，再按小组顺序把指针前移一格落位（A,B,C,A,B…）：
        # 指针遇到已满的小组就继续前移，满员组被跳过而不是一直填满一个组。
        # 剩余学校池为空是唯一退出条件，保证终止且不重复。
        remaining = list(roster)
        used = [0] * groups
        steps = []
        pointer = 0
        while remaining:
            school = rng.choice(remaining)
            remaining.remove(school)
            for _ in range(groups):
                target = pointer % groups
                pointer += 1
                if used[target] < capacities[target]:
                    break
            else:  # pragma: no cover - 入口已校验合计与名额，防御性分支
                raise ValueError("小组名额不足，无法继续落位")
            used[target] += 1
            steps.append({"participation_id": school['id'], "group": target, "pot": None})
        return steps
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

"""编排生成器（设计大纲 5.4）。

支持的阶段类型：
  round_robin  单循环、双循环（分组、奇数队轮次空闲、不等人数小组）
  single_elim  单淘汰（种子签位、轮空、季军赛）
  double_elim  双淘汰（胜者区、败者区、决赛是否重置赛前锁定）
  swiss        瑞士制（逐轮生成，优先避免重复对阵，奇数队轮空）
  gauntlet     阶梯淘汰（按种子顺序依次挑战）
  placement    评次与安慰赛（指定名次范围的循环或淘汰）
  custom       自定义组合（签位来源与名次归属由管理员逐场指定）

生成器只使用 SlotSpec 描述参赛位置，因此既支持已确定的参赛主体，
也支持“某小组第 N 名”“某场胜者/负者”这类待解析来源。

生成结果不落库；由 app/api/scheduling.py 负责写入数据库。
"""
from __future__ import annotations

from helpers.legacy_slots import GenMatch, GenPool, GenStage, SlotSpec, seed_positions, split_pools, pool_name


def _round_label(match_count: int, round_no: int) -> str:
    names = {1: "决赛", 2: "半决赛", 4: "1/4决赛", 8: "1/8决赛", 16: "1/16决赛", 32: "1/32决赛"}
    return names.get(match_count, f"第{round_no}轮")


def plan_pools(count: int, params: dict) -> list[tuple[str, list[int]]]:
    """确定小组数量与成员（返回 [(小组名, 序号列表)]）。"""
    explicit = params.get("pools")
    if explicit:
        out = []
        pos = 0
        for i, item in enumerate(explicit):
            name = item.get("name") or pool_name(i)
            if item.get("members") is not None:
                members = [int(x) for x in item["members"]]
            else:
                size = int(item.get("size") or 0)
                members = list(range(pos, min(pos + size, count)))
                pos += size
            out.append((name, members))
        return out
    pool_count = int(params.get("pool_count") or 0)
    if pool_count > 1:
        groups = split_pools(count, pool_count, params.get("assign", "snake"))
        return [(pool_name(i), g) for i, g in enumerate(groups)]
    return [(params.get("pool_name") or "小组", list(range(count)))]


def round_robin_pairs(n: int) -> list[list[tuple[int, int]]]:
    """圆桌轮转法。奇数时返回的轮次里少一场（轮次空闲，不生成比赛）。"""
    idx: list[int | None] = list(range(n))
    if n % 2 == 1:
        idx.append(None)
    size = len(idx)
    arr = idx[:]
    rounds: list[list[tuple[int, int]]] = []
    for _ in range(size - 1):
        pairs = []
        for i in range(size // 2):
            a, b = arr[i], arr[size - 1 - i]
            if a is not None and b is not None:
                pairs.append((a, b))
        rounds.append(pairs)
        arr = [arr[0]] + [arr[-1]] + arr[1:-1]
    return rounds


# --------------------------------------------------------------------- 循环
def gen_round_robin(sources: list[SlotSpec], params: dict, seq: int, name: str) -> GenStage:
    stage = GenStage(kind="round_robin", name=name, seq=seq, params=params)
    legs = int(params.get("legs") or 1)
    pools = plan_pools(len(sources), params)
    match_seq = 0
    for pseq, (pname, idxs) in enumerate(pools):
        pool = GenPool(key=f"p{pseq}", name=pname, kind="group", seq=pseq,
                       members=[sources[i].participation_id for i in idxs
                                if sources[i].type == "participation"],
                       rank_from=params.get("rank_from"), rank_to=params.get("rank_to"))
        stage.pools.append(pool)
        if len(idxs) < 2:
            stage.warnings.append(f"{pname} 只有 {len(idxs)} 名参赛者，不生成对阵，需组织者确认名次处理")
            continue
        local = [sources[i] for i in idxs]
        rounds = round_robin_pairs(len(local))
        for leg in range(legs):
            for rno, pairs in enumerate(rounds):
                round_no = leg * len(rounds) + rno + 1
                label = f"第{round_no}轮"
                if legs > 1:
                    label = f"第{leg + 1}循环{label}"
                for a, b in pairs:
                    match_seq += 1
                    home, away = (local[a], local[b]) if leg % 2 == 0 else (local[b], local[a])
                    stage.matches.append(GenMatch(
                        key=f"m{match_seq}", round_no=round_no, round_label=label,
                        home=home, away=away, seq=match_seq, pool_key=pool.key))
    return stage


# --------------------------------------------------------------------- 淘汰
def _bracket_layer(entries: list[SlotSpec], round_no: int, label: str, stage: GenStage,
                   pools_key: str, next_seq: int, note: str = ""
                   ) -> tuple[list[SlotSpec], list[SlotSpec], int]:
    """把一层签位两两配对。轮空直接晋级，不生成虚假比赛。

    返回 (每节点的胜者签位, 每节点的负者签位, 下一个序号)。
    负者签位按“节点”给出：轮空节点的负者位置同样是轮空，
    这样败者区才能与签位结构对齐，不会因为首轮轮空不生成比赛而少一个进入败者区的位置。
    """
    winners: list[SlotSpec] = []
    losers: list[SlotSpec] = []
    i = 0
    while i < len(entries):
        a = entries[i]
        b = entries[i + 1] if i + 1 < len(entries) else SlotSpec("bye")
        i += 2
        if a.is_bye() and b.is_bye():
            winners.append(SlotSpec("bye"))
            losers.append(SlotSpec("bye"))
            continue
        if a.is_bye() or b.is_bye():
            winners.append(b if a.is_bye() else a)   # 轮空直接晋级
            losers.append(SlotSpec("bye"))
            continue
        next_seq += 1
        m = GenMatch(key=f"m{next_seq}", round_no=round_no, round_label=label,
                     home=a, away=b, seq=next_seq, note=note, pool_key=pools_key)
        stage.matches.append(m)
        winners.append(SlotSpec("match_winner", match_ref=m.key))
        losers.append(SlotSpec("match_loser", match_ref=m.key))
        m.loser_ref = SlotSpec("match_loser", match_ref=m.key)
    return winners, losers, next_seq


def _seed_entries(sources: list[SlotSpec]) -> tuple[list[SlotSpec], int]:
    n = len(sources)
    size = 1
    while size < n:
        size *= 2
    order = seed_positions(size)
    entries = [sources[s - 1] if s <= n else SlotSpec("bye") for s in order]
    return entries, size


def gen_single_elim(sources: list[SlotSpec], params: dict, seq: int, name: str) -> GenStage:
    stage = GenStage(kind="single_elim", name=name, seq=seq, params=params)
    n = len(sources)
    if n < 2:
        stage.warnings.append("参赛者不足 2 名，不生成淘汰对阵，由组织者确认名次处理")
        return stage
    pool = GenPool(key="b0", name=params.get("pool_name") or "淘汰赛", kind="bracket", seq=0,
                   members=[s.participation_id for s in sources if s.type == "participation"],
                   rank_from=params.get("rank_from"), rank_to=params.get("rank_to"))
    stage.pools.append(pool)
    entries, size = _seed_entries(sources)
    n_matches = size // 2
    total_rounds = 0
    while n_matches >= 1:
        total_rounds += 1
        n_matches //= 2
    layers: list[list[SlotSpec]] = [entries]
    cur = entries
    mseq = 0
    semi_matches: list[GenMatch] = []
    for rno in range(1, total_rounds + 1):
        count = len(cur) // 2
        label = _round_label(count, rno)
        cur, _losers, mseq = _bracket_layer(cur, rno, label, stage, "b0", mseq)
        if count == 2:
            semi_matches = [m for m in stage.matches if m.round_no == rno]
    if params.get("third_place") and len(semi_matches) == 2:
        mseq += 1
        stage.matches.append(GenMatch(
            key=f"m{mseq}", round_no=total_rounds, round_label="三、四名决赛",
            home=semi_matches[0].loser_ref, away=semi_matches[1].loser_ref,
            seq=mseq, note="评次：第3、4名", pool_key=pool.key))
    if any(s.is_bye() for s in entries):
        stage.warnings.append("淘汰签位包含轮空，轮空不计实际比赛得分")
    return stage


# --------------------------------------------------------------------- 双淘汰
def gen_double_elim(sources: list[SlotSpec], params: dict, seq: int, name: str) -> GenStage:
    stage = GenStage(kind="double_elim", name=name, seq=seq, params=params)
    n = len(sources)
    if n < 2:
        stage.warnings.append("参赛者不足 2 名，不生成对阵，由组织者确认名次处理")
        return stage
    stage.pools.append(GenPool(key="b0", name=params.get("pool_name") or "胜者区", kind="bracket",
                               seq=0, members=[s.participation_id for s in sources
                                               if s.type == "participation"]))
    stage.pools.append(GenPool(key="b1", name="败者区", kind="bracket", seq=1, members=[]))
    entries, size = _seed_entries(sources)
    k = 0
    while (1 << k) < size:
        k += 1
    mseq = 0
    wb_losers: dict[int, list[SlotSpec]] = {}
    wb_cur, wb_losers[1], mseq = _bracket_layer(entries, 1, _round_label(size // 2, 1),
                                                stage, "b0", mseq)
    cur = wb_cur
    for rno in range(2, k + 1):
        count = len(cur) // 2
        cur, wb_losers[rno], mseq = _bracket_layer(cur, rno, _round_label(count, rno),
                                                   stage, "b0", mseq)
    wb_winner = cur[0] if cur else SlotSpec("bye")

    # 败者区
    lb_round = 0
    lb_cur = list(wb_losers.get(1, []))
    if k >= 2 and lb_cur:
        lb_round += 1
        mseq += 0
        lb_cur, _lb_out, mseq = _bracket_layer(lb_cur, 100 + lb_round,
                                               f"败者区第{lb_round}轮", stage, "b1", mseq)
        for rno in range(2, k + 1):
            wl = list(wb_losers.get(rno, []))[::-1]
            mixed: list[SlotSpec] = []
            for j, w in enumerate(lb_cur):
                mixed.append(w)
                mixed.append(wl[j] if j < len(wl) else SlotSpec("bye"))
            if len(mixed) < 2:
                continue
            lb_round += 1
            lb_cur, _lb_out, mseq = _bracket_layer(mixed, 100 + lb_round,
                                                   f"败者区第{lb_round}轮", stage, "b1", mseq)
            if len(lb_cur) > 1:
                lb_round += 1
                lb_cur, _lb_out, mseq = _bracket_layer(lb_cur, 100 + lb_round,
                                                       f"败者区第{lb_round}轮", stage, "b1", mseq)
    lb_winner = lb_cur[0] if lb_cur else SlotSpec("bye")

    mseq += 1
    stage.matches.append(GenMatch(
        key=f"m{mseq}", round_no=200, round_label="决赛",
        home=wb_winner, away=lb_winner, seq=mseq, is_grand_final=True, pool_key="b0",
        note="胜者区冠军对败者区冠军"))
    if lb_round == 0 and k == 1:
        stage.warnings.append("参赛 2 队时保留决赛及必要的重赛；每场按项目比赛规则计分")
    if params.get("grand_final_reset"):
        stage.note = "决赛重置已选定：败者区队伍赢下决赛后加赛一场"
    return stage


# --------------------------------------------------------------------- 瑞士
def swiss_first_round(sources: list[SlotSpec], params: dict) -> tuple[list[tuple[SlotSpec, SlotSpec]],
                                                                      SlotSpec | None, list[str]]:
    """首轮配对：默认上下半区对折（1 对 n/2+1）。"""
    warnings: list[str] = []
    working = list(sources)
    bye = None
    if len(working) % 2 == 1:
        bye = working.pop()          # 末位种子轮空
        warnings.append("参赛数为奇数，末位种子本轮轮空")
    n = len(working)
    pairs = []
    mode = params.get("first_round", "fold")
    if mode == "adjacent":
        for i in range(0, n, 2):
            pairs.append((working[i], working[i + 1]))
    else:
        half = n // 2
        for i in range(half):
            pairs.append((working[i], working[half + i]))
    return pairs, bye, warnings


def swiss_next_round(ordered: list[SlotSpec], played: set[tuple[int, int]],
                     byes_given: set[int], params: dict
                     ) -> tuple[list[tuple[SlotSpec, SlotSpec]], SlotSpec | None, list[str]]:
    """按当前成绩配对（ordered 已按成绩排序），优先避免重复对阵。"""
    warnings: list[str] = []
    working = list(ordered)
    bye = None
    if len(working) % 2 == 1:
        for i in range(len(working) - 1, -1, -1):
            pid = working[i].participation_id
            if pid not in byes_given:
                bye = working.pop(i)
                break
        else:
            bye = working.pop()
        warnings.append("参赛数为奇数，安排轮空")
    if params.get("avoid_rematch", True):
        pairs: list[tuple[SlotSpec, SlotSpec]] = []
        used: set[int] = set()
        for i, a in enumerate(working):
            if i in used:
                continue
            chosen = None
            for j in range(i + 1, len(working)):
                if j in used:
                    continue
                b = working[j]
                key = _pair_key(a.participation_id, b.participation_id)
                if key not in played:
                    chosen = j
                    break
            if chosen is None:
                for j in range(i + 1, len(working)):
                    if j not in used:
                        chosen = j
                        warnings.append(f"无法完全避免重复对阵：{a.participation_id} 与 "
                                        f"{working[j].participation_id} 再次相遇")
                        break
            if chosen is None:
                continue
            used.add(i)
            used.add(chosen)
            pairs.append((a, working[chosen]))
        return pairs, bye, warnings
    pairs = []
    for i in range(0, len(working) - 1, 2):
        pairs.append((working[i], working[i + 1]))
    return pairs, bye, warnings


def _pair_key(a: int | None, b: int | None) -> tuple[int, int]:
    x, y = int(a or 0), int(b or 0)
    return (x, y) if x <= y else (y, x)


# --------------------------------------------------------------------- 阶梯
def gen_gauntlet(sources: list[SlotSpec], params: dict, seq: int, name: str) -> GenStage:
    stage = GenStage(kind="gauntlet", name=name, seq=seq, params=params)
    n = len(sources)
    if n < 2:
        stage.warnings.append("参赛者不足 2 名，不生成对阵")
        return stage
    stage.pools.append(GenPool(key="b0", name=params.get("pool_name") or "阶梯淘汰",
                               kind="bracket", seq=0,
                               members=[s.participation_id for s in sources
                                        if s.type == "participation"]))
    order = list(reversed(sources))     # 低种子先出场，逐级向上挑战
    cur: SlotSpec | None = None
    for i in range(n - 1):
        if i == 0:
            home, away = order[0], order[1]
        else:
            home, away = cur, order[i + 1]
        last = (i == n - 2)
        m = GenMatch(key=f"m{i + 1}", round_no=i + 1,
                     round_label="决赛" if last else f"阶梯第{i + 1}场",
                     home=home, away=away, seq=i + 1, pool_key="b0",
                     note="决定第 1、2 名" if last else "胜者继续挑战上一档种子")
        stage.matches.append(m)
        cur = SlotSpec("match_winner", match_ref=m.key)
    return stage


# --------------------------------------------------------------------- 评次
def gen_placement(sources: list[SlotSpec], params: dict, seq: int, name: str) -> GenStage:
    """评次与安慰赛：在给定来源之间安排循环或淘汰。"""
    fmt = params.get("format", "round_robin")
    rfrom = params.get("rank_from")
    rto = params.get("rank_to")
    label = params.get("pool_name") or (f"第{rfrom}—{rto}名比赛" if rfrom and rto else name)
    sub = dict(params)
    sub["pool_name"] = label
    if fmt == "single_elim":
        sub["third_place"] = bool(params.get("third_place"))
        stage = gen_single_elim(sources, sub, seq, name)
    else:
        sub["legs"] = int(params.get("legs") or 1)
        stage = gen_round_robin(sources, sub, seq, name)
    stage.kind = "placement"
    stage.params = params
    if len(sources) < 2:
        stage.warnings.append("评次阶段参赛者不足 2 名，未生成对阵")
    return stage


# --------------------------------------------------------------------- 入口
def generate_stage(kind: str, sources: list[SlotSpec], params: dict, seq: int, name: str,
                   swiss_history: dict | None = None) -> GenStage:
    if kind == "round_robin":
        return gen_round_robin(sources, params, seq, name)
    if kind == "single_elim":
        return gen_single_elim(sources, params, seq, name)
    if kind == "double_elim":
        return gen_double_elim(sources, params, seq, name)
    if kind == "gauntlet":
        return gen_gauntlet(sources, params, seq, name)
    if kind == "placement":
        return gen_placement(sources, params, seq, name)
    if kind == "swiss":
        stage = GenStage(kind="swiss", name=name, seq=seq, params=params)
        stage.pools.append(GenPool(key="b0", name=params.get("pool_name") or "瑞士制",
                                   kind="group", seq=0,
                                   members=[s.participation_id for s in sources
                                            if s.type == "participation"]))
        if swiss_history is None:
            pairs, bye, warnings = swiss_first_round(sources, params)
            round_no = 1
        else:
            pairs, bye, warnings = swiss_next_round(
                sources, swiss_history.get("played", set()),
                swiss_history.get("byes", set()), params)
            round_no = int(swiss_history.get("round_no", 1))
        stage.warnings.extend(warnings)
        for i, (a, b) in enumerate(pairs, start=1):
            stage.matches.append(GenMatch(key=f"m{i}", round_no=round_no,
                                          round_label=f"第{round_no}轮",
                                          home=a, away=b, seq=i, pool_key="b0"))
        if bye is not None:
            stage.bye_participation = bye.participation_id
            stage.note = f"本轮轮空：{bye.describe()}（按方案设定处理轮空积分）"
        return stage
    if kind == "custom":
        stage = GenStage(kind="custom", name=name, seq=seq, params=params)
        stage.warnings.append("自定义阶段：由管理员逐场指定签位来源与名次归属")
        return stage
    raise ValueError(f"未知编排类型：{kind}")


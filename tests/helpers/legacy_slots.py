"""Historical data fixture types, not imported by application code."""
from dataclasses import dataclass, field
from app.domain.slots import SlotSpec, pool_name

@dataclass
class GenMatch:
    """生成阶段的场次（尚未落库）。"""

    key: str
    round_no: int
    round_label: str
    home: SlotSpec
    away: SlotSpec
    seq: int = 0
    note: str = ""
    is_grand_final: bool = False
    loser_ref: "SlotSpec | None" = None
    pool_key: str | None = None


@dataclass
class GenPool:
    key: str
    name: str
    kind: str = "group"
    seq: int = 0
    members: list[int] = field(default_factory=list)       # participation id
    rank_from: int | None = None
    rank_to: int | None = None


@dataclass
class GenStage:
    kind: str
    name: str
    seq: int
    params: dict = field(default_factory=dict)
    pools: list[GenPool] = field(default_factory=list)
    matches: list[GenMatch] = field(default_factory=list)
    note: str = ""
    warnings: list[str] = field(default_factory=list)
    bye_participation: int | None = None


def seed_positions(size: int) -> list[int]:
    """标准种子签位顺序。size=8 → [1,8,5,4,3,6,7,2]。"""
    if size < 2:
        return [1]
    order = [1, 2]
    while len(order) < size:
        n = len(order) * 2
        nxt: list[int] = []
        for s in order:
            nxt.append(s)
            nxt.append(n + 1 - s)
        order = nxt
    return order


def pool_name(index: int, suffix: str = "小组") -> str:
    """Unique alphabetic labels continue from Z to AA, AB, ... ."""
    letters = ""
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters + suffix


def split_pools(count: int, pool_count: int, mode: str = "snake") -> list[list[int]]:
    """按序号把参赛主体分配到小组。

    mode: snake（蛇形均衡）| sequential（顺序切分）| balanced（按人数均衡）
    返回每组的序号列表（0 起）。
    """
    indexes = list(range(count))
    if pool_count <= 0:
        return [indexes]
    if mode == "sequential":
        size = -(-count // pool_count)
        return [indexes[i * size:(i + 1) * size] for i in range(pool_count)]
    if mode == "balanced":
        base, extra = divmod(count, pool_count)
        out, pos = [], 0
        for i in range(pool_count):
            n = base + (1 if i < extra else 0)
            out.append(indexes[pos:pos + n])
            pos += n
        return out
    # snake：依次分配，方向交替
    out = [[] for _ in range(pool_count)]
    for i, idx in enumerate(indexes):
        rnd, pos = divmod(i, pool_count)
        target = pos if rnd % 2 == 0 else pool_count - 1 - pos
        out[target].append(idx)
    return out




"""签位与对阵来源。

对应设计大纲 5.1：后续比赛的参赛位置来源包括
  指定队伍（participation）/ 某小组第 N 名（pool_rank）/
  某场胜者（match_winner）/ 某场负者（match_loser）/ 轮空（bye）

必须区分“对手待定”（来源未解析）与“轮空”（确定没有对手）。
"""
from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction

SOURCE_TYPES = ("participation", "pool_rank", "match_winner", "match_loser", "bye")


@dataclass
class SlotSpec:
    """一个参赛位置。match_ref 在生成阶段使用局部 key，落库后换成真实 id。"""

    type: str
    participation_id: int | None = None
    pool_ref: str | int | None = None      # 小组（局部 key 或数据库 id）
    rank: int | None = None
    match_ref: str | int | None = None     # 前序场次（局部 key 或数据库 id）
    resolved_participation: int | None = None   # 已经落定的参赛主体
    resolved_bye: bool = False

    def is_bye(self) -> bool:
        return self.type == "bye"

    def is_ready(self) -> bool:
        return self.type == "bye" or self.resolved_participation is not None

    def describe(self) -> str:
        if self.type == "participation":
            return "指定队伍"
        if self.type == "pool_rank":
            return f"小组第{self.rank}名"
        if self.type == "match_winner":
            return "前一场胜者"
        if self.type == "match_loser":
            return "前一场负者"
        return "轮空"

    def to_columns(self, prefix: str, match_key_map: dict | None = None,
                   pool_key_map: dict | None = None) -> dict:
        """转成 matches 表列。

        引用写法有两种：生成器产生的局部 key（字符串，如 "m3"、"p0"）需要查映射表，
        尚未落库时解析为 None，由调用方在第二遍回填；
        引用已落库阶段的引用是数据库 id（整数），直接保留。
        """
        mk = self.match_ref
        if isinstance(mk, str) and match_key_map is not None:
            mk = match_key_map.get(mk)
        pk = self.pool_ref
        if isinstance(pk, str) and pool_key_map is not None:
            pk = pool_key_map.get(pk)
        return {
            f"{prefix}_source_type": self.type,
            f"{prefix}_source_pool": pk if self.type == "pool_rank" else None,
            f"{prefix}_source_rank": self.rank if self.type == "pool_rank" else None,
            f"{prefix}_source_match": mk if self.type in ("match_winner", "match_loser") else None,
            f"{prefix}_participation": self.participation_id if self.type == "participation" else None,
        }


def pool_name(index: int, suffix: str = "小组") -> str:
    """Unique alphabetic labels continue from Z to AA, AB, ... ."""
    letters = ""
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters + suffix


def ratio(num: int, den: int) -> tuple[str, Fraction | None, int, int]:
    """C 值 / Z 值：正数除以零按无限大，0/0 不可计算。

    返回 (类型, 精确比值, 原始分子, 原始分母)，比较用精确比值，展示用原始比值。
    """
    if den == 0:
        if num == 0:
            return ("undef", None, num, den)
        return ("inf", None, num, den)
    return ("num", Fraction(num, den), num, den)


def ratio_bucket(value: tuple) -> tuple:
    """判断两个 C 值/Z 值是否相等用的键：只取精确值（约分后）。

    原始分子分母只用于展示，不能参与相等判断，
    否则 6/6 与 7/7 会被当成不同值，导致不再比较后续指标。
    """
    return (value[0], value[1])


def ratio_key(value: tuple) -> tuple:
    """排序键：无限大在前，其次数值从大到小，不可计算最后。"""
    kind, frac = value[0], value[1]
    if kind == "inf":
        return (0, Fraction(0))
    if kind == "num":
        return (1, -frac)
    return (2, Fraction(0))


def ratio_text(value: tuple) -> str:
    kind, _frac, num, den = value
    if kind == "inf":
        return "∞"
    if kind == "undef":
        return "不可计算"
    return f"{num}/{den}"


def ratio_value(value: tuple) -> float | None:
    kind, frac = value[0], value[1]
    if kind == "num":
        return float(frac)
    return None

"""现场记录与提交包校验（设计大纲 6.1、12.2）。

校验用于发现漏传、重复记录、汇总不一致等问题，不替代裁判判罚；
存在不一致时提示核对，不静默改写现场确认结果。

三人赛口径：三局两胜，每局均为 15 分（含第三局），
14 平后再得 1 分即结束，15 分封顶。
"""
from __future__ import annotations

import hashlib
import json

from .. import config

RESULT_STATUSES = ("normal", "home_forfeit", "away_forfeit", "unfinished", "cancelled")
INDIVIDUAL_STATUSES = ("normal", "dnf", "dns", "dsq", "pending")


def set_winner(home: int, away: int, cap: int | None = None) -> str | None:
    cap = cap or config.TEAM_SET_POINT_CAP
    if home >= cap and home > away:
        return "home"
    if away >= cap and away > home:
        return "away"
    return None


def match_winner_from_sets(sets: list[dict], sets_to_win: int | None = None) -> str | None:
    need = sets_to_win or config.TEAM_SETS_TO_WIN
    home = sum(1 for s in sets if s.get("winner_side") == "home")
    away = sum(1 for s in sets if s.get("winner_side") == "away")
    if home >= need:
        return "home"
    if away >= need:
        return "away"
    return None


# ------------------------------------------------------------------ 事件回放
def replay_events(events: list[dict], cap: int | None = None,
                  max_sets: int | None = None) -> tuple[dict[int, list[int]], list[str]]:
    """回放得分事件，返回 {局次: [主队得分, 客队得分]} 与错误列表。"""
    cap = cap or config.TEAM_SET_POINT_CAP
    max_sets = max_sets or config.TEAM_MAX_SETS
    scores: dict[int, list[int]] = {}
    decided: set[int] = set()
    active: dict[int, tuple[int, str]] = {}
    errors: list[str] = []
    seen_seq: set[int] = set()
    for e in sorted(events, key=lambda x: int(x.get("seq") or 0)):
        seq = int(e.get("seq") or 0)
        kind = e.get("kind")
        set_no = int(e.get("set_no") or 0)
        if seq in seen_seq:
            errors.append(f"事件序号 {seq} 重复")
            continue
        seen_seq.add(seq)
        if set_no < 1 or set_no > max_sets:
            errors.append(f"事件 {seq} 的局次 {set_no} 超出范围")
            continue
        if kind == "score":
            if set_no in decided:
                errors.append(f"事件 {seq}：第{set_no}局已结束，不能再记分")
                continue
            if set_no > 1 and (set_no - 1) not in decided:
                errors.append(f"事件 {seq}：第{set_no - 1}局尚未结束，不能开始第{set_no}局")
                continue
            s = scores.setdefault(set_no, [0, 0])
            side = e.get("side")
            if side not in ("home", "away"):
                errors.append(f"事件 {seq}：得分方不合法")
                continue
            s[0 if side == "home" else 1] += 1
            if s[0] > cap or s[1] > cap:
                errors.append(f"事件 {seq}：第{set_no}局得分超过 {cap} 分上限")
                continue
            after = (e.get("home_after"), e.get("away_after"))
            if after != (None, None) and after != (s[0], s[1]):
                errors.append(f"事件 {seq}：记录的过程比分 {after} 与回放结果 {(s[0], s[1])} 不一致")
            active[seq] = (set_no, side)
            if set_winner(s[0], s[1], cap):
                decided.add(set_no)
        elif kind == "undo":
            ref = e.get("ref_seq")
            if ref not in active:
                errors.append(f"事件 {seq}：撤回指向的得分事件不存在或已被撤回")
                continue
            set_no_ref, side = active.pop(ref)
            s = scores.setdefault(set_no_ref, [0, 0])
            s[0 if side == "home" else 1] -= 1
            decided.discard(set_no_ref)
    return scores, errors


def validate_sets(sets: list[dict], result_status: str,
                  cap: int | None = None) -> list[str]:
    """校验单局结果本身。

    弃权或未完成时，现场往往停在一局中途（如 8:5 时弃权）：允许最后一局没有胜方，
    其余各局仍必须完整且与比分一致。
    """
    cap = cap or config.TEAM_SET_POINT_CAP
    errors: list[str] = []
    if result_status == "cancelled":
        if sets:
            errors.append("已取消的比赛不应包含局分")
        return errors
    partial_allowed = result_status in ("home_forfeit", "away_forfeit", "unfinished")
    last_set_no = max((int(s.get("set_no") or 0) for s in sets), default=0)
    seen: set[int] = set()
    wins = {"home": 0, "away": 0}
    for s in sets:
        set_no = int(s.get("set_no") or 0)
        hp, ap = int(s.get("home_points") or 0), int(s.get("away_points") or 0)
        if set_no < 1 or set_no > config.TEAM_MAX_SETS:
            errors.append(f"局次 {set_no} 超出范围")
            continue
        if set_no in seen:
            errors.append(f"第{set_no}局重复提交")
            continue
        seen.add(set_no)
        if hp > cap or ap > cap:
            errors.append(f"第{set_no}局比分超过 {cap} 分上限")
        winner = s.get("winner_side")
        expected = set_winner(hp, ap, cap)
        if winner not in ("home", "away"):
            if partial_allowed and set_no == last_set_no and expected is None:
                continue        # 弃权/未完成时停在半途的最后一局
            errors.append(f"第{set_no}局缺少胜方")
            continue
        if expected != winner:
            errors.append(f"第{set_no}局胜方与比分不一致（{hp}:{ap}）")
            continue
        wins[winner] += 1
    if result_status == "normal":
        if not sets:
            errors.append("正常完成的比赛必须包含各局比分")
        else:
            if wins["home"] != config.TEAM_SETS_TO_WIN and wins["away"] != config.TEAM_SETS_TO_WIN:
                errors.append("正常完成的比赛必须有队伍取得三分之二局数（三局两胜）")
    return errors


def validate_set_order(sets: list[dict]) -> list[str]:
    """局次必须连续，且任何一局结束后不再出现新的局。"""
    errors: list[str] = []
    ordered = sorted(sets, key=lambda s: int(s.get("set_no") or 0))
    for i, s in enumerate(ordered, start=1):
        if int(s.get("set_no") or 0) != i:
            errors.append("局次必须从 1 开始连续")
            break
    wins = {"home": 0, "away": 0}
    for s in ordered:
        w = s.get("winner_side")
        if w in wins:
            wins[w] += 1
        if wins["home"] >= config.TEAM_SETS_TO_WIN or wins["away"] >= config.TEAM_SETS_TO_WIN:
            if s is not ordered[-1]:
                errors.append("比赛已结束后不应再有新的局")
            break
    return errors


def validate_team_package(*, sets: list[dict], events: list[dict],
                          result_status: str, require_events: bool = True) -> list[str]:
    """三人赛提交包校验：过程与结果一致性。

    require_events=False 用于正式更正：只更正最终局分时保留原过程记录，不补造过程。
    """
    errors: list[str] = []
    if result_status not in RESULT_STATUSES:
        return [f"未知结果状态：{result_status}"]
    sets = sets or []
    events = events or []
    if result_status == "normal" and not events and require_events:
        errors.append("正常完成的三人赛必须包含逐分得分过程")
    errors.extend(validate_sets(sets, result_status))
    errors.extend(validate_set_order(sets))
    replayed, replay_errors = replay_events(events)
    errors.extend(replay_errors)
    if result_status in ("normal", "home_forfeit", "away_forfeit", "unfinished"):
        for s in sets:
            set_no = int(s.get("set_no") or 0)
            if set_no in replayed:
                got = replayed[set_no]
                if got != [int(s.get("home_points") or 0), int(s.get("away_points") or 0)]:
                    errors.append(
                        f"第{set_no}局：提交比分 {s.get('home_points')}:{s.get('away_points')} "
                        f"与得分过程回放 {got[0]}:{got[1]} 不一致")
            elif events:
                errors.append(f"第{set_no}局：缺少对应的得分过程记录")
        for set_no, sc in replayed.items():
            if not any(int(s.get("set_no") or 0) == set_no for s in sets):
                errors.append(f"第{set_no}局：得分过程存在但没有对应的局分结果")
    return errors


def validate_individual_package(*, result_status: str, result_value, result_text: str,
                                rank_no, events: list | None = None, error_count=None,
                                violation_count=None) -> list[str]:
    errors: list[str] = []
    if result_status not in INDIVIDUAL_STATUSES:
        return [f"未知结果状态：{result_status}"]
    if events:
        errors.append("个人赛不保存逐次得分过程")
    if result_status == "normal":
        if result_value is None:
            errors.append("正常完成的个人成绩必须填写有效次数，不能仅填写文字说明")
    for value, label in ((result_value, "有效次数"), (error_count, "失误次数"),
                         (violation_count, "违规次数")):
        if value is None:
            if result_status == "normal" and label != "违规次数":
                errors.append(f"正常完成的个人成绩必须填写{label}")
            continue
        try:
            number = float(value)
            if number < 0 or not number.is_integer():
                errors.append(f"{label}必须是非负整数")
        except (TypeError, ValueError):
            errors.append(f"{label}格式不正确")
    if violation_count is not None:
        try:
            if int(violation_count) >= 2 and result_status == "normal":
                errors.append("违规达到两次及以上，结果状态不能标记为正常")
        except (TypeError, ValueError):
            pass
    if rank_no is not None:
        try:
            if int(rank_no) < 1:
                errors.append("名次必须为正整数")
        except (TypeError, ValueError):
            errors.append("名次格式不正确")
    return errors


def payload_hash(payload: dict) -> str:
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

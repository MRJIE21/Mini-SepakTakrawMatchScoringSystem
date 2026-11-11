"""Official package validation uses each match's immutable scoring parameters."""
from __future__ import annotations
import hashlib
import json
from . import team_rules

RESULT_STATUSES = ("normal", "home_forfeit", "away_forfeit", "unfinished", "cancelled")


def _rules(rules=None, cap=None, max_sets=None):
    value = team_rules.normalize(rules)
    if cap is not None:
        value["regular"] = {"mode": "target", "target_points": cap, "win_by": 1, "point_cap": cap}
    if max_sets is not None:
        value["max_sets"] = max_sets
    return team_rules.normalize(value)


def set_winner(home, away, cap=None, *, rules=None, set_no=1):
    return team_rules.winner(home, away, team_rules.for_set(_rules(rules, cap), set_no))


def match_winner_from_sets(sets, sets_to_win=None, *, rules=None):
    need = sets_to_win if sets_to_win is not None else team_rules.sets_to_win(rules)
    home = sum(s.get("winner_side") == "home" for s in sets)
    away = sum(s.get("winner_side") == "away" for s in sets)
    return "home" if home >= need else "away" if away >= need else None


def replay_events(events, cap=None, max_sets=None, *, rules=None):
    value = _rules(rules, cap, max_sets)
    scores, active, errors, seen = {}, {}, [], set()
    last_seq = 0
    for event in events:
        if not isinstance(event, dict):
            errors.append("得分事件必须是对象")
            continue
        seq, no = event.get("seq"), event.get("set_no")
        if type(seq) is not int or not 1 <= seq <= 2147483647 or seq <= last_seq or seq in seen:
            errors.append("事件序号必须是递增且不重复的正整数")
            continue
        last_seq = seq
        seen.add(seq)
        if type(no) is not int or not 1 <= no <= value["max_sets"]:
            errors.append(f"事件 {seq} 的局次超出范围")
            continue
        if event.get("kind") == "undo":
            if event.get('side') not in (None, ''):
                errors.append(f"事件 {seq}：撤回事件不应指定得分方")
                continue
            ref = event.get("ref_seq")
            if type(ref) is not int or not active or ref != next(reversed(active)):
                errors.append(f"事件 {seq}：撤回必须指向最后一次有效记分")
                continue
            ref_no, side = active[ref]
            if no != ref_no:
                errors.append(f"事件 {seq}：撤回局次与原得分不一致")
                continue
            active.pop(ref)
            scores[ref_no][0 if side == "home" else 1] -= 1
            continue
        if event.get("kind") != "score" or event.get("side") not in ("home", "away"):
            errors.append(f"事件 {seq}：得分事件或得分方不合法")
            continue
        decided = {}
        for set_no, score in scores.items():
            w = team_rules.winner(*score, team_rules.for_set(value, set_no))
            if w: decided[set_no] = w
        if any(sum(w == side for w in decided.values()) >= team_rules.sets_to_win(value) for side in ("home", "away")):
            errors.append(f"事件 {seq}：比赛已结束，不能再记分")
            continue
        current = next((i for i in range(1, value["max_sets"] + 1) if i not in decided), None)
        if no != current:
            errors.append(f"事件 {seq}：第{no}局已结束或上一局尚未结束，不能记分")
            continue
        score = scores.setdefault(no, [0, 0])
        side = event["side"]
        index = 0 if side == "home" else 1
        score[index] += 1
        rule = team_rules.for_set(value, no)
        if not team_rules.legal_score(*score, rule):
            score[index] -= 1
            errors.append(f"事件 {seq}：比分超出合法获胜边界或分数上限")
            continue
        after = (event.get("home_after"), event.get("away_after"))
        if after != (None, None) and (any(type(x) is not int for x in after) or after != tuple(score)):
            errors.append(f"事件 {seq}：过程比分与回放结果不一致")
        active[seq] = (no, side)
    return scores, errors


def validate_sets(sets, result_status, cap=None, *, rules=None):
    value = _rules(rules, cap)
    if result_status == "cancelled":
        return ["已取消的比赛不应包含局分"] if sets else []
    errors, seen, wins = [], set(), {"home": 0, "away": 0}
    valid_nos = [s.get("set_no") for s in sets if isinstance(s, dict) and type(s.get("set_no")) is int]
    last_no = max(valid_nos, default=0)
    partial = result_status in ("home_forfeit", "away_forfeit", "unfinished")
    for s in sets:
        if not isinstance(s, dict):
            errors.append("局分必须是对象")
            continue
        no = s.get("set_no")
        if type(no) is not int or not 1 <= no <= value["max_sets"]:
            errors.append("局次超出范围")
            continue
        if no in seen:
            errors.append(f"第{no}局重复提交")
        seen.add(no)
        hp, ap = s.get("home_points"), s.get("away_points")
        rule = team_rules.for_set(value, no)
        if not team_rules.legal_score(hp, ap, rule):
            errors.append(f"第{no}局比分不合法或超过分数上限")
            continue
        expected = team_rules.winner(hp, ap, rule)
        winner = s.get("winner_side")
        if winner not in ("home", "away"):
            if partial and no == last_no and expected is None:
                continue
            errors.append(f"第{no}局缺少胜方")
        elif expected != winner:
            errors.append(f"第{no}局胜方与比分不一致")
        else:
            wins[winner] += 1
    if result_status == "normal" and not any(n == team_rules.sets_to_win(value) for n in wins.values()):
        errors.append(f"正常完成的比赛必须有一方赢得{team_rules.sets_to_win(value)}局")
    return errors


def validate_set_order(sets, *, rules=None):
    value = team_rules.normalize(rules)
    if any(not isinstance(s, dict) or type(s.get("set_no")) is not int for s in sets):
        return ["局次格式不正确"]
    ordered = sorted(sets, key=lambda s: s["set_no"])
    errors, wins = [], {"home": 0, "away": 0}
    for i, s in enumerate(ordered, 1):
        if s["set_no"] != i:
            errors.append("局次必须从 1 开始连续")
        side = s.get("winner_side")
        if side in wins: wins[side] += 1
        if max(wins.values()) >= team_rules.sets_to_win(value) and i != len(ordered):
            errors.append("比赛已结束后不应再有新的局")
    return errors


def validate_team_package(*, sets, events, result_status, require_events=True, rules=None):
    if result_status not in RESULT_STATUSES:
        return [f"未知结果状态：{result_status}"]
    if not isinstance(sets, list) or not isinstance(events, list):
        return ["局分与得分过程必须是数组"]
    errors = []
    if result_status == "normal" and not events and require_events:
        errors.append("正常完成的三人赛必须包含逐分得分过程")
    errors.extend(validate_sets(sets, result_status, rules=rules))
    errors.extend(validate_set_order(sets, rules=rules))
    scores, replay_errors = replay_events(events, rules=rules)
    errors.extend(replay_errors)
    if result_status == "cancelled" and events:
        errors.append("取消的比赛不能包含得分过程")
    if events:
        submitted = {s["set_no"]: [s.get("home_points"), s.get("away_points")] for s in sets
                     if isinstance(s, dict) and type(s.get("set_no")) is int}
        actual = {no: sc for no, sc in scores.items() if any(sc)}
        if actual != submitted:
            errors.append("提交局分与得分过程回放结果不一致，或缺少对应局分/过程")
    return errors


def payload_hash(payload: dict) -> str:
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

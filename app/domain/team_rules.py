"""Typed, immutable scoring parameters; no database or process-wide mutable rules."""
from __future__ import annotations

import copy
import hashlib
import json

DEFAULT_RULES = {"schema_version": 1, "max_sets": 3,
                 "regular": {"mode": "target", "target_points": 15, "win_by": 1, "point_cap": 15},
                 "deciding": None}


def integer(value, minimum, maximum, label):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"{label}必须是 {minimum}—{maximum} 的整数")
    return value


def normalize_set(value):
    if not isinstance(value, dict):
        raise ValueError("单局规则格式不正确")
    mode = value.get("mode")
    allowed = ({"mode", "target_points", "win_by", "point_cap"} if mode == "target"
               else {"mode", "target_points", "deuce_points"} if mode == "fixed_deuce" else set())
    if not allowed or set(value) != allowed:
        raise ValueError("获胜方式或规则参数不正确，请重新加载规则设置")
    target = integer(value["target_points"], 2, 99, "目标分")
    if mode == "fixed_deuce":
        return {"mode": mode, "target_points": target,
                "deuce_points": integer(value["deuce_points"], target + 1, 999, "固定加赛分")}
    cap = value["point_cap"]
    if cap is not None:
        cap = integer(cap, target, 999, "封顶分")
    return {"mode": mode, "target_points": target,
            "win_by": integer(value["win_by"], 1, 2, "领先分差"), "point_cap": cap}


def normalize(value=None):
    if value is None:
        return copy.deepcopy(DEFAULT_RULES)
    if not isinstance(value, dict) or set(value) != {"schema_version", "max_sets", "regular", "deciding"}:
        raise ValueError("比赛规则格式不正确")
    if type(value["schema_version"]) is not int or value["schema_version"] != 1:
        raise ValueError("比赛规则版本不受支持，请联系管理员核对")
    maximum = integer(value["max_sets"], 1, 9, "最多局数")
    if maximum % 2 != 1:
        raise ValueError("最多局数必须是奇数，获胜局数为过半局数")
    return {"schema_version": 1, "max_sets": maximum, "regular": normalize_set(value["regular"]),
            "deciding": normalize_set(value["deciding"]) if value["deciding"] is not None else None}


def canonical(value):
    return json.dumps(normalize(value), sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def fingerprint(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def sets_to_win(rules=None):
    return (normalize(rules)["max_sets"] + 1) // 2


def for_set(rules, set_no):
    value = normalize(rules)
    integer(set_no, 1, value["max_sets"], "局次")
    return value["deciding"] or value["regular"] if set_no == value["max_sets"] else value["regular"]


def winner(home, away, rule):
    integer(home, 0, 2147483647, "主队得分")
    integer(away, 0, 2147483647, "客队得分")
    rule = normalize_set(rule)
    high, low = max(home, away), min(home, away)
    if high == low:
        return None
    target = rule["target_points"]
    if rule["mode"] == "fixed_deuce":
        done = high >= (rule["deuce_points"] if low >= target - 1 else target)
    else:
        done = high >= target and (high - low >= rule["win_by"] or
                                  (rule["point_cap"] is not None and high >= rule["point_cap"]))
    return ("home" if home > away else "away") if done else None


def legal_score(home, away, rule):
    """Final/partial scores must be reachable without scoring past an earlier finish."""
    try:
        expected = winner(home, away, rule)
    except ValueError:
        return False
    high, low = max(home, away), min(home, away)
    target = rule["target_points"]
    cap = rule.get("point_cap") if rule["mode"] == "target" else rule["deuce_points"]
    if rule['mode'] == 'target' and rule['win_by'] == 1 and (high > target or low >= target):
        return False
    if cap is not None and (high > cap or low >= cap):
        return False
    if expected is None:
        return True
    if rule["mode"] == "fixed_deuce":
        return high == (rule["deuce_points"] if low >= target - 1 else target)
    difference = high - low
    return ((high == target and difference >= rule["win_by"]) or
            (high > target and difference == rule["win_by"]) or
            (cap is not None and high == cap and 1 <= difference <= rule["win_by"]))


def set_summary(rule):
    rule = normalize_set(rule)
    target = rule["target_points"]
    if rule["mode"] == "fixed_deuce":
        return f"{target}分，{target - 1}平后先到{rule['deuce_points']}分"
    margin = "直接获胜" if rule["win_by"] == 1 else "须领先2分"
    cap = f"{rule['point_cap']}分封顶" if rule["point_cap"] is not None else "不封顶"
    return f"{target}分，{margin}，{cap}"


def summary(rules=None):
    rules = normalize(rules)
    text = f"{rules['max_sets']}局{sets_to_win(rules)}胜 · {set_summary(rules['regular'])}"
    return text + (f"；决胜局：{set_summary(rules['deciding'])}" if rules["deciding"] else "；决胜局沿用")

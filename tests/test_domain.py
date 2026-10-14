"""领域层测试：编排生成、排名、学校积分、提交校验。"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("STSS_DATA_DIR", str(Path(__file__).resolve().parent / "_tmp"))

from app.domain import formats, points, ranking, validation  # noqa: E402
from app.domain.slots import SlotSpec, seed_positions, split_pools  # noqa: E402


def teams(n: int) -> list[SlotSpec]:
    return [SlotSpec("participation", participation_id=i + 1) for i in range(n)]


def sets_of(*pairs) -> list[dict]:
    return [{"set_no": i + 1, "home_points": h, "away_points": a,
             "winner_side": "home" if h > a else "away"} for i, (h, a) in enumerate(pairs)]


def events_for(pairs, sides) -> list[dict]:
    """按局分生成合法的得分事件序列（先落后方得分，再胜方得分到封顶）。"""
    out, seq = [], 0
    for set_no, (h, a) in enumerate(pairs, start=1):
        seq = _fill(out, set_no, h, a, seq)
    return out


def _fill(out, set_no, h, a, seq):
    ch = ca = 0
    order = ["away", "home"] if h > a else ["home", "away"]
    targets = {"home": h, "away": a}
    for side in order:
        while (ch if side == "home" else ca) < targets[side]:
            if side == "home":
                ch += 1
            else:
                ca += 1
            seq += 1
            out.append({"seq": seq, "kind": "score", "set_no": set_no, "side": side,
                        "home_after": ch, "away_after": ca})
    return seq


class SeedAndPoolTest(unittest.TestCase):
    def test_seed_positions(self):
        for size in (2, 4, 8, 16):
            order = seed_positions(size)
            self.assertEqual(sorted(order), list(range(1, size + 1)))
            for i in range(0, size, 2):
                self.assertEqual(order[i] + order[i + 1], size + 1)   # 首轮对位之和固定
        self.assertEqual(seed_positions(4), [1, 4, 2, 3])             # 1v4、2v3
        order8 = seed_positions(8)
        self.assertIn(1, order8[:4])                                  # 1、2 号种子分处上下半区
        self.assertIn(2, order8[4:])

    def test_split_pools_snake(self):
        groups = split_pools(9, 3, "snake")
        self.assertEqual([len(g) for g in groups], [3, 3, 3])
        self.assertEqual(groups[0], [0, 5, 6])
        self.assertEqual(groups[1], [1, 4, 7])
        self.assertEqual(groups[2], [2, 3, 8])

    def test_split_pools_uneven_4_4_4_3(self):
        groups = split_pools(15, 4, "balanced")
        self.assertEqual([len(g) for g in groups], [4, 4, 4, 3])


class RoundRobinTest(unittest.TestCase):
    def test_even_teams(self):
        stage = formats.gen_round_robin(teams(4), {}, 1, "小组赛")
        self.assertEqual(len(stage.matches), 6)
        rounds = {m.round_no for m in stage.matches}
        self.assertEqual(len(rounds), 3)
        pairs = {tuple(sorted((m.home.participation_id, m.away.participation_id)))
                 for m in stage.matches}
        self.assertEqual(len(pairs), 6)

    def test_odd_teams_no_fake_match(self):
        stage = formats.gen_round_robin(teams(5), {}, 1, "小组赛")
        self.assertEqual(len(stage.matches), 10)          # C(5,2)
        self.assertEqual(len({m.round_no for m in stage.matches}), 5)
        for m in stage.matches:
            self.assertNotEqual(m.home.type, "bye")
            self.assertNotEqual(m.away.type, "bye")

    def test_double_round_robin(self):
        stage = formats.gen_round_robin(teams(4), {"legs": 2}, 1, "小组赛")
        self.assertEqual(len(stage.matches), 12)

    def test_pools_with_uneven_sizes(self):
        stage = formats.gen_round_robin(
            teams(15), {"pools": [{"name": "A小组", "size": 4}, {"name": "B小组", "size": 4},
                                  {"name": "C小组", "size": 4}, {"name": "D小组", "size": 3}]},
            1, "小组赛")
        self.assertEqual(len(stage.pools), 4)
        self.assertEqual(len(stage.matches), 6 + 6 + 6 + 3)
        self.assertEqual(len(stage.pools[3].members), 3)


class SingleElimTest(unittest.TestCase):
    def test_power_of_two(self):
        stage = formats.gen_single_elim(teams(8), {}, 1, "淘汰赛")
        self.assertEqual(len(stage.matches), 7)
        labels = [m.round_label for m in stage.matches]
        self.assertEqual(labels.count("1/4决赛"), 4)
        self.assertEqual(labels.count("半决赛"), 2)
        self.assertEqual(labels.count("决赛"), 1)

    def test_byes_do_not_create_matches(self):
        stage = formats.gen_single_elim(teams(6), {}, 1, "淘汰赛")
        self.assertEqual(len(stage.matches), 5)   # 8 签位，2 队轮空
        first_round = [m for m in stage.matches if m.round_no == 1]
        self.assertEqual(len(first_round), 2)
        second_round = [m for m in stage.matches if m.round_no == 2]
        direct = [m for m in second_round if m.home.type == "participation"
                  or m.away.type == "participation"]
        self.assertEqual(len(direct), 2)          # 两个轮空队直接进入第二轮
        self.assertTrue(any("轮空" in w for w in stage.warnings))

    def test_third_place_match(self):
        stage = formats.gen_single_elim(teams(4), {"third_place": True}, 1, "淘汰赛")
        self.assertEqual(len(stage.matches), 4)
        third = [m for m in stage.matches if m.round_label == "三、四名决赛"]
        self.assertEqual(len(third), 1)
        self.assertEqual(third[0].home.type, "match_loser")


class DoubleElimTest(unittest.TestCase):
    def test_eight_teams_structure(self):
        stage = formats.gen_double_elim(teams(8), {}, 1, "双淘汰")
        wb = [m for m in stage.matches if m.round_no < 100 and m.round_no != 200]
        lb = [m for m in stage.matches if 100 <= m.round_no < 200]
        gf = [m for m in stage.matches if m.round_no == 200]
        self.assertEqual(len(wb), 7)          # 胜者区 4+2+1
        self.assertEqual(len(lb), 6)          # 败者区 2+2+1+1
        self.assertEqual(len(gf), 1)
        self.assertEqual(len(stage.matches), 14)

    def test_four_teams_structure(self):
        stage = formats.gen_double_elim(teams(4), {}, 1, "双淘汰")
        self.assertEqual(len(stage.matches), 6)   # 胜者区3 + 败者区2 + 决赛1

    def test_byes_are_passed_through(self):
        stage = formats.gen_double_elim(teams(5), {}, 1, "双淘汰")
        # 不应出现两侧都是轮空的比赛
        for m in stage.matches:
            self.assertFalse(m.home.is_bye() and m.away.is_bye())

    def test_grand_final_reset_flag(self):
        stage = formats.gen_double_elim(teams(4), {"grand_final_reset": True}, 1, "双淘汰")
        self.assertIn("重置", stage.note)


class GauntletTest(unittest.TestCase):
    def test_chain(self):
        stage = formats.gen_gauntlet(teams(5), {}, 1, "阶梯")
        self.assertEqual(len(stage.matches), 4)
        self.assertEqual(stage.matches[0].home.participation_id, 5)
        self.assertEqual(stage.matches[0].away.participation_id, 4)
        self.assertEqual(stage.matches[-1].away.participation_id, 1)
        self.assertEqual(stage.matches[-1].home.type, "match_winner")
        self.assertEqual(stage.matches[-1].round_label, "决赛")


class SwissTest(unittest.TestCase):
    def test_first_round_fold(self):
        pairs, bye, _ = formats.swiss_first_round(teams(8), {})
        self.assertIsNone(bye)
        self.assertEqual(len(pairs), 4)
        self.assertEqual(pairs[0][0].participation_id, 1)
        self.assertEqual(pairs[0][1].participation_id, 5)

    def test_odd_teams_get_bye(self):
        pairs, bye, _ = formats.swiss_first_round(teams(7), {})
        self.assertEqual(len(pairs), 3)
        self.assertIsNotNone(bye)

    def test_avoid_rematch(self):
        ordered = teams(4)
        played = {(1, 2)}
        pairs, _, _ = formats.swiss_next_round(ordered, played, set(), {})
        for a, b in pairs:
            key = tuple(sorted((a.participation_id, b.participation_id)))
            self.assertNotEqual(key, (1, 2))


class RankingTest(unittest.TestCase):
    def test_points_c_z_and_lot(self):
        members = [{"participation_id": 1, "label": "一队"},
                   {"participation_id": 2, "label": "二队"},
                   {"participation_id": 3, "label": "三队"}]
        matches = [
            {"id": 1, "home_participation": 1, "away_participation": 2, "status": "finished",
             "result_status": "normal", "sets": sets_of((15, 10), (15, 12))},
            {"id": 2, "home_participation": 2, "away_participation": 3, "status": "finished",
             "result_status": "normal", "sets": sets_of((15, 13), (15, 11))},
            {"id": 3, "home_participation": 1, "away_participation": 3, "status": "finished",
             "result_status": "normal", "sets": sets_of((15, 14), (12, 15), (15, 13))},
        ]
        result = ranking.compute_standings(members, matches)
        rows = {r["participation_id"]: r for r in result["rows"]}
        self.assertEqual(rows[1]["points"], 4)
        self.assertEqual(rows[2]["points"], 3)
        self.assertEqual(rows[3]["points"], 2)
        self.assertEqual(rows[1]["rank"], 1)
        # 一队：胜局 4（对二队 2 局、对三队 2 局）负局 1（第三局 12:15）
        self.assertEqual(rows[1]["sets_won"], 4)
        self.assertEqual(rows[1]["sets_lost"], 1)
        self.assertEqual(rows[1]["c_text"], "4/1")

    def test_ratio_infinity_display(self):
        members = [{"participation_id": 1, "label": "甲"}, {"participation_id": 2, "label": "乙"}]
        matches = [
            {"id": 1, "home_participation": 1, "away_participation": 2, "status": "finished",
             "result_status": "normal", "sets": sets_of((15, 5), (15, 6))},
        ]
        result = ranking.compute_standings(members, matches)
        rows = {r["participation_id"]: r for r in result["rows"]}
        self.assertEqual(rows[1]["c_text"], "∞")
        self.assertEqual(rows[2]["c_text"], "0/2")

    def test_same_points_compare_c_then_z(self):
        members = [{"participation_id": 1, "label": "甲"},
                   {"participation_id": 2, "label": "乙"}]
        matches = [
            {"id": 1, "home_participation": 1, "away_participation": 2, "status": "finished",
             "result_status": "normal", "sets": sets_of((15, 5), (15, 6))},
        ]
        result = ranking.compute_standings(members, matches)
        rows = {r["participation_id"]: r for r in result["rows"]}
        self.assertEqual(rows[1]["rank"], 1)
        self.assertEqual(rows[2]["rank"], 2)
        self.assertEqual(rows[1]["c_text"], "∞")     # 2/0 按无限大处理
        self.assertEqual(rows[2]["c_text"], "0/2")

    def test_tie_needs_lot_then_resolved(self):
        members = [{"participation_id": 1, "label": "甲"}, {"participation_id": 2, "label": "乙"}]
        matches = [
            {"id": 1, "home_participation": 1, "away_participation": 2, "status": "finished",
             "result_status": "normal", "sets": sets_of((15, 10), (10, 15), (15, 12))},
        ]
        result = ranking.compute_standings(members, matches)
        rows = {r["participation_id"]: r for r in result["rows"]}
        # 积分：胜 2 负 1；但两队各胜 1 局…… 甲胜 2 局 → 甲积分高
        self.assertEqual(rows[1]["points"], 2)
        result2 = ranking.compute_standings(members, [
            {"id": 1, "home_participation": 1, "away_participation": 2, "status": "finished",
             "result_status": "normal", "sets": sets_of((15, 3), (3, 15), (15, 3))},
        ])
        # 积分相同（2:1），C 值 2/1 对 1/2 → 甲在前
        self.assertEqual(result2["rows"][0]["participation_id"], 1)

    def test_equal_c_with_different_raw_fraction_then_compare_z(self):
        """C 值 3/3 与 2/2 都等于 1，必须视为相等并继续比较 Z 值。"""
        members = [{"participation_id": 2, "label": "乙"}, {"participation_id": 1, "label": "甲"},
                   {"participation_id": 3, "label": "丙"}]
        matches = [
            # 甲：2:1 胜  + 1:2 负  → 胜局 3 负局 3，C = 3/3，得分 73 失分 69
            {"id": 1, "home_participation": 1, "away_participation": 3, "status": "finished",
             "result_status": "normal", "sets": sets_of((15, 0), (0, 15), (15, 10))},
            {"id": 2, "home_participation": 1, "away_participation": 3, "status": "finished",
             "result_status": "normal", "sets": sets_of((15, 14), (14, 15), (14, 15))},
            # 乙：2:0 胜 + 0:2 负 → 胜局 2 负局 2，C = 2/2，得分 30 失分 30
            {"id": 3, "home_participation": 2, "away_participation": 3, "status": "finished",
             "result_status": "normal", "sets": sets_of((15, 0), (15, 0))},
            {"id": 4, "home_participation": 2, "away_participation": 3, "status": "finished",
             "result_status": "normal", "sets": sets_of((0, 15), (0, 15))},
        ]
        result = ranking.compute_standings(members, matches)
        rows = {r["participation_id"]: r for r in result["rows"]}
        self.assertEqual(rows[1]["points"], 3)
        self.assertEqual(rows[2]["points"], 3)
        self.assertEqual(rows[1]["c_text"], "3/3")
        self.assertEqual(rows[2]["c_text"], "2/2")
        # 精确值相等 → 必须继续比较 Z；甲的 Z=73/69 大于乙的 Z=30/30
        order = [r["participation_id"] for r in result["rows"]]
        self.assertEqual(rows[1]["points"], rows[2]["points"])
        self.assertLess(order.index(1), order.index(2),
                        "C 值数值相等时应由 Z 值决定，不能因为原始分子分母不同就停在 C 值")

    def test_ratio_bucket_ignores_raw_fraction(self):
        from app.domain.slots import ratio, ratio_bucket
        self.assertEqual(ratio_bucket(ratio(6, 6)), ratio_bucket(ratio(7, 7)))
        self.assertEqual(ratio_bucket(ratio(2, 4)), ratio_bucket(ratio(1, 2)))
        self.assertNotEqual(ratio_bucket(ratio(2, 3)), ratio_bucket(ratio(3, 2)))
        self.assertNotEqual(ratio_bucket(ratio(1, 0)), ratio_bucket(ratio(0, 0)))

    def test_exact_ratio_no_rounding(self):
        # 2/3 与 1/2 在页面四舍五入后都是 0.67，但必须按精确比值判断 2/3 > 1/2
        from app.domain.slots import ratio, ratio_key
        self.assertLess(ratio_key(ratio(2, 3)), ratio_key(ratio(1, 2)))
        self.assertEqual(ratio_key(ratio(2, 3)), ratio_key(ratio(4, 6)))
        self.assertLess(ratio_key(ratio(1, 0)), ratio_key(ratio(99, 1)))   # 无限大排最前
        self.assertLess(ratio_key(ratio(1, 1)), ratio_key(ratio(0, 0)))    # 不可计算排最后

    def test_forfeit_gives_zero_to_forfeiting_side(self):
        members = [{"participation_id": 1, "label": "甲"}, {"participation_id": 2, "label": "乙"}]
        matches = [
            {"id": 1, "home_participation": 1, "away_participation": 2, "status": "finished",
             "result_status": "home_forfeit", "sets": []},
        ]
        result = ranking.compute_standings(members, matches)
        rows = {r["participation_id"]: r for r in result["rows"]}
        self.assertEqual(rows[1]["points"], 0)
        self.assertEqual(rows[2]["points"], 2)
        self.assertEqual(rows[2]["sets_won"], 0)     # 不补造局分

    def test_unfinished_excluded(self):
        members = [{"participation_id": 1, "label": "甲"}, {"participation_id": 2, "label": "乙"}]
        matches = [
            {"id": 1, "home_participation": 1, "away_participation": 2, "status": "finished",
             "result_status": "unfinished", "sets": sets_of((15, 10))},
        ]
        result = ranking.compute_standings(members, matches)
        self.assertEqual(result["rows"][0]["points"], 0)
        self.assertEqual(len(result["excluded"]), 1)


class PointsTest(unittest.TestCase):
    def test_individual_and_team_points(self):
        self.assertEqual(points.placement_points(1, "individual"), (9, 1, 9))
        self.assertEqual(points.placement_points(1, "team"), (9, 2, 18))
        self.assertEqual(points.placement_points(8, "team"), (1, 2, 2))
        self.assertEqual(points.placement_points(9, "team"), (0, 2, 0))
        self.assertEqual(points.placement_points(None, "team"), (0, 2, 0))

    def test_school_totals_tiebreak_by_first_places(self):
        schools = [{"school_id": 1, "name": "甲校"}, {"school_id": 2, "name": "乙校"}]
        rows = [
            {"school_id": 1, "points": 9, "rank_no": 1, "category_name": "男单", "kind": "individual"},
            {"school_id": 2, "points": 9, "rank_no": 1, "category_name": "女单", "kind": "individual"},
        ]
        result = points.compute_school_totals(schools, rows)
        self.assertEqual(len(result["unresolved"]), 1)   # 总分与名次数量都相同
        result2 = points.compute_school_totals(schools, rows + [
            {"school_id": 1, "points": 7, "rank_no": 2, "category_name": "男双", "kind": "individual"},
        ])
        rows_by_school = {r["school_id"]: r for r in result2["rows"]}
        self.assertEqual(rows_by_school[1]["rank"], 1)
        self.assertEqual(rows_by_school[2]["rank"], 2)

    def test_manual_tiebreak_used(self):
        schools = [{"school_id": 1, "name": "甲校"}, {"school_id": 2, "name": "乙校"}]
        rows = [
            {"school_id": 1, "points": 9, "rank_no": 1, "category_name": "男单", "kind": "individual"},
            {"school_id": 2, "points": 9, "rank_no": 1, "category_name": "女单", "kind": "individual"},
        ]
        result = points.compute_school_totals(schools, rows, tiebreaks={2: 1, 1: 2})
        rows_by_school = {r["school_id"]: r for r in result["rows"]}
        self.assertEqual(rows_by_school[2]["rank"], 1)
        self.assertEqual(result["unresolved"], [])


class ValidationTest(unittest.TestCase):
    def test_replay_matches_sets(self):
        events = events_for([(15, 10), (15, 12)], ["home", "home"])
        errors = validation.validate_team_package(
            sets=sets_of((15, 10), (15, 12)), events=events, result_status="normal")
        self.assertEqual(errors, [])

    def test_replay_mismatch_detected(self):
        events = events_for([(15, 10), (15, 12)], ["home", "home"])
        errors = validation.validate_team_package(
            sets=sets_of((15, 10), (15, 13)), events=events, result_status="normal")
        self.assertTrue(any("不一致" in e for e in errors))

    def test_no_events_for_normal_match(self):
        errors = validation.validate_team_package(
            sets=sets_of((15, 10), (15, 12)), events=[], result_status="normal")
        self.assertTrue(any("逐分" in e for e in errors))

    def test_three_sets_allowed_cap_15(self):
        events = events_for([(15, 10), (10, 15), (15, 9)], ["home", "away", "home"])
        errors = validation.validate_team_package(
            sets=sets_of((15, 10), (10, 15), (15, 9)), events=events, result_status="normal")
        self.assertEqual(errors, [])

    def test_point_beyond_cap_rejected(self):
        errors = validation.validate_sets(
            [{"set_no": 1, "home_points": 16, "away_points": 14, "winner_side": "home"}], "normal")
        self.assertTrue(errors)

    def test_mid_set_forfeit_accepts_partial_last_set(self):
        """第二局打到 8:5 时弃权：半途比分与已有的得分过程都应能提交。"""
        sets = [{"set_no": 1, "home_points": 15, "away_points": 10, "winner_side": "home"},
                {"set_no": 2, "home_points": 8, "away_points": 5, "winner_side": ""}]
        events = events_for([(15, 10), (8, 5)], ["home", "home"])
        self.assertEqual(validation.validate_team_package(
            sets=sets, events=events, result_status="home_forfeit"), [])
        # 同样的数据按“正常完成”提交仍必须被拒
        self.assertTrue(validation.validate_sets(sets, "normal"))
        # 只有最后一局允许停在中途，中间局缺胜方仍报错
        bad = [{"set_no": 1, "home_points": 8, "away_points": 5, "winner_side": ""},
               {"set_no": 2, "home_points": 15, "away_points": 10, "winner_side": "home"}]
        self.assertTrue(any("第1局缺少胜方" in e
                            for e in validation.validate_sets(bad, "unfinished")))

    def test_undo_event_removes_point(self):
        events = [
            {"seq": 1, "kind": "score", "set_no": 1, "side": "home", "home_after": 1, "away_after": 0},
            {"seq": 2, "kind": "undo", "set_no": 1, "side": "", "ref_seq": 1},
            {"seq": 3, "kind": "score", "set_no": 1, "side": "away", "home_after": 0, "away_after": 1},
            {"seq": 4, "kind": "score", "set_no": 1, "side": "home", "home_after": 1, "away_after": 1},
        ]
        scores, errors = validation.replay_events(events)
        self.assertEqual(errors, [])
        self.assertEqual(scores[1], [1, 1])

    def test_score_after_set_finished_rejected(self):
        events = [{"seq": i + 1, "kind": "score", "set_no": 1, "side": "home",
                   "home_after": i + 1, "away_after": 0} for i in range(15)]
        events.append({"seq": 16, "kind": "score", "set_no": 1, "side": "home",
                       "home_after": 16, "away_after": 0})
        _, errors = validation.replay_events(events)
        self.assertTrue(any("已结束" in e or "上限" in e for e in errors))

    def test_individual_requires_value(self):
        errors = validation.validate_individual_package(
            result_status="normal", result_value=None, result_text="", rank_no=None)
        self.assertTrue(errors)
        errors2 = validation.validate_individual_package(
            result_status="dnf", result_value=None, result_text="", rank_no=None)
        self.assertEqual(errors2, [])

    def test_individual_rejects_events(self):
        errors = validation.validate_individual_package(
            result_status="normal", result_value=12, result_text="", rank_no=1,
            events=[{"seq": 1}])
        self.assertTrue(any("不保存" in e for e in errors))


if __name__ == "__main__":
    unittest.main(verbosity=2)

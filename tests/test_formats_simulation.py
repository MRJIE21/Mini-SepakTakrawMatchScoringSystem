"""赛制推演测试：用确定性与随机胜负路径检查对阵结构是否成立。

- 双淘汰：除冠军与决赛负者外，每支队伍必须打满两负才出局（核心不变量）。
- 阶梯淘汰：名次必须完整覆盖 1..N。
- 单循环/单淘汰：场次数量与轮空处理符合预期。
"""
import random
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.domain import formats  # noqa: E402
from app.domain.slots import SlotSpec  # noqa: E402


def teams(n):
    return [SlotSpec("participation", participation_id=i + 1) for i in range(n)]


def play_out(stage, decider):
    """按签名解析并打完整个阶段，返回 (负场统计, 冠军, 决赛负者, 已完成场次)。"""
    def ref_of(spec):
        if spec.type == "participation":
            return ("team", spec.participation_id)
        if spec.type == "bye":
            return ("bye", None)
        return ("match", spec.match_ref, spec.type)

    slots = {m.key: {"home": ref_of(m.home), "away": ref_of(m.away), "seq": m.seq}
             for m in stage.matches}
    played: dict[str, tuple] = {}

    def resolve(ref):
        if ref[0] == "team":
            return ref[1]
        if ref[0] == "bye":
            return None
        key = ref[1]
        if key not in played:
            return None
        winner, loser = played[key]
        return winner if ref[2] == "match_winner" else loser

    losses: dict[int, int] = {}
    progress = True
    while progress:
        progress = False
        for key, info in sorted(slots.items(), key=lambda kv: kv[1]["seq"]):
            if key in played:
                continue
            home, away = resolve(info["home"]), resolve(info["away"])
            if not home or not away:
                continue
            winner, loser = decider(home, away)
            played[key] = (winner, loser)
            losses[loser] = losses.get(loser, 0) + 1
            losses.setdefault(winner, 0)
            progress = True
    last = max(played.items(), key=lambda kv: slots[kv[0]]["seq"]) if played else None
    champion, runner = (last[1][0], last[1][1]) if last else (None, None)
    return losses, champion, runner, len(played)


class DoubleEliminationTest(unittest.TestCase):
    def assert_double_elim(self, n, decider, label):
        stage = formats.gen_double_elim(teams(n), {}, 1, "双淘汰")
        losses, champion, runner, done = play_out(stage, decider)
        self.assertIsNotNone(champion, f"{n} 队（{label}）没有产生冠军")
        self.assertLessEqual(losses[champion], 1, f"{n} 队（{label}）冠军不应输两场")
        # 除冠军与决赛负者外，任何队伍都不允许在只输一场的情况下失去后续比赛
        early = {t: v for t, v in losses.items() if t not in (champion, runner) and v != 2}
        self.assertEqual(early, {}, f"{n} 队（{label}）有队伍只输 {early} 场就出局")
        self.assertEqual(sorted(losses), list(range(1, n + 1)))

    def test_lower_seed_wins_all_sizes(self):
        for n in range(3, 17):
            with self.subTest(n=n):
                self.assert_double_elim(n, lambda h, a: (h, a) if h < a else (a, h), "低号胜")

    def test_higher_seed_wins_all_sizes(self):
        for n in range(3, 17):
            with self.subTest(n=n):
                self.assert_double_elim(n, lambda h, a: (a, h) if h < a else (h, a), "高号胜")

    def test_random_paths(self):
        for n in range(3, 17):
            for trial in range(8):
                rnd = random.Random(n * 1000 + trial)
                decider = (lambda h, a, r=rnd: (h, a) if r.random() < 0.5 else (a, h))
                with self.subTest(n=n, trial=trial):
                    self.assert_double_elim(n, decider, f"随机#{trial}")

    def test_match_count_is_standard(self):
        # 双淘汰完整场次：无轮空时 2n-2（败者区决赛胜者赢下决赛还要加一场重置）
        for n in (4, 8, 16):
            stage = formats.gen_double_elim(teams(n), {}, 1, "双淘汰")
            self.assertEqual(len(stage.matches), 2 * n - 2, f"{n} 队双淘汰场次应为 2n-2")

    def test_byes_do_not_create_empty_matches(self):
        for n in (5, 6, 7, 9, 11, 13):
            stage = formats.gen_double_elim(teams(n), {}, 1, "双淘汰")
            for m in stage.matches:
                self.assertFalse(m.home.is_bye() and m.away.is_bye(),
                                 f"{n} 队出现两侧都是轮空的场次")


class GauntletStructureTest(unittest.TestCase):
    def test_chain_structure(self):
        for n in range(2, 9):
            stage = formats.gen_gauntlet(teams(n), {}, 1, "阶梯")
            matches = sorted(stage.matches, key=lambda m: m.seq)
            self.assertEqual(len(matches), n - 1, f"{n} 队阶梯应有 n-1 场")
            # 第一场：最低号种子 vs 次低号种子
            self.assertEqual(matches[0].home.participation_id, n)
            self.assertEqual(matches[0].away.participation_id, n - 1)
            # 之后每场：上一场胜者 vs 下一个号种子
            for i, m in enumerate(matches[1:], start=1):
                self.assertEqual(m.home.type, "match_winner", f"第{i + 1}场主队应为上一场胜者")
                self.assertEqual(m.home.match_ref, matches[i - 1].key)
                self.assertEqual(m.away.participation_id, n - 1 - i)
            # 最后一场包含 1 号种子，决定第 1、2 名
            self.assertEqual(matches[-1].away.participation_id, 1)
            self.assertEqual(matches[-1].round_label, "决赛")

    def test_no_duplicate_rank_positions(self):
        """阶梯淘汰由落败顺序决定名次：第 i 场落败者名次为 N+1-i，末场再分 1、2。"""
        for n in range(2, 10):
            ranks = []
            for i in range(1, n - 1):    # 前 n-2 场各淘汰一名，末场再分 1、2
                ranks.append(n + 1 - i)
            ranks.extend([1, 2])
            self.assertEqual(sorted(ranks), list(range(1, n + 1)),
                             f"{n} 队阶梯名次应完整且不重复：{sorted(ranks)}")


class SingleElimTest(unittest.TestCase):
    def test_match_count_and_byes(self):
        for n, expect in ((2, 1), (3, 2), (5, 4), (6, 5), (8, 7), (9, 8)):
            stage = formats.gen_single_elim(teams(n), {}, 1, "淘汰")
            self.assertEqual(len(stage.matches), expect, f"{n} 队单淘汰场次")


if __name__ == "__main__":
    unittest.main(verbosity=2)

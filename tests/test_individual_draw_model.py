"""受控随机源证明「开始不预排、每步只抽一人、候选恰为剩余集合」。"""
import unittest
from unittest.mock import patch

from app.domain.individual_draw import (generate, pick_one, remaining, validate_order,
                                        validate_progress)


class RecordingChooser:
    """记录每次 choice 的候选，并按预设顺序返回（不引入概率断言）。"""

    def __init__(self, wanted=()):
        self.wanted = list(wanted)
        self.calls = []

    def choice(self, candidates):
        self.calls.append([row['id'] for row in candidates])
        if self.wanted:
            wanted = self.wanted.pop(0)
            return next(row for row in candidates if row['id'] == wanted)
        return candidates[0]


class IndividualDrawModelTest(unittest.TestCase):
    def test_full_permutation_uses_system_source_and_keeps_input(self):
        roster = [{'id': i} for i in range(1, 41)]
        with patch('app.domain.individual_draw.random.SystemRandom') as source:
            source.return_value.shuffle.side_effect = lambda values: values.reverse()
            self.assertEqual(generate(roster), list(range(40, 0, -1)))
            source.return_value.shuffle.assert_called_once()
        self.assertEqual(roster[0]['id'], 1)

    def test_singleton_and_unchanged_permutation_are_legal(self):
        self.assertEqual(generate([{'id': 6}]), [6])
        class Identity:
            def shuffle(self, values): pass
        self.assertEqual(generate([{'id': 8}, {'id': 9}], Identity()), [8, 9])

    def test_empty_duplicate_omitted_foreign_bool_and_wrong_type_rejected(self):
        with self.assertRaises(ValueError): generate([])
        with self.assertRaises(ValueError): generate([{'id': 1}, {'id': 1}])
        for order in ([1], [1, 1], [1, 3], [True, 2], ['1', 2], None):
            with self.subTest(order=order), self.assertRaises(ValueError):
                validate_order(order, [{'id': 1}, {'id': 2}])

    def test_single_step_pick_uses_one_choice_over_exactly_the_remaining_set(self):
        roster = [{'id': i, 'name': f'选手{i}'} for i in range(1, 6)]
        chooser = RecordingChooser([3, 1, 2, 4, 5])
        # 第一步：候选恰为全部名单，且只调用一次随机源。
        self.assertEqual(pick_one(roster, [], chooser), 3)
        self.assertEqual(chooser.calls, [[1, 2, 3, 4, 5]])
        order = [3]
        for _ in range(4):
            picked = pick_one(roster, order, chooser)
            self.assertNotIn(picked, order)
            order.append(picked)
        self.assertEqual(order, [3, 1, 2, 4, 5])
        self.assertEqual(chooser.calls[1:], [[1, 2, 4, 5], [2, 4, 5], [4, 5], [5]])
        self.assertEqual(len(chooser.calls), 5)
        self.assertEqual(sorted(order), [1, 2, 3, 4, 5])

    def test_no_choice_before_first_step_and_none_when_exhausted(self):
        roster = [{'id': 7}, {'id': 8}]
        chooser = RecordingChooser()
        # 开始抽取/展示候选本身不调用随机源，不预排完整顺序。
        self.assertEqual([row['id'] for row in remaining(roster, [])], [7, 8])
        self.assertEqual(chooser.calls, [])
        with self.assertRaises(ValueError):
            pick_one(roster, [7, 8], chooser)
        self.assertEqual(chooser.calls, [])

    def test_singleton_roster_completes_in_one_step(self):
        roster = [{'id': 42}]
        chooser = RecordingChooser()
        self.assertEqual(pick_one(roster, [], chooser), 42)
        self.assertEqual(chooser.calls, [[42]])

    def test_progress_must_be_unique_subset_of_the_snapshot(self):
        roster = [{'id': 1}, {'id': 2}, {'id': 3}]
        for order in ([], [1], [3, 1]):
            self.assertEqual(validate_progress(list(order), roster), list(order))
        for order in ([1, 1], [1, 4], [True], ['1'], [1.0], None, {1: 1}):
            with self.subTest(order=order), self.assertRaises(ValueError):
                validate_progress(order, roster)

    def test_pick_default_source_is_the_operating_system_random_source(self):
        roster = [{'id': 1}, {'id': 2}, {'id': 3}]
        with patch('app.domain.individual_draw.random.SystemRandom') as source:
            source.return_value.choice.side_effect = lambda candidates: candidates[1]
            self.assertEqual(pick_one(roster, [1]), 3)
            source.return_value.choice.assert_called_once()
            candidates = source.return_value.choice.call_args[0][0]
            self.assertEqual([row['id'] for row in candidates], [2, 3])


if __name__ == '__main__':
    unittest.main()

import itertools
import unittest
from app.domain import auto_schedule as auto


def match(key, a=1, b=2, **values):
    return {'id': key, 'stage_id': 1, 'round_no': 1, 'pool_id': None,
        'home_source_type': 'participation', 'home_participation': a,
        'away_source_type': 'participation', 'away_participation': b,
        'duration_minutes': 30, 'rest_minutes': 30, 'scheduled_at': '', 'venue_id': None,
        'movable': True, **values}


def config(end='14:00', venues=(1, 2)):
    return auto.settings({'stage_ids': [1], 'duration_minutes': 30, 'rest_minutes': 30,
        'windows': [{'venue_id': v, 'start': '2026-10-18 09:00', 'end': '2026-10-18 ' + end} for v in venues]})


class AutoScheduleModelTest(unittest.TestCase):
    def test_circle_pairs_odd_even_and_byes(self):
        for n in range(1, 12):
            rows = auto.round_robin(list(range(1, n + 1)))
            pairs = [frozenset((a, b)) for _, a, b in rows]
            self.assertEqual(len(pairs), n * (n-1)//2)
            self.assertEqual(set(pairs), {frozenset(p) for p in itertools.combinations(range(1, n+1), 2)})
            for rnd in {r for r, _, _ in rows}:
                teams = [t for r, a, b in rows if r == rnd for t in (a, b)]
                self.assertEqual(len(teams), len(set(teams)))

    def test_positive_rules_and_normalized_windows(self):
        for key in ('rest_minutes', 'duration_minutes'):
            for invalid in (0, -1, True, '30'):
                with self.assertRaises(ValueError):
                    auto.settings({**config(), key: invalid})
        c = config()
        c['windows'].append({'venue_id': 1, 'start': '2026-10-18 10:00', 'end': '2026-10-18 17:00'})
        self.assertEqual(len(auto.settings(c)['windows']), 2)
        with self.assertRaises(ValueError):
            auto.stamp('2026-10-18T09:00+08:00')

    def test_rest_measured_from_end_even_on_another_court(self):
        result = auto.arrange([match(1), match(2, 1, 3)], {}, config())
        self.assertTrue(result['complete'])
        games = sorted(result['changes'], key=lambda r: r['scheduled_at'])
        self.assertGreaterEqual((auto.stamp(games[1]['scheduled_at']) - auto.stamp(games[0]['scheduled_at'])).total_seconds(), 3600)
        self.assertEqual(auto.violations(games, {}, config()['windows']), [])

    def test_fixed_occupancy_break_and_partial_fields(self):
        fixed = match(1, 8, 9, movable=False, scheduled_at='2026-10-18 09:00', venue_id=1)
        new = match(2, fixed_venue=1)
        c = config(venues=(1,))
        c['windows'] = [{'venue_id': 1, 'start': '2026-10-18 09:00', 'end': '2026-10-18 09:30'},
                        {'venue_id': 1, 'start': '2026-10-19 13:00', 'end': '2026-10-19 14:00'}]
        result = auto.arrange([fixed, new], {}, c)
        self.assertTrue(result['complete'])
        self.assertEqual(result['changes'][0]['scheduled_at'], '2026-10-19 13:00')
        self.assertEqual(fixed['scheduled_at'], '2026-10-18 09:00')

    def bracket(self):
        pools = {1: [11,12,13], 2: [21,22,23]}
        rows = []
        for key, rank in ((1,1),(2,2)):
            rows.append(match(key, None, None, home_source_type='pool_rank', home_source_pool=1,
                home_source_rank=rank, away_source_type='pool_rank', away_source_pool=2, away_source_rank=rank))
        for key, kind in ((3,'match_winner'),(4,'match_loser')):
            rows.append(match(key, None, None, round_no=2, home_source_type=kind, home_source_match=1,
                away_source_type=kind, away_source_match=2))
        return rows, pools

    def test_unknown_distinct_ranks_and_final_bronze_parallel(self):
        rows, pools = self.bracket()
        model = auto.Sources(rows, pools)
        self.assertFalse(model.share(1,2)); self.assertFalse(model.share(3,4))
        result = auto.arrange(rows, pools, config())
        self.assertTrue(result['complete'])
        by_id = {r['id']: r for r in result['changes']}
        self.assertEqual(by_id[1]['scheduled_at'], by_id[2]['scheduled_at'])
        self.assertEqual(by_id[3]['scheduled_at'], by_id[4]['scheduled_at'])
        for aranks in itertools.permutations(pools[1]):
            for branks in itertools.permutations(pools[2]):
                for w1, w2 in itertools.product((0,1), repeat=2):
                    teams = {1: (aranks[0], branks[0]), 2: (aranks[1], branks[1])}
                    teams[3] = (teams[1][w1], teams[2][w2])
                    teams[4] = (teams[1][1-w1], teams[2][1-w2])
                    for team in [*aranks, *branks]:
                        actual = sorted([auto.interval(by_id[k]) for k in teams if team in teams[k]])
                        for before, after in zip(actual, actual[1:]):
                            self.assertGreaterEqual((after[0]-before[1]).total_seconds(), 1800)

    def test_infeasible_does_not_sacrifice_rest(self):
        result = auto.arrange([match(1), match(2,1,3)], {}, config('09:45'))
        self.assertFalse(result['complete']); self.assertEqual(len(result['unplaced']), 1)
        self.assertEqual(result['changes'][0]['rest_minutes'], 30)

    def test_search_budget_is_distinct_from_infeasibility(self):
        result = auto.arrange([match(1)], {}, config(), max_nodes=1)
        self.assertEqual(result['status'], 'search_limit')

    def test_independent_check_detects_overlap_rest_and_dependency(self):
        a = match(1, scheduled_at='2026-10-18 09:00', venue_id=1)
        b = match(2, 1, 3, scheduled_at='2026-10-18 09:15', venue_id=1)
        errors = auto.violations([a,b], {})
        self.assertTrue(any('场地' in e for e in errors)); self.assertTrue(any('休息' in e for e in errors))
        rows, pools = self.bracket()
        for row in rows:
            row.update(scheduled_at='2026-10-18 09:00', venue_id=row['id'])
        self.assertTrue(any('前序' in e for e in auto.violations(rows,pools)))

    def test_cycle_invalid_rank_and_missing_source(self):
        rows, pools = self.bracket()
        rows[0].update(home_source_type='match_winner', home_source_match=3)
        with self.assertRaisesRegex(ValueError, '循环'):
            auto.Sources(rows, pools)
        with self.assertRaisesRegex(ValueError, '来源缺失'):
            auto.Sources([match(1, None, None)], {})


if __name__ == '__main__': unittest.main()

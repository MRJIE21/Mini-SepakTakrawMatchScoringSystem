import unittest
import random
from app.domain.schedule_stages import compile_stage, group_entries


class ScheduleStageModelTest(unittest.TestCase):
    def test_played_graph_outputs_never_duplicate_a_school_or_rank(self):
        for groups in range(2, 17):
            for purpose in ('knockout', 'placement'):
                graph = compile_stage(self.definition(groups, purpose))
                for seed in range(10):
                    rng = random.Random(seed)
                    outcomes, ranks = {}, {}
                    def resolve(source):
                        if source['type'] == 'pool_rank': return (source['pool_id'], source['rank'])
                        return outcomes[source['key']][0 if source['type'] == 'match_winner' else 1]
                    for match in graph['matches']:
                        pair = [resolve(match['home']), resolve(match['away'])]
                        self.assertNotEqual(*pair)
                        if rng.randrange(2): pair.reverse()
                        outcomes[match['key']] = pair
                        for field, pid in zip(('winner_rank', 'loser_rank'), pair):
                            if match[field] is not None:
                                self.assertNotIn(match[field], ranks)
                                ranks[match[field]] = pid
                    for award in graph['awards']: ranks[award['rank']] = resolve(award['source'])
                    self.assertEqual(sorted(ranks), list(range(graph['rank_from'], graph['rank_to'] + 1)))
                    self.assertEqual(len(set(ranks.values())), len(ranks))

    def definition(self, groups, purpose='knockout', rank=3):
        pools = [{'id': i + 1, 'name': chr(65 + i), 'members': list(range(4))} for i in range(groups)]
        entries, slots, pairs = group_entries(pools, [1, 2] if purpose == 'knockout' else [rank])
        return {'name': purpose, 'purpose': purpose, 'entries': entries, 'bracket_slots': slots,
                'required_pairs': pairs, 'rank_from': 5, 'rank_to': 4 + len(entries)}

    def test_two_four_eight_and_six_group_first_round_is_rank_major(self):
        for count in (2, 4, 6, 8):
            definition = self.definition(count)
            graph = compile_stage(definition)
            first = [m for m in graph['matches'] if m['round_no'] == 1]
            expected = [(left['pool_id'], right['pool_id'], left['rank'])
                        for left, right in zip(definition['entries'][::2], definition['entries'][1::2])]
            self.assertEqual([(m['home']['pool_id'], m['away']['pool_id'], m['home']['rank']) for m in first], expected)
            self.assertEqual(len(graph['matches']), count * 2)
            self.assertEqual([m['role'] for m in graph['matches']].count('final'), 1)
            self.assertEqual([m['role'] for m in graph['matches']].count('bronze'), 1)
            self.assertEqual(bool(graph['byes']), count == 6)

    def test_odd_group_preserves_both_unpaired_rank_sources_as_explicit_byes(self):
        graph = compile_stage(self.definition(3))
        self.assertEqual(len(graph['byes']), 2)
        first = [m for m in graph['matches'] if m['round_no'] == 1]
        self.assertEqual([(m['home']['rank'], m['away']['rank']) for m in first], [(1, 1), (2, 2)])
        self.assertEqual(len([m for m in graph['matches'] if m['role'] == 'bronze']), 1)

    def test_placement_range_and_every_winner_loser_output(self):
        for groups in (2, 3, 4, 6, 8):
            for start in (5, 9, 17):
                d = self.definition(groups, 'placement')
                d.update(rank_from=start, rank_to=start + groups - 1)
                graph = compile_stage(d)
                ranks = [a['rank'] for a in graph['awards']]
                ranks += [m[k] for m in graph['matches'] for k in ('winner_rank', 'loser_rank') if m[k] is not None]
                self.assertEqual(sorted(ranks), list(range(start, start + groups)))

    def test_reject_duplicate_source_rank_gap_and_seed_reorder(self):
        d = self.definition(4)
        d['entries'][1] = d['entries'][0]
        with self.assertRaisesRegex(ValueError, '重复'): compile_stage(d)
        d = self.definition(4)
        d['bracket_slots'] = [0, 7, 1, 6, 2, 5, 3, 4]
        with self.assertRaisesRegex(ValueError, '种子'): compile_stage(d)
        d = self.definition(4, 'placement'); d['rank_to'] = 10
        with self.assertRaisesRegex(ValueError, '数量'): compile_stage(d)

    def test_group_and_manual_do_not_create_fixtures(self):
        for purpose in ('group', 'manual'):
            self.assertEqual(compile_stage({'purpose': purpose, 'name': '仅建立阶段'})['matches'], [])

    def test_missing_pool_rank_and_incomplete_first_four_rejected(self):
        with self.assertRaisesRegex(ValueError, '没有第3名'):
            group_entries([{'id': 1, 'name': 'A组', 'members': [1, 2]}], [3])
        d = self.definition(2); d['entries'] = d['entries'][:2]
        with self.assertRaisesRegex(ValueError, '至少'): compile_stage(d)


if __name__ == '__main__': unittest.main()

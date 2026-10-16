import copy
import json
from pathlib import Path
import unittest
from app.domain import team_rules as rules
from app.domain import validation, ranking


def events_for_scores(scoreline):
    events = []
    for no, (home, away) in enumerate(scoreline, 1):
        h = a = 0
        while h < home or a < away:
            side = 'home' if h < home and (a >= away or h <= a) else 'away'
            if side == 'home': h += 1
            else: a += 1
            events.append({'seq': len(events) + 1, 'kind': 'score', 'set_no': no, 'side': side,
                           'home_after': h, 'away_after': a})
    return events


class RuleTests(unittest.TestCase):
    def test_shared_winner_and_terminal_vectors(self):
        vectors = json.loads(Path(__file__).with_name('team_rules_vectors.json').read_text())
        for vector in vectors:
            for home, away, expected, legal in vector['cases']:
                with self.subTest(rule=vector['rule'], score=(home, away)):
                    self.assertEqual(rules.winner(home, away, vector['rule']), expected)
                    self.assertEqual(rules.legal_score(home, away, vector['rule']), legal)

    def test_formats_and_deciding_set(self):
        for maximum in (1, 3, 5, 7, 9):
            r = rules.normalize()
            r['max_sets'] = maximum
            r['deciding'] = {'mode': 'fixed_deuce', 'target_points': 11, 'deuce_points': 13}
            self.assertEqual(rules.sets_to_win(r), (maximum + 1) // 2)
            for no in range(1, maximum + 1):
                self.assertEqual(rules.for_set(r, no), r['deciding'] if no == maximum else r['regular'])

    def test_strict_parameters_and_no_mutation(self):
        original = rules.normalize()
        for maximum in (0, 2, 4, 10, -1, True, 3.0, '3'):
            r = copy.deepcopy(original)
            r['max_sets'] = maximum
            with self.assertRaises(ValueError): rules.normalize(r)
        for patch in ({'target_points': 0}, {'target_points': 100}, {'win_by': True},
                      {'win_by': 3}, {'point_cap': 14}, {'point_cap': 1000}, {'other': 1}):
            r = copy.deepcopy(original)
            r['regular'].update(patch)
            with self.assertRaises(ValueError): rules.normalize(r)
        for patch in ({'schema_version': True}, {'schema_version': 2}, {'extra': 1}, {'deciding': {}}):
            with self.assertRaises(ValueError): rules.normalize({**original, **patch})
        r = rules.normalize()
        r['regular']['target_points'] = 9
        self.assertEqual(rules.normalize(), original)
        self.assertEqual(rules.fingerprint(original), rules.fingerprint(json.loads(rules.canonical(original))))

    def test_invalid_score_types(self):
        for score in (-1, True, 1.5, '15', None, 2147483648):
            self.assertFalse(rules.legal_score(score, 0, rules.DEFAULT_RULES['regular']))

    def test_package_formats_replay_undo_and_early_finish(self):
        for maximum in (1, 3, 5, 7, 9):
            r = rules.normalize(); r['max_sets'] = maximum
            need = rules.sets_to_win(r)
            sets = [{'set_no': i, 'home_points': 15, 'away_points': 0, 'winner_side': 'home'} for i in range(1, need + 1)]
            events = events_for_scores([(15, 0)] * need)
            self.assertEqual(validation.validate_team_package(sets=sets, events=events, result_status='normal', rules=r), [])
            self.assertEqual(ranking.match_winner_side({'rules': r, 'sets': sets, 'result_status': 'normal'}), 'home')
            events.append({'seq': len(events) + 1, 'kind': 'score', 'set_no': need, 'side': 'home'})
            self.assertTrue(validation.replay_events(events, rules=r)[1])
            events.pop()
            last = events[-1]
            events.append({'seq': len(events) + 1, 'kind': 'undo', 'set_no': last['set_no'], 'ref_seq': last['seq']})
            self.assertEqual(validation.replay_events(events, rules=r)[1], [])
            self.assertEqual(validation.replay_events(events, rules=r)[0][need], [14, 0])

    def test_all_modes_deciding_and_invalid_historical_undo(self):
        r = rules.normalize(); r['max_sets'] = 1
        for vector in json.loads(Path(__file__).with_name('team_rules_vectors.json').read_text()):
            r['regular'] = vector['rule']
            for h, a, w, legal in vector['cases']:
                if legal and w and h < 50 and a < 50:
                    sets = [{'set_no': 1, 'home_points': h, 'away_points': a, 'winner_side': w}]
                    self.assertEqual(validation.validate_team_package(sets=sets, events=events_for_scores([(h, a)]), result_status='normal', rules=r), [])
        r = rules.normalize(); r['deciding'] = {'mode': 'fixed_deuce', 'target_points': 11, 'deuce_points': 13}
        scoreline = [(15, 0), (0, 15), (13, 11)]
        sets = [{'set_no': i, 'home_points': h, 'away_points': a, 'winner_side': rules.winner(h, a, rules.for_set(r, i))}
                for i, (h, a) in enumerate(scoreline, 1)]
        self.assertEqual(validation.validate_team_package(sets=sets, events=events_for_scores(scoreline), result_status='normal', rules=r), [])
        events = events_for_scores([(15, 0), (1, 0)])
        events.append({'seq': len(events) + 1, 'kind': 'undo', 'set_no': 1, 'ref_seq': 15})
        self.assertTrue(validation.replay_events(events)[1])


if __name__ == '__main__': unittest.main()

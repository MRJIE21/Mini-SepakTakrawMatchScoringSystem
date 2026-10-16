"""学校抽签不变量，以及真实 HTTP 的恢复、冲突、编排和锁定覆盖。"""
import json
import random
import tempfile
import unittest
import uuid
from pathlib import Path

from app.domain.group_draw import draw_groups
from app.domain.slots import pool_name
import test_api as fixtures
from app import config, db


class DrawRulesTest(unittest.TestCase):
    def test_random_capacities_and_unique_school_membership(self):
        roster = [{'id': i} for i in range(17)]
        for seed in range(100):
            steps = draw_groups(roster, 'random', [8, 5, 4], random.Random(seed))
            self.assertEqual(sorted(s['participation_id'] for s in steps), list(range(17)))
            self.assertEqual([sum(s['group'] == g for s in steps) for g in range(3)], [8, 5, 4])
        self.assertEqual(roster, [{'id': i} for i in range(17)])

    def test_seeded_pots_with_partial_last_pot_and_unequal_capacities(self):
        for count in range(4, 35):
            for groups in range(2, min(8, count // 2) + 1):
                capacities = [count // groups + (g < count % groups) for g in range(groups)]
                roster = [{'id': i, 'seed_no': 3 * i + 1} for i in reversed(range(count))]
                for seed in range(8):
                    steps = draw_groups(roster, 'seeded', capacities, random.Random(seed))
                    self.assertEqual(len(steps), count)
                    self.assertEqual(len({s['participation_id'] for s in steps}), count)
                    self.assertEqual([sum(s['group'] == g for s in steps) for g in range(groups)], capacities)
                    self.assertEqual(len({(s['pot'], s['group']) for s in steps}), count)
                    for step in steps:
                        self.assertEqual(step['pot'], step['participation_id'] // groups + 1)

    def test_invalid_settings_and_missing_or_duplicate_seeds(self):
        roster = [{'id': i, 'seed_no': i + 1} for i in range(8)]
        for caps in ([], [3, 3], [0, 8], [-1, 9], [4.0, 4], [True, 7]):
            with self.assertRaises(ValueError): draw_groups(roster, 'random', caps)
        with self.assertRaises(ValueError): draw_groups(roster, 'seeded', [2, 6])
        for seed in (None, 0, 1, True):
            roster[-1]['seed_no'] = seed
            with self.assertRaises(ValueError): draw_groups(roster, 'seeded', [4, 4])

    def test_single_group_single_school_groups_and_more_than_26_groups(self):
        for caps in ([1], [4], [2, 1, 1], [1] * 27):
            count = sum(caps)
            roster = [{'id': i, 'seed_no': i + 1} for i in range(count)]
            for method in ('random', 'seeded'):
                for seed in range(8):
                    steps = draw_groups(roster, method, caps, random.Random(seed))
                    self.assertEqual(sorted(s['participation_id'] for s in steps), list(range(count)))
                    self.assertEqual([sum(s['group'] == g for s in steps) for g in range(len(caps))], caps)
        names = [pool_name(i) for i in range(27)]
        self.assertEqual(len(set(names)), 27)
        self.assertEqual((names[0], names[25], names[26]), ('A小组', 'Z小组', 'AA小组'))


class DrawApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        task_tmp = Path(tempfile.mkdtemp(prefix='stss_draw_'))
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = task_tmp, task_tmp / 'registry.db', task_tmp / 'events'
        fixtures.ApiTest.setUpClass.__func__(cls)

    tearDownClass = classmethod(fixtures.ApiTest.tearDownClass.__func__)
    request = fixtures.ApiTest.request
    ok = fixtures.ApiTest.ok
    err = fixtures.ApiTest.err
    login = fixtures.ApiTest.login
    make_user = fixtures.ApiTest.make_user
    build_event = fixtures.ApiTest.build_event
    play = fixtures.ApiTest.play
    events_for = fixtures.ApiTest.events_for
    lineup_for = fixtures.ApiTest.lineup_for

    def setUp(self):
        fixtures.ApiTest.setUp(self)
        self.use_event_database = True
        self.fx = self.build_event(10, 0)
        self.path = f"/api/categories/{self.fx['team_cat']}/group-draw"

    def current(self): return self.ok('GET', self.path)['draw']

    def packet(self, **body):
        return {'request_uid': str(uuid.uuid4()), 'event_identity': self.event_identity, **body}

    def start(self, caps=None, method='random', **extra):
        return self.ok('POST', self.path, self.packet(method=method, capacities=caps or [4, 3, 3],
            roster_hash=self.ok('GET', self.path)['roster_hash'], **extra))['draw']

    def action(self, name, **extra):
        draw = self.current()
        return self.ok('POST', self.path + '/' + name, self.packet(draw_id=draw['id'], base_rev=draw['rev'], **extra))['draw']

    def draft(self, draw_id, cat=None, expect=200, code=None):
        result = self.request('POST', f"/api/categories/{cat or self.fx['team_cat']}/schedule/stages",
            self.packet(base_revision=0, definition={'purpose': 'group', 'name': '小组赛', 'draw_id': draw_id}), expect=expect)
        if code: self.assertEqual(result['code'], code)
        return result

    def confirm_stage(self, stage):
        sid = stage['stage_id']
        preview = self.ok('POST', f'/api/schedule-stages/{sid}/preview', self.packet(base_revision=1))
        self.ok('POST', f'/api/schedule-stages/{sid}/confirm', self.packet(base_revision=1,
            definition_hash=preview['definition_hash'], basis_hash=preview['basis_hash']))
        return self.ok('GET', f"/api/categories/{self.fx['team_cat']}/plan")['plan']['stages'][0]

    def test_single_group_and_unequal_groups_keep_members_without_auto_fixtures(self):
        for capacities in ([10], [8, 1, 1]):
            if self.current(): self.action('cancel', reason='重新验证组数')
            draw = self.start(capacities); self.action('complete'); draw = self.action('confirm')
            stage = self.draft(draw['id'])
            formal = self.confirm_stage(stage)
            self.assertEqual(formal['matches'], [])
            self.assertEqual([len(p['members']) for p in formal['pools']], capacities)
            for pool, group in zip(formal['pools'], draw['groups']):
                self.assertEqual([p['participation_id'] for p in pool['members']], [p['participation_id'] for p in group['members']])
            self.ok('POST', f"/api/schedule-stages/{stage['stage_id']}/unconfirm", self.packet(base_revision=2, reason='核对'))
            self.ok('DELETE', f"/api/schedule-stages/{stage['stage_id']}", self.packet(category_id=self.fx['team_cat'], base_revision=3))

    def test_more_than_26_group_names_match_draw_print_and_schedule(self):
        self.fx = self.build_event(27, 0); self.path = f"/api/categories/{self.fx['team_cat']}/group-draw"
        self.start([1] * 27); self.action('complete'); draw = self.action('confirm')
        formal = self.confirm_stage(self.draft(draw['id']))
        names = [p['name'] for p in formal['pools']]
        self.assertEqual((names[0], names[25], names[26]), ('A组', 'Z组', 'AA组'))
        self.assertEqual(names, [g['name'] for g in draw['groups']])
        status, html = self.request('GET', self.path + '/notice.html', raw=True)
        self.assertEqual(status, 200); self.assertIn('AA组', html.decode())

    def test_lifecycle_retry_revision_confirmation_and_use_guard(self):
        draw = self.start(); self.assertEqual(draw['steps'], [])
        self.draft(draw['id'], expect=409, code='draw_not_confirmed')
        body = self.packet(draw_id=draw['id'], base_rev=draw['rev'])
        first = self.ok('POST', self.path + '/next', body)['draw']
        self.assertEqual(first['revealed'], 1)
        self.assertTrue(self.ok('POST', self.path + '/next', body)['replayed'])
        self.err('POST', self.path + '/next', {**body, 'request_uid': str(uuid.uuid4())}, expect=409, code='draw_stale_revision')
        completed = self.action('complete'); self.assertEqual(completed['steps'][0], first['steps'][0])
        draw = self.action('confirm'); self.confirm_stage(self.draft(draw['id']))
        self.err('POST', self.path + '/cancel', self.packet(draw_id=draw['id'], base_rev=draw['rev'], reason='调整'), expect=409, code='draw_in_use')

    def test_seeded_pots_and_roster_staleness(self):
        old = self.ok('GET', self.path)
        self.ok('PUT', f"/api/participations/{self.fx['team_parts'][0]}", {'seed_no': 101})
        self.err('POST', self.path, self.packet(method='random', capacities=[4, 3, 3], roster_hash=old['roster_hash']), expect=409, code='draw_roster_changed')
        self.start(method='seeded'); draw = self.action('complete')
        self.assertEqual(len({(s['group'], s['pot']) for s in draw['steps']}), 10)
        self.ok('PUT', f"/api/participations/{self.fx['team_parts'][1]}", {'seed_no': 102})
        self.assertTrue(self.current()['stale'])
        self.err('POST', self.path + '/confirm', self.packet(draw_id=draw['id'], base_rev=draw['rev']), expect=409, code='draw_roster_changed')
        self.action('cancel', reason='名单调整'); self.assertFalse(self.start()['stale'])

    def test_roles_and_cross_category_draw_reference(self):
        organizer, recorder, viewer = [self.make_user(role) for role in ('organizer', 'recorder', 'viewer')]
        self.ok('GET', self.path, token=organizer)
        for token in (recorder, viewer):
            self.err('GET', self.path, token=token, expect=403)
            self.err('POST', self.path, self.packet(), token=token, expect=403)
        self.err('GET', f"/api/categories/{self.fx['indiv_cat']}/group-draw")
        self.start(); self.action('complete'); draw = self.action('confirm')
        other = next(c['id'] for c in self.fx['groups']['乙']['categories'] if c['kind'] == 'team' and c['gender'] == 'male')
        self.draft(draw['id'], cat=other, expect=409, code='draw_not_confirmed')


if __name__ == '__main__': unittest.main()

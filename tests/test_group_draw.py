"""学校抽签不变量，以及真实 HTTP 的恢复、冲突、编排和锁定覆盖。"""
import json
import random
import tempfile
import unittest
import uuid
from pathlib import Path

from app.domain.group_draw import draw_groups
from app.domain.formats import plan_pools
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
        names = [name for name, _ in plan_pools(27, {'pool_count': 27})]
        self.assertEqual(len(set(names)), 27)
        self.assertEqual((names[0], names[25], names[26]), ('A小组', 'Z小组', 'AA小组'))


class DrawApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        task_tmp = Path(tempfile.mkdtemp(prefix='stss_draw_'))
        config.DATA_DIR = task_tmp
        config.DB_PATH = task_tmp / 'registry.db'
        config.EVENTS_DIR = task_tmp / 'events'
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
        self.fx = self.build_event(team_count=10, individual_count=0)
        self.path = f"/api/categories/{self.fx['team_cat']}/group-draw"

    def current(self):
        return self.ok('GET', self.path)['draw']

    def start(self, method='random', caps=None, **extra):
        body = {'method': method, 'capacities': caps or [4, 3, 3], 'request_uid': str(uuid.uuid4()),
                'roster_hash': self.ok('GET', self.path)['roster_hash'], **extra}
        return self.ok('POST', self.path, body)['draw']

    def action_body(self, **extra):
        draw = self.current()
        return {'draw_id': draw['id'], 'base_rev': draw['rev'], 'request_uid': str(uuid.uuid4()), **extra}

    def action(self, name, **extra):
        return self.ok('POST', self.path + '/' + name, self.action_body(**extra))['draw']

    def plan(self, draw_id):
        return self.ok('POST', f"/api/categories/{self.fx['team_cat']}/plan", {'stages': [
            {'kind': 'round_robin', 'name': '小组赛', 'params': {'pool_count': 3, 'legs': 1, 'assign': 'snake', 'draw_id': draw_id}},
            {'kind': 'single_elim', 'name': '淘汰赛', 'params': {'third_place': True, 'sources': [
                {'type': 'pool_rank', 'stage': 1, 'pool': group, 'rank': rank}
                for rank in (1, 2) for group in range(3)]}},
        ]})['plan_id']

    def test_single_group_draw_keeps_confirmation_and_generation_guards(self):
        self.start(caps=[10])
        plain = self.ok('POST', f"/api/categories/{self.fx['team_cat']}/plan", {'stages': [
            {'kind': 'round_robin', 'params': {'pool_count': 1}}]})['plan_id']
        self.err('POST', f'/api/plans/{plain}/generate', expect=409, code='draw_not_confirmed')
        self.action('complete')
        confirmed = self.action('confirm')
        self.err('POST', f'/api/plans/{plain}/generate', expect=409, code='draw_groups_changed')
        plan_id = self.ok('POST', f"/api/categories/{self.fx['team_cat']}/plan", {'stages': [
            {'kind': 'round_robin', 'params': {'pool_count': 1, 'draw_id': confirmed['id']}}]})['plan_id']
        self.assertEqual(self.ok('POST', f'/api/plans/{plan_id}/generate')['matches_total'], 45)
        pools = self.ok('GET', f'/api/plans/{plan_id}')['plan']['stages'][0]['pools']
        self.assertEqual(len(pools), 1)
        self.assertEqual([m['participation_id'] for m in pools[0]['members']],
                         [m['participation_id'] for m in confirmed['groups'][0]['members']])

    def test_single_school_groups_generate_without_inventing_matches(self):
        self.start(caps=[8, 1, 1])
        self.action('complete')
        confirmed = self.action('confirm')
        plan_id = self.ok('POST', f"/api/categories/{self.fx['team_cat']}/plan", {'stages': [
            {'kind': 'round_robin', 'params': {'pool_count': 3, 'draw_id': confirmed['id']}}]})['plan_id']
        generated = self.ok('POST', f'/api/plans/{plan_id}/generate')
        self.assertEqual(generated['matches_total'], 28)
        pools = self.ok('GET', f'/api/plans/{plan_id}')['plan']['stages'][0]['pools']
        self.assertEqual([len(p['members']) for p in pools], [8, 1, 1])

    def test_more_than_26_group_names_match_draw_print_and_schedule(self):
        self.fx = self.build_event(team_count=27, individual_count=0)
        self.path = f"/api/categories/{self.fx['team_cat']}/group-draw"
        self.start(caps=[1] * 27)
        self.action('complete')
        confirmed = self.action('confirm')
        names = [g['name'] for g in confirmed['groups']]
        self.assertEqual(len(set(names)), 27)
        self.assertEqual((names[0], names[25], names[26]), ('A组', 'Z组', 'AA组'))
        plan_id = self.ok('POST', f"/api/categories/{self.fx['team_cat']}/plan", {'stages': [
            {'kind': 'round_robin', 'params': {'pool_count': 27, 'draw_id': confirmed['id']}}]})['plan_id']
        self.assertEqual(self.ok('POST', f'/api/plans/{plan_id}/generate')['matches_total'], 0)
        pools = self.ok('GET', f'/api/plans/{plan_id}')['plan']['stages'][0]['pools']
        self.assertEqual([p['name'] for p in pools], names)
        notice = self.request('GET', self.path + '/notice.html', raw=True)
        self.assertEqual(notice[0], 200)
        self.assertIn('AA组', notice[1].decode())

    def test_lifecycle_retry_revision_and_fixed_schedule(self):
        start = self.start()
        self.assertEqual(start['status'], 'drawing')
        self.assertEqual(start['steps'], [])
        self.err('POST', self.path + '/confirm', self.action_body(), expect=409, code='draw_incomplete')
        body = self.action_body()
        first = self.ok('POST', self.path + '/next', body)['draw']
        self.assertEqual(first['revealed'], 1)
        self.assertTrue(self.ok('POST', self.path + '/next', body)['replayed'])
        self.assertEqual(self.current()['revealed'], 1)
        self.err('POST', self.path + '/next', dict(body, request_uid=str(uuid.uuid4())), expect=409, code='draw_stale_revision')
        complete = self.action('complete')
        self.assertEqual(complete['steps'][0], first['steps'][0])
        self.assertEqual([len(g['members']) for g in complete['groups']], [4, 3, 3])
        confirmed = self.action('confirm')
        plan_id = self.plan(confirmed['id'])
        expected = [[p['participation_id'] for p in g['members']] for g in confirmed['groups']]
        for _ in range(2):
            generated = self.ok('POST', f'/api/plans/{plan_id}/generate')
            self.assertEqual(generated['matches_total'], 18)
            pools = self.ok('GET', f'/api/plans/{plan_id}')['plan']['stages'][0]['pools']
            self.assertEqual([[m['participation_id'] for m in p['members']] for p in pools], expected)
        notice = self.request('GET', self.path + '/notice.html', raw=True)
        self.assertEqual(notice[0], 200)
        self.assertIn('学校小组抽签分组表', notice[1].decode())
        self.ok('POST', f'/api/plans/{plan_id}/lock')
        self.err('POST', self.path + '/cancel', self.action_body(reason='调整'), expect=403)
        self.err('POST', self.path, {'request_uid': str(uuid.uuid4())}, expect=403)
        self.ok('POST', f'/api/plans/{plan_id}/unlock', {'reason': '核对分组'})
        self.action('cancel', reason='调整组数')
        self.err('POST', f'/api/plans/{plan_id}/generate', expect=409, code='draw_not_confirmed')
        self.assertEqual(self.ok('GET', self.path)['history'][0]['cancel_reason'], '调整组数')
        self.assertNotEqual(self.start()['id'], confirmed['id'])

    def test_seeded_membership_and_unconfirmed_generation(self):
        draw = self.start('seeded')
        self.err('POST', self.path, {'request_uid': str(uuid.uuid4())}, expect=409, code='draw_exists')
        self.err('POST', f"/api/categories/{self.fx['team_cat']}/plan", {'stages': [
            {'kind': 'round_robin', 'params': {'pool_count': 3, 'draw_id': draw['id']}}]}, expect=409, code='draw_not_confirmed')
        plain = self.ok('POST', f"/api/categories/{self.fx['team_cat']}/plan", {'stages': [
            {'kind': 'round_robin', 'params': {'pool_count': 3}}]})['plan_id']
        self.err('POST', f'/api/plans/{plain}/generate', expect=409, code='draw_not_confirmed')
        draw = self.action('complete')
        self.assertEqual(len({(s['group'], s['pot']) for s in draw['steps']}), 10)
        for group in draw['groups']:
            self.assertEqual(len([m for m in group['members'] if m['pot'] == 1]), 1)
        self.action('confirm')
        self.err('POST', f'/api/plans/{plain}/generate', expect=409, code='draw_groups_changed')

    def test_roster_change_invalidates_confirmation_and_old_start_preview(self):
        old = self.ok('GET', self.path)
        self.ok('PUT', f"/api/participations/{self.fx['team_parts'][0]}", {'seed_no': 101})
        self.err('POST', self.path, {'method': 'random', 'capacities': [4, 3, 3],
                 'roster_hash': old['roster_hash'], 'request_uid': str(uuid.uuid4())}, expect=409, code='draw_roster_changed')
        self.start()
        self.ok('PUT', f"/api/participations/{self.fx['team_parts'][1]}", {'seed_no': 102})
        self.assertTrue(self.current()['stale'])
        self.err('POST', self.path + '/complete', self.action_body(), expect=409, code='draw_roster_changed')
        self.err('POST', self.path + '/cancel', self.action_body(reason=''))
        self.action('cancel', reason='报名名单调整')
        self.assertFalse(self.start()['stale'])

    def test_roles_individual_category_and_other_category_draw_reference(self):
        organizer = self.make_user('organizer')
        recorder = self.make_user('recorder')
        viewer = self.make_user('viewer')
        self.ok('GET', self.path, token=organizer)
        for token in (recorder, viewer):
            self.err('GET', self.path, token=token, expect=403)
            self.err('POST', self.path, {'request_uid': str(uuid.uuid4())}, token=token, expect=403)
        self.err('GET', f"/api/categories/{self.fx['indiv_cat']}/group-draw")
        draw = self.start(); self.action('complete'); self.action('confirm')
        other_cat = next(c['id'] for c in self.fx['groups']['乙']['categories'] if c['kind'] == 'team' and c['gender'] == 'male')
        self.err('POST', f'/api/categories/{other_cat}/plan', {'stages': [
            {'kind': 'round_robin', 'params': {'pool_count': 3, 'draw_id': draw['id']}}]}, expect=409, code='draw_not_confirmed')

    def test_locked_preview_cannot_bypass_a_new_draw(self):
        plain = self.ok('POST', f"/api/categories/{self.fx['team_cat']}/plan", {'stages': [
            {'kind': 'round_robin', 'params': {'pool_count': 3}}]})['plan_id']
        self.ok('POST', f'/api/plans/{plain}/generate')
        self.start()
        self.err('POST', f'/api/plans/{plain}/lock', expect=409, code='draw_not_confirmed')
        self.action('complete'); self.action('confirm')
        self.err('POST', f'/api/plans/{plain}/lock', expect=409, code='draw_groups_changed')

    def test_existing_event_upgrade_preserves_registration_and_plan(self):
        category_path = f"/api/categories/{self.fx['team_cat']}"
        plan_id = self.ok('POST', category_path + '/plan', {'name': '旧库方案', 'stages': [
            {'kind': 'round_robin', 'params': {'pool_count': 2}}]})['plan_id']
        before = self.ok('GET', category_path + '/participations')
        event_path = db.event_db_path(self.fx['event_id'])
        conn = db.connect(event_path)
        try:
            conn.execute('DROP TABLE group_draws')
        finally:
            conn.close()
        db.init_db(event_path)
        self.assertEqual(self.ok('GET', category_path + '/participations'), before)
        plan = self.ok('GET', category_path + '/plan')['plan']
        self.assertEqual((plan['id'], plan['name']), (plan_id, '旧库方案'))
        self.assertIsNone(self.current())
        self.assertEqual(self.start()['total'], 10)

    def test_finished_match_prevents_redraw_even_after_admin_unlock(self):
        draw = self.start(); self.action('complete'); self.action('confirm')
        plan_id = self.plan(draw['id'])
        self.ok('POST', f'/api/plans/{plan_id}/generate')
        self.ok('POST', f'/api/plans/{plan_id}/lock')
        stage = self.ok('GET', f'/api/plans/{plan_id}')['plan']['stages'][0]
        match = next(m for m in stage['matches'] if m['status'] == 'ready')
        lineup = self.lineup_for(match['id'])
        lineup['event_identity'] = dict(self.event_identity)
        self.play(match['id'], [(15, 3), (15, 4)], lineup=lineup)
        self.ok('POST', f'/api/plans/{plan_id}/unlock', {'force': True, 'reason': '核对已完成比赛'})
        self.err('POST', self.path + '/cancel', self.action_body(reason='重抽'), expect=409, code='has_results')
        self.err('POST', self.path, {'request_uid': str(uuid.uuid4())}, expect=409, code='has_results')
        self.assertEqual(self.current()['status'], 'confirmed')
        self.assertEqual(self.ok('GET', self.path)['blocked_reason'], '已有比赛成绩，不能改变抽签分组')


if __name__ == '__main__': unittest.main()

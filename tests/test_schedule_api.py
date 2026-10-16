"""Real HTTP stage lifecycle and played group/knockout/placement tournaments."""
import itertools
import tempfile
from pathlib import Path
import unittest
import uuid

import test_api
from app import config, db


class ScheduleApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        task_tmp = Path(tempfile.mkdtemp(prefix='stss_schedule_'))
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = task_tmp, task_tmp / 'registry.db', task_tmp / 'events'
        test_api.ApiTest.setUpClass.__func__(cls)
    tearDownClass = classmethod(test_api.ApiTest.tearDownClass.__func__)
    request = test_api.ApiTest.request
    ok = test_api.ApiTest.ok
    err = test_api.ApiTest.err
    login = test_api.ApiTest.login
    make_user = test_api.ApiTest.make_user
    build_event = test_api.ApiTest.build_event
    events_for = test_api.ApiTest.events_for
    play = test_api.ApiTest.play
    lineup_for = test_api.ApiTest.lineup_for

    def setUp(self):
        test_api.ApiTest.setUp(self)
        self.use_event_database = True

    def packet(self, **values):
        return {'request_uid': str(uuid.uuid4()), 'event_identity': self.event_identity, **values}

    def draft(self, definition):
        return self.ok('POST', f"/api/categories/{self.fx['team_cat']}/schedule/stages",
                       self.packet(base_revision=0, definition=definition))

    def preview(self, stage_id, revision=1):
        return self.ok('POST', f'/api/schedule-stages/{stage_id}/preview', self.packet(base_revision=revision))

    def confirm(self, stage_id, revision=1):
        preview = self.preview(stage_id, revision)
        body = self.packet(base_revision=revision, definition_hash=preview['definition_hash'],
                           basis_hash=preview['basis_hash'], approved_byes=preview['graph']['byes'])
        result = self.ok('POST', f'/api/schedule-stages/{stage_id}/confirm', body)
        self.assertTrue(self.ok('POST', f'/api/schedule-stages/{stage_id}/confirm', body)['replayed'])
        return result

    def plan(self):
        return self.ok('GET', f"/api/categories/{self.fx['team_cat']}/plan")['plan']

    def setup_groups(self, count=2, size=4, fixtures=False):
        self.fx = self.build_event(count * size, 0)
        cat = self.fx['team_cat']
        roster = self.ok('GET', f'/api/categories/{cat}/group-draw')
        draw = self.ok('POST', f'/api/categories/{cat}/group-draw', self.packet(
            capacities=[size] * count, method='seeded', roster_hash=roster['roster_hash']))['draw']
        for action in ('complete', 'confirm'):
            draw = self.ok('POST', f'/api/categories/{cat}/group-draw/{action}', self.packet(draw_id=draw['id'], base_rev=draw['rev']))['draw']
        stage = self.draft({'purpose': 'group', 'name': '小组赛', 'draw_id': draw['id']})
        preview = self.preview(stage['stage_id'])
        self.assertEqual(preview['graph']['matches'], [])
        self.confirm(stage['stage_id'])
        self.group_stage = self.plan()['stages'][0]
        self.pools = self.group_stage['pools']
        self.assertEqual(len(self.pools), count)
        self.assertEqual(self.group_stage['matches'], [])
        if fixtures:
            for pool in self.pools:
                ids = [m['participation_id'] for m in pool['members']]
                for a, b in itertools.combinations(ids, 2):
                    self.ok('POST', '/api/matches', {'category_id': cat, 'stage_id': stage['stage_id'],
                        'pool_id': pool['id'], 'home_participation': a, 'away_participation': b,
                        'round_label': pool['name'] + '小组赛'})
        return stage['stage_id']

    def finish_groups(self):
        for match in self.plan()['stages'][0]['matches']:
            self.play(match['id'], [(15, 5), (15, 6)])
        for pool in self.pools:
            self.ok('POST', f"/api/pools/{pool['id']}/confirm", {})

    def finish_stage(self, stage_id):
        while True:
            stage = next(s for s in self.plan()['stages'] if s['id'] == stage_id)
            pending = [m for m in stage['matches'] if m['status'] != 'finished']
            if not pending:
                return stage
            ready = [m for m in pending if m['can_score']]
            self.assertTrue(ready, pending)
            for match in ready:
                self.play(match['id'], [(15, 8), (15, 7)])

    def test_played_two_and_four_group_knockout_and_every_custom_placement(self):
        for count, start in ((2, 5), (4, 5), (4, 9)):
            self.event_headers = {}
            self.setup_groups(count, fixtures=True)
            ids = [p['id'] for p in self.pools]
            knockout = self.draft({'purpose': 'knockout', 'name': '淘汰赛', 'pool_ids': ids})
            third = self.draft({'purpose': 'placement', 'name': '第三名名次赛', 'pool_ids': ids,
                                'source_rank': 3, 'rank_from': start, 'rank_to': start + count - 1})
            fourth = self.draft({'purpose': 'placement', 'name': '第四名名次赛', 'pool_ids': ids,
                                 'source_rank': 4, 'rank_from': start + count, 'rank_to': start + 2 * count - 1})
            for stage in (knockout, third, fourth):
                self.confirm(stage['stage_id'])
                saved = next(s for s in self.plan()['stages'] if s['id'] == stage['stage_id'])
                self.assertTrue(all(m['status'] == 'pending' for m in saved['matches']))
                self.assertTrue(all(m['status'] != 'void' for m in saved['matches']))
            first = next(s for s in self.plan()['stages'] if s['id'] == knockout['stage_id'])['matches']
            pairs = [(m['home']['source_pool_id'], m['away']['source_pool_id'], m['home']['source_rank'])
                     for m in first if m['round_no'] == 1]
            self.assertEqual(pairs, [(ids[i], ids[i+1], rank) for rank in (1, 2) for i in range(0, count, 2)])
            self.finish_groups()
            for stage in (knockout, third, fourth):
                self.finish_stage(stage['stage_id'])
            derived = self.ok('POST', f"/api/categories/{self.fx['team_cat']}/placements/auto", {'confirm': True})
            ranks = [p['rank_no'] for p in derived['placements']]
            self.assertEqual(sorted(ranks), list(range(1, 5)) + list(range(start, start + 2 * count)))
            self.assertEqual(len({p['participation_id'] for p in derived['placements']}), len(ranks))
            self.assertEqual(len(set(ranks)), len(ranks))
            self.assertTrue(self.ok('GET', f"/api/categories/{self.fx['team_cat']}/schedule")['plan']['stages'][0]['pools'])
            final = next(m for s in self.plan()['stages'] for m in s['matches'] if m['schedule_role'] == 'final')
            self.ok('POST', f"/api/matches/{final['id']}/correction", {'reason': '裁判复核', 'result_status': 'home_forfeit', 'sets': [], 'events': []})
            ranks_after = self.ok('GET', f"/api/categories/{self.fx['team_cat']}/placements")['placements']
            winner_after = next(p for p in ranks_after if p['rank_no'] == 1)
            self.assertEqual(winner_after['participation_id'], final['away']['participation_id'])
            self.assertEqual(winner_after['points'], 18)

    def test_range_conflicts_sources_and_split_adjacent_group_stages(self):
        self.setup_groups(4)
        ids = [p['id'] for p in self.pools]
        self.draft({'purpose': 'knockout', 'name': '前四名', 'pool_ids': ids})
        path = f"/api/categories/{self.fx['team_cat']}/schedule/stages"
        def rejected(definition, code=None, expect=400):
            self.err('POST', path, self.packet(base_revision=0, definition=definition), expect=expect, code=code)
        rejected({'purpose': 'placement', 'name': '重叠', 'pool_ids': ids, 'source_rank': 3, 'rank_from': 3, 'rank_to': 6}, 'rank_overlap', 409)
        rejected({'purpose': 'knockout', 'name': '缺组', 'pool_ids': ids[:2]})
        rejected({'purpose': 'placement', 'name': '跨组', 'pool_ids': ids[::2], 'source_rank': 3, 'rank_from': 5, 'rank_to': 6})
        rejected({'purpose': 'placement', 'name': '数量不符', 'pool_ids': ids, 'source_rank': 3, 'rank_from': 5, 'rank_to': 10})
        self.draft({'purpose': 'placement', 'name': 'A/B第五六名', 'pool_ids': ids[:2], 'source_rank': 3, 'rank_from': 5, 'rank_to': 6})
        self.draft({'purpose': 'placement', 'name': 'C/D第七八名', 'pool_ids': ids[2:], 'source_rank': 3, 'rank_from': 7, 'rank_to': 8})
        rejected({'purpose': 'placement', 'name': '重复来源', 'pool_ids': ids[:2], 'source_rank': 3, 'rank_from': 9, 'rank_to': 10}, 'source_overlap', 409)

    def test_preview_identity_revision_idempotency_and_explicit_byes(self):
        self.setup_groups(3)
        ids = [p['id'] for p in self.pools]
        stage = self.draft({'purpose': 'knockout', 'name': '六队前四名', 'pool_ids': ids})
        sid = stage['stage_id']
        preview = self.preview(sid)
        self.assertTrue(preview['graph']['byes'])
        path = f'/api/schedule-stages/{sid}/confirm'
        body = self.packet(base_revision=1, definition_hash=preview['definition_hash'], basis_hash=preview['basis_hash'])
        self.err('POST', path, body, code='byes_not_confirmed')
        self.err('POST', path, {**body, 'event_identity': {}}, expect=409, code='event_identity_mismatch')
        self.err('POST', path, {**body, 'base_revision': 0}, expect=409, code='stale_revision')
        self.err('POST', path, {**body, 'basis_hash': 'stale'}, expect=409, code='preview_changed')
        body['approved_byes'] = preview['graph']['byes']
        result = self.ok('POST', path, body)
        self.assertTrue(self.ok('POST', path, body)['replayed'])
        self.err('POST', path, {**body, 'base_revision': 2}, expect=409, code='request_uid_reused')
        self.assertEqual(len(next(s for s in self.plan()['stages'] if s['id'] == sid)['matches']), len(result['match_ids']))

    def test_retract_dependencies_started_matches_and_group_membership(self):
        group = self.setup_groups(2, fixtures=True)
        ids = [p['id'] for p in self.pools]
        stage = self.draft({'purpose': 'knockout', 'name': '淘汰赛', 'pool_ids': ids})
        self.err('POST', f'/api/schedule-stages/{group}/unconfirm', self.packet(base_revision=2, reason='调整'), expect=409, code='has_dependents')
        delete = self.packet(category_id=self.fx['team_cat'], base_revision=1)
        self.ok('DELETE', f"/api/schedule-stages/{stage['stage_id']}", delete)
        self.assertTrue(self.ok('DELETE', f"/api/schedule-stages/{stage['stage_id']}", delete)['replayed'])
        wrong = {'category_id': self.fx['team_cat'], 'stage_id': group, 'pool_id': ids[0],
                 'home_participation': self.pools[0]['members'][0]['participation_id'],
                 'away_participation': self.pools[1]['members'][0]['participation_id']}
        self.err('POST', '/api/matches', wrong)
        match = self.plan()['stages'][0]['matches'][0]
        self.ok('POST', f"/api/recording/match/{match['id']}/claim", {})
        self.err('POST', f'/api/schedule-stages/{group}/unconfirm', self.packet(base_revision=2, reason='调整'), expect=409, code='stage_started')
        self.err('DELETE', f"/api/matches/{match['id']}", {}, expect=409, code='match_started')

    def test_eight_group_pairing_and_independent_schedule_revision(self):
        self.setup_groups(8, 2, fixtures=True)
        ids = [p['id'] for p in self.pools]
        stage = self.draft({'purpose': 'knockout', 'name': '十六队淘汰赛', 'pool_ids': ids})
        self.confirm(stage['stage_id'])
        matches = next(s for s in self.plan()['stages'] if s['id'] == stage['stage_id'])['matches']
        self.assertEqual([(m['home']['source_pool_id'], m['away']['source_pool_id'], m['home']['source_rank'])
                          for m in matches if m['round_no'] == 1], [(ids[i], ids[i+1], r) for r in (1,2) for i in range(0,8,2)])
        match = self.plan()['stages'][0]['matches'][0]
        body = self.packet(base_schedule_revision=match['schedule_revision'], note='场地安排版本1')
        saved = self.ok('PUT', f"/api/matches/{match['id']}", body)['match']
        self.assertEqual(saved['schedule_revision'], match['schedule_revision'] + 1)
        self.assertEqual(saved['public_code'], match['public_code'])
        self.assertTrue(self.ok('PUT', f"/api/matches/{match['id']}", body)['replayed'])
        self.err('PUT', f"/api/matches/{match['id']}", self.packet(base_schedule_revision=match['schedule_revision'], note='并发旧版本'), expect=409, code='stale_revision')
        self.finish_groups()
        self.finish_stage(stage['stage_id'])
        derived = self.ok('POST', f"/api/categories/{self.fx['team_cat']}/placements/auto", {'confirm': True})
        self.assertEqual(sorted(p['rank_no'] for p in derived['placements']), [1,2,3,4])

    def test_retired_all_old_write_routes_and_roles(self):
        self.setup_groups(2)
        plan = self.plan()
        routes = [('POST', f"/api/categories/{self.fx['team_cat']}/plan"),
                  ('PUT', f"/api/plans/{plan['id']}/stages"),
                  *[('POST', f"/api/plans/{plan['id']}/{a}") for a in ('generate', 'lock', 'unlock')],
                  ('PUT', f"/api/pools/{self.pools[0]['id']}"), ('PUT', f"/api/pools/{self.pools[0]['id']}/members"),
                  ('POST', f"/api/stages/{self.group_stage['id']}/next-round")]
        for method, path in routes:
            self.err(method, path, {}, expect=410, code='planner_retired')
        stage = self.draft({'purpose': 'knockout', 'name': '淘汰赛', 'pool_ids': [p['id'] for p in self.pools]})
        organizer = self.make_user('organizer')
        viewer = self.make_user('viewer')
        recorder = self.make_user('recorder')
        self.err('POST', f"/api/schedule-stages/{stage['stage_id']}/confirm", self.packet(base_revision=1), token=organizer, expect=403)
        for token in (viewer, recorder):
            self.err('POST', f"/api/categories/{self.fx['team_cat']}/schedule/stages", self.packet(base_revision=0), token=token, expect=403)
        viewed = self.ok('GET', f"/api/categories/{self.fx['team_cat']}/schedule", token=viewer)
        self.assertEqual(len(viewed['plan']['stages']), 1)
        self.assertNotIn('available_formats', viewed)


if __name__ == '__main__': unittest.main()


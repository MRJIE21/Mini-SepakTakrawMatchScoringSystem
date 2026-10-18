"""成绩更正后人工项目名次必须退出正式口径，并可一键按小组名次重生成。"""
import json
import tempfile
import unittest
from pathlib import Path

import test_api
from app import config, db


class PlacementCascadeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        task = Path(tempfile.mkdtemp(prefix='placement-cascade-'))
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = task, task / 'registry.db', task / 'events'
        test_api.ApiTest.setUpClass.__func__(cls)

    tearDownClass = classmethod(test_api.ApiTest.tearDownClass.__func__)

    request = test_api.ApiTest.request
    ok = test_api.ApiTest.ok
    err = test_api.ApiTest.err
    login = test_api.ApiTest.login
    build_event = test_api.ApiTest.build_event
    play = test_api.ApiTest.play
    events_for = test_api.ApiTest.events_for
    lineup_for = test_api.ApiTest.lineup_for

    def setUp(self):
        test_api.ApiTest.setUp(self)
        self.use_event_database = True
        self.fx = self.build_event(team_count=2, individual_count=0)
        self.event_id = self.fx['event_id']
        self.conn = db.connect(db.event_db_path(self.event_id))
        self.addCleanup(self.conn.close)
        self.plan_id = db.insert(self.conn, 'plans', {
            'category_id': self.fx['team_cat'], 'name': '单循环', 'status': 'locked',
            'version': 1, 'params_json': json.dumps({'stages': []})})
        self.stage_id = db.insert(self.conn, 'stages', {
            'plan_id': self.plan_id, 'seq': 1, 'kind': 'round_robin', 'name': '单循环',
            'params_json': '{}'})
        self.pool_id = db.insert(self.conn, 'pools', {
            'stage_id': self.stage_id, 'name': 'A组', 'kind': 'group', 'seq': 1,
            'status': 'running', 'rank_from': 1, 'rank_to': 2})
        for seed, pid in enumerate(self.fx['team_parts'], start=1):
            db.insert(self.conn, 'pool_members', {
                'pool_id': self.pool_id, 'participation_id': pid, 'seed_no': seed})
        self.match_id = db.insert(self.conn, 'matches', {
            'category_id': self.fx['team_cat'], 'plan_id': self.plan_id, 'plan_version': 1,
            'stage_id': self.stage_id, 'pool_id': self.pool_id, 'seq': 1, 'round_no': 1,
            'round_label': '单循环', 'home_source_type': 'participation',
            'home_participation': self.fx['team_parts'][0], 'away_source_type': 'participation',
            'away_participation': self.fx['team_parts'][1], 'home_actual': self.fx['team_parts'][0],
            'away_actual': self.fx['team_parts'][1], 'status': 'ready',
            'scheduled_at': '2026-10-20 10:00'})
        self.conn.commit()
        self.play(self.match_id, [(15, 10), (15, 12)])
        self.confirm_pool()
        self.set_manual_placements()

    def confirm_pool(self):
        standings = self.ok('GET', f'/api/pools/{self.pool_id}/standings')
        return self.ok('POST', f'/api/pools/{self.pool_id}/confirm', {})

    def set_manual_placements(self):
        standings = self.ok('GET', f'/api/pools/{self.pool_id}/standings')
        self.assertEqual(len(standings['rows']), 2)
        for index, row in enumerate(standings['rows'], start=1):
            self.ok('POST', f"/api/categories/{self.fx['team_cat']}/placements", {
                'participation_id': row['participation_id'], 'rank_no': index, 'confirm': True,
                'note': '现场确认'})

    def placements(self):
        return self.ok('GET', f"/api/categories/{self.fx['team_cat']}/placements")['placements']

    def totals(self):
        group_id = self.fx['groups']['甲']['id']
        return self.ok('GET', f'/api/groups/{group_id}/school-totals')

    def test_correction_marks_manual_placements_pending_and_regenerate_restores_totals(self):
        before = self.totals()
        by_school = {row['name']: row for row in before['rows']}
        a, b = self.fx['schools'][0], self.fx['schools'][1]
        self.assertNotEqual(by_school[f'甲1校']['total'], 0)
        # 改判：客队胜
        corrected = self.ok('POST', f'/api/matches/{self.match_id}/correction', {
            'reason': '现场改判：主队第二局后弃权', 'result_status': 'normal',
            'sets': [{'set_no': 1, 'home_points': 10, 'away_points': 15, 'winner_side': 'away'},
                     {'set_no': 2, 'home_points': 12, 'away_points': 15, 'winner_side': 'away'}],
            'events': self.events_for([{'home_points': 10, 'away_points': 15},
                                       {'home_points': 12, 'away_points': 15}]),
        })
        self.assertTrue(corrected['stale_pools'], '更正后小组名次必须退回待确认')
        pending = self.placements()
        self.assertEqual([p['status'] for p in pending], ['pending', 'pending'])
        idle = self.totals()
        self.assertEqual(sum(row['total'] for row in idle['rows']), 0,
                         '待核对名次不得继续计入学校总分')
        # 重新确认小组名次后一键重生成
        self.confirm_pool()
        generated = self.ok('POST', f"/api/categories/{self.fx['team_cat']}/placements/from-pools", {})
        self.assertIn('生成', generated['message'])
        final = self.placements()
        self.assertEqual([p['status'] for p in final], ['confirmed', 'confirmed'])
        self.assertEqual([p['source'] for p in final], ['standings', 'standings'])
        restored = self.totals()
        by_school = {row['name']: row for row in restored['rows']}
        self.assertEqual(by_school[f'甲2校']['total'], 18, '改判后冠军队学校应得到集体项目双倍积分')
        self.assertEqual(by_school[f'甲1校']['total'], 14)


if __name__ == '__main__':
    unittest.main()

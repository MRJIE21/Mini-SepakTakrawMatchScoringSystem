"""P2-B REQ-006：删除类关键操作审计补齐（动作/对象/detail，不含敏感值）。"""
import json
import tempfile
import unittest
from pathlib import Path

import test_api
from app import config

SENSITIVE = ('password', 'token', 'authorization', 'secret')
ACTIONS = ('delete_athlete', 'delete_team', 'delete_venue',
           'delete_placement', 'clear_school_tiebreak')


def assert_no_sensitive(testcase, detail):
    text = json.dumps(detail, ensure_ascii=False).lower()
    for word in SENSITIVE:
        testcase.assertNotIn(word, text, f'审计 detail 含敏感字样 {word}: {detail}')


class P2BAuditTest(unittest.TestCase):
    fixture_schedule = test_api.fixture_schedule

    @classmethod
    def setUpClass(cls):
        task = Path(tempfile.mkdtemp(prefix='p2b-audit-'))
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = task, task / 'registry.db', task / 'events'
        test_api.ApiTest.setUpClass.__func__(cls)

    tearDownClass = classmethod(test_api.ApiTest.tearDownClass.__func__)

    request = test_api.ApiTest.request
    ok = test_api.ApiTest.ok
    err = test_api.ApiTest.err
    login = test_api.ApiTest.login
    build_event = test_api.ApiTest.build_event

    def setUp(self):
        test_api.ApiTest.setUp(self)
        self.use_event_database = True

    # ------------------------------------------------------------ 工具
    def audits(self, action, entity_type=None):
        query = f'/api/audit-logs?action={action}'
        if entity_type:
            query += f'&entity_type={entity_type}'
        return self.ok('GET', query)['logs']

    def single_audit(self, action, entity_type, entity_id):
        rows = [row for row in self.audits(action, entity_type) if row['entity_id'] == entity_id]
        self.assertEqual(len(rows), 1, rows)
        self.assertEqual(rows[0]['action'], action)
        detail = json.loads(rows[0]['detail_json'])
        assert_no_sensitive(self, detail)
        return detail

    def new_school(self, fx, name):
        return self.ok('POST', f"/api/events/{fx['event_id']}/schools",
                       {'name': name, 'group_id': fx['groups']['甲']['id']})['school_id']

    # ------------------------------------------------------------ 生成各删除动作
    def run_delete_athlete(self):
        fx = self.build_event(team_count=0, individual_count=0)
        school_id = self.new_school(fx, '审计运动员学校')
        athlete = self.ok('POST', f'/api/schools/{school_id}/athletes',
                          {'name': '待删除审计运动员', 'gender': 'male'})
        self.ok('DELETE', f"/api/athletes/{athlete['athlete_id']}")
        return athlete['athlete_id'], {'school_id': school_id, 'name': '待删除审计运动员'}

    def run_delete_team(self):
        fx = self.build_event(team_count=0, individual_count=0)
        school_name = '审计项目名单学校'
        school_id = self.new_school(fx, school_name)
        team = self.ok('POST', f"/api/categories/{fx['team_cat']}/teams",
                       {'school_id': school_id, 'name': '待删除审计项目名单'})
        self.ok('DELETE', f"/api/teams/{team['team_id']}")
        # 项目名单名称取自学校简称/名称，而不是请求里的 name 字段。
        return team['team_id'], {'category_id': fx['team_cat'], 'school_id': school_id,
                                 'name': school_name}

    def run_delete_venue(self):
        fx = self.build_event(team_count=2, individual_count=0)
        venue = self.ok('POST', f"/api/events/{fx['event_id']}/venues", {'name': '审计删除场地'})
        self.ok('DELETE', f"/api/venues/{venue['venue_id']}")
        return venue['venue_id'], {'event_id': fx['event_id'], 'affected_matches': 0}

    def run_delete_placement(self):
        fx = self.build_event(team_count=2, individual_count=0)
        placement = self.ok('POST', f"/api/categories/{fx['team_cat']}/placements", {
            'participation_id': fx['team_parts'][0], 'rank_no': 1, 'confirm': True})
        self.ok('DELETE', f"/api/placements/{placement['placement_id']}")
        return placement['placement_id'], {'category_id': fx['team_cat'],
                                           'participation_id': fx['team_parts'][0],
                                           'rank_no': 1, 'status': 'confirmed',
                                           'source': 'manual'}

    def run_clear_tiebreak(self):
        fx = self.build_event(team_count=2, individual_count=0)
        group_id = fx['groups']['甲']['id']
        self.ok('POST', f'/api/groups/{group_id}/school-tiebreak',
                {'school_ids': fx['schools'][:2], 'note': '审计验证'})
        self.ok('DELETE', f'/api/groups/{group_id}/school-tiebreak')
        return group_id, {'removed': 2}

    # ------------------------------------------------------------ 逐项审计
    def test_delete_athlete_is_audited(self):
        athlete_id, expected = self.run_delete_athlete()
        detail = self.single_audit('delete_athlete', 'athlete', athlete_id)
        self.assertEqual(detail, expected)
        before = len(self.audits('delete_athlete', 'athlete'))
        self.err('DELETE', f'/api/athletes/{athlete_id}', {}, expect=404)
        self.assertEqual(len(self.audits('delete_athlete', 'athlete')), before,
                         '删除失败不得写删除成功审计')

    def test_delete_team_is_audited(self):
        team_id, expected = self.run_delete_team()
        self.assertEqual(self.single_audit('delete_team', 'team', team_id), expected)

    def test_delete_venue_is_audited_with_affected_matches(self):
        venue_id, expected = self.run_delete_venue()
        self.assertEqual(self.single_audit('delete_venue', 'venue', venue_id), expected)

    def test_delete_placement_is_audited(self):
        placement_id, expected = self.run_delete_placement()
        self.assertEqual(self.single_audit('delete_placement', 'placement', placement_id), expected)

    def test_clear_school_tiebreak_is_audited(self):
        group_id, expected = self.run_clear_tiebreak()
        self.assertEqual(self.single_audit('clear_school_tiebreak', 'group', group_id), expected)

    def test_z_audit_rows_are_queryable_and_have_no_sensitive_detail(self):
        """所有新增动作都能按 action 在同一赛事审计接口查到，且 detail 不含口令/令牌。"""
        fx = self.build_event(team_count=0, individual_count=0)
        group_id = fx['groups']['甲']['id']
        # 运动员：新建学校+运动员后删除（未进名单）。
        athlete_school = self.new_school(fx, '查询审计运动员学校')
        athlete = self.ok('POST', f'/api/schools/{athlete_school}/athletes',
                          {'name': '查询审计运动员', 'gender': 'male'})
        self.ok('DELETE', f"/api/athletes/{athlete['athlete_id']}")
        # 队伍：新建学校+项目名单后删除（未进参赛名单）。
        team_school = self.new_school(fx, '查询审计项目名单学校')
        team = self.ok('POST', f"/api/categories/{fx['team_cat']}/teams",
                       {'school_id': team_school, 'name': '查询审计项目名单'})
        self.ok('DELETE', f"/api/teams/{team['team_id']}")
        # 场地：新建后删除。
        venue = self.ok('POST', f"/api/events/{fx['event_id']}/venues", {'name': '查询审计场地'})
        self.ok('DELETE', f"/api/venues/{venue['venue_id']}")
        # 名次：新建学校+名单+参赛记录后录入并删除名次。
        placement_school = self.new_school(fx, '查询审计名次学校')
        placement_team = self.ok('POST', f"/api/categories/{fx['team_cat']}/teams",
                                 {'school_id': placement_school, 'name': '查询审计名次名单'})
        part = self.ok('POST', f"/api/categories/{fx['team_cat']}/participations",
                       {'team_id': placement_team['team_id']})
        placement = self.ok('POST', f"/api/categories/{fx['team_cat']}/placements", {
            'participation_id': part['participation_id'], 'rank_no': 1, 'confirm': True})
        self.ok('DELETE', f"/api/placements/{placement['placement_id']}")
        # 现场确认结果：录入后清除。
        self.ok('POST', f'/api/groups/{group_id}/school-tiebreak',
                {'school_ids': [athlete_school, team_school], 'note': '查询审计'})
        self.ok('DELETE', f'/api/groups/{group_id}/school-tiebreak')
        rows = self.ok('GET', '/api/audit-logs?limit=200')['logs']
        seen = {row['action'] for row in rows}
        for action in ACTIONS:
            self.assertIn(action, seen, f'审计页应可查询到 {action}')
        for row in rows:
            assert_no_sensitive(self, json.loads(row['detail_json']))


if __name__ == '__main__':
    unittest.main(verbosity=2)

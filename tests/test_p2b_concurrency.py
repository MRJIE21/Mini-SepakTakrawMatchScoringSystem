"""P2-B REQ-010：场地删除版本递增/影响统计与批量排场并发保护（隔离 HTTP+SQLite）。"""
import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import test_api
from app import config

SENSITIVE = ('password', 'token', 'authorization', 'secret')


def assert_no_sensitive(testcase, detail):
    text = json.dumps(detail, ensure_ascii=False).lower()
    for word in SENSITIVE:
        testcase.assertNotIn(word, text, f'审计 detail 含敏感字样 {word}: {detail}')


class P2BConcurrencyTest(unittest.TestCase):
    fixture_schedule = test_api.fixture_schedule

    @classmethod
    def setUpClass(cls):
        task = Path(tempfile.mkdtemp(prefix='p2b-concurrency-'))
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = task, task / 'registry.db', task / 'events'
        test_api.ApiTest.setUpClass.__func__(cls)

    tearDownClass = classmethod(test_api.ApiTest.tearDownClass.__func__)

    request = test_api.ApiTest.request
    ok = test_api.ApiTest.ok
    err = test_api.ApiTest.err
    login = test_api.ApiTest.login
    build_event = test_api.ApiTest.build_event
    build_plan = test_api.ApiTest.build_plan
    match_list = test_api.ApiTest.match_list

    def setUp(self):
        test_api.ApiTest.setUp(self)
        self.use_event_database = True

    # ------------------------------------------------------------ 工具
    def setup_matches(self):
        fx = self.build_event(team_count=6, individual_count=0)
        self.build_plan(fx)
        matches = self.match_list(category_id=fx['team_cat'])
        self.assertGreaterEqual(len(matches), 2)
        return fx, matches

    def create_venue(self, fx, name='并发验证场地'):
        return self.ok('POST', f"/api/events/{fx['event_id']}/venues",
                       {'name': name})['venue_id']

    def matches_by_id(self, fx):
        return {match['id']: match for match in self.match_list(category_id=fx['team_cat'])}

    def audits(self, action, event_type=None):
        query = f'/api/audit-logs?action={action}'
        if event_type:
            query += f'&entity_type={event_type}'
        return self.ok('GET', query)['logs']

    # ------------------------------------------------------------ 删除场地
    def test_delete_venue_bumps_versions_reports_affected_and_audits(self):
        fx, matches = self.setup_matches()
        first, second = matches[0], matches[1]
        untouched = matches[2]
        venue_id = self.create_venue(fx)
        assigned = []
        for match in (first, second):
            saved = self.ok('PUT', f"/api/matches/{match['id']}", {
                'venue_id': venue_id,
                'base_schedule_revision': match['schedule_revision']})['match']
            self.assertEqual(saved['schedule_revision'], match['schedule_revision'] + 1)
            assigned.append((match['id'], match['schedule_revision']))

        untouched_before = self.matches_by_id(fx)[untouched['id']]['schedule_revision']
        deleted = self.ok('DELETE', f'/api/venues/{venue_id}')
        self.assertEqual(deleted['message'], '已删除')
        self.assertEqual(deleted['affected_matches'], 2)

        fresh = self.matches_by_id(fx)
        for match_id, base_revision in assigned:
            self.assertIsNone(fresh[match_id]['venue_id'], '引用该场地的场次应变为未安排')
            self.assertEqual(fresh[match_id]['schedule_revision'], base_revision + 2,
                             '删除场地必须递增受影响场次的 schedule_revision')
            self.assertNotEqual(fresh[match_id]['venue_name'], '并发验证场地')
        self.assertEqual(fresh[untouched['id']]['schedule_revision'], untouched_before,
                         '未引用该场地的比赛版本不得变化')

        # 旧 base 的单场保存（模拟另一客户端已打开旧数据）必须 409，且不写入。
        parsed = self.err('PUT', f"/api/matches/{assigned[0][0]}", {
            'venue_id': venue_id, 'base_schedule_revision': assigned[0][1],
        }, expect=409, code='stale_revision')
        self.assertIn('刷新', parsed['message'])
        self.assertIsNone(self.matches_by_id(fx)[assigned[0][0]]['venue_id'])

        logs = [row for row in self.audits('delete_venue', 'venue')
                if row['entity_id'] == venue_id]
        self.assertEqual(len(logs), 1, logs)
        detail = json.loads(logs[0]['detail_json'])
        self.assertEqual(detail['affected_matches'], 2)
        self.assertEqual(detail['event_id'], fx['event_id'])
        assert_no_sensitive(self, detail)

    def test_concurrent_venue_delete_has_one_winner_and_one_audit(self):
        fx, matches = self.setup_matches()
        venue_id = self.create_venue(fx, '并发双删场地')
        self.ok('PUT', f"/api/matches/{matches[0]['id']}", {
            'venue_id': venue_id, 'base_schedule_revision': matches[0]['schedule_revision']})
        before = len(self.audits('delete_venue', 'venue'))

        def send(_):
            return self.request('DELETE', f'/api/venues/{venue_id}', raw=True)

        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(send, range(2)))
        statuses = sorted(status for status, _ in results)
        self.assertEqual(statuses, [200, 404], results)
        self.assertEqual(len(self.audits('delete_venue', 'venue')) - before, 1,
                         '只有真正删除成功的一次写审计')

    # ------------------------------------------------------------ 批量排场版本
    def test_bulk_schedule_with_base_versions_writes_and_audits(self):
        fx, matches = self.setup_matches()
        venue_id = self.create_venue(fx)
        targets = [matches[0], matches[1]]
        ids = [match['id'] for match in targets]
        revisions = {str(match['id']): match['schedule_revision'] for match in targets}
        self.ok('POST', '/api/matches/bulk-schedule', {
            'match_ids': ids, 'venue_id': venue_id, 'start_at': '2026-10-20 09:00',
            'interval_minutes': 30, 'base_schedule_revisions': revisions})
        fresh = self.matches_by_id(fx)
        self.assertEqual(fresh[ids[0]]['venue_id'], venue_id)
        self.assertEqual(fresh[ids[0]]['scheduled_at'], '2026-10-20 09:00')
        self.assertEqual(fresh[ids[1]]['scheduled_at'], '2026-10-20 09:30')
        for match in targets:
            self.assertEqual(fresh[match['id']]['schedule_revision'],
                             match['schedule_revision'] + 1)
        logs = self.audits('bulk_schedule', 'event')
        matched = [row for row in logs if json.loads(row['detail_json']).get('matches') == ids]
        self.assertEqual(len(matched), 1, logs)
        detail = json.loads(matched[0]['detail_json'])
        self.assertEqual(detail['venue_id'], venue_id)
        self.assertEqual(detail['start_at'], '2026-10-20 09:00')
        self.assertEqual(detail['interval_minutes'], 30)
        self.assertEqual(detail['scheduled'], 2)
        self.assertEqual(matched[0]['entity_id'], fx['event_id'])
        assert_no_sensitive(self, detail)

    def test_bulk_schedule_stale_base_writes_nothing(self):
        fx, matches = self.setup_matches()
        venue_id = self.create_venue(fx)
        first, second = matches[0], matches[1]
        ids = [first['id'], second['id']]
        revisions = {str(first['id']): first['schedule_revision'],
                     str(second['id']): second['schedule_revision']}
        # 另一客户端先推进了第一场的版本。
        self.ok('PUT', f"/api/matches/{first['id']}", {
            'venue_id': None, 'base_schedule_revision': first['schedule_revision']})
        before = {match_id: (match['scheduled_at'], match['venue_id'], match['schedule_revision'])
                  for match_id, match in self.matches_by_id(fx).items()}
        parsed = self.err('POST', '/api/matches/bulk-schedule', {
            'match_ids': ids, 'venue_id': venue_id, 'start_at': '2026-10-20 10:00',
            'interval_minutes': 30, 'base_schedule_revisions': revisions,
        }, expect=409, code='stale_revision')
        self.assertEqual(parsed['detail']['match_id'], first['id'])
        self.assertEqual(parsed['detail']['current'], first['schedule_revision'] + 1)
        after = {match_id: (match['scheduled_at'], match['venue_id'], match['schedule_revision'])
                 for match_id, match in self.matches_by_id(fx).items()}
        self.assertEqual(after, before, '版本冲突时不得写入任何覆盖')
        self.assertEqual([row for row in self.audits('bulk_schedule', 'event')
                          if json.loads(row['detail_json']).get('matches') == ids], [],
                         '冲突请求不应写 bulk_schedule 审计')

    def test_bulk_schedule_without_base_versions_keeps_legacy_behavior(self):
        fx, matches = self.setup_matches()
        venue_id = self.create_venue(fx)
        ids = [matches[0]['id'], matches[1]['id']]
        before = {match_id: match['schedule_revision'] for match_id, match in self.matches_by_id(fx).items()}
        result = self.ok('POST', '/api/matches/bulk-schedule', {
            'match_ids': ids, 'venue_id': venue_id, 'start_at': '2026-10-20 11:00',
            'interval_minutes': 20})
        self.assertIn('已安排 2 场', result['message'])
        fresh = self.matches_by_id(fx)
        for match_id in ids:
            self.assertEqual(fresh[match_id]['venue_id'], venue_id)
            self.assertEqual(fresh[match_id]['schedule_revision'], before[match_id] + 1)

    def test_bulk_schedule_invalid_base_payloads_are_rejected(self):
        fx, matches = self.setup_matches()
        ids = [matches[0]['id'], matches[1]['id']]
        base = {'match_ids': ids, 'venue_id': self.create_venue(fx), 'start_at': '2026-10-20 12:00'}
        invalid_revisions = [
            [1, 2],
            {str(ids[0]): matches[0]['schedule_revision']},                       # 缺一场
            {str(ids[0]): matches[0]['schedule_revision'],
             str(ids[1]): matches[1]['schedule_revision'], '999999': 1},         # 多一场
            {str(ids[0]): 'bad', str(ids[1]): matches[1]['schedule_revision']},  # 类型错误
            {str(ids[0]): True, str(ids[1]): matches[1]['schedule_revision']},   # 布尔
        ]
        for revisions in invalid_revisions:
            self.err('POST', '/api/matches/bulk-schedule',
                     {**base, 'base_schedule_revisions': revisions},
                     expect=400, code='invalid_base_revisions')

    def test_concurrent_bulk_schedule_one_wins_and_loser_writes_nothing(self):
        fx, matches = self.setup_matches()
        venue_id = self.create_venue(fx, '并发排场场地')
        first, second = matches[0], matches[1]
        ids = [first['id'], second['id']]
        body = {'match_ids': ids, 'venue_id': venue_id, 'start_at': '2026-10-20 13:00',
                'interval_minutes': 30,
                'base_schedule_revisions': {str(first['id']): first['schedule_revision'],
                                            str(second['id']): second['schedule_revision']}}
        before_audits = len([row for row in self.audits('bulk_schedule', 'event')
                             if json.loads(row['detail_json']).get('matches') == ids])

        def send(_):
            return self.request('POST', '/api/matches/bulk-schedule', body, raw=True)

        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(send, range(2)))
        statuses = sorted(status for status, _ in results)
        self.assertEqual(statuses, [200, 409], results)
        loser_payload = json.loads([raw for status, raw in results if status == 409][0])
        self.assertEqual(loser_payload['code'], 'stale_revision')
        fresh = self.matches_by_id(fx)
        self.assertEqual(fresh[ids[0]]['venue_id'], venue_id)
        self.assertEqual(fresh[ids[0]]['scheduled_at'], '2026-10-20 13:00')
        self.assertEqual(fresh[ids[1]]['scheduled_at'], '2026-10-20 13:30')
        after_audits = len([row for row in self.audits('bulk_schedule', 'event')
                            if json.loads(row['detail_json']).get('matches') == ids])
        self.assertEqual(after_audits - before_audits, 1, '只有成功的一次写 bulk_schedule 审计')


if __name__ == '__main__':
    unittest.main(verbosity=2)

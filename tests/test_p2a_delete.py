"""P2-A REQ-010: delete-school guard exposes actionable structured reasons."""
import tempfile
import unittest
from pathlib import Path

import test_api
from app import config, db


class DeleteSchoolReasonTest(unittest.TestCase):
    fixture_schedule = test_api.fixture_schedule

    @classmethod
    def setUpClass(cls):
        task = Path(tempfile.mkdtemp(prefix='delete-reason-'))
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

    def make_event(self):
        return self.build_event(team_count=1, individual_count=0)

    def assert_reason(self, parsed, code):
        self.assertEqual(parsed['code'], 'in_use', parsed)
        reasons = parsed.get('detail', {}).get('reasons') or []
        self.assertTrue(reasons, parsed)
        self.assertEqual(reasons[0]['code'], code, reasons)
        self.assertTrue(reasons[0]['message'], reasons)
        self.assertTrue(reasons[0]['steps'], reasons)
        for step in reasons[0]['steps']:
            self.assertIsInstance(step, str)
            self.assertTrue(step.strip())

    def test_registration_only_school_reason_is_actionable(self):
        fx = self.make_event()
        school_id = fx['schools'][0]
        parsed = self.err('DELETE', f'/api/schools/{school_id}', {}, expect=409)
        self.assert_reason(parsed, 'registration_in_use')
        self.assertIn('报名', parsed['message'])
        self.assertNotIn('修改参赛记录状态', parsed['message'])

    def test_school_with_result_reports_has_results_first(self):
        fx = self.make_event()
        conn = db.get_event_conn(fx['event_id'])
        try:
            db.insert(conn, 'placements', {
                'category_id': fx['team_cat'], 'participation_id': fx['team_parts'][0],
                'rank_no': 1, 'status': 'confirmed', 'source': 'manual', 'version': 1})
            conn.commit()
        finally:
            conn.close()
        parsed = self.err('DELETE', f"/api/schools/{fx['schools'][0]}", {}, expect=409)
        self.assert_reason(parsed, 'has_results')
        self.assertIn('成绩', parsed['message'])
        combined = ' '.join(parsed['detail']['reasons'][0]['steps'])
        self.assertIn('更正', combined)
        self.assertIn('取消', combined)

    def test_locked_plan_school_reason_points_to_unlock(self):
        fx = self.make_event()
        conn = db.get_event_conn(fx['event_id'])
        try:
            db.insert(conn, 'plans', {
                'category_id': fx['team_cat'], 'name': '锁定方案', 'status': 'locked'})
            conn.commit()
        finally:
            conn.close()
        parsed = self.err('DELETE', f"/api/schools/{fx['schools'][0]}", {}, expect=409)
        self.assert_reason(parsed, 'plan_locked')
        self.assertIn('锁定', parsed['message'])
        combined = ' '.join(parsed['detail']['reasons'][0]['steps'])
        self.assertIn('撤回', combined)

    def test_unreferenced_school_still_deletes(self):
        fx = self.make_event()
        extra = self.ok('POST', f"/api/events/{fx['event_id']}/schools",
                        {'name': '未报名学校', 'group_id': fx['groups']['甲']['id']})['school_id']
        result = self.ok('DELETE', f'/api/schools/{extra}')
        self.assertEqual(result['message'], '已删除')


if __name__ == '__main__':
    unittest.main()

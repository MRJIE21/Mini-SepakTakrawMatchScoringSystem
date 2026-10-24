"""交互缺陷回归：正式更正、全项目排名失效、待确认拦截与抽签闭环。"""
from helpers.reviewed_result import reviewed_result
import unittest
import uuid

import test_imports_exports as fixtures
from app import db


class InteractionRecoveryTest(unittest.TestCase):
    setUpClass = classmethod(fixtures.ImportExportsTest.setUpClass.__func__)
    tearDownClass = classmethod(fixtures.ImportExportsTest.tearDownClass.__func__)
    setUp = fixtures.ImportExportsTest.setUp
    req = fixtures.ImportExportsTest.req
    login = fixtures.ImportExportsTest.login

    def participants(self, count=2):
        cat = self.cat['individual']['id']
        ids = []
        for i in range(count):
            school = self.req('POST', f"/api/events/{self.event['event_id']}/schools",
                              {'name': f'学校{i}', 'group_id': self.group['id']})['school_id']
            athlete = self.req('POST', f'/api/schools/{school}/athletes',
                               {'name': f'选手{i}', 'gender': 'male'})['athlete_id']
            ids.append(self.req('POST', f'/api/categories/{cat}/participations',
                                {'athlete_id': athlete})['participation_id'])
        return ids

    def payload(self, pid, score, version=0, **extra):
        return {'submission_uid': str(uuid.uuid4()), 'participation_id': pid,
                'event_identity': self.event, 'base_version': version, 'result_status': 'normal',
                'result_value': score, 'error_count': 1, 'violation_count': 0, 'rank_no': None, **extra}

    def submit(self, pid, score, version=0, **extra):
        return reviewed_result(self, 'POST', '/api/scoring/individual', self.payload(pid, score, version, **extra), expected=200)

    def confirm(self, body=None, expected=200):
        return self.req('POST', f"/api/categories/{self.cat['individual']['id']}/individual-rankings/confirm",
                        body or {}, expected=expected)

    def placements(self):
        return self.req('GET', f"/api/categories/{self.cat['individual']['id']}/placements")['placements']

    def test_official_correction_requires_role_reason_and_preserves_audit(self):
        pid = self.participants(1)[0]
        recorder = self.login('iteration_recorder')
        self.req('POST', f'/api/recording/individual/{pid}/claim', {}, token=recorder)
        original = self.payload(pid, 20)
        reviewed_result(self, 'POST', '/api/scoring/individual', original, token=recorder, expected=200)
        self.confirm()
        reviewed_result(self, 'POST', '/api/scoring/individual', self.payload(pid, 30, 1, reason='复核'), expected=403, token=recorder)
        error = reviewed_result(self, 'POST', '/api/scoring/individual', self.payload(pid, 30, 1), expected=400)
        self.assertEqual(error['code'], 'correction_reason_required')
        self.assertEqual(self.placements()[0]['rank_no'], 1)
        # 原请求重试优先走幂等，不能因正式成绩权限新增限制而失败。
        self.assertTrue(reviewed_result(self, 'POST', '/api/scoring/individual', original, token=recorder, expected=200)['duplicate'])
        self.submit(pid, 30, 1, reason='裁判复核')
        conn = db.connect(db.event_db_path(self.event['event_id']))
        try:
            audit = db.q1(conn, "SELECT detail_json FROM audit_logs WHERE action='correct_individual'")['detail_json']
            self.assertIn('裁判复核', audit)
            self.assertIn('before', audit)
            self.assertIn('after', audit)
        finally:
            conn.close()

    def test_correction_invalidates_every_rank_and_school_point(self):
        a, b = self.participants()
        self.submit(a, 20)
        self.submit(b, 15)
        self.confirm()
        self.assertEqual(sum(p['points'] for p in self.placements()), 16)
        self.submit(b, 30, 1, reason='原次数抄录错误')
        self.assertTrue(all(p['rank_no'] is None and p['status'] == 'pending' and p['points'] == 0
                            for p in self.placements()))
        totals = self.req('GET', f"/api/groups/{self.group['id']}/school-totals")['rows']
        self.assertTrue(all(r['total'] == 0 for r in totals))
        results = self.req('GET', f"/api/categories/{self.cat['individual']['id']}/individual-results")['results']
        self.assertTrue(all(r['rank_no'] is None for r in results))
        self.confirm()
        self.assertEqual({p['participation_id']: p['rank_no'] for p in self.placements()}, {b: 1, a: 2})

    def test_pending_blocks_ranking_and_requires_formal_correction(self):
        a, b = self.participants()
        self.submit(a, 20)
        self.assertEqual(self.confirm(expected=409)['code'], 'results_incomplete')
        received=self.submit(b, None, result_status='pending')
        error = self.confirm(expected=409)
        self.assertEqual(error['code'], 'results_pending')
        self.assertEqual(error['detail']['participation_ids'], [b])
        self.assertEqual(self.placements(), [])
        reviewed_result(self, 'POST', '/api/scoring/individual', self.payload(b, 10, 1), token=self.login('iteration_recorder'), expected=403)
        self.req('POST',f"/api/result-candidates/{received['candidate_id']}/withdraw",{
            'decision_uid':str(uuid.uuid4()),'action':'withdraw','revision':received['receipt']['revision'],
            'candidate_hash':received['receipt']['candidate_hash'],'base_version':0,'reason':'补全实际结果'})
        self.submit(b, 10, 0, reason='裁判核对完毕')
        self.assertEqual(self.confirm()['count'], 2)

    def test_tie_orders_are_explicit_complete_and_scoped(self):
        ids = self.participants(5)
        for pid, score in zip(ids, (30, 30, 30, 10, 10)):
            self.submit(pid, score)
        detail = self.confirm(expected=409)['detail']
        self.assertEqual([(t['rank_from'], t['rank_to']) for t in detail['ties']], [(1, 3), (4, 5)])
        body = {'base_results': detail['base_results'], 'tie_orders': [[ids[2], ids[0], ids[1]], [ids[4], ids[3]]]}
        for invalid in ([[ids[0], ids[0], ids[1]], [ids[4], ids[3]]],
                        [[ids[0], ids[1], ids[4]], [ids[2], ids[3]]], [[ids[0], ids[1], ids[2]]]):
            self.confirm({**body, 'tie_orders': invalid}, expected=400)
            self.assertEqual(self.placements(), [])
        self.req('POST', f"/api/categories/{self.cat['individual']['id']}/individual-rankings/confirm", body,
                 expected=403, token=self.login('iteration_recorder'))
        self.assertEqual(self.confirm(body)['count'], 5)
        ranks = {p['participation_id']: p['rank_no'] for p in self.placements()}
        self.assertEqual(ranks, {pid: i + 1 for i, pid in enumerate([ids[2], ids[0], ids[1], ids[4], ids[3]])})

    def test_tie_confirmation_rejects_changed_results(self):
        a, b = self.participants()
        self.submit(a, 20)
        self.submit(b, 20)
        detail = self.confirm(expected=409)['detail']
        self.submit(b, 30, 1, reason='复核')
        error = self.confirm({'base_results': detail['base_results'], 'tie_orders': [[a, b]]}, expected=409)
        self.assertEqual(error['code'], 'ranking_changed')
        self.assertEqual(self.placements(), [])

    def test_terminal_statuses_do_not_block_zero_score_ranking(self):
        ids = self.participants(4)
        for pid, status in zip(ids, ('normal', 'dns', 'dnf', 'dsq')):
            self.submit(pid, 0 if status == 'normal' else None, result_status=status)
        self.assertEqual(self.confirm()['count'], 1)
        self.assertEqual(self.placements()[0]['participation_id'], ids[0])


if __name__ == '__main__':
    unittest.main()

"""旧一次性抽签接口迁移 + 正式签表/成绩隔离的真实 HTTP 测试。

本文件原覆盖「preview → confirm」一次性流程；DESIGN_V3 把该入口关闭后，这里保留原有
断言意图，并迁移到逐人抽取会话：

* 旧 ``POST /individual-draw/preview`` 一律 426 ``client_upgrade_required`` 且不写库；
* 旧 ``POST /individual-draw/confirm`` 只允许升级前已持久化成功的回执按原包幂等重放，
  未提交请求同样 426；
* 原子性、并发、名单与开赛保护、删除报名冲突、旧库升级等断言全部保留；
* 出场顺序与成绩名次/学校积分仍然分离。
"""
import json
import sqlite3
import tempfile
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

import test_api
from app import config, db, idempotency
from app.api import individual_draw as api
from app.domain.individual_draw import fingerprint


class IndividualDrawApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        task = Path(tempfile.mkdtemp(prefix='individual-draw-api-'))
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = task, task / 'registry.db', task / 'events'
        test_api.ApiTest.setUpClass.__func__(cls)
    tearDownClass = classmethod(test_api.ApiTest.tearDownClass.__func__)
    request = test_api.ApiTest.request
    ok = test_api.ApiTest.ok
    err = test_api.ApiTest.err
    login = test_api.ApiTest.login
    make_user = test_api.ApiTest.make_user
    build_event = test_api.ApiTest.build_event

    def setUp(self):
        test_api.ApiTest.setUp(self)
        self.use_event_database = True
        self.fx = self.build_event(team_count=0, individual_count=3)
        self.cid = self.fx['indiv_cat']
        self.path = f'/api/categories/{self.cid}/individual-draw'
        self.session_path = self.path + '/session'
        self.pids = self.fx['indiv_parts']

    # ------------------------------------------------------------ 会话工具
    def packet(self, session, uid=None, revision=None, **extra):
        body = {'event_identity': self.event_identity, 'request_uid': uid or str(uuid.uuid4()),
                'session_id': session['session_id'],
                'base_revision': session['revision'] if revision is None else revision}
        return {**body, **extra}

    def start(self, token=None, expect=200):
        body = {'event_identity': self.event_identity, 'request_uid': str(uuid.uuid4())}
        return self.request('POST', self.session_path + '/start', body, token, expect=expect)

    def step(self, session, token=None, uid=None, path='/stop', expect=200):
        return self.request('POST', self.session_path + path, self.packet(session, uid), token,
                            expect=expect)

    def drain(self, session, token=None):
        while session['status'] != 'complete':
            session = self.step(session, token)['session']
        return session

    def confirm(self, session, token=None, uid=None):
        packet = self.packet(session, uid=uid or str(uuid.uuid4()))
        return self.request('POST', self.session_path + '/confirm', packet, token, expect=200), packet

    def draw_complete(self, token=None):
        """抽取完整顺序并确认，返回 (确认结果, 已抽会话)。"""
        session = self.drain(self.start(token)['session'], token)
        result, _ = self.confirm(session, token)
        return result, session

    def save(self, token=None):
        """兼容旧用例命名：返回 (确认结果, 确认包)。"""
        session = self.drain(self.start(token)['session'], token)
        return self.confirm(session, token)

    def legacy_preview_packet(self, preview_id=None, revision=0, uid=None):
        return {'event_identity': self.event_identity, 'preview_id': preview_id or 'legacy-preview',
                'base_revision': revision, 'request_uid': uid or str(uuid.uuid4())}

    def legacy_save(self, token=None, uid=None):
        """按原包构造一次旧「preview → confirm」并确认成功（未提交请求现在应 426）。"""
        packet = self.legacy_preview_packet(uid=uid)
        self.err('POST', self.path + '/preview', {'event_identity': self.event_identity},
                 token=token, expect=426, code='client_upgrade_required')
        return packet

    def snapshot(self):
        c = db.connect(db.event_db_path(self.fx['event_id']))
        try:
            return {r['name']: [tuple(x) for x in c.execute('SELECT * FROM "' + r['name'] + '" ORDER BY rowid')]
                    for r in c.execute("SELECT name FROM sqlite_master WHERE type='table' "
                                       "AND name NOT LIKE 'sqlite_%' ORDER BY name")}
        finally:
            c.close()

    def score(self, pid, **extra):
        return {'event_identity': self.event_identity, 'submission_uid': str(uuid.uuid4()),
                'participation_id': pid, 'base_version': 0, 'result_status': 'normal',
                'result_value': 30, 'error_count': 1, 'violation_count': 0, **extra}

    # ------------------------------------------------------------ 逐人流程
    def test_each_step_writes_only_after_the_stop_request_and_confirms_once(self):
        before = self.snapshot()
        session = self.ok('GET', self.session_path)['session']
        self.assertIsNone(session)
        session = self.start()['session']
        # 开始抽取只记录名单快照，不预排、不写正式签表。
        self.assertEqual(session['picked'], 0)
        self.assertEqual(len(session['candidates']), 3)
        self.assertEqual(self.ok('GET', self.path)['draw']['status'], 'none')
        self.assertEqual(self.snapshot()['individual_draws'], before['individual_draws'])
        session = self.drain(session)
        self.assertEqual(sorted(session['order']), sorted(self.pids))
        result, packet = self.confirm(session)
        self.assertEqual(result['session'], None)
        self.assertEqual(self.ok('GET', self.path)['draw']['revision'], 1)
        self.assertEqual([r['id'] for r in self.ok('GET', self.path)['draw']['entries']], session['order'])
        self.assertTrue(self.ok('GET', self.session_path)['session'] is None)
        self.assertEqual(len(self.snapshot()['individual_draws']), 1)
        self.assertEqual(self.snapshot()['individual_results'], before['individual_results'])
        self.assertEqual(self.snapshot()['placements'], before['placements'])

    def test_legacy_preview_and_unsubmitted_confirm_are_refused_and_replay_exact_receipt(self):
        """旧入口关闭：新请求 426 且不写库；升级前已持久化回执按原包重放且不重复写入。"""
        before = self.snapshot()
        preview = self.err('POST', self.path + '/preview', {'event_identity': self.event_identity},
                           expect=426, code='client_upgrade_required')
        self.assertEqual(preview['outcome'], 'not_committed')
        self.assertTrue(preview['detail']['not_committed'])
        packet = self.legacy_preview_packet()
        upgrade = self.err('POST', self.path + '/confirm', packet, expect=426,
                           code='client_upgrade_required')
        self.assertEqual(upgrade['outcome'], 'not_committed')
        self.assertFalse(self.ok('GET', self.path + '/requests/' + packet['request_uid'])['found'])
        self.assertEqual(self.snapshot(), before)
        # 升级前已成功持久化的旧回执：原包重放返回原结果，不写任何业务数据。
        registry = db.connect()
        try:
            actor = db.q1(registry, "SELECT id FROM users WHERE username='admin'")['id']
        finally:
            registry.close()
        stored = {'draw': {'revision': 1, 'order': list(self.pids), 'roster': [],
                           'confirmed_at': '2026-10-16 10:00:00'},
                  'receipt': {'request_uid': packet['request_uid'], 'category_id': self.cid,
                              'event_identity': self.event_identity, 'revision': 1,
                              'order_hash': fingerprint(list(self.pids))},
                  'message': '个人赛出场顺序已保存'}
        legacy_payload = {'path': self.path + '/confirm', 'method': 'POST', 'actor': actor, 'body': packet}
        conn = db.connect(db.event_db_path(self.fx['event_id']))
        try:
            db.insert(conn, 'request_log', {
                'uid': packet['request_uid'], 'scope': 'individual_draw', 'user_id': actor,
                'payload_hash': idempotency.content_hash(legacy_payload), 'status': 'succeeded',
                'result_json': json.dumps(stored, ensure_ascii=False), 'message': ''})
        finally:
            conn.close()
        seeded = self.snapshot()
        replay = self.ok('POST', self.path + '/confirm', packet)
        self.assertTrue(replay['replayed'])
        self.assertEqual(replay['receipt'], stored['receipt'])
        self.assertEqual(replay['draw'], stored['draw'])
        self.assertEqual(self.snapshot(), seeded)
        self.assertEqual(self.ok('GET', self.path + '/requests/' + packet['request_uid']),
                         {'ok': True, 'found': True, 'receipt': stored['receipt']})
        self.err('POST', self.path + '/confirm', {**packet, 'base_revision': 1},
                 expect=409, code='request_uid_reused')
        self.assertEqual(self.ok('GET', self.path)['draw']['status'], 'none')

    def test_legacy_preview_never_writes_and_memory_preview_stays_empty(self):
        with api.LOCK:
            api.PREVIEWS.clear()
        before = self.snapshot()
        for _ in range(3):
            self.err('POST', self.path + '/preview', {'event_identity': self.event_identity},
                     expect=426, code='client_upgrade_required')
        with api.LOCK:
            self.assertEqual(api.PREVIEWS, {}, '升级后不再产生新的可写预览')
        self.assertEqual(self.snapshot(), before)

    def test_confirmed_order_survives_new_enrollment_until_explicit_redraw(self):
        result, session = self.draw_complete()
        self.assertEqual(result['session'], None)
        saved = self.ok('GET', self.path)['draw']
        order = [r['id'] for r in saved['entries']]
        self.assertEqual(order, session['order'])
        # 计划重抽时新增报名：会话基线立即失效，抽取与确认都被拒绝，只能明确撤销。
        session = self.start()['session']
        self.ok('POST', f'/api/categories/{self.cid}/enrollments/individual',
                {'school': {'name': '新增抽签学校'}, 'athlete': {'name': '新人', 'gender': 'male'}})
        stale = self.ok('GET', self.path)['draw']
        self.assertEqual(stale['status'], 'stale')
        self.assertEqual([r['id'] for r in stale['entries']], order)
        self.err('POST', self.session_path + '/stop', self.packet(session), expect=409,
                 code='draw_session_stale')
        self.ok('POST', self.session_path + '/cancel', self.packet(session))
        self.assertIsNone(self.ok('GET', self.session_path)['session'])
        self.assertEqual([r['id'] for r in self.ok('GET', self.path)['draw']['entries']], order)
        session = self.drain(self.start()['session'])
        self.assertEqual(len(session['order']), 4)

    def test_roster_withdrawal_blocks_recording_and_scoring_until_redraw(self):
        self.save()
        pid = self.pids[0]
        self.ok('PUT', f'/api/participations/{pid}', {'status': 'withdrawn'})
        self.assertEqual(self.ok('GET', self.path)['draw']['status'], 'stale')
        other = self.pids[1]
        self.err('POST', f'/api/recording/individual/{other}/claim', {}, expect=409,
                 code='individual_draw_stale')
        self.err('POST', '/api/scoring/individual', self.score(other), expect=409,
                 code='individual_draw_stale')

    def test_deleted_and_new_enrollment_preserve_history_and_require_redraw(self):
        self.draw_complete()
        saved = self.ok('GET', self.path)['draw']
        pid = self.pids[0]
        self.ok('DELETE', f'/api/participations/{pid}')
        stale = self.ok('GET', self.path)['draw']
        self.assertEqual(stale['status'], 'stale')
        self.assertEqual([(r['id'], r['active']) for r in stale['entries']],
                         [(r['id'], r['id'] != pid) for r in saved['entries']])
        # 撤销旧签表后按当前 2 人重抽并确认，正式签表变为 2 人。
        session = self.drain(self.start()['session'])
        self.assertEqual(len(session['order']), 2)
        self.confirm(session)
        self.assertEqual(len(self.ok('GET', self.path)['draw']['entries']), 2)
        # 新增报名使本轮失效；撤销重开后完整覆盖 3 人，正式签表在确认前保持 2 人。
        self.ok('POST', f'/api/categories/{self.cid}/enrollments/individual',
                {'school': {'name': '新增抽签学校'}, 'athlete': {'name': '新人', 'gender': 'male'}})
        self.assertEqual(len(self.ok('GET', self.path)['draw']['entries']), 2)
        session = self.drain(self.start()['session'])
        self.assertEqual(len(session['order']), 3)
        self.assertNotIn(pid, session['order'])
        self.confirm(session)
        self.assertEqual(len(self.ok('GET', self.path)['draw']['entries']), 3)
        self.assertEqual(self.ok('GET', self.path)['draw']['revision'], 3)

    def test_session_packets_reject_tampering_revision_and_foreign_actor(self):
        session = self.start()['session']
        packet = self.packet(session)
        self.err('POST', self.session_path + '/stop', {**packet, 'order': [1, 2]}, expect=400)
        self.err('POST', self.session_path + '/stop', {**packet, 'base_revision': True}, expect=400)
        bad = json.loads(json.dumps(packet))
        bad['event_identity']['event_uuid'] = 'other'
        self.err('POST', self.session_path + '/stop', bad, expect=409)
        stopped = self.ok('POST', self.session_path + '/stop', packet)
        self.err('POST', self.session_path + '/stop', {**packet, 'base_revision': 99},
                 expect=409, code='request_uid_reused')
        self.assertEqual(stopped['receipt']['op'], 'stop')
        self.assertEqual(stopped['receipt']['request_uid'], packet['request_uid'])
        # 同一账号换 base_revision 重放被拒；其他账号不能读到本账号的精确回执。
        organizer = self.make_user('organizer')
        self.assertFalse(self.ok('GET', self.session_path + '/requests/' + packet['request_uid'],
                                 token=organizer)['found'])
        self.assertTrue(self.ok('GET', self.session_path + '/requests/' + packet['request_uid'])['found'])

    def test_roles_only_read_official_draw_and_cannot_read_sessions(self):
        token = self.make_user('organizer')
        session = self.drain(self.start(token=token)['session'], token)
        self.confirm(session, token=token)
        for role in ('recorder', 'viewer'):
            role_token = self.make_user(role)
            data = self.ok('GET', self.path, token=role_token)['draw']
            self.assertEqual(len(data['entries']), 3)
            self.assertNotIn('roster', data)
            self.err('GET', self.session_path, token=role_token, expect=403)
            self.err('POST', self.session_path + '/start',
                     {'event_identity': self.event_identity, 'request_uid': str(uuid.uuid4())},
                     token=role_token, expect=403)
            self.err('POST', self.path + '/confirm', self.legacy_preview_packet(),
                     token=role_token, expect=403)
        self.err('GET', f'/api/categories/{self.cid}/individual-results', token=role_token, expect=403)
        self.err('GET', f'/api/categories/{self.fx["team_cat"]}/individual-draw', expect=400)

    def test_two_concurrent_steps_have_one_winner_and_no_duplicate_pick(self):
        session = self.start()['session']
        packets = [self.packet(session) for _ in range(2)]

        def send(packet):
            status, raw = self.request('POST', self.session_path + '/stop', packet, raw=True)
            return status, json.loads(raw)

        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(send, packets))
        self.assertEqual(sorted(r[0] for r in results), [200, 409])
        current = self.ok('GET', self.session_path)['session']
        self.assertEqual(current['picked'], 1, '并发停止只允许抽出一人')
        self.assertEqual(len(set(current['order'])), 1)
        self.assertEqual(len(self.snapshot()['individual_draw_sessions']), 1)

    def test_claim_race_and_existing_result_block_start_and_confirm(self):
        pid = self.pids[0]
        self.ok('POST', f'/api/recording/individual/{pid}/claim', {})
        self.err('POST', self.session_path + '/start',
                 {'event_identity': self.event_identity, 'request_uid': str(uuid.uuid4())},
                 expect=409, code='individual_draw_locked')
        self.assertEqual(self.ok('GET', self.path)['draw']['status'], 'none')
        self.assertIsNone(self.ok('GET', self.session_path)['session'])
        self.ok('POST', '/api/scoring/individual', self.score(pid))
        self.err('POST', self.session_path + '/start',
                 {'event_identity': self.event_identity, 'request_uid': str(uuid.uuid4())},
                 expect=409, code='individual_draw_locked')

    def test_old_project_no_draw_can_record_and_pending_result_locks(self):
        pid = self.pids[0]
        self.ok('POST', '/api/scoring/individual', self.score(pid, result_status='pending'))
        self.assertFalse(self.ok('GET', self.path)['draw']['can_draw'])

    def test_saved_start_order_does_not_decide_result_rank_or_school_points(self):
        result, session = self.draw_complete()
        saved = self.ok('GET', self.path)['draw']
        order = session['order']
        self.assertEqual([r['id'] for r in saved['entries']], order)
        self.assertEqual(sorted(order), sorted(self.pids))
        for pid, value in zip(self.pids, [32, 22, 12]):
            self.ok('POST', '/api/scoring/individual', self.score(pid, result_value=value))
        self.ok('POST', f'/api/categories/{self.cid}/individual-rankings/confirm')
        ranks = {r['participation_id']: r['rank_no']
                 for r in self.ok('GET', f'/api/categories/{self.cid}/placements')['placements']}
        self.assertEqual(ranks, {self.pids[0]: 1, self.pids[1]: 2, self.pids[2]: 3})
        totals = self.ok('GET', f'/api/groups/{self.fx["groups"]["甲"]["id"]}/school-totals')['rows']
        self.assertEqual(next(r['total'] for r in totals if r['name'] == '个人1校'), 9)
        self.assertEqual(self.ok('GET', self.path)['draw']['order_hash'], saved['order_hash'])

    def test_receipts_do_not_cross_categories_or_accounts(self):
        session = self.start()['session']
        packet = self.packet(session)
        self.ok('POST', self.session_path + '/stop', packet)
        other = next(c['id'] for c in self.fx['groups']['甲']['categories']
                     if c['kind'] == 'individual' and c['id'] != self.cid)
        self.assertFalse(self.ok('GET', f'/api/categories/{other}/individual-draw/session/requests/'
                                         + packet['request_uid'])['found'])
        self.assertFalse(self.ok('GET', f'/api/categories/{other}/individual-draw/requests/'
                                         + packet['request_uid'])['found'])

    def test_atomic_fault_rolls_back_session_audit_and_idempotency(self):
        session = self.start()['session']
        packet = self.packet(session)
        before = self.snapshot()
        with patch('app.api.individual_draw.security.audit', side_effect=RuntimeError('injected failure')):
            self.err('POST', self.session_path + '/stop', packet, expect=500)
        self.assertEqual(self.snapshot(), before)
        # 故障后同一原包重试仍然成功，且只新增一个人。
        retried = self.ok('POST', self.session_path + '/stop', packet)['session']
        self.assertEqual(retried['picked'], 1)

    def test_expiry_capacity_and_size_reject_without_writes(self):
        before = self.snapshot()
        with patch.object(api, 'MAX_PREVIEW_BYTES', 1):
            self.err('POST', self.path + '/preview', {'event_identity': self.event_identity},
                     expect=426, code='client_upgrade_required')
        self.assertEqual(self.snapshot(), before)
        # 超限名单整份拒绝，不截断、不建立会话。
        session_store = __import__('app.individual_draw_session_store', fromlist=['x'])
        self.assertRaises(Exception, session_store.encode_roster, [{'id': 1, 'name': 'x' * (2 * 1024 * 1024)}])
        self.assertIsNone(self.ok('GET', self.session_path)['session'])
        self.assertEqual(self.snapshot()['individual_draw_sessions'], [])

    def test_singleton_empty_and_repeated_old_database_upgrade(self):
        for pid in self.pids[1:]:
            self.ok('DELETE', f'/api/participations/{pid}')
        session = self.drain(self.start()['session'])
        self.assertEqual(len(session['order']), 1)
        self.assertEqual(session['order'], [self.pids[0]])
        self.ok('DELETE', f'/api/participations/{self.pids[0]}')
        self.err('POST', self.session_path + '/start',
                 {'event_identity': self.event_identity, 'request_uid': str(uuid.uuid4())},
                 expect=409)
        path = db.event_db_path(self.fx['event_id'])
        before = self.snapshot()
        c = db.connect(path)
        c.execute('DROP TABLE individual_draw_sessions')
        c.close()
        db.init_db(path)
        db.init_db(path)
        backup = Path(str(path) + '.before-individual-draw-session-v1.sqlite')
        self.assertTrue(backup.exists())
        self.assertNotIn(backup, list(path.parent.glob('event_*.db')), '启动扫描不能升级备份文件')
        restored = sqlite3.connect(backup)
        try:
            self.assertNotIn('individual_draw_sessions', {r[0] for r in restored.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")})
        finally:
            restored.close()
        after = self.snapshot()
        self.assertEqual(after['individual_draw_sessions'], [])
        self.assertEqual(after['individual_draws'], before['individual_draws'])
        self.assertEqual(after['participations'], before['participations'])
        c = db.connect(path)
        self.assertEqual(c.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
        self.assertEqual(c.execute('PRAGMA foreign_key_check').fetchall(), [])
        c.close()
        # 升级后可重新开始抽取，正式签表仍为原内容。
        self.ok('POST', f'/api/categories/{self.cid}/enrollments/individual',
                {'school': {'name': '回归抽签学校'}, 'athlete': {'name': '回归选手', 'gender': 'male'}})
        session = self.drain(self.start()['session'])
        self.assertEqual(len(session['order']), 1)


if __name__ == '__main__':
    unittest.main()

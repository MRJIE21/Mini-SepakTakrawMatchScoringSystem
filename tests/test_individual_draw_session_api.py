"""逐人抽取会话 HTTP 接口的真实隔离测试（DESIGN_V3 TEST-IND-PROCESS-*）。

一个文件覆盖 V3 test_matrix 的六个测试 ID：
  TEST-IND-PROCESS-ENTRY           四角色权限、非个人赛 400、未开始为 null、start 后候选与进度
  TEST-IND-PROCESS-PICK            每个新 stop/pick 恰好调用一次随机源且参数为剩余候选
  TEST-IND-PROCESS-INVARIANTS      逐步修订递增、无重复遗漏、同 UID 重放与换包、并发竞争、跨账号回执
  TEST-IND-PROCESS-RECOVERY        重启等价、丢响应后同 UID 核实不多抽、进度不依赖进程内存
  TEST-IND-PROCESS-CONFIRM-GUARDS  未抽完/名单失效/记录阻塞拒绝确认、确认后正式签表、撤销保留快照
  TEST-IND-PROCESS-UI-REGRESSION   旧 GET /individual-draw 正式签表只读与角色权限（浏览器部分见 web 测试）

隔离方式沿用 tests/test_individual_draw_api.py：setUpClass 把 config.DATA_DIR/DB_PATH/EVENTS_DIR
指向临时目录，再调用 test_api.ApiTest.setUpClass；每个用例各自建赛事，全部请求走真实 HTTP。
"""
import json
import tempfile
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import MagicMock, patch

import test_api
from app import config, db, idempotency
from app import individual_draw_session_store as sessions
from app.api import individual_draw as api
from app.domain.individual_draw import fingerprint


class IndividualDrawSessionApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        task = Path(tempfile.mkdtemp(prefix='individual-draw-session-api-'))
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
        self.new_event()

    # ------------------------------------------------------------ 夹具与工具
    def new_event(self, individual_count=3):
        """每个场景一份全新赛事，避免名单快照与上一场景互相干扰。"""
        self.fx = self.build_event(team_count=0, individual_count=individual_count)
        self.cid = self.fx['indiv_cat']
        self.path = f'/api/categories/{self.cid}/individual-draw'
        self.session_path = self.path + '/session'
        self.pids = self.fx['indiv_parts']
        return self.fx

    def packet(self, session, uid=None, revision=None):
        return {'event_identity': self.event_identity, 'request_uid': uid or str(uuid.uuid4()),
                'session_id': session['session_id'],
                'base_revision': session['revision'] if revision is None else revision}

    def start(self, token=None, uid=None, expect=200):
        body = {'event_identity': self.event_identity, 'request_uid': uid or str(uuid.uuid4())}
        return self.request('POST', self.session_path + '/start', body, token, expect=expect)

    def draw(self, session, token=None, uid=None, path='/stop', expect=200):
        return self.request('POST', self.session_path + path, self.packet(session, uid), token,
                            expect=expect)

    def drain(self, session, token=None, path='/stop'):
        while session['status'] != 'complete':
            session = self.draw(session, token, path=path)['session']
        return session

    def session(self, token=None, expect=200):
        return self.request('GET', self.session_path, token=token, expect=expect)['session']

    def send(self, packet, path='/stop'):
        status, raw = self.request('POST', self.session_path + path, packet, raw=True)
        return status, json.loads(raw or b'{}')

    def controlled(self):
        """受控随机源：每次从当前剩余候选中取第一项，可统计 choice 调用次数。"""
        source = MagicMock()
        source.choice.side_effect = lambda candidates: candidates[0]
        return source

    def controlled_random(self, source):
        return patch('app.domain.individual_draw.random.SystemRandom', return_value=source)

    def event_conn(self):
        return db.connect(db.event_db_path(self.fx['event_id']))

    def rows(self, sql, args=()):
        conn = self.event_conn()
        try:
            return [dict(row) for row in db.q(conn, sql, args)]
        finally:
            conn.close()

    def snapshot(self, tables=('individual_draws', 'individual_draw_sessions', 'request_log',
                              'individual_results')):
        conn = self.event_conn()
        try:
            return {table: [tuple(row) for row in conn.execute(f'SELECT * FROM {table} ORDER BY rowid')]
                    for table in tables}
        finally:
            conn.close()

    def latest_session_row(self):
        return next(iter(self.rows('SELECT * FROM individual_draw_sessions ORDER BY id DESC LIMIT 1')), None)

    def formal_draw(self):
        return next(iter(self.rows('SELECT * FROM individual_draws WHERE category_id=?', (self.cid,))), None)

    def athlete_of(self, participation_id):
        return self.rows('SELECT athlete_id FROM participations WHERE id=?', (participation_id,))[0]['athlete_id']

    def record_score(self, participation_id, value=30, uid=None):
        return self.ok('POST', '/api/scoring/individual', {
            'event_identity': self.event_identity, 'submission_uid': uid or str(uuid.uuid4()),
            'participation_id': participation_id, 'base_version': 0, 'result_status': 'normal',
            'result_value': value, 'error_count': 0, 'violation_count': 0, 'rank_no': None})

    def admin_id(self):
        registry = db.connect()
        try:
            return db.q1(registry, "SELECT id FROM users WHERE username='admin'")['id']
        finally:
            registry.close()

    def seed_legacy_receipt(self, body, result):
        """种入升级前已提交的旧一次性确认回执（与旧版本 payload 结构完全一致）。"""
        actor = self.admin_id()
        payload = {'path': self.path + '/confirm', 'method': 'POST', 'actor': actor, 'body': body}
        conn = self.event_conn()
        try:
            db.insert(conn, 'request_log', {
                'uid': body['request_uid'], 'scope': 'individual_draw', 'user_id': actor,
                'payload_hash': idempotency.content_hash(payload), 'status': 'succeeded',
                'result_json': json.dumps(result, ensure_ascii=False), 'message': ''})
        finally:
            conn.close()

    # ------------------------------------------------------------ ENTRY
    def test_roles_and_category_kind_gate_session_routes(self):
        recorder, viewer = self.make_user('recorder'), self.make_user('viewer')
        probe = {'event_identity': self.event_identity, 'request_uid': 'role-probe',
                 'session_id': 1, 'base_revision': 1}
        for token in (recorder, viewer):
            self.err('GET', self.session_path, token=token, expect=403)
            self.err('GET', self.session_path + '/requests/role-probe', token=token, expect=403)
            self.err('POST', self.session_path + '/start',
                     {'event_identity': self.event_identity, 'request_uid': 'role-probe'},
                     token=token, expect=403)
            for suffix in ('/stop', '/pick', '/confirm', '/cancel'):
                self.err('POST', self.session_path + suffix, dict(probe), token=token, expect=403)
            # 旧正式签表沿用正式签表查看权限，其他角色仍可读
            self.ok('GET', self.path, token=token)
        # 匿名请求一律 401
        self.err('GET', self.session_path, token='', expect=401)
        self.err('POST', self.session_path + '/start',
                 {'event_identity': self.event_identity, 'request_uid': 'anon-probe'},
                 token='', expect=401)

        organizer = self.make_user('organizer')
        session = self.start(token=organizer)['session']
        self.assertEqual(session['picked'], 0)
        first = self.draw(session, token=organizer, path='/pick')['session']   # DESIGN_V3 别名端点
        self.assertEqual(first['picked'], 1)
        complete = self.drain(first, token=organizer)
        confirmed = self.draw(complete, token=organizer, path='/confirm')
        self.assertEqual(confirmed['receipt']['op'], 'confirm')
        self.assertIsNone(confirmed['session'])
        self.assertEqual(self.ok('GET', self.path, token=organizer)['draw']['revision'], 1)

        self.new_event()
        session = self.start()['session']                                       # admin
        self.draw(session)
        cancelled = self.draw(self.session(), path='/cancel')
        self.assertEqual(cancelled['receipt']['op'], 'cancel')
        self.assertIsNone(cancelled['session'])

        team = self.fx['team_cat']
        self.err('GET', f'/api/categories/{team}/individual-draw/session', expect=400)
        self.err('GET', f'/api/categories/{team}/individual-draw/session/requests/role-probe', expect=400)
        self.err('POST', f'/api/categories/{team}/individual-draw/session/start',
                 {'event_identity': self.event_identity, 'request_uid': 'team-probe'}, expect=400)
        self.err('POST', f'/api/categories/{team}/individual-draw/preview',
                 {'event_identity': self.event_identity}, expect=400)

    def test_session_is_null_before_start_and_exposes_candidates_after_start(self):
        self.assertEqual(self.request('GET', self.session_path, expect=200),
                         {'ok': True, 'session': None})
        uid = 'start-uid-' + uuid.uuid4().hex
        started = self.start(uid=uid)
        self.assertEqual(started['receipt']['op'], 'start')
        self.assertEqual(started['receipt']['revision'], 1)
        self.assertEqual(started['receipt']['base_revision'], 0)
        self.assertEqual(started['receipt']['picked_id'], None)
        self.assertEqual(started['receipt']['event_identity'], self.event_identity)
        self.assertNotIn('replayed', started)
        session = started['session']
        self.assertEqual(session['picked'], 0)
        self.assertEqual(session['remaining'], 3)
        self.assertEqual(session['order'], [])
        self.assertEqual(session['revealed'], [])
        self.assertFalse(session['can_confirm'])
        self.assertTrue(session['can_pick'])
        self.assertFalse(session['stale'])
        self.assertEqual(sorted(row['id'] for row in session['candidates']), sorted(self.pids))
        self.assertEqual(session['roster'], session['session_roster'])
        self.assertEqual(self.session(), session)
        self.assertIn('school_name', session['candidates'][0])

        # 响应丢失：同 UID 原包重放只返回原回执，不新建会话
        replay = self.start(uid=uid)
        self.assertTrue(replay['replayed'])
        self.assertEqual(replay['receipt'], started['receipt'])
        self.assertEqual(replay['session'], session)
        self.assertEqual(len(self.rows('SELECT id FROM individual_draw_sessions')), 1)

    # ------------------------------------------------------------ PICK
    def test_stepwise_stop_reveals_every_runner_exactly_once(self):
        source = self.controlled()
        with self.controlled_random(source):
            session = self.start()['session']
            self.assertEqual(source.choice.call_count, 0)          # start 不预排、不抽
            seen = []
            while session['status'] != 'complete':
                previous = session
                result = self.draw(session)
                session = result['session']
                receipt = result['receipt']
                self.assertEqual(receipt['op'], 'stop')
                self.assertEqual(receipt['picked_id'], session['order'][-1])
                self.assertEqual(receipt['revision'], session['revision'])
                self.assertEqual(receipt['revision'], previous['revision'] + 1)
                self.assertEqual(receipt['base_revision'], session['base_revision'])
                self.assertEqual(receipt['event_identity'], self.event_identity)
                self.assertEqual(session['picked'], previous['picked'] + 1)
                self.assertEqual(session['order'], previous['order'] + [receipt['picked_id']])
                self.assertEqual([row['id'] for row in session['revealed']], session['order'])
                self.assertEqual([row['draw_order'] for row in session['revealed']],
                                 list(range(1, session['picked'] + 1)))
                self.assertEqual(len(session['candidates']), 3 - session['picked'])
                self.assertEqual({row['id'] for row in session['revealed']}
                                 & {row['id'] for row in session['candidates']}, set())
                seen.append(receipt['picked_id'])
            self.assertEqual(sorted(seen), sorted(self.pids))
            self.assertEqual(len(set(seen)), 3)
            self.assertEqual(session['status'], 'complete')
            self.assertEqual(session['remaining'], 0)
            self.assertTrue(session['can_confirm'])
            self.assertFalse(session['can_pick'])
            self.assertEqual(source.choice.call_count, 3)
            # 每次随机调用恰以「当前剩余候选」为参数，且每次只抽一次
            self.assertEqual([[row['id'] for row in call.args[0]]
                              for call in source.choice.call_args_list],
                             [self.pids, self.pids[1:], self.pids[2:]])

    # ------------------------------------------------------------ CONFIRM-GUARDS
    def test_confirm_before_complete_is_rejected_without_writes(self):
        session = self.start()['session']
        self.draw(session)                                          # 只抽了 1/3
        partial = self.session()
        before = self.snapshot()
        parsed = self.err('POST', self.session_path + '/confirm', self.packet(partial),
                          expect=409, code='draw_session_incomplete')
        self.assertTrue(parsed['detail']['not_committed'])
        self.assertEqual(parsed['outcome'], 'not_committed')
        self.assertEqual(self.snapshot(), before)
        self.assertIsNone(self.formal_draw())
        self.assertEqual(self.ok('GET', self.path)['draw']['status'], 'none')
        self.assertEqual(self.session()['order'], partial['order'])

    def test_confirm_writes_formal_draw_and_exact_replay_does_not_rewrite(self):
        session = self.drain(self.start()['session'])
        body = self.packet(session)
        result = self.request('POST', self.session_path + '/confirm', body, expect=200)
        self.assertIsNone(result['session'])
        receipt = result['receipt']
        self.assertEqual(receipt['op'], 'confirm')
        self.assertEqual(receipt['session_id'], session['session_id'])
        self.assertEqual(receipt['revision'], session['revision'])
        self.assertEqual(receipt['base_revision'], session['base_revision'])
        self.assertEqual(receipt['picked_id'], None)
        self.assertEqual(receipt['event_identity'], self.event_identity)
        self.assertEqual(receipt['order_hash'], fingerprint(session['order']))

        draw = self.ok('GET', self.path)['draw']
        self.assertEqual(draw['revision'], 1)
        self.assertEqual(draw['status'], 'current')
        self.assertEqual([row['id'] for row in draw['entries']], session['order'])
        self.assertEqual([row['draw_order'] for row in draw['entries']], [1, 2, 3])
        self.assertEqual(draw['order_hash'], receipt['order_hash'])
        self.assertIsNone(self.session())
        self.assertEqual(self.latest_session_row()['status'], 'confirmed')

        after = self.snapshot()
        replay = self.request('POST', self.session_path + '/confirm', body, expect=200)
        self.assertTrue(replay['replayed'])
        self.assertEqual(replay['receipt'], receipt)
        self.assertIsNone(replay['session'])
        self.assertEqual(self.snapshot(), after)
        # 会话已收尾：新 UID 再确认被明确拒绝，不会二次写正式签表
        self.err('POST', self.session_path + '/confirm', self.packet(session),
                 expect=409, code='session_revision_conflict')
        self.assertEqual(self.snapshot(), after)

    def test_session_packets_reject_extra_invalid_or_cross_table_uids(self):
        session = self.start()['session']
        extra = {**self.packet(session), 'candidate_id': self.pids[0]}
        for path in ('/stop', '/pick', '/confirm', '/cancel'):
            self.err('POST', self.session_path + path, extra, expect=400, code='bad_request')
        self.err('POST', self.session_path + '/start',
                 {'event_identity': self.event_identity, 'request_uid': 'probe-1', 'revision': 1},
                 expect=400, code='bad_request')
        self.err('POST', self.session_path + '/stop',
                 {'event_identity': self.event_identity, 'request_uid': 'probe-2'}, expect=400)
        self.err('POST', self.session_path + '/stop',
                 {**self.packet(session), 'session_id': True}, expect=400)
        self.err('POST', self.session_path + '/stop',
                 {**self.packet(session), 'base_revision': '1'}, expect=400)
        for uid in ('', 'has space', 'x' * 121):
            self.err('POST', self.session_path + '/start',
                     {'event_identity': self.event_identity, 'request_uid': uid}, expect=400)
        mismatch = self.request('POST', self.session_path + '/start',
                                {'event_identity': {**self.event_identity, 'event_uuid': 'other'},
                                 'request_uid': 'probe-3'}, expect=409)
        self.assertEqual(mismatch['code'], 'event_identity_mismatch')
        self.assertEqual(self.session(), session)                  # 全部拒绝且进度不变

        # request_uid 不得与 submissions 表复用
        used = 'score-uid-' + uuid.uuid4().hex
        self.record_score(self.pids[0], uid=used)
        self.err('POST', self.session_path + '/start',
                 {'event_identity': self.event_identity, 'request_uid': used},
                 expect=409, code='request_uid_reused')

    def test_roster_change_invalidates_stop_and_confirm_and_cancel_keeps_snapshot(self):
        # 1) 改名：进行中的抽取立即失效，已抽历史保留；失效后仍可明确撤销
        session = self.start()['session']
        first = self.draw(session)['session']
        self.ok('PUT', f'/api/athletes/{self.athlete_of(self.pids[1])}', {'name': '改名选手甲'})
        parsed = self.err('POST', self.session_path + '/stop', self.packet(first),
                          expect=409, code='draw_session_stale')
        self.assertTrue(parsed['detail']['not_committed'])
        self.assertEqual(parsed['outcome'], 'not_committed')
        stale = self.session()
        self.assertTrue(stale['stale'])
        self.assertIn('已失效', stale['block_reason'])
        self.assertFalse(stale['can_pick'])
        self.assertFalse(stale['can_confirm'])
        self.assertEqual(stale['order'], first['order'])
        self.assertEqual(stale['revision'], first['revision'])
        cancel_body = self.packet(stale)
        cancelled = self.request('POST', self.session_path + '/cancel', cancel_body, expect=200)
        self.assertEqual(cancelled['receipt']['op'], 'cancel')
        self.assertEqual(cancelled['receipt']['order_hash'], fingerprint(first['order']))
        self.assertIsNone(cancelled['session'])
        self.assertIsNone(self.session())
        row = self.latest_session_row()
        self.assertEqual(row['status'], 'cancelled')
        self.assertEqual(json.loads(row['order_json']), first['order'])
        # 撤销已提交但响应丢失：同 UID 原包重放返回原回执
        replay = self.request('POST', self.session_path + '/cancel', cancel_body, expect=200)
        self.assertTrue(replay['replayed'])
        self.assertEqual(replay['receipt'], cancelled['receipt'])

        # 2) 退出报名：同样使进行中的 stop 失效（新事件）
        self.new_event()
        first = self.draw(self.start()['session'])['session']
        self.ok('PUT', f'/api/participations/{self.pids[0]}', {'status': 'withdrawn'})
        self.err('POST', self.session_path + '/stop', self.packet(first),
                 expect=409, code='draw_session_stale')
        self.draw(self.session(), path='/cancel')

        # 3) 新增报名：确认被拒，且原正式签表一字不动（新事件）
        self.new_event()
        self.request('POST', self.session_path + '/confirm',
                     self.packet(self.drain(self.start()['session'])), expect=200)
        formal = self.formal_draw()
        self.assertEqual(formal['revision'], 1)
        second = self.drain(self.start()['session'])
        self.ok('POST', f'/api/categories/{self.cid}/enrollments/individual',
                {'school': {'name': '新增抽签学校'}, 'athlete': {'name': '新增选手', 'gender': 'male'}})
        parsed = self.err('POST', self.session_path + '/confirm', self.packet(second),
                          expect=409, code='draw_session_stale')
        self.assertTrue(parsed['detail']['not_committed'])
        self.assertEqual(self.formal_draw(), formal)
        self.draw(self.session(), path='/cancel')
        self.assertEqual(self.latest_session_row()['status'], 'cancelled')

    def test_claim_or_result_blocks_start_pick_and_confirm(self):
        # 已领取记录任务：start 明确拒绝
        self.ok('POST', f'/api/recording/individual/{self.pids[0]}/claim', {})
        parsed = self.err('POST', self.session_path + '/start',
                          {'event_identity': self.event_identity, 'request_uid': str(uuid.uuid4())},
                          expect=409, code='individual_draw_locked')
        self.assertTrue(parsed['detail']['not_committed'])
        self.assertIsNone(self.session())

        # 抽取途中产生成绩：stop 拒绝但过程保留（新事件）
        self.new_event()
        self.draw(self.start()['session'])
        self.record_score(self.pids[0])
        locked = self.session()
        self.assertTrue(locked['block_reason'])
        self.assertFalse(locked['can_pick'])
        parsed = self.err('POST', self.session_path + '/stop', self.packet(locked),
                          expect=409, code='individual_draw_locked')
        self.assertTrue(parsed['detail']['not_committed'])
        self.assertEqual(self.session()['order'], locked['order'])

        # 抽完后才产生成绩：confirm 拒绝且不写正式签表（新事件）
        self.new_event()
        complete = self.drain(self.start()['session'])
        self.record_score(self.pids[2])
        parsed = self.err('POST', self.session_path + '/confirm', self.packet(complete),
                          expect=409, code='individual_draw_locked')
        self.assertTrue(parsed['detail']['not_committed'])
        self.assertIsNone(self.formal_draw())

    # ------------------------------------------------------------ INVARIANTS
    def test_stop_and_pick_aliases_share_one_handler_and_op(self):
        """DESIGN_V3 的 /session/pick 与冻结契约的 /session/stop 等价。"""
        session = self.start()['session']
        first = self.draw(session, path='/stop')
        self.assertEqual(first['receipt']['op'], 'stop')
        second = self.draw(first['session'], path='/pick')
        self.assertEqual(second['receipt']['op'], 'stop')
        self.assertEqual(second['session']['picked'], 2)
        self.assertEqual(second['receipt']['revision'], first['receipt']['revision'] + 1)
        complete = self.draw(second['session'], path='/pick')
        self.assertEqual(complete['receipt']['op'], 'stop')
        self.assertEqual(complete['session']['status'], 'complete')
        self.assertEqual(complete['session']['order'],
                         [first['receipt']['picked_id'], second['receipt']['picked_id'],
                          complete['receipt']['picked_id']])

    def test_every_session_step_is_audited(self):
        session = self.start()['session']
        self.draw(session)
        self.request('POST', self.session_path + '/confirm',
                     self.packet(self.drain(self.session())), expect=200)
        self.assertEqual([row['action'] for row in self.rows(
            "SELECT action FROM audit_logs WHERE action LIKE 'individual_draw_session%' ORDER BY id")],
            ['individual_draw_session_start', 'individual_draw_session_pick',
             'individual_draw_session_pick', 'individual_draw_session_pick',
             'individual_draw_session_confirm'])
        self.assertEqual({row['user_id'] for row in self.rows(
            "SELECT user_id FROM audit_logs WHERE action LIKE 'individual_draw_session%'")},
            {self.admin_id()})

    def test_request_log_keeps_only_slim_receipts(self):
        """每步只存精简回执：不得把整份名单写进 request_log（避免平方增长）。"""
        session = self.drain(self.start()['session'])
        rows = self.rows("SELECT result_json FROM request_log WHERE scope='individual_draw_session'")
        self.assertEqual(len(rows), 4)
        for row in rows:
            blob = json.loads(row['result_json'])
            self.assertEqual(set(blob), {'category_id', 'receipt', 'message'})
            self.assertNotIn('roster', row['result_json'])
            self.assertNotIn('session_roster', row['result_json'])
            self.assertLess(len(row['result_json']), 1024)
        self.assertEqual(len(session['session_roster']), 3)

    def test_replay_of_same_packet_never_draws_again(self):
        source = self.controlled()
        with self.controlled_random(source):
            session = self.start()['session']
            body = self.packet(session)
            first = self.request('POST', self.session_path + '/stop', body, expect=200)
            self.assertEqual(source.choice.call_count, 1)
            self.assertEqual([row['id'] for row in source.choice.call_args[0][0]], self.pids)
            self.assertEqual(first['receipt']['picked_id'], self.pids[0])
            self.assertEqual(first['receipt']['order_hash'], fingerprint([self.pids[0]]))
            before = self.snapshot()
            replay = self.request('POST', self.session_path + '/stop', body, expect=200)
            self.assertTrue(replay['replayed'])
            self.assertEqual(replay['receipt'], first['receipt'])
            self.assertEqual(replay['session'], first['session'])
            self.assertEqual(source.choice.call_count, 1)     # 重放不再调用随机源
            self.assertEqual(self.snapshot(), before)

    def test_same_uid_with_changed_packet_or_other_scope_is_rejected(self):
        session = self.start()['session']
        body = self.packet(session)
        self.request('POST', self.session_path + '/stop', body, expect=200)
        changed = {**body, 'base_revision': body['base_revision'] + 1}
        for path in ('/stop', '/pick'):
            parsed = self.err('POST', self.session_path + path, changed,
                              expect=409, code='request_uid_reused')
            self.assertTrue(parsed['detail']['not_committed'])
        # 同一 UID 换路径（原包不变）同样不是重放：payload 绑定 path
        self.err('POST', self.session_path + '/pick', body, expect=409, code='request_uid_reused')
        legacy = {'event_identity': self.event_identity, 'request_uid': body['request_uid'],
                  'preview_id': 'A' * 24, 'base_revision': 0}
        self.err('POST', self.path + '/confirm', legacy, expect=409, code='request_uid_reused')
        self.assertEqual(self.session()['picked'], 1)

    def test_two_clients_with_same_revision_compete_for_one_pick(self):
        session = self.start()['session']
        packets = [self.packet(session) for _ in range(2)]
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(self.send, packets))
        self.assertEqual(sorted(status for status, _ in results), [200, 409])
        loser = next(body for status, body in results if status == 409)
        self.assertEqual(loser['code'], 'session_revision_conflict')
        self.assertTrue(loser['detail']['not_committed'])
        final = self.session()
        self.assertEqual(final['picked'], 1)
        self.assertEqual(final['revision'], 2)
        self.assertEqual(len(final['order']), len(set(final['order'])))
        self.assertEqual(len(self.rows('SELECT id FROM individual_draw_sessions')), 1)

    def test_receipt_lookup_is_bound_to_account_category_and_identity(self):
        session = self.start()['session']
        body = self.packet(session)
        result = self.request('POST', self.session_path + '/stop', body, expect=200)
        uid = body['request_uid']
        self.assertEqual(self.ok('GET', f'{self.session_path}/requests/{uid}'),
                         {'ok': True, 'found': True, 'receipt': result['receipt']})

        other = self.make_user('admin')
        self.assertEqual(self.ok('GET', f'{self.session_path}/requests/{uid}', token=other),
                         {'ok': True, 'found': False})
        self.err('POST', self.session_path + '/stop', body, token=other,
                 expect=409, code='request_uid_reused')

        other_cid = next(c['id'] for c in self.fx['groups']['甲']['categories']
                         if c['kind'] == 'individual' and c['id'] != self.cid)
        self.assertEqual(self.ok('GET', f'/api/categories/{other_cid}/individual-draw/session/requests/{uid}'),
                         {'ok': True, 'found': False})
        self.assertEqual(self.ok('GET', f'{self.session_path}/requests/absent-uid-1'),
                         {'ok': True, 'found': False})

        # 丢失响应后按回执核实：回执一致、进度只前进一步
        retry = self.request('POST', self.session_path + '/stop', body, expect=200)
        self.assertTrue(retry['replayed'])
        self.assertEqual(retry['receipt'], result['receipt'])
        self.assertEqual(self.session()['picked'], 1)

    # ------------------------------------------------------------ RECOVERY
    def test_progress_survives_losing_all_process_memory(self):
        session = self.start()['session']
        first = self.draw(session)['session']
        with api.LOCK:
            api.PREVIEWS.clear()                               # 清空全部进程内状态
        self.assertEqual(self.session(), first)                # HTTP 读取仍返回相同进度
        row = self.latest_session_row()
        self.assertEqual(json.loads(row['order_json']), first['order'])
        self.assertEqual(row['revision'], first['revision'])
        conn = db.connect(db.event_db_path(self.fx['event_id']))   # 新连接直接读存储层
        try:
            reloaded = sessions.read(conn, self.cid)
        finally:
            conn.close()
        self.assertEqual(reloaded['order'], first['order'])
        self.assertEqual(reloaded['revision'], first['revision'])
        self.assertEqual(reloaded['session_id'], first['session_id'])

    def test_lost_response_is_recovered_by_receipt_without_extra_draws(self):
        source = self.controlled()
        with self.controlled_random(source):
            session = self.start()['session']
            body = self.packet(session)
            status, first = self.send(body)
            self.assertEqual(status, 200)
            self.assertEqual(source.choice.call_count, 1)
            formal = self.snapshot(('individual_draws',))
            # commit 之后响应丢失：同 UID 原包重试，精确回执核实且不多抽
            status, retry = self.send(body)
            self.assertEqual(status, 200)
            self.assertTrue(retry['replayed'])
            self.assertEqual(retry['receipt'], first['receipt'])
            self.assertEqual(source.choice.call_count, 1)
            self.assertEqual(self.snapshot(('individual_draws',)), formal)
            self.assertEqual(self.session()['picked'], 1)
            # 换 UID 却用旧修订重试：明确 409，不能多抽一人
            status, stale = self.send(self.packet(session))
            self.assertEqual(status, 409)
            self.assertEqual(stale['code'], 'session_revision_conflict')
            self.assertTrue(stale['detail']['not_committed'])
            self.assertEqual(source.choice.call_count, 1)
            self.assertEqual(self.session()['picked'], 1)

    # ------------------------------------------------------------ 旧接口兼容
    def test_legacy_endpoints_require_upgrade_and_replay_only_saved_receipts(self):
        before = self.snapshot()
        preview = self.err('POST', self.path + '/preview', {'event_identity': self.event_identity},
                           expect=426, code='client_upgrade_required')
        self.assertEqual(preview['outcome'], 'not_committed')
        self.assertTrue(preview['detail']['not_committed'])
        self.err('POST', self.path + '/preview',
                 {'event_identity': self.event_identity, 'preview_id': 'x'}, expect=400)
        self.assertEqual(api.PREVIEWS, {})                      # 不再产生新的可写预览
        self.assertEqual(self.snapshot(), before)

        legacy = {'event_identity': self.event_identity, 'request_uid': str(uuid.uuid4()),
                  'preview_id': 'P' * 32, 'base_revision': 0}
        upgrade = self.err('POST', self.path + '/confirm', legacy,
                           expect=426, code='client_upgrade_required')
        self.assertEqual(upgrade['outcome'], 'not_committed')
        self.assertTrue(upgrade['detail']['not_committed'])
        self.assertEqual(self.snapshot(), before)

        stored = {'draw': {'revision': 1, 'order': list(self.pids), 'roster': [],
                           'confirmed_at': '2026-10-16 10:00:00'},
                  'receipt': {'request_uid': legacy['request_uid'],
                              'event_identity': self.event_identity, 'category_id': self.cid,
                              'revision': 1, 'order_hash': fingerprint(list(self.pids))},
                  'message': '个人赛出场顺序已保存'}
        self.seed_legacy_receipt(legacy, stored)
        seeded = self.snapshot()
        replay = self.request('POST', self.path + '/confirm', legacy, expect=200)
        self.assertTrue(replay['replayed'])
        self.assertEqual(replay['receipt'], stored['receipt'])
        self.assertEqual(replay['draw'], stored['draw'])
        self.assertEqual(replay['message'], stored['message'])
        self.assertEqual(self.snapshot(), seeded)               # 重放不重新写正式签表
        self.assertEqual(self.ok('GET', self.path + '/requests/' + legacy['request_uid']),
                         {'ok': True, 'found': True, 'receipt': stored['receipt']})
        self.err('POST', self.path + '/confirm', {**legacy, 'base_revision': 7},
                 expect=409, code='request_uid_reused')
        self.assertEqual(self.ok('GET', self.path)['draw']['status'], 'none')

    def test_old_official_draw_reader_stays_read_only_and_role_limited(self):
        recorder, viewer = self.make_user('recorder'), self.make_user('viewer')
        self.assertEqual(self.ok('GET', self.path)['draw']['status'], 'none')
        self.request('POST', self.session_path + '/confirm',
                     self.packet(self.drain(self.start()['session'])), expect=200)
        session_order = self.formal_draw()
        for token in (recorder, viewer):
            draw = self.ok('GET', self.path, token=token)['draw']
            self.assertEqual([row['id'] for row in draw['entries']], json.loads(session_order['order_json']))
            self.assertNotIn('roster', draw)
        self.err('GET', f'/api/categories/{self.fx["team_cat"]}/individual-draw', expect=400)


if __name__ == '__main__':
    unittest.main()

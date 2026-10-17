"""会话存储的真实隔离 SQLite 测试：抽取、竞争、失效、损坏与容量边界。"""
import json
import tempfile
import unittest
import uuid
from pathlib import Path

from app import config, db, security
from app import individual_draw_session_store as store
from app.domain.individual_draw import default_pick, pick_one
from app.errors import ApiError


class FixedChooser:
    """按候选列表位置选择（不依赖绝对 ID），并记录随机源调用次数。"""

    def __init__(self, *positions):
        self.positions = list(positions) or [0]
        self.calls = 0

    def choice(self, candidates):
        self.calls += 1
        position = self.positions.pop(0) if len(self.positions) > 1 else self.positions[0]
        return candidates[position % len(candidates)]


class IndividualDrawSessionStoreTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        task = Path(tempfile.mkdtemp(prefix='individual-draw-session-store-'))
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = task, task / 'registry.db', task / 'events'
        db.init_db()

    def setUp(self):
        self.conn = db.connect()
        security.ensure_default_users(self.conn)
        self.user = {'id': 1}
        self.cid = self.make_category()
        self.add_athletes(3)

    def tearDown(self):
        self.conn.close()

    def make_category(self, name='individual-male'):
        """每个用例使用独立赛事，避免跨用例唯一约束冲突。"""
        event_id = db.insert(self.conn, 'events', {'uuid': uuid.uuid4().hex, 'name': name,
                                                   'status': 'draft', 'created_at': db.now(self.conn)})
        group_id = db.insert(self.conn, 'groups', {'event_id': event_id, 'code': 'A', 'name': 'grp'})
        return db.insert(self.conn, 'categories', {'group_id': group_id, 'name': name,
                                                   'gender': 'male', 'kind': 'individual'})

    def add_athletes(self, count, cid=None, prefix='athlete'):
        cid = cid or self.cid
        school_id = db.insert(self.conn, 'schools', {'event_id': 1,
                                                    'name': f'school-{uuid.uuid4().hex[:8]}'})
        made = []
        for index in range(count):
            aid = db.insert(self.conn, 'athletes', {'group_id': 1, 'school_id': school_id,
                                                    'name': f'{prefix}-{index}', 'gender': 'male'})
            made.append(db.insert(self.conn, 'participations', {'category_id': cid, 'athlete_id': aid,
                                                                'status': 'active'}))
        return made

    def error(self, code, fn, *args, **kwargs):
        with self.assertRaises(ApiError) as caught:
            fn(*args, **kwargs)
        self.assertEqual(caught.exception.code, code)
        return caught.exception

    def pick_with(self, chooser, session=None):
        current = store.read(self.conn, self.cid) if session is None else session
        return store.append_pick(self.conn, self.cid, current['session_id'], current['revision'],
                                 self.user, lambda roster, order: pick_one(roster, order, chooser))

    def test_each_pick_appends_exactly_one_and_never_repeats(self):
        participants = [row['id'] for row in store._roster(self.conn, self.cid)]
        data = store.create(self.conn, self.cid, self.user)
        self.assertEqual((data['revision'], data['picked'], data['status']), (1, 0, 'drawing'))
        # 第 1 步取候选中的第 2 位；第 2 步在剩余 2 人中取第 3 位（回绕），最后一人自动补齐。
        chooser = FixedChooser(1, 2)
        seen = []
        for step in range(3):
            data = self.pick_with(chooser)
            seen.append(data['order'][-1])
            self.assertEqual(len(data['order']), step + 1)
            self.assertEqual(data['revision'], step + 2)
            self.assertEqual(len(set(data['order'])), len(data['order']))
        self.assertEqual(seen, [participants[1], participants[0], participants[2]])
        self.assertEqual(chooser.calls, 3)
        self.assertEqual(data['status'], 'complete')
        self.assertTrue(data['can_confirm'])
        self.assertEqual(data['remaining'], 0)

    def test_revision_conflict_and_stale_session_reject_without_writing(self):
        data = store.create(self.conn, self.cid, self.user)
        first = self.pick_with(FixedChooser(0))
        self.error('session_revision_conflict', store.append_pick, self.conn, self.cid,
                   data['session_id'], data['revision'], self.user, default_pick)
        self.assertEqual(store.read(self.conn, self.cid)['order'], first['order'])
        # 名单变化使本轮失效：不再允许继续抽取或确认。
        self.add_athletes(1, prefix='late')
        current = store.read(self.conn, self.cid)
        self.assertTrue(current['stale'])
        self.assertFalse(current['can_pick'])
        self.assertFalse(current['can_confirm'])
        self.error('draw_session_stale', store.append_pick, self.conn, self.cid,
                   current['session_id'], current['revision'], self.user, default_pick)
        self.assertEqual(store.read(self.conn, self.cid)['order'], first['order'])

    def test_second_session_rejected_and_cancel_keeps_formal_draw(self):
        data = store.create(self.conn, self.cid, self.user)
        self.error('draw_session_exists', store.create, self.conn, self.cid, self.user)
        store.cancel(self.conn, self.cid, data['session_id'], data['revision'], self.user)
        self.assertIsNone(store.read(self.conn, self.cid))
        self.assertIsNone(db.q1(self.conn, 'SELECT category_id FROM individual_draws WHERE category_id=?',
                                (self.cid,)))
        again = store.create(self.conn, self.cid, self.user)
        self.assertEqual(again['picked'], 0)
        self.assertGreater(again['session_id'], data['session_id'])

    def test_incomplete_session_cannot_be_confirmed(self):
        data = store.create(self.conn, self.cid, self.user)
        data = self.pick_with(FixedChooser(0), data)
        self.assertEqual(data['status'], 'drawing')
        self.error('draw_session_incomplete', store.confirm, self.conn, self.cid,
                   data['session_id'], data['revision'], 'uid-incomplete', self.user)
        self.assertIsNone(db.q1(self.conn, 'SELECT category_id FROM individual_draws WHERE category_id=?',
                                (self.cid,)))

    def test_confirm_writes_formal_draw_atomically_and_closes_session(self):
        data = store.create(self.conn, self.cid, self.user)
        chooser = FixedChooser(1, 2, 0)
        while data['status'] == 'drawing':
            data = self.pick_with(chooser, data)
        result = store.confirm(self.conn, self.cid, data['session_id'], data['revision'], 'uid-1', self.user)
        saved = db.q1(self.conn, 'SELECT * FROM individual_draws WHERE category_id=?', (self.cid,))
        self.assertEqual(saved['revision'], 1)
        self.assertEqual(json.loads(saved['order_json']), result['draw']['order'])
        self.assertEqual(saved['request_uid'], 'uid-1')
        self.assertEqual([entry['draw_order'] for entry in result['entries']], [1, 2, 3])
        self.assertIsNone(store.read(self.conn, self.cid))
        self.assertEqual(db.q1(self.conn, 'SELECT status FROM individual_draw_sessions WHERE id=?',
                               (data['session_id'],))['status'], 'confirmed')

    def test_corrupt_session_is_refused_instead_of_reset(self):
        data = store.create(self.conn, self.cid, self.user)
        db.run(self.conn, "UPDATE individual_draw_sessions SET order_json='[999]' WHERE id=?",
               (data['session_id'],))
        self.error('draw_session_corrupt', store.read, self.conn, self.cid)
        db.run(self.conn, "UPDATE individual_draw_sessions SET order_json='[1,1]' WHERE id=?",
               (data['session_id'],))
        self.error('draw_session_corrupt', store.read, self.conn, self.cid)
        db.run(self.conn, "UPDATE individual_draw_sessions SET order_json='[]', roster_hash='' WHERE id=?",
               (data['session_id'],))
        self.error('draw_session_corrupt', store.read, self.conn, self.cid)

    def test_oversized_roster_is_refused_whole_not_truncated(self):
        cid = self.make_category('individual-big')
        self.add_athletes(1, cid)
        oversized = [{'id': i, 'name': 'x' * 500} for i in range(1, 3000)]
        self.error('bad_request', store.encode_roster, oversized)
        self.assertIsNone(store.read(self.conn, cid))

    def test_locked_category_cannot_start_or_continue(self):
        data = store.create(self.conn, self.cid, self.user)
        row = db.q1(self.conn, 'SELECT id FROM participations WHERE category_id=? ORDER BY id', (self.cid,))
        db.insert(self.conn, 'settings', {'k': f"recording:individual:{row['id']}", 'v': '1'})
        current = store.read(self.conn, self.cid)
        self.assertFalse(current['can_pick'])
        self.assertFalse(current['can_confirm'])
        self.assertTrue(current['block_reason'])
        self.error('individual_draw_locked', store.append_pick, self.conn, self.cid,
                   current['session_id'], current['revision'], self.user, default_pick)
        self.assertEqual(store.read(self.conn, data['category_id'])['order'], [])

    def test_independent_categories_keep_independent_sessions(self):
        other = self.make_category('individual-other')
        self.add_athletes(2, other)
        first = store.create(self.conn, self.cid, self.user)
        second = store.create(self.conn, other, self.user)
        self.assertNotEqual(first['session_id'], second['session_id'])
        store.append_pick(self.conn, other, second['session_id'], second['revision'], self.user,
                          lambda roster, order: pick_one(roster, order, FixedChooser(0)))
        self.assertEqual(store.read(self.conn, self.cid)['order'], [])
        self.assertEqual(len(store.read(self.conn, other)['order']), 1)


if __name__ == '__main__':
    unittest.main()

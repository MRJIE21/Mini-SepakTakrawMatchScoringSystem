"""Display state version must change when stale/missing transitions happen."""
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

from app import db, display_state, display_store


class DisplayStateVersionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='stss-display-state-')
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'event_1.db'
        db.init_db(self.path)
        self.conn = db.connect(self.path)
        self.addCleanup(self.conn.close)
        self._fixture()
        display_store.publish_config(self.conn, 2, {
            'layout': 1, 'mode': 'score', 'poll_ms': 500,
            'slots': [{'match_id': 1, 'label': '1 号场'}],
            'visible_slots': [0],
        })

    def _fixture(self):
        c = self.conn
        c.execute("INSERT INTO events(id, uuid, name) VALUES(1, 'u', '测试赛事')")
        c.execute("INSERT INTO groups(id, event_id, code, name, seq) VALUES(1, 1, 'A', '甲组', 1)")
        c.execute("INSERT INTO categories(id, group_id, gender, kind, name, seq) "
                  "VALUES(1, 1, 'male', 'team', '男子三人赛', 1)")
        c.execute("INSERT INTO schools(id, event_id, name, short_name) VALUES(1, 1, '甲校', '甲')")
        c.execute("INSERT INTO schools(id, event_id, name, short_name) VALUES(2, 1, '乙校', '乙')")
        c.execute("INSERT INTO teams(id, category_id, school_id, name) VALUES(1, 1, 1, '甲队')")
        c.execute("INSERT INTO teams(id, category_id, school_id, name) VALUES(2, 1, 2, '乙队')")
        c.execute("INSERT INTO participations(id, category_id, team_id) VALUES(1, 1, 1)")
        c.execute("INSERT INTO participations(id, category_id, team_id) VALUES(2, 1, 2)")
        c.execute("INSERT INTO plans(id, category_id, name, status, version) VALUES(1, 1, '方案', 'locked', 1)")
        c.execute(
            "INSERT INTO matches(id, category_id, plan_id, plan_version, seq, round_no, round_label, "
            "home_source_type, home_participation, away_source_type, away_participation, "
            "home_actual, away_actual, status, scheduled_at, venue_id) "
            "VALUES(1, 1, 1, 1, 1, 1, '决赛', 'participation', 1, 'participation', 2, 1, 2, 'ready', "
            "'2026-10-20 10:00', NULL)")
        c.execute("INSERT INTO users(id, username, password_hash, salt, display_name, role, active) "
                  "VALUES(2, 'editor', 'x', 'x', '编辑', 'admin', 1)")
        c.commit()

    def _screen(self):
        return {'id': None, 'name': '预览', 'event_id': 1}

    def _set_live(self, expires_minutes=5):
        now = datetime.now()
        db.run(self.conn, 'DELETE FROM display_live WHERE match_id = 1')
        db.insert(self.conn, 'display_live', {
            'match_id': 1, 'revision': 3, 'event_seq': 7, 'status': 'live', 'current_set': 1,
            'home_points': 11, 'away_points': 8, 'home_sets': 0, 'away_sets': 0,
            'sets_json': '[]', 'lineup_hash': '', 'recorder_id': None, 'draft_uid': 'd1',
            'updated_at': (now - timedelta(seconds=5)).strftime('%Y-%m-%d %H:%M:%S'),
            'expires_at': (now + timedelta(minutes=expires_minutes)).strftime('%Y-%m-%d %H:%M:%S'),
        })
        self.conn.commit()

    def test_same_state_has_stable_version_and_live_to_stale_changes_it(self):
        self._set_live()
        live = display_state.build_state(self.conn, self._screen())
        self.assertEqual(live['slots'][0]['status'], 'live')
        again = display_state.build_state(self.conn, self._screen())
        self.assertEqual(live['state_version'], again['state_version'])

        db.run(self.conn, "UPDATE display_live SET expires_at = ? WHERE match_id = 1",
               ((datetime.now() - timedelta(minutes=1)).strftime('%Y-%m-%d %H:%M:%S'),))
        self.conn.commit()
        stale = display_state.build_state(self.conn, self._screen())
        self.assertEqual(stale['slots'][0]['status'], 'stale')
        self.assertNotEqual(live['state_version'], stale['state_version'],
                            'live -> stale must repaint the display')
        self.assertEqual(live['revision'], stale['revision'],
                         'legacy revision alone cannot represent expiry')

    def test_missing_match_changes_version(self):
        self._set_live()
        before = display_state.build_state(self.conn, self._screen())
        db.run(self.conn, 'DELETE FROM matches WHERE id = 1')
        self.conn.commit()
        missing = display_state.build_state(self.conn, self._screen())
        self.assertEqual(missing['slots'][0]['status'], 'missing')
        self.assertNotEqual(before['state_version'], missing['state_version'],
                            'deleted match must repaint the display')

    def test_mode_change_changes_version(self):
        self._set_live()
        before = display_state.build_state(self.conn, self._screen())
        display_store.publish_config(self.conn, 2, {
            'layout': 1, 'mode': 'standby', 'poll_ms': 500,
            'slots': [{'match_id': 1, 'label': '1 号场'}], 'visible_slots': [0],
        })
        standby = display_state.build_state(self.conn, self._screen())
        self.assertEqual(standby['mode'], 'standby')
        self.assertNotEqual(before['state_version'], standby['state_version'])


if __name__ == '__main__':
    unittest.main()

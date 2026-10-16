"""Upgrade real SQLite files without touching live competition data."""
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from app import db, team_rules_store as store
from app.domain import team_rules as rules
from app.errors import ApiError


class EventRulesMigrationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='event-rules-migration-')
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'legacy.db'
        db.init_db(self.path)
        self.conn = db.connect(self.path)
        self.addCleanup(self.conn.close)
        self.event = db.insert(self.conn, 'events', {'name': '原赛事'})
        self.group = db.insert(self.conn, 'groups', {'event_id': self.event, 'code': '甲', 'name': '甲组'})

    def category(self, value=None, gender='male', revision=1):
        return db.insert(self.conn, 'categories', {'group_id': self.group, 'gender': gender, 'kind': 'team',
            'name': gender, 'team_rules_json': rules.canonical(value) if value else None, 'rules_revision': revision})

    def old_schema(self):
        self.conn.execute('DELETE FROM settings WHERE k=?', (store.EVENT_MARKER,))
        self.conn.execute('DROP TRIGGER list_rev_events_update')
        for field in ('team_rules_json', 'team_rules_revision', 'team_rules_state'):
            self.conn.execute(f'ALTER TABLE events DROP COLUMN {field}')

    def upgrade(self):
        self.old_schema()
        db.init_db(self.path)

    def test_equal_rules_and_revision_migrate_and_backup_is_preserved(self):
        value = rules.normalize(); value['max_sets'] = 5
        self.category(value, revision=4); self.category(value, 'female', revision=7)
        self.upgrade()
        current = store.event(self.conn, self.event)
        self.assertEqual((current['rules_state'], current['rules_revision'], current['rules']), ('unified', 7, value))
        backup = Path(str(self.path) + '.before-event-team-rules-v2.db')
        saved = backup.read_bytes()
        old = sqlite3.connect(backup)
        try:
            self.assertNotIn('team_rules_json', [r[1] for r in old.execute('PRAGMA table_info(events)')])
            self.assertEqual(old.execute('SELECT count(*) FROM categories').fetchone()[0], 2)
        finally: old.close()
        db.init_db(self.path)
        self.assertEqual(backup.read_bytes(), saved)
        self.assertEqual(store.event(self.conn, self.event), current)

    def test_mixed_rules_keep_original_project_behavior_until_explicit_unification(self):
        value = rules.normalize(); value['max_sets'] = 5
        male = self.category(value, revision=3); female = self.category(gender='female')
        self.upgrade()
        before = store.event_impact(self.conn, self.event)
        self.assertEqual(before['rules_state'], 'legacy_mixed')
        self.assertEqual(len(before['legacy_rules']), 2)
        self.assertEqual(store.project(self.conn, male)['rules'], value)
        self.assertEqual(store.project(self.conn, female)['rules'], rules.normalize())
        body = {'expected_revision': before['rules_revision'], 'impact_token': before['impact_token']}
        with self.assertRaises(ApiError), db.tx(self.conn):
            store.save_event(self.conn, self.event, rules.normalize(), body)
        with db.tx(self.conn):
            _, changed = store.save_event(self.conn, self.event, rules.normalize(),
                                         {**body, 'acknowledge_legacy_unification': True})
        self.assertTrue(changed)  # The default draft still changes the pending state.
        self.assertEqual(store.event(self.conn, self.event)['rules_state'], 'unified')
        self.assertEqual(store.project(self.conn, male)['rules'], rules.normalize())
        self.assertEqual(json.loads(db.q1(self.conn, 'SELECT team_rules_json FROM categories WHERE id=?', (male,))[0]), value)

    def test_zero_projects_can_configure_before_new_categories_exist(self):
        self.upgrade()
        before = store.event_impact(self.conn, self.event)
        self.assertEqual(before['team_projects'], 0)
        desired = rules.normalize(); desired['max_sets'] = 9
        with db.tx(self.conn):
            store.save_event(self.conn, self.event, desired,
                             {'expected_revision': before['rules_revision'], 'impact_token': before['impact_token']})
        cat = self.category()
        self.assertEqual(store.project(self.conn, cat)['rules'], desired)

    def test_corrupt_legacy_config_rolls_back_entire_migration(self):
        self.category(rules.normalize())
        other = db.insert(self.conn, 'events', {'name': '含异常的另一赛事'})
        group = db.insert(self.conn, 'groups', {'event_id': other, 'code': '乙', 'name': '乙'})
        db.insert(self.conn, 'categories', {'group_id': group, 'gender': 'male', 'kind': 'team',
                                          'name': '异常旧规则', 'team_rules_json': 'null'})
        self.old_schema()
        with self.assertRaises(ApiError): db.init_db(self.path)
        self.assertIsNone(db.q1(self.conn, 'SELECT v FROM settings WHERE k=?', (store.EVENT_MARKER,)))
        self.assertNotIn('team_rules_state', [r['name'] for r in self.conn.execute('PRAGMA table_info(events)')])
        self.assertTrue(Path(str(self.path) + '.before-event-team-rules-v2.db').is_file())

    def test_invalid_existing_backup_is_not_overwritten(self):
        self.old_schema()
        backup = Path(str(self.path) + '.before-event-team-rules-v2.db')
        backup.write_bytes(b'invalid backup; preserve me')
        with self.assertRaises((sqlite3.DatabaseError, RuntimeError)): db.init_db(self.path)
        self.assertEqual(backup.read_bytes(), b'invalid backup; preserve me')
        self.assertIsNone(db.q1(self.conn, 'SELECT v FROM settings WHERE k=?', (store.EVENT_MARKER,)))

    def test_corrupt_event_state_revision_and_json_never_default(self):
        for fields in ({'team_rules_json': 'null'}, {'team_rules_revision': 0},
                       {'team_rules_state': 'unknown'}, {'team_rules_state': 'legacy_mixed', 'team_rules_json': '{}'}):
            with self.subTest(fields=fields):
                with db.tx(self.conn):
                    db.update(self.conn, 'events', self.event, {'team_rules_state': 'unified',
                              'team_rules_json': None, 'team_rules_revision': 1})
                    db.update(self.conn, 'events', self.event, fields)
                    with self.assertRaises(ApiError): store.event(self.conn, self.event)


if __name__ == '__main__': unittest.main()

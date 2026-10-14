"""Regression coverage for edits/restoration as well as new enrollments."""
import unittest
from types import SimpleNamespace

from app import db
from app.api.catalog import update_team, update_participation
from app.errors import ApiError


class RegistrationRulesTest(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect(':memory:')
        from pathlib import Path
        self.conn.executescript((Path(__file__).parents[1] / 'app/schema.sql').read_text(encoding='utf-8'))
        self.event = db.insert(self.conn, 'events', {'name': '赛'})
        self.group = db.insert(self.conn, 'groups', {'event_id': self.event, 'code': 'A', 'name': '甲'})
        self.teamcat = db.insert(self.conn, 'categories', {'group_id': self.group, 'gender': 'male', 'kind': 'team', 'name': '男团'})
        self.indcat = db.insert(self.conn, 'categories', {'group_id': self.group, 'gender': 'male', 'kind': 'individual', 'name': '男单'})
        self.school = db.insert(self.conn, 'schools', {'event_id': self.event, 'name': '校'})
        db.insert(self.conn, 'school_entries', {'event_id': self.event, 'group_id': self.group, 'school_id': self.school})
        self.a = db.insert(self.conn, 'athletes', {'group_id': self.group, 'school_id': self.school, 'name': '甲', 'gender': 'male'})
        self.b = db.insert(self.conn, 'athletes', {'group_id': self.group, 'school_id': self.school, 'name': '乙', 'gender': 'male'})
        self.team = db.insert(self.conn, 'teams', {'category_id': self.teamcat, 'school_id': self.school, 'name': '校'})
        db.insert(self.conn, 'team_members', {'team_id': self.team, 'athlete_id': self.a})
        self.tp = db.insert(self.conn, 'participations', {'category_id': self.teamcat, 'team_id': self.team})

    def tearDown(self):
        self.conn.close()

    def ctx(self, body, **params):
        return SimpleNamespace(conn=self.conn, body=body, params=params, user=None)

    def test_team_edit_cannot_add_an_individual_entrant(self):
        db.insert(self.conn, 'participations', {'category_id': self.indcat, 'athlete_id': self.b})
        with self.assertRaises(ApiError) as raised:
            with db.tx(self.conn):
                update_team(self.ctx({'member_ids': [self.a, self.b]}, team_id=str(self.team)))
        self.assertEqual(raised.exception.code, 'athlete_already_entered')
        self.assertEqual(len(db.q(self.conn, 'SELECT * FROM team_members')), 1)

    def test_restoring_individual_rechecks_double_entry(self):
        ip = db.insert(self.conn, 'participations', {'category_id': self.indcat, 'athlete_id': self.a, 'status': 'withdrawn'})
        with self.assertRaises(ApiError) as raised:
            with db.tx(self.conn):
                update_participation(self.ctx({'status': 'active'}, participation_id=str(ip)))
        self.assertEqual(raised.exception.code, 'athlete_already_entered')
        self.assertEqual(db.q1(self.conn, 'SELECT status FROM participations WHERE id=?', (ip,))['status'], 'withdrawn')


if __name__ == '__main__':
    unittest.main()

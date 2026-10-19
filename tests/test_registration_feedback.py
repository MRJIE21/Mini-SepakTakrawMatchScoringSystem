"""报名页反馈修复：常用号码不得以非法值回填项目号码。"""
from __future__ import annotations

import unittest

import test_imports_exports as fixtures

from app import db
from app.api.catalog import normalize_members
from app.errors import ApiError


class RegistrationFeedbackTest(unittest.TestCase):
    setUpClass = classmethod(fixtures.ImportExportsTest.setUpClass.__func__)
    tearDownClass = classmethod(fixtures.ImportExportsTest.tearDownClass.__func__)
    req = fixtures.ImportExportsTest.req
    login = fixtures.ImportExportsTest.login

    def setUp(self):
        fixtures.ImportExportsTest.setUp(self)
        self.sid = self.req(
            'POST', f"/api/events/{self.event['event_id']}/schools",
            {'name': '反馈测试大学', 'group_id': self.group['id']})['school_id']

    def person(self, name, jersey_no):
        return self.req('POST', f'/api/schools/{self.sid}/athletes', {
            'name': name, 'gender': 'male', 'jersey_no': str(jersey_no)})['athlete_id']

    def normalize(self, members):
        cat = {'id': self.cat['team']['id'], 'kind': 'team', 'gender': 'male', 'name': '男子三人赛',
               'group_id': self.group['id']}
        conn = db.connect(db.event_db_path(self.event['event_id']))
        try:
            return normalize_members(conn, {'members': members}, self.sid, cat)
        finally:
            conn.close()

    def test_illegal_common_number_is_not_backfilled_as_project_number(self):
        ids = {value: self.person(f'号码{value}', value) for value in ('23', '0', '无', '05', '7')}
        members, captain = self.normalize([
            {'athlete_id': ids['23'], 'jersey_no': ''},
            {'athlete_id': ids['0'], 'jersey_no': ''},
            {'athlete_id': ids['无'], 'jersey_no': ''},
            {'athlete_id': ids['05'], 'jersey_no': ''},
            {'athlete_id': ids['7'], 'jersey_no': ''},
        ])
        self.assertIsNone(captain)
        self.assertEqual([item['jersey_no'] for item in members], ['', '', '', '', '7'],
                         '只有合法的 1—20 常用号码可以回填项目号码')

    def test_valid_project_numbers_are_preserved_and_invalid_ones_still_rejected(self):
        athlete = self.person('号码测试', '23')
        members, _ = self.normalize([{'athlete_id': athlete, 'jersey_no': '20'}])
        self.assertEqual(members[0]['jersey_no'], '20')
        members, _ = self.normalize([{'athlete_id': athlete, 'jersey_no': '9'}])
        self.assertEqual(members[0]['jersey_no'], '9')
        with self.assertRaises(ApiError) as raised:
            self.normalize([{'athlete_id': athlete, 'jersey_no': '23'}])
        self.assertEqual(raised.exception.status, 400)
        self.assertIn('1—20', raised.exception.message)


if __name__ == '__main__':
    unittest.main()

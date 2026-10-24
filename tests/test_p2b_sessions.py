"""P2-B REQ-002/003: token hashing migration, session revocation and logout-all."""
import hashlib
import re
import tempfile
import unittest
from pathlib import Path

import test_api
from app import config, db, security

HEX64 = re.compile(r'^[0-9a-f]{64}$')


class SessionSecurityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        task = Path(tempfile.mkdtemp(prefix='p2b-sessions-'))
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = task, task / 'registry.db', task / 'events'
        test_api.ApiTest.setUpClass.__func__(cls)

    tearDownClass = classmethod(test_api.ApiTest.tearDownClass.__func__)

    request = test_api.ApiTest.request
    ok = test_api.ApiTest.ok
    err = test_api.ApiTest.err
    login = test_api.ApiTest.login
    build_event = test_api.ApiTest.build_event

    def setUp(self):
        security.reset_login_limits()
        test_api.ApiTest.setUp(self)
        self.token = self._login('admin', 'admin123')

    def _login(self, username, password):
        return self.request('POST', '/api/login', {'username': username, 'password': password},
                            token='', expect=200)['token']

    def _me(self, token, expect=200):
        return self.request('GET', '/api/me', token=token, expect=expect)

    def _user_tokens(self, user_id):
        conn = db.connect()
        try:
            return [row['token'] for row in conn.execute(
                'SELECT token FROM tokens WHERE user_id = ?', (user_id,)).fetchall()]
        finally:
            conn.close()

    def _create_user(self, username, password='UserPass123'):
        self.ok('POST', '/api/users', {'username': username, 'password': password,
                                       'role': 'viewer', 'display_name': username, 'event_ids': []})
        conn = db.connect()
        try:
            return conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()['id']
        finally:
            conn.close()

    def test_tokens_are_hashed_and_authentication_still_works(self):
        for value in self._user_tokens(1):
            self.assertRegex(value, HEX64)
        self._me(self.token)
        conn = db.connect()
        try:
            hashed = [row['token'] for row in conn.execute('SELECT token FROM tokens').fetchall()]
        finally:
            conn.close()
        self.assertNotIn(self.token, hashed, 'plaintext token must never be stored')

    def test_change_password_revokes_other_sessions_and_keeps_current(self):
        user_id = self._create_user('p2b-changer')
        token_a = self._login('p2b-changer', 'UserPass123')
        token_b = self._login('p2b-changer', 'UserPass123')
        self._me(token_a)
        self._me(token_b)
        self.token = token_a
        result = self.ok('POST', '/api/me/password',
                         {'old_password': 'UserPass123', 'new_password': 'NewPass456'})
        self.assertGreaterEqual(result['revoked_others'], 1)
        self._me(token_a)
        self._me(token_b, expect=401)
        token_new = self._login('p2b-changer', 'NewPass456')
        self._me(token_new)
        conn = db.connect()
        try:
            count = conn.execute("SELECT COUNT(*) AS n FROM audit_logs WHERE action='change_password' "
                                 "AND user_id = ?", (user_id,)).fetchone()['n']
        finally:
            conn.close()
        self.assertGreaterEqual(count, 1)

    def test_logout_all_revokes_every_session(self):
        user_id = self._create_user('p2b-everywhere')
        token_a = self._login('p2b-everywhere', 'UserPass123')
        token_b = self._login('p2b-everywhere', 'UserPass123')
        before = self._user_tokens(user_id)
        self.assertGreaterEqual(len(before), 2)
        self.token = token_a
        result = self.ok('POST', '/api/me/logout-all', {})
        self.assertGreaterEqual(result['revoked'], 2)
        self._me(token_a, expect=401)
        self._me(token_b, expect=401)
        self.assertEqual(self._user_tokens(user_id), [])
        conn = db.connect()
        try:
            count = conn.execute("SELECT COUNT(*) AS n FROM audit_logs WHERE action='logout_all' "
                                 "AND user_id = ?", (user_id,)).fetchone()['n']
        finally:
            conn.close()
        self.assertGreaterEqual(count, 1)

    def test_admin_reset_revokes_all_sessions(self):
        user_id = self._create_user('p2b-reset')
        token = self._login('p2b-reset', 'UserPass123')
        self._me(token)
        result = self.ok('POST', f'/api/users/{user_id}/password', {'password': 'ResetPass789'})
        self.assertGreaterEqual(result['revoked'], 1)
        self._me(token, expect=401)
        self.assertEqual(self._user_tokens(user_id), [])
        self._login('p2b-reset', 'ResetPass789')

    def test_legacy_plaintext_token_migration_is_idempotent(self):
        conn = db.connect()
        try:
            user_id = conn.execute("SELECT id FROM users WHERE username='admin'").fetchone()['id']
            legacy = 'legacy-plain-token-value'
            conn.execute("DELETE FROM tokens WHERE token = ?", (legacy,))
            db.insert(conn, 'tokens', {'token': legacy, 'user_id': user_id,
                                       'expires_at': '2099-01-01 00:00:00', 'expires_at_epoch': 0})
            conn.commit()
            db._migrate_token_hashes(conn)
            migrated = conn.execute('SELECT token FROM tokens WHERE user_id = ?', (user_id,)).fetchall()
            self.assertIn(hashlib.sha256(legacy.encode()).hexdigest(), [row['token'] for row in migrated])
            self.assertNotIn(legacy, [row['token'] for row in migrated])
            before = [row['token'] for row in conn.execute('SELECT token FROM tokens').fetchall()]
            db._migrate_token_hashes(conn)
            after = [row['token'] for row in conn.execute('SELECT token FROM tokens').fetchall()]
            self.assertEqual(before, after, 'migration must be idempotent')
            self.assertIsNotNone(security.user_for_token(conn, legacy),
                                 'existing session must survive hashing migration')
        finally:
            conn.close()

    def test_database_backup_contains_no_plaintext_token(self):
        self._me(self.token)
        # 备份下载的是“当前赛事库”，事件作用域接口需要先选择赛事（X-Event-ID）。
        self.build_event(team_count=0, individual_count=0)
        status, body = self.request('GET', '/api/admin/backup', expect=200, raw=True)
        self.assertEqual(status, 200)
        self.assertNotIn(self.token.encode(), body)


if __name__ == '__main__':
    unittest.main()

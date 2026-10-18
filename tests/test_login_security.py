"""登录失败限流、失败审计与随机初始口令。"""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import test_api
from app import config, db, security


class LoginSecurityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        task = Path(tempfile.mkdtemp(prefix='login-security-'))
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = task, task / 'registry.db', task / 'events'
        test_api.ApiTest.setUpClass.__func__(cls)

    tearDownClass = classmethod(test_api.ApiTest.tearDownClass.__func__)

    request = test_api.ApiTest.request
    login = test_api.ApiTest.login

    def setUp(self):
        security.reset_login_limits()
        test_api.ApiTest.setUp(self)

    def test_repeated_failures_lock_and_success_resets(self):
        for _ in range(4):
            self.request('POST', '/api/login',
                         {'username': 'admin', 'password': 'wrong-pass'}, token='', expect=401)
        locked = self.request('POST', '/api/login',
                              {'username': 'admin', 'password': 'wrong-pass'}, token='', expect=429)
        self.assertEqual(locked['code'], 'login_locked')
        self.assertIn('retry_after', locked.get('detail', {}))
        # 锁定期间正确口令同样被拒绝
        again = self.request('POST', '/api/login',
                             {'username': 'admin', 'password': 'admin123'}, token='', expect=429)
        self.assertEqual(again['code'], 'login_locked')
        # 不同用户名不受该账号锁定影响
        self.request('POST', '/api/login',
                     {'username': 'someone-else', 'password': 'wrong-pass'}, token='', expect=401)
        conn = db.connect(config.DB_PATH)
        try:
            count = conn.execute("SELECT COUNT(*) FROM audit_logs WHERE action='login_failed'").fetchone()[0]
        finally:
            conn.close()
        self.assertGreaterEqual(count, 5)

    def test_success_clears_failures(self):
        for _ in range(4):
            self.request('POST', '/api/login',
                         {'username': 'admin', 'password': 'wrong-pass'}, token='', expect=401)
        self.request('POST', '/api/login',
                     {'username': 'admin', 'password': 'admin123'}, token='', expect=200)
        for _ in range(4):
            self.request('POST', '/api/login',
                         {'username': 'admin', 'password': 'wrong-pass'}, token='', expect=401)
        self.assertEqual(security.login_retry_after('127.0.0.1', 'admin'), 0)

    def test_random_initial_password_replaces_fixed_default(self):
        task = Path(tempfile.mkdtemp(prefix='login-initial-'))
        saved = (config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR)
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = task, task / 'registry.db', task / 'events'
        try:
            saved_env = os.environ.pop('STSS_ADMIN_PASSWORD', None)
            try:
                db.init_db(config.DB_PATH)
                conn = db.connect(config.DB_PATH)
                try:
                    initial = security.ensure_default_users(conn)
                    self.assertIsNotNone(initial)
                    self.assertNotEqual(initial, 'Admin123456')
                    self.assertGreaterEqual(len(initial), 10)
                    self.assertIsNotNone(security.login(conn, 'admin', initial))
                    self.assertIsNone(security.login(conn, 'admin', 'Admin123456'))
                    self.assertIsNone(security.ensure_default_users(conn), '已有账号时不重置口令')
                finally:
                    conn.close()
            finally:
                if saved_env is not None:
                    os.environ['STSS_ADMIN_PASSWORD'] = saved_env
        finally:
            config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = saved

    def test_env_password_still_supported(self):
        task = Path(tempfile.mkdtemp(prefix='login-initial-env-'))
        saved = (config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR)
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = task, task / 'registry.db', task / 'events'
        try:
            with patch.dict(os.environ, {'STSS_ADMIN_PASSWORD': 'EnvPassword123'}):
                db.init_db(config.DB_PATH)
                conn = db.connect(config.DB_PATH)
                try:
                    self.assertIsNone(security.ensure_default_users(conn))
                    self.assertIsNotNone(security.login(conn, 'admin', 'EnvPassword123'))
                finally:
                    conn.close()
        finally:
            config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = saved


if __name__ == '__main__':
    unittest.main()

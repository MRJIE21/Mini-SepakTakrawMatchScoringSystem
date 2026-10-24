"""遗留风险修复回归（上一轮 R1/R7）：
- 事件作用域路由必须显式携带 X-Event-ID，缺失/与路径不一致时拒绝，且不得落到 registry 库；
- 组别结构写自身失效 /api/events 计数缓存（不依赖 HTTP 层按头失效）；
- 赛事库缺失时计数返回 data_error 并写告警，而不是伪装 0 并缓存。
"""
import json
import tempfile
import unittest
from pathlib import Path

import test_api
from app import config, db
from app.api import catalog as catalog_api
from app.http_server import Context


class RemainingRisksTest(unittest.TestCase):
    fixture_schedule = test_api.fixture_schedule

    @classmethod
    def setUpClass(cls):
        task = Path(tempfile.mkdtemp(prefix='remaining-risks-'))
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = task, task / 'registry.db', task / 'events'
        test_api.ApiTest.setUpClass.__func__(cls)

    tearDownClass = classmethod(test_api.ApiTest.tearDownClass.__func__)

    request = test_api.ApiTest.request
    ok = test_api.ApiTest.ok
    login = test_api.ApiTest.login

    def setUp(self):
        test_api.ApiTest.setUp(self)
        self.use_event_database = False
        self.event_headers = {}
        self.token = self.login('admin', 'admin123')
        created = self.ok('POST', '/api/events', {'name': '遗留风险赛事', 'start_date': '2026-10-24'})
        self.event_id = created['event_id']
        self.event_uuid = created['event_uuid']
        self.deployment_id = self.ok('GET', '/api/events')['deployment_id']
        self.event_headers = self._headers_for(self.event_id, self.event_uuid)
        catalog_api.invalidate_event_stats()

    def _headers_for(self, event_id, event_uuid):
        return {'X-Event-ID': str(event_id), 'X-Event-UUID': event_uuid,
                'X-Deployment-ID': self.deployment_id}

    def _without_event_header(self, method, path, body=None, expect=None):
        headers = self.event_headers
        self.event_headers = {}
        try:
            return self.request(method, path, body, expect=expect)
        finally:
            self.event_headers = headers

    def _admin_user(self, conn):
        return dict(db.q1(conn, "SELECT * FROM users WHERE username='admin'"))

    # ------------------------------------------------------------ R1
    def test_event_scope_requires_event_header(self):
        # 无头写组别：400 且 registry 不能出现任何组别行（此前会静默写入 registry）。
        parsed = self._without_event_header(
            'POST', f'/api/events/{self.event_id}/groups',
            {'code': 'GHOST', 'name': '幽灵组'}, expect=400)
        self.assertEqual(parsed['code'], 'missing_event_id', parsed)
        registry = db.connect()
        try:
            count = db.q1(registry, "SELECT COUNT(*) AS n FROM groups WHERE event_id = ?",
                          (self.event_id,))['n']
        finally:
            registry.close()
        self.assertEqual(count, 0, '无 X-Event-ID 的写入不得落到 registry 库')
        # 无头读结构同样拒绝
        parsed = self._without_event_header('GET', f'/api/events/{self.event_id}/structure', expect=400)
        self.assertEqual(parsed['code'], 'missing_event_id', parsed)
        # 带头写入正常落到事件库
        self.ok('POST', f'/api/events/{self.event_id}/groups', {'code': 'E1', 'name': 'E1组'})
        structure = self.ok('GET', f'/api/events/{self.event_id}/structure')
        self.assertIn('E1', [group['code'] for group in structure['groups']])
        # 路径赛事与头部赛事不一致：管理员也必须被拒绝（此前管理员绕过范围校验）。
        other = self.ok('POST', '/api/events', {'name': '另一个赛事'})
        self.event_headers = self._headers_for(other['event_id'], other['event_uuid'])
        try:
            parsed = self.request('GET', f'/api/events/{self.event_id}/structure', expect=409)
        finally:
            self.event_headers = self._headers_for(self.event_id, self.event_uuid)
        self.assertEqual(parsed['code'], 'event_identity_mismatch', parsed)

    # ------------------------------------------------------------ R7（结构写缓存失效）
    def test_group_writes_invalidate_event_stats_cache_without_http_invalidation(self):
        self.ok('GET', '/api/events')   # 预热计数缓存
        cache_key = catalog_api._stats_cache_key(self.event_id)
        self.assertIn(cache_key, catalog_api._EVENT_STATS_CACHE)

        # 直接调用处理器（绕过 HTTP 层按 X-Event-ID 的写后失效），验证函数自身失效。
        registry = db.connect()
        try:
            user = self._admin_user(registry)
            ctx = Context(registry, user, {'code': 'F1', 'name': 'F1组'}, {},
                          {'event_id': str(self.event_id)}, {}, 'POST',
                          f'/api/events/{self.event_id}/groups')
            created = catalog_api.create_group(ctx)
        finally:
            registry.close()
        self.assertIn('group_id', created, created)
        self.assertNotIn(cache_key, catalog_api._EVENT_STATS_CACHE,
                         'create_group 必须自行失效赛事计数缓存')

        self.ok('GET', '/api/events')
        self.assertIn(cache_key, catalog_api._EVENT_STATS_CACHE)
        registry = db.connect()
        try:
            user = self._admin_user(registry)
            ctx = Context(registry, user, {'name': 'F1 改名'}, {},
                          {'group_id': str(created['group_id'])}, {}, 'PUT',
                          f"/api/groups/{created['group_id']}")
            catalog_api.update_group(ctx)
        finally:
            registry.close()
        self.assertNotIn(cache_key, catalog_api._EVENT_STATS_CACHE,
                         'update_group 必须自行失效赛事计数缓存')

    # ------------------------------------------------------------ R7（数据源缺失可见）
    def test_missing_event_database_returns_data_error_and_is_not_cached(self):
        self.ok('GET', '/api/events')
        event_db = db.event_db_path(self.event_id)
        self.assertTrue(event_db.is_file(), event_db)
        backup = event_db.with_name(event_db.name + '.missing')
        event_db.rename(backup)
        try:
            catalog_api.invalidate_event_stats()   # 模拟 TTL 过期/显式失效后的下一次读取
            data = self.ok('GET', '/api/events')
            row = next(item for item in data['events'] if item['id'] == self.event_id)
            self.assertEqual(row.get('data_error'), 'event_database_missing', row)
            self.assertEqual((row['categories'], row['schools'], row['finished_matches']), (0, 0, 0))
            self.assertNotIn(catalog_api._stats_cache_key(self.event_id),
                             catalog_api._EVENT_STATS_CACHE,
                             '赛事库缺失时不能缓存伪 0 计数')
        finally:
            backup.rename(event_db)
        # 恢复文件后重新读取，异常标记消失且计数可正常缓存。
        catalog_api.invalidate_event_stats()
        restored = next(item for item in self.ok('GET', '/api/events')['events']
                        if item['id'] == self.event_id)
        self.assertNotIn('data_error', restored, restored)


if __name__ == '__main__':
    unittest.main(verbosity=2)

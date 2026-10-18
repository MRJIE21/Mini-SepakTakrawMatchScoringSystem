"""P2-B REQ-004：/api/events 计数缓存与显式失效（隔离 HTTP + SQLite）。"""
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import test_api
from app import config, db
from app.api import catalog as catalog_api


def event_db_connects(calls):
    """只统计赛事库连接；registry 连接（每线程首次请求）不计入。"""
    return [path for path in calls if Path(path).name.startswith('event_')]


class P2BEventsTest(unittest.TestCase):
    fixture_schedule = test_api.fixture_schedule

    @classmethod
    def setUpClass(cls):
        task = Path(tempfile.mkdtemp(prefix='p2b-events-'))
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = task, task / 'registry.db', task / 'events'
        test_api.ApiTest.setUpClass.__func__(cls)

    tearDownClass = classmethod(test_api.ApiTest.tearDownClass.__func__)

    request = test_api.ApiTest.request
    ok = test_api.ApiTest.ok
    login = test_api.ApiTest.login
    build_event = test_api.ApiTest.build_event

    def setUp(self):
        test_api.ApiTest.setUp(self)
        self.use_event_database = True
        catalog_api.invalidate_event_stats()

    # ------------------------------------------------------------ 工具
    def events(self):
        status, raw = self.request('GET', '/api/events', raw=True)
        self.assertEqual(status, 200, raw)
        return json.loads(raw)

    def counted_get(self, calls):
        """在一次真实请求中记录 db.connect 调用，返回 (events, 赛事库连接列表)。"""
        real_connect = db.connect

        def counting(*args, **kwargs):
            path = args[0] if args else kwargs.get('db_path')
            calls.append(str(path) if path is not None else '')
            return real_connect(*args, **kwargs)

        with patch('app.api.catalog.db.connect', side_effect=counting):
            status, raw = self.request('GET', '/api/events', raw=True)
        self.assertEqual(status, 200, raw)
        return json.loads(raw), event_db_connects(calls)

    def make_events(self, count):
        existing = len(self.events()['events'])
        for index in range(count - existing):
            self.ok('POST', '/api/events', {'name': f'缓存压力赛事{index + 1}'})
        catalog_api.invalidate_event_stats()
        return len(self.events()['events'])

    # ------------------------------------------------------------ 缓存命中
    def test_second_get_uses_cache_and_skips_event_db_connections(self):
        self.build_event(team_count=2, individual_count=0)
        self.ok('POST', '/api/events', {'name': '缓存验证第二赛事'})
        catalog_api.invalidate_event_stats()
        baseline = self.events()
        total = len(baseline['events'])
        self.assertGreaterEqual(total, 2)
        for event in baseline['events']:
            self.assertTrue({'id', 'uuid', 'name', 'categories', 'schools', 'finished_matches'}
                            <= set(event), event)
        self.assertIn('deployment_id', baseline)

        calls = []
        catalog_api.invalidate_event_stats()
        cold, cold_connects = self.counted_get(calls)
        self.assertEqual(len(cold_connects), total, '冷缓存应逐赛事打开赛事库连接')
        self.assertEqual(len(cold['events']), total)
        calls.clear()
        warm, warm_connects = self.counted_get(calls)
        self.assertEqual(warm_connects, [], 'TTL 内第二次请求不得再打开赛事库连接')
        self.assertEqual(warm['events'], cold['events'], '缓存命中时计数与首次一致')

        # 精确失效单个赛事：只重连该赛事。
        target = cold['events'][0]['id']
        catalog_api.invalidate_event_stats(target)
        calls.clear()
        _, single_connects = self.counted_get(calls)
        self.assertEqual(len(single_connects), 1, single_connects)
        self.assertIn(f'event_{target}.db', single_connects[0])

    def test_ttl_expiry_and_zero_ttl_disable_cache(self):
        self.build_event(team_count=2, individual_count=0)
        catalog_api.invalidate_event_stats()
        total = len(self.events()['events'])
        old_ttl = config.EVENT_STATS_TTL
        calls = []
        try:
            catalog_api.invalidate_event_stats()
            _, cold = self.counted_get(calls)
            self.assertEqual(len(cold), total)
            calls.clear()
            _, warm = self.counted_get(calls)
            self.assertEqual(warm, [])

            config.EVENT_STATS_TTL = 0.05
            catalog_api.invalidate_event_stats()
            calls.clear()
            _, first = self.counted_get(calls)
            self.assertEqual(len(first), total)
            time.sleep(0.15)
            calls.clear()
            _, expired = self.counted_get(calls)
            self.assertEqual(len(expired), total, 'TTL 过期后应重新查询计数')

            config.EVENT_STATS_TTL = 0
            catalog_api.invalidate_event_stats()
            for _ in range(2):
                calls.clear()
                _, no_cache = self.counted_get(calls)
                self.assertEqual(len(no_cache), total, 'TTL=0 时每次请求都实时查询')
        finally:
            config.EVENT_STATS_TTL = old_ttl
            catalog_api.invalidate_event_stats()

    # ------------------------------------------------------------ 显式失效
    def test_create_and_rename_event_invalidate_immediately(self):
        warm = self.ok('POST', '/api/events', {'name': '缓存预热赛事'})
        self.events()  # 预热缓存
        self.assertGreater(len(catalog_api._EVENT_STATS_CACHE), 0)
        created = self.ok('POST', '/api/events', {'name': '创建失效验证赛事'})
        event_id = created['event_id']
        self.assertEqual(catalog_api._EVENT_STATS_CACHE, {}, '创建赛事后应清空计数缓存')
        visible = self.events()['events']
        self.assertIn(event_id, [event['id'] for event in visible])
        self.assertIn(warm['event_id'], [event['id'] for event in visible])
        self.assertGreater(len(catalog_api._EVENT_STATS_CACHE), 0)
        self.ok('PUT', f'/api/events/{event_id}', {'name': '改名失效验证赛事'})
        self.assertNotIn(event_id, catalog_api._EVENT_STATS_CACHE, '改名后应按赛事精确失效')
        renamed = {event['id']: event for event in self.events()['events']}[event_id]
        self.assertEqual(renamed['name'], '改名失效验证赛事')

        # 完整建赛（组别/项目/场地一次写入）后计数立即刷新。
        full = self.ok('POST', '/api/events/full', {
            'event': {'name': '完整建赛缓存验证'},
            'groups': [{'name': '测试组', 'code': 'C', 'categories': [
                {'name': '男子三人赛', 'gender': 'male', 'kind': 'team'},
                {'name': '女子个人赛', 'gender': 'female', 'kind': 'individual'},
            ]}],
            'venues': [{'name': '缓存验证场地'}],
        })
        full_event = {event['id']: event for event in self.events()['events']}[full['event_id']]
        self.assertEqual(full_event['categories'], 2)
        self.assertEqual(full_event['schools'], 0)
        self.assertEqual(full_event['finished_matches'], 0)

    # ------------------------------------------------------------ 结构变更立即刷新
    def test_structure_changes_refresh_counts_immediately(self):
        fx = self.build_event(team_count=0, individual_count=0)
        self.events()  # 预热：此时已缓存该赛事的 categories/schools 计数
        before = {event['id']: event for event in self.events()['events']}[fx['event_id']]
        self.assertEqual(before['categories'], 12)   # bootstrap 建立的甲乙丙各 4 项
        self.assertEqual(before['schools'], 1)       # build_event 的乙组隔离学校
        group = self.ok('POST', f"/api/events/{fx['event_id']}/groups",
                        {'code': 'D', 'name': '丁组'})
        self.ok('POST', f"/api/groups/{group['group_id']}/categories",
                {'gender': 'male', 'kind': 'team', 'name': '丁组男子三人赛'})
        created_school = self.ok('POST', f"/api/events/{fx['event_id']}/schools", {
            'name': '缓存结构变更学校', 'group_id': fx['groups']['甲']['id']})
        after = {event['id']: event for event in self.events()['events']}[fx['event_id']]
        self.assertEqual(after['categories'], 13, '新建项目后赛事计数应立即刷新')
        self.assertEqual(after['schools'], 2, '新建学校后赛事计数应立即刷新')
        # 删除刚建的项目/学校也要立即刷新。
        category_ids = self.ok('GET', f"/api/events/{fx['event_id']}/structure")['groups']
        new_category = next(cat for group_row in category_ids
                            for cat in group_row['categories'] if cat['name'] == '丁组男子三人赛')
        self.ok('DELETE', f"/api/categories/{new_category['id']}")
        self.ok('DELETE', f"/api/schools/{created_school['school_id']}")
        restored = {event['id']: event for event in self.events()['events']}[fx['event_id']]
        self.assertEqual(restored['categories'], 12)
        self.assertEqual(restored['schools'], 1)
        # bootstrap 一次性建立组别/项目后同样立即刷新。
        fresh = self.ok('POST', '/api/events', {'name': 'bootstrap 计数刷新赛事'})
        self.events()
        saved_headers = self.event_headers
        self.event_headers = {'X-Event-ID': str(fresh['event_id']),
                              'X-Event-UUID': fresh['event_uuid']}
        try:
            self.ok('POST', f"/api/events/{fresh['event_id']}/bootstrap")
        finally:
            self.event_headers = saved_headers
        booted = {event['id']: event for event in self.events()['events']}[fresh['event_id']]
        self.assertEqual(booted['categories'], 12)

    # ------------------------------------------------------------ 权限过滤在缓存之外
    def test_viewer_filter_is_applied_after_cache(self):
        first = self.ok('POST', '/api/events', {'name': '过滤验证赛事甲'})
        second = self.ok('POST', '/api/events', {'name': '过滤验证赛事乙'})
        viewer = self.ok('POST', '/api/users', {
            'username': 'p2b-events-viewer', 'password': 'ViewerPass123', 'role': 'viewer',
            'display_name': '事件列表只读', 'event_ids': [first['event_id']]})
        token = self.login('p2b-events-viewer', 'ViewerPass123')
        catalog_api.invalidate_event_stats()
        admin_ids = [event['id'] for event in self.events()['events']]   # 先预热全部计数
        self.assertIn(second['event_id'], admin_ids)
        status, raw = self.request('GET', '/api/events', token=token, raw=True)
        self.assertEqual(status, 200, raw)
        viewer_ids = [event['id'] for event in json.loads(raw)['events']]
        self.assertEqual(viewer_ids, [first['event_id']], '只读账号只看到已分配赛事')
        again = [event['id'] for event in self.events()['events']]
        self.assertEqual(again, admin_ids, '缓存不得保存已按角色过滤的结果')
        # 账号赛事分配变化后，下一次读取立即按新分配过滤（缓存不保存过滤结果）。
        self.ok('PUT', f"/api/users/{viewer['user_id']}",
                {'event_ids': [first['event_id'], second['event_id']]})
        status, raw = self.request('GET', '/api/events', token=token, raw=True)
        self.assertEqual(status, 200, raw)
        assigned = [event['id'] for event in json.loads(raw)['events']]
        self.assertEqual(assigned, [first['event_id'], second['event_id']])

    # ------------------------------------------------------------ 扩展性
    def test_ten_events_constant_connections_and_timing(self):
        total = self.make_events(10)
        self.assertGreaterEqual(total, 10)
        cold_times, warm_times, cold_connects, warm_connects = [], [], [], []
        for _ in range(4):
            calls = []
            catalog_api.invalidate_event_stats()
            start = time.perf_counter()
            _, connect_paths = self.counted_get(calls)
            cold_times.append(time.perf_counter() - start)
            cold_connects.append(len(connect_paths))
        catalog_api.invalidate_event_stats()
        self.counted_get([])
        for _ in range(4):
            calls = []
            start = time.perf_counter()
            _, connect_paths = self.counted_get(calls)
            warm_times.append(time.perf_counter() - start)
            warm_connects.append(len(connect_paths))
        cold_median = sorted(cold_times)[len(cold_times) // 2]
        warm_median = sorted(warm_times)[len(warm_times) // 2]
        print(json.dumps({'events': total, 'cold_median_ms': round(cold_median * 1000, 2),
                          'warm_median_ms': round(warm_median * 1000, 2),
                          'cold_connects': cold_connects, 'warm_connects': warm_connects}))
        self.assertTrue(all(count == total for count in cold_connects), cold_connects)
        self.assertTrue(all(count == 0 for count in warm_connects), warm_connects)
        # 计划值不随赛事数线性增长：10 赛事热缓存不再打开连接；慢机器上再比较耗时。
        if cold_median >= 0.004:
            self.assertLess(warm_median, cold_median, {'cold': cold_times, 'warm': warm_times})


if __name__ == '__main__':
    unittest.main(verbosity=2)

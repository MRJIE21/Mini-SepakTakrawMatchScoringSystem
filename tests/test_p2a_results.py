"""P2-A 业务成绩组：REQ-008 未开赛名次单一口径 + REQ-011 打印名次分组。

三类黄金用例：完全未开赛组（不产生名次）、已开赛但全 0 分（仍按现规则排名）、
正常有积分组；页面接口、CSV、XLSX 与打印公告必须共用 group_started 同一口径。
另验证项目成绩单 desc 只反转已确认名次、待确认名次固定分组追加。
"""
import csv
import io
import re
import tempfile
import unittest
import uuid
from pathlib import Path

import test_api
from app import config, db


def html_cells(page):
    """把打印页第一个表格的每行单元格文本提取为行列表（含表头）。"""
    table_html = page.split('<table', 1)[-1]
    rows = []
    for row_html in re.findall(r'<tr[^>]*>(.*?)</tr>', table_html, flags=re.S):
        cells = [re.sub(r'<[^>]+>', '', cell).strip()
                 for cell in re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', row_html, flags=re.S)]
        if cells:
            rows.append(cells)
    return rows


class P2AResultsTest(unittest.TestCase):
    fixture_schedule = test_api.fixture_schedule

    @classmethod
    def setUpClass(cls):
        task = Path(tempfile.mkdtemp(prefix='p2a-results-'))
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = task, task / 'registry.db', task / 'events'
        test_api.ApiTest.setUpClass.__func__(cls)

    tearDownClass = classmethod(test_api.ApiTest.tearDownClass.__func__)

    request = test_api.ApiTest.request
    ok = test_api.ApiTest.ok
    err = test_api.ApiTest.err
    login = test_api.ApiTest.login
    build_event = test_api.ApiTest.build_event
    build_plan = test_api.ApiTest.build_plan
    match_list = test_api.ApiTest.match_list

    def setUp(self):
        test_api.ApiTest.setUp(self)
        self.use_event_database = True

    # ------------------------------------------------------------ 读取工具
    def group_totals(self, group_id):
        return self.ok('GET', f'/api/groups/{group_id}/school-totals')

    def event_totals(self):
        return self.ok('GET', f"/api/events/{self.fx['event_id']}/school-totals")

    def raw_text(self, path):
        return self.request('GET', path, raw=True)[1].decode('utf-8-sig')

    def csv_rows(self, path):
        return list(csv.reader(io.StringIO(self.raw_text(path))))

    def xlsx_rows(self, path):
        import openpyxl
        raw = self.request('GET', path, raw=True)[1]
        book = openpyxl.load_workbook(io.BytesIO(raw), data_only=True)
        return [list(row) for row in book.active.iter_rows(values_only=True)]

    def notice_cells(self, path):
        return html_cells(self.raw_text(path))

    def submit_individual(self, participation_id, value):
        return self.ok('POST', '/api/scoring/individual', {
            'submission_uid': str(uuid.uuid4()), 'participation_id': participation_id,
            'base_version': 0, 'result_status': 'normal', 'result_value': value,
            'error_count': 0, 'violation_count': 0, 'device': 'P2-A 口径测试',
            'event_identity': dict(self.event_identity),
        })

    # ------------------------------------------------------------ REQ-008 未开赛
    def test_not_started_group_has_no_rank_and_exports_agree(self):
        self.fx = self.build_event(team_count=3, individual_count=0)
        gid = self.fx['groups']['甲']['id']
        data = self.group_totals(gid)
        self.assertFalse(data['started'], '仅报名/仅生成名单没有开赛证据，不能算已开赛')
        self.assertEqual({row['status'] for row in data['rows']}, {'not_started'})
        self.assertTrue(all(row['rank'] is None for row in data['rows']), data['rows'])
        self.assertTrue(all(row['pending'] == [] for row in data['rows']), data['rows'])
        self.assertTrue(all(row['total'] == 0 for row in data['rows']), data['rows'])
        self.assertEqual(data['unresolved'], [])

        # 赛事概览接口复用同一 group_school_totals 结果。
        overview = {item['group']['id']: item for item in self.event_totals()['groups']}
        self.assertFalse(overview[gid]['started'])
        self.assertTrue(all(row['rank'] is None for row in overview[gid]['rows']))

        # CSV：名次列“—”、待确认项目固定 0。
        rows = self.csv_rows(f'/api/exports/school-totals.csv?group_id={gid}')
        self.assertEqual(rows[0][0], '名次')
        self.assertEqual(len(rows), 4)
        for row in rows[1:]:
            self.assertEqual(row[0], '—', row)
            self.assertEqual(row[-1], '0', row)
        # XLSX 与 CSV 同口径。
        xrows = self.xlsx_rows(f'/api/exports/school-totals.xlsx?group_id={gid}')
        for row in xrows[1:]:
            self.assertEqual(row[0], '—', row)
            self.assertEqual(row[-1], 0, row)

        # 打印公告：名次“—”，并给出未开赛说明，不再出现“待确认”名次。
        notice = self.raw_text(f'/api/exports/school-notice.html?group_id={gid}')
        self.assertIn('本组别尚未开赛/无成绩，名次不计入', notice)
        self.assertNotIn('尚有', notice)
        self.assertEqual(notice.count('<tr><td>—</td>'), 3, notice)

    # ------------------------------------------------------------ REQ-008 已开赛全 0
    def test_started_group_with_zero_scores_still_ranked(self):
        self.fx = self.build_event(team_count=3, individual_count=0)
        self.build_plan(self.fx)
        gid = self.fx['groups']['甲']['id']
        # 仅生成/锁定赛程不算开赛。
        self.assertFalse(self.group_totals(gid)['started'])
        match = next(m for m in self.match_list(category_id=self.fx['team_cat'])
                     if m['status'] == 'ready')
        # 领取记录任务即“已开赛”证据（没有任何成绩数据）。
        self.ok('POST', f"/api/recording/match/{match['id']}/claim", {})
        data = self.group_totals(gid)
        self.assertTrue(data['started'])
        self.assertEqual([row['rank'] for row in data['rows']], [1, 2, 3])
        self.assertTrue(all(row['status'] == 'ok' for row in data['rows']))
        self.assertTrue(all(row['total'] == 0 for row in data['rows']))
        rows = self.csv_rows(f'/api/exports/school-totals.csv?group_id={gid}')
        self.assertEqual([row[0] for row in rows[1:]], ['1', '2', '3'])
        notice = self.raw_text(f'/api/exports/school-notice.html?group_id={gid}')
        self.assertIn('尚有 3 项名次未确认', notice)
        self.assertNotIn('本组别尚未开赛/无成绩', notice)

    # ------------------------------------------------------------ REQ-008 正常组
    def test_normal_group_rank_and_exports_agree(self):
        self.fx = self.build_event(team_count=0, individual_count=2)
        gid = self.fx['groups']['甲']['id']
        for pid, value in zip(self.fx['indiv_parts'], (20, 15)):
            self.submit_individual(pid, value)
        self.ok('POST', f"/api/categories/{self.fx['indiv_cat']}/individual-rankings/confirm", {})
        data = self.group_totals(gid)
        self.assertTrue(data['started'])
        self.assertEqual([row['rank'] for row in data['rows']], [1, 2])
        self.assertEqual([row['total'] for row in data['rows']], [9, 7])
        self.assertEqual({row['status'] for row in data['rows']}, {'ok'})
        rows = self.csv_rows(f'/api/exports/school-totals.csv?group_id={gid}')
        self.assertEqual([row[0] for row in rows[1:]], ['1', '2'])
        self.assertEqual({row[-1] for row in rows[1:]}, {'0'})
        xrows = self.xlsx_rows(f'/api/exports/school-totals.xlsx?group_id={gid}')
        self.assertEqual([str(row[0]) for row in xrows[1:]], ['1', '2'])
        notice = self.raw_text(f'/api/exports/school-notice.html?group_id={gid}')
        self.assertIn('尚有 0 项名次未确认', notice)
        self.assertIn('<td>9</td>', notice)
        self.assertIn('<td>7</td>', notice)

    # ------------------------------------------------------------ REQ-011 项目成绩单 desc
    def test_category_notice_desc_reverses_confirmed_and_groups_pending(self):
        self.fx = self.build_event(team_count=4, individual_count=0)
        cat = self.fx['team_cat']
        for pid, rank_no in zip(self.fx['team_parts'][:2], (1, 2)):
            self.ok('POST', f'/api/categories/{cat}/placements', {
                'participation_id': pid, 'rank_no': rank_no, 'confirm': True})
        asc = self.notice_cells(f'/api/exports/category-notice.html?category_id={cat}')
        desc = self.notice_cells(f'/api/exports/category-notice.html?category_id={cat}&order=desc')
        self.assertEqual(asc[0][0], '名次')
        asc_data = asc[1:]
        desc_data = desc[1:]
        self.assertEqual(len(asc_data), 5, asc_data)      # 2 已确认 + 1 分组行 + 2 待确认
        self.assertEqual(len(desc_data), 5, desc_data)
        # 已确认名次：asc 1、2；desc 只反转已确认块 → 2、1。
        self.assertEqual([row[0] for row in asc_data if len(row) > 1][:2], ['1', '2'])
        self.assertEqual([row[0] for row in desc_data if len(row) > 1][:2], ['2', '1'])
        # 待确认行固定追加在最后，两种顺序都保持原始稳定顺序。
        self.assertEqual([row[0] for row in asc_data if len(row) > 1][2:], ['待确认', '待确认'])
        self.assertEqual([row[0] for row in desc_data if len(row) > 1][2:], ['待确认', '待确认'])
        for cells in (asc_data, desc_data):
            separator = [index for index, row in enumerate(cells)
                         if row and row[0] == '待确认名次（不计入）']
            self.assertEqual(separator, [2], cells)
        # desc 不得把待确认名次排到已确认之前。
        self.assertNotEqual(desc_data[0][0], '待确认')

    # ------------------------------------------------------------ REQ-011 学校总分表 desc/分组
    def test_school_notice_desc_reverses_only_confirmed_and_groups_tie_pending(self):
        self.fx = self.build_event(team_count=4, individual_count=0)
        gid = self.fx['groups']['甲']['id']
        conn = db.get_event_conn(self.fx['event_id'])
        try:
            for index, (rank_no, points) in enumerate([(1, 18), (1, 18), (3, 12), (4, 10)]):
                pid = self.fx['team_parts'][index]
                school_id = db.q1(conn,
                                  """SELECT t.school_id FROM participations p
                                     JOIN teams t ON t.id = p.team_id WHERE p.id = ?""",
                                  (pid,))['school_id']
                placement_id = db.insert(conn, 'placements', {
                    'category_id': self.fx['team_cat'], 'participation_id': pid,
                    'rank_no': rank_no, 'status': 'confirmed', 'source': 'manual', 'version': 1})
                db.insert(conn, 'school_points', {
                    'event_id': self.fx['event_id'], 'group_id': gid, 'school_id': school_id,
                    'category_id': self.fx['team_cat'], 'participation_id': pid,
                    'placement_id': placement_id, 'rank_no': rank_no,
                    'base_points': 9, 'multiplier': 2, 'points': points})
            conn.commit()
        finally:
            conn.close()
        data = self.group_totals(gid)
        self.assertTrue(data['started'])
        # 两校总分相同且名次数量相同 → 待确认；另两校正常名次。
        self.assertEqual(
            {row['name']: row['status'] for row in data['rows']},
            {'甲1校': 'tie_pending', '甲2校': 'tie_pending', '甲3校': 'ok', '甲4校': 'ok'})
        asc = self.notice_cells(f'/api/exports/school-notice.html?group_id={gid}')
        desc = self.notice_cells(f'/api/exports/school-notice.html?group_id={gid}&order=desc')
        asc_data, desc_data = asc[1:], desc[1:]

        def order(cells):
            return [(row[0], row[1]) for row in cells if len(row) > 1]

        self.assertEqual(order(asc_data), [('3', '甲3校'), ('4', '甲4校'),
                                           ('待确认', '甲1校'), ('待确认', '甲2校')])
        self.assertEqual(order(desc_data), [('4', '甲4校'), ('3', '甲3校'),
                                            ('待确认', '甲1校'), ('待确认', '甲2校')])
        for cells in (asc_data, desc_data):
            separator = [index for index, row in enumerate(cells)
                         if row and row[0] == '待确认名次（不计入）']
            self.assertEqual(separator, [2], cells)


if __name__ == '__main__':
    unittest.main(verbosity=2)

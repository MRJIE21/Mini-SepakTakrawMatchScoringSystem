"""学校报名模板/填写说明/示例下载与旧模板兼容（真实 HTTP）。"""
from __future__ import annotations

import csv
import io
import json
import unittest
import urllib.request

import test_imports_exports as fixtures

from app.api.school_import import TEMPLATE_HEADERS


class ImportTemplateTest(unittest.TestCase):
    setUpClass = classmethod(fixtures.ImportExportsTest.setUpClass.__func__)
    tearDownClass = classmethod(fixtures.ImportExportsTest.tearDownClass.__func__)
    req = fixtures.ImportExportsTest.req
    login = fixtures.ImportExportsTest.login

    def setUp(self):
        fixtures.ImportExportsTest.setUp(self)
        self.sid = self.req(
            'POST', f"/api/events/{self.event['event_id']}/schools",
            {'name': '模板验证大学', 'group_id': self.group['id']})['school_id']

    def download(self, path):
        request = urllib.request.Request(self.base + path)
        request.add_header('Authorization', 'Bearer ' + self.token)
        for key, value in self.headers.items():
            request.add_header(key, value)
        response = urllib.request.urlopen(request)
        return response.status, dict(response.headers), response.read()

    def payload(self):
        snapshot = self.req('GET', f'/api/schools/{self.sid}/registration-workspace')
        return dict(event_identity=snapshot['event_identity'], base_hash=snapshot['base_hash'],
                    people=[], projects=[])

    def rows_of(self, body):
        text = body.decode('utf-8-sig')
        return list(csv.reader(io.StringIO(text, newline='')))

    def test_minimal_template_headers_filename_and_rows(self):
        status, headers, body = self.download(f'/api/schools/{self.sid}/registration-import-template.csv')
        self.assertEqual(status, 200)
        self.assertIn('text/csv', headers['Content-Type'])
        disposition = headers['Content-Disposition']
        self.assertIn("filename*=UTF-8''", disposition)
        self.assertIn('_报名表_', urllib.request.unquote(disposition))
        self.assertTrue(body.startswith(b'\xef\xbb\xbf'), '模板需带 BOM 便于 Excel 打开')
        rows = self.rows_of(body)
        self.assertEqual(rows[0], TEMPLATE_HEADERS)
        self.assertEqual(len(rows[0]), 8)
        self.assertNotIn('学校', rows[0])
        self.assertNotIn('项目ID', rows[0])
        flat = {cell for row in rows[1:] for cell in row}
        self.assertTrue({'男子三人赛', '男子个人赛'} <= flat, flat)
        for row in rows[1:]:
            self.assertEqual(len(row), 8)

    def test_guide_and_example_downloads(self):
        status, headers, guide = self.download(f'/api/schools/{self.sid}/registration-import-guide.txt')
        self.assertEqual(status, 200)
        self.assertIn('text/plain', headers['Content-Type'])
        self.assertIn('填写说明', urllib.request.unquote(headers['Content-Disposition']))
        text = guide.decode('utf-8')
        for phrase in ('字段说明', '三人赛', '个人赛', '常用号码', '项目号码', '示例', '填写规则'):
            self.assertIn(phrase, text)

        status, headers, body = self.download(f'/api/schools/{self.sid}/registration-import-example.csv')
        self.assertEqual(status, 200)
        decoded_name = urllib.request.unquote(headers['Content-Disposition'])
        self.assertIn('示例_', decoded_name)
        rows = self.rows_of(body)
        self.assertEqual(rows[0], TEMPLATE_HEADERS)
        self.assertGreaterEqual(len(rows), 5)
        self.assertTrue(any('示例' in cell for row in rows for cell in row), '示例表需包含虚构人员')
        preview = self.req('POST', f'/api/schools/{self.sid}/registration-import-preview',
                           dict(self.payload(), csv_text=body.decode('utf-8-sig')))
        self.assertEqual(preview['errors'], [], '示例表需要能被真实预览解析')
        self.assertTrue(preview['items'])

    def test_legacy_fourteen_column_template_still_previews(self):
        header = ['学校', '项目', '项目ID', '参赛选择', '运动员', '性别', '常用号码',
                  '项目号码', '队长', '种子序号', '报名备注', '区分信息', '运动员ID', '同名新建确认']
        team = self.cat['team']
        rows = [header,
                ['模板验证大学', team['name'], str(team['id']), '参加', '旧模板队员', '男', '7', '7', '是', '1', '', '', '', '']]
        buffer = io.StringIO()
        csv.writer(buffer).writerows(rows)
        preview = self.req('POST', f'/api/schools/{self.sid}/registration-import-preview',
                           dict(self.payload(), csv_text=buffer.getvalue()))
        self.assertEqual(preview['errors'], [])
        self.assertIn('旧模板队员', json.dumps(preview['items'], ensure_ascii=False))

    def test_filename_is_sanitized_for_unsafe_school_names(self):
        school = self.req('POST', f"/api/events/{self.event['event_id']}/schools",
                          {'name': '模板/验证:大学*2026', 'group_id': self.group['id']})['school_id']
        status, headers, _ = self.download(f'/api/schools/{school}/registration-import-template.csv')
        self.assertEqual(status, 200)
        decoded = urllib.request.unquote(headers['Content-Disposition'])
        self.assertNotIn('/验证', decoded)
        self.assertIn('_报名表_', decoded)


if __name__ == '__main__':
    unittest.main()

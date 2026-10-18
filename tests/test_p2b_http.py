"""P2-B REQ-001/005: same-origin CORS, security headers and headers case handling."""
import http.client
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import test_api
from app import config, web_security


class HttpSecurityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        task = Path(tempfile.mkdtemp(prefix='p2b-http-'))
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

    def _headers(self, headers):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        try:
            conn.request('GET', '/api/me', headers=headers)
            response = conn.getresponse()
            response.read()
            return {k.lower(): v for k, v in response.getheaders()}, response.status
        finally:
            conn.close()

    def _assert_security_headers(self, headers):
        self.assertEqual(headers.get('x-content-type-options'), 'nosniff')
        self.assertEqual(headers.get('x-frame-options'), 'DENY')
        self.assertEqual(headers.get('content-security-policy'), "frame-ancestors 'none'")
        self.assertEqual(headers.get('referrer-policy'), 'same-origin')

    def test_security_headers_cover_html_401_404_and_api(self):
        anon = self._headers({})
        self.assertEqual(anon[1], 401)
        self._assert_security_headers(anon[0])
        self.assertNotIn('access-control-allow-origin', anon[0])
        token = self.login('admin', 'admin123')
        authed = self._headers({'Authorization': f'Bearer {token}'})
        self.assertEqual(authed[1], 200)
        self._assert_security_headers(authed[0])
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        try:
            conn.request('GET', '/index.html')
            response = conn.getresponse()
            response.read()
            self.assertEqual(response.status, 200)
            self._assert_security_headers({k.lower(): v for k, v in response.getheaders()})
        finally:
            conn.close()
        self.request('GET', '/api/does-not-exist', expect=404)
        self.request('GET', '/api/me', expect=200)

    def test_cross_origin_denied_and_same_origin_allowed(self):
        port = self.port
        headers, status = self._headers({'Origin': f'http://127.0.0.1:{port}'})
        self.assertEqual(status, 401)
        self.assertNotIn('access-control-allow-origin', headers)
        headers, status = self._headers({'Origin': 'http://evil.example'})
        self.assertEqual(status, 403)
        self._assert_security_headers(headers)
        self.assertNotIn('access-control-allow-origin', headers)

    def test_cors_allowlist_echoes_origin_and_vary(self):
        with mock.patch.object(config, 'CORS_ORIGINS', ['http://allowed.example']):
            headers, status = self._headers({'Origin': 'http://allowed.example'})
            self.assertEqual(status, 401)
            self.assertEqual(headers.get('access-control-allow-origin'), 'http://allowed.example')
            self.assertEqual(headers.get('vary'), 'Origin')
            self._assert_security_headers(headers)

    def test_options_preflight_matrix(self):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        try:
            conn.request('OPTIONS', '/api/me', headers={'Origin': 'http://evil.example'})
            response = conn.getresponse()
            response.read()
            self.assertEqual(response.status, 403)
            conn.request('OPTIONS', '/api/me', headers={'Origin': f'http://127.0.0.1:{self.port}'})
            response = conn.getresponse()
            response.read()
            self.assertEqual(response.status, 204)
        finally:
            conn.close()

    def test_lowercase_headers_full_chain(self):
        token = self.login('admin', 'admin123')
        headers = {'authorization': f'Bearer {token}', 'content-type': 'application/json'}
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        try:
            conn.request('GET', '/api/me', headers=headers)
            response = conn.getresponse()
            self.assertEqual(response.status, 200, response.read())
            response.read()
            conn.request('POST', '/api/logout', headers=headers)
            response = conn.getresponse()
            response.read()
            self.assertEqual(response.status, 200)
            conn.request('GET', '/api/me', headers=headers)
            response = conn.getresponse()
            response.read()
            self.assertEqual(response.status, 401, 'lowercase authorization must revoke the token')
        finally:
            conn.close()

    def test_lowercase_event_header_selects_event_database_for_backup_name(self):
        token = self.login('admin', 'admin123')
        fx = self.build_event(team_count=0, individual_count=0)
        event_id = fx['event_id']
        headers = {'authorization': f'Bearer {token}', 'x-event-id': str(event_id)}
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=30)
        try:
            conn.request('GET', '/api/admin/backup', headers=headers)
            response = conn.getresponse()
            body = response.read()
            self.assertEqual(response.status, 200, body[:300])
            disposition = response.getheader('Content-Disposition')
            self.assertIn(f'event_{event_id}_backup', disposition)
        finally:
            conn.close()

    def test_headers_class_is_case_insensitive(self):
        from app.http_server import Headers
        headers = Headers({'x-event-id': '3', 'Authorization': 'Bearer abc'})
        self.assertEqual(headers.get('X-Event-ID'), '3')
        self.assertEqual(headers.get('authorization'), 'Bearer abc')
        self.assertIn('X-EVENT-ID', headers)
        self.assertEqual(web_security.is_same_origin('http://127.0.0.1:8000', '127.0.0.1:8000'), True)
        self.assertEqual(web_security.is_same_origin('http://evil.example', '127.0.0.1:8000'), False)


if __name__ == '__main__':
    unittest.main()

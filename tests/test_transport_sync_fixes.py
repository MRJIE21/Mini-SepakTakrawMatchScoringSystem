"""真实产品接入工厂的资源边界、事务与跨库故障验证。"""
from __future__ import annotations

import concurrent.futures
import http.client
import json
import socket
import sqlite3
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from app import config, db, security
from app.http_server import Handler, Response, create_server, load_routes, route
from app.user_sync import SnapshotWorker

read_started = threading.Event()
read_continue = threading.Event()


@route('GET', r'/api/transport-test/read-snapshot', public=True, scope='registry')
def read_snapshot(ctx):
    before = ctx.conn.execute("SELECT v FROM settings WHERE k='probe_counter'").fetchone()[0]
    read_started.set()
    read_continue.wait(2)
    after = ctx.conn.execute("SELECT v FROM settings WHERE k='probe_counter'").fetchone()[0]
    return {'before': before, 'after': after}


@route('POST', r'/api/transport-test/increment', public=True, scope='registry')
def increment(ctx):
    ctx.conn.execute("UPDATE settings SET v=CAST(v AS INTEGER)+1 WHERE k='probe_counter'")
    return {'saved': True}


class ProbeHandler(Handler):
    def log_message(self, *args):
        pass

    def _send(self, response):
        self.server.released_before_send.append(getattr(db._local, 'conn', None) is None and
                                                not getattr(db._local, 'event_conns', {}))
        super()._send(response)

    def _serve_static(self, path):
        if path == '/large-probe':
            return Response(b'x' * (16 * 1024 * 1024))
        return super()._serve_static(path)


class TransportSyncFixesTest(unittest.TestCase):
    def setUp(self):
        self.old_config = config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR
        self.tmp = tempfile.TemporaryDirectory(prefix='stss_transport_')
        config.DATA_DIR = Path(self.tmp.name)
        config.DB_PATH = config.DATA_DIR / 'registry.db'
        config.EVENTS_DIR = config.DATA_DIR / 'events'
        db.close_thread_connections()
        db.init_db()
        conn = db.connect()
        try:
            self.uid = security.create_user(conn, 'transport_admin', 'Transport123', 'admin', 'Before')
            self.token = security.login(conn, 'transport_admin', 'Transport123')
            for eid in (1, 2):
                conn.execute('INSERT INTO events(id,uuid,name) VALUES(?,?,?)', (eid, str(uuid.uuid4()), f'Probe {eid}'))
                event = dict(db.q1(conn, 'SELECT * FROM events WHERE id=?', (eid,)))
                db.create_event_database(eid, event, conn)
            conn.execute("INSERT INTO settings(k,v) VALUES('probe_counter','0')")
        finally:
            conn.close()
        self.event = db.connect(db.event_db_path(1), existing=True)
        self.event.execute("INSERT INTO groups(id,event_id,code,name) VALUES(1,1,'G','Group')")
        self.event.execute("INSERT INTO categories(id,group_id,gender,kind,name) VALUES(1,1,'male','individual','Individual')")
        self.event.execute("INSERT INTO schools(id,event_id,name) VALUES(1,1,'School')")
        self.event.execute("INSERT INTO athletes(id,group_id,school_id,name,gender) VALUES(1,1,1,'Athlete','male')")
        self.event.execute('INSERT INTO participations(id,category_id,athlete_id) VALUES(1,1,1)')
        self.event.close()
        load_routes()
        self.servers = []
        self.sockets = []
        self.start_server()

    def start_server(self, **limits):
        server = create_server(('127.0.0.1', 0), ProbeHandler, limits=limits, background_sync=False)
        server.released_before_send = []
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.servers.append((server, thread))
        self.server, self.port = server, server.server_port
        return server

    def tearDown(self):
        for sock in self.sockets:
            sock.close()
        for server, thread in self.servers:
            server.shutdown()
            server.server_close()
            thread.join(2)
        db.close_thread_connections()
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = self.old_config
        self.tmp.cleanup()

    def request(self, method, path, body=None, token=None, event=False, protocol='2', actor=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        headers = {'Authorization': f'Bearer {self.token if token is None else token}',
                   'Content-Type': 'application/json'}
        if protocol is not None:
            headers['X-Client-Protocol'] = protocol
        if event:
            headers['X-Event-ID'] = '1'
        if actor is not None:
            headers['X-Actor-ID'] = str(actor)
        try:
            conn.request(method, path, json.dumps(body).encode() if body is not None else None, headers)
            response = conn.getresponse()
            payload = json.loads(response.read())
            return response.status, payload, dict(response.getheaders())
        finally:
            conn.close()

    def raw_socket(self, request):
        sock = socket.create_connection(('127.0.0.1', self.port), timeout=3)
        self.sockets.append(sock)
        sock.sendall(request)
        return sock

    def receive(self, sock):
        data = bytearray()
        while True:
            part = sock.recv(65536)
            if not part:
                return bytes(data)
            data.extend(part)

    def wait_for(self, check, seconds=2):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if check():
                return
            time.sleep(.01)
        self.fail('condition did not become true within deadline')

    def test_normal_100_concurrent_requests_use_product_limits_and_release_db(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=100) as pool:
            results = list(pool.map(lambda _: self.request('GET', '/api/me')[0], range(100)))
        self.assertEqual(results, [200] * 100)
        self.assertLessEqual(self.server.resource_stats()['peak_active'], 32)
        self.assertTrue(all(self.server.released_before_send))

    def test_cached_actor_cannot_use_another_accounts_token(self):
        status, payload, _ = self.request('PUT', f'/api/users/{self.uid}',
                                          {'display_name': 'must not apply'}, actor=self.uid + 100)
        self.assertEqual((status, payload['code'], payload['outcome']), (409, 'account_changed', 'not_committed'))
        conn = db.connect()
        try:
            self.assertEqual(db.q1(conn, 'SELECT display_name FROM users WHERE id=?', (self.uid,))[0], 'Before')
        finally:
            conn.close()
        self.assertEqual(self.request('GET', '/api/me', actor=self.uid)[0], 200)
        self.assertEqual(len(self.server._workers), 32)
        self.assertTrue(self.request('GET', '/api/me')[2]['Connection'].lower() == 'close')

    def test_header_and_body_drips_cannot_extend_absolute_deadline(self):
        self.start_server(header_timeout=.3, body_timeout=.35, idle_timeout=.2)
        for raw, budget in ((b'GET /api/me HTTP/1.1\r\nHost: localhost', .3),
                            (b'POST /api/login HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n{', .35)):
            sock = self.raw_socket(raw)
            stop = threading.Event()
            def drip():
                while not stop.wait(.05):
                    try:
                        sock.sendall(b' ')
                    except OSError:
                        break
            thread = threading.Thread(target=drip, daemon=True)
            thread.start()
            started = time.monotonic()
            data = self.receive(sock)
            stop.set()
            thread.join(1)
            self.assertIn(b'408', data.split(b'\r\n')[0])
            self.assertLess(time.monotonic() - started, budget + .4)

    def test_pending_expires_while_every_worker_is_reading_slow_body(self):
        server = self.start_server(workers=1, pending=2, queue_timeout=.2, body_timeout=1, idle_timeout=2)
        slow = self.raw_socket(b'POST /api/login HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n{')
        self.wait_for(lambda: server.resource_stats()['active'] == 1)
        queued = self.raw_socket(b'POST /api/transport-test/increment HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n{}')
        started = time.monotonic()
        data = self.receive(queued)
        self.assertIn(b'503', data.split(b'\r\n')[0])
        self.assertLess(time.monotonic() - started, .6)
        self.assertEqual(server.resource_stats()['active'], 1)
        self.assertEqual(server.resource_stats()['pending'], 0)
        slow.close()
        self.wait_for(lambda: server.resource_stats()['active'] == 0)
        conn = db.connect()
        try:
            self.assertEqual(db.q1(conn, "SELECT v FROM settings WHERE k='probe_counter'")[0], '0')
        finally:
            conn.close()

    def test_slow_reader_write_deadline_releases_worker(self):
        server = self.start_server(workers=1, write_timeout=.3, idle_timeout=.2)
        sock = socket.socket()
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
        sock.settimeout(3)
        sock.connect(('127.0.0.1', self.port))
        self.sockets.append(sock)
        sock.sendall(b'GET /large-probe HTTP/1.1\r\nHost: localhost\r\n\r\n')
        self.wait_for(lambda: server.resource_stats()['completed'] == 1)
        self.assertEqual(self.request('GET', '/api/me')[0], 200)
        self.assertTrue(all(server.released_before_send))

    def test_bad_framing_and_old_protocol_do_not_enter_business(self):
        data = self.receive(self.raw_socket(b'POST /api/login HTTP/1.1\r\nHost: x\r\nContent-Length: -1\r\n\r\n'))
        self.assertIn(b'400', data.split(b'\r\n')[0])
        data = self.receive(self.raw_socket(b'POST /api/login HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}'))
        self.assertIn(b'400', data.split(b'\r\n')[0])
        status, body, _ = self.request('POST', '/api/scoring/submit', {}, event=True, protocol=None)
        self.assertEqual((status, body['code']), (426, 'client_upgrade_required'))
        status, _, _ = self.request('POST', '/api/scoring/submit', {}, event=True)
        self.assertEqual(status, 426)

    def test_busy_event_returns_503_while_user_update_and_login_do_not_wait(self):
        lock = db.connect(db.event_db_path(2), existing=True)
        lock.execute('BEGIN IMMEDIATE')
        try:
            started = time.monotonic()
            self.assertEqual(self.request('PUT', f'/api/users/{self.uid}', {'display_name': 'New'})[0], 200)
            self.assertEqual(self.request('POST', '/api/login', {'username': 'transport_admin', 'password': 'Transport123'})[0], 200)
            self.assertLess(time.monotonic() - started, 1)
        finally:
            lock.execute('ROLLBACK')
            lock.close()
        lock = db.connect(db.event_db_path(1), existing=True)
        lock.execute('BEGIN IMMEDIATE')
        try:
            status, body, headers = self.request('POST', '/api/recording/individual/1/claim', {}, event=True)
            self.assertEqual((status, body['code'], body['outcome']), (503, 'database_busy', 'not_committed'))
            self.assertEqual(headers['Retry-After'], '1')
        finally:
            lock.execute('ROLLBACK')
            lock.close()

    def test_new_actor_and_transfer_target_are_present_before_async_sync(self):
        created = self.request('POST', '/api/users', {'username': 'new_actor', 'password': 'Actor123',
                                                    'role': 'recorder', 'event_ids': [1]})[1]
        token = self.request('POST', '/api/login', {'username': 'new_actor', 'password': 'Actor123'})[1]['token']
        self.assertEqual(self.request('POST', '/api/recording/individual/1/claim', {}, token=token, event=True)[0], 200)
        target = self.request('POST', '/api/users', {'username': 'new_target', 'display_name': 'Target', 'password': 'Actor123',
                                                    'role': 'recorder', 'event_ids': [1]})[1]
        status, result, _ = self.request('POST', '/api/recording/individual/1/transfer',
                                          {'user_id': target['user_id'], 'reason': 'handover'}, event=True)
        self.assertEqual((status, result['recorder_name']), (200, 'Target'))
        conn = db.connect(db.event_db_path(1), existing=True)
        try:
            self.assertIsNotNone(db.q1(conn, 'SELECT id FROM users WHERE id=?', (created['user_id'],)))
            self.assertIsNotNone(db.q1(conn, 'SELECT id FROM users WHERE id=?', (target['user_id'],)))
            self.assertEqual(list(conn.execute('PRAGMA foreign_key_check')), [])
        finally:
            conn.close()

    def change_user(self, **fields):
        conn = db.connect()
        try:
            with db.tx(conn):
                db.update(conn, 'users', self.uid, fields)
                db.sync_user_to_event_databases(conn, self.uid)
        finally:
            conn.close()

    def test_outbox_old_active_and_ack_cannot_overwrite_disabled_new_revision(self):
        worker = SnapshotWorker(config.DB_PATH, config.EVENTS_DIR)
        self.change_user(display_name='Older')
        old_job, old_user = worker._read_jobs(32)[0]
        self.change_user(display_name='Disabled', active=0)
        worker._apply(old_job, old_user)
        worker._ack(old_job, old_user)
        conn = db.connect()
        try:
            self.assertEqual(db.q1(conn, 'SELECT target_revision FROM user_snapshot_outbox WHERE event_id=1')[0], 3)
        finally:
            conn.close()
        worker.run_once()
        worker._apply(old_job, old_user)
        conn = db.connect(db.event_db_path(1), existing=True)
        try:
            row = db.q1(conn, 'SELECT * FROM users WHERE id=?', (self.uid,))
            self.assertEqual((row['snapshot_revision'], row['active'], row['display_name']), (3, 0, 'Disabled'))
        finally:
            conn.close()
        self.assertEqual(self.request('GET', '/api/me')[0], 401)

    def test_commit_then_ack_failure_replays_safely_and_missing_or_wrong_identity_is_visible(self):
        worker = SnapshotWorker(config.DB_PATH, config.EVENTS_DIR)
        self.change_user(display_name='Committed')
        with patch.object(worker, '_ack', side_effect=RuntimeError('crash after event commit')):
            with self.assertRaises(RuntimeError):
                worker.run_once()
        worker.run_once()
        conn = db.connect()
        try:
            self.assertEqual(db.q1(conn, 'SELECT COUNT(*) FROM user_snapshot_outbox')[0], 0)
            db.enqueue_user_snapshot(conn, self.uid)
            conn.execute("UPDATE user_snapshot_outbox SET event_uuid='wrong' WHERE event_id=1")
        finally:
            conn.close()
        db.event_db_path(2).unlink()
        worker.run_once()
        conn = db.connect()
        try:
            errors = db.q(conn, 'SELECT last_error FROM user_snapshot_outbox ORDER BY event_id')
            self.assertEqual(len(errors), 2)
            self.assertIn('身份', errors[0][0])
            self.assertIn('不存在', errors[1][0])
            self.assertFalse(db.event_db_path(2).exists())
        finally:
            conn.close()

    def test_deferred_foreign_key_commit_failure_rolls_back_original_transaction(self):
        conn = db.connect(':memory:')
        conn.execute('CREATE TABLE parent(id INTEGER PRIMARY KEY)')
        conn.execute('CREATE TABLE child(pid INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)')
        try:
            with self.assertRaises(sqlite3.IntegrityError):
                with db.tx(conn):
                    conn.execute('INSERT INTO child(pid) VALUES(999)')
            self.assertFalse(conn.in_transaction)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM child').fetchone()[0], 0)
        finally:
            conn.close()

    def test_http_read_materialization_uses_one_snapshot(self):
        read_started.clear()
        read_continue.clear()
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            response = pool.submit(self.request, 'GET', '/api/transport-test/read-snapshot')
            self.assertTrue(read_started.wait(2))
            conn = db.connect()
            try:
                conn.execute("UPDATE settings SET v='1' WHERE k='probe_counter'")
            finally:
                conn.close()
            read_continue.set()
            status, payload, _ = response.result(timeout=3)
        self.assertEqual((status, payload['before'], payload['after']), (200, '0', '0'))
        self.assertTrue(all(self.server.released_before_send))

    def test_login_rechecks_disable_after_password_work_outside_write_transaction(self):
        original = security.verify_password
        def verify_then_disable(*args):
            valid = original(*args)
            self.change_user(active=0)
            return valid
        with patch.object(security, 'verify_password', side_effect=verify_then_disable):
            status, _, _ = self.request('POST', '/api/login', {'username': 'transport_admin', 'password': 'Transport123'})
        self.assertEqual(status, 401)
        conn = db.connect()
        try:
            self.assertEqual(db.q1(conn, 'SELECT COUNT(*) FROM tokens')[0], 1)
        finally:
            conn.close()

    def test_background_worker_stops_with_busy_event_and_resumes_pending_job(self):
        lock = db.connect(db.event_db_path(2), existing=True)
        lock.execute('BEGIN IMMEDIATE')
        server = create_server(('127.0.0.1', 0), ProbeHandler,
                               limits={'workers': 2, 'pending': 4}, background_sync=True)
        server.released_before_send = []
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.servers.append((server, thread))
        try:
            self.wait_for(lambda: server._sync is not None)
            worker = server._sync
            self.wait_for(lambda: (self._outbox_attempts(2) or 0) > 0)
            started = time.monotonic()
            server.shutdown()
            server.server_close()
            thread.join(1)
            self.assertLess(time.monotonic() - started, 1.5)
            self.assertFalse(worker._thread.is_alive())
            self.assertTrue(all(not t.is_alive() for t in server._workers))
            self.assertIsNotNone(self._outbox_attempts(2))
        finally:
            lock.execute('ROLLBACK')
            lock.close()
        conn = db.connect()
        try:
            conn.execute('UPDATE user_snapshot_outbox SET next_attempt_at=0')
        finally:
            conn.close()
        SnapshotWorker(config.DB_PATH, config.EVENTS_DIR).run_once()
        self.assertIsNone(self._outbox_attempts(2))

    def _outbox_attempts(self, eid):
        conn = db.connect()
        try:
            row = db.q1(conn, 'SELECT attempts FROM user_snapshot_outbox WHERE event_id=? LIMIT 1', (eid,))
            return row[0] if row else None
        finally:
            conn.close()


if __name__ == '__main__':
    unittest.main()

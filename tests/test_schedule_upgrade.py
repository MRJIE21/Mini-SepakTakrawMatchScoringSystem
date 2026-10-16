"""Real startup against a pre-stage-schema copy; IDs, passwords and results survive."""
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.request

from app import db, security, team_rules_store

ROOT = Path(__file__).resolve().parents[1]


class ScheduleUpgradeTest(unittest.TestCase):
    def test_old_event_copy_restarts_twice_without_rewriting_accounts_or_results(self):
        with tempfile.TemporaryDirectory(prefix='schedule-upgrade-') as temporary:
            data = Path(temporary)
            registry = data / 'registry.db'
            schema = (ROOT / 'app/schema.sql').read_text(encoding='utf-8')
            schema = '\n'.join(line for line in schema.splitlines() if not re.match(
                r'\s*(schedule_role|schedule_revision|winner_rank|loser_rank)\s', line))
            conn = db.connect(registry)
            conn.executescript(schema)
            security.create_user(conn, 'admin', 'ScheduleUpgrade123', 'admin', '迁移验证管理员')
            user = dict(db.q1(conn, 'SELECT * FROM users'))
            deployment = 'schedule-upgrade-deployment'
            db.insert(conn, 'settings', {'k': 'deployment_id', 'v': deployment})
            eid = db.insert(conn, 'events', {'name': '历史赛事副本', 'uuid': 'schedule-upgrade-event'})
            gid = db.insert(conn, 'groups', {'event_id': eid, 'name': 'A', 'code': 'A'})
            cid = db.insert(conn, 'categories', {'group_id': gid, 'name': '男子三人赛', 'kind': 'team', 'gender': 'male'})
            parts = []
            for name in ('甲校', '乙校'):
                sid = db.insert(conn, 'schools', {'event_id': eid, 'name': name})
                tid = db.insert(conn, 'teams', {'category_id': cid, 'school_id': sid, 'name': name})
                parts.append(db.insert(conn, 'participations', {'category_id': cid, 'team_id': tid}))
            plan = db.insert(conn, 'plans', {'category_id': cid, 'name': '旧正式赛程', 'status': 'locked'})
            stage = db.insert(conn, 'stages', {'plan_id': plan, 'seq': 1, 'name': '旧比赛', 'kind': 'custom'})
            mid = db.insert(conn, 'matches', {'category_id': cid, 'plan_id': plan, 'stage_id': stage,
                'home_source_type': 'participation', 'home_participation': parts[0], 'home_actual': parts[0],
                'away_source_type': 'participation', 'away_participation': parts[1], 'away_actual': parts[1],
                'status': 'finished', 'result_status': 'normal', 'result_version': 2})
            for no in (1, 2): db.insert(conn, 'match_sets', {'match_id': mid, 'set_no': no, 'home_points': 15, 'away_points': 8, 'winner_side': 'home'})
            db.insert(conn, 'placements', {'category_id': cid, 'participation_id': parts[0], 'rank_no': 1,
                'source': 'manual', 'status': 'confirmed', 'note': '现场确认'})
            # Reproduce the already-frozen rules of the prior 1.1.6 release.
            # This prepares only its rules migration, not the new schedule columns.
            team_rules_store.install(conn)
            match_before = dict(db.q1(conn, 'SELECT * FROM matches WHERE id=?', (mid,)))
            sets_before = db.rows_to_dicts(db.q(conn, 'SELECT * FROM match_sets ORDER BY id'))
            events_dir = data / 'events'; events_dir.mkdir()
            event_path = events_dir / f'event_{eid}.db'
            target = db.connect(event_path); conn.backup(target); target.close(); conn.close()
            env = {**os.environ, 'STSS_DATA_DIR': str(data), 'STSS_DB': str(registry), 'STSS_EVENTS_DIR': str(events_dir), 'PYTHONUTF8': '1'}
            for _ in range(2):
                process = subprocess.Popen([sys.executable, '-B', '-u', 'run.py', '--host', '127.0.0.1', '--port', '0'], cwd=ROOT,
                    env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8',
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
                lines = queue.Queue()
                def read_output(stream):
                    for line in stream: lines.put(line)
                reader = threading.Thread(target=read_output, args=(process.stdout,), daemon=True); reader.start()
                output = []
                try:
                    port = None
                    for _line in range(20):
                        line = lines.get(timeout=10); output.append(line)
                        match = re.search(r'http://127\.0\.0\.1:(\d+)', line)
                        if match: port = int(match[1]); break
                    self.assertIsNotNone(port, ''.join(output))
                    def request(path, body=None, token=None):
                        headers = {'Content-Type': 'application/json', 'X-Client-Protocol': '2'}
                        if token: headers.update(Authorization=f'Bearer {token}', **{'X-Event-ID': str(eid), 'X-Event-UUID': 'schedule-upgrade-event'})
                        req = urllib.request.Request(f'http://127.0.0.1:{port}' + path,
                            data=json.dumps(body).encode() if body is not None else None, headers=headers)
                        with urllib.request.urlopen(req, timeout=10) as response: return json.load(response)
                    token = request('/api/login', {'username': 'admin', 'password': 'ScheduleUpgrade123'})['token']
                    saved = request(f'/api/matches/{mid}', token=token)['match']
                    self.assertEqual((saved['id'], saved['result_version'], saved['public_code']), (mid, 2, f'M{mid:03d}'))
                finally:
                    process.terminate(); process.wait(timeout=10); process.stdout.close(); reader.join(timeout=2)
            conn = db.connect(event_path)
            try:
                saved = dict(db.q1(conn, 'SELECT * FROM matches WHERE id=?', (mid,)))
                self.assertEqual({k: saved[k] for k in match_before}, match_before)
                self.assertEqual(saved['schedule_revision'], 1)
                self.assertEqual(db.rows_to_dicts(db.q(conn, 'SELECT * FROM match_sets ORDER BY id')), sets_before)
                self.assertEqual(db.q1(conn, 'SELECT rank_no,status,source FROM placements')[0:3], (1, 'confirmed', 'manual'))
                self.assertEqual(conn.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
                self.assertEqual(conn.execute('PRAGMA foreign_key_check').fetchall(), [])
            finally: conn.close()
            conn = db.connect(registry)
            try:
                after = db.q1(conn, 'SELECT * FROM users WHERE id=?', (user['id'],))
                for key in ('id', 'username', 'salt', 'password_hash', 'role', 'active'): self.assertEqual(after[key], user[key])
            finally: conn.close()


if __name__ == '__main__': unittest.main()

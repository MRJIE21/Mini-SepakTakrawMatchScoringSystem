"""Request-local, read-only lookup cache for match serialization.

Keep the single-match rules as the source of truth, while bulk-fetching the
relations those rules read. Unknown queries fall through to the same snapshot.
"""
from __future__ import annotations

import re
from collections import defaultdict

from .. import db


class _Rows:
    def __init__(self, rows):
        self.rows = list(rows)

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows


class BatchReadConnection:
    def __init__(self, conn, matches, with_sets):
        self.conn = conn
        self.matches = {r['id']: dict(r) for r in matches}
        mids = list(self.matches)
        source_ids = {r.get(f'{side}_source_match') for r in self.matches.values()
                      for side in ('home', 'away')} - {None}
        seen = set(mids)
        missing = source_ids - seen
        while missing:
            seen.update(missing)
            loaded = self._in('SELECT * FROM matches WHERE id IN', missing)
            for row in loaded:
                self.matches[row['id']] = dict(row)
                source_ids.update(row[f'{side}_source_match'] for side in ('home', 'away')
                                  if row[f'{side}_source_match'])
            missing = source_ids - seen
        selected = [self.matches[mid] for mid in mids]
        self.plans = self._map('plans', {r['plan_id'] for r in self.matches.values()})
        self.stages = self._map('stages', {r['stage_id'] for r in self.matches.values()})
        self.venues = self._map('venues', {r['venue_id'] for r in selected if r['venue_id']})
        pool_ids = {r.get(f'{side}_source_pool') for r in self.matches.values()
                    for side in ('home', 'away')} - {None}
        self.pools = self._map('pools', pool_ids)
        self.snapshots = self._in('SELECT * FROM pool_rank_snapshots WHERE pool_id IN', pool_ids)
        self.pool_matches = defaultdict(list)
        for row in self._in('SELECT * FROM matches WHERE pool_id IN', pool_ids):
            self.pool_matches[row['pool_id']].append(dict(row))
        pids = {r.get(f'{side}_{field}') for r in selected
                for side in ('home', 'away') for field in ('actual', 'participation')} - {None}
        self.labels = {r['id']: dict(r) for r in self._in('''SELECT p.id,p.team_id,
            COALESCE(t.name,a.name) AS subject, COALESCE(NULLIF(s.short_name,''),s.name) AS school
            FROM participations p LEFT JOIN teams t ON t.id=p.team_id
            LEFT JOIN athletes a ON a.id=p.athlete_id
            LEFT JOIN schools s ON s.id=COALESCE(t.school_id,a.school_id) WHERE p.id IN''', pids)}
        self.sets = defaultdict(list)
        set_ids = source_ids | (set(mids) if with_sets else set())
        for row in self._in('SELECT * FROM match_sets WHERE match_id IN', set_ids,
                            ' ORDER BY match_id,set_no'):
            self.sets[row['match_id']].append(dict(row))
        self.authors = defaultdict(list)
        for row in self._in('''SELECT s.match_id,s.user_id,u.display_name FROM submissions s
            LEFT JOIN users u ON u.id=s.user_id WHERE s.match_id IN''', mids, ' ORDER BY s.id'):
            self.authors[row['match_id']].append(dict(row))
        self.corrections = {}
        for row in self._in('''SELECT a.entity_id,u.display_name FROM audit_logs a
            LEFT JOIN users u ON u.id=a.user_id WHERE a.entity_type='match'
            AND a.action IN ('correct_match','cancel_match') AND a.entity_id IN''', mids,
                            ' ORDER BY a.id'):
            self.corrections[row['entity_id']] = dict(row)
        self.settings = {r['k']: dict(r) for r in self._in(
            'SELECT k,v FROM settings WHERE k IN', [f'recording:match:{mid}' for mid in mids])}
        import json
        owner_ids = set()
        for row in self.settings.values():
            owner_ids.add(json.loads(row['v'])['user_id'])
        self.users = self._map('users', owner_ids)

    def _in(self, prefix, ids, suffix=''):
        ids = list(ids)
        if not ids:
            return []
        rows = []
        for start in range(0, len(ids), 800):
            part = ids[start:start + 800]
            rows.extend(db.q(self.conn, prefix + ' (' + ','.join('?' for _ in part) + ')' + suffix, part))
        return rows

    def _map(self, table, ids):
        return {r['id']: dict(r) for r in self._in(f'SELECT * FROM {table} WHERE id IN', ids)}

    def __getattr__(self, name):
        return getattr(self.conn, name)

    def execute(self, sql, args=()):
        text = re.sub(r'\s+', ' ', sql.strip()).lower()
        key = args[0] if args else None
        row = None
        if text.startswith('select'):
            if 'from participations p' in text and 'where p.id in' in text:
                return _Rows(self.labels[pid] for pid in args if pid in self.labels)
            if 'from submissions s' in text and 's.match_id' in text and len(args) == 1:
                return _Rows(self.authors.get(key, []))
            if 'from matches where pool_id' in text:
                return _Rows(r for r in self.pool_matches.get(key, [])
                             if r.get('reset_state', 'none') in ('none', 'active'))
            if 'from audit_logs a' in text and "a.entity_type='match'" in text:
                row = self.corrections.get(key)
            elif 'from pool_rank_snapshots s' in text and 'join pools p' in text:
                pool = self.pools.get(key)
                row = next((s for s in self.snapshots if s['pool_id'] == key
                            and s['rank_no'] == args[1] and s['status'] == 'confirmed'
                            and pool and pool['status'] == 'confirmed'), None)
            elif 'from match_sets where match_id' in text:
                return _Rows(self.sets.get(key, []))
            elif 'from settings where k' in text:
                row = self.settings.get(key)
            elif 'from users where id' in text:
                row = self.users.get(key)
            else:
                for table, lookup in (('plans', self.plans), ('stages', self.stages),
                                      ('venues', self.venues), ('matches', self.matches),
                                      ('pools', self.pools)):
                    if f'from {table} where id' in text:
                        row = lookup.get(key)
                        if row and table == 'stages' and len(args) > 1 and row['plan_id'] != args[1]:
                            row = None
                        break
                else:
                    return self.conn.execute(sql, args)
            return _Rows([row] if row else [])
        return self.conn.execute(sql, args)

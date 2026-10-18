"""Test-only helper: seed or expire a display_live row in an isolated database."""
import sqlite3
import sys
from datetime import datetime, timedelta


def main():
    db_path, action = sys.argv[1], sys.argv[2]
    conn = sqlite3.connect(db_path)
    try:
        if action == 'live':
            now = datetime.now()
            conn.execute('DELETE FROM display_live WHERE match_id = 1')
            conn.execute(
                "INSERT INTO display_live(match_id, revision, event_seq, status, current_set, "
                "home_points, away_points, home_sets, away_sets, sets_json, lineup_hash, recorder_id, "
                "draft_uid, updated_at, expires_at) VALUES(1, 4, 9, 'live', 1, 9, 6, 0, 0, '[]', '', NULL, "
                "'browser-live', ?, ?)",
                ((now - timedelta(seconds=2)).strftime('%Y-%m-%d %H:%M:%S'),
                 (now + timedelta(minutes=5)).strftime('%Y-%m-%d %H:%M:%S')))
        elif action == 'expire':
            conn.execute("UPDATE display_live SET expires_at = ? WHERE match_id = 1",
                         ((datetime.now() - timedelta(minutes=1)).strftime('%Y-%m-%d %H:%M:%S'),))
        elif action == 'release':
            conn.execute("DELETE FROM settings WHERE k = 'recording:match:1'")
        else:
            raise SystemExit('unknown action: ' + action)
        conn.commit()
    finally:
        conn.close()


if __name__ == '__main__':
    main()

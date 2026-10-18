"""Consistent SQLite online backups, kept outside live database directories.

Pre-upgrade snapshots used to be written next to the live database as
``<db>.before-*.db``.  That made the startup scanner mistake them for event
databases and migrate them again (and again on every restart).  All backups now
live under ``config.BACKUPS_DIR`` with an explicit timestamp and are never
scanned as event databases.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from . import config


def source_path(conn: sqlite3.Connection) -> Path | None:
    """Return the main database file for a live connection."""
    row = conn.execute('PRAGMA database_list').fetchone()
    value = row['file'] if row is not None else None
    return Path(value).resolve() if value else None


def _label(suffix: str) -> str:
    label = suffix.strip().lstrip('.')
    for ext in ('.sqlite', '.db'):
        if label.lower().endswith(ext):
            label = label[: -len(ext)]
            break
    return ''.join(ch if ch.isalnum() or ch in '-_.' else '-' for ch in label) or 'before-upgrade'


def _validate(path: Path) -> None:
    """A migration backup must at least be a complete, readable SQLite file."""
    try:
        saved = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)
        try:
            if saved.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('升级前备份无效，请保留文件并核对：' + str(path))
        finally:
            saved.close()
    except sqlite3.DatabaseError as exc:
        raise RuntimeError('升级前备份无法读取，请保留文件并核对：' + str(path)) from exc


def backups_root(source: Path) -> Path:
    """Where backups for this database belong.

    Production databases live under the configured data directory and use the
    shared ``config.backups_dir()``.  Unit tests and one-off migrations often
    open a temporary database outside that directory; in that case keep the
    snapshot beside the temporary database so tests never write into real data.
    """
    resolved = source.resolve()
    try:
        if resolved == config.DB_PATH.resolve() or resolved.parent == config.EVENTS_DIR.resolve():
            return config.backups_dir()
    except OSError:
        pass
    return resolved.parent / 'backups'


def online_backup(conn: sqlite3.Connection, suffix: str) -> Path | None:
    """Create (or reuse) a validated pre-upgrade snapshot outside live dirs.

    The first valid snapshot for a database+label is preserved on retries, so a
    failed migration can be retried against the same rollback point.
    """
    source = source_path(conn)
    if source is None:
        return None
    label = _label(suffix)
    backups = backups_root(source)
    backups.mkdir(parents=True, exist_ok=True)
    existing = sorted(backups.glob(f'{source.stem}-{label}-*.db'))
    for candidate in existing:
        _validate(candidate)
        return candidate
    stamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S-%f')
    target = backups / f'{source.stem}-{label}-{stamp}.db'
    temporary = target.with_name(target.name + '.tmp')
    destination = sqlite3.connect(temporary)
    try:
        conn.backup(destination)
    finally:
        destination.close()
    try:
        _validate(temporary)
        temporary.replace(target)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return target

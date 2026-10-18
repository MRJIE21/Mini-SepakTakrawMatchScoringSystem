"""Locate pre-upgrade snapshots written by app.backup.online_backup()."""
from pathlib import Path

from app import backup, config


def backups_root(db_path: Path) -> Path:
    resolved = Path(db_path).resolve()
    if resolved == config.DB_PATH.resolve() or resolved.parent == config.EVENTS_DIR.resolve():
        return config.backups_dir()
    return resolved.parent / 'backups'


def find_backup(db_path: Path, label: str) -> Path | None:
    """Return the first snapshot for *db_path* with migration *label*.

    ``label`` is the old suffix without dots/extension, e.g.
    ``before-display-v1`` or ``before-event-team-rules-v2``.
    """
    stem = Path(db_path).stem
    matches = sorted(backups_root(db_path).glob(f'{stem}-{label}-*.db'))
    return matches[0] if matches else None


def backup_count(db_path: Path, label: str) -> int:
    stem = Path(db_path).stem
    return len(list(backups_root(db_path).glob(f'{stem}-{label}-*.db')))

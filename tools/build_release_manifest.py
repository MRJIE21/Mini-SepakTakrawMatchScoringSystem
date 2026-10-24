#!/usr/bin/env python3
"""重算发布清单 release-manifest.json（发布流水线用）。

用法（产品根目录执行）：
    python tools/build_release_manifest.py
    python tools/build_release_manifest.py --check   # 只校验当前清单是否最新

说明：
- 文件清单 = 产品根目录下除运行数据（保留 data/.gitkeep）、__pycache__/*.pyc、
  release-manifest.json、副本说明.txt 之外的普通文件；按路径排序，记录 sha256 与字节数。
- 版本号取自 package.json。
- 旧清单存在时，将其整体 sha256 记为 previous_release_manifest_sha256；
  previous_release_commit、feature、schema_change、source_manifest_sha256 沿用旧值。
- source_manifest.json 属于上层源码快照工具（仓库外），本脚本不生成它；
  若该文件不存在，保留旧清单中的 source_manifest_sha256 并在输出中提示。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "release-manifest.json"

EXCLUDED_DIRS = {"__pycache__", ".verify-data", "backups", ".git"}
EXCLUDED_FILES = {"release-manifest.json", "副本说明.txt"}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def collect_files() -> list[dict]:
    rows = []
    for path in sorted(ROOT.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(ROOT)
        # 清单描述发布文件；数据库、日志与实例锁会变化或被占用，不能参与构建。
        if relative.parts[0] == "data" and relative.as_posix() != "data/.gitkeep":
            continue
        if any(part in EXCLUDED_DIRS for part in relative.parts):
            continue
        if relative.name in EXCLUDED_FILES or relative.suffix == ".pyc":
            continue
        rows.append({"path": relative.as_posix(), "bytes": path.stat().st_size, "sha256": sha256(path)})
    return rows


def build() -> dict:
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    previous = {}
    previous_hash = ""
    if MANIFEST.is_file():
        raw = MANIFEST.read_bytes()
        previous_hash = hashlib.sha256(raw).hexdigest()
        previous = json.loads(raw.decode("utf-8"))
    source_manifest = ROOT.parent / "src" / "source_manifest.json"
    if source_manifest.is_file():
        source_hash = sha256(source_manifest)
    else:
        source_hash = previous.get("source_manifest_sha256", "")
        print(f"提示：未找到 {source_manifest}，沿用旧 source_manifest_sha256", file=sys.stderr)
    files = collect_files()
    if len(files) < 200:
        raise SystemExit(f"文件数异常（{len(files)}），拒绝写入发布清单")
    return {
        "name": previous.get("name", "NEW-PROJIECT"),
        "version": package["version"],
        "feature": previous.get("feature", "independent-review-workspace"),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "startup": previous.get("startup", "start.cmd"),
        "previous_release_commit": previous.get("previous_release_commit", ""),
        "previous_release_manifest_sha256": previous_hash,
        "source_manifest_sha256": source_hash,
        "schema_change": previous.get(
            "schema_change",
            "Additive independent review schema3, immutable candidates/decisions/history, explicit grants, old-writer guard, live stream epoch. Preserve increments on restore.",
        ),
        "files": files,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="重算 release-manifest.json")
    parser.add_argument("--check", action="store_true", help="只校验，不写入")
    args = parser.parse_args()
    manifest = build()
    if args.check:
        current = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.is_file() else None
        if current is None:
            print("release-manifest.json 不存在，请先运行生成", file=sys.stderr)
            return 1
        # created_at 与 previous_release_manifest_sha256 每次生成都会变化，
        # 校验只比较版本与文件清单，避免把时间戳当成“过期”。
        same = (current.get("version") == manifest["version"]
                and current.get("files") == manifest["files"])
        if not same:
            print("release-manifest.json 不是最新，请重新生成", file=sys.stderr)
            return 1
        print("release-manifest.json 已是最新")
        return 0
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已写入 {MANIFEST}：version={manifest['version']} files={len(manifest['files'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

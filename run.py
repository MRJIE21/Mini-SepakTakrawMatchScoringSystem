#!/usr/bin/env python3
"""藤球比赛计分系统 启动入口。

用法：
  python run.py                 启动服务（默认 0.0.0.0:8000）
  python run.py --port 8080     指定端口
  python run.py --init-db       仅初始化空的全局索引库后退出
  python run.py --reset-db      删除全局索引库和全部赛事库后重建（危险）
  python run.py --db 路径       指定数据库文件
  python run.py --set-admin-password 新密码   忘记 admin 密码时重设

运维子命令（一次性 CLI，不启动服务）：
  python run.py backup  [--output 备份目录]                 成套备份 registry+赛事库并写清单
  python run.py verify  --input 备份目录                    校验备份清单/哈希/完整性/外键/计数
  python run.py restore --input 备份目录 --yes              停服恢复到当前数据目录（先校验、先快照）
  python run.py maintenance [--dry-run|--apply] [--retention-days N]
                                                            数据保留维护（默认 dry-run 只看不删）

Windows 推荐双击 start.cmd。同一数据目录只允许一个服务实例：第二个实例会
明确报错（含占用 PID/端口）并以非零码退出，不再静默改用备用端口；显式端口
被占用时请按提示用 netstat -ano | findstr :端口 查看占用进程。

首次启动只创建管理员账号 admin：密码取自环境变量 STSS_ADMIN_PASSWORD；
未设置时生成随机初始密码并只在启动控制台显示一次，请登录后立即修改。
其他角色账号由管理员在页面中创建。

后端只使用 Python 标准库，无需安装任何依赖，Python 3.10+ 即可运行。
"""
from __future__ import annotations

import argparse
import errno
import os
import shutil
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def _configure_logging() -> None:
    """最早初始化日志；配置失败绝不阻断启动（回退 stderr/静默）。"""
    try:
        from app.logging_setup import configure
        configure()
    except Exception:
        pass  # loguru/文件系统不可用时按无日志运行，真正的启动错误由 main 异常路径报告


def reset_admin_password(password: str) -> int:
    """忘记 admin 密码时的离线恢复入口：直接改库并使旧令牌失效。"""
    from app import config, db, security
    if len(password) < 6:
        print("密码至少 6 位")
        return 2
    conn = db.connect()
    try:
        with db.tx(conn):
            admin = db.q1(conn, "SELECT id FROM users WHERE username = 'admin'")
            if admin is None:
                uid = security.create_user(conn, "admin", password, "admin", "赛事管理员")
                print("已创建管理员账号 admin")
            else:
                uid = admin['id']
                security.set_password(conn, uid, password)
                security.revoke_user_tokens(conn, uid)
                print("admin 密码已重设，该账号原有登录状态已失效")
            db.sync_user_to_event_databases(conn, uid)
    finally:
        conn.close()
    return 0


def _requested_port() -> int:
    """从命令行/环境变量推断请求端口，仅用于端口占用提示。"""
    argv = sys.argv[1:]
    for index, value in enumerate(argv):
        if value == "--port" and index + 1 < len(argv):
            try:
                return int(argv[index + 1])
            except ValueError:
                continue
        if value.startswith("--port="):
            try:
                return int(value.split("=", 1)[1])
            except ValueError:
                continue
    try:
        return int(os.environ.get("STSS_PORT", "8000"))
    except ValueError:
        return 8000


# ------------------------------------------------------------------ 运维子命令
def _command_backup(args) -> int:
    from app import backup_restore, instance_lock
    try:
        print(instance_lock.describe_status())
    except Exception as exc:  # 只读探测失败不应阻断备份
        print(f"提示：无法探测服务实例状态（{exc}），继续备份。")
    try:
        result = backup_restore.build_archive(args.output)
    except backup_restore.BackupError as exc:
        print(f"备份失败：{exc}", file=sys.stderr)
        return 1
    manifest = result["manifest"]
    print(f"备份完成：{result['archive_dir']}")
    print(f"  数据库文件 {result['files']} 个；deployment_id={manifest.get('deployment_id')}")
    for item in manifest["files"]:
        print(f"  - {item['path']}：{item['bytes']} 字节，sha256 {item['sha256'][:16]}…，"
              f"integrity={item['integrity']}，外键={item['foreign_keys']}")
    for warning in result.get("warnings") or []:
        print(f"  提示：{warning}")
    print("  校验命令：python run.py verify --input " + str(result["archive_dir"]))
    return 0


def _command_verify(args) -> int:
    from app import backup_restore, instance_lock
    try:
        print(instance_lock.describe_status())
    except Exception as exc:
        print(f"提示：无法探测服务实例状态（{exc}），继续校验。")
    try:
        result = backup_restore.verify_archive(args.input)
    except backup_restore.VerifyError as exc:
        print(f"校验失败：{exc}", file=sys.stderr)
        return 1
    manifest = result["manifest"]
    print(f"校验通过：{args.input}")
    print(f"  数据库文件 {result['files']} 个；deployment_id={result.get('deployment_id')}；"
          f"created_at_utc={manifest.get('created_at_utc')}")
    totals: dict[str, int] = {}
    for item in manifest["files"]:
        for table, count in (item.get("counts") or {}).items():
            if count:
                totals[table] = totals.get(table, 0) + count
    if totals:
        print("  关键表合计：" + "，".join(f"{table}={count}" for table, count in sorted(totals.items())))
    for warning in result.get("warnings") or []:
        print(f"  提示：{warning}")
    return 0


def _command_restore(args) -> int:
    if not args.yes:
        print("恢复会覆盖当前数据目录中的数据库文件，必须显式确认。", file=sys.stderr)
        print("请先停止服务，再执行：python run.py restore --input 备份目录 --yes", file=sys.stderr)
        return 2
    from app import backup_restore, config, instance_lock
    print("恢复要求服务已停止；正在检查实例锁……")
    try:
        holder = instance_lock.acquire(config.DATA_DIR)
    except instance_lock.InstanceLockError as exc:
        print(f"恢复被拒绝：{exc}", file=sys.stderr)
        return 1
    try:
        result = backup_restore.restore_archive(args.input, lock=holder)
    except backup_restore.BackupError as exc:
        print(f"恢复失败：{exc}", file=sys.stderr)
        return 1
    finally:
        holder.release()
    print(f"恢复完成：{args.input} -> {config.DATA_DIR}")
    print(f"  已恢复数据库文件 {len(result['restored'])} 个，恢复后校验通过。")
    if result.get("pre_restore_snapshot"):
        print(f"  恢复前快照（回滚用）：{result['pre_restore_snapshot']}")
    else:
        print("  恢复前没有数据库文件，未生成 pre-restore 快照。")
    for warning in result.get("warnings") or []:
        print(f"  提示：{warning}")
    print("  请重新启动服务（python run.py）并在页面上核对赛事列表与成绩。")
    return 0


def _command_maintenance(args) -> int:
    from app import config, instance_lock, maintenance
    dry_run = not args.apply
    try:
        if dry_run:
            try:
                print(instance_lock.describe_status())
            except Exception as exc:
                print(f"提示：无法探测服务实例状态（{exc}），继续 dry-run 统计。")
            report = maintenance.run_maintenance(dry_run=True, retention_days=args.retention_days)
        else:
            print("apply 会删除过期数据并要求服务已停止；正在检查实例锁……")
            try:
                holder = instance_lock.acquire(config.DATA_DIR)
            except instance_lock.InstanceLockError as exc:
                print(f"维护被拒绝：{exc}", file=sys.stderr)
                print("请停止服务后重试；仅统计可运行：python run.py maintenance（默认 dry-run）。",
                      file=sys.stderr)
                return 1
            try:
                report = maintenance.run_maintenance(
                    dry_run=False, retention_days=args.retention_days, lock=holder)
            finally:
                holder.release()
    except maintenance.MaintenanceError as exc:
        print(f"维护失败：{exc}", file=sys.stderr)
        return 1
    print(maintenance.format_report(report))
    return 0


# ------------------------------------------------------------------ 主入口
def main() -> int:
    _configure_logging()
    from app import backup_restore, config, db, instance_lock, maintenance
    from app.http_server import load_routes, serve

    parser = argparse.ArgumentParser(
        description="藤球比赛计分系统",
        epilog="运维子命令：backup / verify / restore / maintenance（详见 python run.py --help）")
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--init-db", action="store_true", help="初始化空数据库后退出")
    parser.add_argument("--reset-db", action="store_true", help="删除索引库和全部赛事库后重建")
    parser.add_argument("--set-admin-password", default=None, metavar="新密码",
                        help="重设 admin 密码（忘记初始密码时使用），完成后退出")
    parser.add_argument("--db", default=None, help="数据库文件路径")
    # 子命令也接受 --db/--output 等参数：全局 --db 写在子命令前，子命令后的 --db 同样生效。
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--db", default=argparse.SUPPRESS, help=argparse.SUPPRESS)
    subparsers = parser.add_subparsers(dest="command", metavar="子命令")
    backup_parser = subparsers.add_parser("backup", parents=[common],
                                          help="成套备份 registry 与全部赛事库")
    backup_parser.add_argument("--output", default=None, metavar="DIR",
                               help="备份输出目录（默认 data/backups/backup-<UTC 时间戳>）")
    verify_parser = subparsers.add_parser("verify", parents=[common], help="校验备份清单与数据库")
    verify_parser.add_argument("--input", required=True, metavar="DIR", help="备份目录")
    restore_parser = subparsers.add_parser("restore", parents=[common], help="停服恢复备份")
    restore_parser.add_argument("--input", required=True, metavar="DIR", help="备份目录")
    restore_parser.add_argument("--yes", action="store_true", help="确认恢复会覆盖当前数据")
    maintenance_parser = subparsers.add_parser("maintenance", parents=[common],
                                               help="数据保留维护（默认 dry-run）")
    maintenance_parser.add_argument("--apply", action="store_true",
                                    help="执行清理（需要服务已停止）；缺省只统计")
    maintenance_parser.add_argument("--retention-days", type=int, default=None, metavar="N",
                                    help="request_log 保留天数（默认 STSS_RETENTION_DAYS=30）")
    args = parser.parse_args()

    if args.db:
        config.DB_PATH = Path(args.db)

    if args.command == "backup":
        return _command_backup(args)
    if args.command == "verify":
        return _command_verify(args)
    if args.command == "restore":
        return _command_restore(args)
    if args.command == "maintenance":
        return _command_maintenance(args)

    serving = not (args.init_db or args.reset_db or args.set_admin_password)
    requested_port = (args.port if args.port is not None else config.PORT) if serving else None
    lock = None
    try:
        try:
            lock = instance_lock.acquire(config.DATA_DIR, port=requested_port)
        except instance_lock.InstanceLockError as exc:
            print(f"\n启动失败：{exc}", file=sys.stderr)
            _log_error("单实例锁冲突", exc)
            return 1
        _log_info("已获取实例锁：%s（pid=%s, port=%s）", lock.path, lock.pid, lock.port)

        if args.reset_db and config.DB_PATH.exists():
            print(f"删除全局索引库：{config.DB_PATH}")
            config.DB_PATH.unlink()
        if args.reset_db and config.EVENTS_DIR.exists():
            events_dir = config.EVENTS_DIR.resolve()
            data_dir = config.DATA_DIR.resolve()
            if events_dir == data_dir or data_dir not in events_dir.parents:
                raise RuntimeError(f"拒绝删除数据目录外的赛事库目录：{events_dir}")
            print(f"删除赛事数据库目录：{events_dir}")
            shutil.rmtree(events_dir)

        db.init_db()

        if args.set_admin_password:
            return reset_admin_password(args.set_admin_password)

        if args.init_db:
            print(f"空的全局索引库已就绪：{config.DB_PATH}")
            return 0

        load_routes()
        serve(args.host, args.port)
        return 0
    finally:
        if lock is not None:
            lock.release()


def _log_error(prefix: str, exc: BaseException) -> None:
    try:
        import logging
        logging.getLogger("stss").error("%s：%s", prefix, exc)
    except Exception:
        pass


def _log_info(message: str, *args) -> None:
    try:
        import logging
        logging.getLogger("stss").info(message, *args)
    except Exception:
        pass


def entrypoint() -> int:
    """双击启动失败时显示诊断；命令行/重定向执行不等待输入。"""
    _configure_logging()
    try:
        return main()
    except KeyboardInterrupt:
        return 0
    except Exception as exc:
        _log_error("启动失败", exc)
        traceback.print_exc()
        print(f"\n启动失败：{exc}", file=sys.stderr)
        port_busy = getattr(exc, "winerror", None) in (10013, 10048) or getattr(
            exc, "errno", None) in (errno.EACCES, errno.EADDRINUSE)
        if isinstance(exc, OSError) and port_busy:
            port = _requested_port()
            print(f"端口 {port} 无法监听：可能已被其他程序占用，或当前用户无监听权限。",
                  file=sys.stderr)
            print(f"Windows 可运行 netstat -ano | findstr :{port} 查看占用进程，"
                  "结束占用进程或以 --port 指定其他端口后重试。", file=sys.stderr)
        print("请保留上方错误信息以便排查。", file=sys.stderr)
        if os.name == 'nt' and sys.stdin is not None and sys.stdin.isatty() and not os.environ.get('STSS_LAUNCHER'):
            try:
                input("按回车键关闭窗口……")
            except (EOFError, KeyboardInterrupt):
                pass
        return 1


if __name__ == "__main__":
    raise SystemExit(entrypoint())

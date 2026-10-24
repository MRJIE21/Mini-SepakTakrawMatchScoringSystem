#!/usr/bin/env python3
"""发布前浏览器回归门禁（Browser regression release gate）。

作用：串行/并行运行 ``tests/*.browser.test.mjs`` 全部真实浏览器回归套件，
汇总通过/失败/耗时并以退出码作为发布门禁：

    退出码 0  全部套件通过
    退出码 1  存在失败或超时套件（禁止发布）
    退出码 2  运行环境不满足（Node/Playwright 模块不可用）

环境要求（不新增运行依赖到产品本体，仅发布机需要）：
  - Node.js 18+（含全局 fetch）与 Python 3.10+（套件内部自行启动隔离服务）
  - Playwright 模块：默认 ``playwright``；可用 ``--playwright-module`` 或环境变量
    ``STSS_PLAYWRIGHT_MODULE`` 指定模块路径（例如离线/CI 内置缓存路径）。
  - 浏览器：默认使用 Playwright 自带 Chromium；若机器只有 Edge/Chrome，可设置
    ``STSS_BROWSER_PATH`` 指向浏览器可执行文件（套件自身会读取该变量），或使用
    一个把 ``chromium.launch`` 默认 channel 指向本机浏览器的 shim 模块并通过
    ``--playwright-module`` 传入。

用法（在项目根目录执行）：
    python tools/run_browser_regression.py                    # 全量、串行
    python tools/run_browser_regression.py --jobs 2           # 两路并行
    python tools/run_browser_regression.py --only p2b_session # 只跑一个套件（子串）
    python tools/run_browser_regression.py --list             # 列出套件不执行
    python tools/run_browser_regression.py --timeout 300 --report-dir <目录>

说明：
  - 每个套件在独立进程、独立临时数据目录与随机端口上运行，互不影响；
  - 门禁报告默认写入系统临时目录（不污染产品目录），可用 --report-dir 指定；
  - 输出为 UTF-8，Windows 控制台重定向时建议先 ``chcp 65001``。
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

# Windows 控制台/重定向可能是 GBK；失败摘要含非 GBK 字符时不能中断门禁报告。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
TESTS = ROOT / "tests"
SUFFIX = ".browser.test.mjs"
CST = timezone.utc


def discover() -> list[str]:
    if not TESTS.is_dir():
        return []
    return sorted(p.name for p in TESTS.glob("*" + SUFFIX) if p.is_file())


def preflight(playwright_module: str) -> tuple[bool, str]:
    """检查 Node 与 Playwright 模块是否可用，返回 (ok, 说明)。"""
    node = shutil.which("node")
    if not node:
        return False, "未找到 Node.js（需要 Node 18+ 运行浏览器回归）"
    code = (
        "try { require(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');"
        " console.log('ok'); } catch (e) { console.error(String(e && e.message || e));"
        " process.exit(1); }"
    )
    env = dict(os.environ)
    if playwright_module:
        env["STSS_PLAYWRIGHT_MODULE"] = playwright_module
    proc = subprocess.run([node, "-e", code], capture_output=True,
                          encoding="utf-8", errors="replace", env=env, timeout=60)
    if proc.returncode != 0:
        return False, (
            "Playwright 模块不可用："
            + ((proc.stderr or proc.stdout or "").strip().splitlines() or [""])[-1]
            + "\n  提示：安装 Playwright 或用 --playwright-module/STSS_PLAYWRIGHT_MODULE 指定模块路径")
    return True, "环境就绪"


def _loopback_fetch_import_option() -> str:
    """测试用 fetch 兼容层：规避 Node fetch 对本地随机端口的 bad-port 限制。"""
    shim = ROOT / "tests" / "helpers" / "loopback_fetch.mjs"
    if not shim.is_file():
        return ""
    return " --import=" + shim.resolve().as_uri()


def run_suite(suite: str, timeout: float, playwright_module: str) -> dict:
    env = dict(os.environ)
    if playwright_module:
        env["STSS_PLAYWRIGHT_MODULE"] = playwright_module
    env.setdefault("PYTHONDONTWRITEBYTECODE", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    shim_option = _loopback_fetch_import_option()
    if shim_option:
        env["NODE_OPTIONS"] = (env.get("NODE_OPTIONS", "") + shim_option).strip()
    started = time.monotonic()
    record = {"suite": suite, "started_at": datetime.now(CST).isoformat(timespec="seconds")}
    try:
        proc = subprocess.run(["node", f"tests/{suite}"], cwd=str(ROOT), env=env,
                              capture_output=True, encoding="utf-8", errors="replace",
                              timeout=timeout)
        output = (proc.stdout or "") + (proc.stderr or "")
        record["exit"] = proc.returncode
        record["timed_out"] = False
    except subprocess.TimeoutExpired as exc:
        output = ""
        for stream in (exc.stdout, exc.stderr):
            if isinstance(stream, bytes):
                output += stream.decode("utf-8", "replace")
            elif stream:
                output += stream
        record["exit"] = 124
        record["timed_out"] = True
    except Exception as exc:  # noqa: BLE001
        output = f"<runner error: {type(exc).__name__}: {exc}>"
        record["exit"] = 125
        record["timed_out"] = False
    record["seconds"] = round(time.monotonic() - started, 2)
    lines = [line for line in output.splitlines() if line.strip()]
    record["tail"] = "\n".join(lines[-20:])[:3000]
    record["status"] = "PASS" if record["exit"] == 0 else ("TIMEOUT" if record["timed_out"] else "FAIL")
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description="发布前浏览器回归门禁")
    parser.add_argument("--playwright-module", default=os.environ.get("STSS_PLAYWRIGHT_MODULE", ""),
                        help="Playwright 模块路径（默认取 STSS_PLAYWRIGHT_MODULE，否则 playwright）")
    parser.add_argument("--timeout", type=float, default=300.0, help="单套件超时秒数（默认 300）")
    parser.add_argument("--jobs", type=int, default=1, help="并行进程数（默认 1=串行，推荐）")
    parser.add_argument("--only", default="", help="只跑文件名包含该子串的套件（逗号分隔多个）")
    parser.add_argument("--list", action="store_true", help="仅列出套件")
    parser.add_argument("--report-dir", default="", help="门禁报告输出目录（默认系统临时目录）")
    args = parser.parse_args()

    suites = discover()
    if args.only:
        keywords = [item.strip() for item in args.only.split(",") if item.strip()]
        suites = [s for s in suites if any(k in s for k in keywords)]
    if not suites:
        print("未发现浏览器回归套件（tests/*.browser.test.mjs）", file=sys.stderr)
        return 2
    if args.list:
        for suite in suites:
            print(suite)
        print(f"共 {len(suites)} 套")
        return 0

    ok, message = preflight(args.playwright_module)
    print(message, flush=True)
    if not ok:
        return 2

    report_dir = Path(args.report_dir) if args.report_dir else \
        Path(tempfile.mkdtemp(prefix="stss-browser-gate-"))
    report_dir.mkdir(parents=True, exist_ok=True)
    print(f"发布门禁：{len(suites)} 套浏览器回归，并行 {args.jobs}，单套超时 {args.timeout:.0f}s", flush=True)
    started = time.monotonic()
    results: list[dict] = []
    if args.jobs <= 1:
        for index, suite in enumerate(suites, 1):
            record = run_suite(suite, args.timeout, args.playwright_module)
            results.append(record)
            print(f"[{index:02d}/{len(suites)}] {record['status']:7s} {record['seconds']:8.2f}s  {suite}",
                  flush=True)
            if record["status"] != "PASS" and record["tail"]:
                print(f"            -> {record['tail'].splitlines()[-1][:220]}", flush=True)
    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
            futures = {pool.submit(run_suite, suite, args.timeout, args.playwright_module): suite
                       for suite in suites}
            for index, future in enumerate(concurrent.futures.as_completed(futures), 1):
                record = future.result()
                results.append(record)
                print(f"[{index:02d}/{len(suites)}] {record['status']:7s} "
                      f"{record['seconds']:8.2f}s  {record['suite']}", flush=True)
    results.sort(key=lambda r: r["suite"])
    elapsed = round(time.monotonic() - started, 1)
    passed = sum(1 for r in results if r["status"] == "PASS")
    failed = [r for r in results if r["status"] != "PASS"]
    summary = {
        "gate": "browser-regression",
        "generated_at": datetime.now(CST).isoformat(timespec="seconds"),
        "product_root": str(ROOT),
        "playwright_module": args.playwright_module or "playwright",
        "total": len(results), "passed": passed,
        "failed": len(failed), "elapsed_seconds": elapsed,
        "results": results,
    }
    (report_dir / "gate-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    lines = ["# 浏览器回归发布门禁报告", "",
             f"- 生成时间：{summary['generated_at']}",
             f"- 产品根目录：`{ROOT}`",
             f"- 结论：**{'PASS（允许发布）' if not failed else 'FAIL（禁止发布）'}**",
             f"- 套件：{len(results)}；通过 {passed}；失败 {len(failed)}；耗时 {elapsed}s", "",
             "| 套件 | 结果 | 耗时(s) |", "| --- | --- | --- |"]
    for r in results:
        lines.append(f"| `{r['suite']}` | {r['status']} | {r['seconds']} |")
    if failed:
        lines += ["", "## 失败套件", ""]
        for r in failed:
            lines += [f"### {r['suite']}（{r['status']}）", "", "```text",
                      r["tail"] or "<无输出>", "```", ""]
    (report_dir / "gate-summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

    print("", flush=True)
    print(f"门禁结果：{'PASS' if not failed else 'FAIL'} — {passed}/{len(results)} 通过，"
          f"失败 {len(failed)}，总耗时 {elapsed}s", flush=True)
    print(f"报告：{report_dir / 'gate-summary.md'}", flush=True)
    if failed:
        print("失败套件：" + ", ".join(r["suite"] for r in failed), flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

# 基线目录说明（G0）

本目录保存 G0 设计冻结时的基线证据。

## 已有

- `baseline-20261023.json`：三端（1440×900 / 834×1112 / 390×844）× 8 个关键页面的 DOM 量测基线：横向溢出、页面高度、主区宽度、唯一 H1、390 下 `.btn.small` 高度。G1 及后续改动以“不劣化这些数值”为回归标准。
- `screens-20261023/{1440,834,390}/`：24 张 PNG（8 页 × 3 端），已用 Playwright-core + 本机 Edge（headless）实际生成。**保留为历史基线，不覆盖。**
- `baseline-20261024.json`：D08 移动导航/结构树重构后的导航基线：三端 `#/dashboard` 的横向溢出、顶栏/主区/侧栏尺寸、抽屉开关与底栏可见性、390 抽屉打开宽度/高度/焦点/遮罩、Escape 关闭。2026-10-24 由 Playwright + Edge 在隔离临时赛事上实测生成。
- `screens-20261024/390/`：D08 的 3 张 390 截图：`01-dashboard-closed.png`、`02-drawer-open.png`、`03-workspace.png`。

## 2026-10-24 导航基线（D08）

- **原因**：390 宽度下导航从横排滚动改为分组抽屉 + 底部快捷栏；原 `baseline-20261023.json` 的 390 导航壳已不适用，按冻结规则新建基线文件，不修改旧文件。
- **范围**：只重采导航相关量测（三端壳层/抽屉/底栏），20261023 的 8 页面内容基线继续作为历史证据；页面内容与令牌未重新冻结。
- **验收**：≤620px 出现菜单按钮、抽屉关闭态高度 0、底栏 4 项、打开后宽度 320/视口高 844、焦点进入抽屉、Escape 关闭、所有测量视图 `overflowX=0`；≥621px 保持原侧栏/横排导航。
- **生成方式**：隔离临时数据目录 + 随机端口，管理员登录，逐视图 2 次 rAF 后量测；截图仅 390 三张。
- **回滚**：若回退 D08，删除/忽略本基线，恢复 `baseline-20261023.json` 为当前门禁基线；旧文件未被改动。

## 截图（重生成方法）

```bash
# 需能 require('playwright') 或 playwright-core；可指向本机 Edge
STSS_PLAYWRIGHT_MODULE=<node_modules>/playwright-core \
STSS_EDGE_PATH="C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" \
STSS_ADMIN_PASSWORD=test12345 OUT_DIR=docs/baseline/screens-<日期> node tools/capture_baseline.mjs
# 输出：docs/baseline/screens-<日期>/<viewport>/<page>.png
```

脚本会：用管理员登录、按 1440/834/390 三端逐页打开并整页截图；页面清单与 `baseline-20261023.json` 一致，需要先启动服务并准备演示赛事数据。

## 冻结规则

- 本目录文件一旦冻结，G1—G5 期间只追加、不覆盖；
- 需要重新冻结（改设计基线）时，新建 `baseline-<日期>.json` 并在 G0 文档登记原因。

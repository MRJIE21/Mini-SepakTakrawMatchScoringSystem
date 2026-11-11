# 内置文件解析依赖

- `xlrd` 2.0.2，PyPI 官方 wheel，BSD 许可（含历史组件许可）。完整许可保留在 `xlrd-2.0.2.dist-info/LICENSE`。
- 用途仅为读取 `.xls` 的第一个工作表，通过 `app.vendor.xlrd` 导入，不修改 Python 全局环境，不在运行时下载。
- `.xlsx` 使用标准库受限 OOXML 解析器，模板使用项目原有 XLSX 写出器；`.csv` 使用标准库。
- 测试使用的 XLS 样例由 xlwt 1.3.0 生成，xlwt 仅位于测试产物目录，不是产品依赖。

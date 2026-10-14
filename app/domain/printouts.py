"""核对成绩单的通用 HTML 模板：固定表头、完整分页、所有动态文本转义。"""
from __future__ import annotations

import html


def render_sheet(*, title: str, event: str, scope: str, headers: list[str], rows: list[list],
                 generated_at: str, prepared_by: str, note: str = "", per_page: int = 16) -> str:
    esc = lambda value: html.escape("" if value is None else str(value))
    chunks = [rows[index:index + per_page] for index in range(0, len(rows), per_page)] or [[]]
    pages = []
    for index, chunk in enumerate(chunks, start=1):
        heading = "".join(f"<th scope='col'>{esc(label)}</th>" for label in headers)
        body = "".join("<tr>" + "".join(f"<td>{esc(cell)}</td>" for cell in row) + "</tr>"
                       for row in chunk)
        if not body:
            body = f"<tr><td colspan='{len(headers)}'>暂无参赛名单或成绩</td></tr>"
        pages.append(f"""<section class="sheet">
          <div class="event">{esc(event)}</div><h1>{esc(title)}</h1>
          <div class="meta"><strong>{esc(scope)}</strong><span>现场核对用</span></div>
          <div class="note">{esc(note)}</div>
          <table><thead><tr>{heading}</tr></thead><tbody>{body}</tbody></table>
          <div class="signatures">制表：{esc(prepared_by)}　　核对：____________　　裁判长：____________</div>
          <div class="footer"><span>生成时间：{esc(generated_at)}</span>
          <span>共 {len(rows)} 条 · 第 {index} / {len(chunks)} 页</span></div>
        </section>""")
    return f"""<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1"><title>{esc(title)}</title>
      <style>
      *{{box-sizing:border-box}}body{{margin:0;background:#eee;color:#111;font-family:'Microsoft YaHei',sans-serif}}
      .toolbar{{padding:14px;text-align:center}}button{{padding:10px 24px;font:inherit;cursor:pointer}}
      .sheet{{width:190mm;min-height:265mm;margin:12px auto;padding:12mm;background:white}}
      .event{{text-align:center;font-size:15px;overflow-wrap:anywhere}}h1{{text-align:center;font-size:23px;margin:12px 0 18px}}
      .meta,.footer{{display:flex;justify-content:space-between;gap:12px}}.meta{{font-size:14px}}
      .note{{font-size:12px;line-height:1.6;margin:10px 0;white-space:pre-wrap;overflow-wrap:anywhere}}
      table{{width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px}}
      th,td{{border:1px solid #555;padding:8px 5px;text-align:center;overflow-wrap:anywhere;white-space:pre-wrap}}
      th{{background:#f2f2f2}}tr{{break-inside:avoid}}.signatures{{font-size:12px;margin:22px 0;line-height:2}}
      .footer{{border-top:1px solid #aaa;padding-top:9px;font-size:11px;color:#444}}
      @page{{size:A4 portrait;margin:10mm}}@media print{{body{{background:white}}.toolbar{{display:none}}
      .sheet{{width:auto;min-height:0;margin:0;padding:0;break-after:page}}.sheet:last-child{{break-after:auto}}
      thead{{display:table-header-group}}}}
      @media screen and (max-width:760px){{.sheet{{width:100%;min-height:0;padding:20px}}}}
      </style></head><body><div class="toolbar"><button onclick="window.print()">打印 / 另存为 PDF</button></div>
      {''.join(pages)}</body></html>"""

"""最小 XLSX 写出器：仅用 Python 标准库生成合法 OOXML 工作簿。

只覆盖本项目报表需要的表格：表头加粗、首行冻结、按内容估算列宽、文本安全转义、
整数/浮点写成数值单元格、空表仍输出表头。不引入第三方依赖，也不写公式。
"""
from __future__ import annotations

import io
import re
import zipfile
from xml.sax.saxutils import escape

_CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')
_INVALID_SHEET = re.compile(r'[\[\]:*?/\\]')


def _clean_text(value) -> str:
    return _CONTROL.sub('', str(value))


def _sheet_title(name: str) -> str:
    title = _INVALID_SHEET.sub('_', _clean_text(name or '数据')).strip() or '数据'
    return title[:31]


def _cell_ref(row: int, column: int) -> str:
    letters = ''
    while column:
        column, remainder = divmod(column - 1, 26)
        letters = chr(65 + remainder) + letters
    return f'{letters}{row}'


def _inline_cell(row: int, column: int, value: str, style: int = 0) -> str:
    ref = _cell_ref(row, column)
    style_attr = f' s="{style}"' if style else ''
    attributes = ' xml:space="preserve"' if value != value.strip() else ''
    return (f'<c r="{ref}"{style_attr} t="inlineStr"><is>'
            f'<t{attributes}>{escape(value)}</t></is></c>')


def _number_cell(row: int, column: int, value) -> str:
    ref = _cell_ref(row, column)
    if isinstance(value, float):
        if value.is_integer():
            value = int(value)
        else:
            return f'<c r="{ref}"><v>{value!r}</v></c>'
    return f'<c r="{ref}"><v>{int(value)}</v></c>'


def _display_width(value) -> int:
    text = '' if value is None else str(value)
    return sum(2 if ord(ch) > 127 else 1 for ch in text)


def workbook_bytes(headers: list, rows: list, sheet_name: str = '数据') -> bytes:
    """把表头与数据行写成最小 XLSX；文本与数值分别使用 inlineStr/数值单元格。"""
    title = _sheet_title(sheet_name)
    column_count = max(1, len(headers))
    widths = []
    for column in range(column_count):
        width = _display_width(headers[column] if column < len(headers) else '')
        for row in rows:
            if column < len(row):
                width = max(width, _display_width(row[column]))
        widths.append(min(60, max(8, width + 2)))

    columns_xml = ''.join(
        f'<col min="{index}" max="{index}" width="{width}" customWidth="1"/>'
        for index, width in enumerate(widths, start=1))
    sheet_rows = []
    header_cells = ''.join(
        _inline_cell(1, index, _clean_text(value), style=1)
        for index, value in enumerate(headers, start=1))
    sheet_rows.append(f'<row r="1">{header_cells}</row>')
    for row_index, row in enumerate(rows, start=2):
        cells = []
        for column_index in range(column_count):
            value = row[column_index] if column_index < len(row) else None
            if value is None or value == '':
                continue
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                cells.append(_number_cell(row_index, column_index + 1, value))
            else:
                cells.append(_inline_cell(row_index, column_index + 1, _clean_text(value)))
        sheet_rows.append(f'<row r="{row_index}">{"".join(cells)}</row>')
    dimension = f'A1:{_cell_ref(max(1, len(rows) + 1), column_count)}'
    worksheet = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f'<dimension ref="{dimension}"/>'
        '<sheetViews><sheetView workbookViewId="0">'
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
        '</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>'
        f'<cols>{columns_xml}</cols><sheetData>{"".join(sheet_rows)}</sheetData>'
        '</worksheet>')
    sheet_name_xml = escape(title)
    workbook = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f'<sheets><sheet name="{sheet_name_xml}" sheetId="1" r:id="rId1"/></sheets>'
        '</workbook>')
    styles = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
        '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
        '<fills count="2"><fill><patternFill patternType="none"/></fill>'
        '<fill><patternFill patternType="gray125"/></fill></fills>'
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        '</styleSheet>')
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/styles.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        '</Types>')
    root_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="xl/workbook.xml"/></Relationships>')
    workbook_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        'Target="worksheets/sheet1.xml"/>'
        '<Relationship Id="rId2" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
        'Target="styles.xml"/></Relationships>')
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('[Content_Types].xml', content_types)
        archive.writestr('_rels/.rels', root_rels)
        archive.writestr('xl/workbook.xml', workbook)
        archive.writestr('xl/_rels/workbook.xml.rels', workbook_rels)
        archive.writestr('xl/styles.xml', styles)
        archive.writestr('xl/worksheets/sheet1.xml', worksheet)
    return buffer.getvalue()

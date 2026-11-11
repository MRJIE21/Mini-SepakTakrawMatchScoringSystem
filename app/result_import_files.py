"""受限文件读取：首张工作表、首行表头，保留物理行号；不执行公式。"""
import base64
import csv
import io
import posixpath
import re
import zipfile
from xml.etree import ElementTree as ET

from .errors import bad_request

MAX_ROWS = 2000
MAX_BYTES = 2 * 1024 * 1024
NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'


def _xml(archive, name):
    raw = archive.read(name)
    if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
        raise ValueError('不支持含实体定义的工作簿')
    return ET.fromstring(raw)


def _xlsx(raw):
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        if len(archive.infolist()) > 512 or sum(i.file_size for i in archive.infolist()) > 16 * 1024 * 1024:
            raise ValueError('工作簿解压后过大')
        workbook = _xml(archive, 'xl/workbook.xml')
        first = workbook.find(NS + 'sheets')[0]
        rid = first.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']
        rels = _xml(archive, 'xl/_rels/workbook.xml.rels')
        rel = next(r for r in rels if r.attrib['Id'] == rid)
        if rel.attrib.get('TargetMode') == 'External':
            raise ValueError('不支持外部工作表')
        target = rel.attrib['Target']
        target = target.lstrip('/') if target.startswith('/') else posixpath.normpath('xl/' + target)
        if not target.startswith('xl/'):
            raise ValueError('工作表路径无效')
        strings = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            strings = [''.join(s.itertext()) for s in _xml(archive, 'xl/sharedStrings.xml')]
        result = []
        for row in _xml(archive, target).findall('.//' + NS + 'sheetData/' + NS + 'row'):
            cells = []
            for cell in row:
                ref = re.fullmatch(r'([A-Z]+)\d+', cell.attrib.get('r', ''))
                if not ref:
                    raise ValueError('单元格坐标无效')
                col = 0
                for char in ref[1]:
                    col = col * 26 + ord(char) - 64
                if col > 32:
                    raise ValueError('最多允许 32 列')
                while len(cells) < col:
                    cells.append('')
                if cell.find(NS + 'f') is not None or cell.attrib.get('t') == 'e':
                    cells[col - 1] = '#无法解析：请使用值而非公式/错误单元格'
                elif cell.attrib.get('t') == 'inlineStr':
                    cells[col - 1] = ''.join(cell.find(NS + 'is').itertext())
                else:
                    value = cell.findtext(NS + 'v', '')
                    cells[col - 1] = strings[int(value)] if cell.attrib.get('t') == 's' else value
            result.append((int(row.attrib['r']), cells))
            if len(result) > MAX_ROWS + 1:
                raise ValueError(f'一次最多 {MAX_ROWS} 行')
        return result


def parse_file(body):
    name, encoded = body.get('filename'), body.get('file_base64')
    if not isinstance(name, str) or not isinstance(encoded, str) or len(encoded) > MAX_BYTES * 1.4:
        raise bad_request('请上传不超过 2 MB 的文件')
    extension = name.rsplit('.', 1)[-1].lower()
    try:
        raw = base64.b64decode(encoded, validate=True)
        if not raw or len(raw) > MAX_BYTES:
            raise ValueError('文件为空或超过 2 MB')
        if extension == 'csv':
            try:
                text = raw.decode('utf-8-sig')
            except UnicodeDecodeError:
                text = raw.decode('gb18030')
            reader = csv.reader(io.StringIO(text), strict=True)
            rows = []
            for cells in reader:
                rows.append((reader.line_num, cells))
                if len(rows) > MAX_ROWS + 1:
                    raise ValueError(f'一次最多 {MAX_ROWS} 行')
        elif extension == 'xlsx':
            rows = _xlsx(raw)
        elif extension == 'xls':
            from .vendor import xlrd
            book = xlrd.open_workbook(file_contents=raw, on_demand=True)
            try:
                sheet = book.sheet_by_index(0)
                if sheet.nrows > MAX_ROWS + 1 or sheet.ncols > 32:
                    raise ValueError(f'一次最多 {MAX_ROWS} 行、32 列')
                rows = [(i + 1, ['#无法解析：错误或布尔单元格' if c.ctype in (xlrd.XL_CELL_ERROR, xlrd.XL_CELL_BOOLEAN)
                                 else str(int(c.value)) if c.ctype == xlrd.XL_CELL_NUMBER and c.value.is_integer()
                                 else str(c.value) if c.ctype not in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK)
                                 else '' for c in sheet.row(i)]) for i in range(sheet.nrows)]
            finally:
                book.release_resources()
        else:
            raise ValueError('仅支持 .xlsx、.xls、.csv')
        if not rows or rows[0][0] != 1:
            raise ValueError('首行必须为表头')
        headers = [str(c).strip() for c in rows[0][1]]
        while headers and not headers[-1]:
            headers.pop()
        if not headers or any(not h for h in headers) or len(set(headers)) != len(headers):
            raise ValueError('表头缺失或重复')
        result = []
        for line, values in rows[1:]:
            values = [str(v) for v in values]
            if not any(v.strip() for v in values):
                continue
            if any(v.strip() for v in values[len(headers):]):
                raise ValueError(f'第 {line} 行列数超过表头')
            result.append({'line': line, 'raw': dict(zip(headers, (values + [''] * len(headers))[:len(headers)]))})
        if not result:
            raise ValueError('没有可导入的数据')
        return extension, headers, result
    except Exception as exc:
        raise bad_request(f'文件解析失败：{exc}') from exc

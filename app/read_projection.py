"""Request-local projections of text/integer/null columns in one SQLite step.

Only use explicit, uniquely named projections of those types. In particular,
scoring measurements and financial/ratio floats must keep their native reads.
SQLite JSON is already required by the review schema and queue predicates.
No cache or transaction boundary is introduced here.
"""
import json
import re


def text_integer_rows(conn, sql, columns, args=()):
    if not columns or len(set(columns)) != len(columns) or any(
            not re.fullmatch(r'[a-z_][a-z0-9_]*', name) for name in columns):
        raise ValueError('Projection requires unique internal column names')
    fields = ','.join(f"'{name}',projected.\"{name}\"" for name in columns)
    row = conn.execute('SELECT json_group_array(json_object(' + fields + ')) FROM (' + sql + ') AS projected', args).fetchone()
    return json.loads(row[0])

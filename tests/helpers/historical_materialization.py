"""Unit-only historical materializer vectors, below the new HTTP review boundary.

Tests intentionally retain the former idempotency/rollback vectors of extracted
services. Current API authority/decisions are independently exercised over HTTP
by test_independent_review. These functions are never registered as routes.
"""
from pathlib import Path
from app import db
from app.api import scoring
from app.result_safety import atomic_result


def _run(ctx,kind,service):
    row=ctx.conn.execute('PRAGMA database_list').fetchone()
    if row[2] and Path(row[2]).resolve().is_relative_to((Path(__file__).resolve().parents[2]/'data').resolve()):
        raise RuntimeError('Unit materializer cannot write product data')
    return atomic_result(lambda c:scoring._run_result_mutation(c,kind,service))(ctx)


def correction(ctx):return _run(ctx,'correction',scoring._correct_match)
def cancel(ctx):return _run(ctx,'cancel',scoring._cancel_match)
def reset_review(ctx):return _run(ctx,'reset_review',scoring._review_reset_match)

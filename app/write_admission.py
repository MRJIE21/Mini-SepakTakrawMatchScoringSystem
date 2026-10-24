"""FIFO admission to the registry write fence within its existing wait budget.

SQLite remains the cross-process authority. Local contenders wait in order,
then use only the remaining original busy timeout to acquire its real lock.
No transaction, retry, permission snapshot or longer timeout is hidden here.
"""
import sqlite3
import threading
import time
from collections import deque
from contextlib import contextmanager


class WriteAdmission:
    def __init__(self):
        self._condition=threading.Condition()
        self._tickets=deque()

    @contextmanager
    def enter(self, conn):
        original=int(conn.execute('PRAGMA busy_timeout').fetchone()[0])
        deadline=time.monotonic()+original/1000
        ticket=object()
        with self._condition:
            self._tickets.append(ticket)
            try:
                while self._tickets[0] is not ticket:
                    remaining=deadline-time.monotonic()
                    if remaining<=0:
                        error=sqlite3.OperationalError('database is locked')
                        error.transaction_rolled_back=True
                        raise error
                    self._condition.wait(remaining)
            except BaseException:
                self._tickets.remove(ticket)
                self._condition.notify_all()
                raise
        try:
            remaining=max(0,min(original,int((deadline-time.monotonic())*1000)))
            conn.execute(f'PRAGMA busy_timeout={remaining}')
            yield
        finally:
            try:
                conn.execute(f'PRAGMA busy_timeout={original}')
            finally:
                with self._condition:
                    self._tickets.remove(ticket)
                    self._condition.notify_all()

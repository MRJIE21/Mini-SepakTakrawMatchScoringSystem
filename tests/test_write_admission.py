"""Real SQLite contention: bounded waiting, cleanup, and exactly-once writes."""
import sqlite3
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from app import db
from app.write_admission import WriteAdmission


class WriteAdmissionTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='write-admission-')
        self.path=Path(self.tmp.name)/'synthetic.db'
        self.conn=db.connect(self.path,busy_ms=400)
        self.conn.execute('CREATE TABLE counter(value INTEGER)')
        self.conn.execute('INSERT INTO counter VALUES(0)')
        self.admission=WriteAdmission()
    def tearDown(self):self.conn.close();self.tmp.cleanup()

    def test_queue_and_sqlite_share_one_original_wait_budget(self):
        started=threading.Event();blocker=db.connect(self.path)
        def attempt():
            conn=db.connect(self.path,busy_ms=400)
            start=time.monotonic();started.set()
            try:
                with self.assertRaises(sqlite3.OperationalError):
                    with self.admission.enter(conn),db.tx(conn):conn.execute('UPDATE counter SET value=value+1')
                return time.monotonic()-start,conn.execute('PRAGMA busy_timeout').fetchone()[0]
            finally:conn.close()
        try:
            with ThreadPoolExecutor(1) as pool,db.tx(blocker):
                with self.admission.enter(self.conn):
                    future=pool.submit(attempt);self.assertTrue(started.wait(2))
                    threading.Event().wait(.3)
                elapsed,busy=future.result(timeout=3)
            self.assertGreater(elapsed,.3)
            self.assertLess(elapsed,.6,'Queue waiting must not add another full SQLite busy budget')
            self.assertEqual(busy,400)
            self.assertEqual(self.conn.execute('SELECT value FROM counter').fetchone()[0],0)
        finally:blocker.close()

    def test_expired_waiter_does_not_block_the_next_write(self):
        def attempt(budget):
            conn=db.connect(self.path,busy_ms=budget)
            try:
                with self.admission.enter(conn),db.tx(conn):conn.execute('UPDATE counter SET value=value+1')
                return True
            except sqlite3.OperationalError:return False
            finally:conn.close()
        with ThreadPoolExecutor(2) as pool:
            with self.admission.enter(self.conn):
                self.assertFalse(pool.submit(attempt,40).result(timeout=2))
                next_write=pool.submit(attempt,400)
            self.assertTrue(next_write.result(timeout=2))
        self.assertEqual(self.conn.execute('SELECT value FROM counter').fetchone()[0],1)

    def test_real_contenders_each_commit_once(self):
        def increment(_):
            conn=db.connect(self.path,busy_ms=1000)
            try:
                with self.admission.enter(conn),db.tx(conn):conn.execute('UPDATE counter SET value=value+1')
                self.assertEqual(conn.execute('PRAGMA busy_timeout').fetchone()[0],1000)
            finally:conn.close()
        with ThreadPoolExecutor(6) as pool:list(pool.map(increment,range(30)))
        self.assertEqual(self.conn.execute('SELECT value FROM counter').fetchone()[0],30)


if __name__=='__main__':unittest.main()

"""启动端口故障、明确端口约定与可见异常诊断。"""
import contextlib
import errno
import io
import os
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import run
from app import config
from app.http_server import _listen, _local_ips, serve


class StartupFixesTest(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {})
        self.env.start()
        os.environ.pop('STSS_PORT', None)
        self.port = patch.object(config, 'PORT', 8000)
        self.port.start()

    def tearDown(self):
        self.port.stop()
        self.env.stop()

    def test_default_port_occupancy_does_not_fall_back(self):
        """P2-B：端口被占用时明确报错，不再静默改用 8080/8800 起第二个实例。"""
        blocked = OSError(errno.EADDRINUSE, 'occupied')
        with patch('app.http_server.create_server', side_effect=blocked) as factory:
            with self.assertRaises(OSError) as caught:
                _listen('0.0.0.0')
        self.assertEqual(factory.call_count, 1)
        self.assertIn('8000', str(caught.exception))
        self.assertIn('--port', str(caught.exception))

    def test_permission_denied_port_does_not_fall_back(self):
        blocked = PermissionError(errno.EACCES, 'blocked')
        with patch('app.http_server.create_server', side_effect=blocked) as factory:
            with self.assertRaises(OSError) as caught:
                _listen('0.0.0.0')
        self.assertEqual(factory.call_count, 1)
        self.assertIn('8000', str(caught.exception))

    def test_explicit_port_must_not_silently_change(self):
        with patch('app.http_server.create_server', side_effect=PermissionError(errno.EACCES, 'blocked')) as factory:
            with self.assertRaises(OSError):
                _listen('0.0.0.0', 8000)
        self.assertEqual(factory.call_count, 1)

    def test_environment_port_must_not_silently_change(self):
        os.environ['STSS_PORT'] = '8000'
        with patch('app.http_server.create_server', side_effect=OSError(errno.EADDRINUSE, 'occupied')) as factory:
            with self.assertRaises(OSError):
                _listen('0.0.0.0')
        self.assertEqual(factory.call_count, 1)

    def test_unrelated_network_failure_is_not_hidden(self):
        with patch('app.http_server.create_server', side_effect=OSError(errno.EADDRNOTAVAIL, 'bad address')) as factory:
            with self.assertRaises(OSError):
                _listen('bad-host')
        self.assertEqual(factory.call_count, 1)

    def test_zero_port_reaches_socket_factory(self):
        server = SimpleNamespace(server_port=54321)
        with patch('app.http_server.create_server', return_value=server) as factory:
            self.assertIs(_listen('127.0.0.1', 0), server)
        factory.assert_called_once_with(('127.0.0.1', 0))

    def test_all_network_adapters_are_listed_without_loopback_or_duplicates(self):
        addresses = ['10.145.142.5', '10.153.172.225', '127.0.0.1', '169.254.1.2', '0.0.0.0']
        records = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', (address, 0)) for address in addresses]
        with patch('app.http_server._local_ip', return_value='10.145.142.5'), patch('socket.getaddrinfo', return_value=records):
            self.assertEqual(_local_ips(), ['10.145.142.5', '10.153.172.225'])

    def test_adapter_address_is_available_without_default_route(self):
        record = (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('10.153.172.225', 0))
        with patch('app.http_server._local_ip', return_value=''), patch('socket.getaddrinfo', return_value=[record]):
            self.assertEqual(_local_ips(), ['10.153.172.225'])

    def test_adapter_lookup_failure_retains_default_route_address(self):
        with patch('app.http_server._local_ip', return_value='10.145.142.5'), patch('socket.getaddrinfo', side_effect=OSError):
            self.assertEqual(_local_ips(), ['10.145.142.5'])

    def test_missing_network_addresses_still_fall_back_to_manual_hint(self):
        with patch('app.http_server._local_ip', return_value=''), patch('socket.getaddrinfo', side_effect=OSError):
            self.assertEqual(_local_ips(), [])

    def test_startup_displays_both_adapter_urls(self):
        server = SimpleNamespace(server_port=8000, serve_forever=Mock(side_effect=KeyboardInterrupt), server_close=Mock())
        with tempfile.TemporaryDirectory(prefix='stss-startup-events-') as events:
            with patch('app.http_server.db.init_db'), patch('app.http_server.db.connect'), \
                    patch.object(config, 'EVENTS_DIR', Path(events)), \
                    patch.object(config, 'HOST', '0.0.0.0'), \
                    patch('app.http_server.security.ensure_default_users', return_value=None), \
                    patch('app.http_server._listen', return_value=server), \
                    patch('app.http_server._local_ips', return_value=['10.145.142.5', '10.153.172.225']):
                with contextlib.redirect_stdout(io.StringIO()) as output:
                    serve()
        self.assertIn('http://10.145.142.5:8000/', output.getvalue())
        self.assertIn('http://10.153.172.225:8000/', output.getvalue())
        self.assertIn('Wi-Fi', output.getvalue())
        server.server_close.assert_called_once()

    def test_failed_startup_prints_error_and_returns_failure_without_hanging_pipe(self):
        with patch.object(run, 'main', side_effect=RuntimeError('migration failed')):
            with patch.object(run.sys, 'stdin', SimpleNamespace(isatty=lambda: False)):
                with patch('builtins.input') as pause:
                    with contextlib.redirect_stderr(io.StringIO()) as output:
                        self.assertEqual(run.entrypoint(), 1)
        self.assertIn('migration failed', output.getvalue())
        self.assertIn('启动失败', output.getvalue())
        pause.assert_not_called()

    def test_import_configuration_error_is_caught_by_entrypoint(self):
        root = Path(__file__).resolve().parents[1]
        env = dict(os.environ, STSS_PORT='not-a-number', PYTHONIOENCODING='utf-8')
        result = subprocess.run([sys.executable, str(root / 'run.py')], env=env,
                                stdin=subprocess.DEVNULL, capture_output=True,
                                encoding='utf-8', timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertIn('not-a-number', result.stderr)
        self.assertIn('启动失败', result.stderr)


if __name__ == '__main__':
    unittest.main()

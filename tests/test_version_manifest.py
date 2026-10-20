"""Version, cache and release-manifest consistency for the P1 fix release."""
import hashlib
import json
import re
import unittest
from pathlib import Path

PRODUCT = Path(__file__).resolve().parents[1]
ROOT = PRODUCT.parent


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class VersionManifestTest(unittest.TestCase):
    def test_version_and_cache_are_bumped(self):
        package = json.loads((PRODUCT / 'package.json').read_text(encoding='utf-8'))
        self.assertEqual(package['version'], '1.3.19')
        sw = (PRODUCT / 'web/sw.js').read_text(encoding='utf-8')
        self.assertIn("const CACHE = 'stss-shell-v80'", sw)
        readme = (PRODUCT / 'README.md').read_text(encoding='utf-8')
        self.assertIn('1.3.19', readme.splitlines()[0])
        changelog = (PRODUCT / 'CHANGELOG.md').read_text(encoding='utf-8')
        self.assertIn('## 1.3.19', changelog)
        usage = (PRODUCT / 'docs/体育馆大屏使用说明-20261017.md').read_text(encoding='utf-8')
        self.assertIn('1.3.19', usage)
        self.assertIn('stss-shell-v80', usage)
        template_note = (PRODUCT / 'docs/报名模板填写说明-20261018.md').read_text(encoding='utf-8')
        self.assertIn('1.3.19', template_note)
        self.assertIn('stss-shell-v80', template_note)
        fix_note = (PRODUCT / 'docs/报名页错误反馈修复-20261018.md').read_text(encoding='utf-8')
        self.assertIn('1.3.17', fix_note)
        self.assertIn('stss-shell-v78', fix_note)

    def test_role_documentation_matches_readonly_setup_roles(self):
        readme = (PRODUCT / 'README.md').read_text(encoding='utf-8')
        for role in ['赛事管理员', '编排与成绩人员', '场地记录员', '成绩查看者', '大屏操作员']:
            self.assertIn(role, readme)
        self.assertIn('赛事设置只读', readme)
        admin_js = (PRODUCT / 'web/js/views/admin.js').read_text(encoding='utf-8')
        self.assertIn('大屏操作员', admin_js)

    def test_release_manifest_matches_files_and_source_manifest(self):
        manifest = json.loads((PRODUCT / 'release-manifest.json').read_text(encoding='utf-8'))
        package = json.loads((PRODUCT / 'package.json').read_text(encoding='utf-8'))
        self.assertEqual(manifest['version'], package['version'])
        self.assertEqual(manifest['startup'], 'start.cmd')
        self.assertGreaterEqual(len(manifest['files']), 200)
        self.assertRegex(manifest['previous_release_manifest_sha256'], r'^[0-9a-f]{64}$')
        self.assertRegex(manifest['source_manifest_sha256'], r'^[0-9a-f]{64}$')
        self.assertEqual(manifest['source_manifest_sha256'], sha(ROOT / 'src/source_manifest.json'))
        for row in manifest['files']:
            path = PRODUCT / row['path']
            self.assertTrue(path.is_file(), row['path'])
            self.assertEqual(row['sha256'], sha(path), row['path'])
            self.assertEqual(row['bytes'], path.stat().st_size, row['path'])

    def test_frozen_source_manifest_verifies(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('source_manifest', ROOT / 'src/source_manifest.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertRegex(module.verify(), r'^[0-9a-f]{64}$')


if __name__ == '__main__':
    unittest.main()

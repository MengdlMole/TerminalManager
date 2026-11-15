"""Release checks use fake binaries; no network, signing tools, or GitHub writes."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('release', Path(__file__).resolve().parents[1] / 'scripts/release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
COMMIT = 'a' * 40


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / 'src-tauri').mkdir()

    def versions(self, version='0.1.0'):
        (self.root / 'package.json').write_text(json.dumps({'version': version}))
        (self.root / 'package-lock.json').write_text(json.dumps({'version': version, 'packages': {'': {'version': version}}}))
        (self.root / 'src-tauri/tauri.conf.json').write_text(json.dumps({'version': version}))
        (self.root / 'src-tauri/Cargo.toml').write_text(f'[package]\nname = "terminal-manager"\nversion = "{version}"\n')
        (self.root / 'src-tauri/Cargo.lock').write_text(f'[[package]]\nname = "terminal-manager"\nversion = "{version}"\n')

    @patch.object(subprocess, 'check_output', return_value=COMMIT + '\n')
    def test_version_mismatch_stops_release(self, _):
        self.versions()
        self.assertEqual(release.validate(self.root, 'v0.1.0')['version'], '0.1.0')
        (self.root / 'package.json').write_text('{"version":"0.2.0"}')
        with self.assertRaisesRegex(ValueError, 'does not match'):
            release.validate(self.root, 'v0.1.0')

    def test_invalid_tag_is_rejected_before_any_git_operation(self):
        for tag in ['main', 'v01.0.0', 'v0.1', 'v0.1.0;echo bad', '../../main']:
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                release.validate(self.root, tag)

    @patch.object(subprocess, 'check_output', side_effect=[COMMIT + '\n', 'b' * 40 + '\n'])
    def test_tag_must_point_to_checked_out_commit(self, _):
        self.versions()
        with self.assertRaisesRegex(ValueError, 'does not match the version tag'):
            release.validate(self.root, 'v0.1.0', check_ref=True)

    def fake_build(self, target):
        binary_dir = self.root / 'src-tauri/target' / target / 'release'
        for bundle, suffix in release.TARGETS[target]:
            folder = binary_dir / 'bundle' / bundle
            folder.mkdir(parents=True)
            (folder / ('test' + suffix)).write_bytes(b'fake installer')
        executable = binary_dir / ('tmctl.exe' if 'windows' in target else 'tmctl')
        executable.write_bytes(b'fake CLI')
        executable.chmod(0o755)
        return binary_dir

    def test_collect_linux_preserves_cli_permissions_and_validates_every_bundle(self):
        target = 'x86_64-unknown-linux-gnu'
        binary_dir = self.fake_build(target)
        destination = self.root / 'output'
        manifest = release.collect(self.root, '0.1.0', COMMIT, target, destination)
        self.assertEqual(len(manifest['assets']), 3)
        for asset in manifest['assets']:
            self.assertEqual(asset['sha256'], release.checksum(destination / asset['name']))
        archive = next(a['name'] for a in manifest['assets'] if a['name'].endswith('.tar.gz'))
        with tarfile.open(destination / archive) as package:
            self.assertEqual(package.extractfile('tmctl').read(), b'fake CLI')
            self.assertTrue(package.getmember('tmctl').mode & 0o111)
        (binary_dir / 'bundle/deb/test.deb').unlink()
        with self.assertRaisesRegex(ValueError, 'exactly one deb'):
            release.collect(self.root, '0.1.0', COMMIT, target, self.root / 'incomplete')
        self.assertFalse((self.root / 'incomplete').exists())

    def test_collect_windows_packages_cli_and_installer_separately(self):
        target = 'x86_64-pc-windows-msvc'
        self.fake_build(target)
        manifest = release.collect(self.root, '0.1.0', COMMIT, target, self.root / 'output')
        self.assertEqual(len(manifest['assets']), 2)
        self.assertTrue(manifest['assets'][0]['name'].endswith('-setup.exe'))
        with zipfile.ZipFile(self.root / 'output' / manifest['assets'][1]['name']) as package:
            self.assertEqual(package.namelist(), ['tmctl.exe'])
            self.assertEqual(package.read('tmctl.exe'), b'fake CLI')


if __name__ == '__main__':
    unittest.main()

#!/usr/bin/env python3
"""Validate versions and collect native release artifacts; Python 3.11+, stdlib only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tomllib
import zipfile

ROOT = Path(__file__).resolve().parent.parent
TARGETS = {
    'x86_64-pc-windows-msvc': [('nsis', '.exe')],
    'aarch64-apple-darwin': [('dmg', '.dmg')],
    'x86_64-apple-darwin': [('dmg', '.dmg')],
    'x86_64-unknown-linux-gnu': [('appimage', '.AppImage'), ('deb', '.deb')],
}
VERSION = re.compile(r'v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?\Z')


def checksum(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def validate(root, tag, check_ref=False):
    if not VERSION.fullmatch(tag):
        raise ValueError('Use a version tag such as v0.1.0 or v0.1.0-beta.1')
    version = tag[1:]
    package = json.loads((root / 'package.json').read_text())
    lock = json.loads((root / 'package-lock.json').read_text())
    tauri = json.loads((root / 'src-tauri/tauri.conf.json').read_text())
    cargo = tomllib.loads((root / 'src-tauri/Cargo.toml').read_text())
    cargo_lock = tomllib.loads((root / 'src-tauri/Cargo.lock').read_text())
    own_package = next(p for p in cargo_lock['package'] if p['name'] == cargo['package']['name'] and 'source' not in p)
    versions = {
        'package.json': package['version'],
        'package-lock.json': lock['version'],
        'package-lock.json packages root': lock['packages']['']['version'],
        'tauri.conf.json': tauri['version'],
        'Cargo.toml': cargo['package']['version'],
        'Cargo.lock': own_package['version'],
    }
    for file, actual in versions.items():
        if actual != version:
            raise ValueError(f'{file}: version {actual!r} does not match tag {tag!r}')
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    if check_ref:
        tagged_commit = subprocess.check_output(['git', 'rev-parse', '--verify', f'refs/tags/{tag}^{{commit}}'], cwd=root, text=True).strip()
        if tagged_commit != commit:
            raise ValueError('Checked-out commit does not match the version tag')
    return {'version': version, 'commit': commit}


def collect(root, version, commit, target, destination):
    if target not in TARGETS:
        raise ValueError(f'Unsupported release target: {target}')
    if not VERSION.fullmatch('v' + version) or not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('Invalid release version or commit')
    release = root / 'src-tauri' / 'target' / target / 'release'
    # Require every installer before copying anything, never upload a partial target.
    sources = []
    for bundle, suffix in TARGETS[target]:
        found = list((release / 'bundle' / bundle).glob('*' + suffix))
        if len(found) != 1:
            raise ValueError(f'Expected exactly one {bundle} installer, got {len(found)}')
        sources.append((found[0], f'TerminalManager_{version}_{target}{"-setup" if bundle == "nsis" else ""}{suffix}'))
    windows = 'windows' in target
    executable = release / ('tmctl.exe' if windows else 'tmctl')
    if not executable.is_file():
        raise ValueError(f'Missing CLI executable: {executable}')
    destination.mkdir(parents=True, exist_ok=True)
    names = []
    for source, name in sources:
        shutil.copyfile(source, destination / name)
        names.append(name)
    archive = f'tmctl_{version}_{target}' + ('.zip' if windows else '.tar.gz')
    if windows:
        with zipfile.ZipFile(destination / archive, 'w', zipfile.ZIP_DEFLATED) as output:
            output.write(executable, arcname='tmctl.exe')
    else:
        with tarfile.open(destination / archive, 'w:gz') as output:
            output.add(executable, arcname='tmctl')
    names.append(archive)
    manifest = {
        'version': version, 'commit': commit, 'target': target,
        'assets': [{'name': name, 'sha256': checksum(destination / name)} for name in names],
    }
    (destination / f'manifest-{target}.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    check = commands.add_parser('validate')
    check.add_argument('--tag', default=os.environ.get('RELEASE_TAG', ''))
    check.add_argument('--check-ref', action='store_true')
    commands.add_parser('collect')
    args = parser.parse_args()
    if args.command == 'validate':
        result = validate(ROOT, args.tag, args.check_ref)
        if os.environ.get('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
                for key, value in result.items():
                    output.write(f'{key}={value}\n')
        print(json.dumps(result))
    else:
        print(json.dumps(collect(ROOT, os.environ['RELEASE_VERSION'], os.environ['RELEASE_COMMIT'],
                                 os.environ['RELEASE_TARGET'], ROOT / 'release-assets'), indent=2))


if __name__ == '__main__':
    main()

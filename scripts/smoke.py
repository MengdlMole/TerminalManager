#!/usr/bin/env python3
"""End-to-end desktop/CLI check. Uses an isolated config and closes only its own terminals/app."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--app', required=True, type=Path)
    parser.add_argument('--cli', required=True, type=Path)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    app_path, cli_path = args.app.resolve(), args.cli.resolve()

    def processes():
        if os.name == 'nt':
            return {}
        result = subprocess.run(['ps', '-axo', 'pid=,ppid=,rss=,time=,comm='], text=True, capture_output=True, check=True)
        rows = {}
        for line in result.stdout.splitlines():
            parts = line.strip().split(None, 4)
            if len(parts) == 5:
                pid, ppid, rss, cpu, name = parts
                cpu_seconds = 0
                for part in cpu.split(':'):
                    cpu_seconds = cpu_seconds * 60 + float(part)
                rows[int(pid)] = {'pid': int(pid), 'ppid': int(ppid), 'rssKiB': int(rss), 'cpuSeconds': cpu_seconds, 'name': name}
        return rows

    baseline = processes()
    measurements = []
    terminals = []
    with tempfile.TemporaryDirectory(prefix='terminalmanager-smoke-') as directory:
        env = dict(os.environ, TM_CONFIG_DIR=directory)
        log_path = Path(directory) / 'app.log'
        with log_path.open('w') as log:
            app = subprocess.Popen([str(app_path)], env=env, stdout=log, stderr=log)

            def cli(*arguments):
                result = subprocess.run([str(cli_path), *arguments], env=env, text=True, capture_output=True, timeout=18)
                if result.returncode:
                    raise RuntimeError(f'tmctl {arguments}: {result.stderr.strip()}')
                return json.loads(result.stdout)

            def wait_text(identifier, expected, timeout=12):
                deadline = time.monotonic() + timeout
                last = ''
                while time.monotonic() < deadline:
                    last = cli('read', identifier, '--lines', '30')['text']
                    if expected in last:
                        return last
                    time.sleep(.08)
                raise AssertionError(f'Missing {expected!r} in {last!r}')

            def measure(count):
                time.sleep(1)
                before = processes()
                start = time.monotonic()
                time.sleep(2)
                rows = processes()
                elapsed = time.monotonic() - start
                # macOS WebKit XPC helpers are often reparented to launchd. Isolated run:
                # include only newly created WebKit processes plus this application's PID.
                owned = [r for pid, r in rows.items() if pid == app.pid or
                         (pid not in baseline and 'com.apple.WebKit.' in r['name'])]
                shell_pids = {t.get('pid') for t in cli('list')}
                shells = [r for pid, r in rows.items() if pid in shell_pids]
                measurements.append({'terminals': count, 'appAndWebKitRssMiB': round(sum(r['rssKiB'] for r in owned) / 1024, 1),
                                     'appAndWebKitCpuPercent': round(sum(max(0, r['cpuSeconds'] - before.get(r['pid'], r)['cpuSeconds']) for r in owned) / elapsed * 100, 2),
                                     'shellRssMiB': round(sum(r['rssKiB'] for r in shells) / 1024, 1), 'processes': owned})

            try:
                deadline = time.monotonic() + 20
                while not (Path(directory) / 'control.json').exists():
                    if app.poll() is not None:
                        raise RuntimeError(log_path.read_text())
                    if time.monotonic() > deadline:
                        raise RuntimeError('Application did not start')
                    time.sleep(.1)
                # Endpoint is created before the WebView has finished loading its listeners.
                while True:
                    try:
                        assert cli('list') == []
                        break
                    except RuntimeError:
                        if time.monotonic() > deadline:
                            raise
                        time.sleep(.1)
                measure(0)
                shell = 'powershell.exe' if os.name == 'nt' else '/bin/sh'
                first = cli('new', '--name', '背景终端', '--group', '验证', '--tags', '后台,test', '--shell', shell, '--cwd', directory)
                second = cli('new', '--name', '前台终端', '--group', '验证', '--shell', shell, '--cwd', directory)
                terminals.extend([first, second])
                if os.name != 'nt':
                    # "running" is written only after the delay, while this terminal is hidden.
                    cli('send', first['id'], "sleep 0.4; printf '\\n中文_background_done\\n'", '--enter')
                    cli('focus', second['id'])
                    wait_text(first['id'], '\n中文_background_done\n')
                    cli('send', second['id'], "printf '\\nforeground_ok\\n'", '--enter')
                    wait_text(second['id'], '\nforeground_ok\n')
                    cli('send', second['id'], 'sleep 30', '--enter')
                    time.sleep(.15)
                    cli('send', second['id'], '\x03')
                    cli('send', second['id'], "printf '\\ninterrupt_ok\\n'", '--enter')
                    wait_text(second['id'], '\ninterrupt_ok\n')
                    cli('send', first['id'], "i=0; while [ $i -lt 20000 ]; do printf 'row_%s_abcdefghijklmno\\n' $i; i=$((i+1)); done; printf '\\nFLOW_COMPLETE\\n'", '--enter')
                    wait_text(first['id'], '\nFLOW_COMPLETE\n', timeout=20)
                cli('rename', first['id'], '重命名终端')
                cli('tag', first['id'], '性能,后台')
                cli('group', first['id'], '测试项目')
                saved = next(t for t in cli('list') if t['id'] == first['id'])
                assert saved['name'] == '重命名终端' and saved['tags'] == ['性能', '后台'] and saved['group'] == '测试项目'
                cli('close', second['id'])
                measure(1)
                for count in range(2, 31):
                    terminals.append(cli('new', '--name', f'idle-{count}', '--group', '空闲测试', '--shell', shell, '--cwd', directory))
                    if count in (10, 30):
                        measure(count)
                assert len(cli('list')) == 30
                for terminal in cli('list'):
                    cli('close', terminal['id'])
                assert cli('list') == []
                measure(0)
                print('PASS: real PTY, Unicode, hidden-terminal progress, Ctrl+C, output flow control, metadata, CLI, 30 terminals, teardown')
                report = {'platform': os.uname().sysname if os.name != 'nt' else 'Windows', 'measurements': measurements,
                          'notes': 'Release build; RSS includes main + newly created WebKit helpers, excludes shells. RSS sums may double-count shared pages. Idle CPU uses CPU-time deltas over 2 seconds after 1 second settling, not a long-duration benchmark. 1-terminal sample includes prior high-output history. WebView allocation/cache need not return RSS immediately after closing terminals.'}
                if args.report:
                    args.report.parent.mkdir(parents=True, exist_ok=True)
                    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
                for sample in measurements:
                    print(f"{sample['terminals']:2d} terminals: app+WebKit RSS {sample['appAndWebKitRssMiB']} MiB, CPU {sample['appAndWebKitCpuPercent']}%, shells {sample['shellRssMiB']} MiB")
            finally:
                try:
                    for terminal in cli('list'):
                        cli('close', terminal['id'])
                finally:
                    app.terminate()
                    try:
                        app.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        app.kill()
                        app.wait(timeout=5)


if __name__ == '__main__':
    main()

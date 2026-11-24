import argparse
import hashlib
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import uiautomator2 as u2

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import tv_runtime_helpers as h

parser = argparse.ArgumentParser()
parser.add_argument('--serial', required=True)
args = parser.parse_args()
h.SERIAL = args.serial

PACKAGE = 'app.panda.tv'
FILES = '/data/user/0/app.panda.tv/files'
STATE = FILES + '/user-state.json'
RULES = FILES + '/play-sources.json'
OUTPUT = ROOT / '.tmp' / 'usage-audit-2026-11-22' / 'tv-storage'
OUTPUT.mkdir(parents=True, exist_ok=True)

def sha(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest().upper()

def stat_mode(path: str) -> tuple[str, str, str]:
    raw = h.run_adb('shell', 'stat', '-c', '%a:%u:%g', path).strip()
    parts = raw.split(':')
    if len(parts) != 3 or not all(part.isdigit() for part in parts):
        raise RuntimeError(f'Unexpected permissions for {path}: {raw}')
    return tuple(parts)

def state_digest() -> str:
    raw = h.run_adb('shell', 'sha256sum', STATE).split()[0]
    return raw.upper()

def firewall_digest(tool: str) -> str:
    return sha(h.run_adb('shell', tool, '-S').encode())

def optional_digest(path: str) -> str:
    raw = h.run_adb('shell', 'sha256sum', path, check=False).strip()
    return raw.split()[0].upper() if len(raw.split()) >= 2 and len(raw.split()[0]) == 64 else 'absent'

def restore_state():
    h.run_adb('shell', 'chmod', file_mode[0], FILES)
    h.run_adb('shell', 'am', 'force-stop', PACKAGE)
    h.run_adb('push', str(backup), STATE)
    h.run_adb('shell', 'chmod', state_mode[0], STATE)
    h.run_adb('shell', 'chown', state_mode[1] + ':' + state_mode[2], STATE)
    if state_digest() != original_sha:
        raise AssertionError('Complete original user state was not restored')

def snapshot(device, name: str):
    xml = device.dump_hierarchy(compressed=False)
    (OUTPUT / (name + '.xml')).write_text(xml, encoding='utf-8')
    device.screenshot(str(OUTPUT / (name + '.png')))
    return h.parse_nodes(xml)

file_mode = stat_mode(FILES)
state_mode = stat_mode(STATE)
backup = OUTPUT / 'private-original-user-state.json'
h.run_adb('pull', STATE, str(backup))
original_sha = sha(backup.read_bytes())
if state_digest() != original_sha:
    raise AssertionError('State backup did not match the installed application')
before = {
    'at': datetime.now(timezone.utc).isoformat(),
    'serial': args.serial,
    'apkSha256': h.installed_apk_sha256(),
    'userStateSha256': original_sha,
    'filesPermissions': file_mode,
    'statePermissions': state_mode,
    'sourceOverrideSha256': optional_digest(RULES),
    'ipv4RulesSha256': firewall_digest('iptables'),
    'ipv6RulesSha256': firewall_digest('ip6tables'),
    'displaySize': h.run_adb('shell', 'wm', 'size').strip(),
    'displayDensity': h.run_adb('shell', 'wm', 'density').strip(),
}
(OUTPUT / 'before.json').write_text(json.dumps(before, ensure_ascii=False, indent=2), encoding='utf-8')
cases = []
failure = None

try:
    device = u2.connect(args.serial)
    for index in range(2):
        restore_state()
        h.run_adb('shell', 'am', 'start', '-n', PACKAGE + '/.ui.MainActivity')
        h.wait_for(device, lambda nodes: any(node['text'] == '设置' for node in nodes), timeout=25)
        snapshot(device, f'run-{index + 1}-home')
        h.focus_top_bar(device)
        h.move_focus_to_text(device, '设置')
        focused = h.find_focused(h.dump_nodes(device))
        if focused is None or '设置' not in focused['childTexts']:
            raise AssertionError('Settings launcher was not focused')
        h.key('dpad_center')
        h.wait_for(device, lambda nodes: any('自动播放下一集' in node['childTexts'] for node in nodes if node['focused']), timeout=12)
        nodes = snapshot(device, f'run-{index + 1}-settings-before')
        focus = h.find_focused(nodes)
        if focus is None or '自动播放下一集' not in focus['childTexts']:
            raise AssertionError('Actual settings control was not focused before fault injection')
        pid = h.run_adb('shell', 'pidof', PACKAGE).strip()
        if not pid.isdigit():
            raise AssertionError('No foreground Panda TV process before input')
        started = datetime.now(timezone.utc).isoformat()
        try:
            h.run_adb('shell', 'chmod', '555', FILES)
            if stat_mode(FILES)[0] != '555':
                raise AssertionError('Read-only directory fault was not applied')
            h.key('dpad_center', wait=0.2)
            deadline = time.monotonic() + 8.0
            running_pid = pid
            while time.monotonic() < deadline:
                running_pid = h.run_adb('shell', 'pidof', PACKAGE, check=False).strip()
                if not running_pid:
                    break
                time.sleep(0.3)
            logs = h.run_adb('logcat', '-d', '--pid', pid, '-v', 'threadtime', '-s', 'AndroidRuntime:E')
            (OUTPUT / f'run-{index + 1}-android-runtime.log').write_text(logs, encoding='utf-8')
            snapshot(device, f'run-{index + 1}-after-activation')
            state_unchanged = state_digest() == original_sha
            observation = {
                'startedAt': started,
                'controlFocus': focus['childTexts'],
                'input': 'D-pad Confirm on real auto-next setting',
                'fault': 'app files directory temporarily chmod 555',
                'processExited': not bool(running_pid),
                'fatalMainThread': 'FATAL EXCEPTION: main' in logs,
                'permissionWriteFailure': 'FileNotFoundException' in logs and ('EACCES' in logs or 'Permission denied' in logs),
                'savedStateUnchangedBeforeRestoration': state_unchanged,
            }
            cases.append(observation)
            if not observation['processExited'] or not observation['fatalMainThread'] or not observation['permissionWriteFailure']:
                raise AssertionError('Storage failure did not produce the hypothesized main-thread crash')
        finally:
            restore_state()
        (OUTPUT / 'observations.json').write_text(json.dumps(cases, ensure_ascii=False, indent=2), encoding='utf-8')
except BaseException as error:
    failure = f'{type(error).__name__}: {error}'
finally:
    restore_state()
    after = {
        'at': datetime.now(timezone.utc).isoformat(),
        'apkSha256': h.installed_apk_sha256(),
        'userStateSha256': state_digest(),
        'filesPermissions': stat_mode(FILES),
        'statePermissions': stat_mode(STATE),
        'sourceOverrideSha256': optional_digest(RULES),
        'ipv4RulesSha256': firewall_digest('iptables'),
        'ipv6RulesSha256': firewall_digest('ip6tables'),
        'displaySize': h.run_adb('shell', 'wm', 'size').strip(),
        'displayDensity': h.run_adb('shell', 'wm', 'density').strip(),
    }
    restored = all(after[key] == before[key] for key in after if key != 'at')
    report = {'before': before, 'cases': cases, 'failure': failure, 'after': after, 'restored': restored}
    (OUTPUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'cases': cases, 'failure': failure, 'restored': restored, 'apkSha256': before['apkSha256']}, ensure_ascii=False, indent=2))
    if not restored:
        raise AssertionError('Device state or temporary permissions were not restored')
if failure:
    raise RuntimeError(failure)

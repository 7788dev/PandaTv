"""Replay home More links and keep the active tab and actual D-pad focus together."""
import argparse
import datetime
import json
import os
from pathlib import Path
import time
import xml.etree.ElementTree as ET
import uiautomator2 as u2
import tv_runtime_helpers as h

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--serial', required=True)
    parser.add_argument('--label', required=True)
    parser.add_argument('--repeat', type=int, default=2)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    h.SERIAL = args.serial
    os.environ['ADBUTILS_ADB_PATH'] = h.ADB
    d = u2.connect(args.serial)
    out = args.output or ROOT / '.tmp/e2e-evidence/tv-navigation' / args.label
    out.mkdir(parents=True, exist_ok=True)
    report = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'version': h.run_adb('shell', 'dumpsys', 'package', 'app.panda.tv').split('versionName=')[-1].splitlines()[0].strip(),
              'apkSha256': h.installed_apk_sha256(), 'cases': [], 'failures': []}

    def nav_state():
        xml = d.dump_hierarchy(compressed=False)
        ns = h.parse_nodes(xml)
        tabs = [n for n in ns if n['text'] in ['首页', '剧集', '电影', '综艺', '动漫', '纪录片', '我的'] and n['cy'] < 140]
        return xml, {'selected': [n['text'] for n in tabs if n['selected']],
                     'focused': [n['text'] for n in tabs if n['focused']]}

    def capture(name):
        xml, state = nav_state()
        (out / f'{name}.xml').write_text(xml.replace('\r\n', '\n').replace('\r', '\n'), encoding='utf-8', newline='\n')
        d.screenshot(str(out / f'{name}.png'))
        return state

    def activate_more(title, repeat):
        h.focus_top_bar(d)
        h.move_focus_to_text(d, '首页', max_steps=14)
        h.key('enter', wait=.5)
        h.wait_for(d, lambda ns: any(n['text'] == '首页' and n['selected'] for n in ns)
                   and ('播放' in h.texts(ns) or '剧集榜' in h.texts(ns)), timeout=30)
        h.key('dpad_down', wait=.32)
        for _ in range(16):
            focus = h.find_focused(h.dump_nodes(d))
            if focus and focus['cy'] > 140 and ('播放' in focus['childTexts'] or '详情' in focus['childTexts']):
                break
            h.key('dpad_up' if focus and focus['cy'] > 140 else 'dpad_down', wait=.32)
        else:
            raise AssertionError('Could not establish the home hero before testing downward focus')
        for _ in range(16):
            xml = d.dump_hierarchy(compressed=False)
            root = ET.fromstring(xml)
            parents = {child: parent for parent in root.iter('node') for child in parent}
            focused = next((n for n in root.iter('node') if n.get('focused') == 'true'), None)
            text = ' | '.join(n.get('text', '') for n in focused.iter('node')) if focused is not None else ''
            if focused is not None and '更多' in text:
                card = parents.get(parents.get(focused))
                labels = [n.get('text') for n in card.iter('node')] if card is not None else []
                if title in labels:
                    break
                if '剧集榜' in labels:
                    h.key('dpad_right', wait=.2)
                    continue
                if '电影榜' in labels and title == '动漫榜':
                    h.key('dpad_right', wait=.2)
                    continue
            h.key('dpad_down', wait=.25)
        else:
            raise AssertionError(f'D-pad did not reach {title} More')
        name = f'{title}-{repeat}'
        capture(name + '-before')
        h.key('enter', wait=.25)
        # Navigation selection is local and must be correct even while metadata loads.
        state = capture(name + '-after')
        expected = title.removesuffix('榜')
        result = {'name': name, **state}
        report['cases'].append(result)
        assert state['selected'] == [expected], f'Active page {expected} retained selection {state}'
        assert state['focused'] == [expected], f'Page changed to {expected}, but D-pad focus stayed elsewhere: {state}'
        h.key('dpad_right', wait=.2)
        _, moved = nav_state()
        assert moved['selected'] == [expected], f'Focus movement changed the active page: {moved}'
        h.key('dpad_left', wait=.2)
        result['passed'] = True
        print(f'PASS {name}: {state}', flush=True)

    state_path = '/data/user/0/app.panda.tv/files/user-state.json'
    scratch = ROOT / '.tmp/tv-nav-selection'
    scratch.mkdir(parents=True, exist_ok=True)
    backup = scratch / 'original.json'
    h.run_adb('shell', 'am', 'force-stop', 'app.panda.tv')
    original = h.run_adb('shell', 'cat', state_path)
    backup.write_text(original, encoding='utf-8')
    try:
        h.run_adb('shell', 'am', 'start', '-W', '-n', 'app.panda.tv/.ui.MainActivity')
        h.wait_for(d, lambda ns: '播放' in h.texts(ns), timeout=30)
        for repeat in range(1, args.repeat + 1):
            for title in ['剧集榜', '电影榜', '动漫榜']:
                try:
                    activate_more(title, repeat)
                except Exception as exc:
                    report['failures'].append({'name': f'{title}-{repeat}', 'error': str(exc)})
                    print(f'FAIL {title}-{repeat}: {exc}', flush=True)
                    capture(f'{title}-{repeat}-failure')
    finally:
        h.run_adb('shell', 'am', 'force-stop', 'app.panda.tv')
        remote = '/data/local/tmp/panda-tv-nav-selection-original.json'
        h.run_adb('push', str(backup), remote)
        h.run_adb('shell', 'cp', remote, state_path)
        h.run_adb('shell', 'rm', remote)
        report['userStateRestored'] = h.run_adb('shell', 'cat', state_path) == original
        (out / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"Report: {out / 'report.json'}", flush=True)
    assert report['userStateRestored'], 'Original user state was not restored'
    assert not report['failures'], f"{len(report['failures'])} navigation selection failures"


if __name__ == '__main__':
    main()

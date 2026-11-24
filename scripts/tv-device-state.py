"""Preserve and independently verify all TV user-state files around device replays."""

import argparse
from collections import Counter
import datetime
import hashlib
import json
from pathlib import Path
import re
import shlex

import tv_runtime_helpers as h

PACKAGE = "app.panda.tv"
FILES = f"/data/user/0/{PACKAGE}/files"


def shell(*parts: str) -> str:
    return h.run_adb("shell", " ".join(shlex.quote(str(part)) for part in parts))


def metadata(path: str) -> dict:
    mode, uid, gid, kind = shell("stat", "-c", "%a %u %g %F", path).strip().split(maxsplit=3)
    context = shell("ls", "-Zd", path).split()[0]
    return {"mode": mode, "uid": uid, "gid": gid, "kind": kind,
            "context": context if context.startswith("u:") else None}


def preserved_paths() -> list[str]:
    paths = shell("find", FILES, "-maxdepth", "1", "-name", "user-state.json*").splitlines()
    result = h.run_adb("shell", "test -e " + shlex.quote(FILES + "/play-sources.json") + " && echo present", check=False)
    if result.strip() == "present":
        paths.append(FILES + "/play-sources.json")
    for path in paths:
        name = Path(path).name
        if path != FILES + "/" + name or not (name.startswith("user-state.json") or name == "play-sources.json"):
            raise RuntimeError(f"Unexpected state path: {path}")
    return sorted(paths)


def display() -> dict:
    return {"size": shell("wm", "size"), "density": shell("wm", "density"),
            "fontScale": shell("settings", "get", "system", "font_scale"),
            "rotation": shell("settings", "get", "system", "user_rotation"),
            "autoRotation": shell("settings", "get", "system", "accelerometer_rotation")}


def apply_metadata(path: str, saved: dict) -> None:
    shell("chown", f"{saved['uid']}:{saved['gid']}", path)
    shell("chmod", saved["mode"], path)
    if saved.get("context"):
        shell("chcon", saved["context"], path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("snapshot", "restore", "verify"))
    parser.add_argument("--serial", required=True)
    parser.add_argument("--output", type=Path, required=True, help="Ignored directory containing the original state snapshot")
    args = parser.parse_args()
    h.SERIAL = args.serial
    out = args.output.resolve()
    manifest_path = out / "manifest.json"
    shell("am", "force-stop", PACKAGE)
    if args.mode == "snapshot":
        if manifest_path.exists():
            raise RuntimeError("The original device snapshot already exists; choose a new output directory")
        originals = out / "originals"
        originals.mkdir(parents=True, exist_ok=True)
        manifest = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "serial": args.serial,
                    "root": metadata(FILES), "files": {}, "display": display(),
                    "apkSha256": h.installed_apk_sha256(), "firewall": {}, "uid": None}
        package = shell("dumpsys", "package", PACKAGE)
        manifest["uid"] = re.search(r"(?:userId|appId)=(\d+)", package)[1]
        (out / "package-before.txt").write_text(package, encoding="utf-8")
        for path in preserved_paths():
            name = Path(path).name
            info = metadata(path)
            if info["kind"] != "regular file":
                raise RuntimeError(f"Cannot preserve non-file state material: {path} ({info['kind']})")
            target = originals / name
            h.run_adb("pull", path, str(target))
            info["sha256"] = hashlib.sha256(target.read_bytes()).hexdigest()
            manifest["files"][name] = info
        for binary in ("iptables", "ip6tables"):
            manifest["firewall"][binary] = shell(binary, "-S", "OUTPUT")
            (out / f"{binary}-save.txt").write_text(shell(binary + "-save"), encoding="utf-8")
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"snapshotSaved": True, "files": len(manifest["files"]), "apkSha256": manifest["apkSha256"]}))
        return

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest["serial"] != args.serial:
        raise RuntimeError("Snapshot serial does not match this device")
    if args.mode == "restore":
        shell("chmod", "700", FILES)
        existing = preserved_paths()
        for path in existing:
            if Path(path).name not in manifest["files"]:
                info = metadata(path)
                if info["kind"] == "directory":
                    shell("rmdir", path)
                elif info["kind"] == "regular file":
                    shell("rm", "--", path)
                else:
                    raise RuntimeError(f"Refusing to remove unexpected state material: {path}")
        for name, info in manifest["files"].items():
            local = out / "originals" / name
            if hashlib.sha256(local.read_bytes()).hexdigest() != info["sha256"]:
                raise RuntimeError(f"Original backup changed: {name}")
            remote = "/data/local/tmp/panda-restore-" + hashlib.sha256(name.encode()).hexdigest()[:16]
            h.run_adb("push", str(local), remote)
            shell("cp", remote, FILES + "/" + name)
            shell("rm", "--", remote)
            apply_metadata(FILES + "/" + name, info)
        apply_metadata(FILES, manifest["root"])
        for binary, before in manifest["firewall"].items():
            added = Counter(shell(binary, "-S", "OUTPUT").splitlines()) - Counter(before.splitlines())
            for rule, count in added.items():
                tokens = shlex.split(rule)
                if tokens[:2] != ["-A", "OUTPUT"] or "--uid-owner" not in tokens or "DROP" not in tokens:
                    raise RuntimeError(f"Unexpected network change; refusing to remove it: {rule}")
                if tokens[tokens.index("--uid-owner") + 1] != manifest["uid"]:
                    raise RuntimeError("Network change belongs to another app")
                for _ in range(count):
                    shell(binary, "-D", *tokens[1:])
        for field, command, pattern in (("size", "size", r"Override size:\s*(\S+)"),
                                        ("density", "density", r"Override density:\s*(\S+)")):
            match = re.search(pattern, manifest["display"][field])
            shell("wm", command, match[1] if match else "reset")
        for field, setting in (("fontScale", "font_scale"), ("rotation", "user_rotation"), ("autoRotation", "accelerometer_rotation")):
            value = manifest["display"][field].strip()
            if value == "null":
                shell("settings", "delete", "system", setting)
            else:
                shell("settings", "put", "system", setting, value)

    actual = {Path(path).name: path for path in preserved_paths()}
    report = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "serial": args.serial,
              "mode": args.mode, "fileSetRestored": set(actual) == set(manifest["files"]), "files": {},
              "directoryPermissionsRestored": metadata(FILES) == manifest["root"],
              "firewallRulesRestored": all(shell(binary, "-S", "OUTPUT") == before for binary, before in manifest["firewall"].items()),
              "displaySettingsRestored": display() == manifest["display"], "apkSha256": h.installed_apk_sha256()}
    for name, info in manifest["files"].items():
        if name not in actual:
            report["files"][name] = False
            continue
        same_metadata = metadata(actual[name]) == {key: value for key, value in info.items() if key != "sha256"}
        digest = shell("sha256sum", actual[name]).split()[0]
        report["files"][name] = same_metadata and digest == info["sha256"]
    report["completeUserStateRestored"] = report["fileSetRestored"] and all(report["files"].values()) and report["directoryPermissionsRestored"]
    (out / f"{args.mode}-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "files"}))
    if not all(report[field] for field in ("completeUserStateRestored", "firewallRulesRestored", "displaySettingsRestored")):
        raise RuntimeError("Device restoration differs from the original snapshot; inspect the report")


if __name__ == "__main__":
    main()

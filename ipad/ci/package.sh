#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
output="$1"
mkdir -p "$output"
output="$(cd "$output" && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

xcodebuild -project Panda.xcodeproj -scheme Panda -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath "$stage/build" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY= \
  CURRENT_PROJECT_VERSION="${GITHUB_RUN_NUMBER:-1}" build
app="$stage/build/Build/Products/Release-iphoneos/Panda.app"
test "$(lipo -archs "$app/Panda")" = "arm64"
xcrun vtool -show-build "$app/Panda" | tee "$stage/platform.txt"
grep -Eq 'platform IOS$' "$stage/platform.txt"
test ! -e "$app/embedded.mobileprovision"
test ! -d "$app/_CodeSignature"
if codesign -d "$app/Panda" 2>/dev/null; then
  echo "Expected an unsigned device executable" >&2
  exit 1
fi
python3 - "$app/Info.plist" <<'PY'
import plistlib, sys
with open(sys.argv[1], "rb") as file:
    info = plistlib.load(file)
assert info["UIDeviceFamily"] == [2]
assert info["MinimumOSVersion"] == "15.0"
assert info["CFBundleSupportedPlatforms"] == ["iPhoneOS"]
assert len(set(info["UISupportedInterfaceOrientations~ipad"])) == 4
assert not info.get("UIRequiresFullScreen")
PY
version="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$app/Info.plist")"
name="Panda-iPad-$version-unsigned.ipa"
mkdir "$stage/Payload"
ditto "$app" "$stage/Payload/Panda.app"
(cd "$stage" && /usr/bin/zip -qry "$output/$name" Payload)
unzip -tq "$output/$name"
(cd "$output" && shasum -a 256 "$name" > "$name.sha256")

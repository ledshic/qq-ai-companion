#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
if [[ $# != 1 ]]; then
  echo 'Usage: pnpm native:ios:sim <simulator-UDID> (keep pnpm native:ios:open running in another terminal)' >&2
  exit 1
fi
simulator_id=$1
project_dir="$PWD/apps/native/src-tauri/gen/apple"
output_dir="$PWD/artifacts/phase-a/ios-derived"
xcrun simctl bootstatus "$simulator_id" -b
xcodebuild -project "$project_dir/companion-phase-a.xcodeproj" \
  -scheme companion-phase-a_iOS -configuration debug -sdk iphonesimulator \
  -destination "id=$simulator_id" -derivedDataPath "$output_dir" CODE_SIGNING_ALLOWED=NO build
app_path="$output_dir/Build/Products/debug-iphonesimulator/Companion Phase A.app"
xcrun simctl install "$simulator_id" "$app_path"
xcrun simctl launch "$simulator_id" dev.qqcompanion.phasea

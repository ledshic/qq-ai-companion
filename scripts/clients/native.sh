#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
if [[ -x "$PWD/.local-tools/xcodegen/xcodegen/bin/xcodegen" ]]; then
  export PATH="$PWD/.local-tools/xcodegen/xcodegen/bin:$PATH"
fi
if [[ -d "$PWD/.local-tools/jdk/Contents/Home" ]]; then
  export JAVA_HOME="$PWD/.local-tools/jdk/Contents/Home"
fi
if [[ -d "$PWD/.local-tools/android" ]]; then
  export ANDROID_HOME="${ANDROID_HOME:-$PWD/.local-tools/android}"
fi
if [[ -z "${NDK_HOME:-}" && -d "${ANDROID_HOME:-/nonexistent}/ndk" ]]; then
  NDK_HOME=$(find "$ANDROID_HOME/ndk" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)
  export NDK_HOME
fi
if [[ "${1:-}" == android ]]; then
  [[ -n "${JAVA_HOME:-}" && -x "$JAVA_HOME/bin/java" ]] || { echo 'Android requires JDK 17: set JAVA_HOME.' >&2; exit 1; }
  [[ -d "${ANDROID_HOME:-/nonexistent}/platform-tools" && -d "${NDK_HOME:-/nonexistent}/toolchains" ]] || { echo 'Android requires SDK platform-tools and NDK: set ANDROID_HOME / NDK_HOME.' >&2; exit 1; }
fi
exec pnpm --filter @companion/native exec tauri "$@"

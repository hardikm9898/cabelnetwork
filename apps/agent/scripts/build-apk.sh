#!/usr/bin/env bash
# Builds the agent app APK inside Linux (Docker), from the current working copy.
#
#   apps/agent/scripts/build-apk.sh http://10.50.0.201:6600          # internal network, plain http
#   apps/agent/scripts/build-apk.sh https://cable.example.in         # public https server
#   ABIS=arm64-v8a,armeabi-v7a apps/agent/scripts/build-apk.sh …     # also very old 32-bit phones
#
# Output: apps/agent/dist-apk/cable-collect-<host>.apk  (install on the agents' phones)
# The APK is signed with the project's debug key: fine for installing directly on phones
# (internal distribution); a Play Store release needs its own upload key (use EAS).
set -euo pipefail
API_URL="${1:?usage: build-apk.sh <api base url, e.g. http://10.50.0.201:6600>}"
ABIS="${ABIS:-arm64-v8a}"          # every Android phone from ~2017 on
JOBS="${JOBS:-2}"                  # parallel compile jobs (Docker Desktop has ~8 GB; more jobs run out of memory)
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
ALLOW_HTTP=false
case "$API_URL" in http://*) ALLOW_HTTP=true ;; esac
NAME="cable-collect-$(echo "$API_URL" | sed -E 's#^https?://##; s#[^A-Za-z0-9]+#-#g; s#-$##').apk"
BOX=cablenet-apk-build
mkdir -p apps/agent/dist-apk

docker build -q -t cablenet-apk-builder -f docker/apk-builder.Dockerfile docker > /dev/null
docker rm -f "$BOX" > /dev/null 2>&1 || true

echo "Building $NAME for $API_URL (cleartext http allowed: $ALLOW_HTTP, ABIs: $ABIS) …"
MSYS_NO_PATHCONV=1 docker create --name "$BOX" \
  -e EXPO_PUBLIC_API_URL="$API_URL" -e EXPO_PUBLIC_ALLOW_HTTP="$ALLOW_HTTP" -e APK_NAME="$NAME" \
  -e ABIS="$ABIS" -e JOBS="$JOBS" -e CMAKE_BUILD_PARALLEL_LEVEL="$JOBS" \
  -v cablenet-gradle-cache:/root/.gradle -v cablenet-pnpm-store:/pnpm/store \
  cablenet-apk-builder bash -euo pipefail -c '
    pnpm config set store-dir /pnpm/store > /dev/null
    pnpm install --frozen-lockfile --filter @cablenet/agent...
    pnpm --filter @cablenet/domain build && pnpm --filter @cablenet/contracts build
    cd apps/agent
    npx expo prebuild --platform android --no-install --clean
    cd android
    ./gradlew assembleRelease --no-daemon --console=plain \
      -PreactNativeArchitectures="$ABIS" \
      -Dorg.gradle.workers.max="$JOBS" -Dorg.gradle.jvmargs="-Xmx2560m -XX:MaxMetaspaceSize=768m"
    mkdir -p /out && cp app/build/outputs/apk/release/app-release.apk "/out/$APK_NAME"
  ' > /dev/null

# Source = tracked + new files that git does not ignore (no node_modules, no .env, no Excel files).
git ls-files -co --exclude-standard -z | tar --null -cf - -T - | MSYS_NO_PATHCONV=1 docker cp - "$BOX:/src"

docker start "$BOX" > /dev/null
# Poll instead of following one long connection: Docker Desktop on Windows drops long-lived
# connections under heavy load, which must not end (or mis-report) the build.
SINCE=0
while :; do
  STATE="$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$BOX" 2>/dev/null || echo 'unknown -')"
  LINES="$(docker logs "$BOX" 2>&1 | grep -cE '^> Task' || true)"
  if [ "$LINES" != "$SINCE" ]; then echo "  … $LINES build steps done"; SINCE="$LINES"; fi
  case "$STATE" in exited*) break ;; esac
  sleep 20
done
STATUS="${STATE#exited }"
if [ "$STATUS" != "0" ]; then
  docker logs "$BOX" 2>&1 | grep -aA8 'What went wrong' || docker logs --tail 30 "$BOX" 2>&1
  echo "BUILD FAILED (exit $STATUS); the container is kept for inspection: docker logs $BOX"
  exit 1
fi
MSYS_NO_PATHCONV=1 docker cp "$BOX:/out/$NAME" "apps/agent/dist-apk/$NAME"
docker rm "$BOX" > /dev/null
echo "APK ready: apps/agent/dist-apk/$NAME ($(du -h "apps/agent/dist-apk/$NAME" | cut -f1))"

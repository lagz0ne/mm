#!/usr/bin/env bash
# The box image's tools for a project's own work (sy-qfca): in an image built from this checkout's box/Dockerfile, run
# as mm runs a box (its own uid, read-only root, cap-drop ALL, no-new-privileges, tmpfs /tmp and home; no network):
# ffmpeg encodes a frame; merman-cli renders a flowchart with the board's own arguments; the headless Chrome
# (`chromium`, CHROME_PATH) dumps a page's DOM and takes a screenshot; none of them misses a library (ldd); and the
# board's real server (template/site/server.mjs, MERMAN_BIN unset as in a box) answers POST /api/mermaid with an SVG.
# Through mm's Docker wrapper only (test/lib/docker.sh). Removed at the end: the container, the image, the copy.
#   test/box-tools.sh                 builds the image (BOX_IMAGE=<mm-box:tag> to use that one instead)
#   test/box-tools.sh --inside        (the part that runs in the container)
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  ok   $*"; }
bad() { fail=$((fail+1)); echo "  FAIL $*"; }

if [ "${1:-}" = --inside ]; then
  O=/tmp/out
  check() { local d=$1; shift; if "$@" >"$O" 2>&1; then ok "$d"; else bad "$d"; tail -5 "$O" | sed 's/^/       /'; fi; }
  echo "== the tools ($(id -u):$(id -g), $(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f1-3), merman-cli $(merman-cli --version 2>/dev/null), $(chromium --version 2>/dev/null))"
  for b in ffmpeg merman-cli /opt/chrome/chrome; do
    check "$b: every library found (ldd)" sh -c "p=\$(command -v $b) && ldd \"\$p\" >/tmp/ldd && ! grep 'not found' /tmp/ldd"
  done
  check "ffmpeg -version" ffmpeg -version
  check "ffmpeg encodes a frame (lavfi -> png)" sh -c 'ffmpeg -v error -f lavfi -i testsrc=d=1:s=64x48 -frames:v 1 -y /tmp/f.png && [ -s /tmp/f.png ]'
  check "merman-cli --version" merman-cli --version
  # the host's merman (manifest.yaml) and the box's are one version: the board renders the same in and out of a box
  want=$(sed -n 's/.*repo: Latias94\/merman, tag: v\([0-9.]*\),.*/\1/p' "$HERE/manifest.yaml")
  check "merman-cli is the manifest's version ($want)" sh -c "[ -n '$want' ] && merman-cli --version | grep -qw '$want'"
  check "merman-cli renders 'flowchart LR; A-->B' to an SVG (the board's arguments)" sh -c \
    "printf 'flowchart LR; A-->B' | merman-cli render -q -f svg --svg-pipeline resvg-safe -t default -b transparent -o - - >/tmp/m.svg && grep -q '<svg' /tmp/m.svg"
  check "chromium --version" chromium --version
  check "CHROME_PATH is the chromium on PATH" sh -c '[ "$CHROME_PATH" = "$(command -v chromium)" ] && [ -x "$CHROME_PATH" ]'
  check "chromium --headless --dump-dom about:blank" sh -c 'chromium --headless --dump-dom about:blank 2>/tmp/c.err | grep -q "<body>"'
  check "chromium renders a page's DOM (script ran)" sh -c \
    "chromium --headless --dump-dom 'data:text/html,<p id=p></p><script>p.textContent=\"box-\"+\"ok\"</script>' 2>/tmp/c.err | grep -q 'box-ok'"
  check "chromium takes a screenshot (fonts, compositor)" sh -c \
    "cd /tmp && chromium --headless --window-size=320,200 --screenshot=/tmp/s.png 'data:text/html,<h1>Box</h1>' 2>/tmp/c.err && [ -s /tmp/s.png ]"
  # the board's real server, as the board service runs it in a box: MERMAN_BIN unset, merman-cli from PATH
  B=$HERE/template; PORT=47391
  env -u MERMAN_BIN HOME=/tmp/h MM_HOME=/tmp/h/.mm MM_OBS_TRACES= MM_OBS_METRICS= PORT=$PORT HOST=127.0.0.1 BD_SERVE=http://127.0.0.1:9 \
    PASEO_BIN=/bin/true PASEO_NO_SDK=1 BOARD_PROJECT=t MM_PROJECT=t node "$B/site/server.mjs" >/tmp/srv.log 2>&1 &
  SRV=$!
  for _ in $(seq 1 80); do curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/whoami" 2>/dev/null && break; sleep 0.1; done
  check "the board's Mermaid route returns an SVG" sh -c \
    "curl -fsS -D /tmp/h.txt -o /tmp/r.svg --data-binary 'flowchart LR; A-->B' 'http://127.0.0.1:$PORT/api/mermaid' && grep -qi 'content-type: image/svg+xml' /tmp/h.txt && grep -q '<svg' /tmp/r.svg"
  [ "$fail" -eq 0 ] || tail -5 /tmp/srv.log | sed 's/^/       board: /'
  kill "$SRV" 2>/dev/null
  echo; echo "$pass passed, $fail failed"
  [ "$fail" -eq 0 ]; exit
fi

. "$HERE/test/lib/docker.sh"
W=$DOCKER
T=$(mm_test_dir tools); P=$(basename "$T"); BOX="mm-box-$P"; G=$(id -g); BUID=$((200000 + $$ % 50000))
IMG=${BOX_IMAGE:-}; BUILT=""; RAN=""
cleanup() { $W rm -f "$BOX" >/dev/null 2>&1
  # what the box's uid wrote in the copy: removed by that uid
  [ -n "$RAN" ] && $W run --rm --name "$BOX" --label "mm.project=$P" --network none --user "$BUID:$G" --cap-drop ALL -v "$T:$T" "$IMG" sh -c "rm -rf '$T'/* '$T'/.[!.]*" >/dev/null 2>&1
  [ -n "$BUILT" ] && $W rmi -f "$BUILT" >/dev/null 2>&1
  rm -rf "$T"; }
trap cleanup EXIT
if [ -z "$IMG" ]; then
  # as mm box build does: box/ copied into a folder of the owner's (mm-box-build-*), then built there
  IMG=mm-box:toolstest-$$; BB="$T/mm-box-build-tools$$"; mkdir -p "$BB"; chmod 700 "$BB"; cp -r "$HERE/box/." "$BB/"
  echo "== building $IMG from box/Dockerfile"
  $W build -q -t "$IMG" -f "$BB/Dockerfile" "$BB" >/dev/null || { echo "image build failed"; exit 1; }
  BUILT=$IMG; rm -rf "$BB"
fi
echo "== $IMG: $($W images --format '{{.Size}}' "$IMG")"
# for the size it adds: the newest other mm-box image here, if any (mm box build's)
$W images --format '{{.Repository}}:{{.Tag}} {{.Size}}' mm-box 2>/dev/null | grep -v -e test- -e '<none>' | sort -V | tail -1 | sed 's/^/   (here before: /; s/$/)/'
# the checkout as it is (its working tree, without .git), readable by the box's uid through the owner's group; the
# board's cache folder writable by it
tar -C "$HERE" --exclude=.git -cf - . | tar -C "$T" -xf - && mkdir -p "$T/template/.cache" && chmod -R g+rX "$T" && chmod 2775 "$T/template" "$T/template/.cache"
RAN=1
OUT=$($W run --rm --name "$BOX" --hostname "$P" --label "mm.project=$P" --network none \
  --user "$BUID:$G" --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 512 --memory 2g \
  --tmpfs /tmp:rw,nosuid,nodev,size=512m,mode=1777 \
  --tmpfs "/home/box:rw,nosuid,nodev,size=64m,uid=$BUID,gid=$G,mode=0700" -e HOME=/home/box -v "$T:$T" -w "$T" -e TMPDIR=/tmp "$IMG" bash "$T/test/box-tools.sh" --inside 2>&1)
echo "$OUT" | sed '/^[0-9]* passed, [0-9]* failed$/d'
pass=$(echo "$OUT" | sed -n 's/^\([0-9]*\) passed, \([0-9]*\) failed$/\1/p'); fail=$(echo "$OUT" | sed -n 's/^\([0-9]*\) passed, \([0-9]*\) failed$/\2/p')
[ -n "$pass" ] || { echo "the container gave no result"; pass=0; fail=1; }
echo; echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]

#!/bin/sh
# Invoked only during app will-quit, with a locally validated bundle and private job directory.
set -eu
parent_pid=$1
target=$2
source_app=$3
job=$4
incoming=$5
previous=$6
new_pid=''
replaced=0
write_result() { /usr/bin/printf '%s\n' "$1" > "$job/result"; }
recover() {
  if [ -n "$new_pid" ]; then kill "$new_pid" 2>/dev/null || true; wait "$new_pid" 2>/dev/null || true; fi
  if [ "$replaced" = 1 ] && [ -d "$previous" ]; then
    if [ -e "$target" ]; then /bin/mv "$target" "$job/failed.app" || true; fi
    /bin/mv "$previous" "$target" || true
  fi
  write_result failed
  if [ -x "$target/Contents/MacOS/ReviewOps" ]; then
    "$target/Contents/MacOS/ReviewOps" > "$job/rollback.log" 2>&1 &
    /usr/bin/printf '%s\n' "$!" > "$job/rollback.pid"
  fi
}
trap 'recover' EXIT
attempt=0
while kill -0 "$parent_pid" 2>/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 120 ]; then exit 1; fi
  /bin/sleep 1
done
[ -d "$target" ] && [ -d "$source_app" ] && [ ! -e "$incoming" ] && [ ! -e "$previous" ]
/usr/bin/ditto --norsrc "$source_app" "$incoming"
/usr/bin/codesign --verify --deep --strict "$incoming"
/bin/mv "$target" "$previous"
replaced=1
/bin/mv "$incoming" "$target"
# Launch our own process so a failed start can be rolled back without touching another app.
"$target/Contents/MacOS/ReviewOps" > "$job/launch.log" 2>&1 &
new_pid=$!
/usr/bin/printf '%s\n' "$new_pid" > "$job/launched.pid"
attempt=0
while [ ! -f "$job/healthy" ]; do
  kill -0 "$new_pid" 2>/dev/null || exit 1
  attempt=$((attempt + 1))
  [ "$attempt" -le 60 ] || exit 1
  /bin/sleep 1
done
write_result installed
# Retain the previous app in the private update cache for recovery.
/usr/bin/ditto --norsrc "$previous" "$job/previous.app" && /bin/rm -rf "$previous" || true
trap - EXIT
exit 0

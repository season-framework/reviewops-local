'use strict';

const quote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
function directory(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('에이전트 작업 ID가 올바르지 않습니다.');
  return `/tmp/reviewops-agent-${id}`;
}
function runner(settings, executable, assets = []) {
  return `umask 077
d=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 125
printf '%s\\n' "$$" > "$d/pid"
trap 'printf "143\\n" > "$d/result.tmp"; mv "$d/result.tmp" "$d/result"; exit 143' TERM INT
cd -- ${quote(settings.workPath)} || { printf '%s\\n' 'SSH 계정으로 에이전트 작업 폴더를 열 수 없습니다.' >> "$d/stderr"; printf '125\\n' > "$d/result"; exit 125; }
${executable} < "$d/input" >> "$d/stdout" 2>> "$d/stderr"
result=$?
printf '%s\\n' "$result" > "$d/result.tmp"
mv "$d/result.tmp" "$d/result"
rm -f -- "$d/input" ${assets.map(quote).join(' ')}
exit "$result"`;
}
function launch(id) {
  const d = directory(id);
  return `d=${quote(d)}
command -v nohup >/dev/null 2>&1 && command -v setsid >/dev/null 2>&1 || exit 127
# The private directory is created once. Reconnecting never launches this script again.
nohup setsid bash "$d/runner" </dev/null >/dev/null 2>&1 &
for attempt in 1 2 3 4 5 6 7 8 9 10; do [ -s "$d/pid" ] && exit 0; sleep .1; done
exit 75`;
}
function read(id, stdoutOffset = 0, stderrOffset = 0) {
  const d = directory(id);
  for (const offset of [stdoutOffset, stderrOffset]) if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('에이전트 출력 위치가 올바르지 않습니다.');
  return `d=${quote(d)}
[ -d "$d" ] || { printf 'missing\\n\\n0\\n0\\n\\n\\n'; exit 0; }
state=lost
if [ ! -s "$d/result" ]; then
  pid=$(cat "$d/pid" 2>/dev/null)
  case "$pid" in ''|*[!0-9]*) ;; *)
    command=$(ps -p "$pid" -o args= 2>/dev/null)
    case "$command" in *"$d/runner"*) if [ "$pid" -gt 1 ] && kill -0 -- "-$pid" 2>/dev/null; then state=running; fi;; esac;;
  esac
fi
# The runner can finish while ps is reading its command. Recheck the atomic
# result file after liveness detection before declaring a missing process.
if [ -s "$d/result" ]; then printf 'done\\n'; cat "$d/result"; else printf '%s\\n\\n' "$state"; fi
wc -c < "$d/stdout"
wc -c < "$d/stderr"
tail -c +${stdoutOffset + 1} "$d/stdout" | head -c 65536 | base64 | tr -d '\\n'
printf '\\n'
tail -c +${stderrOffset + 1} "$d/stderr" | head -c 65536 | base64 | tr -d '\\n'
printf '\\n'`;
}
function parseRead(output) {
  const [state, code, stdoutSize, stderrSize, stdout, stderr] = output.split('\n').map((value,index)=>index===2||index===3?value.trim():value);
  if (!['missing','lost','running','done'].includes(state) || !/^\d+$/.test(stdoutSize || '') || !/^\d+$/.test(stderrSize || '') || (state === 'done' && !/^\d{1,3}$/.test(code))) throw new Error('서버의 에이전트 실행 정보를 읽지 못했습니다.');
  if ([stdout,stderr].some(value => typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))) throw new Error('서버의 에이전트 출력을 읽지 못했습니다.');
  return {state, code:state === 'done' ? Number(code) : null, stdoutSize:Number(stdoutSize), stderrSize:Number(stderrSize), stdout:Buffer.from(stdout,'base64'), stderr:Buffer.from(stderr,'base64')};
}
function stop(id) {
  return `d=${quote(directory(id))}
[ -d "$d" ] || exit 75
[ -s "$d/pid" ] || exit 75
pid=$(cat "$d/pid")
case "$pid" in ''|*[!0-9]*) exit 76;; esac
[ "$pid" -gt 1 ] || exit 76
# A server restart can reuse an old PID. Only signal this job's runner.
command=$(ps -p "$pid" -o args= 2>/dev/null)
case "$command" in *"$d/runner"*) ;; *) [ -s "$d/result" ] && exit 0; exit 78;; esac
kill -TERM -- "-$pid" 2>/dev/null || true
for attempt in 1 2 3 4 5 6 7 8 9 10; do kill -0 -- "-$pid" 2>/dev/null || exit 0; sleep .2; done
kill -KILL -- "-$pid" 2>/dev/null || true
for attempt in 1 2 3 4 5 6 7 8 9 10; do kill -0 -- "-$pid" 2>/dev/null || exit 0; sleep .1; done
exit 77`;
}
function cleanup(id) { return `rm -rf -- ${quote(directory(id))}`; }

module.exports = {directory,runner,launch,read,parseRead,stop,cleanup};

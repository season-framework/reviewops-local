# 외부 도구에서 ReviewOps 리뷰 열기

외부 도구는 리뷰를 등록하거나 기존 리뷰를 프로젝트별 작업 창으로 열 수 있습니다. 이 연결은 에이전트 실행을 시작하지 않습니다. Codex, Claude Code, Hermes 등에서 사용할 수 있는 명령 실행 환경을 통해 같은 JSON 명령을 전달합니다. 특정 제품의 전용 API나 스킬 설치 기능은 포함하지 않습니다.

## 명령 사용

외부 도구 연결을 지원하는 ReviewOps 앱과 Node.js가 필요합니다. 앱을 실행한 뒤 저장소의 스크립트를 호출하십시오.

```sh
node skills/reviewops/scripts/reviewops.mjs list
node skills/reviewops/scripts/reviewops.mjs open <<'JSON'
{"requestId":"review-example-001","projectId":"PROJECT_ID","title":"문서 확인","body":"설치 안내의 경로를 확인하십시오.","tool":"claude-code"}
JSON
node skills/reviewops/scripts/reviewops.mjs status <<'JSON'
{"requestId":"review-example-001"}
JSON
```

macOS 기본 데이터 폴더는 `~/Library/Application Support/ReviewOps Local`, Windows는 `%APPDATA%\ReviewOps Local`입니다. 다른 데이터 폴더를 사용하는 경우 `--data-dir` 또는 `REVIEWOPS_DATA_DIR`로 지정하십시오. `.app`은 실행 앱이며 데이터 폴더가 아닙니다. 스크립트는 앱을 자동으로 실행하지 않습니다.

프로젝트 이름만으로 대상을 선택하지 않습니다. `list` 결과의 프로젝트 ID를 명시하거나 `workspacePath`에 전체 로컬 작업 폴더 경로를 지정하십시오. 두 항목을 동시에 지정할 수 없습니다. 작업 폴더는 심볼릭 링크를 해석한 실제 경로로 비교하며, 프로젝트와 연결이 하나로 결정될 때만 사용합니다. SSH 프로젝트는 프로젝트 ID로 선택하십시오.

프로젝트 ID를 명시하면 로컬 작업 폴더가 없어도 소유관계가 일치하는 리뷰를 열 수 있습니다. `workspacePath`로 선택할 때는 실제 폴더가 있어야 합니다. 어느 경우에도 에이전트를 자동 실행하지 않습니다.

프로젝트에 연결이 여러 개라면 `serviceId`를 추가하십시오. 이 연결이 선택한 프로젝트에 속하는지 검사합니다. 기존 리뷰를 열 때는 `reviewId`를 지정하고 `title`과 `body`를 생략합니다. 기존 리뷰에서도 프로젝트 또는 작업 폴더는 명시해야 합니다.

## 요청과 응답

| 명령 | 앱 요청 | 내용 |
| --- | --- | --- |
| `list` | `projects.list` | 프로젝트의 `id`, `name`, `kind`, `workPath`와 연결의 동일 항목을 반환합니다. 비밀번호, 키, 호스트 인증 정보를 반환하지 않습니다. |
| `open` | `review.open` | `requestId`, 대상(`projectId` 또는 `workspacePath`), 선택적인 `serviceId`, 새 리뷰의 `title`·`body` 또는 기존 `reviewId`, 선택적인 출처 이름 `tool`을 받습니다. |
| `status` | `review.status` | `requestId`로 저장된 요청과 표시 상태를 조회합니다. |

요청 ID는 영문·숫자·밑줄·하이픈으로 된 1~128자입니다. 제목은 300자, 본문은 100,000자, 도구 이름은 80자까지 받습니다. 요청 전체는 512 KiB 이하여야 합니다.

정상 응답은 `{ "ok": true, "data": ... }`, 오류는 `{ "ok": false, "error": { "code": "...", "message": "..." } }`입니다. `open`과 `status`의 `data`에는 원래 `payload`, `requestId`, `status`, `projectId`, `serviceId`, `reviewId`, `windowId`, `shown`, `message`와 저장 시각이 들어 있습니다.

| 상태 | 의미와 다음 작업 |
| --- | --- |
| `needs_project` | 대상이 없거나 여러 개이거나 저장된 연결이 변경되었습니다. 원래 요청을 보관합니다. 대상을 새로 지정하려면 새 요청 ID를 사용하십시오. 같은 경로의 프로젝트가 나중에 등록되거나 중복 연결이 정리되면 원래 요청을 그대로 재시도할 수 있습니다. |
| `opening` | 리뷰를 저장했으며 창 표시를 기다리고 있습니다. 같은 요청을 중복 제출하지 않고 상태를 조회할 수 있습니다. |
| `shown` | 요청한 프로젝트와 리뷰의 창을 표시했습니다. 에이전트 실행이나 리뷰 완료를 뜻하지 않습니다. |
| `display_failed` | 리뷰 준비 또는 창 표시에 실패했습니다. 원래 요청과 저장된 리뷰 ID를 유지합니다. 같은 ID와 내용으로 재시도하십시오. |

같은 요청 ID에 다른 내용이나 대상을 보내면 거절합니다. 동시에 같은 요청을 보내면 하나의 처리를 공유합니다. 앱이 재시작되거나 응답이 끊긴 경우에도 저장된 리뷰를 다시 사용합니다. 리뷰가 삭제된 경우 같은 ID로 새 리뷰를 만들지 않습니다.

상태는 마지막 요청의 처리 결과입니다. 사용자가 창을 닫아도 자동으로 변경되지 않습니다. 같은 요청을 다시 보내면 저장된 리뷰의 창을 다시 엽니다. SSH 서버 주소·별칭·포트·사용자명·설정 파일 경로가 달라진 경우에도 이전 요청을 그대로 열지 않고 대상 확인을 요구합니다.

## 앱 사이 연결

앱은 데이터 폴더의 `integrations/tools.json`에 `{version, socketPath, token, pid}`를 기록합니다. Unix에서는 `integrations/tools.sock`, Windows에서는 `\\.\pipe\reviewops-tools-...` 이름의 파이프를 사용합니다. TCP·HTTP 포트를 열지 않습니다. 클라이언트는 로컬 주소와 토큰을 검사합니다.

Unix 폴더 권한은 `0700`, 연결 파일·요청 기록·소켓은 `0600`입니다. Windows에서는 사용자 데이터 폴더의 접근 권한을 사용합니다. 토큰은 앱 실행마다 바뀌며 명령 출력에 포함하지 않습니다. 연결 파일을 공유하거나 저장소에 추가하지 마십시오.

소켓 요청은 `{token, action, payload}` JSON 한 줄이며, 연결마다 요청 하나와 응답 하나를 처리합니다. 요청 기록은 `integrations/tools-state.json`에 저장합니다. 이 파일에는 요청 본문이 포함되며 JSON 프로젝트 백업에 자동 포함되지 않습니다. 새 리뷰에는 중복 방지용 요청 ID와 내용의 해시, 도구 이름을 저장합니다.

리뷰 저장과 요청 기록 변경만 순서대로 처리합니다. 창 표시를 기다리는 동안 다른 프로젝트의 요청과 상태 조회를 처리할 수 있습니다. 기존 Season AI 연결은 별도로 유지합니다.

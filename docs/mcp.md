# Codex·Claude Code에서 여러 프로젝트 QA 실행

ReviewOps MCP 서버는 프로젝트·리뷰·작업 실행을 직접 조회하고 수정한다. 화면 QA는 프로젝트 창의 웹 화면에 입력을 전달하므로 시스템 마우스와 키보드를 공유하지 않는다. Codex 두 개 또는 Codex와 Claude Code가 서로 다른 프로젝트를 동시에 검사할 수 있다.

## 준비

ReviewOps 앱과 Node.js를 같은 컴퓨터에서 실행한다. ReviewOps에 검사할 프로젝트와 연결을 등록한다. 에이전트 작업을 시작하려면 해당 프로젝트에서 에이전트 실행 파일·작업 폴더·로그인을 설정한다.

설치 앱에는 `mcp/reviewops-mcp.cjs`와 `mcp/automation-api.cjs`가 함께 포함된다.

| 실행 환경 | MCP 서버 파일 |
| --- | --- |
| macOS 설치 앱 | `/Applications/ReviewOps.app/Contents/Resources/mcp/reviewops-mcp.cjs` |
| Windows 설치 앱 | ReviewOps 설치 폴더의 `resources\mcp\reviewops-mcp.cjs` |
| 저장소 소스 | 저장소의 `electron/mcp-server.cjs` |

앱을 먼저 실행한다. MCP 서버는 앱 데이터 폴더의 `integrations/tools.json`을 읽어 실행 중인 앱에 연결한다. 기본 데이터 폴더는 macOS의 `~/Library/Application Support/ReviewOps Local`, Windows의 `%APPDATA%\ReviewOps Local`이다. 다른 폴더를 사용하는 앱에는 `--data-path`로 같은 폴더를 지정한다.

아래 명령의 Node.js·앱 경로는 설치 위치에 맞게 바꾼다. Node.js의 전체 경로를 사용하면 외부 에이전트의 PATH 설정과 관계없이 실행할 수 있다.

## Codex 연결

Codex의 [MCP 설정](https://developers.openai.com/codex/mcp)에서 지원하는 stdio 연결을 사용한다.

```sh
codex mcp add reviewops -- /opt/homebrew/bin/node \
  /Applications/ReviewOps.app/Contents/Resources/mcp/reviewops-mcp.cjs
```

직접 설정할 경우 Codex의 `config.toml`에 다음 항목을 추가한다.

```toml
[mcp_servers.reviewops]
command = "/opt/homebrew/bin/node"
args = ["/Applications/ReviewOps.app/Contents/Resources/mcp/reviewops-mcp.cjs"]
startup_timeout_sec = 20
tool_timeout_sec = 60
```

`codex mcp list`로 설정을 확인하고 새 Codex 대화에서 `reviewops_projects_list` 호출을 요청한다. 설정 목록에 표시되는 것과 앱 기능 호출이 성공하는 것은 별도로 검사한다.

### 자동 QA 실행에서 사용할 도구 지정

대화형 승인 입력이 없는 `codex exec`에서 화면 조작 도구의 승인이 필요하면 호출이 거절될 수 있다. 사용자가 요청한 자동 QA에는 해당 실행의 `-c` 인수로 필요한 도구만 지정한다. 예를 들어 클릭 도구의 허용 설정은 다음과 같다. 도구별 설정은 [Codex 설정 문서](https://learn.chatgpt.com/docs/config-file/config-reference)에 설명되어 있다.

```sh
-c 'mcp_servers.reviewops.tools.reviewops_qa_click.approval_mode="approve"'
```

입력·키·스크롤·창 연결·연결 해제에도 각각 `reviewops_qa_type`, `reviewops_qa_key`, `reviewops_qa_scroll`, `reviewops_qa_open`, `reviewops_qa_release`의 설정을 지정할 수 있다. `mcp_servers.reviewops.enabled_tools`에는 해당 검사에서 사용할 도구 이름만 나열한다. 리뷰 작성이나 에이전트 실행이 필요 없는 화면 검사에는 `reviewops_review_create`와 `reviewops_run_start`를 포함하지 않는다. 이 설정은 승인받은 QA 실행의 인수에 적용하며, 전체 도구의 승인 설정이나 시스템 접근 권한을 변경하지 않는다.

## Claude Code 연결

검사할 작업 폴더에서 [Claude Code MCP 연결 명령](https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server)을 실행한다.

```sh
claude mcp add --transport stdio --scope local reviewops -- /opt/homebrew/bin/node \
  /Applications/ReviewOps.app/Contents/Resources/mcp/reviewops-mcp.cjs
```

`claude mcp list` 또는 대화의 `/mcp`에서 연결을 확인한 후 `reviewops_projects_list` 호출을 요청한다. 한 실행에만 설정을 전달하려면 아래 JSON을 파일로 저장하고 `claude --mcp-config 파일경로`로 실행한다.

```json
{
  "mcpServers": {
    "reviewops": {
      "type": "stdio",
      "command": "/opt/homebrew/bin/node",
      "args": ["/Applications/ReviewOps.app/Contents/Resources/mcp/reviewops-mcp.cjs"]
    }
  }
}
```

## 프로젝트 지정

먼저 `reviewops_projects_list`의 `projectId`를 읽는다. 이후 각 요청에 대상 ID를 명시한다. 프로젝트 이름이나 활성 창으로 대상을 추측하지 않는다.

특정 에이전트가 한 프로젝트만 처리하도록 연결하려면 서버 실행 인수에 `--project-id PROJECT_ID`를 추가한다. 이 연결은 해당 프로젝트만 목록에 표시하고 다른 프로젝트 ID의 호출을 거절한다. 프로젝트 A와 B의 에이전트는 각자 다른 프로젝트 ID를 사용한다.

```toml
[mcp_servers.reviewops_a]
command = "/opt/homebrew/bin/node"
args = ["/Applications/ReviewOps.app/Contents/Resources/mcp/reviewops-mcp.cjs", "--project-id", "PROJECT_A_ID"]
```

이 설정은 작업 대상의 혼동을 막는 기능이다. 같은 사용자 계정의 프로그램 사이에 운영체제 접근 권한을 분리하지 않는다.

## 리뷰와 작업 실행

이 도구들은 창을 열거나 앞으로 가져오지 않는다.

| 도구 | 필수 입력 | 처리 결과 |
| --- | --- | --- |
| `reviewops_projects_list` | 없음 | 프로젝트와 연결 목록 |
| `reviewops_reviews_list` | `projectId` | 해당 프로젝트의 리뷰 목록 |
| `reviewops_review_get` | `projectId`, `reviewId` | 리뷰 내용과 작업 이력 |
| `reviewops_review_create` | `projectId`, `requestId`, `title` | 새 리뷰 ID와 저장 내용 |
| `reviewops_review_update` | `projectId`, `reviewId`, 수정할 항목 | 변경한 리뷰 |
| `reviewops_run_start` | `projectId`, `reviewId`, `requestId`, `prompt` | 실행 ID와 시작 상태 |
| `reviewops_run_list` | `projectId`, `reviewId` | 해당 리뷰의 실행 목록 |
| `reviewops_run_get` | `projectId`, `reviewId`, `runId` | 진행 상태·로그·응답·오류 |
| `reviewops_run_cancel` | `projectId`, `reviewId`, `runId` | 지정한 실행의 취소 요청 결과 |

리뷰 작성에는 `body`, `status`, `priority`, `category`, `targetPath`, `targetUrl`, `serviceId`를 추가할 수 있다. 프로젝트에 연결이 여러 개면 `serviceId`를 지정한다. 리뷰 수정은 전달한 항목만 변경하며 프로젝트와 연결은 옮기지 않는다. 실행 시작에는 `model`, `reasoningEffort`, `newConversation`을 추가할 수 있다.

`requestId`는 새 작업마다 다른 값으로 지정한다. 응답이 끊겨 같은 작업을 다시 요청할 때는 ID와 내용을 그대로 사용한다. 같은 ID로 내용을 바꾸면 오류를 반환한다. 리뷰 작성 결과에는 `projectId`·`reviewId`, 실행 결과에는 `runId`도 함께 들어 있다.

호출 예시:

```json
{
  "name": "reviewops_review_create",
  "arguments": {
    "projectId": "PROJECT_B_ID",
    "requestId": "qa-b-review-001",
    "title": "검색 결과 화면 검사",
    "body": "검색어 입력과 결과 목록을 검사한다."
  }
}
```

반환된 `reviewId`로 작업을 요청한다.

```json
{
  "name": "reviewops_run_start",
  "arguments": {
    "projectId": "PROJECT_B_ID",
    "reviewId": "CREATED_REVIEW_ID",
    "requestId": "qa-b-run-001",
    "prompt": "검색 기능을 검사하고 오류와 재현 순서를 정리하십시오.",
    "newConversation": true
  }
}
```

`run_start` 응답은 실행 완료를 뜻하지 않는다. 반환된 `runId`로 `run_get`을 호출하여 `run.status`, `run.progress`, `run.output`, `run.response`, `run.error`를 읽는다. 실행 환경의 작업 폴더 충돌 검사와 동일 프로젝트의 중복 실행 제한은 유지된다.

## 프로젝트 창에서 동시 QA

1. 각 에이전트가 `reviewops_qa_open`에 자신의 `projectId`와 고유한 `clientId`를 전달한다. 예: `codex-a`, `codex-b`, `claude-b`.
2. 반환된 `sessionId`·`projectId`·`windowId`를 이후 모든 화면 요청에 함께 전달한다.
3. `reviewops_qa_state`로 화면 내용과 요소 위치를 읽는다. 앱 안의 웹 검사 화면을 조작하려면 응답의 `browsers`에서 `browserId`를 읽어 다음 호출에 추가한다. 전체 창 사진에 웹 검사 화면이 보이더라도 그 화면의 입력에는 `browserId`가 필요하다.
4. 같은 화면의 요소 위치를 사용하여 클릭·입력·스크롤을 수행한다. 화면 전환 뒤에는 다시 `qa_state`를 호출한다.
5. `reviewops_qa_capture`로 해당 화면을 촬영한다. 응답에는 PNG 이미지, 프로젝트·창 ID, 이미지 크기, `viewport`, `imageToCss`가 포함된다.
6. 검사를 마치면 `reviewops_qa_release`로 연결을 해제한다. 창도 닫으려면 `reviewops_qa_close`를 사용한다.

| 화면 도구 | 추가 입력 | 동작 |
| --- | --- | --- |
| `reviewops_qa_open` | `projectId`, `clientId`, 선택적 `reviewId` | 프로젝트 창과 QA 연결 생성·재사용 |
| `reviewops_qa_state` | 없음 | 화면 글자·요소 위치·웹 검사 화면 목록 |
| `reviewops_qa_click` | `x`, `y`, 선택적 `button`, `clickCount` | 지정한 화면의 좌표 클릭 |
| `reviewops_qa_type` | `text` | 해당 화면에서 선택한 입력란에 문자열 입력 |
| `reviewops_qa_key` | `key`, 선택적 `modifiers` | 해당 화면에 키 입력 |
| `reviewops_qa_scroll` | `x`, `y`, `deltaY`, 선택적 `deltaX` | 지정한 위치에서 스크롤 |
| `reviewops_qa_capture` | 없음 | 지정한 화면의 PNG 이미지 |
| `reviewops_qa_navigate` | `browserId`, `url` | 웹 검사 화면에서 HTTP·HTTPS 주소 열기 |
| `reviewops_qa_reload` | 없음 | 지정한 화면 새로고침 |
| `reviewops_qa_close` | 없음 | 프로젝트 창 닫기 |
| `reviewops_qa_release` | 없음 | QA 연결 해제, 창 유지 |

`open`을 제외한 화면 도구에는 앞서 받은 `sessionId`·`projectId`·`windowId`가 필수다. `close`·`release`를 제외한 요청은 `browserId`를 추가하여 앱 안의 웹 검사 화면을 선택할 수 있다. 좌표는 선택한 화면의 왼쪽 위에서 시작하며 CSS 픽셀 단위다. `qa_state`의 요소 `rect`는 그대로 사용한다. 사진에서 읽은 좌표는 `x × imageToCss.scaleX`, `y × imageToCss.scaleY`로 변환한다. 예를 들어 이미지 좌표가 `(400, 200)`이고 두 배율이 `0.5`이면 클릭 좌표는 `(200, 100)`이다. `browsers`의 `bounds`·`clip`은 앱 화면 안의 위치를 나타내며 앱의 CSS 픽셀 단위다. 웹 검사 화면을 조작할 때는 해당 `browserId`로 상태나 사진을 다시 읽고 그 화면의 좌표를 사용한다.

`modifiers`에는 `Shift`, `Control`, `Alt`, `Meta`를 사용할 수 있다.

한 프로젝트 창은 한 QA 클라이언트가 사용한다. 다른 클라이언트가 사용 중이면 `PROJECT_BUSY`를 반환한다. 같은 클라이언트가 다른 리뷰로 연결하려면 먼저 `qa_release`를 호출한 후 새 `reviewId`로 연다. 30분 동안 요청이 없는 QA 연결은 만료된다.

개별 화면 요청이 20초 안에 끝나지 않으면 `QA_TIMEOUT`을 반환하고 해당 창의 추가 QA를 차단한다. 이때는 연결을 해제하는 것만으로 복구되지 않는다. 작성 중인 내용을 보존한 뒤 해당 창을 닫고 다시 열어야 한다. 다른 프로젝트 창은 계속 사용할 수 있다. 프로젝트 A와 B의 입력 요청은 각 창에서 처리되어 동시 진행이 가능하다. 이 도구는 ReviewOps 창과 앱 안의 웹 검사 화면을 조작한다. 운영체제 파일 선택 창이나 다른 프로그램의 화면은 조작 대상에 포함하지 않는다.

에이전트 요청 예시:

> ReviewOps의 PROJECT_A_ID 프로젝트에서 QA를 수행하십시오. clientId는 codex-a로 지정하십시오. qa_open의 sessionId와 windowId를 유지하고 qa_state, qa_click, qa_type, qa_scroll, qa_capture로 입력과 결과를 검사하십시오. 종료 시 qa_release를 호출하십시오.

다른 에이전트에는 `PROJECT_B_ID`와 `claude-b`를 지정한다. A의 화면 QA 중 B에서 리뷰 작성·작업 실행·결과 조회 도구를 사용할 수 있다.

## 연결 오류 처리

- `APP_UNAVAILABLE`: ReviewOps 앱 실행 여부와 데이터 폴더를 확인한다.
- `TARGET_MISMATCH`: 프로젝트·리뷰·실행·창 ID의 조합을 다시 조회한다. 다른 프로젝트로 자동 전환하지 않는다.
- `REQUEST_ID_CONFLICT`: 기존 요청을 조회한다. 다른 작업을 만들 때만 새 요청 ID를 사용한다.
- `PROJECT_BUSY`: 해당 프로젝트의 기존 QA를 종료하거나 기존 클라이언트에서 연결을 해제한다.
- `REVIEW_MISMATCH`: 기존 연결을 `qa_release`로 해제한 후 원하는 리뷰를 지정하여 다시 연다.
- `QA_TIMEOUT`·`QA_TARGET_UNAVAILABLE`: 요청이 멈춘 창을 닫고 다시 연다. 같은 창에 새 연결을 만들어 계속 입력하지 않는다.
- 닫힌 창 또는 만료된 연결: `qa_open`으로 새 연결을 얻는다. 이전 `sessionId`와 `windowId`를 재사용하지 않는다.

MCP 연결은 표준 입력·출력으로 통신한다. 앱과의 연결에는 사용자 전용 로컬 소켓 또는 Windows 파이프를 사용하며 TCP 포트를 열지 않는다. 앱을 다시 실행하면 연결 토큰이 바뀌므로 MCP 서버는 호출할 때마다 연결 파일을 다시 읽는다. 연결 파일의 토큰을 설정 파일·로그·이슈에 복사하지 않는다.

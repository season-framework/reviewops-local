---
name: reviewops
description: ReviewOps에 지정한 프로젝트의 리뷰를 등록하거나 기존 리뷰를 독립 작업 창으로 연다. 외부 도구에서 검토 요청을 전달하거나 요청 상태를 조회할 때 사용한다.
---

# ReviewOps 리뷰 요청

이 스킬의 `scripts/reviewops.mjs`는 Node.js의 표준 입력으로 JSON을 받아 실행 중인 ReviewOps 앱에 전달한다. Codex, Claude Code, Hermes 등에서 명령 실행이 가능한 환경이라면 같은 명령을 사용할 수 있다. 각 제품의 스킬 자동 설치나 전용 API 연동은 제공하지 않는다.

ReviewOps 앱을 먼저 실행한다. 이 명령은 리뷰를 저장하고 작업 창을 연다. Codex나 다른 에이전트 작업은 자동으로 시작하지 않는다.

- 사용자가 지정한 프로젝트 ID 또는 전체 작업 폴더 경로를 사용한다. 먼저 `list`로 프로젝트와 연결을 확인할 수 있다. 이름이 같거나 작업 폴더가 여러 프로젝트에 연결된 경우 임의로 선택하지 않는다.
- 프로젝트에 연결이 여러 개면 `serviceId`를 명시한다. 작업 폴더로 지정할 때는 로컬 프로젝트의 실제 경로와 일치하고 연결이 하나로 결정되어야 한다. SSH 작업 폴더는 `projectId`로 지정한다.
- 요청마다 새로운 `requestId`를 만들고 응답을 받을 때까지 보관한다. 같은 요청을 재시도할 때는 ID와 JSON 내용을 그대로 사용한다. 이미 사용한 ID의 내용이나 대상을 바꾸지 않는다.
- `needs_project`는 대상을 지정하거나 다시 확인해야 하는 상태다. `message`와 `reviewId`를 읽고 이미 등록된 리뷰를 새로 만들지 않는다. 대상을 바꾸려면 새 ID를 사용한다. `display_failed`는 리뷰 ID가 이미 있을 수 있으므로 원래 ID와 내용으로 다시 시도한다.
- 연결이 끊기거나 시간이 초과되면 먼저 `status`를 조회한다. 오류를 성공으로 보고하거나 새 ID로 같은 리뷰를 중복 등록하지 않는다.
- 앱 연결 파일의 토큰을 읽어 출력하거나 복사하지 않는다. 스크립트가 토큰을 내부에서 처리한다.

`SKILL_DIR`는 이 파일이 있는 실제 폴더로 바꾸어 사용한다. `.app` 경로는 데이터 폴더가 아니다. 데이터 폴더가 기본 위치와 다르면 `--data-dir` 또는 `REVIEWOPS_DATA_DIR`를 지정한다.

```sh
node "$SKILL_DIR/scripts/reviewops.mjs" list
```

새 리뷰 요청:

```sh
node "$SKILL_DIR/scripts/reviewops.mjs" open <<'JSON'
{"requestId":"review-2026-001","projectId":"PROJECT_ID","serviceId":"SERVICE_ID","title":"결제 화면 확인","body":"모바일 화면에서 결제 버튼이 가려지는지 확인하십시오.","tool":"codex"}
JSON
```

`projectId` 대신 `workspacePath`를 지정할 수 있다. `serviceId`는 연결이 하나면 생략한다. 기존 리뷰를 열 때는 `title`과 `body` 대신 `reviewId`를 사용하며 프로젝트 또는 작업 폴더도 함께 명시한다.

```sh
node "$SKILL_DIR/scripts/reviewops.mjs" status <<'JSON'
{"requestId":"review-2026-001"}
JSON
```

응답의 `ok`와 `data.status`, `data.reviewId`, `data.windowId`를 읽어 결과를 전달한다. `shown`은 요청한 리뷰의 창을 표시했다는 뜻이며 리뷰 작업이 완료되었다는 뜻은 아니다.

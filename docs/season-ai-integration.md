# Season AI 연결

Season AI는 이 Mac에 설치된 ReviewOps 앱으로 제작 작업을 전달한다. 별도 웹 서버, 로그인 계정, Docker를 요구하지 않는다. 웹 서비스, 웹 게임, HTML 발표자료는 Season AI의 전용 작업 폴더에 저장하며 ReviewOps의 프로젝트의 로컬 폴더로 연결한다.

## 사용 흐름

1. Season AI에서 만들 종류와 내용을 정하고 제작을 선택한다.
2. ReviewOps에 그룹과 로컬 폴더에 연결된 프로젝트를 등록한다. 같은 대화의 수정 요청은 기존 작업 공간을 사용한다.
3. 요청을 리뷰로 저장하고 ReviewOps 앱에서 해당 리뷰를 전체 화면으로 연다. Season AI가 다른 모니터를 지정하면 그 모니터를 사용한다.
4. ReviewOps의 기존 Codex 실행 기능으로 제작한다. 파일 변경, 명령 실행, 진행 상태, 최종 응답은 기존 작업 기록에 저장한다.
5. Season AI는 파일 변경과 결과물 응답을 검사한 뒤 결과물 버튼을 제공한다. 실패한 작업도 리뷰에 남으며 성공으로 표시하지 않는다.

ReviewOps의 기존 탭과 입력 내용은 유지한다. 작업 중지 시 실제 프로세스 종료를 기다린다. 앱 연결이 끊겨 실행 접수 여부를 알 수 없는 경우에는 같은 작업을 다시 실행하지 않고 해당 리뷰의 상태를 확인한다.

## 앱 사이 연결

`electron/season-integration.cjs`는 사용자 데이터 폴더의 `integrations/season-ai.sock` Unix 소켓을 연다. TCP 포트를 열지 않는다. `integrations/season-ai.json`에는 소켓 경로와 실행 시마다 새로 만드는 연결 토큰을 저장한다. 폴더 권한은 `0700`, 파일과 소켓 권한은 `0600`이다. 이 파일을 Git이나 공유 폴더에 복사하지 않는다.

지원 요청은 `capabilities`, `prepare`, `review.create`, `review.show`, `task.start`, `task.status`, `task.cancel`이다. 모든 데이터 변경은 ReviewOps 앱의 기존 작업 처리 함수를 사용한다. 외부 프로세스가 SQLite 파일을 직접 수정하지 않는다.

작업 폴더는 `~/Library/Application Support/Season AI/reviewops-workspace/` 아래로 제한한다. 저장된 리뷰와 작업 폴더의 연결은 실행 직전에 다시 검사한다. 다른 리뷰나 다른 작업의 실행을 조회하거나 중지할 수 없다. 요청 ID는 중복 리뷰와 중복 실행을 방지하는 데 사용한다.

새 프로젝트 연결의 Codex 실행 파일은 실행 가능한 `SEASON_CODEX_PATH`, ChatGPT 앱의 번들 Codex, Codex 앱의 번들 Codex 순으로 선택하며 모두 없으면 `PATH`의 `codex`를 사용한다. 기존 자동 생성 연결의 값이 기본값 `codex`이면 실행 전에 같은 순서로 갱신한다. 사용자가 지정한 실행 파일 경로와 모델 설정은 유지한다. 그룹 이름의 날짜와 시각은 Mac의 현지 시간으로 표시한다.

자동 검사에서는 `SEASON_CODEX_PATH`에 합성 실행 파일의 전체 경로를 지정한다. 이 환경변수로 검사 실행이 실제 모델을 호출하지 않도록 한다.

`reviewops-local://review/<id>`는 Season AI의 작업 이력 버튼에 저장하는 주소다. 운영체제 URL 처리기에 등록하지 않으며 Season AI가 저장한 리뷰를 ReviewOps 연결을 통해 연다.

## 검증

`node --test tests/season-integration.test.cjs`로 소켓 권한, 연결 토큰, 한국어·일본어 전송, 중복 등록 방지, 작업 폴더 변경 차단, 삭제된 리뷰 처리, 작업 중지를 검사한다. 실제 모델 실행과 화면 표시는 설치한 두 앱에서 별도로 검사한다.

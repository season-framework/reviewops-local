# 개발 서비스 관찰과 관리형 로컬 Node 서비스

이 변경은 이슈 #15의 로컬 실행 경로 한 가지를 구현한다. 과거 연결 실패의 원인은 당시 로그가 없어 미확인이다. SSH 서비스, 일반 셸 명령, 프로세스 트리 관리, 호스트 재부팅 후 유지, 기존 프로세스 채택은 제공하지 않는다. 이 범위를 전체 이슈 완료로 표시하지 않는다.

## 사용 경로

설치 묶음은 ASAR 안의 원본 bootstrap을 패키징 후 `resources/owned-services/owned-node-bootstrap.cjs`로 복사한다. 독립 Node에는 이 실제 파일 경로를 전달하고 시작 응답의 명령도 같은 경로와 대조한다. 소스 실행은 저장소의 bootstrap을 사용한다. 이 경로는 main 내부에서 선택하며 사용자 실행 설정이나 외부 도구 요청으로 변경하지 않는다. 이 패키징 검사를 실제 설치 앱 UI 검사로 대체하지 않는다.

프로젝트의 검토 대상 화면에서 **서비스 준비 상태**를 펼친다. 관찰 검사는 ReviewOps 컴퓨터에서 인증 정보 없이 GET한다. 2xx 헤더는 실제 저장·사용 흐름의 성공이나 SSH 호스트 내부 상태를 증명하지 않는다. 리디렉션은 따라가지 않고 응답 본문은 저장하지 않는다. 선택한 비교 파일 해시는 실제 실행 파일의 증거가 아니다. 관찰 결과는 화면의 임시 상태다.

로컬 연결에는 **관리형 로컬 Node 서비스**가 표시된다. 기본 프로젝트 화면에서 독립 설치된 Node 실행 파일의 절대 경로, 작업 폴더 안의 상대 `.cjs` 진입 파일, JSON 문자열 배열 인수, loopback HTTP 준비 URL을 저장한다. **저장한 서비스 시작**이 main 소유 자식 프로세스를 만든다. 저장 자체나 앱 재실행은 서비스를 자동 시작하지 않는다. Electron 실행 파일, npm/셸 래퍼, ESM 진입 파일은 첫 지원 범위에 없다. 인수에 비밀 값을 넣지 않는다. 설정과 인수는 사용자 데이터 폴더의 `owned-node-services.json`에 0600 권한으로 보존하고 백업 복원 시 폐기한다. 전체 직렬화 설정은 1 MiB로 제한한다. 추가 저장이 예산을 넘으면 파일 쓰기와 현재 설정 교체 전에 거절하므로 기존 설정으로 다음 앱을 시작할 수 있다. 백업 내보내기에 포함하지 않는다.

**저장한 준비 URL 검사**는 별도 HTTP 관찰이다. `running`은 소유 Node 프로세스의 IPC 시작 응답이며 준비 완료를 뜻하지 않는다. UI는 URL의 소유권을 확인하지 않았다고 표시한다. 외부 서버가 해당 URL에 200을 반환하거나 Node 서비스가 EADDRINUSE를 무시해도 그 외부 응답을 소유 서비스에 연결하지 않는다. 자식이 보고한 실제 `net.Server` listen 주소는 별도의 출처로 표시하며 HTTP 응답의 소유 증명으로 승격하지 않는다. 실제 핵심 버튼·POST·저장값의 검사는 따로 필요하다.

설정 초안은 프로젝트의 저장하지 않은 내용으로 등록한다. 연결이나 작업 폴더가 바뀌면 실행 상태와 관찰값은 새 연결로 전환하지만, 편집 중인 초안과 원래 프로젝트·연결 정보는 남긴다. SSH나 연결 없음에서도 초안을 숨기지 않는다. 원래 연결로 돌아가 이어서 쓰거나 명시적으로 버릴 수 있다. 같은 프로젝트의 새 로컬 연결에서는 **이 연결에서 검토**를 누른 뒤 현재 작업 폴더의 파일 검사를 통과해 저장해야 시작할 수 있다. 다른 프로젝트에 저장하거나 자동으로 실행하지 않는다. 저장을 기다리는 동안 연결이 바뀌어도 이전 저장 응답으로 새 초안을 저장 완료 처리하지 않는다.

## 실행 정보와 수명

- main은 `projectId + connectionId + instanceId`와 정확한 ChildProcess/IPC 채널을 보유한다. 실제 Node의 executable, startup argv, 애플리케이션 argv, cwd, PID, Node 버전과 보고 시각은 그 자식 채널에서 수집한다. 시작 시각과 임의 instance ID는 main의 실행 기록이다. 이 ID는 HTTP nonce나 독립 OS attestation이 아니다.
- executable과 entry의 SHA-256은 **시작 전 파일 스냅샷**이다. 열린 FD의 파일 종류·정체성과 경로, 크기·변경 시각을 검사하고 제한된 블록으로 읽는다. 파일이 로드되기 전 바뀔 수 있으므로 `loadedBytesVerified:false`이며 `attested-loaded`라고 부르지 않는다. 실행 프로세스의 `process.execPath`를 실제 spawn 대상과 대조해도 로드된 모든 코드 바이트를 증명하지 않는다.
- 서비스는 에이전트 job/프로세스 그룹이나 renderer에 속하지 않는다. 프로젝트 화면을 닫거나 에이전트를 완료·취소해도 서비스에 중지 명령을 보내지 않는다. 화면을 다시 열면 main 상태를 조회한다. 이 단계의 start/stop은 신뢰 앱 renderer에서만 제공하며 외부 MCP/API·내장 웹페이지에는 실행·제어 권한을 노출하지 않는다.
- **이 인스턴스 중지/복구**는 보유한 자식 IPC 채널로 협조 종료를 요청한다. bootstrap은 추적한 실제 server의 close 메서드로 새 연결 수락을 닫고, 이미 수락한 요청을 기다린다. HTTP의 진행 요청은 자르지 않으며 이후 같은 연결의 새 HTTP 요청은 503/Connection: close로 거절한다. 요청 완료 뒤 idle keep-alive만 닫고 `closeAllConnections`나 socket destroy를 사용하지 않는다.
- entry는 선택적으로 `exports.reviewopsShutdown = async ({reason}) => { ... }`를 초기 로드 중 내보낼 수 있다. `reason`은 `stop` 또는 `parent-disconnect`다. hook은 인스턴스당 한 번만 호출하며, 서버 close와 병렬로 기다린다. 자기 interval 정리와 별도 작업·쓰기의 완료 대기를 이 hook에서 수행한다. 미해결 Promise만 있어도 bootstrap의 참조 핸들로 프로세스를 보존한다. hook 거절·미완료는 완료로 처리하지 않는다.
- 모든 listener close와 hook이 끝나면 private 완료 marker를 parent에 보내고 같은 인스턴스의 ack를 받은 뒤 bootstrap IPC와 자체 keepalive만 해제한다. 성공 경로에서 `process.exit`를 호출하지 않는다. 참조가 남은 요청·타이머·파일 I/O가 자연스럽게 끝나야 자식이 종료된다. parent는 marker와 정확한 자식의 실제 exit code0/signal없음을 모두 관찰한 뒤에만 완료/새 인스턴스 시작을 허용한다. marker 없이 exit0한 경우도 요청한 종료의 완료로 인정하지 않는다. 고의 entry `process.exit`, unref된 작업이나 임의 자손 프로세스의 완료는 이 계약이 보장하지 않는다.
- PID 입력·재사용된 PID 신호·포트 주인 추정·프로세스명 검색·killall·강제 종료 fallback은 없다. 정리나 자연 종료를 기한 안에 확인하지 못하면 `stop-unconfirmed`를 유지하고 새 시작·복구·앱 종료 성공을 거절한다. 살아 있는 자식의 정리는 계속 진행하며 나중에 marker와 실제 exit가 확인되면 상태를 갱신한다.
- 정상 앱 종료는 소유 서비스의 정리 marker와 exit를 먼저 확인한 뒤 각 창을 닫는다. 저장하지 않은 내용의 버리기 질문은 그 창의 실제 renderer unload 거부에서 한 번만 표시한다. 미리 검사한 dirty 값이나 다른 창의 동의로 자동 허용하지 않는다. 정리 대기 중 입력과 이전 동의 뒤의 새 입력도 그 창의 최종 닫기에서 다시 다룬다. Electron의 close() 반환은 완료로 간주하지 않고 같은 창의 실제 closed를 기다린다. 사용자가 버리기 질문에 응답하는 시간은 창 닫힘 제한에서 제외하며, 응답 뒤 같은 종료 시도의 남은 닫힘 시간을 기다린다. 명시적 닫기 거부·새 창·10초 미완료는 해당 종료 시도만 취소한다. 계속 작성으로 취소해도 서비스는 이미 중지됐을 수 있다. 중지된 서비스는 자동으로 다시 시작하지 않는다. 남은 창과 초안은 유지하지만 앞에서 버리기에 동의하여 닫힌 창은 복원하지 않는다. 이전의 모든 창 사전 확인 방식과 이 점이 다르다.
- 부모 IPC 단절 시에도 같은 listener/hook 정리와 자연 종료를 시도하지만, 이벤트 루프 정지·프로세스 강제 종료·앱 크래시에서 이 처리가 반드시 실행된다고 보장하지 않는다. 새 앱은 과거 PID를 채택하거나 정리하지 않는다. 임의 자손 프로세스를 생성하는 entry는 지원하지 않으며, 그 자손의 종료를 보장하지 않는다. OS 전역 자동 시작은 설치하지 않는다.
- 실행 중인 소유 서비스가 있으면 관련 프로젝트 연결 변경·연결 삭제·프로젝트 삭제·그룹 삭제·백업 복원을 거절한다. 다른 프로젝트 작업은 계속 가능하다. 각 비동기 작업의 연결 generation과 앱 종료 lifecycle을 검사해 A→B→A 또는 종료 뒤 늦은 시작이 새 상태를 덮지 못하게 한다.

## 검증 범위

단위 검사와 private temp/loopback의 실제 Node 자식 fixture는 HTTP POST 저장, 실제 자식 정보·listen 관찰, 선택 종료/새 identity 복구, 외부 포트 보존, EADDRINUSE+외부 HTTP200, 미확인 종료, 경합과 파일 교체 경계를 검사한다. main 단위 harness는 실제 저장소/권한 경계를 검사하지만 Electron 창은 mock이다. 제품 UI, 실제 에이전트 CLI 수명, 설치 앱, Windows/ARM native, SSH, 앱/호스트 재시작은 별도 실제 실증 전까지 미검사다. 기존 PR39의 Mac 합성 조사 4조건×4시점은 별도 역사적 증거이며 새 제품 QA로 합산하지 않는다.

Node API 근거: [ChildProcess IPC·exit](https://nodejs.org/docs/latest-v24.x/api/child_process.html#event-exit), [process.disconnect](https://nodejs.org/docs/latest-v24.x/api/process.html#event-disconnect), [process.exit](https://nodejs.org/docs/latest-v24.x/api/process.html#processexitcode). IPC 전송 성공과 실제 프로세스 종료는 구분한다.

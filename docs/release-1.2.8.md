# ReviewOps 1.2.8

작업을 시작하기 전에 실행 환경을 검사하고, 후속 요청과 리뷰 자료를 관리하는 기능을 추가했습니다. 리뷰 작성 중 입력을 보존하고 첨부 파일을 닫은 뒤 웹사이트 탐색을 이어 갈 수 있도록 개선했습니다.

## 변경 사항

- [#12](https://github.com/season-framework/reviewops-local/issues/12): 실행 전에 작업 폴더가 있는지와 접근할 수 있는지 검사합니다. 폴더가 없으면 폴더 선택 또는 생성을 안내합니다.
- [#13](https://github.com/season-framework/reviewops-local/issues/13): 실행 전에 Codex 실행 파일과 로그인 상태를 검사합니다. 실행을 시작하지 못한 경우 작성한 요청과 선택한 자료를 유지합니다.
- [#14](https://github.com/season-framework/reviewops-local/issues/14): 이전 요청을 새 초안으로 가져오고 이전 설정과 새 실행 설정을 비교할 수 있습니다. 누락되거나 손상된 첨부 파일은 제외하고 다시 선택하도록 안내합니다. 초안을 가져온 뒤 직접 실행해야 작업이 시작됩니다.
- [#16](https://github.com/season-framework/reviewops-local/issues/16): 후속 요청에 먼저 끝나야 하는 작업과 필요한 결과를 지정할 수 있습니다. 대기 이유와 등록 순서를 표시하고 같은 작업 폴더에서 겹치는 실행을 막습니다. 대기 요청은 사용자가 실행합니다. 스크린샷·첨부 선택 화면이 후속 요청 영역에 가려지는 문제도 수정했습니다.
- [#17](https://github.com/season-framework/reviewops-local/issues/17): 리뷰 작성 시 화면 캡처 여부를 선택할 수 있습니다. 캡처에 실패하면 작성한 내용과 첨부 선택을 유지하여 다시 시도하거나 캡처 없이 저장할 수 있습니다.
- [#18](https://github.com/season-framework/reviewops-local/issues/18): 리뷰 첨부 파일을 닫거나 이전 웹사이트로 돌아가기를 선택하면 기존 웹사이트의 주소와 탐색 기록을 유지합니다.
- [#19](https://github.com/season-framework/reviewops-local/issues/19): Markdown 문서의 표를 표 형태로 표시합니다. 문서 미리보기에서 서식을 적용한 화면과 원문을 전환할 수 있습니다.
- [#20](https://github.com/season-framework/reviewops-local/issues/20): 실행 중 추가한 내용을 후속 요청으로 보관하고 제출 상태를 표시합니다. 후속 실행이 끝나면 사용자가 반영 여부와 결과 버전, 처리 내용을 기록할 수 있습니다. 제출만으로 요청을 읽었거나 반영했다고 표시하지 않습니다.
- [#21](https://github.com/season-framework/reviewops-local/issues/21): 실행 결과와 리뷰 상태를 함께 표시합니다. 실행이 끝난 뒤 결과 확인, 재요청 등 다음 작업을 안내하며 리뷰 완료 여부는 사용자가 결정합니다.
- [#22](https://github.com/season-framework/reviewops-local/issues/22): 코드·산출물·데이터베이스의 버전 이름을 직접 입력하고 첨부 사본을 연결해 보관할 수 있습니다. 대상 버전을 바꾸면 이전 자료에 재검토 필요를 표시하고, 누락되거나 손상된 사본을 안내합니다. 버전 이름과 출처는 기기에 저장하며 에이전트에 자동 전달하지 않습니다.
- [#23](https://github.com/season-framework/reviewops-local/issues/23): 리뷰 등록 전에 프로젝트, 실행 대상, 작업 폴더와 첨부 출처를 표시합니다. 실행하지 않은 리뷰를 다른 프로젝트로 복사할 때 선택한 첨부 사본을 함께 저장하며 원본 리뷰와 이력을 유지합니다.

## 설치와 업데이트

- macOS 13 이상에서 Apple Silicon용 `arm64` 또는 Intel용 `x64` DMG를 선택하십시오. macOS 앱의 업데이트 알림을 통해 새 버전을 설치할 수도 있습니다.
- macOS 앱은 ad-hoc 서명을 사용하며 Apple 공증을 받지 않았습니다. 처음 실행할 때 운영체제에서 추가 확인을 요구할 수 있습니다.
- Windows 10·11 x64에서는 `ReviewOps-1.2.8-windows-x64.exe`를 사용하십시오. 설치 파일은 서명되지 않았습니다.
- Windows에서는 앱을 종료하고 새 설치 파일을 실행하여 업데이트하십시오. Windows 앱 내 자동 설치는 지원하지 않습니다.
- 프로젝트와 리뷰 데이터는 앱 설치 폴더와 별도로 보관하며 업데이트할 때 유지됩니다.

## 이번 버전에 포함되지 않은 기능

- [#15](https://github.com/season-framework/reviewops-local/issues/15)의 개발 서비스 시작·중지와 준비 상태 관리 기능은 포함되지 않았습니다. 이번 변경에서는 에이전트 완료·중지 이후 서비스 실행 상태를 구분하는 테스트를 추가했습니다.
- [#24](https://github.com/season-framework/reviewops-local/issues/24)의 다른 프로젝트 요청을 전용 ReviewOps 창으로 분리하는 기능은 포함되지 않았습니다.
- [#8](https://github.com/season-framework/reviewops-local/issues/8)·[#9](https://github.com/season-framework/reviewops-local/issues/9)의 가상 모니터와 [#10](https://github.com/season-framework/reviewops-local/issues/10)·[#11](https://github.com/season-framework/reviewops-local/issues/11)의 PC 간 연결·원격 조작 기능은 포함되지 않았습니다.

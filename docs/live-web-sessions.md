# 프로젝트 웹 화면의 공유 캡처 세션

홈 리뷰의 스크린샷 캡처는 프로젝트에서 이미 열어 둔 `WebContents`를 명시적으로 선택한다. 같은 URL을 새로 열지 않으므로 저장하지 않은 폼·페이지 이동·클릭 상태를 유지한다. 홈은 PNG 미리보기와 캡처만 제공하며 입력과 이동은 원래 프로젝트 창에서 수행한다.

## 연결과 신뢰 경계

- `OriginalViewer`와 `NativeBrowser`가 프로젝트 ID와 연결 서비스 ID를 함께 전달한다. main은 실제 저장소의 `connection`/`serviceIds` 소속과 요청 창의 프로젝트를 검증한다. 서비스 ID에서 첫 프로젝트를 추정하지 않으므로 공유 연결과 보조 연결도 구분한다.
- `electron/viewer-sessions.cjs`의 메모리 레지스트리가 실제 source WebContents, 소유 창, 프로젝트·서비스, 임시 session ID와 epoch를 연결한다. source를 다른 프로젝트에 재결합한 WebContents는 공유 대상으로 재사용하지 않는다.
- `viewerSession.list/context/begin/preview/capture/end/closeContext`는 기존 trusted main-frame IPC만 사용한다. 목록은 요청한 프로젝트의 현재 연결 서비스에 속한 화면만 반환한다. 외부 웹페이지에는 이 API가 없다.
- 캡처 intent는 consumer 창, 작성 context UUID와 generation, project/review, 용도와 해당 activity ID, session/epoch에 고정한다. 새 리뷰, 리뷰 수정, 새 작업이력과 기존 작업이력 수정, 에이전트 요청 초안·대기 요청 수정은 작성 context를 분리한다. 에이전트 수정은 정확한 대기 요청 ID까지 확인한다.
- 탐색·대상 교체·원본 종료·작성 내용 변경·취소 후 도착한 결과는 사용자 수락과 임시첨부 staging 시점까지 거절한다. 다른 화면을 자동으로 선택하거나 URL을 다시 열지 않는다. 소속 연결을 제거한 화면도 새 캡처에 사용할 수 없다.

## 수락한 사진과 저장

사용자가 `사용하기`를 누르면 main이 보관한 원본 PNG에서 선택 영역을 잘라 임시첨부를 만든다. renderer가 반환한 편집 이미지로 원본을 교체하지 않는다. 선택 좌표는 원본 PNG의 픽셀 단위이며, CSS 뷰포트 해상도·화면 배율과 구분한다.

임시첨부가 만들어진 뒤에는 원래 뷰어가 이동하거나 종료돼도 사진을 저장할 수 있다. 이때 main은 고정된 사진의 바이트·SHA-256, consumer·작성 context·project/review·용도/activity 연결과 기존 staging 소유권을 확인한다. 수락한 사진을 다른 리뷰·다른 초안·다른 작업이력에 재사용할 수 없다. 정상적인 본문 편집은 사진을 무효화하지 않는다.

원본 session/epoch, project/service, 캡처 시각, 원본 픽셀 크기·SHA-256, crop과 저장 PNG의 SHA-256은 기존 review/activity evidence에 보존한다. 작업이력 수정은 이전 `log_captures`와 새 자료를 병합한다. 기존 JSON 크기 제한과 백업 형식은 유지하며, 백업의 과거 session ID는 실행 가능한 세션으로 복원되지 않는다. live registry는 메모리에만 존재한다.

기존 파일 미리보기·일반 파일 첨부·직접 뷰어 toolbar의 저장 동작은 기존 경로를 사용한다. 이 증분의 intent/frozen 검증은 프로젝트·홈 리뷰 작성기의 세션 캡처와 기존 작업이력 편집·에이전트 앨범의 새 캡처 경로에 적용한다. 에이전트 초안은 같은 consumer와 저장된 초안 ID에 수락한 사진을 유지하며, 패널을 벗어나면 수락 전 요청만 중단하고 명시적 초안 삭제·수정 취소 때 작성 context를 폐기한다.

## 제공 범위와 검사

실제로 연결된 provider는 웹 화면이며, 공유 미리보기의 input과 virtual-display capability는 `false`, OS 캡처 권한은 `notRequired`이다. OS 가상 모니터 생성, native 앱 캡처·입력, 드라이버, OS 권한·설정 변경과 외부 네트워크 공개 기능은 구현하지 않았다. #8·#9의 가상 모니터 완료를 뜻하지 않는다.

관련 검사:

```sh
node --test tests/viewer-sessions.test.cjs tests/browser-manager.test.cjs tests/review-capture.test.cjs tests/store.test.cjs
npm run build
node scripts/e2e-live-web-sessions.mjs
node scripts/e2e-screenshots.mjs
node scripts/e2e-viewer-toolbar.mjs
node scripts/e2e-browser-ui.mjs
```

새 E2E는 격리된 HOME·앱 자료와 loopback 합성 HTTP 폼을 사용하며 실제 AI·계정 로그인·운영 SSH를 사용하지 않는다. source Electron 검사와 배포·설치 앱 검사는 별도다. 실제 원본 전체 창 사진과 조작 결과는 ignored `test-results/live-web-sessions`에 기록한다.

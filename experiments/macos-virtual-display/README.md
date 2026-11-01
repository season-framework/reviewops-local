# macOS 가상 디스플레이 수명 실험 (#8)

이 코드는 제품 provider가 아닌 별도 실험이다. Apple의 비공개 `CGVirtualDisplay` ABI를 시험하며, Apple이 지원하는 공개 API·배포 가능성·macOS 13 이상 호환성을 입증하지 않는다. #8·#9 전체 구현은 미완료다. Electron의 기존 웹 캡처나 NSView 렌더를 OS 화면 캡처로 계산하지 않는다.

## 실행 범위

이 브랜치는 main `3fd011a3a5d2adeaaaa1cdfaa46efd5aab35172d`를 기반으로 한다. 제품 UI, Electron provider, 설치파일, 릴리즈 workflow에는 연결하지 않는다.

로컬에서는 **컴파일만** 수행한다. 이 명령은 helper를 실행하지 않으며, 로컬 빌드의 디스플레이 실행 gate도 컴파일 시 닫혀 있다.

```sh
node --test tests/macos-virtual-display-probe.test.cjs
node experiments/macos-virtual-display/run-probe.mjs --compile-only
```

실제 생성은 `.github/workflows/macos-virtual-display-prototype.yml`의 정확한 `codex/macos-virtual-display-prototype` push에서만 예정된다. `macos-15` arm64와 `macos-15-intel` x64의 GitHub 호스팅 runner가 대상이다. 작업 권한은 `contents: read`, checkout credential 저장은 끄며 외부 secret·서비스·설정 변경을 사용하지 않는다. 새 workflow 등록을 위해 dispatch-only 방식으로 구성하지 않았다. **최초 push·CI 실행·PR은 root 검토 후 별도 수행한다.**

Node launcher와 native helper는 모두 repository, branch, push event, GitHub Actions·CI·github-hosted·macOS 환경을 확인한다. launcher는 clean checkout SHA 및 실제 Node architecture를 검사하며 helper의 native architecture도 대조한다. 이 gate는 실수 방지용이며 환경 변수를 위조하는 행위에 대한 보안 경계라는 뜻은 아니다. 사용자 Mac에서 CI 변수를 흉내 내거나 CI 전용 빌드를 실행하지 않는다.

## 실험이 검증하는 것

1. public Quartz 조회로 기존 online 디스플레이 ID·bounds·mode·pixel size·online/active·vendor/serial을 기록한다. physical과 virtual을 이름으로 추측하지 않고 **모든 기존 online 디스플레이**를 보존 대상으로 삼는다.
2. 필요한 private class·선택자·호출 ABI를 조회한다. 부재 또는 형식 불일치는 `unsupported/PRIVATE_API_OR_ABI_UNAVAILABLE`이다. 이 상태는 native 통과가 아니며 CI도 성공 처리하지 않는다.
3. 고유 serial을 갖는 소유 객체 **하나**를 생성한다. 객체가 반환한 실제 `CGDirectDisplayID`가 0이나 기존 ID가 아님을 확인한다. 해당 객체에만 1920×1080·60 Hz·HiDPI off 설정을 적용한다.
4. public Quartz 목록에 그 ID가 online/active로 나타나고, 실제 논리 mode·pixel size·bounds가 1920×1080인지 검사한다. vendor/serial도 요청 값과 대조한다. 생성 중에도 기존 ID·bounds·mode를 포함한 기록이 그대로여야 한다. refresh rate는 실제 관측값을 남기며 보장되지 않는 값을 채우지 않는다.
5. 그 ID의 NSScreen 안에 이 프로세스의 새 borderless NSWindow만 배치하고 실제 screen ID·frame 포함·visible 상태·window number를 기록한 뒤 닫는다. 다른 앱·창을 이동하지 않는다. **OS frame 수집·NSView 이미지·입력 전달은 수행하지 않는다.**
6. `@finally`에서 소유 객체의 마지막 strong 참조만 해제한다. 기존 디스플레이를 재설정·복구하거나 이름으로 찾아 제거하는 호출은 없다. 기존 inventory가 정확히 복원되고 새 ID가 사라졌는지 15초 안에 조회하여 확인한다. 두 번째 디스플레이를 만드는 workaround는 사용하지 않는다.
7. child가 종료된 후 별도 public 조회 프로세스가 inventory를 한 번 더 대조한다. timeout·signal·output 초과는 통과가 될 수 없다. 늦은 제거, 생성 거절, headless runner 한계는 결과에 그대로 남긴다.

## 경계와 결과 판독

`test-results/virtual-display-probe/result.json`은 tested source SHA·dirty 상태·architecture와 native 결과를 묶는다. `native.json`에는 `before/during/after` 원본 inventory와 phase가, `post-process.json`에는 child 종료 뒤 조회가 남는다. 결과 구분은 다음과 같다.

| outcome | 의미 |
| --- | --- |
| `compile-only` | 로컬 컴파일만 성공. 실제 디스플레이 검사는 0회. |
| `unsupported` | private class·selector·ABI 부재/불일치. native 통과 아님. |
| `failed` | 생성·mode/identity·창 배치·기존 display 보존·cleanup·시간 제한 중 실패. code와 마지막 phase를 확인한다. |
| `passed` | 실제 소유 display 1개 생성·관측·자체 창 배치·해제, 기존 모든 online display 불변 및 종료 후 재조회가 통과. |

helper 단계 대기는 최대 38초, launcher의 child watchdog은 70초 후 SIGTERM·5초 뒤 SIGKILL이다. 생성 native 호출 자체가 멈추면 watchdog이 종료하고 정리 확인 실패를 남긴다. 소유 객체의 프로세스가 비정상 종료된 경우 디스플레이가 제거된다고 추정하여 성공 처리하지 않는다. 종료 후 inventory가 남아 있으면 수동 복구나 다른 ID 제거를 자동 수행하지 않는다. runner는 일회용이며 전체 job은 8분 제한이다.

출력은 JSON 파일당 최대 128 KiB, 각 프로세스 stdout/stderr 합계 최대 128 KiB이다. artifact는 JSON·로그만 포함하고 helper 실행파일은 제외한다. 이름은 `reviewops-virtual-display-probe-darwin-{arm64,x64}`, 보존 7일이다. test-release 정리 대상인 `reviewops-test-build-*` 이름을 사용하지 않는다.

통과해도 해당 GitHub runner OS·CPU에서 관측한 실험 결과일 뿐이다. 정식 provider·서명/공증·재배포·앱 패키지·권한 거부/철회·화면 기록·앱 입력·Retina/4K·잠자기/잠금·프로그램 crash 후 복구·macOS 전체 지원은 입증하지 않는다. native 결과가 나오기 전에는 클래스 존재나 로컬 컴파일로 생성 성공을 주장하지 않는다. Windows에는 이 실험을 적용하지 않는다.

## 출처와 라이선스

- [Chromium 고정 소스](https://chromium.googlesource.com/chromium/src/+/1b72286560637710932b4ef43908d0d6a121a432/ui/display/mac/test/virtual_display_util_mac.mm): binary-generated private 인터페이스, macOS 14의 nonzero vendor/고유 serial 조건, 객체 수명에 따른 제거의 참고 자료다. 최소 ABI 선언은 이를 참고해 별도 protocol로 줄였다. Chromium의 first-removal workaround·headless 제약을 임의로 지원 완료로 바꾸지 않는다. 파생 인터페이스의 저작권 표시와 [원본 BSD license](CHROMIUM-LICENSE)를 보존했다.
- [Apple Quartz Display Services](https://developer.apple.com/documentation/coregraphics/quartz-display-services), [CGGetOnlineDisplayList](https://developer.apple.com/documentation/coregraphics/cggetonlinedisplaylist(_:_:_:)), [CGDisplayBounds](https://developer.apple.com/documentation/coregraphics/cgdisplaybounds(_:)): 기존 online display inventory와 bounds 조회의 공개 API다. `CGVirtualDisplay`의 공개 지원 근거가 아니다.
- [Apple ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos): 이미 있는 화면을 수집하는 별도 권한·처리 경로다. 본 실험은 호출하지 않는다.

선행 로컬 runtime probe는 클래스·15개 선택자의 metadata만 조회했으며 생성은 0회였다. 그 기록을 실제 lifecycle 증거로 사용하지 않는다.

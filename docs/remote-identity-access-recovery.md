# macOS 기존 원격 신원 접근 확인

변경된 ReviewOps 설치본에서 기존 보호 신원을 읽을 때 `ITEM_READ_FAILED`와 OSStatus `-25293`이 실제 반환되면, 설정 → 원격 관리에 **macOS에서 기존 신원 접근 확인** 안내를 펼칠 수 있다. 이 번호만으로 앱 서명 또는 접근 제어를 단독 원인으로 확정하지 않는다. 미완료 등록, 보존된 과거 진단, Windows와 다른 실패 단계에는 이 안내를 표시하지 않는다.

기존 **기존 신원 읽기 다시 시도**는 저장된 참조의 원래 항목을 읽고 기존 인증서와 키를 확인한다. 신원·인증서·접속 정보를 만들거나 삭제하지 않으며 ACL도 변경하지 않는다. 네이티브 저장소는 프로세스의 Keychain 사용자 상호 작용을 비활성화하므로 이 버튼으로 macOS 접근 승인 창이 열리지는 않는다.

승인이 필요한 경우 사용자가 키체인 접근에서 조치한다.

1. Spotlight에서 키체인 접근을 열고 기본 키체인의 기존 암호 항목에서 서비스 `kr.co.season.reviewops.remote-device-identity.v1`을 찾는다.
2. 해당 기존 항목의 정보 → 접근 제어에서 현재 설치된 ReviewOps 앱의 접근 권한을 확인한다. 승인이 필요하면 그 앱만 개별적으로 추가하거나 승인하고 macOS가 요구하는 확인을 직접 완료한다.
3. ReviewOps에서 **기존 신원 읽기 다시 시도**를 누른다. 성공한 경우 기존 저장 연결로 다시 접속하여 대상과 프로젝트를 확인한다. 다시 거절되면 자료를 보존하고 오류 번호와 앱 버전을 기록한다.

동일 서비스의 항목이 여러 개이거나 앱을 구분할 수 없으면 임의로 변경하지 않는다. 암호를 표시하거나 모든 앱 접근을 허용할 필요가 없다. 기존 항목·프로필·연결을 삭제하거나 신원을 새로 등록하는 절차가 아니다. ReviewOps는 OS 설정을 자동으로 바꾸거나 승인 UI를 자동으로 열지 않는다.

Apple은 [항목별 접근 제어와 개별 앱 추가](https://support.apple.com/en-gb/guide/mac-help/kychn002/26/mac/26), [Keychain 사용자 상호 작용 허용 여부](https://developer.apple.com/documentation/security/seckeychaingetuserinteractionallowed(_:))를 문서화한다. [TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)은 ad hoc 서명의 지정 요구사항이 해당 코드 버전에 묶임을 설명하고, [TN2206](https://developer.apple.com/library/archive/technotes/tn2206/)은 안정된 지정 요구사항을 사용한 업데이트 식별을 설명한다. 이 일반 설명만으로 특정 설치본의 실패 원인이나 접근 승인 후 성공을 확인한 것은 아니다. Developer ID가 안정된 Keychain 코드 신원을 구현할 수 있는 유일한 기술적 방법인 것도 아니다.

이번 변경은 기존 항목의 접근 확인과 읽기 재시도를 연결하는 안내 개선이다. 실제 업데이트 설치본에서 OS 승인 후 같은 기기 ID·키·저장 연결로 재접속하는 결과와 두 PC 연결은 별도 실제 검사가 필요하다. 안내 표시와 단위 검사 통과만으로 해당 결과를 완료 처리하지 않는다.

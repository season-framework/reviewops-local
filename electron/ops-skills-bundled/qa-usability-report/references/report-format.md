# 입력 형식과 실행 방법

## 실행 환경

Python 3.10 이상과 Poppler의 pdftoppm이 필요하다. 가능하면 작업 환경에서 제공하는 Python을 사용하고 전역 패키지를 변경하지 않는다. 아래 SKILL_DIR와 WORK_DIR는 실행 환경에서 정한다.

~~~sh
python3 -m venv "$WORK_DIR/.venv"
"$WORK_DIR/.venv/bin/python" -m pip install -r "$SKILL_DIR/scripts/requirements.txt"
"$WORK_DIR/.venv/bin/python" "$SKILL_DIR/scripts/build_report.py" "$WORK_DIR/content.json" "$WORK_DIR/report-staging.hwpx"
"$WORK_DIR/.venv/bin/python" "$SKILL_DIR/scripts/audit_report.py" "$WORK_DIR/report-final.hwpx" "$WORK_DIR/content.json"
"$WORK_DIR/.venv/bin/python" "$SKILL_DIR/scripts/render_pdf.py" "$WORK_DIR/report-final.pdf" "$WORK_DIR/content.json"
~~~

한글 앱에서 저장·PDF 내보내기는 위 명령 사이에 수행한다. 스크립트는 앱을 열거나 UI를 조작하지 않는다. requirements.txt는 검증한 라이브러리 버전을 고정한다. 다른 버전을 선택하면 도형·이미지 삽입과 한글에서 출력한 결과를 다시 확인한다.

## JSON

- document_title, header, font: 문서 이름·머리말·글꼴. 기본 글꼴은 맑은 고딕이며 대상 환경에서 대체 글꼴을 지정할 수 있다.
- cover: kicker, title(행별 배열), subtitle, rows(항목·내용), notes.
- omit_cover=true: 표지 없는 부분 문서나 서식 검사에 사용.
- pages: 각 원소가 한 쪽. title, 선택적 kicker·lead, blocks를 지정한다. omit_kicker=true는 연속 화면 쪽의 높이를 확보한다.
- qa_scenarios: id, status의 배열. 입력한 경우 결과표의 QA ID와 판정을 감사 스크립트가 대조한다. 상태는 pass, error_found, not_provided, not_run, partial.
- expected_counts: 선택 항목. 실제 검사로 집계한 상태별 수만 입력한다. 빈 양식의 수를 검사 결과로 사용하지 않는다.

일반 블록은 heading, paragraph, bullets, table, link, space이다.

~~~json
{
  "type": "table",
  "headers": ["검사 항목", "조작과 예상 동작", "검사 결과"],
  "rows": [
    ["QA-001\n검사 이름", "실제 수행한 조작과 예상 동작", "오류 발견\n관찰한 실제 결과"]
  ],
  "widths": [1, 2.05, 2.25]
}
~~~

결과표의 첫 칸은 고유한 QA- ID로 시작한다. 마지막 칸은 판정으로 시작한다. 통과·오류 발견·기능 미제공·미실행·부분 확인을 사용한다. 위 행은 입력 구조의 예시이며 실제 검사 결과가 아니다.

## 전체 창 단계

~~~json
{
  "type": "flow_step",
  "title": "1. 조작 이름",
  "path": "screenshots/step-01.png",
  "caption": "① 조작한 위치와 관찰한 결과.",
  "width_mm": 174,
  "max_height_mm": 102,
  "annotations": [
    {"number": 1, "box": [430, 220, 800, 160], "label": "설명할 부분"}
  ]
}
~~~

- path는 입력 JSON 위치에서의 상대 경로 또는 절대 경로이다. 확장자가 틀려도 Pillow가 확인한 실제 PNG/JPEG 형식을 사용한다.
- box는 원본 픽셀의 [x,y,width,height]이다. 사진 자체를 자르지 않는다.
- 번호는 7mm로 출력한다. 사진을 축소하면 원본 좌표에서 차지하는 크기가 커지므로 26px 같은 작은 번호 크기를 가정하지 않는다.
- 자동 배치는 다른 번호와 표시 영역을 피한다. 적절한 위치가 없으면 .validation.json의 annotation_warnings에 기록한다.
- 수동 조정이 필요하면 label_at: [x,y]를 지정한다. label_y는 자동 x 위치를 유지하고 y만 조정한다. 두 값 모두 원본 픽셀 단위이다.
- 캡션에 각 번호의 원문자(①·②)를 포함한다. 박스가 두 개이면 설명에서도 두 위치를 구분한다.
- 원본 사진·테두리·번호는 한 그룹이지만 이미지 바이트와 문서 도형은 별개로 유지된다.
- 2장/쪽은 높이 102mm를 기본으로 한다. 1440×940 원본은 폭 약 156mm로 배치된다. 한 장만 넣거나 표 아래에 넣을 때 높이 105~110mm를 검토할 수 있다.
- 긴 제목·여러 줄 캡션·큰 표가 있으면 실제 쪽 넘침을 검사하고 페이지를 나눈다. 빈 공간보다 원본 전체 창과 읽기 쉬운 설명을 우선한다.

## 검사 파일

- Builder: .validation.json, 본문 .txt 생성. ZIP·스키마·재열기·쪽 추정·도형 경고 기록.
- Audit: .audit.json 생성. JSON 본문 누락, 사진 바이트/MIME, 회색 색상, 사진·도형 수, QA ID·판정, 번호·캡션 대응 검사.
- language_review_flags는 검토할 문자열 목록이다. 예를 들어 실제 UI 문구의 “기준”과 무의미한 장식 표현을 사람이 구분한다. 문자열 일치만으로 문장을 삭제하지 않는다.
- Renderer: PDF 이름의 -pages 폴더에 각 쪽의 PNG·추출 문장·모아 보기·inspection.json 생성. 이 폴더의 이전 생성 파일은 정리하므로 다른 파일을 넣지 않는다. 실제 쪽 수와 제목 위치를 입력 JSON과 대조한다.
- 문서 변경 전후의 PNG 해시가 같으면 해당 쪽의 렌더 결과가 동일하다. 변경된 쪽과 자동 검사에서 발견한 문제는 직접 다시 본다.

이 도구들은 문서 구조를 검사한다. 제품 동작의 사실성, 검사 조건의 충분성, 화면 흐름의 연속성은 실제 실행 자료와 함께 검토한다.


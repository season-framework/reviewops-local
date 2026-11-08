# Writing an actionable ReviewOps review

Use GitHub issue clarity for the internal ReviewOps destination. The reader should understand what to change and how to check it without reopening the chat. Copy facts and constraints from the request accurately; rewrite conversational wording into concise prose. Do not paste the raw instruction as the entire body or use a vague title such as "Improvement request" unless the user explicitly chose it.

## Title

Name the affected feature and concrete behavior. Prefer the trigger plus the problem for a bug, or the resulting behavior for a feature. Keep one concise line and avoid repeating the whole body.

- Useful: `프로젝트 파일 보기에서 탭 전환 후 입력한 설명이 사라짐`
- Useful: `Ops 대화에서 작업 대상을 검색해 선택`
- Weak: `프로그램 개선`, `확인해주세요`, or a long copy of the original chat.

## Body

Use only relevant sections. A bug usually needs a problem, user impact, operation steps, expected behavior and actual behavior. A feature usually needs the current inconvenience, requested behavior and concrete completion conditions; do not invent a broken reproduction for a new feature. Describe actual UI labels so the reader can find them.

The following is an example of an unverified user report, not current QA evidence:

```markdown
## 문제

- 프로젝트 설정에 입력한 설명이 파일 화면으로 이동한 뒤 사라진다는 사용자 제보.
- 작성 중인 설명을 다시 입력해야 한다.
- 직접 재현 검사는 수행하지 않았다.

## 재현 순서

사용자가 제보한 순서다.

1. 프로젝트의 설정에서 설명을 입력한다.
2. 파일 화면으로 이동한 뒤 설정으로 돌아온다.
3. 작성 중인 설명이 남아 있는지 확인한다.

## 실제 동작

- 제보에서는 설명이 사라진다. 발생 조건과 원인은 아직 확인하지 않았다.

## 기대한 동작

- 저장 전 설명도 같은 프로젝트의 화면을 오갈 때 유지한다.
```

Do not retain example wording, identifiers or headings that do not apply. If a fact is missing, omit the detail or identify the narrow unknown; do not fill the section with a guess. A usage question should be answered as guidance instead of silently converted into an executable review.

## Screenshots, source and status

- When actual screenshots are available, attach the relevant original whole app window and connect it to the operation steps. A detail crop may supplement the full window, not replace it. Put photographs outside narrow tables.
- Use returned attachment names and IDs with the app's attachment interface. Do not claim an inline image is displayed when this interface only shows an attachment, and do not invent attachment URLs. If no photograph or reproduction exists, say so accurately rather than presenting an unrelated example.
- Keep private paths, tokens and personal information out of shared text and images. Necessary redaction must not hide the state being explained.
- Include source paths or code links only when actually read and relevant. Do not infer a cause from a file name. Do not require a push or GitHub issue merely to save an internal review.
- Separate requested work, implemented work, tested behavior, publication and review status. New requests may have unchecked completion conditions; a passed result needs a test actually performed.

Use concise Korean written prose and parallel bullets for Korean requests. Prefer useful headings such as `문제`, `재현 순서`, `실제 동작`, `기대한 동작`, `요청 사항` and `조작 화면`. Avoid repetitive introductions, unsupported conclusions and filler headings such as `현재 확인`, `근거`, `기준`, `참고자료`, `축` or a forced count of items. Preserve an actual UI label or source quotation when it is needed for precision.

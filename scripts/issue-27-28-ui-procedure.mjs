import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

// Produce instructions for the parent reviewer. This script does not start an
// application, drive a screen, open a database, or change candidate data.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const reports=path.join(root,'test-results','issue-27-28');
const candidateFile=path.resolve(root,process.argv[2]||'');
if(path.dirname(candidateFile)!==reports||!path.basename(candidateFile).startsWith('candidate-')||!candidateFile.endsWith('.json'))throw new Error('test-results/issue-27-28/candidate-*.json 경로를 입력하십시오.');
const candidate=JSON.parse(fs.readFileSync(candidateFile,'utf8'));
const isolated=path.join(root,'.local-data','q2728-');
if(!candidate.dbPath?.startsWith(isolated)||!candidate.wrapper?.startsWith(isolated)||!candidate.candidateHash)throw new Error('격리 후보 경로와 해시가 필요합니다.');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const relative=file=>path.relative(root,file);
const createdAt=new Date().toISOString();
const output=path.join(reports,`ui-procedure-${createdAt.replace(/[:.]/g,'-')}-${crypto.randomUUID().slice(0,8)}.md`);
const content=`# GitHub #27·#28 부모 화면 검사 절차

작성 시각: ${createdAt}

이 문서는 01 구현의 자기검사와 부모 화면 조작을 구분합니다. 아래 화면 검사는 아직 실행하지 않았습니다. 별도 독립 검토도 남아 있습니다.

| 항목 | 값 |
| --- | --- |
| 후보 해시 | \`${candidate.candidateHash}\` |
| 시작 커밋 | \`${candidate.baseCommit}\` |
| 후보 앱 | \`${candidate.wrapper}\` |
| 시작 파일 | \`${candidate.startCommand}\` |
| 검사 DB | \`${candidate.dbPath}\` |
| 준비 당시 DB SHA256 | \`${candidate.dbSha256}\` |
| DB 형식 | ${candidate.seed?.schemaVersion??'후보 메타데이터 참조'} |
| 후보 정보 파일 | \`${relative(candidateFile)}\` |
| 후보 정보 파일 SHA256 | \`${sha(candidateFile)}\` |
| 실행 로그 | \`${candidate.runtimeLog}\` |
| 준비 URL | 해당 없음. 격리된 Electron 후보 앱을 사용합니다. |

후보는 실제 제품 화면과 검사용 실행 프로그램을 사용합니다. 검사용 실행 프로그램은 정해진 이벤트를 보내며 실제 AI 모델이나 SSH에 접속하지 않습니다. 따라서 이 후보 화면의 통과를 실제 모델 또는 SSH 검사로 기록하지 않습니다.

## 시작

1. 부모가 후보 앱 경로를 CUA로 엽니다. 실행 중인 기본 ReviewOps는 그대로 둡니다.
2. 창의 앱 이름과 검사 그룹을 읽고 기본 ReviewOps와 구분합니다.
3. 'GitHub #27·#28 검사 → 격리 후보 → 요청별 기록과 대화 화면'을 열고 에이전트 화면을 선택합니다.
4. 아래 결과 칸은 실제 조작 후 기록합니다. 통과하지 않은 항목은 실행 전 또는 미검증으로 남깁니다.

## 화면 조작

| 번호 | 조작 | 기대 동작 | 결과 |
| --- | --- | --- | --- |
| 1 | 완료 요청을 읽습니다. | 요청별 모델과 추론 수준이 짧은 한 줄로 보입니다. ID와 원본 로그, 선택값·전달값·프로그램이 알려준 값은 상세를 펼칠 때 보입니다. | 실행 전 |
| 2 | 요청문 복사 후 일반 입력창에 붙여넣습니다. 실행하지 않고 내용을 살핍니다. | 개행과 Markdown 원문이 유지됩니다. 모델 정보, 진행 기록, 버튼 이름은 포함되지 않습니다. 성공 안내가 보입니다. | 실행 전 |
| 3 | 완료 응답을 복사해 같은 방법으로 붙여넣습니다. | 표와 코드의 원문이 유지됩니다. 화면 장식과 진행 정보가 섞이지 않습니다. | 실행 전 |
| 4 | 일반 입력에 'STREAM'을 작성하고 실행합니다. 응답 작성 중 복사합니다. | 작성 중 응답임을 버튼과 안내로 구분합니다. 복사한 뒤 추가된 내용은 포함되지 않습니다. | 실행 전 |
| 5 | 실행 중 접힌 실행 기록을 읽고 펼칩니다. | 접힌 줄에 마지막 작업이 표시됩니다. 별도 진행 박스와 임의 진행률은 없습니다. 펼친 목록 안에서 스크롤합니다. | 실행 전 |
| 6 | 긴 응답의 앞부분으로 이동한 뒤 새 응답을 기다립니다. | 읽던 위치가 유지되고 최신 내용으로 이동 버튼이 보입니다. 버튼을 누를 때 최신 내용으로 이동합니다. | 실행 전 |
| 7 | 긴 실행 기록을 펼치고 목록 중간을 읽는 동안 새 기록을 기다립니다. | 대화 화면과 펼친 목록을 강제로 끝으로 이동시키지 않습니다. 완료 후 제목은 실행 기록입니다. | 실행 전 |
| 8 | 완료된 100개 기록과 생략 안내를 읽습니다. 추가로 'MANY'를 실행합니다. | 저장한 시각과 받은 작업만 표시합니다. 최근 100개 저장과 생략한 수를 알립니다. | 실행 전 |
| 9 | 'EMPTY'를 실행합니다. | 응답이 없다는 안내가 보입니다. 빈 응답의 복사 버튼은 숨기거나 사용할 수 없는 상태이며 복사 성공으로 표시하지 않습니다. | 실행 전 |
| 10 | 'MISSING'을 실행하고 상세를 펼칩니다. | 프로그램이 알려주지 않은 모델·추론 값은 제공되지 않음으로 표시합니다. 선택값이나 전달값으로 채우지 않습니다. | 실행 전 |
| 11 | 예전 실패 기록과 자동 설정 기록의 상세를 읽습니다. | 값이 없던 예전 실행은 기록 없음으로 남습니다. 자동 선택 여부와 프로그램이 알려준 값의 누락을 구분합니다. | 실행 전 |
| 12 | 실행 중 일반 입력에 후속 내용을 쓰고 검사 파일을 첨부한 뒤 대기 목록에 저장합니다. | 실행 중에도 작성과 저장이 가능합니다. 저장만으로 새 실행이 시작되지 않습니다. 저장과 실행을 구분합니다. | 실행 전 |
| 13 | 기본 설정이 A·medium인 상태에서 저장된 B·high 대기 요청을 실행합니다. 다른 대기 요청의 설정도 바꾼 뒤 실행합니다. | 저장된 B·high로 실행합니다. 사용자가 대기 요청 설정을 바꾸면 변경한 값으로 실행합니다. | 실행 전 |
| 14 | 대기 요청 취소와 실행 중지를 각각 사용합니다. | 대기 취소는 대기 요청에만 적용합니다. 실행 중지는 실행 중인 작업에만 적용합니다. | 실행 전 |
| 15 | 같은 대화 이어서 요청과 새 대화를 각각 선택해 짧게 실행합니다. 실패한 요청의 재실행과 이전 내용 가져오기도 사용합니다. | 실행별 기록이 분리됩니다. 상세의 연결 버튼으로 원본 요청·응답을 찾을 수 있습니다. 가져온 내용은 직접 실행해야 시작합니다. | 실행 전 |
| 16 | 일반 초안과 첨부를 남기고 다른 리뷰 또는 화면으로 이동했다 돌아옵니다. 자료 선택 창도 열었다 닫습니다. | 초안과 선택한 자료가 유지됩니다. 자동으로 요청을 시작하지 않습니다. | 실행 전 |
| 17 | 창 너비를 약 640px로 줄이고 밝은 화면과 어두운 화면에서 읽습니다. | 복사와 입력, 대기 목록, 상세 버튼을 사용할 수 있습니다. 긴 ID와 설정 표가 주요 기능을 가리지 않습니다. | 실행 전 |
| 18 | Tab과 Shift+Tab으로 복사·실행 기록·더보기·입력·저장·대기 목록을 이동합니다. Enter·Space로 펼치고 Escape로 메뉴를 닫습니다. | 포커스가 보이고 이름을 읽을 수 있습니다. 메뉴를 닫으면 여는 버튼으로 돌아옵니다. 대화와 기록을 키보드로 이동할 수 있습니다. | 실행 전 |
| 19 | 같은 후보를 닫았다 다시 열고 저장한 대기 요청과 완료 기록을 읽습니다. | 검사 DB의 요청 설정과 연결, 시각과 결과를 유지합니다. 기본 ReviewOps와 사용자 DB에는 영향이 없습니다. | 실행 전 |
| 20 | 프로젝트 기본 모델 A·추론 medium으로 대기 요청을 저장한 뒤 기본값을 B·high로 바꿉니다. 저장된 요청에서 추론 수준만 수정하거나 새 대화만 선택합니다. | 수정하지 않은 모델과 추론 전달값은 저장 당시 값으로 유지됩니다. 모델을 직접 변경할 때만 해당 모델 전달값을 바꿉니다. | 실행 전 |

## 오류와 동시 요청

- 복사 실패, Clipboard API 부재, 작성 중 복사 실패는 Node 격리 검사에서 별도로 다룹니다. 실제 OS의 복사 거부 화면은 아직 검사하지 않았습니다.
- 초안 저장 실패, 동일 문구의 별도 요청 보존, 다른 패널의 새 첨부 보존은 순수 함수 검사로 다룹니다. UI에서 저장 오류를 강제로 만들지 않았으므로 화면 전환 후 오류 안내와 보존 여부는 미검증입니다.
- 같은 대기 요청의 동시 실행은 저장 처리의 자동 검사에서 다룹니다. 부모 화면에서 동시 실행을 검사하려면 이 후보의 검사 DB만 사용합니다.
- 백업·복원과 구버전 DB는 저장 처리의 자동 검사 결과를 확인합니다. 실제 사용자 DB로 시험하지 않습니다.

## 기록할 내용

- 화면 검사 시각, 후보 해시, 시작과 종료 화면을 남깁니다.
- 항목별 실제 결과와 화면 파일을 연결합니다. 화면 파일은 새 고유 이름으로 저장합니다.
- 새 후보가 만들어지면 이 문서의 통과 결과를 옮기지 않고 해당 후보에서 다시 검사합니다.
- 모든 화면 조작이 끝나도 01 구현자의 자기검사와 별도 독립 검토를 구분합니다.

## 문서 점검

- [x] 구어체를 사용하지 않았습니다.
- [x] 모호한 분류명과 과장된 전문용어를 사용하지 않았습니다.
- [x] 검사한 방법과 미검증 항목을 구분했습니다.
- [x] 실제 모델·SSH·사용자 DB 검사를 수행했다고 기록하지 않았습니다.
- [x] 화면 검사를 실행 전으로 표시했습니다.
`;
fs.writeFileSync(output,content,{flag:'wx',mode:0o600});
console.log(JSON.stringify({path:relative(output),sha256:sha(output),candidateHash:candidate.candidateHash},null,2));

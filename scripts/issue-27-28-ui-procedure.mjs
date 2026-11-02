import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {verifyCandidate} from './issue-27-28-candidate.mjs';

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
const sidecar=fs.readFileSync(`${candidateFile}.sha256`,'utf8').trim().split(/\s+/);
if(sidecar[0]!==sha(candidateFile)||sidecar[1]!==path.basename(candidateFile))throw new Error('후보 정보 파일의 SHA256이 일치하지 않습니다.');
const verification=verifyCandidate(candidate);
const relative=file=>path.relative(root,file);
const createdAt=new Date().toISOString();
const output=path.join(reports,`ui-procedure-${createdAt.replace(/[:.]/g,'-')}-${crypto.randomUUID().slice(0,8)}.md`);
const content=`# GitHub #27·#28 parent reviewer UI procedure

Created at: ${createdAt}

This document distinguishes the step 03 implementation self-check from the parent reviewer's UI checks. The UI checks below have not been run. Step 04 re-review also remains pending.

| Item | Value |
| --- | --- |
| Candidate hash | \`${candidate.candidateHash}\` |
| Fix commit | \`${candidate.baseCommit}\` |
| Product file changes | ${candidate.productDirty?'Includes uncommitted changes':'No product file changes'} |
| Candidate app | \`${candidate.wrapper}\` |
| Actual Electron executable | \`${candidate.electronExecutable}\` |
| Electron SHA256 | \`${candidate.electronExecutableSha256}\` |
| Startup file | \`${candidate.startCommand}\` |
| Test DB | \`${candidate.dbPath}\` |
| DB SHA256 at preparation | \`${candidate.dbSha256}\` |
| DB schema | ${candidate.seed?.schemaVersion??'See candidate metadata'} |
| Candidate metadata file | \`${relative(candidateFile)}\` |
| Candidate metadata file SHA256 | \`${sha(candidateFile)}\` |
| Runtime log | \`${candidate.runtimeLog}\` |
| Prepared file verification | SHA256 matches for ${verification.checkedFiles} files |
| Prepared URL | Not applicable. Use the isolated Electron candidate app. |

The candidate uses the actual product UI with a test executable. The test executable emits predefined events and does not connect to a real AI model or SSH host. Do not record a pass in this candidate UI as verification of a real model or SSH connection.

## Start

1. The parent reviewer opens the candidate app path. Leave the running primary ReviewOps app and other candidate apps untouched.
2. Read the app name and test group in the window to distinguish it from the primary ReviewOps app.
3. Open 'GitHub #27·#28 검사 → 격리 후보 → 요청별 기록과 대화 화면' and select the agent view.
4. Fill in the result cells below after performing the actual actions. Leave items that have not passed as Not run or Unverified.

## UI actions

| No. | Action | Expected behavior | Result |
| --- | --- | --- | --- |
| 1 | Read a completed request and an older request with no usage information. | The model used and the absence of usage information are clear and concise. Distinguish selected, submitted, and used values, IDs, and raw logs in More. Do not repeat a large disabled save button for every completed response. | Not run |
| 2 | Copy the request and paste it into a regular input field. Inspect the content without running it. | Preserve line breaks and raw Markdown. Do not include model information, progress logs, or button names. Show a success message. | Not run |
| 3 | Copy a completed response and paste it in the same way. | Preserve raw table and code content. Do not mix in UI decoration or progress information. | Not run |
| 4 | Enter '작성 중 복사 검사' in the main input and run it. Copy while the response is being written. | The button and message identify a response still being written. Content added after copying is not included. | Not run |
| 5 | Read and expand the collapsed execution log during a run. | The collapsed line shows the latest action. There is no separate progress box or arbitrary progress percentage. Scroll within the expanded list. | Not run |
| 6 | Move to an earlier part of a long response and wait for new response content. | Preserve the reading position and show the jump-to-latest button. Move to the latest content when the button is clicked. | Not run |
| 7 | Expand a long execution log and wait for completion while reading the middle of the list. For another run, wait for completion without expanding the log. | The list being read remains expanded at the same reading position after completion. Only logs the user did not expand remain collapsed. | Not run |
| 8 | In the '오류와 빈 응답 검사' review, set the entire request to 'QA:MANY' and run it. | Show the most recent 100 command records and the omitted count. Preserve record sequence numbers and timestamps. | Not run |
| 9 | In the same test review, set the entire request to 'QA:EMPTY' and run it. | Complete successfully without a response. Do not report an empty response as a successful copy. | Not run |
| 10 | In the same test review, set the entire request to 'QA:MISSING', run it, and open More. | Show that used model and reasoning values are unavailable. Do not fill used values with selected or submitted values. | Not run |
| 11 | Read the details of an older failed run and an automatically configured run. | Older runs without values retain the no-record state. Distinguish automatic selection from values missing from the program's report. | Not run |
| 12 | Expand the waiting list during a run and write an additional request in the main input. Attach a test file and save it. | There is one input field. Writing, saving to the waiting list, and stopping the run remain easy to use during a run. Show a message that the request is saved and is not sent directly to the active run. | Not run |
| 13 | With defaults of A·medium, run a saved B·high waiting request. Change another waiting request's settings and then run it. | Run with the saved B·high settings. If the user changes a waiting request's settings, run with the changed values. | Not run |
| 14 | Use waiting request cancellation and run stopping separately. | Waiting cancellation applies only to the waiting request. Stopping applies only to the active run. | Not run |
| 15 | Complete a request with model A. Select a follow-up request, switch to model B, and run it. Also run a new conversation separately. | A follow-up retains the original conversation. Only a new conversation creates a new conversation link. More provides navigation to the original request and response. | Not run |
| 16 | Leave a regular draft and attachments, navigate to another review or view, and return. Also open and close the material picker. | Preserve the draft and selected materials. Do not start a request automatically. | Not run |
| 17 | Resize the window to 850×700 and 1080×800. Prepare a long request, attachments, and several waiting items, then expand the list. Repeat in light and dark themes. | Keep the main input, save, send, More, and stop buttons, and error messages within the window. The waiting list scrolls within the remaining height. | Not run |
| 18 | Use Tab and Shift+Tab to move among copy, execution log, More, input, save, and waiting list controls. Expand with Enter or Space and close menus with Escape. | Focus is visible and control names are readable. Closing a menu returns focus to its trigger. Conversation and log controls support keyboard navigation. | Not run |
| 19 | After testing, close and reopen only this candidate window, then read waiting requests and completed records. | Preserve request settings and links, record sequence numbers, omitted counts, timestamps, and results in the test DB. | Not run |
| 20 | Save a waiting request with project defaults of model A and reasoning medium, then change the defaults to B·high. In the saved request, change only the reasoning level or select only a new conversation. | Unchanged submitted model and reasoning values retain their values from the time of saving. Change the submitted model value only when the user explicitly changes the model. | Not run |
| 21 | In the '오류와 빈 응답 검사' review, save a regular request to the waiting list and run it. Then run 'QA:FAIL' and 'QA:EMPTY' as separate requests. | A regular request does not fail because MANY·MISSING·EMPTY·FAIL appear in the instructions. Distinguish a normal response, failure, and completion without a response. | Not run |
| 22 | Create a failed run with 'QA:FAIL', then run another conversation in the same review. Select retry for the original failed run. | Retry in the conversation used by the original failed run. Preserve the original links in More. | Not run |
| 23 | Start editing a waiting request and change its input, model, and attachments without saving. Separately complete another run, collapse and expand the waiting list, and navigate to another review and back. | Preserve the input, model, attachments, and original links being edited. A saved-list refresh does not overwrite the draft. | Not run |
| 24 | Separately prepare data containing both an older regular draft and a follow-up draft in this candidate, then open the input view. | Retain both drafts and their attachments, and let the user distinguish which content to load. Record preparation of this data condition separately from the actual UI actions. | Not run |
| 25 | Before copying, copy a known temporary phrase. Copy a request and a completed response, then paste them into an input field. | Paste the selected request or response source text instead of the temporary phrase. On failure, provide a failure message and retry. | Not run |

## Errors and concurrent requests

- A mocked copy-function pass in isolated Node checks does not establish that actual OS copying passed. Record actual paste results for items 2, 3, 4, and 25. Record deliberate OS denial and retry results only if tested.
- Pure-function checks cover draft-save failure, preservation of separate requests with identical text, and preservation of new attachments in another panel. Because no save error was forced in the UI, error messages and preservation after view changes remain unverified.
- Automated persistence checks cover concurrent execution of the same waiting request. If the parent reviewer checks concurrent execution in the UI, use only this candidate's test DB.
- Check the automated persistence results for backup, restore, and older DB schemas. Do not test against an actual user's DB.

## What to record

- Record the UI check time, candidate hash, and starting and ending screens.
- Link each item's actual result to a screen file. Save screen files with new unique names.
- When a new candidate is created, rerun the checks on that candidate rather than transferring pass results from this document.
- Even after all UI actions are complete, distinguish the step 03 implementer's self-check from the step 04 re-review.

## Document checks

- [x] Avoided colloquial wording.
- [x] Avoided vague category names and exaggerated technical terminology.
- [x] Distinguished the methods checked from unverified items.
- [x] Did not claim to have tested a real model, SSH connection, or user DB.
- [x] Marked UI checks as Not run.
`;
fs.writeFileSync(output,content,{flag:'wx',mode:0o600});
console.log(JSON.stringify({path:relative(output),sha256:sha(output),candidateHash:candidate.candidateHash},null,2));

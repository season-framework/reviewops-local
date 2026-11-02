import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const run=promisify(execFile),sourceRoot=fileURLToPath(new URL('..',import.meta.url));
const repository='https://github.com/season-framework/reviewops-local';
const headings={features:'New features',improvements:'Improvements',fixes:'Fixes',documentation:'Documentation',maintenance:'Maintenance'};
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const english=value=>typeof value==='string'&&/[A-Za-z]/.test(value)&&!/[\x00-\x1f\x7f]/.test(value)&&!(/[^\p{Script=Latin}\p{Number}\p{Punctuation}\p{Separator}\p{Symbol}\p{Mark}]/u).test(value);
export const escapeReleaseText=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replace(/[\\`*_[\]]/g,'\\$&');

export function validateReleaseHighlights(value,version){
 if(value?.schema!==1||typeof value.version!=='string'||!Array.isArray(value.entries))throw new Error('Release highlights must use schema 1 with a version and entries.');
 if(value.version!==version)return [];
 if(value.entries.length>40)throw new Error('Release highlights contain too many entries.');
 const seen=new Set();
 return value.entries.map(entry=>{
  if(!entry||!Object.hasOwn(headings,entry.category)||!english(entry.title)||entry.title.length>120||!english(entry.description)||entry.description.length>600||!Array.isArray(entry.commits)||!entry.commits.length||entry.commits.length>20||entry.commits.some(commit=>!sha(commit))||new Set(entry.commits).size!==entry.commits.length)throw new Error('Each release highlight needs an English title, description, category and exact source commits.');
  const key=entry.category+'\0'+entry.title;if(seen.has(key))throw new Error('Release highlights contain a duplicate entry.');seen.add(key);
  return {category:entry.category,title:entry.title,description:entry.description,commits:[...entry.commits]};
 });
}

export async function loadReleaseHighlights({version,changes,source,directory=sourceRoot,command=run}={}){
 let value;try{value=JSON.parse(await fs.readFile(path.join(directory,'release-notes.json'),'utf8'));}catch(error){if(error.code==='ENOENT')return [];throw error;}
 const entries=validateReleaseHighlights(value,version);
 if(changes){
  const included=new Set(changes.commits.map(item=>item.commit));
  return entries.filter(entry=>entry.commits.every(commit=>included.has(commit)));
 }
 if(!entries.length)return [];
 if(!sha(source))throw new Error('A full reviewed source commit is required for stable release highlights.');
 // A draft may describe only changes actually present in the reviewed checkout.
 for(const commit of new Set(entries.flatMap(entry=>entry.commits)))await command('git',['merge-base','--is-ancestor',commit,source],{cwd:directory});
 return entries;
}

function references(items){
 const found=new Map();
 for(const item of items)for(const ref of item.references||[]){
  if(!['issue','pull_request'].includes(ref.kind)||!Number.isSafeInteger(ref.number)||ref.number<1)throw new Error('Release reference is invalid.');
  const url=`${repository}/${ref.kind==='issue'?'issues':'pull'}/${ref.number}`;if(ref.url!==url)throw new Error('Release reference must point to this repository.');
  found.set(ref.kind+':'+ref.number,`[${ref.kind==='issue'?'Issue':'PR'} #${ref.number}](${url})`);
 }
 return [...found.values()].join(', ');
}
function categoryFor(subject){
 if(/^(?:docs?|documentation)(?:\(|:|\b)/i.test(subject))return 'documentation';
 if(/^(?:test|ci|build|chore|style|release|refactor)(?:\(|:|\b)/i.test(subject))return 'maintenance';
 if(/^(?:feat(?:ure)?|add|introduce|implement)(?:\(|:|\b)/i.test(subject))return 'features';
 if(/^(?:fix|repair|correct|restore|prevent|reject|guard)(?:\(|:|\b)/i.test(subject))return 'fixes';
 if(/^(?:improve|enhance|support|perf)(?:\(|:|\b)/i.test(subject))return 'improvements';
 return 'maintenance';
}
function subjectTitle(subject){
 if(!english(subject))return 'Source update';
 const value=subject.replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/i,'').replace(/\s*\(#\d+\)$/,'').trim();
 return value?value[0].toUpperCase()+value.slice(1):'Source update';
}
export function changeSections(changes,highlights=[]){
 const commits=changes?.commits||[],byCommit=new Map(commits.map(item=>[item.commit,item]));
 const sections=new Map(Object.keys(headings).map(key=>[key,[]])),covered=new Set(),seen=new Set();
 for(const entry of highlights){
  const items=entry.commits.map(commit=>byCommit.get(commit)).filter(Boolean);
  // Stable draft highlights were already checked against the reviewed source.
  if(changes&&items.length!==entry.commits.length)continue;
  const refs=references(items)||entry.commits.map(commit=>`[${commit.slice(0,12)}](${repository}/commit/${commit})`).join(', ');
  sections.get(entry.category).push(`- **${escapeReleaseText(entry.title)}:** ${escapeReleaseText(entry.description)} ${refs}`);
  for(const commit of entry.commits)covered.add(commit);
 }
 // Reviewed highlights own the user-facing summary. Raw history can contain
 // duplicate merge subjects, fixture work or changes already in the public base.
 // Keep those subjects in sourceDetails; retain fallback only without a match.
 if(!covered.size)for(const item of commits){
  if(covered.has(item.commit)||/^Merge\b/i.test(item.subject))continue;
  const category=categoryFor(item.subject);
  // Raw documentation/build subjects describe implementation work. Keep them
  // in source details; top-level documentation needs a reviewed highlight.
  if(category==='documentation'||category==='maintenance')continue;
  const title=subjectTitle(item.subject),key=title.toLowerCase();if(seen.has(key))continue;seen.add(key);
  const refs=references([item]),link=`[${item.commit.slice(0,12)}](${repository}/commit/${item.commit})`;
  sections.get(category).push(`- **${escapeReleaseText(title)}.** ${refs||link}`);
 }
 return [...sections].filter(([,items])=>items.length).map(([key,items])=>`## ${headings[key]}\n\n${items.slice(0,8).join('\n')}\n`).join('\n');
}
function artifactLink(file,label){return file?`[${label}](${file.url})`:'—';}
function installTable(installers={},archives={}){
 return `| Platform | Installer | Archive |\n| --- | --- | --- |\n${[['darwin-arm64','macOS Apple Silicon'],['darwin-x64','macOS Intel'],['win32-x64','Windows x64']].map(([target,label])=>`| ${label} | ${artifactLink(installers[target],target==='win32-x64'?'EXE':'DMG')} | ${target==='win32-x64'?'—':artifactLink(archives[target],'ZIP')} |`).join('\n')}\n`;
}
function verificationText(records=[]){
 const labels={'darwin-arm64':'macOS Apple Silicon','darwin-x64':'macOS Intel','win32-x64':'Windows x64'};
 const targets=records.filter(record=>record.ok===true&&Object.hasOwn(labels,record.target)).map(record=>labels[record.target]);
 return targets.length?`Native package verification completed on ${targets.join(', ')}. Issue-specific QA is recorded separately.\n`:'Native package verification records and issue-specific QA must be reviewed before publication.\n';
}
function limits(records=[],test=false){
 const items=test?['This is a prerelease intended for testing before the next stable release.']:[];
 if(records.some(record=>record.target==='win32-x64'&&record.publisher?.status==='NotSigned'))items.push('The Windows installer is **NotSigned**.');
 return items.length?`## Known limitations\n\n${items.map(item=>'- '+item).join('\n')}\n\n`:'';
}
function sourceDetails(changes){
 if(!changes?.baseCommit)return 'The previous public test source is unavailable; no change range is inferred.\n';
 const list=changes.commits.slice(0,30).map(item=>`- ${escapeReleaseText(subjectTitle(item.subject))} ([${item.commit.slice(0,12)}](${repository}/commit/${item.commit}))${references([item])?' · '+references([item]):''}`).join('\n');
 return `<details>\n<summary>Source changes and related issues</summary>\n\n[Full comparison: ${changes.totalCommits} commits](${repository}/compare/${changes.baseCommit}...${changes.commit})\n\n${list}\n\n</details>\n`;
}
export function renderTestReleaseNotes({build,versionLabel,pointer,changes,installers,archives,verification=[],highlights=[],history=[]}){
 const sections=changeSections(changes,highlights);
 const historyText=history.length?`\n## Development history\n\n${history.map(item=>`- [${item.version}](${item.url}) · build ${item.buildNumber} · [${item.commit.slice(0,12)}](${repository}/commit/${item.commit})`).join('\n')}\n`:'';
 return `**Test channel** — preview the changes below before the next stable release.\n\n${sections?sections+'\n':''}## Install and update\n\n${installTable(installers,archives)}\nEnable **Test updates** in the app to use this channel. Development-version downloads and legacy test-build downloads contain the same verified bytes. Only the current installer set is retained; development-history JSON files are preserved.\n\n${limits(verification,true)}## Verification\n\n${verificationText(verification)}\n## Build details\n\n| Item | Value |\n| --- | --- |\n| App version | \`${versionLabel}\` |\n| Build | \`${build.buildNumber}\` |\n| Source | [${build.commit.slice(0,12)}](${repository}/commit/${build.commit}) |\n| Built at | \`${build.builtAt}\` (UTC) |\n\n${sourceDetails(changes)}${historyText}\n<!-- reviewops-test-pointer:${JSON.stringify(pointer)} -->\n`;
}
export function renderStableDraftNotes(plan,highlights=[]){
 const reason=english(plan.policy?.reason)?escapeReleaseText(plan.policy.reason):'Review the source changes linked below for the release scope.';
 const sections=changeSections(undefined,highlights)||`## Changes\n\n- ${reason}\n`;
 const base=`${repository}/releases/download/${plan.tag}/`,file=suffix=>{const item=plan.files?.find(value=>value.name.endsWith(suffix));return item&&{...item,url:base+item.name};};
 const installers={'darwin-arm64':file('-arm64.dmg'),'darwin-x64':file('-x64.dmg'),'win32-x64':file('-windows-x64.exe')},archives={'darwin-arm64':file('-arm64.zip'),'darwin-x64':file('-x64.zip')};
 return `**Draft — issue-linked QA, the QA report, and publication review are pending.**\n\n${sections}\n## Install and update\n\n${installTable(installers,archives)}\nVerified packages are attached by the delivery task. This draft is not published automatically.\n\n${limits(plan.verification)}## Verification\n\n${verificationText(plan.verification)}\n## Build details\n\n- [Reviewed source: ${plan.commit}](${repository}/commit/${plan.commit})\n${plan.policy?.previousVersion?`- [Changes since ${plan.policy.previousVersion}](${repository}/compare/v${plan.policy.previousVersion}...${plan.commit})\n`:''}`;
}

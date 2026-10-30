import React, {useEffect, useId, useRef, useState} from 'react';
import Icon from './icons.jsx';
import {formatDate, t, useLocale} from './i18n/index.js';
import RefreshIntervalField,{intervalValue} from './RefreshIntervalField.jsx';
import './update-settings.css';
const messages = {
 idle:'업데이트를 확인할 수 있습니다.', checking:'업데이트 확인 중', current:'최신 버전입니다.',
 available:'새 버전을 사용할 수 있습니다.', downloading:'업데이트 다운로드 중', verifying:'다운로드한 앱 검사 중',
 ready:'업데이트 설치 준비가 완료되었습니다.', installing:'업데이트를 설치하기 위해 앱을 다시 시작합니다.', error:'업데이트를 완료하지 못했습니다.'
};
const errorMessages = {
 test_changed:'테스트 버전이 변경되었습니다. 업데이트를 다시 확인하십시오.',
 older_build:'설치했거나 전에 받은 버전보다 오래된 파일입니다.',
 invalid_manifest:'업데이트 파일 정보가 일치하지 않습니다. 다시 확인하십시오.',
 build_mismatch:'업데이트 파일 정보가 일치하지 않습니다. 다시 확인하십시오.',
 invalid_installer:'업데이트 파일 정보가 일치하지 않습니다. 다시 확인하십시오.',
 hash_mismatch:'설치 파일 검사가 실패했습니다. 다시 받으십시오.',
 installer_failed:'설치 파일을 열지 못했습니다. 다시 시도하십시오.'
};
const invokeUpdate=(action,payload)=>window.reviewops.invoke(action,payload);
const generation=value=>Number.isSafeInteger(value?.generation)?value.generation:0;
function BuildInfo({label,build,version}) {
 return <div className="update-build-info"><h3>{label}</h3><dl>
  <dt>{t('버전')}</dt><dd>{build?.version||version||'—'}{build?.channel==='test'?` · ${t('테스트')}`:''}</dd>
  <dt>{t('빌드 번호')}</dt><dd>{build?.buildNumber??t('정보 없음')}</dd>
  <dt>{t('커밋')}</dt><dd title={build?.commit}>{build?.commit?build.commit.slice(0,12):t('정보 없음')}</dd>
  <dt>{t('생성 시간')}</dt><dd>{build?.builtAt?<time dateTime={build.builtAt}>{formatDate(build.builtAt)}</time>:t('정보 없음')}</dd>
 </dl></div>
}
export default function UpdateSettings({invoke=invokeUpdate}) {
 useLocale();
 const descriptionId=useId();
 const [state,setState]=useState(null),[error,setError]=useState(''),[pending,setPending]=useState(false),[minutes,setMinutes]=useState('10'),[saved,setSaved]=useState(false),[testChoice,setTestChoice]=useState(null),[copied,setCopied]=useState(false);
 const stateRef=useRef(null),request=useRef(0),actionPending=useRef(false),revision=useRef(0),previous=useRef(null),copyTimer=useRef(null);
 const accept=value=>{if(!value||generation(value)<generation(stateRef.current))return false;revision.current++;stateRef.current=value;setState(value);return true};
 useEffect(()=>{
  let active=true;const before=revision.current;
  const stop=window.reviewops?.onUpdateState?.(value=>{if(active)accept(value)});
  invoke('update.state').then(value=>{if(active&&before===revision.current)accept(value)}).catch(failure=>{if(active&&before===revision.current)setError(failure.message)});
  return()=>{active=false;request.current++;stop?.();clearTimeout(copyTimer.current)};
 },[invoke]);
 useEffect(()=>{if(!state)return;const next=String(state.intervalMinutes??10),prior=previous.current;setMinutes(current=>prior===null||current===prior?next:current);previous.current=next},[state?.intervalMinutes]);
 const action=async(name,payload,{changeChannel=false}={})=>{
  if(actionPending.current&&!changeChannel)return;
  const token=++request.current,before=revision.current,epoch=generation(stateRef.current);
  actionPending.current=true;setPending(true);setError('');setSaved(false);
  if(changeChannel)setTestChoice(payload.testUpdates);
  try{
   const result=await invoke(`update.${name}`,payload);
   if(token!==request.current)return;
   if(result?.status&&generation(result)>=generation(stateRef.current)&&(before===revision.current||generation(result)>generation(stateRef.current)))accept(result);
   if(name==='configure'&&payload?.intervalMinutes!==undefined){setMinutes(String(payload.intervalMinutes));setSaved(true)}
  }catch(failure){if(token===request.current&&(changeChannel||epoch===generation(stateRef.current)))setError(failure.message)}
  finally{if(token===request.current){actionPending.current=false;setPending(false);if(changeChannel)setTestChoice(null)}}
 };
 const copyInfo=async()=>{setCopied(false);setError('');try{await invoke('update.copyInfo');setCopied(true);clearTimeout(copyTimer.current);copyTimer.current=setTimeout(()=>setCopied(false),2000)}catch(failure){setError(failure.message)}};
 const save=event=>{event.preventDefault();const value=intervalValue(minutes,1);if(value===null){setError(t('업데이트 확인 주기는 1~1440분 사이의 정수로 입력하십시오.'));return}action('configure',{intervalMinutes:value})};
 const working=pending||['checking','downloading','verifying','installing'].includes(state?.status);
 const canCheck=state?.canCheck??state?.supported,manual=state?.manualInstall===true,testSelected=testChoice??(state?.testUpdates??state?.channel==='test'),installed=state?.installedBuild;
 const testUnavailable=state?.errorCode==='test_unavailable';
 const updateError=error||(!testUnavailable&&(errorMessages[state?.errorCode]||state?.error));
 const progress=Math.max(0,Math.min(100,Number(state?.progress)||0));
 let message=messages[state?.status]||messages.idle;
 if(testUnavailable)message='받을 수 있는 테스트 버전이 없습니다.';
 else if(state?.status==='current'&&installed?.channel==='test'&&state?.channel==='stable')message='새 정식 버전이 없습니다.';
 else if(state?.status==='current'&&state?.channel==='test')message=installed?.channel==='test'?'설치된 테스트 버전이 최신입니다.':'새 테스트 버전이 없습니다.';
 else if(manual&&state?.status==='ready')message='설치 파일을 사용할 수 있습니다.';
 else if(manual&&state?.status==='installing')message='설치 파일을 여는 중';
 const installerReady=state?.status==='ready'||state?.errorCode==='installer_failed';
 const installLabel=manual?(installerReady?'설치 파일 열기':working?'업데이트 진행 중':'설치 파일 받기'):(state?.status==='ready'?'설치하고 다시 시작':working?'업데이트 진행 중':'업데이트 설치');
 return <section className="settings-panel update-settings" aria-label={t('앱 업데이트')}>
  <div className="section-heading"><h2>{t('앱 업데이트')}</h2><button className="button" disabled={working||!canCheck} onClick={()=>action('check')}><Icon name="refresh" size={16}/>{t('업데이트 확인')}</button></div>
  <p>{t('GitHub에 공개된 새 버전을 확인하고 설치합니다.')}</p>
  <label className="update-automatic"><input type="checkbox" checked={state?.automatic??true} disabled={!canCheck||working} onChange={event=>action('configure',{automatic:event.target.checked})}/><span>{t('새 버전 자동 확인')}</span></label>
  <p className="muted">{t('앱을 시작할 때 새 버전을 확인하고 설정한 간격으로 다시 확인합니다.')}</p>
  <form className="settings-interval-form" onSubmit={save} noValidate><RefreshIntervalField label={t('앱 업데이트 확인 주기')} value={minutes} onChange={value=>{setMinutes(value);setSaved(false)}} min={1} presets={[1,5,10,30,60,360,1440]} disabled={!canCheck||working}/><button type="submit" className="button" disabled={!canCheck||working||String(state?.intervalMinutes??10)===minutes}>{t('주기 저장')}</button></form>
  {saved&&<p className="settings-save-note" aria-live="polite">{t('주기를 저장했습니다.')}</p>}
  <div className="update-test-option"><label className="update-automatic"><input type="checkbox" checked={testSelected} disabled={!state?.testSupported||state?.status==='installing'} onChange={event=>action('configure',{testUpdates:event.target.checked},{changeChannel:true})} aria-describedby={descriptionId}/><span>{t('테스트 버전 받기')}</span></label>
   <p id={descriptionId} className="muted">{t('정식 출시 전 기능을 확인할 수 있는 버전을 받습니다.')}</p>
   {installed?.channel==='test'&&!testSelected&&<p className="muted">{t('선택 해제 후에는 정식 업데이트를 확인합니다. 설치된 테스트 버전은 바뀌지 않습니다.')}</p>}
  </div>
  <div className="update-version-row"><span>{t('설치된 버전')} <strong>{installed?.version||state?.version||'—'}</strong>{installed?.channel==='test'&&<span className="update-test-badge">{t('테스트')}</span>}</span>{state?.availableVersion&&<span>{t('받을 버전')} <strong>{state.availableVersion}</strong>{state?.availableBuild?.channel==='test'&&<span className="update-test-badge">{t('테스트')}</span>}</span>}</div>
  {state&&!canCheck?<p className="muted">{t(state.testSupported?'정식 버전은 릴리스에서 설치 파일을 받아 설치하십시오.':'자동 업데이트는 설치된 macOS 앱에서 사용할 수 있습니다.')}</p>:<p role="status" aria-live="polite">{t(message)}{state?.status==='downloading'?` ${progress}%`:''}</p>}
  {state?.status==='downloading'&&<progress max="100" value={progress} aria-label={t('업데이트 다운로드 진행률')}/>}
  {updateError&&<p className="form-error" role="alert">{t(updateError)}</p>}
  {canCheck&&state?.availableVersion&&<div className="update-actions"><button className="button primary" disabled={working} onClick={()=>action(manual?(installerReady?'install':'download'):'apply')}><Icon name={working||installerReady?'refresh':'download'} size={16}/>{t(installLabel)}</button></div>}
  {canCheck&&<p className="muted">{t(manual?'설치 파일을 연 뒤 안내에 따라 설치하십시오. 앱은 자동으로 종료되지 않습니다.':'업데이트를 누르면 다운로드와 설치 후 앱을 다시 시작합니다. 프로젝트와 계정 자료는 유지됩니다.')}</p>}
  <details className="update-details"><summary>{t('자세히 보기')}</summary><div className="update-build-list"><BuildInfo label={t('설치된 버전')} build={installed} version={state?.version}/>{state?.availableVersion&&<BuildInfo label={t('받을 버전')} build={state.availableBuild} version={state.availableVersion}/>}</div>
   <div className="update-actions"><button className="button" onClick={copyInfo} disabled={!state}>{t(copied?'복사됨':'버전 정보 복사')}</button><button className="button" disabled={pending||state?.status==='installing'} onClick={()=>action('openRelease')}><Icon name="external" size={16}/>{t('릴리스 보기')}</button></div>
  </details>
 </section>
}

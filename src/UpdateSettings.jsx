import React, {useEffect, useRef, useState} from 'react';
import Icon from './icons.jsx';
import {t, useLocale} from './i18n/index.js';
import './update-settings.css';
const messages = {
 idle:'업데이트를 확인할 수 있습니다.', checking:'업데이트 확인 중', current:'최신 버전입니다.',
 available:'새 버전을 사용할 수 있습니다.', downloading:'업데이트 다운로드 중', verifying:'다운로드한 앱 검사 중',
 ready:'업데이트 설치 준비가 완료되었습니다.', installing:'업데이트를 설치하기 위해 앱을 다시 시작합니다.', error:'업데이트를 완료하지 못했습니다.'
};
const invokeUpdate=(action,payload)=>window.reviewops.invoke(action,payload);
export default function UpdateSettings({invoke=invokeUpdate}) {
 useLocale();
 const [state,setState]=useState(null),[error,setError]=useState(''),[pending,setPending]=useState(false);
 const actionPending=useRef(false);
 useEffect(()=>{let active=true,updated=false;const stop=window.reviewops?.onUpdateState?.(value=>{updated=true;if(active)setState(value)});invoke('update.state').then(value=>{if(active&&!updated)setState(value)}).catch(failure=>{if(active&&!updated)setError(failure.message)});return()=>{active=false;stop?.()}},[invoke]);
 const action=async(name,payload)=>{if(actionPending.current)return;actionPending.current=true;setPending(true);setError('');try{const result=await invoke(`update.${name}`,payload);if(result?.status)setState(result)}catch(failure){setError(failure.message)}finally{actionPending.current=false;setPending(false)}};
 const working=pending||['checking','downloading','verifying','installing'].includes(state?.status);
 const progress=Math.max(0,Math.min(100,Number(state?.progress)||0));
 return <section className="settings-panel update-settings" aria-label={t('앱 업데이트')}>
  <div className="section-heading"><h2>{t('앱 업데이트')}</h2><button className="button" disabled={working||!state?.supported} onClick={()=>action('check')}><Icon name="refresh" size={16}/>{t('업데이트 확인')}</button></div>
  <p>{t('GitHub에 공개된 새 버전을 확인하고 설치합니다.')}</p>
  <label className="update-automatic"><input type="checkbox" checked={state?.automatic??true} disabled={!state?.supported||working} onChange={event=>action('configure',{automatic:event.target.checked})}/><span>{t('새 버전 자동 확인')}</span></label>
  <div className="update-version-row"><span>{t('설치된 버전')} <strong>{state?.version||'—'}</strong></span>{state?.availableVersion&&<span>{t('새 버전')} <strong>{state.availableVersion}</strong></span>}</div>
  {state&&!state.supported?<p className="muted">{t('자동 업데이트는 설치된 macOS 앱에서 사용할 수 있습니다.')}</p>:<p role="status" aria-live="polite">{t(messages[state?.status]||messages.idle)}{state?.status==='downloading'?` ${progress}%`:''}</p>}
  {state?.status==='downloading'&&<progress max="100" value={progress} aria-label={t('업데이트 다운로드 진행률')}/>}
  {(error||state?.error)&&<p className="form-error" role="alert">{t(error||state.error)}</p>}
  <div className="update-actions">
   {state?.supported&&state?.availableVersion&&<button className="button primary" disabled={working} onClick={()=>action('apply')}><Icon name={working||state.status==='ready'?'refresh':'download'} size={16}/>{t(state.status==='ready'?'설치하고 다시 시작':working?'업데이트 진행 중':'업데이트 설치')}</button>}
   <button className="button" disabled={pending||state?.status==='installing'} onClick={()=>action('openRelease')}><Icon name="external" size={16}/>{t('릴리스 보기')}</button>
  </div>
  <p className="muted">{t('업데이트를 누르면 다운로드와 설치 후 앱을 다시 시작합니다. 프로젝트와 계정 자료는 유지됩니다.')}</p>
 </section>
}

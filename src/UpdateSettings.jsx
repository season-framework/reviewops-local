import React, {useEffect, useState} from 'react';
import Icon from './icons.jsx';
import {t, useLocale} from './i18n/index.js';
import './update-settings.css';
const messages = {
 idle:'업데이트를 확인할 수 있습니다.', checking:'업데이트 확인 중', current:'최신 버전입니다.',
 available:'새 버전을 사용할 수 있습니다.', downloading:'업데이트 다운로드 중', verifying:'다운로드한 앱 검사 중',
 ready:'업데이트 설치 준비가 완료되었습니다.', installing:'업데이트를 설치하기 위해 앱을 다시 시작합니다.', error:'업데이트를 완료하지 못했습니다.'
};
export default function UpdateSettings({invoke = (action,payload) => window.reviewops.invoke(action,payload)}) {
 useLocale();
 const [state,setState]=useState(null),[error,setError]=useState(''),[pending,setPending]=useState(false);
 useEffect(()=>{let active=true;invoke('update.state').then(value=>{if(active)setState(value)}).catch(failure=>{if(active)setError(failure.message)});const stop=window.reviewops?.onUpdateState?.(value=>setState(value));return()=>{active=false;stop?.()}},[invoke]);
 const action=async(name,payload)=>{setPending(true);setError('');try{const result=await invoke(`update.${name}`,payload);if(result?.status)setState(result)}catch(failure){setError(failure.message)}finally{setPending(false)}};
 const working=pending||['checking','downloading','verifying','installing'].includes(state?.status);
 return <section className="settings-panel update-settings" aria-label={t('앱 업데이트')}>
  <div className="section-heading"><h2>{t('앱 업데이트')}</h2><button className="button" disabled={working||!state?.supported} onClick={()=>action('check')}><Icon name="refresh" size={16}/>{t('업데이트 확인')}</button></div>
  <p>{t('GitHub에 공개된 새 버전을 확인하고 설치합니다.')}</p>
  <label className="update-automatic"><input type="checkbox" checked={state?.automatic??true} disabled={!state||working} onChange={event=>action('configure',{automatic:event.target.checked})}/><span>{t('새 버전 자동 확인')}</span></label>
  <div className="update-version-row"><span>{t('설치된 버전')} <strong>{state?.version||'—'}</strong></span>{state?.availableVersion&&<span>{t('새 버전')} <strong>{state.availableVersion}</strong></span>}</div>
  {state&&!state.supported?<p className="muted">{t('자동 업데이트는 설치된 macOS 앱에서 사용할 수 있습니다.')}</p>:<p role="status" aria-live="polite">{t(messages[state?.status]||messages.idle)}{state?.status==='downloading'?` ${state.progress}%`:''}</p>}
  {state?.status==='downloading'&&<progress max="100" value={state.progress} aria-label={t('업데이트 다운로드 진행률')}/>}
  {(error||state?.error)&&<p className="form-error" role="alert">{t(error||state.error)}</p>}
  <div className="update-actions">
   {state?.availableVersion&&!['ready','installing'].includes(state.status)&&<button className="button primary" disabled={working} onClick={()=>action('download')}><Icon name="download" size={16}/>{t('업데이트 다운로드')}</button>}
   {state?.status==='ready'&&<button className="button primary" disabled={working} onClick={()=>action('install')}><Icon name="refresh" size={16}/>{t('설치하고 다시 시작')}</button>}
   <button className="button" onClick={()=>action('openRelease')}><Icon name="external" size={16}/>{t('릴리스 보기')}</button>
  </div>
  <p className="muted">{t('설치 전 작업을 저장하고 터미널 연결을 종료하십시오. 프로젝트와 계정 자료는 유지됩니다.')}</p>
 </section>
}

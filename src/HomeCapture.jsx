import {t} from './i18n/index.js';
import React,{useEffect,useRef,useState} from 'react';
import {Dialog,Button} from './components.jsx';
import {OriginalViewer} from './ProjectWorkspace.jsx';
import './browser-logs.css';

export default function HomeCapture({request,service,invoke,onFinish}) {
 const alive=useRef(true),viewer=useRef(null),[file,setFile]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);
 useEffect(()=>{let alive=true;if(request.review.targetPath&&service)invoke('files.read',{serviceId:service.id,path:request.review.targetPath}).then(value=>{if(alive)setFile(value)}).catch(cause=>{if(alive)setError(cause.message)});return()=>{alive=false}},[request.review.id]);
 const capture=async()=>{setBusy(true);setError('');try{const result=await viewer.current.capture(request.options);if(result&&alive.current){const evidence=await viewer.current.collectEvidence();if(alive.current)onFinish(result,evidence)}}catch(cause){if(alive.current)setError(cause.message)}finally{if(alive.current)setBusy(false)}};
 return <div className="home-capture-dialog"><Dialog title={t("스크린샷 캡처")} wide onClose={()=>onFinish(null)} footer={<><span>{t("캡처할 화면을 열고 선택하십시오.")}</span><Button onClick={()=>onFinish(null)}>{t("취소")}</Button><Button variant="primary" disabled={busy} onClick={capture}>{busy?t("캡처 중"):t("스크린샷 캡처")}</Button></>}>{error&&<p className="form-error" role="alert">{error}</p>}<OriginalViewer ref={viewer} service={service} services={service?[service]:[]} invoke={invoke} file={file} targetUrl={request.review.targetUrl||service?.viewerUrl||''} onError={setError} onScreenshot={async result=>{if(!alive.current)return;const evidence=await viewer.current.collectEvidence();if(alive.current)onFinish(result,evidence)}} onBrowse={()=>setError(t("프로젝트 파일 화면에서 파일을 선택한 뒤 캡처할 수 있습니다."))} onClearFile={()=>setFile(null)}/></Dialog></div>;
}

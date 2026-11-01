import {t} from './i18n/index.js';
import React,{useEffect,useRef,useState} from 'react';
import {Dialog,Button} from './components.jsx';
import {OriginalViewer} from './ProjectWorkspace.jsx';
import './browser-logs.css';
import ScreenshotEditor from './ScreenshotEditor.jsx';
import Select from './Select.jsx';

function FileHomeCapture({request,service,invoke,onFinish}) {
 const alive=useRef(true),viewer=useRef(null),[file,setFile]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);
 useEffect(()=>{let alive=true;if(request.review.targetPath&&service)invoke('files.read',{serviceId:service.id,path:request.review.targetPath}).then(value=>{if(alive)setFile(value)}).catch(cause=>{if(alive)setError(cause.message)});return()=>{alive=false}},[request.review.id]);
 const capture=async()=>{setBusy(true);setError('');try{const result=await viewer.current.capture(request.options);if(result&&alive.current){const evidence=await viewer.current.collectEvidence();if(alive.current)onFinish(result,evidence)}}catch(cause){if(alive.current)setError(cause.message)}finally{if(alive.current)setBusy(false)}};
 return <div className="home-capture-dialog"><Dialog title={t("스크린샷 캡처")} wide onClose={()=>onFinish(null)} footer={<><span>{t("캡처할 화면을 열고 선택하십시오.")}</span><Button onClick={()=>onFinish(null)}>{t("취소")}</Button><Button variant="primary" disabled={busy} onClick={capture}>{busy?t("캡처 중"):t("스크린샷 캡처")}</Button></>}>{error&&<p className="form-error" role="alert">{error}</p>}<OriginalViewer ref={viewer} projectId={request.review.projectId} service={service} services={service?[service]:[]} invoke={invoke} file={file} targetUrl={request.review.targetUrl||service?.viewerUrl||''} onError={setError} onScreenshot={async result=>{if(!alive.current)return;const evidence=await viewer.current.collectEvidence();if(alive.current)onFinish(result,evidence)}} onBrowse={()=>setError(t("프로젝트 파일 화면에서 파일을 선택한 뒤 캡처할 수 있습니다."))} onClearFile={()=>setFile(null)}/></Dialog></div>;
}


export default function HomeCapture(props){
 if(props.request.review.targetPath)return <FileHomeCapture {...props}/>;
 return <LiveHomeCapture {...props}/>;
}
function LiveHomeCapture({request,invoke,onFinish}){
 const [sessions,setSessions]=useState([]),[selected,setSelected]=useState(''),[acquired,setAcquired]=useState(null),[preview,setPreview]=useState(null),[capture,setCapture]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const live=useRef(true),intent=useRef(''),accepted=useRef(false),sequence=useRef(0);
 const projectId=request.review.projectId,reviewId=request.review.id,context=request.options.captureContext;
 useEffect(()=>{live.current=true;invoke('viewerSession.list',{projectId,reviewId}).then(value=>{if(live.current){setSessions(value.sessions);if(value.sessions.length===1)setSelected(value.sessions[0].sessionId)}}).catch(cause=>{if(live.current)setError(cause.message)});return()=>{live.current=false;sequence.current++;if(intent.current&&!accepted.current)invoke('viewerSession.end',{intentId:intent.current}).catch(()=>{})}},[]);
 const run=async action=>{setBusy(true);setError('');const revision=++sequence.current;try{await action(revision)}catch(cause){if(live.current&&revision===sequence.current){setError(t(cause.message));if(['SESSION_GONE','TARGET_CHANGED','STALE_CAPTURE'].includes(cause.code))setPreview(null)}}finally{if(live.current&&revision===sequence.current)setBusy(false)}};
 const connect=()=>run(async revision=>{
  if(!context)throw new Error(t('작성 화면에서 캡처를 다시 시작하십시오.'));
  if(intent.current)await invoke('viewerSession.end',{intentId:intent.current});
  const target=sessions.find(s=>s.sessionId===selected);if(!target)return;
  const value=await invoke('viewerSession.begin',{...context,projectId,reviewId,sessionId:target.sessionId,epoch:target.epoch});
  if(!live.current||revision!==sequence.current){invoke('viewerSession.end',{intentId:value.intentId}).catch(()=>{});return}
  intent.current=value.intentId;setAcquired(value);
  const image=await invoke('viewerSession.preview',{intentId:value.intentId});if(live.current&&revision===sequence.current)setPreview(image);
 });
 const refresh=()=>run(async revision=>{const image=await invoke('viewerSession.preview',{intentId:intent.current});if(live.current&&revision===sequence.current)setPreview(image)});
 const take=()=>run(async revision=>{const image=await invoke('viewerSession.capture',{intentId:intent.current});if(!live.current||revision!==sequence.current)return;if(request.options.mode==='auto'){accepted.current=true;onFinish(image,image.evidence)}else setCapture(image)});
 const finish=image=>{if(!image){setCapture(null);return}accepted.current=true;onFinish(image,image.evidence)};
 return <div className="home-capture-dialog live-home-capture-dialog"><Dialog title={t('스크린샷 캡처')} wide onClose={()=>onFinish(null)} footer={<><Button onClick={()=>onFinish(null)}>{t('취소')}</Button><Button disabled={busy||!acquired} onClick={refresh}>{t('미리보기 새로고침')}</Button><Button variant="primary" disabled={busy||!acquired||!preview} onClick={take}>{busy?t('캡처 중'):t('스크린샷 캡처')}</Button></>}>
  <p>{t('웹 화면의 읽기 전용 미리보기입니다. 입력과 이동은 원래 프로젝트 창에서 수행하십시오.')}</p>
  {error&&<p className="form-error" role="alert">{error}</p>}
  {!acquired&&<><label>{t('실행 중인 웹 화면')}<Select searchable disabled={busy} aria-label={t('실행 중인 웹 화면')} value={selected} onChange={event=>setSelected(event.target.value)}><option value="">{t('화면 선택')}</option>{sessions.map(s=><option key={s.sessionId} value={s.sessionId}>{s.title||s.url}</option>)}</Select></label><Button disabled={busy||!selected} onClick={connect}>{t('선택한 화면 연결')}</Button>{!sessions.length&&<p role="status">{t('열려 있는 웹 검사 화면이 없습니다. 프로젝트에서 화면을 연 뒤 다시 캡처하십시오.')}</p>}</>}
  {acquired&&<><p><strong>{t('웹 화면')}</strong> · {acquired.title||acquired.url}</p><Button disabled={busy} onClick={()=>{invoke('viewerSession.end',{intentId:intent.current}).catch(()=>{});intent.current='';setAcquired(null);setPreview(null);setSelected('');invoke('viewerSession.list',{projectId,reviewId}).then(value=>{if(live.current)setSessions(value.sessions)}).catch(cause=>{if(live.current)setError(cause.message)})}}>{t('대상 다시 선택')}</Button></>}
  {preview&&<img src={preview.dataUrl} alt={t('실행 중인 웹 화면 미리보기')} style={{display:'block',maxWidth:'100%',maxHeight:'55vh',margin:'0 auto',objectFit:'contain'}}/>}
 </Dialog>{capture&&<ScreenshotEditor capture={capture} onConfirm={finish} onCancel={()=>setCapture(null)}/>}</div>;
}

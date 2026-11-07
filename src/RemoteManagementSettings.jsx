import React,{useEffect,useRef,useState} from 'react';
import {t,useLocale} from './i18n/index.js';
import RemoteAppConnections from './RemoteAppConnections.jsx';
import PageHeader from './PageHeader.jsx';

const ID=/^[A-Za-z0-9_-]{1,128}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FIXED_CODE=/^[A-Z][A-Z0-9_]{0,79}$/;
const ERROR_TEXT=Object.freeze({
 INVALID_REMOTE_REQUEST:'요청 내용을 확인한 뒤 다시 시도하십시오.',
 STALE_REMOTE_REQUEST:'원격 관리 상태가 바뀌었습니다. 상태를 새로고침하십시오.',
 REMOTE_MANAGEMENT_BUSY:'다른 원격 관리 작업을 마친 뒤 다시 시도하십시오.',
 REMOTE_MANAGEMENT_CLOSED:'원격 관리를 사용할 수 없습니다.',
 WEB_ACCESS_ACTIVE:'브라우저 연결을 끈 뒤 인증서를 변경하십시오.',
 WEB_ACCESS_DISABLED:'브라우저 연결을 켠 뒤 초대를 만드십시오.',
 WEB_LISTENER_UNAVAILABLE:'브라우저 연결을 시작하지 못했습니다. 주소와 포트를 확인하십시오.',
 WEB_DRAIN_UNCONFIRMED:'이전 연결의 종료를 확인하지 못했습니다. 연결을 다시 시작하지 마십시오.',
 PORT_IN_USE:'선택한 포트를 이미 사용 중입니다. 다른 포트를 선택하십시오.',
 ADDRESS_UNAVAILABLE:'선택한 주소를 이 컴퓨터에서 사용할 수 없습니다.',
 REMOTE_WEB_ASSETS_UNAVAILABLE:'브라우저 화면 파일을 불러오지 못했습니다.',
 IDENTITY_UNAVAILABLE:'이 컴퓨터의 보안 신원을 사용할 수 없습니다.',
 IDENTITY_NOT_INITIALIZED:'먼저 이 컴퓨터의 신원을 설정하십시오.',
 IDENTITY_LOST:'기존에 저장한 컴퓨터 신원을 확인하지 못했습니다.',
 IDENTITY_PENDING:'이전 신원 설정 결과가 확인되지 않았습니다. 다시 만들지 마십시오.',
 CERTIFICATE_REISSUE_REQUIRED:'주소 또는 유효기간에 맞게 인증서를 다시 발급하십시오.',
 INVALID_REMOTE_ADDRESS:'이 컴퓨터에서 사용할 IPv4 주소를 선택하십시오.',
 STALE_IDENTITY_REQUEST:'신원 설정 상태가 바뀌었습니다. 상태를 새로고침하십시오.',
 ACCESS_DENIED:'이 창에서 요청한 원격 관리 작업을 할 수 없습니다.'
});
function failureMessage(value){let code;try{code=value?.code}catch{}return t(typeof code==='string'&&Object.hasOwn(ERROR_TEXT,code)?ERROR_TEXT[code]:'요청을 완료하지 못했습니다. 상태를 다시 불러온 뒤 확인하십시오.');}
const fields=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&
 [Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).length===keys.length&&
 keys.every(key=>Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)||{},'value'));
const text=(value,max)=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
const iso=value=>typeof value==='string'&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString()===value;
const nullableCode=value=>value===null||typeof value==='string'&&FIXED_CODE.test(value);
const ipv4=value=>typeof value==='string'&&/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(value)&&
 value.split('.').every(part=>Number(part)<=255)&&value!=='0.0.0.0'&&value!=='255.255.255.255'&&Number(value.split('.')[0])<224;
const endpoint=value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&
 ipv4(url.hostname)&&url.pathname==='/'&&!url.search&&!url.hash&&url.href===value}catch{return false}};
const DIAGNOSTIC_CODES=Object.freeze(["UNKNOWN", "IDENTITY_UNAVAILABLE", "IDENTITY_NOT_INITIALIZED", "IDENTITY_LOST", "IDENTITY_PENDING", "CERTIFICATE_REISSUE_REQUIRED", "INVALID_REMOTE_ADDRESS", "STALE_IDENTITY_REQUEST", "ACCOUNT_IMMUTABLE", "ACCOUNT_REFUSED", "ARGUMENTS_REFUSED", "ATTRIBUTES_REFUSED", "BUFFER_REFUSED", "CF_RELEASE_FAILED", "CLASS_MISMATCH", "CREATE_READBACK_MISMATCH", "CREATOR_ACCESS_FAILED", "CREATOR_APPLICATION_FAILED", "CREATOR_LIST_REFUSED", "DEFAULT_KEYCHAIN_FAILED", "DEFAULT_LOCKED", "DEFAULT_STATUS_FAILED", "DETACHED_BUFFER_REFUSED", "DIGEST_FAILED", "DIGEST_MISMATCH", "FINAL_DEFAULT_FAILED", "ITEM_CREATE_FAILED", "ITEM_DELETE_FAILED", "ITEM_KEYCHAIN_FAILED", "ITEM_READ_FAILED", "NAPI_FAILURE", "NATIVE_EXCEPTION", "NATIVE_SHAPE_REFUSED", "NO_UI_GET_FAILED", "NO_UI_NOT_ENFORCED", "NO_UI_SET_FAILED", "NO_UI_VERIFY_FAILED", "OWNER_CONTEXT_REFUSED", "OWN_CREATE_CLEANUP_FAILED", "PAYLOAD_SIZE_REFUSED", "PROVIDER_BUSY", "PROVIDER_CLOSED", "PROVIDER_FAILED", "PROVIDER_NOT_READY", "READ_FREE_FAILED", "REFERENCE_CREATE_FAILED", "REFERENCE_RESOLVE_FAILED", "REFERENCE_SIZE_REFUSED", "SHARED_BUFFER_REFUSED", "TARGET_CHANGED", "TARGET_MISMATCH"]);
const DIAGNOSTIC_OS_STATUSES=Object.freeze([-50, -128, -25291, -25293, -25294, -25295, -25299, -25300, -25307, -25308, -25315, -34018, -67068, -67062, -67054, -67050, -67034, -67022]);
export function identityDiagnosticValid(value){
 return fields(value,['version','source','stage','code','osStatus','mayRemain','cleanup'])&&value.version===1&&
 ["live-operation", "retained-intent", "legacy-intent"].includes(value.source)&&["unknown", "backend-preflight", "certificate-generation", "write-intent", "create-protected-item", "verify-protected-item", "publish-index", "publish-certificate", "commit-intent"].includes(value.stage)&&
 DIAGNOSTIC_CODES.includes(value.code)&&(value.osStatus===null||DIAGNOSTIC_OS_STATUSES.includes(value.osStatus))&&
 [true,false,null].includes(value.mayRemain)&&["unknown", "not-needed", "not-attempted", "confirmed", "unconfirmed"].includes(value.cleanup)&&
 (value.source!=='retained-intent'||['create-protected-item','verify-protected-item','publish-index','publish-certificate','commit-intent'].includes(value.stage))&&
 (value.cleanup!=='confirmed'||value.mayRemain===false)&&(value.cleanup!=='unconfirmed'||value.mayRemain===true)&&
 (value.source!=='legacy-intent'||value.stage==='unknown'&&value.code==='UNKNOWN'&&value.osStatus===null&&value.mayRemain===null&&value.cleanup==='unknown');
}
export const identityValid=value=>fields(value,['status','backend','identity','errorCode',...(value&&Object.hasOwn(value,'diagnostic')?['diagnostic']:[])])&&
 (!Object.hasOwn(value,'diagnostic')||value.status!=='ready'&&value.errorCode!==null&&identityDiagnosticValid(value.diagnostic))&&
 ['not_initialized','ready','unavailable','identity_lost','pending'].includes(value.status)&&
 ['macos-default-file-keychain','electron-safe-storage','unsupported'].includes(value.backend)&&nullableCode(value.errorCode)&&
 (value.identity===null||fields(value.identity,['deviceId','address','keyFingerprint','certificateFingerprint','validUntil'])&&
 typeof value.identity.deviceId==='string'&&ID.test(value.identity.deviceId)&&ipv4(value.identity.address)&&/^[0-9a-f]{64}$/.test(value.identity.keyFingerprint)&&
 /^[0-9a-f]{64}$/.test(value.identity.certificateFingerprint)&&iso(value.identity.validUntil))&&
 (value.status!=='ready'||value.identity!==null&&value.errorCode===null);
function stateValid(value){
 if(!fields(value,['generation','managementAllowed','identity','web','app','pending','connections'])||
 !Number.isSafeInteger(value.generation)||value.generation<1||typeof value.managementAllowed!=='boolean'||!identityValid(value.identity)||
 !fields(value.web,['enabled','state','endpoint','errorCode','bindAddress','port'])||typeof value.web.enabled!=='boolean'||
 !['disabled','listening','unavailable','closing'].includes(value.web.state)||
 !(value.web.endpoint===null||endpoint(value.web.endpoint))||!nullableCode(value.web.errorCode)||
 !(value.web.bindAddress===''||ipv4(value.web.bindAddress))||!Number.isSafeInteger(value.web.port)||value.web.port<1||value.web.port>65535||
 !fields(value.app,['enabled','state','endpoint','bindAddress','port','errorCode','sessions'])||typeof value.app.enabled!=='boolean'||
 !['disabled','listening','closing','unavailable'].includes(value.app.state)||!(value.app.endpoint===null||endpoint(value.app.endpoint))||
 !(value.app.bindAddress===''||ipv4(value.app.bindAddress))||!Number.isInteger(value.app.port)||value.app.port<1||value.app.port>65535||
 !nullableCode(value.app.errorCode)||!Array.isArray(value.app.sessions)||value.app.sessions.length>16||
 !Array.isArray(value.pending)||value.pending.length>8||!Array.isArray(value.connections)||value.connections.length>16)return false;
 const pending=new Set(),connections=new Set();
 for(const row of value.pending){if(!fields(row,['pendingId','clientName','expiresAt'])||!ID.test(row.pendingId)||pending.has(row.pendingId)||
 !text(row.clientName,80)||!row.clientName.trim()||!iso(row.expiresAt))return false;pending.add(row.pendingId)}
 for(const row of value.connections){if(!fields(row,['connectionId','principalId','clientName','projectIds','expiresAt'])||
 !ID.test(row.connectionId)||connections.has(row.connectionId)||!ID.test(row.principalId)||!text(row.clientName,80)||!row.clientName.trim()||
 !Array.isArray(row.projectIds)||row.projectIds.length>1000||row.projectIds.some(id=>typeof id!=='string'||!ID.test(id))||
 new Set(row.projectIds).size!==row.projectIds.length||!iso(row.expiresAt))return false;connections.add(row.connectionId)}
 for(const row of value.app.sessions){if(!fields(row,['id','label','address','state','expiresAt','grants'])||!ID.test(row.id)||
  !text(row.label,120)||!text(row.address,100)||!['pending','approved'].includes(row.state)||!Number.isSafeInteger(row.expiresAt)||
  !Array.isArray(row.grants)||row.grants.length>1000||row.grants.some(grant=>!fields(grant,['projectId','read','write','execute'])||!ID.test(grant.projectId)||grant.read!==true||typeof grant.write!=='boolean'||typeof grant.execute!=='boolean'))return false;}
 return true;
}
const unavailable=()=>new Error(t('원격 관리 상태를 확인하지 못했습니다. 다시 불러오십시오.'));
const statusLabel=value=>({not_initialized:t('아직 설정하지 않았습니다.'),ready:t('이 컴퓨터의 신원을 확인했습니다.'),
 unavailable:t('이 컴퓨터에서 보안 저장소를 사용할 수 없습니다.'),identity_lost:t('저장한 신원을 확인하지 못했습니다.'),
 pending:t('이전 설정 결과를 확인해야 합니다.')})[value]||t('상태를 확인하지 못했습니다.');

export function IdentityDiagnosticNotice({identity}){
 const diagnostic=identity?.diagnostic;
 if(!identityDiagnosticValid(diagnostic))return null;
 const unknown=diagnostic.source==='legacy-intent'||diagnostic.stage==='unknown'||diagnostic.code==='UNKNOWN';
 const readDenied=diagnostic.source==='live-operation'&&diagnostic.stage==='verify-protected-item'&&diagnostic.code==='ITEM_READ_FAILED'&&diagnostic.osStatus===-25293;
 const message=unknown?'이전 등록의 실패 원인과 보호된 신원 항목의 상태를 확인할 수 없습니다. 기존 기록을 보존하고 새 신원을 만들지 마십시오.':readDenied?'운영체제가 저장된 보호 신원의 읽기를 거부했습니다. 기존 신원과 프로필을 보존하고 앱의 접근 권한과 서명 상태를 확인하십시오.':diagnostic.code==='DEFAULT_LOCKED'?'작업 당시 기본 Keychain 잠금이 확인되었습니다. 현재 잠금 상태를 확인하고, 잠겨 있으면 macOS의 키체인 접근에서 잠금 해제한 뒤 상태를 새로고침하십시오.':'보안 저장소 작업을 완료하지 못했습니다. 아래 실패 단계와 OSStatus를 확인하십시오.';
 const stages={'unknown':'단계 확인 불가','backend-preflight':'보안 저장소 사전 확인','certificate-generation':'인증서 준비','write-intent':'등록 시작 기록 저장','create-protected-item':'보호된 신원 저장','verify-protected-item':'저장한 신원 확인','publish-index':'신원 참조 저장','publish-certificate':'인증서 저장','commit-intent':'등록 완료 기록'};
 const cleanup={'unknown':'정리 결과 확인 불가','not-needed':'정리 대상 없음','not-attempted':'정리 미실행','confirmed':'정리 확인됨','unconfirmed':'정리 결과 미확인'};
 const h=React.createElement;
 return h('section',{className:'muted',role:'note','aria-label':t('신원 설정 진단')},
  h('p',null,t(message)),
  readDenied&&h('p',null,t('이 진단만으로 접근 권한이나 앱 서명 문제를 원인으로 확정할 수 없습니다. 신원을 삭제하거나 교체하거나 새로 등록하지 마십시오.')),
  diagnostic.source==='retained-intent'&&h('p',null,t("이 진단은 보존한 등록 시도의 기록입니다. 현재 보안 저장소 상태를 새로 검사한 결과가 아닙니다.")),
  identity.status==='pending'&&h('p',null,t('미완료 등록 기록은 보존됩니다. 상태 새로고침은 등록을 다시 실행하거나 기록을 삭제하지 않습니다.')),
  diagnostic.mayRemain===true&&h('p',null,t('보호된 신원 항목이 남아 있을 수 있습니다.')),
  h('dl',null,h('dt',null,t('실패 단계')),h('dd',null,t(stages[diagnostic.stage])),h('dt',null,'OSStatus'),h('dd',null,diagnostic.osStatus===null?t('확인 불가'):String(diagnostic.osStatus)),h('dt',null,t('정리 상태')),h('dd',null,t(cleanup[diagnostic.cleanup]))));
}
export function identitySetupBlocked(state,disabled=false){
 return disabled||['pending','identity_lost'].includes(state?.identity.status)||
 !(['not_initialized','ready'].includes(state?.identity.status)||state?.identity.errorCode==='CERTIFICATE_REISSUE_REQUIRED')||
 state?.web.enabled||state?.app.enabled||state?.web.state==='closing'||state?.app.state==='closing'||state?.web.errorCode==='WEB_DRAIN_UNCONFIRMED';
}

export default function RemoteManagementSettings({invoke,projects=[],active=true}){
 useLocale();
 const [state,setState]=useState(null),[fresh,setFresh]=useState(false),[busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [address,setAddress]=useState(''),[bindAddress,setBindAddress]=useState(''),[port,setPort]=useState('9443');
 const [appAddress,setAppAddress]=useState(''),[appPort,setAppPort]=useState('9444'),[appInvitation,setAppInvitation]=useState(null),[appGrants,setAppGrants]=useState({});
 const [invitation,setInvitation]=useState(null),[selections,setSelections]=useState({});
 const alive=useRef(false),visible=useRef(false),serial=useRef(0),pending=useRef(null),current=useRef(null),refreshQueued=useRef(false),refreshRef=useRef(null);
 const apply=value=>{
  if(!stateValid(value))throw unavailable();
  if(current.current&&value.generation<current.current.generation)throw unavailable();
  const previous=current.current;current.current=value;setState(value);setFresh(true);
  setAddress(input=>!previous||input===(previous.identity.identity?.address||'')?value.identity.identity?.address||input:input);
  setBindAddress(input=>value.web.enabled||!previous||input===(previous.web.bindAddress||previous.identity.identity?.address||'')?
   value.web.bindAddress||value.identity.identity?.address||'':input);
  setPort(input=>value.web.enabled||!previous||input===String(previous.web.port)?String(value.web.port):input);
  setAppAddress(input=>value.app.enabled||!previous||input===(previous.app.bindAddress||previous.identity.identity?.address||'')?value.app.bindAddress||value.identity.identity?.address||'':input);
  setAppPort(input=>value.app.enabled||!previous||input===String(previous.app.port)?String(value.app.port):input);
  setInvitation(previous=>previous&&previous.generation===value.generation&&value.web.state==='listening'?previous:null);
  setSelections(previous=>Object.fromEntries(value.pending.map(row=>[row.pendingId,previous[row.pendingId]||[]])));
  return value;
 };
 const perform=async(name,payload={},kind='state')=>{
  if(!alive.current||!visible.current||pending.current)return;
  const original=++serial.current,owner={};pending.current=owner;setBusy(name);setFresh(false);setError('');if(name!=='state')setNotice('');
  if(name!=='state')setInvitation(null);
  try{
   const value=await invoke(`remoteManagement.${name}`,payload);
   if(!alive.current||!visible.current||original!==serial.current)return;
   if(kind==='state')apply(value);
   else if(kind==='invite'){
    if(!fields(value,['generation','invitationId','secret','expiresAt','endpoint'])||!Number.isSafeInteger(value.generation)||value.generation<1||
    !UUID.test(value.invitationId)||typeof value.secret!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.secret)||!iso(value.expiresAt)||!endpoint(value.endpoint))throw unavailable();
    setInvitation(value);refreshQueued.current=true;
   }else if(kind==='appInvite'){
    if(!fields(value,['generation','invitation','expiresAt','endpoint'])||typeof value.invitation!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.invitation)||!Number.isSafeInteger(value.expiresAt)||!endpoint(value.endpoint))throw unavailable();
    setAppInvitation(value);refreshQueued.current=true;
   }else{
    if(!fields(value,['cancelled','fingerprint'])||typeof value.cancelled!=='boolean'||
    !(value.fingerprint===null||typeof value.fingerprint==='string'&&/^[0-9a-f]{64}$/.test(value.fingerprint)))throw unavailable();
    if(!value.cancelled)setNotice(t('공개 인증서를 저장했습니다. 연결할 기기에서 지문을 확인한 뒤 직접 신뢰하십시오.'));
    refreshQueued.current=true;
   }
  }catch(cause){
   if(alive.current&&visible.current&&original===serial.current){setInvitation(null);setError(failureMessage(cause));}
  }finally{
   if(pending.current===owner){pending.current=null;if(alive.current){setBusy('');if(visible.current&&refreshQueued.current){refreshQueued.current=false;refreshRef.current?.();}}}
  }
 };
 refreshRef.current=()=>perform('state');
 useEffect(()=>{
  alive.current=true;visible.current=active;serial.current++;
  if(active){if(pending.current)refreshQueued.current=true;else refreshRef.current?.();}
  else{setFresh(false);setInvitation(null);setSelections({});}
  return()=>{visible.current=false;alive.current=false;serial.current++;};
 },[active,invoke]);
 useEffect(()=>{if(!active)return;const timer=setInterval(()=>{if(!document.hidden)refreshRef.current?.()},5000);return()=>clearInterval(timer)},[active]);
 useEffect(()=>{
  if(!invitation)return;
  const remaining=Date.parse(invitation.expiresAt)-Date.now();
  if(remaining<=0){setInvitation(null);return;}
  const timer=setTimeout(()=>setInvitation(null),remaining);return()=>clearTimeout(timer);
 },[invitation]);
 useEffect(()=>{if(!appInvitation)return;const remaining=appInvitation.expiresAt-Date.now();if(remaining<=0){setAppInvitation(null);return;}const timer=setTimeout(()=>setAppInvitation(null),remaining);return()=>clearTimeout(timer)},[appInvitation]);
 const command=(name,payload={},kind='state')=>{
  const original=current.current;
  if(!fresh||!original?.managementAllowed||pending.current)return;
  return perform(name,{expectedGeneration:original.generation,...payload},kind);
 };
 const initialize=event=>{event.preventDefault();if(!ipv4(address)){setError(t('이 컴퓨터의 IPv4 주소를 입력하십시오.'));return;}command('initializeIdentity',{address});};
 const configure=enabled=>{
  if(!enabled){
   const original=current.current?.web;
   if(!original||!ipv4(original.bindAddress)){setError(t('연결 상태를 다시 불러온 뒤 확인하십시오.'));return;}
   command('configureWeb',{bindAddress:original.bindAddress,port:original.port,enabled:false});return;
  }
  if(!ipv4(bindAddress)||!/^\d{1,5}$/.test(port)||Number(port)<1||Number(port)>65535){setError(t('IPv4 주소와 1~65535 사이의 포트를 입력하십시오.'));return;}
  command('configureWeb',{bindAddress,port:Number(port),enabled});
 };
 const configureApp=enabled=>{
  const currentApp=current.current?.app,selectedAddress=enabled?appAddress:currentApp?.bindAddress,selectedPort=enabled?Number(appPort):currentApp?.port;
  if(!ipv4(selectedAddress)||!Number.isInteger(selectedPort)||selectedPort<1||selectedPort>65535){setError(t('IPv4 주소와 1~65535 사이의 포트를 입력하십시오.'));return;}
  setAppInvitation(null);command('configureApp',{bindAddress:selectedAddress,port:selectedPort,enabled});
 };
 if(!active)return null;
 const allowed=state?.managementAllowed===true&&fresh,disabled=!allowed||Boolean(busy),ready=state?.identity.status==='ready',identity=state?.identity.identity;
 const initializeDisabled=identitySetupBlocked(state,disabled);
 const projectOptions=projects.filter(row=>row&&typeof row.id==='string'&&ID.test(row.id)&&typeof row.name==='string');
 return <div className="remote-management-settings">
  <section className="settings-panel" aria-label={t('원격 관리')}>
   <PageHeader variant="section" headingLevel={2} title={t('원격 관리')} actions={<button className="button" type="button" disabled={Boolean(busy)} onClick={()=>perform('state')}>{busy==='state'?t('불러오는 중'):t('상태 새로고침')}</button>}/>
   <p>{t('다른 기기의 브라우저에서 승인한 프로젝트와 리뷰를 읽을 수 있습니다.')}</p>
   <p className="muted">{t('브라우저 조회와 ReviewOps 앱 제어를 각각 허용하고, 기기별 프로젝트 권한을 승인하십시오.')}</p>
   {state&&!state.managementAllowed&&<p role="status">{t('이 창에서는 원격 관리를 변경할 수 없습니다.')}</p>}
   {state&&!fresh&&!busy&&<p role="status">{t('이전 상태입니다. 상태를 새로고침한 뒤 변경하십시오.')}</p>}
   {error&&<p className="form-error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  </section>
  <section className="settings-panel" aria-label={t('이 컴퓨터 신원')}>
   <h2>{t('이 컴퓨터 신원')}</h2><p>{state?statusLabel(state.identity.status):t('상태를 불러오는 중입니다.')}</p>
   {state?.identity.errorCode&&<p className="form-error" role="alert">{failureMessage({code:state.identity.errorCode})}</p>}
   <IdentityDiagnosticNotice identity={state?.identity}/>
   {state?.identity.status==='unavailable'&&state.identity.backend!=='unsupported'&&<><p>{t('기존 신원을 다시 확인하면 저장된 보호 항목만 읽습니다. 신원·인증서·접속 정보는 새로 만들거나 삭제하지 않습니다. 운영체제 보안 저장소의 잠금과 이 앱의 해당 항목 접근 권한을 확인한 뒤 다시 시도하십시오.')}</p><button type="button" className="button" disabled={disabled||state?.web.enabled||state?.app.enabled} onClick={()=>command('retryExistingIdentity')}>{t('기존 신원 읽기 다시 시도')}</button></>}
   {identity&&<dl><dt>{t('기기 ID')}</dt><dd><code>{identity.deviceId}</code></dd><dt>{t('인증서 주소')}</dt><dd>{identity.address}</dd>
    <dt>{t('공개 키 지문 · SHA-256')}</dt><dd><code style={{overflowWrap:'anywhere'}}>{identity.keyFingerprint}</code></dd>
    <dt>{t('인증서 지문 · SHA-256')}</dt><dd><code style={{overflowWrap:'anywhere'}}>{identity.certificateFingerprint}</code></dd><dt>{t('인증서 만료')}</dt><dd>{identity.validUntil}</dd></dl>}
   <form onSubmit={initialize}><label className="field"><span>{t('인증서에 사용할 이 컴퓨터의 IPv4 주소')}</span><input value={address} onChange={event=>setAddress(event.target.value)} maxLength={15} disabled={initializeDisabled} placeholder="192.168.0.10" required/></label>
    <button type="submit" className="button primary" disabled={initializeDisabled}>{ready?t('같은 신원으로 인증서 다시 발급'):t('컴퓨터 신원 설정')}</button></form>
   {ready&&<p className="muted">{t('주소나 인증서 유효기간이 바뀌면 브라우저 연결을 끄고 인증서를 다시 발급하십시오. 기기 신원과 키를 유지하며, 연결할 브라우저에서 새 인증서를 다시 확인해야 합니다.')}</p>}
   <button type="button" className="button" disabled={disabled||!ready} onClick={()=>command('exportPublicCertificate',{},'export')}>{t('공개 인증서 저장')}</button>
   <p className="muted">{t('연결할 브라우저에서 저장한 인증서의 지문을 위 값과 비교한 뒤 직접 신뢰하십시오. 이 작업은 브라우저의 신뢰 설정을 자동으로 바꾸지 않습니다.')}</p>
  </section>
  <section className="settings-panel" aria-label={t('브라우저 읽기 연결')}>
   <h2>{t('브라우저 읽기 연결')}</h2><p role="status">{state?.web.state==='listening'?t('브라우저 연결을 받고 있습니다.'):state?.web.state==='closing'?t('연결을 종료하고 있습니다.'):t('브라우저 연결이 꺼져 있습니다.')}</p>
   {state?.web.errorCode&&<p className="form-error" role="alert">{failureMessage({code:state.web.errorCode})}</p>}
   {state?.web.endpoint&&<p><code>{state.web.endpoint}</code></p>}
   <div className="field-row"><label className="field"><span>{t('수신 IPv4 주소')}</span><input maxLength={15} value={bindAddress} onChange={event=>setBindAddress(event.target.value)} disabled={disabled||state?.web.enabled} placeholder={identity?.address||'192.168.0.10'}/></label>
    <label className="field"><span>{t('포트')}</span><input inputMode="numeric" maxLength={5} value={port} onChange={event=>setPort(event.target.value)} disabled={disabled||state?.web.enabled}/></label></div>
   <button type="button" className="button primary" disabled={disabled||!ready&&!state?.web.enabled||state?.web.state==='closing'} onClick={()=>configure(!state?.web.enabled)}>{state?.web.enabled?t('브라우저 연결 끄기'):t('브라우저 연결 켜기')}</button>
   <button type="button" className="button" disabled={disabled||state?.web.state!=='listening'} onClick={()=>command('inviteBrowser',{},'invite')}>{t('브라우저 초대 만들기')}</button>
   {invitation&&<div role="status"><p>{t('아래 초대 정보를 연결할 브라우저에 직접 입력하십시오. 주소에 비밀값을 넣지 마십시오.')}</p><dl>
    <dt>{t('연결 주소')}</dt><dd><code>{invitation.endpoint}</code></dd><dt>{t('초대 ID')}</dt><dd><code>{invitation.invitationId}</code></dd>
    <dt>{t('초대 비밀값')}</dt><dd><code style={{overflowWrap:'anywhere'}}>{invitation.secret}</code></dd><dt>{t('초대 만료')}</dt><dd>{invitation.expiresAt}</dd></dl>
    <button type="button" className="button" onClick={()=>setInvitation(null)}>{t('화면에서 초대 정보 숨기기')}</button></div>}
  </section>
  <section className="settings-panel" aria-label={t('브라우저 승인 대기')}>
   <h2>{t('브라우저 승인 대기')}</h2><p className="muted">{t('기기 이름은 브라우저가 입력한 표시 이름입니다. 연결하려는 기기인지 확인한 뒤 프로젝트를 선택하십시오.')}</p>
   {!state?.pending.length&&<p>{t('승인 대기 중인 브라우저가 없습니다. 상태를 새로고침하여 확인하십시오.')}</p>}
   {state?.pending.map(row=><fieldset key={row.pendingId} disabled={disabled}><legend>{row.clientName}</legend><p>{row.expiresAt}</p>
    {projectOptions.map(project=><label className="check-option" key={project.id}><input type="checkbox" checked={(selections[row.pendingId]||[]).includes(project.id)} onChange={event=>setSelections(previous=>({...previous,[row.pendingId]:event.target.checked?[...(previous[row.pendingId]||[]),project.id]:(previous[row.pendingId]||[]).filter(id=>id!==project.id)}))}/>{project.name}</label>)}
    <button type="button" className="button primary" disabled={!(selections[row.pendingId]||[]).length} onClick={()=>command('approveBrowser',{pendingId:row.pendingId,projectIds:[...(selections[row.pendingId]||[])]})}>{t('선택한 프로젝트 읽기 승인')}</button></fieldset>)}
  </section>
  <section className="settings-panel" aria-label={t('승인한 브라우저')}>
   <h2>{t('승인한 브라우저')}</h2>{!state?.connections.length&&<p>{t('승인한 브라우저가 없습니다.')}</p>}
   {state?.connections.map(row=><div key={row.connectionId}><h3>{row.clientName}</h3><p>{t('승인한 프로젝트: {0}',[row.projectIds.map(id=>projectOptions.find(project=>project.id===id)?.name||id).join(', ')])}</p><p>{t('만료: {0}',[row.expiresAt])}</p>
    <button type="button" className="button" disabled={disabled} onClick={()=>command('disconnect',{connectionId:row.connectionId})}>{t('이 연결 종료')}</button>
    <button type="button" className="button danger-text" disabled={disabled} onClick={()=>command('revoke',{principalId:row.principalId})}>{t('이 브라우저 승인 취소')}</button></div>)}
  </section>
  <section className="settings-panel" aria-label={t('ReviewOps 앱 원격 접속')}>
   <h2>{t('ReviewOps 앱 원격 접속')}</h2><p>{t('허용한 다른 ReviewOps 앱에서 이 컴퓨터의 자료를 읽고, 승인한 프로젝트의 리뷰를 작성하거나 에이전트 작업을 제어합니다.')}</p>
   <p role="status">{state?.app.state==='listening'?t('앱 원격 접속을 받고 있습니다.'):state?.app.state==='closing'?t('연결을 종료하고 있습니다.'):t('앱 원격 접속이 꺼져 있습니다.')}</p>
   {state?.app.errorCode&&<p role="alert" className="form-error">{failureMessage({code:state.app.errorCode})}</p>}
   {state?.app.endpoint&&<p><code>{state.app.endpoint}</code><button type="button" className="button" onClick={()=>invoke('clipboard.writeText',{text:state.app.endpoint}).then(()=>setNotice(t('접속 주소를 복사했습니다.'))).catch(cause=>setError(failureMessage(cause)))}>{t('주소 복사')}</button></p>}
   <div className="field-row"><label className="field"><span>{t('앱 수신 IPv4 주소')}</span><input value={appAddress} onChange={event=>setAppAddress(event.target.value)} maxLength={15} disabled={disabled||state?.app.enabled} placeholder={identity?.address||'192.168.0.10'}/></label>
    <label className="field"><span>{t('앱 접속 포트')}</span><input value={appPort} onChange={event=>setAppPort(event.target.value)} inputMode="numeric" maxLength={5} disabled={disabled||state?.app.enabled}/></label></div>
   <button type="button" className="button primary" disabled={disabled||!ready&&!state?.app.enabled||state?.app.state==='closing'} onClick={()=>configureApp(!state?.app.enabled)}>{state?.app.enabled?t('앱 접속 끄기'):t('앱 접속 켜기')}</button>
   <button type="button" className="button" disabled={disabled||state?.app.state!=='listening'} onClick={()=>command('inviteApp',{},'appInvite')}>{t('앱 초대 만들기')}</button>
   {appInvitation&&<div role="status"><p>{t('접속할 ReviewOps 앱에 주소와 초대 비밀값을 입력하고, 위 공개 인증서의 지문을 확인하십시오.')}</p><code className="remote-secret">{appInvitation.invitation}</code><p>{t('만료: {0}',[new Date(appInvitation.expiresAt).toLocaleString()])}</p><button type="button" className="button" onClick={()=>setAppInvitation(null)}>{t('화면에서 초대 정보 숨기기')}</button></div>}
   <p className="muted">{t('다른 네트워크에서는 이 IP와 포트로 연결할 수 있도록 공유기와 방화벽을 설정해야 합니다. 잠자기·종료 중에는 접속할 수 없습니다.')}</p>
  </section>
  <section className="settings-panel" aria-label={t('앱 기기와 프로젝트 권한')}>
   <h2>{t('앱 기기와 프로젝트 권한')}</h2>{!state?.app.sessions.length&&<p>{t('접속한 앱 기기가 없습니다.')}</p>}
   {state?.app.sessions.map(row=><fieldset key={row.id} disabled={disabled}><legend>{row.label} · {row.state==='pending'?t('승인 대기'):t('승인됨')}</legend><p>{row.address} · {new Date(row.expiresAt).toLocaleString()}</p>
    {row.state==='pending'?<>
     {projectOptions.map(project=>{const grant=appGrants[row.id]?.[project.id];return <div className="remote-project-grant" key={project.id}><label><input type="checkbox" checked={Boolean(grant)} onChange={event=>setAppGrants(previous=>({...previous,[row.id]:{...previous[row.id],[project.id]:event.target.checked?{projectId:project.id,read:true,write:false,execute:false}:null}}))}/>{project.name}</label>
      {grant&&<><label><input type="checkbox" checked={grant.write} onChange={event=>setAppGrants(previous=>({...previous,[row.id]:{...previous[row.id],[project.id]:{...grant,write:event.target.checked}}}))}/>{t('리뷰 작성')}</label><label><input type="checkbox" checked={grant.execute} onChange={event=>setAppGrants(previous=>({...previous,[row.id]:{...previous[row.id],[project.id]:{...grant,execute:event.target.checked}}}))}/>{t('에이전트 실행·중지')}</label></>}</div>})}
     <button type="button" className="button primary" disabled={!Object.values(appGrants[row.id]||{}).some(Boolean)} onClick={()=>command('approveApp',{id:row.id,grants:Object.values(appGrants[row.id]||{}).filter(Boolean)})}>{t('선택한 권한 승인')}</button>
    </>:<ul>{row.grants.map(grant=><li key={grant.projectId}>{projectOptions.find(project=>project.id===grant.projectId)?.name||grant.projectId} · {t('조회')}{grant.write&&` · ${t('리뷰 작성')}`}{grant.execute&&` · ${t('에이전트 실행·중지')}`}</li>)}</ul>}
    <button type="button" className="button danger-text" onClick={()=>command('revokeApp',{id:row.id})}>{t('앱 승인 취소·연결 해제')}</button>
   </fieldset>)}
  </section>
  <RemoteAppConnections invoke={invoke} active={active}/>
 </div>;
}

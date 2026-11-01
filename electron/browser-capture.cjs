'use strict';

const captureBusy=()=>Object.assign(new Error('이 화면의 다른 캡처가 진행 중입니다. 잠시 후 다시 시도하십시오.'),{code:'CAPTURE_BUSY'});
const sourceGone=()=>Object.assign(new Error('원본 검사 화면이 종료되었습니다. 프로젝트에서 화면을 다시 선택하십시오.'),{code:'SESSION_GONE'});

// Own only this WebContents' capture lifetime. Native capture cannot be cancelled;
// a renderer exit settles the caller and makes any late native completion inert.
function createNativeCaptureLease(contents,{alive=()=>!contents.isCrashed?.()}={}) {
  let active=null,pendingRestore=null;
  const isAlive=()=>{try{return !contents.isDestroyed()&&alive();}catch{return false;}};

  function finish(lease,{value,error}) {
    if(active!==lease||lease.finished)return;
    lease.finished=true;
    let restoreError;
    if(lease.changed&&!contents.isDestroyed()) {
      try{contents.setBackgroundThrottling(lease.previous);}
      catch(failure){restoreError=failure;pendingRestore={previous:lease.previous};}
    }
    contents.removeListener('destroyed',lease.cancel);
    contents.removeListener('render-process-gone',lease.cancel);
    active=null;
    // Cleanup must not replace an original native rejection or synchronous error.
    if(error)lease.reject(error);
    else if(lease.invalidated||!isAlive())lease.reject(sourceGone());
    else if(restoreError)lease.reject(restoreError);
    else lease.resolve(value);
  }

  return {
    capture(capturePage) {
      if(active)return Promise.reject(captureBusy());
      if(!isAlive())return Promise.reject(sourceGone());
      // A crashed renderer can temporarily reject the restoration setter. Restore
      // that saved policy before allowing a recovered renderer to acquire a lease.
      if(pendingRestore) {
        try{contents.setBackgroundThrottling(pendingRestore.previous);pendingRestore=null;}
        catch(error){return Promise.reject(error);}
      }
      return new Promise((resolve,reject)=>{
        const lease={resolve,reject,finished:false,changed:false};
        lease.cancel=()=>{lease.invalidated=true;finish(lease,{error:sourceGone()});};
        active=lease;
        contents.on('destroyed',lease.cancel);
        contents.on('render-process-gone',lease.cancel);
        try {
          lease.previous=contents.getBackgroundThrottling();
          lease.changed=lease.previous===true;
          if(lease.changed)contents.setBackgroundThrottling(false);
          if(active!==lease||lease.finished)return;
          if(!isAlive()){finish(lease,{error:sourceGone()});return;}
          const native=capturePage();
          Promise.resolve(native).then(
            value=>finish(lease,isAlive()?{value}:{error:sourceGone()}),
            error=>finish(lease,{error})
          );
        }catch(error){finish(lease,{error});}
      });
    }
  };
}

module.exports={createNativeCaptureLease};

'use strict';

// Executed in the browser's isolated world. DOM references never leave that world.
function inspectBrowserElement(action = 'pick') {
  const key = '__reviewopsElementInspector';
  let state = window[key];
  if (!state) {
    const overlay = document.createElement('reviewops-element-highlight');
    for (const [name,value] of Object.entries({all:'initial',position:'fixed','pointer-events':'none','z-index':'2147483647','box-sizing':'border-box',border:'3px solid #f04b24',background:'rgba(240,75,36,.12)','box-shadow':'0 0 0 1px #fff,0 0 0 3px rgba(0,0,0,.5)',display:'none'})) overlay.style.setProperty(name,value,'important');
    overlay.setAttribute('aria-hidden','true');
    const label = document.createElement('span');
    label.style.cssText='all:initial;position:absolute;left:-3px;max-width:480px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:3px 7px;background:#a5260d;color:#fff;font:600 12px/18px system-ui;box-shadow:0 0 0 1px #fff;pointer-events:none';
    overlay.attachShadow({mode:'closed'}).appendChild(label);
    state = window[key] = {overlay,label,selected:null,hover:null,picking:null,frame:0};
  }
  const selector = element => {
    const pieces=[];let current=element;
    while(current?.tagName&&pieces.length<6){
      let piece=current.tagName.toLowerCase();
      if(current.id){pieces.unshift('#'+CSS.escape(current.id));break}
      const parent=current.parentElement;
      if(parent){const siblings=[...parent.children].filter(child=>child.tagName===current.tagName);if(siblings.length>1)piece+=':nth-of-type('+(siblings.indexOf(current)+1)+')'}
      pieces.unshift(piece);current=parent;
    }
    return pieces.join(' > ');
  };
  const describe = target => {
    const el=target.element,r=rectangle(target,false);
    const editable=el.isContentEditable||el.closest('[contenteditable]')||/^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(el.tagName)||el.querySelector('input,textarea,select,[contenteditable]');
    return {selector:selector(el),framePath:target.frames.map(selector),tag:el.tagName.toLowerCase(),id:el.id||'',classes:typeof el.className==='string'?el.className:'',text:editable?'':String(el.textContent||'').trim().slice(0,1000),rect:{x:r.left,y:r.top,width:Math.max(0,r.right-r.left),height:Math.max(0,r.bottom-r.top)},at:new Date().toISOString()};
  };
  const intersect = (rect,clip) => ({left:Math.max(rect.left,clip.left),top:Math.max(rect.top,clip.top),right:Math.min(rect.right,clip.right),bottom:Math.min(rect.bottom,clip.bottom)});
  const connected = target => {
    if(!target?.element.isConnected)return false;
    let owner=document;
    for(const frame of target.frames){if(!frame.isConnected||frame.ownerDocument!==owner)return false;try{owner=frame.contentDocument}catch{return false}}
    return target.element.ownerDocument===owner&&Boolean(owner?.defaultView);
  };
  function clipParents(rect,element) {
    const view=element.ownerDocument.defaultView;
    for(let parent=element.parentElement;parent;parent=parent.parentElement){
      const style=view.getComputedStyle(parent),clipX=/^(auto|scroll|hidden|clip)$/.test(style.overflowX),clipY=/^(auto|scroll|hidden|clip)$/.test(style.overflowY);
      if(!clipX&&!clipY)continue;
      const r=parent.getBoundingClientRect(),sx=r.width/(parent.offsetWidth||r.width||1),sy=r.height/(parent.offsetHeight||r.height||1),left=r.left+parent.clientLeft*sx,top=r.top+parent.clientTop*sy;
      rect=intersect(rect,{left:clipX?left:-Infinity,top:clipY?top:-Infinity,right:clipX?left+parent.clientWidth*sx:Infinity,bottom:clipY?top+parent.clientHeight*sy:Infinity});
    }
    return rect;
  }
  function rectangle(target,clip=true) {
    let r=target.element.getBoundingClientRect(),rect={left:r.left,top:r.top,right:r.right,bottom:r.bottom};
    if(clip)rect=clipParents(rect,target.element);
    for(const frame of [...target.frames].reverse()){
      r=frame.getBoundingClientRect();const sx=r.width/(frame.offsetWidth||r.width||1),sy=r.height/(frame.offsetHeight||r.height||1),left=r.left+frame.clientLeft*sx,top=r.top+frame.clientTop*sy;
      rect={left:left+rect.left*sx,top:top+rect.top*sy,right:left+rect.right*sx,bottom:top+rect.bottom*sy};
      if(clip)rect=clipParents(intersect(rect,{left,top,right:left+frame.clientWidth*sx,bottom:top+frame.clientHeight*sy}),frame);
    }
    return rect;
  }
  function draw() {
    state.frame=0;
    const target=state.hover||state.selected;
    if(!connected(target)){
      state.overlay.style.setProperty('display','none','important');return;
    }
    const view=target.element.ownerDocument.defaultView,style=view.getComputedStyle(target.element),rect=intersect(rectangle(target),{left:0,top:0,right:innerWidth,bottom:innerHeight});
    if(style.display==='none'||style.visibility==='hidden'||rect.right<=rect.left||rect.bottom<=rect.top)state.overlay.style.setProperty('display','none','important');
    else {
      if(!state.overlay.isConnected)document.documentElement.appendChild(state.overlay);
      for(const [name,value] of Object.entries({display:'block',left:rect.left+'px',top:rect.top+'px',width:rect.right-rect.left+'px',height:rect.bottom-rect.top+'px'}))if(state.overlay.style.getPropertyValue(name)!==value)state.overlay.style.setProperty(name,value,'important');
      state.label.textContent=selector(target.element);state.label.style.top=rect.top>=28?'-28px':'0';
    }
    state.frame=requestAnimationFrame(draw);
  }
  const update = () => {if(!state.frame)draw()};
  const cancelFrame = () => {cancelAnimationFrame(state.frame);state.frame=0};
  if(action==='clear'){
    state.picking?.(null);state.selected=null;state.hover=null;cancelFrame();state.overlay.remove();return null;
  }
  if(action==='show'){
    const target=state.selected;
    if(!connected(target))throw new Error('선택한 요소를 찾을 수 없습니다. 요소를 다시 지정하십시오.');
    for(const frame of target.frames)frame.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
    target.element.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
    update();return describe(target);
  }
  if(action!=='pick')return null;
  state.picking?.(null);
  return new Promise(resolve=>{
    const listeners=[],documents=new Set();let finished=false,timer;
    const clean=value=>{
      if(finished)return;finished=true;clearTimeout(timer);
      for(const [doc,event,listener]of listeners)doc.removeEventListener(event,listener,true);
      state.picking=null;state.hover=null;cancelFrame();update();resolve(value);
    };
    state.picking=clean;
    const watch=(doc,frames=[])=>{
      if(!doc||documents.has(doc))return;documents.add(doc);
      const elementFor=event=>{const element=event.composedPath?.()[0]||event.target;return element?.nodeType===1&&element!==state.overlay?element:null};
      const move=event=>{const element=elementFor(event);if(element){state.hover={element,frames};update()}};
      const click=event=>{
        const element=elementFor(event);if(!element)return;
        event.preventDefault();event.stopImmediatePropagation();state.selected={element,frames};clean(describe(state.selected));
      };
      const key=event=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();clean(null)}};
      for(const [event,listener]of [['pointermove',move],['click',click],['keydown',key]]){doc.addEventListener(event,listener,true);listeners.push([doc,event,listener])}
      for(const frame of doc.querySelectorAll('iframe,frame'))try{watch(frame.contentDocument,[...frames,frame])}catch{}
    };
    watch(document);timer=setTimeout(()=>clean(null),60000);
  });
}

module.exports = { inspectBrowserElement };

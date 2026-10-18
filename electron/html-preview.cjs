'use strict';
const crypto=require('node:crypto');
const pages=new Map();
const TTL=30*60*1000,MAX_PAGE=20*1024*1024,MAX_TOTAL=64*1024*1024;
const csp="sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https: http:; style-src 'unsafe-inline' https: http:; img-src data: blob: https: http:; font-src data: https: http:; connect-src https: http:; frame-src https: http: data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'";
function createHtmlPreview(content) {
  if(typeof content!=='string'||Buffer.byteLength(content)>MAX_PAGE)throw new Error('HTML 미리보기는 20 MB까지 지원합니다.');
  for(const [id,page]of pages)if(page.expires<Date.now())pages.delete(id);
  const bytes=Buffer.byteLength(content);
  while(pages.size&&(pages.size>=8||[...pages.values()].reduce((sum,page)=>sum+page.bytes,bytes)>MAX_TOTAL))pages.delete(pages.keys().next().value);
  const id=crypto.randomUUID();pages.set(id,{content,bytes,expires:Date.now()+TTL});return `reviewops://preview/${id}`;
}
function htmlPreviewResponse(value,method='GET') {
  let url;try{url=new URL(value)}catch{return null}
  if(url.protocol!=='reviewops:'||url.host!=='preview')return null;
  const headers={'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':csp,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
  if(method!=='GET')return new Response('허용하지 않는 요청입니다.',{status:405,headers});
  const page=pages.get(url.pathname.slice(1));
  if(!page||page.expires<Date.now()){pages.delete(url.pathname.slice(1));return new Response('미리보기를 다시 여십시오.',{status:404,headers})}
  return new Response(page.content,{headers});
}
module.exports={createHtmlPreview,htmlPreviewResponse};

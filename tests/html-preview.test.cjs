'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHtmlPreview,htmlPreviewResponse}=require('../electron/html-preview.cjs');
test('HTML preview uses a separate host and sandbox CSP without changing the app CSP',async()=>{
  const source='<h1>검사</h1><script>window.fixture=true</script>',url=createHtmlPreview(source),response=htmlPreviewResponse(url);
  assert.equal(new URL(url).host,'preview');assert.equal(response.status,200);assert.equal(await response.text(),source);
  assert.match(response.headers.get('Content-Security-Policy'),/sandbox allow-scripts/);assert.match(response.headers.get('Content-Security-Policy'),/script-src 'unsafe-inline'/);assert.ok(!response.headers.get('Content-Security-Policy').includes('allow-same-origin'));
  assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(htmlPreviewResponse('reviewops://app/index.html'),null);assert.equal(htmlPreviewResponse(url,'POST').status,405);
});
test('HTML preview URLs cannot select filesystem paths and old previews are bounded',()=>{
  const first=createHtmlPreview('old');for(let i=0;i<8;i++)createHtmlPreview(String(i));
  assert.equal(htmlPreviewResponse(first).status,404);assert.equal(htmlPreviewResponse('reviewops://preview/../../electron/main.cjs').status,404);assert.equal(htmlPreviewResponse('reviewops://preview/not-a-token').status,404);assert.throws(()=>createHtmlPreview(null),/20 MB/);
});

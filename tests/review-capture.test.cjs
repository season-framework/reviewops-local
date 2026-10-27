const test = require('node:test');
const assert = require('node:assert/strict');

test('document capture defaults to none and web capture has a separate preference', async () => {
  const {captureTargetKind, capturePreferenceKey, selectedCaptureMode} = await import('../src/review-capture.mjs');
  assert.equal(captureTargetKind('report.md', {source:'browser'}), 'file');
  assert.equal(captureTargetKind('', {source:'file'}), 'file');
  assert.equal(selectedCaptureMode({kind:'file'}), 'none');
  assert.equal(selectedCaptureMode({kind:'web'}), 'browser-partial');
  assert.equal(selectedCaptureMode({kind:'web', available:false}), 'none');
  assert.equal(selectedCaptureMode({kind:'file', savedMode:'auto'}), 'auto');
  assert.equal(selectedCaptureMode({kind:'web', savedMode:'none'}), 'none');
  assert.equal(selectedCaptureMode({kind:'web', savedMode:'invalid'}), 'browser-partial');
  assert.equal(selectedCaptureMode({kind:'file', draftMode:'none', savedMode:'auto'}), 'none');
  assert.notEqual(capturePreferenceKey('a','file'),capturePreferenceKey('a','web'));
  assert.notEqual(capturePreferenceKey('a','web'),capturePreferenceKey('b','web'));
});

test('capture identity tolerates URL normalization but rejects a different page or file',async()=>{
  const {captureTargetKey:key}=await import('../src/review-capture.mjs');
  assert.equal(key('s','web','','http://localhost:3000'),key('s','web','','http://localhost:3000/'));
  assert.notEqual(key('s','web','','http://localhost:3000/a'),key('s','web','','http://localhost:3000/b'));
  assert.equal(key('s','file','a.md','http://localhost:3000'),key('s','file','a.md',''));
  assert.notEqual(key('s','file','a.md',''),key('s','file','b.md',''));
});

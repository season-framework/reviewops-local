'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {createZip}=require('../electron/archive.cjs');

test('ZIP contains valid UTF8 names and exact text and binary contents',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-zip-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const archive=path.join(root,'review.zip'),content=Buffer.from([0,255,3,4,10]);
  const zip=createZip([{name:'작업 지시서.md',bytes:Buffer.from('# 요청\n한글 내용')},{name:'attachments/data.bin',bytes:content}]);
  fs.writeFileSync(archive,zip);execFileSync('unzip',['-t',archive]);
  assert.deepEqual(execFileSync('unzip',['-p',archive,'attachments/data.bin']),content);
  assert.equal(zip.readUInt32LE(0),0x04034b50);assert.equal(zip.readUInt16LE(6),0x800);assert.equal(zip.readUInt32LE(zip.length-22),0x06054b50);assert.equal(zip.readUInt16LE(zip.length-14),2);
});
test('ZIP refuses duplicate names, paths outside the archive and malformed bytes',()=>{
  for(const name of ['/tmp/file','C:/file','../file','a/../file','a\\file','a//file','a/./file','a\0file'])assert.throws(()=>createZip([{name,bytes:Buffer.from('x')}]),/이름/);
  assert.throws(()=>createZip([{name:'same',bytes:Buffer.alloc(0)},{name:'same',bytes:Buffer.alloc(0)}]),/이름/);
  assert.throws(()=>createZip([{name:'file',bytes:'text'}]),/형식/);assert.throws(()=>createZip([]),/목록/);
});

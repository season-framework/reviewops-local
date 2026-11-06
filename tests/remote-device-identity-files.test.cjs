'use strict';
// Real temporary-file fixtures only; never an application profile, addon or Keychain.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createPrivateIdentityFiles,identityAncestorPaths}=require('../electron/remote-device-identity-files.cjs');
const windows=process.platform==='win32',supported=windows||(typeof process.getuid==='function'&&Number.isInteger(fs.constants.O_NOFOLLOW));
function fixture(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-identity-SYNTHETIC-')));fs.chmodSync(root,0o700);let files;t.after(()=>{try{files?.close();}catch{}finally{fs.rmSync(root,{recursive:true,force:true});}});files=createPrivateIdentityFiles(root);files.open(true);return{root,dir:path.join(root,'remote-device-identity'),files};}
const pending=()=>({schema:1,operationId:crypto.randomUUID(),deviceId:crypto.randomUUID(),accountUUID:crypto.randomUUID(),keyFingerprint:'a'.repeat(64)});
test('Windows drive and UNC ancestors do not repeat the filesystem root',()=>{
 assert.deepEqual(identityAncestorPaths('C:\\Users\\Example\\AppData',path.win32),['C:\\Users','C:\\Users\\Example','C:\\Users\\Example\\AppData']);
 assert.deepEqual(identityAncestorPaths('\\\\host\\share\\Example\\Profile',path.win32),['\\\\host\\share\\Example','\\\\host\\share\\Example\\Profile']);
 assert.deepEqual(identityAncestorPaths('/Users/example/Profile',path.posix),['/Users','/Users/example','/Users/example/Profile']);
});
test('private directory and regular single-link snapshots use POSIX modes where supported',{skip:!supported},t=>{const f=fixture(t),s=f.files.write('pending.json',pending(),null,()=>{});if(!windows)assert.equal(fs.statSync(f.dir).mode&0o777,0o700);const stat=fs.statSync(path.join(f.dir,'pending.json'));if(!windows)assert.equal(stat.mode&0o777,0o600);assert.equal(stat.nlink,1);f.files.unchanged(s);s.bytes.fill(0);});
test('symlink final file is refused',{skip:!supported||windows},t=>{const f=fixture(t);fs.writeFileSync(path.join(f.root,'outside'),Buffer.from('{}'),{mode:0o600});fs.symlinkSync(path.join(f.root,'outside'),path.join(f.dir,'pending.json'));assert.throws(()=>f.files.read('pending.json'));});
test('hard-linked private file is refused',{skip:!supported},t=>{const f=fixture(t),p=path.join(f.dir,'pending.json');fs.writeFileSync(p,JSON.stringify(pending()),{mode:0o600});fs.linkSync(p,path.join(f.dir,'duplicate'));assert.throws(()=>f.files.read('pending.json'));});
test('oversized metadata and POSIX permissive files are refused',{skip:!supported},t=>{const f=fixture(t),p=path.join(f.dir,'pending.json');fs.writeFileSync(p,Buffer.alloc(1025),{mode:0o600});assert.throws(()=>f.files.read('pending.json'));if(!windows){fs.writeFileSync(p,JSON.stringify(pending()));fs.chmodSync(p,0o644);assert.throws(()=>f.files.read('pending.json'));}});
test('a ready directory can be reopened without stale process-lock or PID adoption',{skip:!supported},t=>{const f=fixture(t),other=createPrivateIdentityFiles(f.root);other.open(false);other.assertDirectory();other.close();assert.equal(fs.existsSync(path.join(f.dir,'.owner-lock')),false);});
test('private DER fields and unknown output names cannot enter metadata writer',{skip:!supported},t=>{const f=fixture(t);assert.throws(()=>f.files.write('pending.json',{...pending(),privateKeyDERbase64:'secret'},null,()=>{}));assert.throws(()=>f.files.write('private.key',pending(),null,()=>{}));assert.equal(fs.existsSync(path.join(f.dir,'private.key')),false);});
test('intent-bound diagnostic journal remains private and cannot persist provider text or arbitrary codes',{skip:!supported},t=>{
 const {captureIdentityDiagnostic,identityDiagnosticRecord}=require('../electron/remote-identity-diagnostics.cjs'),f=fixture(t);
 const intent=f.files.write('pending.json',pending(),null,()=>{}),before=Buffer.from(intent.bytes);
 const diagnostic=captureIdentityDiagnostic({stage:'create-protected-item',error:{code:'ITEM_CREATE_FAILED',osStatus:-25308,mayRemain:true},cleanup:'not-attempted'});
 const record=identityDiagnosticRecord(intent.bytes,diagnostic),written=f.files.write('diagnostic.json',record,null,()=>{});
 assert.deepEqual(JSON.parse(written.bytes),record);assert.ok(f.files.read('pending.json').bytes.equals(before));
 const stat=fs.statSync(path.join(f.dir,'diagnostic.json'));if(!windows)assert.equal(stat.mode&0o777,0o600);assert.equal(stat.nlink,1);
 assert.throws(()=>f.files.write('diagnostic.json',{...record,diagnostic:{...diagnostic,code:'Synthetic private provider detail'}},written,()=>{}));
 assert.ok(f.files.read('diagnostic.json').bytes.equals(written.bytes));intent.bytes.fill(0);written.bytes.fill(0);before.fill(0);
});
test('a replaced original directory fails the owner fence',{skip:!supported},t=>{const f=fixture(t);fs.renameSync(f.dir,f.dir+'-old');fs.mkdirSync(f.dir,{mode:0o700});assert.throws(()=>f.files.assertDirectory());});
test('Windows directory junction cannot replace the private profile',{skip:!windows},t=>{const f=fixture(t);fs.renameSync(f.dir,f.dir+'-old');fs.symlinkSync(f.dir+'-old',f.dir,'junction');assert.throws(()=>f.files.assertDirectory());});

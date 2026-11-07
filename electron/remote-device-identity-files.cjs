'use strict';
// Application-private metadata only. No private DER/PEM is accepted by this writer.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {copyIdentityDiagnostic}=require('./remote-identity-diagnostics.cjs');
const fields = Object.freeze({
  'pending.json': ['schema','operationId','deviceId','accountUUID','keyFingerprint'],
  'index.json': ['schema','deviceId','accountUUID','referenceBase64','payloadSHA256','keyFingerprint'],
  'certificate.json': ['schema','deviceId','address','keyFingerprint','certificateFingerprint','validUntil','certificatePEM'],
  'diagnostic.json':['schema','pendingSHA256','diagnostic']
});
const bounds = Object.freeze({'pending.json':1024,'index.json':8192,'certificate.json':24576,'diagnostic.json':1536});
const unavailable = () => { throw Object.assign(new Error('The remote identity is unavailable.'), {code:'IDENTITY_UNAVAILABLE'}); };
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const id = s => [s.dev,s.ino,s.uid,s.mode].join(':');
const fileId = s => [id(s),s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
function identityAncestorPaths(dataPath,pathImpl=path) {
  const filesystemRoot=pathImpl.parse(dataPath).root;
  let current=filesystemRoot;
  return dataPath.slice(filesystemRoot.length).split(pathImpl.sep).filter(Boolean).map(part=>{
    current=pathImpl.join(current,part);return current;
  });
}
function createPrivateIdentityFiles(dataPath) {
  const windows=process.platform==='win32';
  if (typeof dataPath !== 'string' || !path.isAbsolute(dataPath) || path.resolve(dataPath)!==dataPath || path.dirname(dataPath)===dataPath || /[\x00-\x1f\x7f]/.test(dataPath) || Buffer.byteLength(dataPath)>3500 || (!windows&&(typeof process.getuid!=='function' || !Number.isInteger(fs.constants.O_NOFOLLOW)))) unavailable();
  const uid=windows?null:BigInt(process.getuid()), root=path.join(dataPath,'remote-device-identity');
  const nofollow=fs.constants.O_NOFOLLOW||0, nonblock=fs.constants.O_NONBLOCK||0;
  // Windows inherits the actual Electron user's profile ACL; POSIX mode bits
  // are not an ACL assertion there. DPAPI ciphertext remains user protected.
  const privateDirectory=s=>s.isDirectory()&&!s.isSymbolicLink()&&(windows||(s.uid===uid&&(s.mode&0o7777n)===0o700n));
  let chain=null, directory=null, directoryFD, closed=false;
  function ancestors() {
    const rows=[];
    for (const current of identityAncestorPaths(dataPath)) {
      const s=fs.lstatSync(current,{bigint:true});
      if (!s.isDirectory() || s.isSymbolicLink() || (!windows&&((s.uid!==uid && s.uid!==0n) || ((s.mode&0o022n)!==0n && !(s.uid===0n && (s.mode&0o1000n)!==0n))))) unavailable();
      rows.push([current,id(s)]);
    }
    if (fs.realpathSync(dataPath)!==dataPath) unavailable();
    return rows;
  }
  function assertDirectory() {
    if(closed || !directory || (!windows&&directoryFD===undefined)) unavailable();
    for(const [p,expected]of chain) if(id(fs.lstatSync(p,{bigint:true}))!==expected) unavailable();
    const named=fs.lstatSync(root,{bigint:true});
    if(!privateDirectory(named) || id(named)!==directory || (!windows&&id(fs.fstatSync(directoryFD,{bigint:true}))!==directory)) unavailable();
  }
  function missing(name) { try { fs.lstatSync(path.join(root,name));return false; } catch(e) { if(e.code==='ENOENT')return true;throw e; } }
  function probe() { ancestors();try {const s=fs.lstatSync(root,{bigint:true});if(!privateDirectory(s))unavailable();return true;}catch(e){if(e.code==='ENOENT')return false;throw e;} }
  function open(enroll=false) {
    if(closed) unavailable();if(directory){assertDirectory();return;}
    const parent=ancestors();
    if(enroll)fs.mkdirSync(root,{mode:0o700}); // Exclusive: a concurrent/old directory is never adopted for first enrollment.
    const s=fs.lstatSync(root,{bigint:true});if(!privateDirectory(s))unavailable();
    if(!windows){directoryFD=fs.openSync(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|nofollow);
    if(id(fs.fstatSync(directoryFD,{bigint:true}))!==id(s)){fs.closeSync(directoryFD);directoryFD=undefined;unavailable();}}
    chain=parent;directory=id(s);
    try {
      assertDirectory();
      if(enroll&&!windows){const fd=fs.openSync(dataPath,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|nofollow);try{if(id(fs.fstatSync(fd,{bigint:true}))!==parent[parent.length-1][1])unavailable();fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
      assertDirectory();
    } catch(e) {if(directoryFD!==undefined){try{fs.closeSync(directoryFD);}catch{}directoryFD=undefined;}directory=null;throw e;}
  }
  function regular(s,max) { return s.isFile()&&!s.isSymbolicLink()&&(windows||(s.uid===uid&&(s.mode&0o7777n)===0o600n))&&s.nlink===1n&&s.size>=1n&&s.size<=BigInt(max); }
  function read(name) {
    if(!Object.hasOwn(fields,name))unavailable();assertDirectory();const filename=path.join(root,name);let fd,primary;
    try {
      let before;try{before=fs.lstatSync(filename,{bigint:true});}catch(e){if(e.code==='ENOENT'){assertDirectory();return null;}throw e;}
      if(!regular(before,bounds[name]))unavailable();
      fd=fs.openSync(filename,fs.constants.O_RDONLY|nofollow|nonblock);
      if(fileId(fs.fstatSync(fd,{bigint:true}))!==fileId(before))unavailable();
      const bytes=Buffer.alloc(bounds[name]+1);let offset=0;
      for(;;){const n=fs.readSync(fd,bytes,offset,bytes.length-offset,null);if(!n)break;offset+=n;if(offset>bounds[name])unavailable();}
      if(BigInt(offset)!==before.size||fileId(fs.fstatSync(fd,{bigint:true}))!==fileId(before)||fileId(fs.lstatSync(filename,{bigint:true}))!==fileId(before))unavailable();
      assertDirectory();return{name,bytes:bytes.subarray(0,offset),identity:fileId(before)};
    } catch(e){primary=e;throw e;}finally {if(fd!==undefined){try{fs.closeSync(fd);}catch(e){if(!primary)throw e;}}}
  }
  function unchanged(snapshot,name=snapshot?.name) {
    const now=read(name);
    try {if(snapshot ? !now||now.identity!==snapshot.identity||!now.bytes.equals(snapshot.bytes) : now!==null)unavailable();}
    finally {now?.bytes.fill(0);}
  }
  function encode(name,record) {
    if(!Object.hasOwn(fields,name)||!plain(record)||record.schema!==1||JSON.stringify(Object.keys(record).sort())!==JSON.stringify([...fields[name]].sort()))unavailable();
    if(name==='diagnostic.json'){if(typeof record.pendingSHA256!=='string'||!/^[a-f0-9]{64}$/.test(record.pendingSHA256))unavailable();copyIdentityDiagnostic(record.diagnostic);}
    const bytes=Buffer.from(JSON.stringify(record));if(bytes.length<1||bytes.length>bounds[name]||bytes.includes(Buffer.from('PRIVATE KEY')))unavailable();return bytes;
  }
  function write(name,record,expected,guard) {
    const bytes=encode(name,record), temporary='.write-'+crypto.randomUUID();let fd, temporaryId, attemptedUnlink=false,primary;
    const target=path.join(root,name), temp=path.join(root,temporary);
    try {
      guard();assertDirectory();unchanged(expected,name);
      fd=fs.openSync(temp,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_RDWR|nofollow,0o600);
      fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);const s=fs.fstatSync(fd,{bigint:true});
      if(!regular(s,bounds[name])||s.size!==BigInt(bytes.length))unavailable();temporaryId=id(s);
      guard();assertDirectory();unchanged(expected,name);
      if(expected)fs.renameSync(temp,target);
      else {fs.linkSync(temp,target);attemptedUnlink=true;fs.unlinkSync(temp);}
      temporaryId=null;if(!windows)fs.fsyncSync(directoryFD);assertDirectory();const observed=read(name);if(!observed||!observed.bytes.equals(bytes)){observed?.bytes.fill(0);unavailable();}return observed;
    } catch(e){primary=e;throw e;}finally {
      bytes.fill(0);let closeError;if(fd!==undefined){try{fs.closeSync(fd);}catch(e){closeError=e;}}
      if(temporaryId&&!attemptedUnlink){attemptedUnlink=true;try{const s=fs.lstatSync(temp,{bigint:true});if(id(s)===temporaryId)fs.unlinkSync(temp);}catch{}}
      if(closeError&&!primary)throw closeError;
    }
  }
  function remove(name,snapshot,guard) {guard();assertDirectory();unchanged(snapshot,name);fs.unlinkSync(path.join(root,name));if(!windows)fs.fsyncSync(directoryFD);assertDirectory();}
  function close() {
    if(closed)return;let failed=false;
    try {if(directory)assertDirectory();}
    catch {failed=true;}
    finally {closed=true;if(directoryFD!==undefined){try{fs.closeSync(directoryFD);}catch{failed=true;}directoryFD=undefined;}}
    if(failed)unavailable();
  }
  return Object.freeze({probe,open,read,unchanged,write,remove,close,assertDirectory});
}
module.exports={createPrivateIdentityFiles,identityAncestorPaths};

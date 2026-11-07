'use strict';
// Inert command outputs only: no compiler, codesign, certificate, vault or app execution.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {signingPlan,builderConfiguration,readEntitlements}=require('../scripts/mac-signing.cjs');
const {buildRemoteIdentity}=require('../scripts/build-remote-identity.cjs');
const {createBeforePack}=require('../scripts/before-pack.cjs');
const {createAfterSign}=require('../scripts/verify-remote-identity.cjs');
const base=require('../package.json').build,hash='A'.repeat(40),team='AB12CD34EF';
const env={REVIEWOPS_MAC_SIGNING:'developer-id',CSC_NAME:hash,REVIEWOPS_MAC_TEAM_ID:team};
const policy=fs.readFileSync(path.join(__dirname,'../build/entitlements.developer-id.plist'),'utf8');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t,{mode='developer-id'}={}){
 const project=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-signing-INERT-'));t.after(()=>fsp.rm(project,{recursive:true,force:true}));
 for(const directory of ['build','headers','electron/native'])fs.mkdirSync(path.join(project,directory),{recursive:true});
 fs.writeFileSync(path.join(project,'build/entitlements.developer-id.plist'),policy);fs.writeFileSync(path.join(project,'headers/node_api.h'),'fixture header');
 const selectedEnv=mode==='developer-id'?env:{},config=builderConfiguration(base,selectedEnv,project);
 const app=path.join(project,'packaged/ReviewOps.app'),resources=path.join(app,'Contents/Resources');
 const calls=[],state={memoReads:0,lookups:0,builds:0,displayTeam:team,actualEntitlements:policy,appLeafHash:hash,appleDeveloperID:true};
 const packager={projectDir:project,platformSpecificBuildOptions:config.mac,forceCodeSigning:config.forceCodeSigning||false,getResourcesDir:()=>resources,codeSigningInfo:{get value(){state.memoReads++;return Promise.resolve({keychainFile:path.join(project,'builder-owned.keychain')});}}};
 const context={electronPlatformName:'darwin',appOutDir:path.dirname(app),packager};
 function execute(file,args){calls.push({file,args:[...args]});
  if(file==='/usr/bin/xcrun'){fs.writeFileSync(args[args.indexOf('-o')+1],Buffer.from('COMPILED:'+args[args.indexOf('-arch')+1]));}
  else if(args.includes('--force')&&args.at(-1)!==app)fs.appendFileSync(args.at(-1),Buffer.from(':SIGNED:'+args[args.indexOf('--sign')+1]));
  if(args.includes('--verify')&&args.includes('--test-requirement')){const requirement=args[args.indexOf('--test-requirement')+1];assert.ok(requirement.includes('anchor apple generic'));assert.ok(requirement.includes('certificate 1[field.1.2.840.113635.100.6.2.6] exists'));assert.ok(requirement.includes('certificate leaf[field.1.2.840.113635.100.6.1.13] exists'));assert.ok(requirement.includes('certificate leaf = H\"'+hash+'\"'));if(!state.appleDeveloperID||args.at(-1)===app&&state.appLeafHash!==hash)throw new Error('Inert OS requirement verification denied this signer');}
  if(args.includes('--entitlements'))return {status:0,stdout:state.actualEntitlements,stderr:''};
  return {status:0,stdout:'',stderr:'CodeDirectory v=20500 size=100 flags=0x10000(runtime) hashes=1+1 location=embedded\nAuthority=Developer ID Application: Inert Fixture ('+state.displayTeam+')\nTeamIdentifier='+state.displayTeam+'\n'};
 }
 const hook=createBeforePack({env:selectedEnv,isSignAllowed:()=>true,findIdentity:async(type,qualifier,keychain)=>{state.lookups++;assert.equal(type,'Developer ID Application');assert.equal(qualifier,hash);assert.equal(keychain,path.join(project,'builder-owned.keychain'));return {hash,name:'Developer ID Application: Inert Fixture ('+team+')'};},build:({signing})=>{state.builds++;return buildRemoteIdentity({directory:path.join(project,'electron/native'),headers:path.join(project,'headers'),signing,execute});}});
 function copyNative(){fs.mkdirSync(path.join(resources,'app.asar.unpacked/electron'),{recursive:true});fs.cpSync(path.join(project,'electron/native'),path.join(resources,'app.asar.unpacked/electron/native'),{recursive:true});}
 return {project,config,context,packager,app,resources,calls,state,execute,hook,copyNative};
}
test('default configuration and native hooks preserve explicit ad-hoc behavior without credential resolution',async t=>{
 assert.deepEqual(builderConfiguration(base,{}),base);assert.equal(signingPlan({CSC_NAME:hash,CSC_LINK:'not-consumed-without-opt-in'}).mode,'adhoc');
 const f=fixture(t,{mode:'adhoc'});await f.hook(f.context);assert.equal(f.state.memoReads,0);assert.equal(f.state.lookups,0);
 const signs=f.calls.filter(c=>c.file==='/usr/bin/codesign');assert.equal(signs.length,2);for(const c of signs)assert.deepEqual(c.args.slice(0,-1),['--force','--sign','-']);
 f.copyNative();const before=f.calls.length;await createAfterSign({env:{},execute:f.execute})(f.context);assert.equal(f.calls.length,before);
});
test('opt-in resolves the builder-owned Keychain once and signs both addons before their final-byte manifest',async t=>{
 const f=fixture(t);await f.hook(f.context);assert.equal(f.state.memoReads,1);assert.equal(f.state.lookups,1);assert.equal(f.state.builds,1);
 const manifest=JSON.parse(fs.readFileSync(path.join(f.project,'electron/native/remote-identity-manifest.json'),'utf8'));
 for(const arch of ['arm64','x64']){const file=path.join(f.project,'electron/native',manifest.files[arch].file),bytes=fs.readFileSync(file);assert.match(bytes.toString(),/:SIGNED:AAAA/);assert.equal(manifest.files[arch].sha256,digest(bytes));}
 const signs=f.calls.filter(c=>c.args.includes('--force'));assert.equal(signs.length,2);for(const c of signs){assert.equal(c.args[c.args.indexOf('--sign')+1],hash);assert.equal(c.args[c.args.indexOf('--keychain')+1],path.join(f.project,'builder-owned.keychain'));assert.ok(c.args.includes('--timestamp'));assert.equal(c.args[c.args.indexOf('--options')+1],'runtime');}
 f.copyNative();await createAfterSign({env,execute:f.execute})(f.context);assert.ok(f.calls.some(c=>c.args.includes('--deep')&&c.args.at(-1)===f.app));assert.ok(f.calls.some(c=>c.args.includes('--entitlements')&&c.args.at(-1)===f.app));
});
test('the explicit builder config reaches actual test/stable packaging arguments without disabling configured signing',async()=>{
 const {buildNativePackage}=await import('../scripts/test-build.mjs');const {getConfig}=require('app-builder-lib/out/util/config/config');let calls=0;
 const input={...env,CSC_IDENTITY_AUTO_DISCOVERY:'true',CSC_LINK:'SYNTHETIC-P12-NOT-A-CREDENTIAL',CSC_KEY_PASSWORD:'SYNTHETIC-PASSWORD'};
 await buildNativePackage('darwin-x64','/absolute/inert-output',{env:input,execute:async(file,args,options)=>{
  calls++;assert.equal(file,process.execPath);assert.equal(args[args.indexOf('--config')+1],path.join(__dirname,'../scripts/electron-builder.config.cjs'));assert.equal(options.env.CSC_IDENTITY_AUTO_DISCOVERY,'true');assert.equal(options.env.CSC_LINK,input.CSC_LINK);assert.equal(options.env.CSC_KEY_PASSWORD,input.CSC_KEY_PASSWORD);assert.equal(options.env.REVIEWOPS_PACKAGE_OUTPUT,'/absolute/inert-output');assert.ok(!args.some(a=>a.startsWith('--config.directories')));
  const saved={};for(const [key,value]of Object.entries(options.env)){saved[key]=process.env[key];process.env[key]=value;}
  try{const resolved=await getConfig(path.join(__dirname,'..'),'scripts/electron-builder.config.cjs');assert.equal(resolved.mac.identity,hash);assert.equal(resolved.mac.type,'distribution');assert.equal(resolved.mac.hardenedRuntime,true);assert.equal(resolved.forceCodeSigning,true);assert.equal(resolved.directories.output,'/absolute/inert-output');assert.equal(resolved.mac.entitlements,resolved.mac.entitlementsInherit);assert.equal(resolved.mac.preAutoEntitlements,false);}
  finally{for(const [key,value]of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;}
 }});assert.equal(calls,1);
});
test('missing, malformed or ambiguous explicit selection cannot silently become ad-hoc',()=>{
 for(const values of [{REVIEWOPS_MAC_SIGNING:'typo'},{REVIEWOPS_MAC_SIGNING:'developer-id'},{...env,CSC_NAME:'Developer ID Application: Inert Fixture ('+team+')'},{...env,CSC_NAME:'-'},{...env,REVIEWOPS_MAC_TEAM_ID:'short'}])assert.throws(()=>builderConfiguration(base,values));
 const selected=builderConfiguration(base,env);assert.equal(selected.mac.identity,hash);assert.equal(selected.mac.hardenedRuntime,true);assert.equal(selected.forceCodeSigning,true);assert.deepEqual(base.mac.identity,'-');
});
test('missing, non-Apple, wrong certificate and wrong-team identities fail before compilation',async t=>{
 for(const identity of [null,{hash,name:'Unrelated Test Certificate'},{hash:'B'.repeat(40),name:'Developer ID Application: Inert Fixture ('+team+')'},{hash,name:'Developer ID Application: Inert Fixture (ZZ99ZZ99ZZ)'}]){
  const f=fixture(t);const hook=createBeforePack({env,isSignAllowed:()=>true,findIdentity:async()=>identity,build:()=>{f.state.builds++;}});await assert.rejects(hook(f.context));assert.equal(f.state.builds,0);
 }
});
test('builder signing policy refusal and credential import failure do not compile or expose secret errors',async t=>{
 const f=fixture(t);const denied=createBeforePack({env,isSignAllowed:()=>false,findIdentity:async()=>{throw new Error('must not resolve');},build:()=>{f.state.builds++;}});await assert.rejects(denied(f.context));assert.equal(f.state.memoReads,0);assert.equal(f.state.builds,0);
 const secret='INERT-SECRET-DO-NOT-LOG';f.packager.codeSigningInfo={get value(){return Promise.reject(new Error(secret));}};
 const failed=createBeforePack({env,isSignAllowed:()=>true,findIdentity:async()=>null,build:()=>{f.state.builds++;}});await assert.rejects(failed(f.context),error=>!error.message.includes(secret)&&error.message.includes('Developer ID'));assert.equal(f.state.builds,0);
});
test('overridden signing or entitlement policy is rejected before credential resolution',async t=>{
 for(const patch of [{identity:'-'},{hardenedRuntime:false},{type:'development'},{entitlementsInherit:'other.plist'},{requirements:'unreviewed-requirements'},{sign:()=>{}},{signIgnore:['.*']}]){
  const f=fixture(t);Object.assign(f.packager.platformSpecificBuildOptions,patch);await assert.rejects(f.hook(f.context));assert.equal(f.state.memoReads,0);assert.equal(f.state.builds,0);
 }
 const forbidden=policy.replace('</dict>','<key>com.apple.security.cs.disable-library-validation</key><true/></dict>');assert.throws(()=>readEntitlements(forbidden));
});
test('native signing failure publishes no new manifest and retains the previously accepted files',t=>{
 const f=fixture(t),directory=path.join(f.project,'electron/native');fs.writeFileSync(path.join(directory,'remote-identity-manifest.json'),'original-manifest');fs.writeFileSync(path.join(directory,'remote-identity-darwin-arm64.node'),'original-addon');
 assert.throws(()=>buildRemoteIdentity({directory,headers:path.join(f.project,'headers'),signing:{mode:'developer-id',identityHash:hash,teamId:team,keychain:null},execute:(file,args)=>{if(args.includes('--force'))throw new Error('inert signing denied');return f.execute(file,args);}}));
 assert.equal(fs.readFileSync(path.join(directory,'remote-identity-manifest.json'),'utf8'),'original-manifest');assert.equal(fs.readFileSync(path.join(directory,'remote-identity-darwin-arm64.node'),'utf8'),'original-addon');assert.equal(fs.readdirSync(directory).filter(name=>name.startsWith('.identity-build-')).length,0);
});
test('post-sign verification refuses changed addon bytes, wrong actual team or relaxed actual entitlements',async t=>{
 const f=fixture(t);await f.hook(f.context);f.copyNative();const target=path.join(f.resources,'app.asar.unpacked/electron/native/remote-identity-darwin-x64.node'),original=fs.readFileSync(target);fs.appendFileSync(target,'changed');await assert.rejects(createAfterSign({env,execute:f.execute})(f.context),/changed after manifest/);fs.writeFileSync(target,original);
 f.state.displayTeam='ZZ99ZZ99ZZ';await assert.rejects(createAfterSign({env,execute:f.execute})(f.context));f.state.displayTeam=team;
 f.state.actualEntitlements=policy.replace('</dict>','<key>com.apple.security.cs.disable-library-validation</key><true/></dict>');await assert.rejects(createAfterSign({env,execute:f.execute})(f.context));
});
test('nominal matching authority and team cannot bypass an incorrect actual app leaf or Apple class',async t=>{
 const f=fixture(t);await f.hook(f.context);f.copyNative();
 f.state.appLeafHash='B'.repeat(40);await assert.rejects(createAfterSign({env,execute:f.execute})(f.context),/OS requirement verification denied/);assert.equal(f.state.displayTeam,team);
 f.state.appLeafHash=hash;f.state.appleDeveloperID=false;await assert.rejects(createAfterSign({env,execute:f.execute})(f.context),/OS requirement verification denied/);
});
test('non-Mac packaging never invokes the native signing hook',async()=>{
 let calls=0;await createBeforePack({env,build:()=>{calls++;},findIdentity:async()=>{calls++;},isSignAllowed:()=>{calls++;}})({electronPlatformName:'win32'});await createAfterSign({env,execute:()=>{calls++;}})({electronPlatformName:'win32'});assert.equal(calls,0);
});

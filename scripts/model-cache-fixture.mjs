import fs from 'node:fs';
import path from 'node:path';

// Test-only CLI: model metadata is synthetic and no account or model turn runs.
export function isolatedModelRuntime({home,dataPath}){
 const bin=path.join(home,'.local/bin'),codexHome=path.join(home,'.codex'),runtime=path.join(dataPath,'codex-manager/runtime.json');
 for(const directory of [bin,codexHome,path.dirname(runtime)])fs.mkdirSync(directory,{recursive:true});
 const log=path.join(home,'model-fixture-calls.jsonl');
 const source=`#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');if(args[0]==='--version'){console.log('codex-cli 0.0.0');process.exit(0)}if(args[0]==='login'&&args[1]==='status')process.exit(1);if(args[0]!=='app-server')process.exit(77);let pending='';process.stdin.on('data',chunk=>{pending+=chunk;let end;while((end=pending.indexOf('\\n'))>=0){const text=pending.slice(0,end);pending=pending.slice(end+1);if(!text.trim())continue;const message=JSON.parse(text);if(message.id==null)continue;let result;if(message.method==='initialize')result={};else if(message.method==='config/read')result={config:{model:'fixture-model',model_reasoning_effort:'high'}};else if(message.method==='model/list')result={data:[{id:'fixture-model',model:'fixture-model',displayName:'Fixture model',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}],defaultReasoningEffort:'high'}],nextCursor:null};else process.exit(78);console.log(JSON.stringify({id:message.id,result}));}});\n`;
 fs.writeFileSync(path.join(bin,'codex'),source,{mode:0o755});
 // A failed explicit lookup does not search the user's installed CLI. The
 // collector then uses the bounded fixture command at the beginning of PATH.
 fs.writeFileSync(runtime,JSON.stringify({path:path.join(home,'no-user-runtime')}));
 return {HOME:home,CODEX_HOME:codexHome,PATH:bin+path.delimiter+(process.env.PATH||'')};
}

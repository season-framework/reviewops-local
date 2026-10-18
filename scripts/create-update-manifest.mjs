import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createReadStream} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {validateArchive}=require('../electron/update-archive.cjs');
const directory=path.resolve(process.argv[2]||'release');
const version=process.argv[3]||JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8')).version;
if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('Use a stable semantic version such as 1.2.0.');
const artifacts={};
for(const arch of ['arm64','x64']) {
 const name=`ReviewOps-${version}-${arch}.zip`,file=path.join(directory,name);
 let stat;try{stat=await fs.stat(file)}catch(error){if(error.code==='ENOENT')continue;throw error}
 await validateArchive(file);
 const hash=crypto.createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);
 const sha256=hash.digest('hex');
 artifacts[`darwin-${arch}`]={name,url:`https://github.com/season-framework/reviewops-local/releases/download/v${version}/${name}`,size:stat.size,sha256};
 await fs.writeFile(file+'.sha256',`${sha256}  ${name}\n`);
}
if(!Object.keys(artifacts).length)throw new Error('Build at least one ReviewOps update ZIP first.');
const manifest={schema:1,version,artifacts};
await fs.writeFile(path.join(directory,'reviewops-update.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(`Created update manifest for ${version}: ${Object.keys(artifacts).join(', ')}`);

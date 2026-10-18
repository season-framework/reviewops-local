'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {inside,readLocal} = require('./files.cjs');

function filePathVariants(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 16384 || /[\0\r\n\\]/.test(value)) throw new Error('파일 경로가 올바르지 않습니다.');
  let input = value.trim();
  if (input.startsWith('<') && input.endsWith('>')) input = input.slice(1,-1);
  let encoded = false;
  if (/^file:/i.test(input)) {
    let url;try {url = new URL(input);} catch {throw new Error('파일 주소가 올바르지 않습니다.');}
    if (url.hostname && url.hostname !== 'localhost') throw new Error('프로젝트에 연결한 폴더의 파일 경로를 선택하십시오.');
    input = url.pathname;encoded = true;
  } else if (/^sandbox:/i.test(input)) {
    input = input.replace(/^sandbox:/i,'').split(/[?#]/)[0];encoded = true;
  } else if (/^[a-z][a-z\d+.-]*:\/\//i.test(input) || /^(?:javascript|data|reviewops):/i.test(input)) throw new Error('파일 경로를 선택하십시오.');
  const decode = value => {try{return decodeURIComponent(value);}catch{return value;}};
  if (encoded) input = decode(input);
  const stripLocation = value => value.replace(/(?:#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?|:\d+(?::\d+)?(?:-\d+(?::\d+)?)?)$/i,'');
  const variants = encoded ? [input,stripLocation(input)] : [stripLocation(input),input];
  if (!encoded) variants.push(stripLocation(decode(input)),decode(input));
  // A literal # in a filename takes priority over a Markdown section fragment.
  for (const value of [...variants]) if (value.includes('#')) variants.push(value.slice(0,value.indexOf('#')));
  return [...new Set(variants)].filter(value=>value && !/[\0\r\n\\]/.test(value));
}

function agentFileCandidates(root, value, basePath, home = '') {
  if (typeof root !== 'string' || !path.posix.isAbsolute(root)) throw new Error('에이전트 작업 폴더를 설정하십시오.');
  const base = basePath ? filePathVariants(basePath)[0] : '';
  if (base && !path.posix.isAbsolute(base)) throw new Error('열린 문서의 경로가 올바르지 않습니다.');
  const candidates = [];
  for (let candidate of filePathVariants(value)) {
    if (home && candidate.startsWith('~/')) candidate = path.posix.join(home,candidate.slice(2));
    if (path.posix.isAbsolute(candidate) || candidate.startsWith('~/')) candidates.push(candidate);
    else {
      if (base) candidates.push(path.posix.resolve(path.posix.dirname(base),candidate));
      candidates.push(path.posix.resolve(root,candidate));
    }
  }
  return [...new Set(candidates)];
}

async function readAgentOutput(config, value, {raw=false,basePath,ssh} = {}) {
  const candidates = agentFileCandidates(config.rootPath,value,basePath,config.kind==='local'?os.homedir():'');
  const canonicalRoot = config.kind==='local'?await fs.realpath(config.rootPath):null;
  let missing;
  for (const candidate of candidates) {
    try {
      let file,absolutePath;
      if (config.kind === 'ssh') {
        file = await ssh.read(config,candidate,{raw,allowBinary:true});
        absolutePath = path.posix.resolve(config.rootPath,file.path);
      } else {
        absolutePath = await fs.realpath(candidate);
        if (!inside(canonicalRoot,absolutePath)) throw new Error('에이전트 작업 폴더 안의 파일만 열 수 있습니다.');
        file = await readLocal({...config,rootPath:canonicalRoot},path.relative(canonicalRoot,absolutePath),{raw});
      }
      return {...file,absolutePath};
    } catch(error) {
      if (error.code !== 'ENOENT' && error.code !== 2 && error.code !== 'SSH_FILE_NOT_FOUND') throw error;
      missing = error;
    }
  }
  const error = new Error(`파일을 찾을 수 없습니다. 파일이 이동되거나 삭제됐는지 확인하십시오. (${filePathVariants(value)[0]})`);
  error.code = 'AGENT_FILE_NOT_FOUND';error.cause = missing;
  throw error;
}
module.exports = {filePathVariants,agentFileCandidates,readAgentOutput};

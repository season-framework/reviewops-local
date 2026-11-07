'use strict';

const https = require('node:https');
const tls = require('node:tls');
const {isIP} = require('node:net');
const {X509Certificate, createHash} = require('node:crypto');
const {copyReadDTO} = require('./remote-web-listener.cjs');
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
function fail(code) { throw Object.assign(new Error('The remote app connection could not be completed.'), {code}); }
function attachmentReply(operation,payload,value){
  const record=(input,keys)=>{
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==keys.length||keys.some(key=>!Object.hasOwn(input,key)))fail('INVALID_RESPONSE');
    return input;
  };
  const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
  const integer=value=>Number.isSafeInteger(value)&&value>=0;
  function metadata(value){
    record(value,['id','reviewId','activityId','name','mimeType','size','sha256','createdAt']);
    if(!id(value.id)||!id(value.reviewId)||value.activityId!==null&&!id(value.activityId)||
      typeof value.name!=='string'||!value.name.trim()||value.name.length>255||/[/\\\x00-\x1f\x7f]/.test(value.name)||
      typeof value.mimeType!=='string'||value.mimeType.length>255||!integer(value.size)||value.size>10*1024*1024||
      typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256)||typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt)))fail('INVALID_RESPONSE');
    if(payload.reviewId&&value.reviewId!==payload.reviewId)fail('INVALID_RESPONSE');return value;
  }
  if(operation==='readChunk')return copyReadDTO('attachments.read',payload,value);
  if(operation==='describe'){metadata(value);if(value.id!==payload.attachmentId)fail('INVALID_RESPONSE');return value;}
  if(operation==='discardUpload'){record(value,['discarded']);if(typeof value.discarded!=='boolean')fail('INVALID_RESPONSE');return value;}
  if(operation==='beginUpload'&&value?.state==='uploading'){
    record(value,['version','state','uploadId','received','size','expiresAt']);
    if(value.version!==1||!id(value.uploadId)||!integer(value.received)||!integer(value.size)||value.received>value.size||value.size!==payload.size||!integer(value.expiresAt))fail('INVALID_RESPONSE');return value;
  }
  if(operation==='writeChunk'){
    record(value,['version','uploadId','received','size']);if(value.version!==1||value.uploadId!==payload.uploadId||!integer(value.received)||!integer(value.size)||value.received>value.size||value.size>10*1024*1024)fail('INVALID_RESPONSE');return value;
  }
  record(value,['version','state','uploadId','requestId','projectId','reviewId','attachment','revision']);
  if(value.version!==1||value.state!=='committed'||![value.uploadId,value.requestId,value.projectId,value.reviewId].every(id)||!Number.isSafeInteger(value.revision)||value.revision<1)fail('INVALID_RESPONSE');
  for(const key of ['uploadId','requestId','projectId','reviewId'])if(payload[key]!==undefined&&payload[key]!==value[key])fail('INVALID_RESPONSE');
  metadata(value.attachment);if(value.attachment.reviewId!==value.reviewId)fail('INVALID_RESPONSE');return value;
}

// Trust is scoped to one explicitly paired host and its exact certificate.
// No global CA store, TLS defaults, local path or SSH settings are modified.
function createRemoteAppClient({address, port, certificatePEM, certificateFingerprint,
  sessionToken: savedToken = '', onSessionToken = () => {}, requestAgent = false}) {
  if (isIP(address) !== 4 || !Number.isInteger(port) || port < 1 || port > 65535 ||
      typeof certificatePEM !== 'string' || certificatePEM.length > 32768 ||
      typeof certificateFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(certificateFingerprint) ||
      typeof savedToken !== 'string' || savedToken !== '' && !TOKEN.test(savedToken) || typeof onSessionToken !== 'function' ||
      requestAgent !== false && !(requestAgent instanceof https.Agent)) fail('INVALID_CONNECTION');
  let certificate;
  try { certificate = new X509Certificate(certificatePEM); } catch { fail('INVALID_CONNECTION'); }
  if (createHash('sha256').update(certificate.raw).digest('hex') !== certificateFingerprint ||
      certificate.checkIP(address) !== address || Date.parse(certificate.validTo) <= Date.now()) fail('INVALID_CONNECTION');
  let sessionToken = savedToken, closed = false, drain;
  const active = new Set();
  function request(route, value, authenticated = true) {
    if (closed) return Promise.reject(Object.assign(new Error('The remote connection is closed.'), {code: 'CONNECTION_CLOSED'}));
    if (authenticated && !sessionToken) return Promise.reject(Object.assign(new Error('Remote app authentication is required.'), {code: 'AUTH_REQUIRED'}));
    let body;
    try { body = JSON.stringify(value); } catch { fail('INVALID_REQUEST'); }
    if (typeof body !== 'string' || Buffer.byteLength(body) > 256 * 1024) fail('INVALID_REQUEST');
    return new Promise((resolve, reject) => {
      const connection = https.request({hostname: address, port, method: 'POST', path: route,
        ca: certificatePEM, allowPartialTrustChain: true, rejectUnauthorized: true, agent: requestAgent, minVersion: 'TLSv1.2',
        checkServerIdentity(host, peer) {
          const error = tls.checkServerIdentity(host, peer);
          if (error) return error;
          if (!peer.raw || createHash('sha256').update(peer.raw).digest('hex') !== certificateFingerprint)
            return Object.assign(new Error('The remote certificate changed.'), {code: 'CERTIFICATE_CHANGED'});
        }, headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
          ...(authenticated ? {Authorization: `Bearer ${sessionToken}`} : {})}}, response => {
        const chunks = []; let size = 0;
        response.on('data', bytes => { size += bytes.length; if (size > 1024 * 1024) connection.destroy(Object.assign(new Error('The remote response is too large.'), {code: 'RESPONSE_LIMIT'})); else chunks.push(bytes); });
        response.once('error', reject);
        response.once('end', () => {
          let result;
          try { result = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks))); } catch { reject(Object.assign(new Error('The remote response is invalid.'), {code: 'INVALID_RESPONSE'})); return; }
          if (result?.ok !== true) reject(Object.assign(new Error('The remote app rejected the request.'), {
            code: typeof result?.error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(result.error.code) ? result.error.code : 'REMOTE_ERROR'}));
          else resolve(result.data);
        });
      });
      active.add(connection);
      connection.setTimeout(15000, () => connection.destroy(Object.assign(new Error('The remote connection timed out.'), {code: 'CONNECTION_TIMEOUT'})));
      connection.once('close', () => active.delete(connection)); connection.once('error', reject);
      connection.end(body);
    });
  }
  function close() {
    if (drain) return drain;
    sessionToken = ''; closed = true;
    drain = Promise.all([...active].map(connection => new Promise(resolve => {
      if (connection.closed) resolve(); else connection.once('close', resolve); connection.destroy();
    }))).then(() => {});
    return drain;
  }
  return Object.freeze({
    async connect({invitation, label}) {
      if (sessionToken || !TOKEN.test(invitation)) fail('INVALID_REQUEST');
      const state = await request('/api/app/connect', {invitation, label}, false);
      if (!TOKEN.test(state?.sessionToken)) fail('INVALID_RESPONSE');
      sessionToken = state.sessionToken; await onSessionToken(sessionToken);
      const result = {...state}; delete result.sessionToken; return result;
    },
    state: () => request('/api/app/state', {}),
    read: async (operation, payload) => copyReadDTO(operation, payload, await request('/api/app/read', {operation, payload})),
    writeState: target => request('/api/app/writeState', target),
    command: envelope => request('/api/app/command', envelope),
    result: query => request('/api/app/result', query),
    attachment: (operation,payload) => request('/api/app/attachment',{operation,payload}).then(value=>attachmentReply(operation,payload,value)),
    async disconnect() {
      try { if (sessionToken && !closed) return await request('/api/app/disconnect', {}); }
      finally { await close(); await onSessionToken(''); }
    },
    close
  });
}

module.exports = {createRemoteAppClient};

'use strict';
const { randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { SshError } = require('./ssh.cjs');

function createTerminalManager({ssh,maxSessions=8,maxBufferBytes=2*1024*1024}={}) {
  if (!ssh?.openShell) throw new TypeError('SSH service is required');
  const sessions = new Map();
  const geometry = ({cols=80,rows=24}={}) => {
    if (!Number.isInteger(cols)||cols<2||cols>500||!Number.isInteger(rows)||rows<1||rows>300) throw new SshError('TERMINAL_SIZE_INVALID','터미널 크기가 올바르지 않습니다.');
    return {cols,rows};
  };
  const get = id => {
    if (typeof id!=='string'||!sessions.has(id)) throw new SshError('TERMINAL_NOT_FOUND','터미널 연결을 찾을 수 없습니다.');
    return sessions.get(id);
  };
  function append(session,text) {
    if(!text)return;
    session.output+=text;session.cursor+=text.length;
    if(Buffer.byteLength(session.output)>maxBufferBytes){
      const bytes=Buffer.from(session.output);let start=bytes.length-maxBufferBytes;
      while(start<bytes.length&&(bytes[start]&0xc0)===0x80)start++;
      session.output=bytes.subarray(start).toString('utf8');
    }
    session.start=session.cursor-session.output.length;
  }
  return {
    async open(config,size={}) {
      const dimensions=geometry(size);
      if(sessions.size>=maxSessions)throw new SshError('TERMINAL_LIMIT','터미널은 최대 8개까지 연결할 수 있습니다.');
      const id=randomUUID(),session={id,serviceId:config.id||config.serviceId,output:'',cursor:0,start:0,closed:false,decoder:new StringDecoder('utf8'),shell:null};
      sessions.set(id,session);
      try {
        session.shell=await ssh.openShell(config,{...dimensions,onData:chunk=>{if(!session.closed)append(session,session.decoder.write(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)))},onClose:details=>{if(session.closed)return;append(session,session.decoder.end());session.closed=true;session.details=details||{};}});
        if(!sessions.has(id)){session.shell.close();throw new SshError('TERMINAL_CLOSED','터미널 연결이 취소되었습니다.');}
        return {id};
      }catch(error){sessions.delete(id);session.shell?.close();throw error;}
    },
    read(id,cursor=0) {
      const session=get(id);
      if(!Number.isSafeInteger(cursor)||cursor<0||cursor>session.cursor)throw new SshError('TERMINAL_CURSOR_INVALID','터미널 출력 위치가 올바르지 않습니다.');
      const start=Math.max(cursor,session.start);
      return {data:session.output.slice(start-session.start),cursor:session.cursor,closed:session.closed,truncated:cursor<session.start,...(session.details?.error?{error:session.details.error}:{})};
    },
    write(id,data) {
      const session=get(id);
      if(typeof data!=='string'||!data.length||Buffer.byteLength(data)>64*1024)throw new SshError('TERMINAL_INPUT_INVALID','터미널 입력은 64KB까지 전송할 수 있습니다.');
      if(session.closed||!session.shell)throw new SshError('TERMINAL_CLOSED','터미널 연결이 종료되었습니다.');
      session.shell.write(data);return {written:true};
    },
    resize(id,size) {const session=get(id),dimensions=geometry(size);if(session.closed||!session.shell)throw new SshError('TERMINAL_CLOSED','터미널 연결이 종료되었습니다.');session.shell.resize(dimensions);return dimensions;},
    close(id) {const session=get(id);sessions.delete(id);session.closed=true;session.shell?.close();return {closed:true};},
    closeService(serviceId) {for(const [id,session] of sessions)if(session.serviceId===serviceId)this.close(id);},
    closeAll() {for(const id of [...sessions.keys()])this.close(id);},
    get size() {return sessions.size;},
  };
}
module.exports={createTerminalManager};

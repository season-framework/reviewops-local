'use strict';
const crcTable=Array.from({length:256},(_,number)=>{for(let i=0;i<8;i++)number=number&1?0xedb88320^(number>>>1):number>>>1;return number>>>0});
const crc32=bytes=>{let value=0xffffffff;for(const byte of bytes)value=crcTable[(value^byte)&255]^(value>>>8);return (value^0xffffffff)>>>0};

function createZip(entries) {
  if(!Array.isArray(entries)||!entries.length||entries.length>10000)throw new Error('내보낼 파일 목록이 올바르지 않습니다.');
  const names=new Set(),files=[],directory=[];let offset=0,total=0;
  for(const entry of entries){
    const name=entry?.name;
    if(typeof name!=='string'||!name||name.startsWith('/')||/^[a-z]:/i.test(name)||/[\\\0]/.test(name)||name.split('/').some(part=>!part||part==='.'||part==='..')||names.has(name))throw new Error('내보낼 파일 이름이 올바르지 않습니다.');
    names.add(name);
    const filename=Buffer.from(name,'utf8'),bytes=entry.bytes;
    if(filename.length>65535||!Buffer.isBuffer(bytes))throw new Error('내보낼 파일 형식이 올바르지 않습니다.');
    total+=bytes.length;if(total>200*1024*1024)throw new Error('ZIP으로 저장할 자료는 합계 200 MB까지 지원합니다.');
    const checksum=crc32(bytes),header=Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(0x21,12);header.writeUInt32LE(checksum,14);header.writeUInt32LE(bytes.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(filename.length,26);
    const central=Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(0x21,14);central.writeUInt32LE(checksum,16);central.writeUInt32LE(bytes.length,20);central.writeUInt32LE(bytes.length,24);central.writeUInt16LE(filename.length,28);central.writeUInt32LE(offset,42);
    files.push(header,filename,bytes);directory.push(central,filename);offset+=header.length+filename.length+bytes.length;
  }
  const directorySize=directory.reduce((sum,part)=>sum+part.length,0),end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directorySize,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...files,...directory,end]);
}
module.exports={createZip};

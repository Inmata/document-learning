import {inflateRawSync} from 'node:zlib';
import {hash} from './io.mjs';

// Read selected Office ZIP entries in memory. Never extract paths to disk.
export function inspectDocx(buffer) {
 const tail=buffer.subarray(Math.max(0,buffer.length-65557)),end=tail.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));
 if(end<0)throw new Error('DOCX ZIP 目录缺失');
 let at=tail.readUInt32LE(end+16);const count=tail.readUInt16LE(end+10),parts=[],headers=[];
 for(let n=0;n<count;n++) {
  if(buffer.readUInt32LE(at)!==0x02014b50)throw new Error('DOCX ZIP 目录损坏');
  const method=buffer.readUInt16LE(at+10),size=buffer.readUInt32LE(at+20),uncompressed=buffer.readUInt32LE(at+24),nameLength=buffer.readUInt16LE(at+28),extraLength=buffer.readUInt16LE(at+30),commentLength=buffer.readUInt16LE(at+32),offset=buffer.readUInt32LE(at+42);
  const name=buffer.toString('utf8',at+46,at+46+nameLength);at+=46+nameLength+extraLength+commentLength;
  if(!/^word\/(?:header[^/]*|styles|document|footer[^/]*)\.xml$/.test(name))continue;
  if(uncompressed>16*1024*1024)throw new Error('DOCX XML 超过检查大小上限');
  if(buffer.readUInt32LE(offset)!==0x04034b50)throw new Error('DOCX ZIP 条目损坏');
  const start=offset+30+buffer.readUInt16LE(offset+26)+buffer.readUInt16LE(offset+28),compressed=buffer.subarray(start,start+size);
  const bytes=method===0?compressed:method===8?inflateRawSync(compressed,{maxOutputLength:16*1024*1024}):null;
  if(!bytes)throw new Error('DOCX ZIP 压缩方式不支持');
  const xml=bytes.toString('utf8');parts.push({name,digest:hash(xml)});
  if(/^word\/header/.test(name))headers.push({name,text:[...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m=>m[1]).join(''),realTabs:(xml.match(/<w:tab\s*\/>/g)||[]).length,tabStops:[...xml.matchAll(/<w:tab\b([^>]*?)(?:\/>|>)/g)].filter(m=>/w:val=/.test(m[1])).map(m=>m[1].trim()),spacesAsSpacer:/<w:t[^>]*>\s{3,}<\/w:t>/.test(xml)});
 }
 return {parts,headers,limitation:'结构检查，未证明视觉位置或分页效果'};
}

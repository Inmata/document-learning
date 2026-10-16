import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateRawSync} from 'node:zlib';
import {inspectDocx} from '../src/docx-structure.mjs';
// Small in-memory fixture with a nonstandard header name and a compressed entry.
function zip(name,text){const n=Buffer.from(name),data=deflateRawSync(Buffer.from(text)),local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(8,8);local.writeUInt32LE(data.length,18);local.writeUInt32LE(Buffer.byteLength(text),22);local.writeUInt16LE(n.length,26);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(8,10);central.writeUInt32LE(data.length,20);central.writeUInt32LE(Buffer.byteLength(text),24);central.writeUInt16LE(n.length,28);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+n.length,12);end.writeUInt32LE(local.length+n.length+data.length,16);return Buffer.concat([local,n,data,central,n,end]);}
test('实际读取自定义名称页眉，区分文字制表字符与 Word 制表符及继承清除',()=>{
 const before=inspectDocx(zip('word/headerCompany.xml','<w:hdr><w:t>Company\t</w:t><w:tab w:val="right" w:pos="9000"/></w:hdr>'));
 const after=inspectDocx(zip('word/headerCompany.xml','<w:hdr><w:t>Company</w:t><w:tab/><w:tab w:val="clear" w:pos="4500"/><w:tab w:val="right" w:pos="9000"/></w:hdr>'));
 assert.equal(before.headers[0].realTabs,0);assert.equal(after.headers[0].realTabs,1);assert.match(after.headers[0].tabStops[0],/clear/);assert.notEqual(before.parts[0].digest,after.parts[0].digest);assert.match(after.limitation,/未证明视觉/);
});

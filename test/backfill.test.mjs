import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Library} from '../src/library.mjs';
import {runBackfill} from '../src/backfill.mjs';
import {normalizeJsonl} from '../src/history.mjs';
test('原始日志不把环境注入当作用户偏好，保留实际需求及工具证据',()=>{
 const raw=[{type:'session_meta',payload:{id:'native'}},{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'<environment_context>system state</environment_context>'}]}},{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'写客户操作说明'}]}},{type:'response_item',payload:{type:'function_call_output',output:'actual tool result'}}].map(JSON.stringify).join('\n');
 const s=normalizeJsonl(raw,'test');assert.equal(s.messages.filter(m=>m.role==='user').length,1);assert.equal(s.messages.filter(m=>m.role==='tool').length,1);
});
test('当前补学读取参考文件和后续差异，校验原始引文并交付可读内容',async t=>{
 const root=await mkdtemp(join(tmpdir(),'doc-backfill-'));t.after(()=>rm(root,{recursive:true,force:true}));const lib=await Library.open(root);
 const user={id:'u',role:'user',text:'按实际操作整理实验轮次，不要编造动机。',task:'case',context:{task:'case'}};
 const dataset={sessions:[{id:'case',title:'案例',messages:[user],completeness:{truncated:false,warnings:[]}}],git:{head:'a'.repeat(40),actual:{files:[{path:'example/references/rules.md',text:'不凭沉默认定认可。'}]},commits:[{sha:'a'.repeat(40),subject:'修订',relevant:true,selected:[{path:'example/SKILL.md',diff:'-old\n+new'}]}]}};
 const learner=async request=>{assert.equal(request.mode,'current-material-backfill');assert.match(request.repository.sources[0].text,/沉默/);assert.match(request.repository.changes[0].selected[0].diff,/new/);return {document:true,rules:[{key:'intent',value:'observed',text:'按真实操作解释实验动机',category:'method',strength:'default',scope:{kind:'experiment-report'},evidence:[{source:'u',quote:user.text}]}],observations:[],skills:[],retire:[]};};
 const result=await runBackfill(lib,dataset,learner,{jobId:'test'});assert.match(await readFile(result.catalog.knowledge,'utf8'),/按真实操作/);assert.equal((await lib.read()).rules.length,1);
 const revision=(await lib.read()).revision;
 await runBackfill(lib,dataset,()=>{throw new Error('已完成任务不应重复调用模型');},{jobId:'test'});
 assert.equal((await lib.read()).revision,revision);
});

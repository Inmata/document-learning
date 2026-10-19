import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Library} from '../src/library.mjs';
import {handleHook,sessionKey} from '../src/hooks.mjs';
import {recoveryInput} from '../src/recovery.mjs';
test('中断后跨工作区新会话消费旧学习票据，不继续旧业务操作',async t=>{
 const root=await mkdtemp(join(tmpdir(),'doc-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));const lib=await Library.open(root);
 const event=(session,name,rest={})=>({session_id:session,hook_event_name:name,cwd:`workspace-${session}`,...rest});
 await handleHook(lib,'codex',event('old','UserPromptSubmit',{prompt:'这份报告不要图注'}));
 let old=(await lib.read()).sessions[sessionKey('codex','old')].current;
 await handleHook(lib,'codex',event('old','PostToolUse',{tool_response:{document_learning_signal:{session:sessionKey('codex','old'),turn:old.id,token:old.token,phase:'begin',document:true,context:{task:'old-report',kind:'experiment-report'}}}}));
 await handleHook(lib,'codex',event('old','Interrupt'));
 const result=await handleHook(lib,'claude',event('new','UserPromptSubmit',{prompt:'2+2'}));assert.match(result.hookSpecificOutput.additionalContext,/recover/);
 const key=sessionKey('claude','new'),owner=(await lib.read()).sessions[key].current;
 const [input]=recoveryInput(await lib.read(),key,owner.id,owner.token);assert.equal(input.prompt,'这份报告不要图注');assert.match(input.instruction,/不继续旧业务/);
 await handleHook(lib,'claude',event('new','PostToolUse',{tool_response:{document_learning_signal:{...input,phase:'complete',rules:[],skills:[],skillDecision:{action:'no-change',reason:'一次局部图注偏好不构成新工作流'}}}}));
 assert.equal((await lib.read()).sessions[sessionKey('codex','old')].current.receipt,'no-new-learning');
 assert.equal(recoveryInput(await lib.read(),key,owner.id,owner.token).length,0);
});
test('同会话后续轮次不会丢失旧回执，过期和伪造票据不能取回证据',async t=>{
 const root=await mkdtemp(join(tmpdir(),'doc-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));const lib=await Library.open(root),key=sessionKey('codex','a');
 await handleHook(lib,'codex',{session_id:'a',hook_event_name:'UserPromptSubmit',prompt:'旧需求'});
 await handleHook(lib,'codex',{session_id:'a',hook_event_name:'UserPromptSubmit',prompt:'新需求'});
 const state=await lib.read(),current=state.sessions[key].current;assert.equal(state.sessions[key].pending.length,1);assert.equal(recoveryInput(state,key,current.id,current.token).length,1);
 assert.throws(()=>recoveryInput(state,key,current.id,'forged'),/不属于/);
});

test('恢复者中断后释放租期并清空票据，下一会话立即接续',async t=>{
 const root=await mkdtemp(join(tmpdir(),'doc-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));const lib=await Library.open(root);
 const event=(session,name,rest={})=>({session_id:session,hook_event_name:name,cwd:`workspace-${session}`,...rest});
 const originalKey=sessionKey('codex','original');
 await handleHook(lib,'codex',event('original','UserPromptSubmit',{prompt:'旧需求'}));
 await handleHook(lib,'codex',event('original','SessionEnd'));
 await handleHook(lib,'codex',event('owner','UserPromptSubmit',{prompt:'认领'}));
 const ownerKey=sessionKey('codex','owner'),owner=(await lib.read()).sessions[ownerKey].current;
 assert.equal(recoveryInput(await lib.read(),ownerKey,owner.id,owner.token).length,1);
 await handleHook(lib,'codex',event('owner','Interrupt'));
 const released=await lib.read();
 assert.deepEqual(released.sessions[ownerKey].current.recoveryTickets,[]);
 assert.equal(released.sessions[originalKey].current.recoveryLease,undefined);
 await handleHook(lib,'codex',event('next','UserPromptSubmit',{prompt:'接续'}));
 const nextKey=sessionKey('codex','next'),next=(await lib.read()).sessions[nextKey].current;
 assert.equal(recoveryInput(await lib.read(),nextKey,next.id,next.token)[0].session,originalKey);
});
test('恢复者关闭后立即释放租期，下一会话可接续而不必等待十分钟',async t=>{
 const root=await mkdtemp(join(tmpdir(),'doc-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));const lib=await Library.open(root);
 for(const id of ['original','first-owner']){await handleHook(lib,'codex',{session_id:id,hook_event_name:'UserPromptSubmit',prompt:id});await handleHook(lib,'codex',{session_id:id,hook_event_name:'SessionEnd'});}
 await handleHook(lib,'codex',{session_id:'second-owner',hook_event_name:'UserPromptSubmit',prompt:'new'});
 const key=sessionKey('codex','second-owner'),turn=(await lib.read()).sessions[key].current;
 assert.equal(recoveryInput(await lib.read(),key,turn.id,turn.token)[0].session,sessionKey('codex','original'));
});

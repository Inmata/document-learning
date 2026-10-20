import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Library} from '../src/library.mjs';
import {handleHook,sessionKey} from '../src/hooks.mjs';
import {recoveryInput} from '../src/recovery.mjs';

const event=(session,name,rest={})=>({session_id:session,hook_event_name:name,cwd:`workspace-${session}`,...rest});
async function begin(lib,agent,session,turn,task='report'){
  return handleHook(lib,agent,event(session,'PostToolUse',{tool_response:{document_learning_signal:{session:sessionKey(agent,session),turn:turn.id,token:turn.token,phase:'begin',document:true,context:{task,kind:'report'}}}}));
}
async function complete(lib,agent,session,turn){
  return handleHook(lib,agent,event(session,'PostToolUse',{tool_response:{document_learning_signal:{session:sessionKey(agent,session),turn:turn.id,token:turn.token,phase:'complete',rules:[],skills:[],skillDecision:{action:'no-change',reason:'测试中暂无新经验'}}}}));
}

test('中断后跨工作区新会话只在文档轮消费旧学习票据，不继续旧业务操作',async t=>{
 const root=await mkdtemp(join(tmpdir(),'doc-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));const lib=await Library.open(root);
 await handleHook(lib,'codex',event('old','UserPromptSubmit',{prompt:'这份报告不要图注'}));
 const old=(await lib.read()).sessions[sessionKey('codex','old')].current;
 await begin(lib,'codex','old',old,'old-report');
 await handleHook(lib,'codex',event('old','Interrupt'));
 // 普通聊天轮不认领旧账
 const chat=await handleHook(lib,'claude',event('new','UserPromptSubmit',{prompt:'2+2'}));
 assert.doesNotMatch(chat.hookSpecificOutput.additionalContext,/recover/);
 const chatState=await lib.read();
 assert.equal(chatState.sessions[sessionKey('codex','old')].current.recoveryLease,undefined);
 assert.equal(chatState.sessions[sessionKey('claude','new')].current.recoveryTickets,undefined);
 // 同一会话的文档轮才认领
 await handleHook(lib,'claude',event('new','UserPromptSubmit',{prompt:'整理一份新报告'}));
 const key=sessionKey('claude','new'),owner=(await lib.read()).sessions[key].current;
 const beginResult=await begin(lib,'claude','new',owner,'new-report');
 assert.match(beginResult.hookSpecificOutput.additionalContext,/recover/);
 const [input]=recoveryInput(await lib.read(),key,owner.id,owner.token);assert.equal(input.prompt,'这份报告不要图注');assert.match(input.instruction,/不继续旧业务/);
 await handleHook(lib,'claude',event('new','PostToolUse',{tool_response:{document_learning_signal:{...input,phase:'complete',rules:[],skills:[],skillDecision:{action:'no-change',reason:'一次局部图注偏好不构成新工作流'}}}}));
 assert.equal((await lib.read()).sessions[sessionKey('codex','old')].current.receipt,'no-new-learning');
 assert.equal(recoveryInput(await lib.read(),key,owner.id,owner.token).length,0);
});

test('同会话后续轮次不会丢失旧回执，过期和伪造票据不能取回证据',async t=>{
 const root=await mkdtemp(join(tmpdir(),'doc-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));const lib=await Library.open(root),key=sessionKey('codex','a');
 await handleHook(lib,'codex',{session_id:'a',hook_event_name:'UserPromptSubmit',prompt:'旧需求'});
 const first=(await lib.read()).sessions[key].current;
 await begin(lib,'codex','a',first,'old-report');
 await handleHook(lib,'codex',{session_id:'a',hook_event_name:'UserPromptSubmit',prompt:'新需求'});
 const state=await lib.read(),current=state.sessions[key].current;assert.equal(state.sessions[key].pending.length,1);
 await begin(lib,'codex','a',current,'new-report');
 const claimed=await lib.read();
 assert.equal(recoveryInput(claimed,key,current.id,current.token).length,1);
 assert.throws(()=>recoveryInput(claimed,key,current.id,'forged'),/不属于/);
});

test('恢复者中断后释放租期并清空票据，下一文档轮立即接续',async t=>{
 const root=await mkdtemp(join(tmpdir(),'doc-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));const lib=await Library.open(root);
 const originalKey=sessionKey('codex','original');
 await handleHook(lib,'codex',event('original','UserPromptSubmit',{prompt:'旧需求'}));
 const original=(await lib.read()).sessions[originalKey].current;
 await begin(lib,'codex','original',original,'old-report');
 await handleHook(lib,'codex',event('original','SessionEnd'));
 await handleHook(lib,'codex',event('owner','UserPromptSubmit',{prompt:'认领'}));
 const ownerKey=sessionKey('codex','owner'),owner=(await lib.read()).sessions[ownerKey].current;
 await begin(lib,'codex','owner',owner,'owner-report');
 assert.equal(recoveryInput(await lib.read(),ownerKey,owner.id,owner.token).length,1);
 await handleHook(lib,'codex',event('owner','Interrupt'));
 const released=await lib.read();
 assert.deepEqual(released.sessions[ownerKey].current.recoveryTickets,[]);
 assert.equal(released.sessions[originalKey].current.recoveryLease,undefined);
 await handleHook(lib,'codex',event('next','UserPromptSubmit',{prompt:'接续'}));
 const nextKey=sessionKey('codex','next'),next=(await lib.read()).sessions[nextKey].current;
 await begin(lib,'codex','next',next,'next-report');
 assert.equal(recoveryInput(await lib.read(),nextKey,next.id,next.token)[0].session,originalKey);
});

test('恢复者关闭后立即释放租期，下一文档轮可接续而不必等待十分钟',async t=>{
 const root=await mkdtemp(join(tmpdir(),'doc-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));const lib=await Library.open(root);
 for(const id of ['original','first-owner']){
  await handleHook(lib,'codex',{session_id:id,hook_event_name:'UserPromptSubmit',prompt:id});
  const turn=(await lib.read()).sessions[sessionKey('codex',id)].current;
  await begin(lib,'codex',id,turn,`${id}-report`);
  await handleHook(lib,'codex',{session_id:id,hook_event_name:'SessionEnd'});
 }
 await handleHook(lib,'codex',{session_id:'second-owner',hook_event_name:'UserPromptSubmit',prompt:'new'});
 const key=sessionKey('codex','second-owner'),turn=(await lib.read()).sessions[key].current;
 await begin(lib,'codex','second-owner',turn,'new-report');
 assert.equal(recoveryInput(await lib.read(),key,turn.id,turn.token)[0].session,sessionKey('codex','original'));
});

test('未分类轮直接结束，不进入补学队列',async t=>{
 const root=await mkdtemp(join(tmpdir(),'doc-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));const lib=await Library.open(root);
 await handleHook(lib,'codex',event('chat','UserPromptSubmit',{prompt:'聊聊天气'}));
 const key=sessionKey('codex','chat');
 assert.deepEqual(await handleHook(lib,'codex',event('chat','Stop')),{});
 let state=await lib.read();
 assert.equal(state.sessions[key].current.receipt,'not-document');
 assert.deepEqual(state.sessions[key].pending || [],[]);
 await handleHook(lib,'codex',event('chat','SessionEnd'));
 state=await lib.read();
 assert.equal(state.sessions[key].current.receipt,'not-document');
 await handleHook(lib,'codex',event('next','UserPromptSubmit',{prompt:'整理报告'}));
 const next=(await lib.read()).sessions[sessionKey('codex','next')].current;
 await begin(lib,'codex','next',next,'next-report');
 assert.equal(recoveryInput(await lib.read(),sessionKey('codex','next'),next.id,next.token).length,0);
});

test('补不上的文档旧账达到认领上限即归档，不再反复复活',async t=>{
 const root=await mkdtemp(join(tmpdir(),'doc-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));const lib=await Library.open(root);
 await lib.transact('seed-old-debt',state=>{
  state.sessions['codex-old']={agent:'codex',id:'old',current:{id:'old-turn',token:'old-token',prompt:'旧报告',receipt:'pending-recovery',document:true,recoveryAttempts:5,firstRecoveryAt:Date.now()-1000}};
 });
 await handleHook(lib,'codex',event('fresh','UserPromptSubmit',{prompt:'整理新报告'}));
 const fresh=(await lib.read()).sessions[sessionKey('codex','fresh')].current;
 await begin(lib,'codex','fresh',fresh,'fresh-report');
 const state=await lib.read();
 assert.equal(state.sessions['codex-old'].current.receipt,'abandoned');
 assert.equal(recoveryInput(state,sessionKey('codex','fresh'),fresh.id,fresh.token).length,0);
});

test('API 失败只保留文档轮，旧版未分类欠账在下一次提示时清理',async t=>{
 const root=await mkdtemp(join(tmpdir(),'doc-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));const lib=await Library.open(root);
 await handleHook(lib,'codex',event('doc','UserPromptSubmit',{prompt:'整理报告'}));
 const doc=(await lib.read()).sessions[sessionKey('codex','doc')].current;
 await begin(lib,'codex','doc',doc,'doc-report');
 await handleHook(lib,'codex',event('doc','StopFailure',{error:'api failed'}));
 await handleHook(lib,'codex',event('chat','UserPromptSubmit',{prompt:'聊聊天气'}));
 await handleHook(lib,'codex',event('chat','StopFailure',{error:'api failed'}));
 await lib.transact('seed-legacy',state=>{
  state.sessions['codex-legacy']={agent:'codex',id:'legacy',current:{id:'legacy-turn',token:'legacy-token',prompt:'旧聊天',receipt:'pending-recovery'}};
 });
 await handleHook(lib,'codex',event('fresh','SessionStart',{source:'startup'}));
 const state=await lib.read();
 assert.equal(state.sessions[sessionKey('codex','doc')].current.receipt,'pending-recovery');
 assert.equal(state.sessions[sessionKey('codex','chat')].current.receipt,'not-document');
 assert.equal(state.sessions['codex-legacy'].current.receipt,'not-document');
});

test('恢复提交只结清原轮，不再认领新的历史欠账',async t=>{
 const root=await mkdtemp(join(tmpdir(),'doc-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));const lib=await Library.open(root);
 // 两笔文档欠账
 for(const id of ['x','z']){
  await handleHook(lib,'codex',event(id,'UserPromptSubmit',{prompt:`${id} 报告`}));
  const turn=(await lib.read()).sessions[sessionKey('codex',id)].current;
  await begin(lib,'codex',id,turn,`${id}-report`);
  await handleHook(lib,'codex',event(id,'Interrupt'));
 }
 // 恢复者认领第一笔
 await handleHook(lib,'claude',event('owner','UserPromptSubmit',{prompt:'整理新报告'}));
 const ownerKey=sessionKey('claude','owner'),owner=(await lib.read()).sessions[ownerKey].current;
 await begin(lib,'claude','owner',owner,'owner-report');
 const [input]=recoveryInput(await lib.read(),ownerKey,owner.id,owner.token);
 assert.equal(typeof input?.recoveryTicket,'string');
 // 对原轮补判断时不应再认领第二笔
 await handleHook(lib,'claude',event('owner','PostToolUse',{tool_response:{document_learning_signal:{session:input.session,turn:input.turn,token:input.token,phase:'begin',document:true,recoveryTicket:input.recoveryTicket,context:{task:'x-report',kind:'report'}}}}));
 const state=await lib.read();
 assert.equal(state.sessions[ownerKey].current.recoveryTickets.length,1);
 assert.equal(state.sessions[sessionKey('codex','z')].current.recoveryLease,undefined);
});

test('有效租约内的恢复不被认领上限归档',async t=>{
 const root=await mkdtemp(join(tmpdir(),'doc-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));const lib=await Library.open(root);
 await lib.transact('seed-leased',state=>{
  const expires=Date.now()+600000;
  state.sessions['codex-old']={agent:'codex',id:'old',current:{id:'old-turn',token:'old-token',prompt:'旧报告',receipt:'pending-recovery',document:true,recoveryAttempts:5,firstRecoveryAt:Date.now()-1000,recoveryLease:{ownerKey:'codex-holder',ownerTurn:'holder-turn',ticket:'tk',expires}}};
  state.sessions['codex-holder']={agent:'codex',id:'holder',current:{id:'holder-turn',token:'holder-token',receipt:'in-progress',document:true,recoveryTickets:[{id:'tk',session:'codex-old',turn:'old-turn',expires}]}};
 });
 await handleHook(lib,'codex',event('fresh','UserPromptSubmit',{prompt:'整理新报告'}));
 const fresh=(await lib.read()).sessions[sessionKey('codex','fresh')].current;
 await begin(lib,'codex','fresh',fresh,'fresh-report');
 assert.equal((await lib.read()).sessions['codex-old'].current.receipt,'pending-recovery');
});

test('非文档轮改判后释放票据，Stop 不再反复提示补学',async t=>{
 const root=await mkdtemp(join(tmpdir(),'doc-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));const lib=await Library.open(root);
 await handleHook(lib,'codex',event('old','UserPromptSubmit',{prompt:'旧报告'}));
 const old=(await lib.read()).sessions[sessionKey('codex','old')].current;
 await begin(lib,'codex','old',old,'old-report');
 await handleHook(lib,'codex',event('old','Interrupt'));
 await handleHook(lib,'codex',event('owner','UserPromptSubmit',{prompt:'整理新报告'}));
 const ownerKey=sessionKey('codex','owner'),owner=(await lib.read()).sessions[ownerKey].current;
 await begin(lib,'codex','owner',owner,'owner-report');
 assert.equal(recoveryInput(await lib.read(),ownerKey,owner.id,owner.token).length,1);
 // 同一轮改判为非文档
 await handleHook(lib,'codex',event('owner','PostToolUse',{tool_response:{document_learning_signal:{session:ownerKey,turn:owner.id,token:owner.token,phase:'begin',document:false}}}));
 const state=await lib.read();
 assert.deepEqual(state.sessions[ownerKey].current.recoveryTickets,[]);
 assert.equal(state.sessions[sessionKey('codex','old')].current.recoveryLease,undefined);
 assert.deepEqual(await handleHook(lib,'codex',event('owner','Stop')),{});
});

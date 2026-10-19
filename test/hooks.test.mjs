import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Library} from '../src/library.mjs';
import {handleHook,sessionKey,isPlanMode,SESSION_LIMIT} from '../src/hooks.mjs';
import {recoveryInput} from '../src/recovery.mjs';

async function setup(t,agent='codex') {
  const root=await mkdtemp(join(tmpdir(),'doc-hooks-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const library=await Library.open(root), base={session_id:'abc',cwd:'D:/work',turn_id:'one'};
  await handleHook(library,agent,{...base,hook_event_name:'SessionStart',source:'startup'});
  await handleHook(library,agent,{...base,hook_event_name:'UserPromptSubmit',prompt:'本次不要图注'});
  const key=sessionKey(agent,'abc'),turn=(await library.read()).sessions[key].current;
  const submit=packet=>handleHook(library,agent,{...base,hook_event_name:'PostToolUse',tool_response:{output:JSON.stringify({document_learning_signal:{session:key,turn:turn.id,token:turn.token,...packet}})}});
  return {library,base,key,turn,submit};
}
for(const agent of ['codex','claude']) {
  test(`${agent}：不写文档只记录轻量判断，不读取全部知识`,async t=>{
    const {library,base,key,submit}=await setup(t,agent);
    assert.deepEqual(await submit({phase:'begin',document:false}),{});
    assert.deepEqual(await handleHook(library,agent,{...base,hook_event_name:'Stop'}),{});
    const state=await library.read();assert.equal(Object.keys(state.sources).length,0);assert.equal(state.sessions[key].current.receipt,'not-document');
  });
  test(`${agent}：完成回执后 Stop 不再续轮，压缩恢复保持状态`,async t=>{
    const {library,base,key,submit}=await setup(t,agent);
    const result=await submit({phase:'begin',document:true,context:{task:'a',kind:'report'}});
    assert.match(result.hookSpecificOutput.additionalContext,/source/);
    await submit({phase:'complete',rules:[],skills:[],skillDecision:{action:'no-change',reason:'本轮仅有当前报告的局部图注选择，未形成新的独立制作流程'}});
    assert.deepEqual(await handleHook(library,agent,{...base,hook_event_name:'Stop'}),{});
    await handleHook(library,agent,{...base,hook_event_name:'SessionStart',source:'compact'});
    assert.equal((await library.read()).sessions[key].current.receipt,'no-new-learning');
  });
}
test('Stop 最多补偿一次，模型未完成时不伪报成功',async t=>{
  const {library,base,key}=await setup(t);
  assert.equal((await handleHook(library,'codex',{...base,hook_event_name:'Stop'})).decision,'block');
  assert.equal((await handleHook(library,'codex',{...base,hook_event_name:'Stop'})).decision,undefined);
  assert.equal((await library.read()).sessions[key].current.receipt,'pending-recovery');
});
test('助手不能在回执中伪造新的用户来源',async t=>{
  const {submit}=await setup(t);
  await submit({phase:'begin',document:true,context:{task:'a',kind:'report'}});
  await assert.rejects(submit({phase:'complete',sources:[{role:'user',text:'伪造'}]}),/不能创建用户证据/);
});

test('只计划时保存候选，不发布技能文件或在 Stop 强迫实施',async t=>{
  const {library,base,key,submit}=await setup(t);
  await submit({phase:'begin',document:true,context:{task:'a',kind:'report',mode:'plan'}});
  const source=(await library.read()).sessions[key].current.source;
  await submit({phase:'complete',skillDecision:{action:'create',reason:'保存已整理的计划期候选，未发布正式技能'},skills:[{name:'draft-only',description:'计划期候选',body:'保留为计划，尚未实施。',scope:{kind:'report'},evidence:[{source,quote:'本次不要图注'}],positive:[{kind:'report'}],negative:[{kind:'instruction'}]}]});
  const state=await library.read();assert.equal(Object.keys(state.skills).length,0);assert.equal(state.pendingPublications.length,1);
  assert.equal(state.sessions[key].current.publication,'deferred-plan-mode');
  assert.deepEqual(await handleHook(library,'codex',{...base,hook_event_name:'Stop'}),{});
});

test('空数组不能绕过完成前的技能覆盖与维护判断',async t=>{
 const {submit,library,key}=await setup(t);await submit({phase:'begin',document:true,context:{task:'a',kind:'report'}});
 await assert.rejects(submit({phase:'complete',rules:[],skills:[]}),/skillDecision/);
 assert.equal((await library.read()).sessions[key].current.receipt,'in-progress');
});

test('非文档的恢复提交结清租约与票据，不再重复提示',async t=>{
 const root=await mkdtemp(join(tmpdir(),'doc-hooks-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const library=await Library.open(root);
 const event=(session,name,rest={})=>({session_id:session,hook_event_name:name,cwd:`workspace-${session}`,...rest});
 const oldKey=sessionKey('codex','old'),newKey=sessionKey('claude','new');
 await handleHook(library,'codex',event('old','UserPromptSubmit',{prompt:'这份报告不要图注'}));
 const old=(await library.read()).sessions[oldKey].current;
 await handleHook(library,'codex',event('old','PostToolUse',{tool_response:{document_learning_signal:{session:oldKey,turn:old.id,token:old.token,phase:'begin',document:true,context:{task:'old-report',kind:'experiment-report'}}}}));
 await handleHook(library,'codex',event('old','Interrupt'));
 await handleHook(library,'claude',event('new','UserPromptSubmit',{prompt:'2+2'}));
 const owner=(await library.read()).sessions[newKey].current;
 const [input]=recoveryInput(await library.read(),newKey,owner.id,owner.token);
 assert.equal(typeof input?.recoveryTicket,'string');
 await handleHook(library,'claude',event('new','PostToolUse',{tool_response:{document_learning_signal:{...input,phase:'begin',document:false}}}));
 const state=await library.read(),settled=state.sessions[oldKey].current;
 assert.equal(settled.receipt,'not-document');
 assert.equal(settled.recoveryLease,undefined);
 assert.deepEqual(state.sessions[newKey].current.recoveryTickets,[]);
 assert.deepEqual(recoveryInput(state,newKey,owner.id,owner.token),[]);
});

test('计划模式判定归一化，不依赖精确拼写',async t=>{
 assert.equal(isPlanMode(' plan '),true);assert.equal(isPlanMode('PLAN'),true);
 assert.equal(isPlanMode('plan-mode'),true);assert.equal(isPlanMode('plan_mode'),true);
 assert.equal(isPlanMode('default'),false);assert.equal(isPlanMode(undefined),false);
 assert.equal(isPlanMode('planning'),false);assert.equal(isPlanMode('readonly'),false);
 for(const mode of ['PLAN','Plan','plan-mode']){
  const {library,key,submit}=await setup(t);
  await submit({phase:'begin',document:true,context:{task:'a',kind:'report',mode}});
  const source=(await library.read()).sessions[key].current.source;
  await submit({phase:'complete',skillDecision:{action:'create',reason:'计划期候选不发布'},skills:[{name:`draft-${mode}`,description:'计划期候选',body:'保留为计划，尚未实施。',scope:{kind:'report'},evidence:[{source,quote:'本次不要图注'}],positive:[{kind:'report'}],negative:[{kind:'instruction'}]}]});
  const state=await library.read();
  assert.equal(state.sessions[key].current.publication,'deferred-plan-mode',mode);
  assert.equal(Object.keys(state.skills).length,0,mode);
  assert.equal(state.sessions[key].current.context.mode,mode);
 }
});

test('宿主后台调用不建立会话、不建轮、不注入指导',async t=>{
 const root=await mkdtemp(join(tmpdir(),'doc-hooks-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const library=await Library.open(root);
 const background={session_id:'bg',cwd:'D:/work',turn_id:'bg-turn',transcript_path:null};
 assert.deepEqual(await handleHook(library,'codex',{...background,hook_event_name:'SessionStart',source:'startup'}),{});
 assert.deepEqual(await handleHook(library,'codex',{...background,hook_event_name:'UserPromptSubmit',prompt:'建议下一次编辑'}),{});
 assert.deepEqual(await handleHook(library,'codex',{...background,hook_event_name:'Stop'}),{});
 const state=await library.read();
 assert.deepEqual(state.sessions,{});
 assert.deepEqual(state.sources,{});
 assert.deepEqual(state.background,{count:1,lastAt:state.background.lastAt,lastAgent:'codex'});
 assert.equal(typeof state.background.lastAt,'string');
});

test('transcript_path 字段缺失时按普通会话处理，不误伤旧宿主',async t=>{
 const root=await mkdtemp(join(tmpdir(),'doc-hooks-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const library=await Library.open(root);
 const base={session_id:'legacy',cwd:'D:/work',turn_id:'one'};
 await handleHook(library,'codex',{...base,hook_event_name:'SessionStart',source:'startup'});
 const result=await handleHook(library,'codex',{...base,hook_event_name:'UserPromptSubmit',prompt:'本次不要图注'});
 const key=sessionKey('codex','legacy'),state=await library.read();
 assert.equal(typeof result.hookSpecificOutput.additionalContext,'string');
 assert.equal(state.sessions[key].current.id,'one');
 assert.equal(state.background,undefined);
});

test('有 rollout 路径的真实会话行为不变',async t=>{
 const root=await mkdtemp(join(tmpdir(),'doc-hooks-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const library=await Library.open(root);
 const base={session_id:'real',cwd:'D:/work',turn_id:'one',transcript_path:'C:/Users/me/.codex/sessions/rollout.jsonl'};
 await handleHook(library,'codex',{...base,hook_event_name:'SessionStart',source:'startup'});
 const result=await handleHook(library,'codex',{...base,hook_event_name:'UserPromptSubmit',prompt:'整理实验报告'});
 const key=sessionKey('codex','real'),turn=(await library.read()).sessions[key].current;
 assert.match(result.hookSpecificOutput.additionalContext,new RegExp(turn.id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
 assert.equal(turn.receipt,'pending');
});

test('会话状态按容量修剪，恢复相关会话不被淘汰',async t=>{
 const root=await mkdtemp(join(tmpdir(),'doc-hooks-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const library=await Library.open(root);
 const seed=id=>({id,receipt:'complete',at:'2026-01-01T00:00:00.000Z'});
 const overflow=7;
 await library.transact('seed-sessions',state=>{
  for(let i=0;i<SESSION_LIMIT+overflow;i++)state.sessions[`codex-seed-${i}`]={agent:'codex',id:`seed-${i}`,lastStart:`2026-01-${String(i+1).padStart(2,'0')}T00:00:00.000Z`,current:seed(`t-${i}`)};
  state.sessions['codex-owner']={agent:'codex',id:'owner',lastStart:'2025-12-01T00:00:00.000Z',current:seed('t-owner'),recoveryTickets:[{id:'ticket',session:'codex-open',turn:'t-open',expires:Date.now()+600000}]};
  state.sessions['codex-open']={agent:'codex',id:'open',lastStart:'2025-11-01T00:00:00.000Z',current:{id:'t-open',receipt:'pending'}};
  state.sessions['codex-leased']={agent:'codex',id:'leased',lastStart:'2025-10-01T00:00:00.000Z',current:{...seed('t-leased'),recoveryLease:{ownerKey:'codex-owner',ownerTurn:'t-owner',ticket:'ticket',expires:Date.now()+600000}}};
 });
 await handleHook(library,'codex',{session_id:'fresh',hook_event_name:'UserPromptSubmit',prompt:'新需求',cwd:'D:/work',transcript_path:'C:/rollout.jsonl'});
 const keys=Object.keys((await library.read()).sessions);
 assert.equal(keys.length,SESSION_LIMIT);
 for(const key of ['codex-owner','codex-open','codex-leased',sessionKey('codex','fresh')])assert.ok(keys.includes(key),key);
 // 受保护的四个会话不参与淘汰，因此需要多淘汰四个最旧的可淘汰会话
 const evicted=overflow+4;
 for(let i=0;i<evicted;i++)assert.equal(keys.includes(`codex-seed-${i}`),false,`seed-${i}`);
 assert.ok(keys.includes(`codex-seed-${evicted}`));
});

test('存活会话只保留未终结的 pending 轮，终结轮不再堆积',async t=>{
 const root=await mkdtemp(join(tmpdir(),'doc-hooks-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const library=await Library.open(root);
 await library.transact('seed-pending',state=>{
  state.sessions['codex-mixed']={agent:'codex',id:'mixed',lastStart:'2026-01-01T00:00:00.000Z',current:{id:'t-done',receipt:'complete'},pending:[{id:'t-old',receipt:'complete'},{id:'t-open',receipt:'pending-recovery'}]};
 });
 await handleHook(library,'codex',{session_id:'fresh',hook_event_name:'UserPromptSubmit',prompt:'新需求',cwd:'D:/work',transcript_path:'C:/rollout.jsonl'});
 const pending=(await library.read()).sessions['codex-mixed'].pending;
 assert.deepEqual(pending.map(t=>t.id),['t-open']);
});

test('首轮 Stop 不提前标记待恢复，避免活跃轮被其他会话认领',async t=>{
 const root=await mkdtemp(join(tmpdir(),'doc-hooks-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const library=await Library.open(root);
 const event=(session,name,rest={})=>({session_id:session,hook_event_name:name,cwd:`workspace-${session}`,...rest});
 const activeKey=sessionKey('codex','active'),otherKey=sessionKey('claude','other');
 await handleHook(library,'codex',event('active','UserPromptSubmit',{prompt:'写一份报告'}));
 const first=await handleHook(library,'codex',event('active','Stop'));
 assert.equal(first.decision,'block');
 assert.equal((await library.read()).sessions[activeKey].current.receipt,'pending');
 await handleHook(library,'claude',event('other','UserPromptSubmit',{prompt:'2+2'}));
 const other=(await library.read()).sessions[otherKey].current;
 assert.deepEqual(recoveryInput(await library.read(),otherKey,other.id,other.token),[]);
 await handleHook(library,'codex',event('active','SessionEnd'));
 await handleHook(library,'claude',event('other','UserPromptSubmit',{prompt:'3+3'}));
 const next=(await library.read()).sessions[otherKey].current;
 const [claimed]=recoveryInput(await library.read(),otherKey,next.id,next.token);
 assert.equal(claimed.session,activeKey);
});

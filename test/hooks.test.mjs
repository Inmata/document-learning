import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Library} from '../src/library.mjs';
import {handleHook,sessionKey} from '../src/hooks.mjs';

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
    await submit({phase:'complete',rules:[],skills:[]});
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

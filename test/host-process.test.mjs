import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Library} from '../src/library.mjs';
import {sessionKey} from '../src/hooks.mjs';

const cli=fileURLToPath(new URL('../bin/document-learning.mjs',import.meta.url));
function invoke(base,args,input) {
  return new Promise((resolve,reject)=>{
    const env={...process.env,DOCUMENT_LEARNING_HOME:base};delete env.DOCUMENT_LEARNING_WORKER;
    const child=spawn(process.execPath,[cli,...args],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',err='';
    child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);child.on('error',reject);
    child.on('close',code=>{if(code!==0)return reject(new Error(err));try{resolve(JSON.parse(out));}catch(e){reject(e);}});child.stdin.end(JSON.stringify(input));
  });
}
for(const agent of ['codex','claude'])test(`${agent} 原生 JSON 协议完整经过独立进程、信号输出与回执保存`,async t=>{
  const base=await mkdtemp(join(tmpdir(),'doc-native-process-'));t.after(()=>rm(base,{recursive:true,force:true}));
  const event={session_id:'fixture-native',cwd:'/fixture',turn_id:'t'};
  const hook=(name,extra={})=>invoke(base,['hook','--agent',agent],{...event,hook_event_name:name,...extra});
  await hook('SessionStart');await hook('UserPromptSubmit',{prompt:'本次不加图注'});
  const lib=await Library.open(join(base,'library'),{create:false}),key=sessionKey(agent,event.session_id);
  const turn=(await lib.read()).sessions[key].current;
  const send=async packet=>hook('PostToolUse',{tool_name:'Bash',tool_response:{output:JSON.stringify(await invoke(base,['signal'],{session:key,turn:turn.id,token:turn.token,...packet}))}});
  await send({phase:'begin',document:true,context:{task:'fixture',kind:'report'}});
  const source=(await lib.read()).sessions[key].current.source;
  const rejected=await send({phase:'complete',skillDecision:{action:'no-change',reason:'局部偏好'},rules:[{key:'figure.caption',value:'none',text:'本次不加图注',category:'preference',strength:'default',scope:'fixture',evidence:[{source,quote:'本次不加图注'}]}]});
  assert.equal(rejected.hookSpecificOutput.hookEventName,'PostToolUse');assert.match(rejected.hookSpecificOutput.additionalContext,/scope 是对象/);assert.equal((await lib.read()).sessions[key].current.receipt,'in-progress');
  await send({phase:'complete',skillDecision:{action:'no-change',reason:'仅当前报告的局部图注偏好，无独立新制作流程'},rules:[{key:'figure.caption',value:'none',text:'本次不加图注',category:'preference',strength:'required',scope:{task:'fixture'},evidence:[{source,quote:'本次不加图注'}]}]});
  assert.deepEqual(await hook('Stop'),{});
  const state=await lib.read();assert.equal(state.rules.length,1);assert.equal(state.sessions[key].current.receipt,'complete');
});

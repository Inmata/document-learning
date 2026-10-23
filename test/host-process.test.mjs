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
function invoke(base,args,input,extra={}) {
  return new Promise((resolve,reject)=>{
    const env={...process.env,DOCUMENT_LEARNING_HOME:base,DOCUMENT_LEARNING_NO_TRIGGER:'1',...extra};if(!extra.DOCUMENT_LEARNING_WORKER)delete env.DOCUMENT_LEARNING_WORKER;
    const child=spawn(process.execPath,[cli,...args],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',err='';
    child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);child.on('error',reject);
    child.on('close',code=>{if(code!==0)return reject(new Error(err));try{resolve(JSON.parse(out));}catch(e){reject(e);}});child.stdin.end(JSON.stringify(input));
  });
}
for(const agent of ['codex','claude'])test(`${agent} 原生 JSON 协议经过独立进程：登记请求与简短指导，hook 出错不阻断宿主`,async t=>{
  const base=await mkdtemp(join(tmpdir(),'doc-native-process-'));t.after(()=>rm(base,{recursive:true,force:true}));
  const event={session_id:'fixture-native',cwd:'/fixture',turn_id:'t'};
  const hook=(name,extra={},env)=>invoke(base,['hook','--agent',agent],{...event,hook_event_name:name,...extra},env);
  assert.equal((await hook('SessionStart')).hookSpecificOutput.hookEventName,'SessionStart');
  const prompt=await hook('UserPromptSubmit',{prompt:'本次不加图注'});
  assert.match(prompt.hookSpecificOutput.additionalContext,/remember/);
  const lib=await Library.open(join(base,'library'),{create:false}),key=sessionKey(agent,event.session_id);
  assert.equal((await lib.read()).sessions[key].current.prompt,'本次不加图注');
  assert.deepEqual(await hook('SessionEnd'),{});
  // 整理器子进程里的 hook 直接放行。
  assert.deepEqual(await hook('UserPromptSubmit',{prompt:'worker'},{DOCUMENT_LEARNING_WORKER:'1'}),{});
  // 缺少会话标识等错误只写 stderr，标准输出仍是空对象。
  assert.deepEqual(await invoke(base,['hook','--agent',agent],{hook_event_name:'UserPromptSubmit'}),{});
});

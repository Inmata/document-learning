import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {runProcess} from '../src/provider.mjs';
import {readJson,writeJson} from '../src/io.mjs';

const cli=fileURLToPath(new URL('../bin/document-learning.mjs',import.meta.url));
const env={DOCUMENT_LEARNING_NO_TRIGGER:'1'};
const run=(dir,args,input='')=>runProcess(process.execPath,[cli,...args,'--home',dir],input,{worker:false,environment:env});
// runProcess 只返回 stdout；这里需要同时检查 hook 写到 stderr 的配置错误。
const capture=(dir,args,input)=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[cli,...args,'--home',dir],{env:{...process.env,...env},windowsHide:true});
  let stdout='',stderr='';
  child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  child.on('error',reject);
  child.on('close',code=>code===0?resolve({stdout,stderr}):reject(new Error(`退出 ${code}：${stderr}`)));
  child.stdin.end(input);
});

test('真实 CLI：hook 登记请求，remember 引用原话入库，proposals/promote 走用户确认',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'doc-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const hook=async(name,rest={})=>JSON.parse(await run(dir,['hook','--agent','claude'],JSON.stringify({session_id:'host',cwd:dir,turn_id:'one',hook_event_name:name,...rest})));
  await hook('SessionStart',{source:'startup'});
  const guidance=(await hook('UserPromptSubmit',{prompt:'记住：实验报告的结论段先写数据再写判断'})).hookSpecificOutput.additionalContext;
  const session=guidance.match(/--session ([\w-]+)/)[1];
  await assert.rejects(run(dir,['remember','--session',session,'--text','结论先写数据','--quote','编造的话','--kind','experiment-report']),/逐字|引文|原文/);
  const remembered=JSON.parse(await run(dir,['remember','--session',session,'--text','实验报告的结论段先写数据再写判断','--quote','实验报告的结论段先写数据再写判断','--category','method','--scope','{"kind":"experiment-report"}']));
  assert.equal(remembered.changes[0].action,'create');
  assert.ok(remembered.manuals.includes('knowledge/experiment-report.md'));
  assert.match(await readFile(join(dir,'library','knowledge','experiment-report.md'),'utf8'),/结论段先写数据/);
  assert.deepEqual(JSON.parse(await run(dir,['proposals'])),[]);
  await assert.rejects(run(dir,['promote','--id','missing']),/--confirm-source/);
  await assert.rejects(run(dir,['promote','--id','missing','--confirm-source','x']),/不存在或已处理/);
});

test('consolidate --if-due 在没有待整理会话时不调用模型；配置错误指出字段',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'doc-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const home=join(dir,'user');
  const result=JSON.parse(await runProcess(process.execPath,[cli,'consolidate','--if-due','--home',dir],'',{worker:false,environment:{...env,USERPROFILE:home,HOME:home}}));
  assert.equal(result.status,'not-due');
  await writeJson(join(dir,'config.json'),{consolidate:{minSessions:0}});
  await assert.rejects(run(dir,['consolidate','--if-due']),/consolidate\.minSessions/);
  assert.equal((await readJson(join(dir,'config.json'))).consolidate.minSessions,0);
});

test('已退役的 signal/recover 命令不再可用',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'doc-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const command of ['signal','recover'])await assert.rejects(run(dir,[command]),/未知命令/);
});

test('hook 配置无效时回退默认配置继续处理，错误只写 stderr',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'doc-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeJson(join(dir,'config.json'),{hooks:{documentSkills:['docx',1]}});
  const {stdout,stderr}=await capture(dir,['hook','--agent','claude'],JSON.stringify({session_id:'host',cwd:dir,hook_event_name:'SessionStart',source:'startup'}));
  const output=JSON.parse(stdout);
  assert.match(output.hookSpecificOutput.additionalContext,/后台批量整理/);
  assert.match(stderr,/hooks\.documentSkills/);
  // 其他命令保持原样：配置错误直接报错退出。
  await assert.rejects(run(dir,['catalog']),/hooks\.documentSkills/);
});

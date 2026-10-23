import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Library} from '../src/library.mjs';
import {handleHook,sessionKey,guidance,SESSION_LIMIT} from '../src/hooks.mjs';
import {writeJson} from '../src/io.mjs';

async function setup(t) {
  const root=await mkdtemp(join(tmpdir(),'doc-hooks-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const library=await Library.open(root),triggers=[];
  const hook=(agent,event)=>handleHook(library,agent,event,{trigger:()=>triggers.push(event.hook_event_name)});
  return {root,library,hook,triggers};
}
const base={session_id:'abc',cwd:'D:/work',turn_id:'one'};

test('普通会话只得到一行简短指导，不要求逐轮提交学习信号',async t=>{
  const {library,hook,triggers}=await setup(t);
  const start=await hook('claude',{...base,hook_event_name:'SessionStart',source:'startup'});
  assert.match(start.hookSpecificOutput.additionalContext,/后台批量整理/);
  const prompt=await hook('claude',{...base,hook_event_name:'UserPromptSubmit',prompt:'修复插件里的单元测试'});
  const key=sessionKey('claude','abc'),text=prompt.hookSpecificOutput.additionalContext;
  assert.equal(text,guidance(key));assert.ok(text.length<200);assert.match(text,/remember/);assert.doesNotMatch(text,/signal|票据|begin|complete/);
  const state=await library.read();assert.equal(state.sessions[key].current.prompt,'修复插件里的单元测试');
  assert.deepEqual(await hook('claude',{...base,hook_event_name:'Stop'}),{});
  assert.deepEqual(await hook('claude',{...base,hook_event_name:'SessionEnd'}),{});
  assert.deepEqual(triggers,['SessionStart','SessionEnd']);
});

test('SessionStart 提示待确认的晋升提案，超过 3 天未整理时提示检查',async t=>{
  const {root,library,hook}=await setup(t);
  await library.transact('seed',state=>{state.proposals=[{id:'p',status:'pending',from:[],scope:{},text:'x',strength:'default'}];state.inbox={'claude:x':{at:'2026-01-01T00:00:00Z',users:1}};});
  await writeJson(join(root,'history','consolidations','last.json'),{at:'2026-01-01T00:00:00Z'});
  const text=(await hook('codex',{...base,hook_event_name:'SessionStart'})).hookSpecificOutput.additionalContext;
  assert.match(text,/1 条经验晋升提案待确认/);assert.match(text,/超过 3 天未运行/);
});

test('问答证据只接收用户实际选择，不接收问题、空答、拒答、超时及其他工具的相似输出',async t=>{
  const {library,hook}=await setup(t);
  await hook('claude',{...base,hook_event_name:'UserPromptSubmit',prompt:'整理报告'});
  const event={...base,hook_event_name:'PostToolUse',tool_name:'AskUserQuestion',tool_input:{questions:[{question:'图表怎么处理？',options:[{label:'只用表格'},{label:'加趋势图'}]}]}};
  for(const response of [{answers:{}},{answers:{'图表怎么处理？':''}},{answers:{'图表怎么处理？':'只用表格'},afkTimeoutMs:1000},{answers:[{question:'图表怎么处理？',selected:['只用表格']}],declined:true},{answers:{'其他问题':'只用表格'}},{isError:true,answers:{'图表怎么处理？':'只用表格'}}])await hook('claude',{...event,tool_response:response});
  await hook('claude',{...event,tool_name:'Read',tool_response:{answers:{'图表怎么处理？':'只用表格'}}});
  assert.equal(Object.keys((await library.read()).sources).length,0);
  const output=await hook('claude',{...event,tool_use_id:'actual',tool_response:{content:[{type:'text',text:JSON.stringify({answers:{'图表怎么处理？':'只用表格'}})}]}});
  const sources=Object.values((await library.read()).sources);
  assert.equal(sources.length,1);assert.equal(sources[0].text,'只用表格');assert.equal(sources[0].role,'user');
  assert.match(output.hookSpecificOutput.additionalContext,new RegExp(sources[0].id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  // 同一工具调用重复回调不重复登记。
  assert.deepEqual(await hook('claude',{...event,tool_use_id:'actual',tool_response:{answers:{'图表怎么处理？':'只用表格'}}}),{});
});

test('宿主后台调用不建立会话、不注入指导、不触发整理',async t=>{
  const {library,hook,triggers}=await setup(t);
  const background={session_id:'bg',cwd:'D:/work',turn_id:'bg-turn',transcript_path:null};
  assert.deepEqual(await hook('codex',{...background,hook_event_name:'SessionStart',source:'startup'}),{});
  assert.deepEqual(await hook('codex',{...background,hook_event_name:'UserPromptSubmit',prompt:'建议下一次编辑'}),{});
  assert.deepEqual(await hook('codex',{...background,hook_event_name:'SessionEnd'}),{});
  const state=await library.read();
  assert.deepEqual(state.sessions,{});assert.deepEqual(state.sources,{});assert.equal(state.background.count,1);assert.deepEqual(triggers,[]);
});

test('transcript_path 字段缺失时按普通会话处理',async t=>{
  const {library,hook}=await setup(t);
  const result=await hook('codex',{...base,session_id:'legacy',hook_event_name:'UserPromptSubmit',prompt:'本次不要图注'});
  assert.equal(typeof result.hookSpecificOutput.additionalContext,'string');
  assert.equal((await library.read()).sessions[sessionKey('codex','legacy')].current.id,'one');
});

test('会话状态按容量修剪，保留当前会话',async t=>{
  const {library,hook}=await setup(t);
  await library.transact('seed-sessions',state=>{for(let i=0;i<SESSION_LIMIT+5;i++)state.sessions[`codex-seed-${i}`]={agent:'codex',id:`seed-${i}`,lastSeen:`2026-01-${String(i+1).padStart(2,'0')}T00:00:00.000Z`};});
  await hook('codex',{session_id:'fresh',hook_event_name:'UserPromptSubmit',prompt:'新需求',cwd:'D:/work'});
  const keys=Object.keys((await library.read()).sessions);
  assert.equal(keys.length,SESSION_LIMIT);assert.ok(keys.includes(sessionKey('codex','fresh')));
  for(let i=0;i<6;i++)assert.equal(keys.includes(`codex-seed-${i}`),false);
});

test('Codex request_user_input 的答案按问题 id 对回问题，user_note 去掉前缀',async t=>{
  const {library,hook}=await setup(t);
  await hook('codex',{...base,hook_event_name:'UserPromptSubmit',prompt:'整理报告'});
  const questions=[{header:'晋升',id:'promote_core',question:'是否晋升为通用经验？',options:[{label:'晋升',description:'所有文档适用'},{label:'不晋升',description:'保持原范围'}]}];
  const output=await hook('codex',{...base,hook_event_name:'PostToolUse',tool_name:'request_user_input',tool_use_id:'call_1',tool_input:JSON.stringify({questions}),tool_response:JSON.stringify({answers:{promote_core:{answers:['晋升','user_note: 报告和说明书都适用']}}})});
  const [source]=Object.values((await library.read()).sources);
  assert.equal(source.question,'是否晋升为通用经验？');assert.equal(source.text,'晋升\n报告和说明书都适用');assert.equal(source.origin,'user-question');
  assert.match(output.hookSpecificOutput.additionalContext,/已登记用户回答/);
  // 未知 id 与空答案不登记。
  await hook('codex',{...base,hook_event_name:'PostToolUse',tool_name:'request_user_input_async',tool_use_id:'call_2',tool_input:{questions},tool_response:{answers:{other:{answers:['晋升']},promote_core:{answers:[]}}}});
  assert.equal(Object.keys((await library.read()).sources).length,1);
});

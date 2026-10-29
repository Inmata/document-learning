import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Library} from '../src/library.mjs';
import {handleHook,sessionKey,SESSION_LIMIT} from '../src/hooks.mjs';
import {manualRoot} from '../src/catalog.mjs';
import {writeJson} from '../src/io.mjs';

async function setup(t) {
  const root=await mkdtemp(join(tmpdir(),'doc-hooks-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const library=await Library.open(root),triggers=[];
  const hook=(agent,event)=>handleHook(library,agent,event,{trigger:()=>triggers.push(event.hook_event_name)});
  return {root,library,hook,triggers};
}
async function manuals(library,names=['core.md','experiment-report.md','conditional.md','index.md','memory.json']) {
  const root=manualRoot(library);await mkdir(root,{recursive:true});
  for(const name of names)await writeFile(join(root,name),`# ${name}\n`);
  return root;
}
const base={session_id:'abc',cwd:'D:/work',turn_id:'one'};

test('普通会话只得到一行简短指导，不要求逐轮提交学习信号',async t=>{
  const {library,hook,triggers}=await setup(t);
  const start=await hook('claude',{...base,hook_event_name:'SessionStart',source:'startup'});
  assert.match(start.hookSpecificOutput.additionalContext,/后台批量整理/);
  const prompt=await hook('claude',{...base,hook_event_name:'UserPromptSubmit',prompt:'修复插件里的单元测试'});
  const key=sessionKey('claude','abc'),text=prompt.hookSpecificOutput.additionalContext;
  assert.ok(text.includes(`--session ${key}`));assert.ok(text.length<260);assert.match(text,/remember/);assert.ok(text.includes(join(manualRoot(library),'core.md')));assert.doesNotMatch(text,/signal|票据|begin|complete/);
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

test('Claude 进入文档技能时提醒读手册，读过手册后同一会话不再提醒',async t=>{
  const {library,hook}=await setup(t);
  const root=await manuals(library);
  await hook('claude',{...base,hook_event_name:'UserPromptSubmit',prompt:'生成 Word 文档'});
  const output=await hook('claude',{...base,hook_event_name:'PostToolUse',tool_name:'Skill',tool_input:{skill:'docx'}});
  const text=output.hookSpecificOutput.additionalContext;
  assert.match(text,/docx/);assert.ok(text.includes(join(root,'core.md')));assert.ok(text.includes(join(root,'experiment-report.md')));assert.ok(text.includes(join(root,'conditional.md')));
  assert.doesNotMatch(text,/index\.md|memory\.json/);
  assert.deepEqual(await hook('claude',{...base,hook_event_name:'PostToolUse',tool_name:'Read',tool_input:{file_path:join(root,'core.md')}}),{});
  assert.ok((await library.read()).sessions[sessionKey('claude','abc')].manualRead);
  assert.deepEqual(await hook('claude',{...base,hook_event_name:'PostToolUse',tool_name:'Skill',tool_input:{skill:'docx'}}),{});
});

test('Claude 技能名可带插件前缀；非文档技能与 document-learning 自身不提醒',async t=>{
  const {library,hook}=await setup(t);
  await manuals(library);
  await hook('claude',{...base,hook_event_name:'UserPromptSubmit',prompt:'生成演示文稿'});
  const prefixed=await hook('claude',{...base,hook_event_name:'PostToolUse',tool_name:'Skill',tool_input:{skill:'document-skills:pptx'}});
  assert.match(prefixed.hookSpecificOutput.additionalContext,/pptx/);
  for(const skill of ['other-skill','document-learning'])assert.deepEqual(await hook('claude',{...base,hook_event_name:'PostToolUse',tool_name:'Skill',tool_input:{skill}}),{});
});

test('没有会话记录时文档技能事件直接返回',async t=>{
  const {library,hook}=await setup(t);
  await manuals(library);
  assert.deepEqual(await hook('claude',{...base,hook_event_name:'PostToolUse',tool_name:'Skill',tool_input:{skill:'docx'}}),{});
  assert.deepEqual(await hook('codex',{...base,hook_event_name:'PostToolUse',tool_name:'Bash',tool_input:{command:'cat docx/SKILL.md'}}),{});
});

test('Codex 通过 shell 或读文件工具读取 SKILL.md 时提醒，读取手册后标记已读',async t=>{
  const {library,hook}=await setup(t);
  const root=await manuals(library);
  await hook('codex',{...base,hook_event_name:'UserPromptSubmit',prompt:'生成报告'});
  const shell=await hook('codex',{...base,hook_event_name:'PostToolUse',tool_name:'Bash',tool_input:{command:'Get-Content "D:\\skills\\docx\\SKILL.md"'}});
  assert.match(shell.hookSpecificOutput.additionalContext,/docx/);assert.ok(shell.hookSpecificOutput.additionalContext.includes(join(root,'core.md')));
  assert.deepEqual(await hook('codex',{...base,hook_event_name:'PostToolUse',tool_name:'exec_command',tool_input:{command:['cat','"'+join(root,'core.md')+'"']}}),{});
  assert.ok((await library.read()).sessions[sessionKey('codex','abc')].manualRead);
  assert.deepEqual(await hook('codex',{...base,hook_event_name:'PostToolUse',tool_name:'shell',tool_input:{command:`type "${join(root,'core.md')}"`}}),{});
  // 读文件类工具带路径时同样识别。
  const fileTool=await hook('codex',{...base,session_id:'file-tool',hook_event_name:'UserPromptSubmit',prompt:'生成幻灯片'});
  assert.ok(fileTool.hookSpecificOutput.additionalContext);
  const read=await hook('codex',{...base,session_id:'file-tool',hook_event_name:'PostToolUse',tool_name:'read_file',tool_input:{path:'C:\\skills\\pptx\\SKILL.md'}});
  assert.match(read.hookSpecificOutput.additionalContext,/pptx/);
});

test('个人技能目录中的技能也按文档技能提醒',async t=>{
  const {root,library,hook}=await setup(t);
  library.skillDirectory=join(root,'personal');
  const manual=await manuals(library);
  await mkdir(join(library.skillDirectory,'custom-report'),{recursive:true});
  await writeFile(join(library.skillDirectory,'custom-report','SKILL.md'),'# custom\n');
  await hook('claude',{...base,hook_event_name:'UserPromptSubmit',prompt:'按我的技能写报告'});
  const output=await hook('claude',{...base,hook_event_name:'PostToolUse',tool_name:'Skill',tool_input:{skill:'custom-report'}});
  assert.match(output.hookSpecificOutput.additionalContext,/custom-report/);
  assert.ok(output.hookSpecificOutput.additionalContext.includes(join(manual,'core.md')));
});

test('缺少 core.md 时提醒仍先给 core.md 路径，再列出实际存在的类型手册',async t=>{
  const {library,hook}=await setup(t);
  await hook('claude',{...base,hook_event_name:'UserPromptSubmit',prompt:'生成报告'});
  // 手册目录不存在。
  const missing=(await hook('claude',{...base,hook_event_name:'PostToolUse',tool_name:'Skill',tool_input:{skill:'docx'}})).hookSpecificOutput.additionalContext;
  assert.ok(missing.includes(`"${join(manualRoot(library),'core.md')}"`));
  // 只有类型手册，没有 core.md，index.md 不算类型手册。
  const manual=await manuals(library,['experiment-report.md','index.md']);
  await hook('claude',{...base,session_id:'typed',hook_event_name:'UserPromptSubmit',prompt:'生成报告'});
  const typed=(await hook('claude',{...base,session_id:'typed',hook_event_name:'PostToolUse',tool_name:'Skill',tool_input:{skill:'docx'}})).hookSpecificOutput.additionalContext;
  assert.ok(typed.indexOf(join(manual,'core.md'))>=0);
  assert.ok(typed.includes(join(manual,'experiment-report.md')));
  assert.doesNotMatch(typed,/index\.md/);
});

test('只有读取命令的路径参数才算读手册：ls、echo、..、相邻目录都不标记',async t=>{
  const {root,library,hook}=await setup(t);
  const manual=await manuals(library);
  await mkdir(join(root,'knowledge2'),{recursive:true});
  await writeFile(join(root,'knowledge2','core.md'),'# 相邻目录\n');
  const key=sessionKey('codex','abc');
  await hook('codex',{...base,hook_event_name:'UserPromptSubmit',prompt:'生成报告'});
  for(const command of [`ls "${manual}"`,`echo "${join(manual,'core.md')}"`,`Write-Output "${join(manual,'core.md')}"`,`cat "${join(manual,'..','other.md')}"`,`cat "${join(root,'knowledge2','core.md')}"`])
    assert.deepEqual(await hook('codex',{...base,hook_event_name:'PostToolUse',tool_name:'shell',tool_input:{command}}),{},command);
  assert.equal((await library.read()).sessions[key].manualRead,undefined);
  assert.deepEqual(await hook('codex',{...base,hook_event_name:'PostToolUse',tool_name:'shell',tool_input:{command:`ls "${join(root,'skills','docx','SKILL.md')}"`}}),{});
  assert.deepEqual(await hook('codex',{...base,hook_event_name:'PostToolUse',tool_name:'shell',tool_input:{command:`Get-ChildItem "${join(root,'skills','docx','SKILL.md')}"`}}),{});
  // 真正读取后才标记，同一会话不再提醒。
  assert.deepEqual(await hook('codex',{...base,hook_event_name:'PostToolUse',tool_name:'shell',tool_input:{command:`cat "${join(manual,'core.md')}"`}}),{});
  assert.ok((await library.read()).sessions[key].manualRead);
});

test('相对路径按 event.cwd 解析：手册内 cat core.md、父目录 cat knowledge/core.md 都标记已读',async t=>{
  const {root,library,hook}=await setup(t);
  const manual=await manuals(library);
  await hook('codex',{session_id:'inside',cwd:manual,hook_event_name:'UserPromptSubmit',prompt:'生成报告'});
  await hook('codex',{session_id:'inside',cwd:manual,hook_event_name:'PostToolUse',tool_name:'shell',tool_input:{command:'cat core.md'}});
  assert.ok((await library.read()).sessions[sessionKey('codex','inside')].manualRead);
  await hook('codex',{session_id:'above',cwd:root,hook_event_name:'UserPromptSubmit',prompt:'生成报告'});
  await hook('codex',{session_id:'above',cwd:root,hook_event_name:'PostToolUse',tool_name:'shell',tool_input:{command:'cat knowledge/core.md'}});
  assert.ok((await library.read()).sessions[sessionKey('codex','above')].manualRead);
});

test('Codex 字符串与数组命令载荷都识别 SKILL.md，相对技能路径取父目录名',async t=>{
  const {library,hook}=await setup(t);
  await manuals(library);
  await hook('codex',{...base,hook_event_name:'UserPromptSubmit',prompt:'生成报告'});
  const string=await hook('codex',{...base,hook_event_name:'PostToolUse',tool_name:'shell',tool_input:{command:'cat docx/SKILL.md'}});
  assert.match(string.hookSpecificOutput.additionalContext,/docx/);
  const array=await hook('codex',{...base,hook_event_name:'PostToolUse',tool_name:'exec_command',tool_input:{command:['cat','C:\\skills\\pptx\\SKILL.md']}});
  assert.match(array.hookSpecificOutput.additionalContext,/pptx/);
});

test('PowerShell -Path/-LiteralPath 与 &&、| 串联的命令按段识别路径参数',async t=>{
  const {library,hook}=await setup(t);
  const manual=await manuals(library);
  const post=(session,command)=>hook('codex',{...base,session_id:session,hook_event_name:'PostToolUse',tool_name:'shell',tool_input:{command}});
  for(const [session,command] of [
    ['path-flag',`Get-Content -Path "${join(manual,'core.md')}"`],
    ['literal-path',`Get-Content -LiteralPath:${join(manual,'core.md')}`],
    ['chained',`echo hi && cat "${join(manual,'core.md')}" | head -n 5`]
  ]) {
    await hook('codex',{...base,session_id:session,hook_event_name:'UserPromptSubmit',prompt:'生成报告'});
    await post(session,command);
    assert.ok((await library.read()).sessions[sessionKey('codex',session)].manualRead,command);
  }
  // 搜索表达式的第一个非选项参数不是文件。
  await hook('codex',{...base,session_id:'grep-pattern',cwd:manual,hook_event_name:'UserPromptSubmit',prompt:'生成报告'});
  await hook('codex',{...base,session_id:'grep-pattern',cwd:manual,hook_event_name:'PostToolUse',tool_name:'shell',tool_input:{command:'grep core.md'}});
  assert.equal((await library.read()).sessions[sessionKey('codex','grep-pattern')].manualRead,undefined);
});

test('Claude 的 Bash/PowerShell 通过 shell 读取手册也标记已读，但技能触发仍只看 Skill 工具',async t=>{
  const {library,hook}=await setup(t);
  const manual=await manuals(library);
  await hook('claude',{...base,hook_event_name:'UserPromptSubmit',prompt:'生成报告'});
  await hook('claude',{...base,hook_event_name:'PostToolUse',tool_name:'PowerShell',tool_input:{command:`Get-Content -LiteralPath "${join(manual,'core.md')}"`}});
  assert.ok((await library.read()).sessions[sessionKey('claude','abc')].manualRead);
  await hook('claude',{...base,session_id:'skill-via-shell',hook_event_name:'UserPromptSubmit',prompt:'生成报告'});
  assert.deepEqual(await hook('claude',{...base,session_id:'skill-via-shell',hook_event_name:'PostToolUse',tool_name:'Bash',tool_input:{command:'cat docx/SKILL.md'}}),{});
});

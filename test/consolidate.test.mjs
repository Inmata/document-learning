import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,appendFile,readFile,utimes} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Library,syncMemoryFromSkillDirectory} from '../src/library.mjs';
import {normalizeJsonl} from '../src/history.mjs';
import {validateConfig} from '../src/config.mjs';
import {scanTranscripts,applyScan,excluded} from '../src/scan.mjs';
import {runConsolidation,isDue} from '../src/consolidate.mjs';
import {isWorkerSession} from '../src/scan.mjs';
import {createJudge} from '../src/judge.mjs';
import {addSources,mergeLearning,applyPromotion,validatePromotion,retireRules} from '../src/knowledge.mjs';
import {buildManuals} from '../src/catalog.mjs';
import {remember} from '../src/remember.mjs';
import {withLock} from '../src/io.mjs';

// 测试目录位于临时目录（可能含 Temp 或 codeg-acp），默认排除规则会跳过它们，这里换成不会命中的模式。
const config=validateConfig({sources:{excludePaths:['*never-match-fixture*']}});
const line=(session,uuid,text,cwd='D:/docs')=>`${JSON.stringify({type:'user',sessionId:session,cwd,uuid,timestamp:'2026-10-01T00:00:00Z',message:{role:'user',content:text}})}\n`;
const reply=(session,uuid,text)=>`${JSON.stringify({type:'assistant',sessionId:session,uuid,message:{role:'assistant',content:[{type:'text',text}]}})}\n`;
async function setup(t) {
 const dir=await mkdtemp(join(tmpdir(),'doc-consolidate-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const userHome=join(dir,'home'),project=join(userHome,'.claude','projects','D--docs');
 await mkdir(project,{recursive:true});
 const library=await Library.open(join(dir,'library'));
 // 已有水位表示不是首次扫描，避免基线跳过测试文件。
 await library.transact('seed-scan',state=>{state.scan={};});
 const write=(name,text)=>writeFile(join(project,`${name}.jsonl`),text);
 return {dir,userHome,project,library,write};
}

test('扫描水位：未变不重复入队，追加无用户行只推进水位，截断后从头开始',async t=>{
 const {userHome,project,library,write}=await setup(t);
 const path=join(project,'a.jsonl');
 await write('a',line('a','u1','把实验报告的图注改成表格下方'));
 const scan=async()=>{const s=await scanTranscripts(await library.read(),{config,userHome,libraryRoot:library.root});const {result}=await library.transact('scan',state=>applyScan(state,s));return {s,added:result};};
 let {s,added}=await scan();
 assert.deepEqual(added,['claude:a']);assert.equal(s.sessions[0].users,1);
 ({s,added}=await scan());assert.equal(s.skipped.unchanged,1);assert.deepEqual(added,[]);
 // 整理后清空收件箱，再追加助手回复：只推进水位，不重新入队。
 await library.transact('done',state=>{state.transcripts['claude:a'].processedUsers=1;delete state.inbox['claude:a'];});
 await appendFile(path,reply('a','r1','已修改'));
 ({s,added}=await scan());assert.equal(s.skipped.noUser,1);assert.deepEqual(added,[]);
 assert.equal((await library.read()).scan[path].offset,(await readFile(path)).length);
 await appendFile(path,line('a','u2','图注字号也改小'));
 ({s,added}=await scan());assert.deepEqual(added,['claude:a']);assert.equal((await library.read()).inbox['claude:a'].users,2);
 await library.transact('done',state=>{state.transcripts['claude:a'].processedUsers=2;delete state.inbox['claude:a'];});
 // 文件被重写为更短内容：视为重建，从头处理。
 await write('a',line('a','x1','重新开始'));
 ({s,added}=await scan());assert.equal(s.sessions[0].restart,true);assert.deepEqual(added,['claude:a']);
 assert.equal((await library.read()).transcripts['claude:a'].processedUsers,0);
});

test('扫描跳过排除路径、整理器会话、空会话，首次扫描只记录旧文件水位',async t=>{
 const {userHome,project,library,write}=await setup(t);
 await write('worker',line('w','u','{"mode":"consolidation","sessions":[]}'));
 await write('excluded',line('e','u','普通请求','C:/work/never-match-fixture/x'));
 await write('empty',reply('n','r','只有助手'));
 await write('normal',line('n2','u','写一份现场报告'));
 const s=await scanTranscripts(await library.read(),{config,userHome,libraryRoot:library.root});
 assert.deepEqual(s.sessions.map(x=>x.id),['claude:n2']);
 assert.equal(s.skipped.worker,1);assert.equal(s.skipped.excluded,1);
 assert.ok(excluded('C:\\Users\\me\\AppData\\Local\\Temp\\x.jsonl',validateConfig({}).sources.excludePaths));
 const old=join(project,'normal.jsonl'),past=new Date(Date.now()-30*864e5);await utimes(old,past,past);
 const fresh=await scanTranscripts({scan:undefined},{config,userHome,libraryRoot:library.root});
 assert.equal(fresh.updates[old].baseline,true);assert.equal(fresh.sessions.some(x=>x.path===old),false);
});

test('if-due：未到阈值不调用模型，锁被占用时直接退出，超时后仍会整理',async t=>{
 const {userHome,library,write}=await setup(t);
 await write('a',line('a','u1','写报告'));
 const never=async()=>{throw new Error('不应调用模型');};
 const judge={available:false,reason:'test'};
 assert.equal((await runConsolidation(library,{config,learner:never,judge,userHome})).status,'not-due');
 assert.equal(Object.keys((await library.read()).inbox).length,1);
 let inner;
 await withLock(join(library.root,'history','consolidations'),async()=>{inner=await runConsolidation(library,{config,learner:never,judge,userHome});});
 assert.equal(inner.status,'locked');
 const state=await library.read(),entry=Object.values(state.inbox)[0];
 assert.equal(isDue(state,null,config,Date.parse(entry.at)+25*36e5),true);
 assert.equal(isDue(state,{at:new Date().toISOString()},config,Date.now()),false);
});

function seedRules(state,tasks,{key='text.blocks',text='避免大段文字堆积',kind='experiment-report'}={}) {
 const sources=tasks.map(task=>({id:`${task}/u`,role:'user',text:`${text}，多用表格`,task,origin:'conversation',context:{task,kind,workspace:'D:/docs'}}));
 addSources(state,sources);
 return tasks.map(task=>mergeLearning(state,{rules:[{key:`${key}.${task}`,value:'on',text,category:'method',strength:'default',scope:{task},evidence:[{source:`${task}/u`,quote:text}]}]})[0].id);
}

test('整理：假模型合并证据、提出晋升，首次无效输出经修复重试后写入',async t=>{
 const {userHome,library,write}=await setup(t);
 let existing;
 await library.transact('seed',state=>{existing=seedRules(state,['r1','r2']);});
 await write('d3',line('d3','m1','r1 这份实验报告继续避免大段文字堆积')+reply('d3','a1','好的'));
 await write('code',line('code','m2','修复插件的单元测试'));
 const calls=[];
 const learner=async request=>{
  calls.push(request);
  const doc=request.sessions.find(s=>s.id==='claude:d3'),code=request.sessions.find(s=>s.id==='claude:code');
  assert.ok(request.knowledge.some(k=>k.id===existing[0]&&k.tier==='doc'));
  const sessions=[{id:doc.id,document:true,task:'r1',kind:'experiment-report'},{id:code.id,document:false}];
  const evidence=[{source:'m1',quote:calls.length===1?'杜撰的原话':'避免大段文字堆积'}];
  return {sessions,rules:[],attach:[{id:existing[0],evidence}],observations:[],promote:[{from:existing,scope:{kind:'experiment-report'},text:'实验报告避免大段文字堆积',strength:'default',reason:'两份报告'}]};
 };
 const result=await runConsolidation(library,{config,learner,judge:{available:false,reason:'test'},userHome,mode:'now'});
 assert.equal(result.status,'consolidated');assert.equal(calls.length,2);assert.match(calls[1].repair.validationError,/引文|原文|quote|证据/);
 const state=await library.read();
 assert.deepEqual(state.inbox,{});
 assert.equal(state.rules.find(r=>r.id===existing[0]).evidence.length,2);
 assert.equal(state.sources.m1.task,'r1');assert.equal(state.sources.m2,undefined,'未被引用的消息不入库');
 assert.equal(state.transcripts['claude:code'].document,false);assert.equal(state.transcripts['claude:d3'].task,'r1');
 assert.equal(state.proposals.length,1);assert.equal(state.proposals[0].status,'pending');assert.equal(state.proposals[0].support,2);
 const report=await readFile(result.report,'utf8');assert.match(report,/未启用 Jev/);assert.match(report,/合并证据 1 条/);
 // 再跑一次：没有新会话，不调用模型。
 assert.equal((await runConsolidation(library,{config,learner:async()=>{throw new Error('不应调用');},judge:{available:false},userHome,mode:'now'})).status,'empty');
});

test('另一份文档的同一要求 attach 到单份文档经验时改建本文档经验，不让整轮失败',async t=>{
 const {userHome,library,write}=await setup(t);
 let existing;
 await library.transact('seed',state=>{existing=seedRules(state,['r1']);});
 await write('d9',line('d9','m9','r9 这份实验报告也要避免大段文字堆积'));
 const learner=async request=>({sessions:[{id:request.sessions[0].id,document:true,task:'r9',kind:'experiment-report'}],rules:[],attach:[{id:existing[0],evidence:[{source:'m9',quote:'避免大段文字堆积'}]}],observations:[],promote:[]});
 const result=await runConsolidation(library,{config,learner,judge:{available:false},userHome,mode:'now'});
 assert.equal(result.status,'consolidated');
 const state=await library.read(),old=state.rules.find(r=>r.id===existing[0]),fresh=state.rules.find(r=>r.scope.task==='r9');
 assert.equal(old.evidence.length,1);assert.ok(fresh);assert.equal(fresh.key,old.key);assert.equal(fresh.evidence[0].source,'m9');
 assert.match(await readFile(result.report,'utf8'),/另建单份文档经验/);
});
test('Jev 只丢弃高置信非文档会话；不可用时全部交给整理模型并注明',async t=>{
 const {userHome,library,write}=await setup(t);
 await write('doc',line('doc','m1','把这份说明书的步骤编号统一'));
 await write('code',line('code','m2','修复插件 bug'));
 await write('maybe',line('maybe','m3','看看这个'));
 const probabilities={doc:0.95,code:0.02,maybe:0.5};
 const transport={name:'fixture',ask:async({state,questions})=>({answers:Object.fromEntries(Object.entries(questions).map(([id,q])=>{
  const index=Number(id.match(/^s(\d+)/)[1]),title=state.sessions[index].user;
  if(id.endsWith('_kind'))return [id,{type:'choice',choice:'instruction',probabilities:Object.fromEntries(Object.keys(q.criteria).map(k=>[k,k==='instruction'?1:0])),confidence:0.9}];
  const p=title.includes('说明书')?probabilities.doc:(title.includes('bug')?probabilities.code:probabilities.maybe);
  return [id,{type:'choice',choice:p>=0.5?'document':'not_document',probabilities:{document:p,not_document:Number((1-p).toFixed(2))},confidence:0.9}];
 })),usage:{input_tokens:10,output_tokens:5},model:'fixture'})};
 const judge=createJudge({provider:'jev',documentThreshold:0.85,transport});
 let seen;
 const learner=async request=>{seen=request.sessions;return {sessions:request.sessions.map(s=>({id:s.id,document:false})),rules:[],attach:[],observations:[],promote:[]};};
 await runConsolidation(library,{config,learner,judge,userHome,mode:'now'});
 assert.deepEqual(seen.map(s=>s.id).sort(),['claude:doc','claude:maybe']);
 assert.equal(seen.find(s=>s.id==='claude:doc').kindHint,'instruction');
 const state=await library.read();assert.deepEqual(state.inbox,{});assert.equal(state.transcripts['claude:code'].document,false);
 // Jev 失败（无凭据）时回退。
 await write('later',line('later','m4','再改一份报告'));
 const failing=createJudge({provider:'jev',env:{}});
 const result=await runConsolidation(library,{config,learner,judge:failing,userHome,mode:'now'});
 assert.match(await readFile(result.report,'utf8'),/Jev 不可用（configuration_error）/);
 assert.match(result.processed+'', /1/);
});

test('晋升：需要用户确认、范围更宽、足够文档；来源被替代后不可复活',async t=>{
 const root=await mkdtemp(join(tmpdir(),'doc-promote-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const library=await Library.open(root);
 let ids;
 await library.transact('seed',state=>{
  ids=seedRules(state,['r1','r2']);
  state.proposals=[{id:'p1',status:'pending',from:ids,scope:{kind:'experiment-report'},text:'实验报告避免大段文字堆积',strength:'default'},{id:'p2',status:'pending',from:ids,scope:{},text:'所有文档避免大段文字',strength:'default'}];
  addSources(state,[{id:'s/answer',role:'user',text:'同意晋升',origin:'user-question',context:{}},{id:'s/assistant',role:'assistant',text:'同意',context:{}}]);
 });
 await assert.rejects(library.transact('x',state=>applyPromotion(state,'p1',['s/assistant'])),/用户的原始回答/);
 await assert.rejects(library.transact('x',state=>applyPromotion(state,'p2',['s/answer'],{minDocsForCore:3})),/至少需要 3 份/);
 await assert.rejects(library.transact('x',state=>applyPromotion(state,'p1',[{source:'s/answer',quote:'不同意'}])),/引文/);
 const state0=await library.read();
 assert.throws(()=>validatePromotion(state0,{from:ids,scope:{task:'r1'},text:'x',strength:'default'}),/单份文档/);
 const {result}=await library.transact('promote',state=>applyPromotion(state,'p1',['s/answer']));
 assert.equal(result.tier,'type');assert.equal(result.support,2);assert.deepEqual(result.superseded.sort(),[...ids].sort());
 let state=await library.read();
 const promoted=state.rules.find(r=>r.id===result.id);
 assert.equal(promoted.evidence.length,2);assert.equal(promoted.status,'active');assert.deepEqual(promoted.scope,{kind:'experiment-report'});
 for(const id of ids)assert.equal(state.rules.find(r=>r.id===id).status,'superseded');
 // 同一旧规则的重复反馈不复活旧规则，证据并入晋升后的规则。
 await library.transact('repeat',state=>{
  addSources(state,[{id:'r1/u2',role:'user',text:'还是避免大段文字堆积',task:'r1',context:{task:'r1',kind:'experiment-report'}}]);
  const changes=mergeLearning(state,{rules:[{key:'text.blocks.r1',value:'on',text:'避免大段文字堆积',category:'method',strength:'default',scope:{task:'r1'},evidence:[{source:'r1/u2',quote:'避免大段文字堆积'}]}]});
  assert.equal(changes[0].action,'skip-superseded');
 });
 state=await library.read();
 assert.equal(state.rules.find(r=>r.id===ids[0]).status,'superseded');assert.equal(state.rules.find(r=>r.id===result.id).evidence.length,3);
 await assert.rejects(library.transact('again',state=>applyPromotion(state,'p1',['s/answer'])),/已处理/);
});

test('手册：required 优先、按文档数排序、超长截断，单份文档经验只进 cases',async()=>{
 const state={rules:[],sources:{},observations:[],skills:{},proposals:[]};
 const add=(id,strength,scope,tasks,text)=>{for(const t of tasks)state.sources[`${id}/${t}`]={id:`${id}/${t}`,role:'user',task:t,text,context:{}};state.rules.push({id,status:'active',category:'method',strength,scope,text,evidence:tasks.map(t=>({source:`${id}/${t}`,quote:text}))});};
 add('a','default',{},['t1','t2','t3'],'核心默认三份');
 add('b','required',{},['t1'],'核心强制一份');
 add('c','default',{},['t1','t2','t3','t4'],'核心默认四份');
 add('d','default',{kind:'site-report',skill:'site'},['t1','t2'],'现场报告技能条目');
 add('e','required',{task:'t9'},['t9'],'单份文档参数');
 for(let i=0;i<40;i++)add(`z${i}`,'suggestion',{},['t1'],`低优先级建议 ${i} ${'x'.repeat(60)}`);
 const {files}=buildManuals(state,{maxChars:800});
 const core=files['knowledge/core.md'];
 assert.ok(core.indexOf('核心强制一份')<core.indexOf('核心默认四份'));assert.ok(core.indexOf('核心默认四份')<core.indexOf('核心默认三份'));
 assert.match(core,/- \[required·1份文档\] 核心强制一份/);
 assert.ok(core.length<=900);assert.match(core,/另有 \d+ 条较低优先级经验未列出/);
 assert.match(files['knowledge/site-report.md'],/## 技能 site[\s\S]*现场报告技能条目/);
 assert.ok(!Object.entries(files).some(([k,v])=>k.startsWith('knowledge/')&&k!=='knowledge/index.md'&&v.includes('单份文档参数')));
 assert.match(files['cases/t9.md'],/单份文档参数/);
});

test('remember：引用本轮用户原话立即入库，并更新手册',async t=>{
 const root=await mkdtemp(join(tmpdir(),'doc-remember-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const library=await Library.open(root);
 await library.transact('seed',state=>{state.sessions.k={agent:'claude',id:'x',cwd:'D:/docs',current:{id:'turn1',prompt:'记住：以后所有文档的表格都用三线表',at:'2026-10-01'}};});
 await assert.rejects(remember(library,{session:'k',text:'表格用三线表',quote:'没说过的话'}),/引文|原文|quote/);
 const result=await remember(library,{session:'k',text:'表格用三线表',quote:'以后所有文档的表格都用三线表',scopeBasis:'explicit'});
 assert.equal(result.changes[0].action,'create');
 const manual=await readFile(join(root,'knowledge','core.md'),'utf8');assert.match(manual,/表格用三线表/);
 const again=await remember(library,{session:'k',text:'表格用三线表',quote:'以后所有文档的表格都用三线表',scopeBasis:'explicit'});
 assert.equal(again.changes[0].action,'skip');assert.equal((await library.read()).rules.length,1);
});

test('配置：整理模型强度默认 high，网关地址和强度无效时指出字段',()=>{
 assert.equal(validateConfig({}).consolidate.effort,'high');
 assert.equal(validateConfig({consolidate:{baseUrl:'http://127.0.0.1:3425',apiKey:'magpie',model:'group/ds4.1flash'}}).consolidate.baseUrl,'http://127.0.0.1:3425');
 assert.throws(()=>validateConfig({consolidate:{effort:'extreme'}}),/consolidate\.effort/);
 assert.throws(()=>validateConfig({consolidate:{baseUrl:'127.0.0.1:3425'}}),/consolidate\.baseUrl/);
});

test('整理三次修复仍失败时推迟这批会话，不再每次重试；残留锁按年龄清理',async t=>{
 const {userHome,library,write}=await setup(t);
 await write('f1',line('f1','u1','写报告 f1'));
 let calls=0;
 const bad=async request=>{calls++;return {sessions:request.sessions.map(s=>({id:s.id,document:true,task:'f1',kind:'experiment-report'})),rules:[],attach:[{id:'missing',evidence:[{source:'u1',quote:'写报告'}]}],observations:[],promote:[]};};
 const judge={available:false};
 const first=await runConsolidation(library,{config,learner:bad,judge,userHome,mode:'now'});
 assert.equal(first.status,'failed');assert.equal(calls,3);
 const entry=Object.values((await library.read()).inbox)[0];assert.equal(entry.failures,1);assert.ok(entry.retryAfter);
 assert.equal((await runConsolidation(library,{config,learner:bad,judge,userHome,mode:'now'})).status,'empty');assert.equal(calls,3);
 assert.equal(isDue(await library.read(),null,config,Date.now()+12*36e5),false);assert.equal(isDue(await library.read(),{at:new Date(0).toISOString()},config,Date.now()+30*36e5),true);
 // 第二次失败后放弃：移出收件箱，未变化的会话文件不会重新排队。
 const second=await runConsolidation(library,{config,learner:bad,judge,userHome,mode:'now',now:Date.now()+25*36e5});
 assert.equal(second.status,'failed');assert.equal(calls,6);
 let after=await library.read();assert.deepEqual(after.inbox,{});assert.ok(Object.values(after.transcripts)[0].abandoned);
 assert.equal((await runConsolidation(library,{config,learner:bad,judge,userHome,mode:'now',now:Date.now()+50*36e5})).status,'empty');assert.equal(calls,6);
 // 进程号被复用的残留锁：超过 staleAfter 后可被接管。
 const lockRoot=join(library.root,'history','consolidations');
 await writeFile(join(lockRoot,'.write-lock'),JSON.stringify({pid:process.pid,id:'stale',created:Date.now()-7*36e5}));
 assert.equal((await runConsolidation(library,{config,learner:bad,judge,userHome})).status,'not-due');
 assert.equal(isWorkerSession({context:{workspace:library.root+'-notes'},messages:[]},{libraryRoot:library.root}),false);
 assert.equal(isWorkerSession({context:{workspace:join(library.root,'x')},messages:[]},{libraryRoot:library.root}),true);
});

test('晋升确认只认提案之后的问答回答，不能引用来源证据或提高强度；单条原话不能直接成为核心经验',async t=>{
 const root=await mkdtemp(join(tmpdir(),'doc-promote2-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const library=await Library.open(root);
 let ids;
 await library.transact('seed',state=>{
  ids=seedRules(state,['r1','r2']);
  state.proposals=[{id:'p1',status:'pending',from:ids,scope:{kind:'experiment-report'},text:'实验报告避免大段文字堆积',strength:'default',at:'2026-10-02T00:00:00Z'},{id:'p3',status:'pending',from:ids,scope:{kind:'experiment-report'},text:'x',strength:'required'}];
  addSources(state,[{id:'early',role:'user',origin:'user-question',at:'2026-10-01T00:00:00Z',text:'同意',context:{}},{id:'chat',role:'user',origin:'conversation',text:'同意',context:{}}]);
 });
 await assert.rejects(library.transact('x',state=>applyPromotion(state,'p1',['r1/u'])),/提问工具|来源经验/);
 await assert.rejects(library.transact('x',state=>applyPromotion(state,'p1',['chat'])),/提问工具/);
 await assert.rejects(library.transact('x',state=>applyPromotion(state,'p1',['early'])),/早于提案/);
 await assert.rejects(library.transact('x',state=>validatePromotion(state,state.proposals[1])),/强度/);
 await assert.rejects(library.transact('x',state=>{addSources(state,[{id:'one',role:'user',text:'表格都用三线表',task:'r1',context:{task:'r1'}}]);mergeLearning(state,{rules:[{key:'table.style',value:'three-line',text:'表格用三线表',category:'method',strength:'default',scope:{},evidence:[{source:'one',quote:'表格都用三线表'}]}]});}),/所有文档通用/);
});

test('分叉会话复制同一消息、模型截短会话 ID、批次超长时仍能整理',async t=>{
 const {userHome,library,write}=await setup(t);
 const shared=line('fork-a','same','r5 这份实验报告避免大段文字堆积');
 await write('fork-a',shared);
 await write('fork-b',shared.replace('"sessionId":"fork-a"','"sessionId":"fork-b-longer-id"')+line('fork-b-longer-id','m2','再补一句'));
 const learner=async request=>({sessions:request.sessions.map(s=>({id:s.id.slice(0,15),document:true,task:'r5',kind:'experiment-report'})),rules:[{key:'text.blocks',value:'on',text:'避免大段文字堆积',category:'method',strength:'default',scope:{task:'r5'},evidence:[{source:'same',quote:'避免大段文字堆积'}]}],attach:[],observations:[],promote:[]});
 const result=await runConsolidation(library,{config,learner,judge:{available:false},userHome,mode:'now'});
 assert.equal(result.status,'consolidated');assert.equal(result.processed,2);
 assert.equal((await library.read()).rules.filter(r=>r.scope.task==='r5').length,1);
});

test('晋升保留比结果更强的来源经验',async t=>{
 const root=await mkdtemp(join(tmpdir(),'doc-promote-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const library=await Library.open(root);
 let ids;
 await library.transact('seed',state=>{
  ids=seedRules(state,['r1','r2']);
  state.rules.find(r=>r.id===ids[1]).strength='required';
  state.proposals=[{id:'p',status:'pending',from:ids,scope:{kind:'experiment-report'},text:'实验报告避免大段文字堆积',strength:'default'}];
  addSources(state,[{id:'s/answer',role:'user',text:'同意晋升',origin:'user-question',context:{}}]);
 });
 const {result}=await library.transact('promote',state=>applyPromotion(state,'p',['s/answer']));
 assert.deepEqual(result.superseded,[ids[0]]);assert.deepEqual(result.kept,[ids[1]]);
 assert.equal((await library.read()).rules.find(r=>r.id===ids[1]).status,'active');
});

test('手册：案例经验全部被替代后覆盖旧案例文件',()=>{
 const state={rules:[{id:'old',status:'superseded',category:'method',strength:'default',scope:{task:'r1'},text:'旧经验',evidence:[]}],sources:{},observations:[],skills:{},proposals:[]};
 const text=buildManuals(state).files['cases/r1.md'];
 assert.match(text,/已全部晋升或被替代/);assert.doesNotMatch(text,/旧经验/);
});

test('Jev 配置网关时只把 TypeSafe 变量交给 Jev 包，去掉末尾 /v1',async()=>{
 assert.deepEqual(validateConfig({judge:{baseUrl:'http://127.0.0.1:3425/v1',apiKey:'magpie'}}).judge.model,'jev-latest');
 assert.throws(()=>validateConfig({judge:{baseUrl:'ftp://x'}}),/judge\.baseUrl/);
 const seen=[];
 const original=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{seen.push({url,auth:init.headers.Authorization});return new Response(JSON.stringify({answers:{s0_doc:{type:'choice',choice:'document',probabilities:{document:1,not_document:0},confidence:1},s0_kind:{type:'choice',choice:'instruction',probabilities:Object.fromEntries(['experiment-report','instruction','site-report','presentation','markdown','other-document'].map(k=>[k,k==='instruction'?1:0])),confidence:1}},usage:{input_tokens:1,output_tokens:1},model:'jev-x'}),{status:200,headers:{'content-type':'application/json'}});};
 try {
  const judge=createJudge({baseUrl:'http://127.0.0.1:3425/v1',apiKey:'magpie',env:{}});
  assert.equal(judge.identity,'jev:jev-latest@gateway');
  const result=await judge.classify([{id:'a',messages:[{role:'user',text:'改说明书'}]}]);
  assert.equal(result.available,true);assert.equal(result.results.a.decision,'document');
  assert.deepEqual(seen,[{url:'http://127.0.0.1:3425/v1/systemone',auth:'Bearer magpie'}]);
 } finally {globalThis.fetch=original;}
});

test('Codex 子代理会话与带目录的 AGENTS 注入不进入整理',()=>{
 const meta=source=>JSON.stringify({type:'session_meta',payload:{id:'s',cwd:'D:/docs',source}});
 const msg=text=>JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}});
 const guardian=normalizeJsonl([meta({subagent:{other:'guardian'}}),msg('写一份报告')].join('\n'),'g.jsonl');
 assert.equal(isWorkerSession(guardian),true);
 const normal=normalizeJsonl([meta('cli'),msg('# AGENTS.md instructions for D:\proj\n\n所有回复用简体中文'),msg('写一份报告')].join('\n'),'n.jsonl');
 assert.equal(isWorkerSession(normal),false);
 assert.deepEqual(normal.messages.filter(m=>m.role==='user').map(m=>m.text),['写一份报告']);
});

test('手动撤销经验：记录原因，已撤销的同 id 经验不被复活，未知 id 报错',async t=>{
 const {library}=await setup(t);
 const [id]=await (await library.transact('seed',state=>seedRules(state,['t1']))).result;
 assert.throws(()=>retireRules({rules:[]},['x'],'误收'),/未找到经验/);
 assert.throws(()=>retireRules({rules:[]},[id],''),/撤销原因/);
 const {result}=await library.transact('retire',state=>retireRules(state,[id],'误收的 workflow 协议'));
 assert.deepEqual(result,[{id,action:'retire'}]);
 let state=await library.read();const rule=state.rules.find(r=>r.id===id);
 assert.equal(rule.status,'retired');assert.equal(rule.retirement.reason,'误收的 workflow 协议');
 assert.ok(state.events.at(-1).rollback);
 await library.transact('again',s=>seedRules(s,['t1']));
 assert.equal((await library.read()).rules.find(r=>r.id===id).status,'retired');
});

test('多端同步：另一台电脑撤销的经验在本机同步撤销',async t=>{
 const {dir,library}=await setup(t);
 const [id]=(await library.transact('seed',state=>seedRules(state,['t1']))).result;
 const skillDir=join(dir,'skills-repo');await mkdir(join(skillDir,'knowledge'),{recursive:true});
 const remote=structuredClone(await library.read());retireRules(remote,[id],'另一台电脑撤销');
 await writeFile(join(skillDir,'knowledge','memory.json'),JSON.stringify({schema:1,rules:remote.rules,observations:[],sources:remote.sources,skills:{}}));
 const local=await Library.open(library.root,{skillDirectory:skillDir});
 assert.equal(await syncMemoryFromSkillDirectory(local),true);
 assert.equal((await local.read()).rules.find(r=>r.id===id).status,'retired');
 assert.equal(await syncMemoryFromSkillDirectory(local),false);
});

test('粘贴的 workflow 对齐协议只去掉这一条，同会话的文档反馈保留',()=>{
 const msg=text=>JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}});
 const meta=JSON.stringify({type:'session_meta',payload:{id:'w',cwd:'D:/proj',source:'cli'}});
 const s=normalizeJsonl([meta,msg('## 项目对齐（每次会话开始先做）\n读取 `docs/WORKFLOW-ALIGNMENT.md`，所有回复用简体中文'),msg('使用说明里的截图都加图注，放在图片下方')].join('\n'),'w.jsonl');
 assert.equal(isWorkerSession(s),false);
 assert.deepEqual(s.messages.filter(m=>m.role==='user').map(m=>m.text),['使用说明里的截图都加图注，放在图片下方']);
 // 只是提到对齐文件的普通消息不受影响。
 const plain=normalizeJsonl([meta,msg('把 docs/WORKFLOW-ALIGNMENT.md 里的表格改成三列')].join('\n'),'p.jsonl');
 assert.equal(plain.messages.length,1);
});

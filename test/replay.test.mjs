import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Library} from '../src/library.mjs';
import {normalizeSession,replaySteps} from '../src/history.mjs';
import {runReplay,reconcileReplay} from '../src/replay.mjs';
import {hash,readJson} from '../src/io.mjs';

const empty={document:true,context:{},rules:[],observations:[],retire:[],skills:[]};
function dataset() {
  const sessions=[normalizeSession({id:'a',context:{task:'a',kind:'instruction'},messages:[{role:'user',text:'图片要符合实拍位置关系'},{role:'assistant',text:'已完成'},{role:'user',text:'FUTURE_ANSWER 本次不要图注'}]})];
  return {sessions,inputDigest:hash(sessions),warnings:[],git:{baseline:{digest:'initial',files:[{path:'SKILL.md',text:'初始规则'}]},actual:{digest:'FUTURE_ACTUAL',files:[{path:'SKILL.md',text:'FUTURE_ACTUAL'}]}}};
}
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'doc-replay-'));t.after(()=>rm(dir,{recursive:true,force:true}));return Library.open(dir);}
test('回放第一步无法读取未来消息、最终提交或隐藏评估答案',async t=>{
  const lib=await fixture(t),data=dataset(),calls=[];
  const steps=replaySteps(data);
  const {run}=await runReplay(lib,data,async req=>{calls.push(req);return structuredClone(empty);},{expectations:{[steps[0].id]:{document:true,forbiddenRules:['HIDDEN_EXPECTATION']}}});
  assert.equal(calls.length,2);
  assert.doesNotMatch(JSON.stringify(calls[0]),/FUTURE_ANSWER|FUTURE_ACTUAL|HIDDEN_EXPECTATION/);
  assert.equal(run.summary.layoutEvaluation.startsWith('未评估'),true);
  assert.equal(run.summary.baselines.actual.status,'reference-only');
});
test('模型失败后从检查点继续，重复回补不会增加经验',async t=>{
  const lib=await fixture(t),data=dataset();let count=0;
  const learner=async req=>{
    if(++count===2)throw new Error('模拟后端中断');
    return {...empty,rules:req.current.text.includes('FUTURE')?[]:[{key:'image.truth',value:'match',text:'图片对应实拍位置关系',category:'method',strength:'default',scope:{kind:'instruction'},evidence:[{source:req.current.id,quote:'图片要符合实拍位置关系'}]}]};
  };
  await assert.rejects(runReplay(lib,data,learner,{jobId:'resume'}),/后端中断/);
  const checkpoint=await readJson(join(lib.root,'history','runs','resume','run.json'));
  assert.equal(checkpoint.index,1);
  const {root,run}=await runReplay(lib,data,learner,{jobId:'resume'});
  assert.equal(run.results.length,2);
  await reconcileReplay(lib,root);await reconcileReplay(lib,root);
  assert.equal((await lib.read()).rules.length,1);
});
test('有失败边界的回放不会用其他成功项抵消失败并自动发布',async t=>{
  const lib=await fixture(t),data=dataset(),id=replaySteps(data)[0].id;
  const {root}=await runReplay(lib,data,async()=>structuredClone(empty),{expectations:{[id]:{document:false}}});
  await assert.rejects(reconcileReplay(lib,root),/失败的边界/);
});
test('截断会话保留缺失标记，不补写不存在的早期反馈',()=>{
  const s=normalizeSession({session_id:40,messages:{total:311,truncated:true,items:[{role:'user',text:'本次按现有裁剪方式替换图片'}]}});
  assert.equal(s.completeness.truncated,true);
  assert.match(s.completeness.warnings.join(' '),/1\/311/);
  assert.equal(s.messages.length,1);
});

test('非文档轮试图整理旧经验时自动修正一次，修正提示没有未来答案',async t=>{
  const lib=await fixture(t),data=dataset();let repaired=0;
  const learner=async req=>{
    if(req.repair){repaired++;assert.doesNotMatch(JSON.stringify(req.repair),/FUTURE_ACTUAL/);return {...empty,document:false};}
    return {...empty,document:false,observations:[{text:'不应写入',evidence:[{source:req.current.id,quote:req.current.text}]}]};
  };
  const {run}=await runReplay(lib,data,learner);
  assert.ok(repaired>0);assert.equal(run.results.every(r=>r.evolving.observations.length===0),true);
  assert.equal((await Library.open(join(lib.root,'history','runs',run.id,'evolving'),{create:false}).then(l=>l.read())).observations.length,0);
});

test('冻结对照的无效提案被记录，不阻塞通过检查的演化分支',async t=>{
  const lib=await fixture(t),data=dataset();
  const learner=async req=>{
    if(!req.current.text.includes('FUTURE'))return {...empty,rules:[{key:'image.truth',value:'match',text:'图片对应实拍',category:'method',strength:'default',scope:{kind:'instruction'},evidence:[{source:req.current.id,quote:'图片要符合实拍位置关系'}]}]};
    return req.knowledge.length?structuredClone(empty):{...empty,document:false,observations:[{text:'错误对照',evidence:[{source:req.current.id,quote:req.current.text}]}]};
  };
  const {run,root}=await runReplay(lib,data,learner);
  assert.equal(run.status,'complete');assert.equal(run.summary.frozenValidationErrors,1);
  await reconcileReplay(lib,root);assert.equal((await lib.read()).rules.length,1);
});

test('重复回补保留同批的未解偏好冲突，不把它误认成新的当前要求',async t=>{
  const lib=await fixture(t);
  const sessions=[normalizeSession({id:'ambiguous',context:{task:'a',kind:'report'},messages:[{role:'user',text:'图注可以放下方，也可以不加图注'}]})];
  const data={sessions,inputDigest:hash(sessions),warnings:[]};
  const learner=async req=>({...empty,rules:['below','none'].map(value=>({key:'figure.caption',value,text:value==='below'?'图注放下方':'不加图注',category:'preference',strength:'default',scope:{task:'a'},evidence:[{source:req.current.id,quote:req.current.text}]}))});
  const {root}=await runReplay(lib,data,learner);await reconcileReplay(lib,root);
  const before=await lib.read();await reconcileReplay(lib,root);const after=await lib.read();
  assert.equal(after.rules.length,2);assert.equal(after.observations.length,before.observations.length);assert.equal(after.revision,before.revision);
});

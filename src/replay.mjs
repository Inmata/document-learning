import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {hash,readJson,writeJson,withLock} from './io.mjs';
import {Library} from './library.mjs';
import {applyLearning,mergeLearning,retrieve} from './knowledge.mjs';
import {replaySteps} from './history.mjs';
import {validateSkillProposal,publishSkills} from './skills.mjs';
import {engineFingerprint} from './engine.mjs';

function requestFor(step,state,baseline,sandbox) {
  const prefix=step.prefix.filter(m=>m.text?.trim()).map(m=>({id:m.id,role:m.role,text:m.text}));
  // Only the prefix of this historical session is supplied. No repository, ref name,
  // live library path, hidden expectations, later commits or final artifact is exposed.
  const history=prefix.slice(-10);
  const initialFiles=(baseline?.files || []).filter(f=>/(?:SKILL\.md|openai\.yaml)$/.test(f.path)).map(f=>({...f,text:f.text?.slice(0,8000),truncated:!!f.truncated || (f.text?.length || 0)>8000}));
  return {mode:'historical-trajectory',current:step.source,context:step.context,history,historyWindow:{included:history.length,total:prefix.length},knowledge:state.rules,observations:state.observations,initialFiles,sandbox};
}
function score(decision,expected) {
  if(!expected)return {status:'not-evaluated'};
  const failures=[];
  if(expected.document!==undefined && expected.document!==decision.document)failures.push('document-routing');
  for(const key of expected.requiredRules || [])if(!decision.rules?.some(r=>r.key===key))failures.push(`missing:${key}`);
  for(const key of expected.forbiddenRules || [])if(decision.rules?.some(r=>r.key===key))failures.push(`forbidden:${key}`);
  return {status:failures.length?'failed':'passed',failures};
}
function validateDecision(state,sources,output) {
  if(output.sources)throw new Error('模型不能提供原始用户来源');
  if(!output.document && [output.rules,output.observations,output.retire,output.skills].some(x=>x?.length))throw new Error('非文档判断不能写入文档经验，rules/observations/retire/skills 应为空数组');
  const prospective=structuredClone(state);
  mergeLearning(prospective,{sources,rules:output.rules || [],observations:output.observations || [],retire:output.retire || []});
  for(const p of output.skills || [])validateSkillProposal(prospective,p);
}
async function checkedDecision(learner,request,state,sources,initial,onFailure=()=>{}) {
  let output=initial;const repairs=[];
  for(let attempt=0;attempt<2;attempt++) {
    try {validateDecision(state,sources,output);return {output,repairs};}
    catch(error) {
      if(attempt===1)throw error;
      repairs.push({error:error.message,metadata:output._meta || null});
      await onFailure({output,error:error.message,attempt});
      output=await learner({...request,repair:{validationError:error.message,previousOutput:output,instruction:'仅修正这个结构或证据错误；没有新反馈可返回空数组。引文用原始用户消息中的连续原文，不添加未来信息。'}});
    }
  }
}
export async function runReplay(library,dataset,learner,{jobId,expectations={},progress=()=>{}}={}) {
  const engine=await engineFingerprint();
  const signature=hash({schema:1,engine,dataset:dataset.inputDigest,baseline:dataset.git?.baseline?.digest,provider:learner.identity || 'injected-test-provider',expectations});
  const id=jobId || signature.slice(0,20);
  if(!/^[a-zA-Z0-9-]{1,64}$/.test(id))throw new Error('无效的历史任务标识');
  const root=join(library.root,'history','runs',id);
  await mkdir(root,{recursive:true});
  return withLock(root,async()=>{
    const evolving=await Library.open(join(root,'evolving'));
    const frozen=await Library.open(join(root,'frozen'));
    const sandbox=join(root,'worker');await mkdir(sandbox,{recursive:true});
    const file=join(root,'run.json');
    const run=await readJson(file,{schema:1,id,signature,engine,index:0,status:'running',results:[],proposals:[],warnings:dataset.warnings || [],started:new Date().toISOString()});
    if(run.signature!==signature)throw new Error('输入或评估条件变化，不能沿用旧检查点');
    const steps=replaySteps(dataset);
    for(let i=run.index;i<steps.length;i++) {
      const step=steps[i];
      progress({job:id,index:i,total:steps.length,source:step.id});
      const started=Date.now();
      try {
        const state=await evolving.read();
        const evolveRequest=requestFor(step,state,dataset.git?.baseline,sandbox);
        const frozenRequest=requestFor(step,await frozen.read(),dataset.git?.baseline,sandbox);
        let decision,control;
        if(hash(evolveRequest)===hash(frozenRequest)) {
          decision=await learner(evolveRequest);control=structuredClone(decision);
        } else {
          const results=await Promise.allSettled([learner(evolveRequest),learner(frozenRequest)]);
          for(const result of results)if(result.status==='rejected')throw result.reason;
          [decision,control]=results.map(r=>r.value);
        }
        const sources=step.prefix.filter(m=>m.text?.trim());
        const failure=(variant)=>data=>writeJson(join(root,'rejected',`${i}-${variant}.json`),{step:step.id,variant,...data});
        const checked=await checkedDecision(learner,evolveRequest,state,sources,decision,failure('evolving'));
        decision=checked.output;
        let controlError=null;
        try{validateDecision(await frozen.read(),sources,control);}catch(error){controlError=error.message;await failure('frozen')({output:control,error:error.message,attempt:0});}
        // Invalid control output is an evaluation result. It cannot block the evolving
        // branch, and repairing it would give the frozen baseline extra assistance.
        const repairs={evolving:checked.repairs,frozen:[],frozenValidationError:controlError};
        const result=await applyLearning(evolving,{sources,rules:decision.rules || [],observations:decision.observations || [],retire:decision.retire || []});
        run.results.push({step:step.id,session:step.session,document:decision.document,context:decision.context,changes:result.result,evolving:decision,frozen:control,repairs,evaluation:{evolving:score(decision,expectations[step.id]),frozen:score(control,expectations[step.id])},inputDigest:hash(evolveRequest),elapsedMs:Date.now()-started});
        run.proposals.push(...(decision.skills || []));
        run.index=i+1;run.status='running';delete run.error;
        await writeJson(file,run);
      }catch(error){run.status='failed';run.error={step:step.id,message:error.message};await writeJson(file,run);throw error;}
    }
    run.status='complete';run.finished=new Date().toISOString();
    const evaluated=run.results.filter(r=>r.evaluation.evolving.status!=='not-evaluated').length;
    run.summary={steps:run.results.length,documentSteps:run.results.filter(r=>r.document).length,rules:(await evolving.read()).rules.length,failedChecks:run.results.filter(r=>r.evaluation.evolving.status==='failed').length,evaluatedSteps:evaluated,semanticEvaluation:evaluated?'按提供的隐藏期望评估':'未提供隐藏期望；不报告语义正确率',frozenValidationErrors:run.results.filter(r=>r.repairs?.frozenValidationError).length,baselines:{frozen:'固定初始快照，不保存模型产生的新经验',evolving:'逐步保存仅由已出现证据支持的经验',actual:{status:dataset.git?'reference-only':'unavailable',snapshotDigest:dataset.git?.actual?.digest || null}},layoutEvaluation:'未评估；需要历史文档、图片及原始偏好依据',completeness:dataset.sessions.map(s=>({session:s.id,...s.completeness}))};
    await writeJson(file,run);
    await library.transact('history-run',state=>{state.jobs[id]={root,status:run.status,summary:run.summary};});
    return {root,run};
  },1000);
}

export async function reconcileReplay(library,root,{repository}={}) {
  const run=await readJson(join(root,'run.json'));
  if(run.status!=='complete' || run.summary.failedChecks)throw new Error('历史任务未完成或存在失败的边界检查，不能自动回补');
  const generated=await Library.open(join(root,'evolving'),{create:false});
  const learned=await generated.read();
  const current=await library.read();
  const conflicts=[];
  const rules=learned.rules.filter(r=>r.status==='active').filter(r=>{
    const existing=current.rules.filter(x=>x.status==='active'&&x.key===r.key&&hash(x.scope)===hash(r.scope)&&x.value!==r.value);
    if(existing.length){conflicts.push(r);return false;}return true;
  });
  const result=await applyLearning(library,{sources:Object.values(learned.sources),rules,observations:[...learned.observations,...conflicts.map(r=>({text:`历史与当前选择冲突，保留当前要求：${r.text}`,scope:r.scope,evidence:r.evidence}))]});
  const proposals=run.proposals.filter(p=>(p.ruleIds || []).every(id=>rules.some(r=>r.id===id)||current.rules.some(r=>r.id===id)));
  const skills=await publishSkills(library,proposals,{repository});
  const report={job:run.id,revision:result.revision,changes:result.result,conflicts:conflicts.map(r=>r.id),skills,merged:new Date().toISOString()};
  await writeJson(join(root,'reconciliation.json'),report);
  return report;
}

import {join} from 'node:path';
import {hash,readJson,writeJson,atomicWrite,withLock} from './io.mjs';
import {mergeLearning} from './knowledge.mjs';
import {validateSkillProposal,publishSkills} from './skills.mjs';
import {exportCatalog} from './catalog.mjs';
import {engineFingerprint} from './engine.mjs';

export function backfillEvidence(dataset) {
 const conversation=dataset.sessions.flatMap(s=>s.messages.filter(m=>m.role==='user'&&m.text.trim()));
 const repo=dataset.git;
 const repository=(repo?.actual?.files || []).filter(f=>f.text).map(f=>({id:`git:${repo.head}:${f.path}`,role:'repository',origin:'repository-policy',text:f.text,path:f.path,commit:repo.head,context:{...(/^([^/]+)\//.exec(f.path)?{skill:f.path.split('/')[0]}:{})}}));
 return [...conversation,...repository];
}
export function sourceSkillCatalog(dataset) {
 const files=dataset.git?.actual?.files || [],skills={};
 for(const file of files.filter(f=>/^[^/]+\/SKILL\.md$/.test(f.path)&&f.text)) {
  const name=file.path.split('/')[0],yaml=files.find(f=>f.path===`${name}/agents/openai.yaml`)?.text || '';
  skills[name]={name,title:yaml.match(/^\s*display_name:\s*"?([^"\n]+)"?\s*$/m)?.[1] || name,description:file.text.match(/^description:\s*(.*)$/m)?.[1] || '',scope:{skill:name},implicit:!/^\s*allow_implicit_invocation:\s*false/m.test(yaml)&&!/^disable-model-invocation:\s*true/m.test(file.text),source:'read-only-repository',commit:dataset.git.head,path:join(dataset.git.repository || '',file.path)};
 }
 return skills;
}
export async function runBackfill(library,dataset,learner,{jobId,replaceRun,progress=()=>{}}={}) {
 const engine=await engineFingerprint(),signature=hash({engine,dataset,provider:learner.identity || 'test',replaceRun:replaceRun || null});
 const id=jobId || signature.slice(0,20);if(!/^[\w-]{1,64}$/.test(id))throw new Error('无效的补学任务标识');
 const root=join(library.root,'history','backfills',id);
 return withLock(root,async()=>{
  const old=await readJson(join(root,'result.json'),null);if(old&&old.signature!==signature)throw new Error('补学条件变化，不能沿用旧结果');
  const sources=backfillEvidence(dataset),state=await library.read();
  const request={mode:'current-material-backfill',context:{task:`backfill:${id}`,kind:'document-learning'},sandbox:root,
   instruction:'这是当前资料补学，不是时间回放。综合全部原始用户反馈和当前仓库规范；历史 diff 用于理解演变，已删除的旧规范不能作为当前政策。优先提炼能改变后续制作行为的方法，案例参数和临时执行状态不建长期规则。方法 scope 用稳定英文 kind/purpose/process 表达能力边界，不因原案例是 PCB 就限制 object；不能给所有文档统一版式。审美偏好保留原任务。先判断已有技能的覆盖和明确调用限制，不通过新副本绕过限制。确有独立完整制作流程才创建技能：正文写实际输入、步骤、产物、检查及不适用情况；不照搬案例参数。不要只列注意事项。新技能规则不强制绑定原案例 task 的事实。不要 retire/revise 当前经验；替换旧历史记录由宿主处理。',
   sessions:dataset.sessions.map(s=>({id:s.id,title:s.title,context:s.context,completeness:s.completeness,messages:s.messages.filter(m=>m.role==='user'||(m.role==='assistant'&&m.text.trim())).map(m=>({id:m.id,role:m.role,text:m.text.slice(0,16000),truncated:m.text.length>16000}))})),
   repository:{sources:sources.filter(s=>s.role==='repository'),changes:dataset.git?.commits.filter(c=>c.relevant).map(c=>({sha:c.sha,date:c.date,subject:c.subject,selected:c.selected})),warnings:dataset.git?.warnings},knowledge:[]};
  await writeJson(join(root,'input.json'),request);progress({phase:'learning',sources:sources.length});
  let decision=old?.decision;
  if(!decision) {
   let failure;
   for(let attempt=0;attempt<3;attempt++) {
    decision=await learner({...request,...(failure?{repair:failure}:{})});
    try {
     if(!decision.document)throw new Error('补学结果未覆盖文档资料');
     if(decision.retire?.length||decision.revise?.length)throw new Error('当前补学不允许撤销或修改现有经验');
     const dry=structuredClone(state);mergeLearning(dry,{sources,rules:decision.rules,observations:decision.observations});
     for(const p of decision.skills || [])validateSkillProposal(dry,p);
     break;
    }catch(error){await writeJson(join(root,`rejected-${attempt}.json`),{decision,error:error.message});if(attempt===2)throw error;failure={validationError:error.message,previousOutput:decision,instruction:'只修复结构、范围或引文错误，逐字引用 sources 或 sessions 中原始用户原文，不杜撰来源。'};}
   }
   await writeJson(join(root,'result.json'),{signature,engine,decision,mode:request.mode,created:new Date().toISOString()});
  }
  let replaced=[];
  if(replaceRun){const previous=await readJson(join(library.root,'history','runs',replaceRun,'evolving','state.json'));replaced=previous.rules;}
  const merged=await library.transact('backfill-current-materials',draft=>{
   for(const previous of replaced){const existing=draft.rules.find(r=>r.id===previous.id);if(existing&&hash(existing)===hash(previous)){existing.status='archived';existing.archiveReason=`重新补学 ${id}；原始证据保留`;}}
   draft.sourceSkills={...(draft.sourceSkills || {}),...sourceSkillCatalog(dataset)};
   return mergeLearning(draft,{sources,rules:decision.rules || [],observations:decision.observations || []});
  });
  const skills=await publishSkills(library,decision.skills || []),catalog=await exportCatalog(library);
  const git=dataset.git;
  const report=`# 历史资料补学结果\n\n本次是当前完整资料整理，不作为无未来信息的历史回放或视觉效果评测。\n\n## 实际产出\n\n${skills.map(s=>`- 技能 ${s.name}：${s.status}；${s.path}`).join('\n') || '- 无新增技能，详见模型原始判断。'}\n- 可阅读经验：${catalog.knowledge}\n- 案例与历史归档：${catalog.cases}\n\n## 仓库学习范围\n\n${git?.commits.filter(c=>c.relevant).map(c=>`- ${c.sha} ${c.subject}\n${c.selected.map(f=>`  - ${f.path}${f.structure?`（已检查实际 DOCX XML：${f.structure.changedParts.join('、')}）`:f.binary?'（仅识别变更；尚未解析实际内容）':''}`).join('\n')}`).join('\n') || '未提供仓库。'}\n\n## 来源完整性\n\n${dataset.sessions.map(s=>`- ${s.title || s.id}：${s.messages.filter(m=>m.role==='user').length} 条有效用户消息；${s.completeness.truncated?'仍有截断':'本机可见日志未截断'}；${s.completeness.warnings.join('；') || '有原始记录、时间与工具内容'}`).join('\n')}\n\n原始输入、模型结果及拒绝修复记录保存在本任务目录。有效经验的具体内容和引文见经验目录。\n`;
  await atomicWrite(join(root,'report.md'),report);await writeJson(join(root,'receipt.json'),{merged,skills,catalog});
  return {root,skills,catalog,changes:merged.result};
 });
}

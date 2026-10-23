import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {hash,readJson,writeJson,atomicWrite,withLock,stable} from './io.mjs';
import {mergeLearning,addSources,validatePromotion,tierOf,support,scopeMatch} from './knowledge.mjs';
import {learnerInstructions,learningSchema} from './provider.mjs';
import {exportCatalog} from './catalog.mjs';
import {scanTranscripts,applyScan,readTranscript,userMessages} from './scan.mjs';

// 后台批量整理：扫描宿主会话 → Jev 初筛 → 整理模型提炼 → 校验写入 → 编译手册。
// 学习信号不再由当前会话的模型逐轮提交；当前会话只在用户明确要求时运行 remember。
export const STALE_DAYS=3;
// 单个会话与单批输入的字数上限：整批要放进整理模型的上下文，超出部分留到下一批。
export const SESSION_CHARS=30000,BATCH_CHARS=150000;
const ruleItem=learningSchema.properties.rules.items,observationItem=learningSchema.properties.observations.items;
const evidenceItem=ruleItem.properties.evidence;
export const consolidationSchema={type:'object',additionalProperties:false,required:['sessions','rules','attach','observations','promote'],properties:{
 sessions:{type:'array',items:{type:'object',additionalProperties:false,required:['id','document'],properties:{id:{type:'string'},document:{type:'boolean'},task:{type:'string',minLength:1,maxLength:200},kind:{type:'string',minLength:1,maxLength:80},reason:{type:'string',maxLength:300}}}},
 rules:{type:'array',items:ruleItem},
 attach:{type:'array',items:{type:'object',additionalProperties:false,required:['id','evidence'],properties:{id:{type:'string'},evidence:evidenceItem}}},
 observations:{type:'array',items:observationItem},
 promote:{type:'array',items:{type:'object',additionalProperties:false,required:['from','scope','text','strength'],properties:{from:{type:'array',minItems:1,items:{type:'string'}},scope:ruleItem.properties.scope,text:{type:'string',minLength:1,maxLength:6000},strength:{type:'string',enum:['suggestion','default','required']},reason:{type:'string',maxLength:600}}}}
}};
export const consolidationInstructions=`${learnerInstructions}

本次 mode=consolidation：输入是若干条已结束或进行中的宿主会话（sessions）和全部有效经验（knowledge）。
1. 先逐个判断会话是否实际制作、修改或审阅文档，在 sessions 中为每个输入会话返回 {id,document,task,kind}；文档会话的 task 是稳定的文档标识（输入已给 task 时必须原样沿用），kind 优先 experiment-report/instruction/site-report/presentation/markdown。非文档会话 document=false，不从中学习。
2. 只从文档会话的原始用户消息提炼经验；evidence.source 用消息 id，quote 逐字摘自该消息。
3. 与 knowledge 中已有经验表达同一要求时，不新建规则，改用 attach:[{id:已有经验id,evidence}] 合并证据；同一维度仍复用已有 key。attach 只能并入范围覆盖该会话的经验：已有经验限定了别的 task 时，为本文档新建同 key 的单份文档经验，并按第 4 条提出晋升。
4. 同一条要求已在 ≥2 份不同文档（不同 task）中出现（knowledge 的 support 与 tier 可参考），用 promote 提出晋升：from 为这些已有经验 id，scope 为覆盖全部来源的更宽范围（去掉 task，保留 kind 等共同条件；全部文档通用才留空），text 为合并后的表述，strength 取来源中用户明确表达的强度。晋升需要用户确认，只是提案。
5. 新经验的 scope 至少限定 task 或 kind；所有文档通用只能经第 4 条晋升，除非用户原话明确说“所有文档/一律”。不输出 retire、revise 或 skills。没有可学内容时各数组为空。`;

const sessionView=(session,fixedTask)=>{
 const messages=[];let size=0;
 for(const m of session.messages) {
  if(m.role==='tool')continue;
  const limit=m.role==='user'?6000:800,text=m.text.length>limit?`${m.text.slice(0,limit)}…`:m.text;
  if(!text.trim())continue;
  if(size+text.length>SESSION_CHARS){messages.push({role:'note',text:'后续消息因长度省略'});break;}
  size+=text.length;messages.push({id:m.id,role:m.role,text,...(m.text.length>limit?{truncated:true}:{})});
 }
 return {id:session.key,title:session.title,workspace:session.context.workspace || '',...(fixedTask?{task:fixedTask}:{}),messages};
};
export const knowledgeView=state=>state.rules.filter(r=>r.status==='active').map(r=>({id:r.id,key:r.key,value:r.value,text:r.text,category:r.category,strength:r.strength,scope:r.scope,tier:r.tier || tierOf(r.scope),support:r.support ?? support(state,r)}));
const proposalId=p=>hash({from:[...p.from].sort(),scope:p.scope,text:p.text.trim()}).slice(0,24);

export async function lastConsolidation(library){return readJson(join(library.root,'history','consolidations','last.json'),null);}
export async function consolidationStatus(library,{now=Date.now()}={}) {
 const state=await library.read(),last=await lastConsolidation(library);
 const pending=Object.keys(state.inbox || {}).length;
 const since=last?.at?Date.parse(last.at):null;
 return {last,pending,proposals:(state.proposals || []).filter(p=>p.status==='pending').length,stale:pending>0&&(since===null?Object.values(state.inbox).some(i=>now-Date.parse(i.at)>STALE_DAYS*864e5):now-since>STALE_DAYS*864e5)};
}
// 整理失败的会话按失败次数退避，避免每次触发都重复调用模型。
export const eligible=(state,now=Date.now())=>Object.entries(state.inbox || {}).filter(([,e])=>!e.retryAfter||Date.parse(e.retryAfter)<=now);
export function isDue(state,last,config,now=Date.now()) {
 const entries=eligible(state,now).map(([,e])=>e);
 if(!entries.length)return false;
 if(entries.length>=config.consolidate.minSessions)return true;
 const since=last?.at?Date.parse(last.at):Math.min(...entries.map(e=>Date.parse(e.at)));
 return now-since>config.consolidate.maxWaitHours*36e5;
}

// 续接或分叉的会话会复制早先的消息行；同一消息 ID 只登记一次，已入库的沿用原记录。
function uniqueSources(state,list) {
 const seen=new Set();
 return list.filter(s=>{if(seen.has(s.id)||state.sources[s.id])return false;seen.add(s.id);return true;});
}
// 模型偶尔截短会话 ID；能唯一对应输入会话的前缀改回完整 ID。
function restoreSessionIds(decision,batch) {
 if(!Array.isArray(decision?.sessions))return decision;
 const keys=batch.map(s=>s.key);
 return {...decision,sessions:decision.sessions.map(item=>{
  if(keys.includes(item.id))return item;
  const hits=keys.filter(k=>typeof item.id==='string'&&item.id.length>=8&&k.startsWith(item.id));
  return hits.length===1?{...item,id:hits[0]}:item;
 })};
}
function sourcesFor(session,decision) {
 const context={task:decision.task,kind:decision.kind,workspace:session.context.workspace || ''};
 return userMessages(session).map(m=>({id:m.id,role:'user',text:m.text,origin:'conversation',task:decision.task,context,...(m.timestamp?{timestamp:m.timestamp}:{})}));
}
// 校验整理结果：会话判断、证据、范围与晋升提案。返回可写入的载荷。
function validateDecision(state,batch,decision,config,{dropInvalidProposals=false}={}) {
 if(!decision||!Array.isArray(decision.sessions))throw new Error('整理结果缺少 sessions 判断');
 if(decision.retire?.length||decision.revise?.length||decision.skills?.length)throw new Error('后台整理不允许撤销、修改强度或生成技能');
 const byId=new Map(batch.map(s=>[s.key,s]));
 const judged=new Map();
 for(const item of decision.sessions) {
  const session=byId.get(item.id);if(!session)throw new Error(`sessions 中出现未知会话：${item.id}`);
  if(item.document) {
   if(!item.task||!item.kind)throw new Error(`文档会话 ${item.id} 需要 task 和 kind`);
   if(session.fixedTask&&item.task!==session.fixedTask)throw new Error(`会话 ${item.id} 已有文档标识 ${session.fixedTask}，必须沿用`);
  }
  judged.set(item.id,item);
 }
 for(const s of batch)if(!judged.has(s.key))throw new Error(`sessions 缺少会话判断：${s.key}`);
 const all=batch.filter(s=>judged.get(s.key).document).flatMap(s=>sourcesFor(s,judged.get(s.key)));
 const allowed=new Set(all.map(s=>s.id)),sources=uniqueSources(state,all);
 for(const item of [...(decision.rules || []),...(decision.attach || []),...(decision.observations || [])])for(const e of item.evidence || [])if(!allowed.has(e.source)&&!state.sources[e.source])throw new Error(`证据来源不是文档会话中的用户消息：${e.source}`);
 const dry=structuredClone(state);
 const changes=mergeLearning(dry,{sources,rules:decision.rules || [],attach:decision.attach || [],observations:decision.observations || []});
 const proposals=[],rejected=[];
 for(const p of decision.promote || []) {
  try{const checked=validatePromotion(dry,p,config.promotion);proposals.push({...p,from:[...new Set(p.from)],scope:checked.scope,tier:checked.tier,support:checked.tasks});}
  catch(error){if(!dropInvalidProposals)throw new Error(`晋升提案无效：${error.message}`);rejected.push({proposal:p,error:error.message});}
 }
 return {judged,sources,changes,proposals,rejected};
}
// 模型常把另一份文档里的同一要求 attach 到只限某份文档的经验上；只因 task 不同而冲突时，
// 改为该文档自己的单份文档经验，跨文档合并留给需要用户确认的晋升。
export function splitForeignAttach(state,decision,sources,notes=[]) {
 if(!decision.attach?.length)return decision;
 const byId=new Map(sources.map(s=>[s.id,s])),rules=[...(decision.rules || [])],attach=[];
 for(const item of decision.attach) {
  const old=state.rules.find(r=>r.id===item.id);
  if(!old?.scope?.task||!Array.isArray(item.evidence)){attach.push(item);continue;}
  const groups=new Map(),keep=[];
  for(const e of item.evidence) {
   const s=byId.get(e.source) || state.sources[e.source],context={...(s?.context || {}),task:s?.task || s?.context?.task};
   if(!s||scopeMatch(old.scope,context)!=='no'||scopeMatch({...old.scope,task:context.task},context)==='no'||!context.task){keep.push(e);continue;}
   groups.set(context.task,[...(groups.get(context.task) || []),e]);
  }
  if(keep.length)attach.push({...item,evidence:keep});
  for(const [task,evidence] of groups) {
   rules.push({key:old.key,value:old.value,text:old.text,category:old.category,strength:old.strength,scope:{...old.scope,task},evidence});
   notes.push(`经验 ${old.id} 只限文档 ${old.scope.task}，文档 ${task} 的同一要求另建单份文档经验，可经晋升合并`);
  }
 }
 return {...decision,rules,attach};
}
// Jev 找到的同义已有经验：把新规则改成证据合并；范围不兼容时保留为新规则。
async function mergeByJudge(state,judge,decision,sources,notes) {
 if(!judge?.available||!decision.rules?.length)return decision;
 const existingIds=new Set(state.rules.map(r=>r.id));
 const fresh=decision.rules.map((r,i)=>({r,i})).filter(({r})=>!existingIds.has(hash({key:r.key,value:r.value,scope:r.scope,category:r.category}).slice(0,24)));
 if(!fresh.length)return decision;
 const active=state.rules.filter(r=>r.status==='active');
 const result=await judge.matchRules(fresh.map(x=>x.r),active);
 if(!result.available){notes.push(`Jev 合并判断不可用（${result.code}），由整理模型自行合并`);return decision;}
 const rules=[...decision.rules],attach=[...(decision.attach || [])],moved=new Set();
 for(const [index,id] of Object.entries(result.matches)) {
  const {r,i}=fresh[index],trial=structuredClone(state);
  try{addSources(trial,sources);mergeLearning(trial,{attach:[{id,evidence:r.evidence}]});attach.push({id,evidence:r.evidence});moved.add(i);notes.push(`Jev 判定“${r.text.slice(0,40)}”与已有经验 ${id} 相同，已合并证据`);}
  catch{}
 }
 return {...decision,rules:rules.filter((_,i)=>!moved.has(i)),attach};
}

export async function runConsolidation(library,{config,learner,judge,mode='if-due',userHome=homedir(),now=Date.now(),progress=()=>{}}={}) {
 const lockRoot=join(library.root,'history','consolidations');
 try {
  // 单批最多 3 次 15 分钟的模型调用；超过 6 小时的锁视为被中断的整理留下的。
  return await withLock(lockRoot,()=>consolidate(library,{config,learner,judge,mode,userHome,now,progress}),mode==='if-due'?0:10000,{staleAfter:6*36e5});
 }catch(error){
  // 只有整理锁本身被占用才算 locked；个人库事务超时等照常报错。
  if(/正被其他进程使用/.test(error.message)&&error.message.includes(lockRoot))return {status:'locked'};
  throw error;
 }
}
async function consolidate(library,{config,learner,judge,mode,userHome,now,progress}) {
 const scanned=await scanTranscripts(await library.read(),{config,userHome,libraryRoot:library.root,now});
 const {result:added}=await library.transact('scan-transcripts',state=>applyScan(state,scanned,{now:new Date(now).toISOString()}));
 const last=await lastConsolidation(library);
 let state=await library.read();
 const scan={added:added?.length || 0,skipped:{...scanned.skipped,errors:scanned.skipped.errors.length}};
 if(mode==='if-due'&&!isDue(state,last,config,now))return {status:'not-due',pending:Object.keys(state.inbox || {}).length,scan};
 if(!eligible(state,now).length&&mode!=='all-existing')return {status:'empty',pending:Object.keys(state.inbox || {}).length,scan};
 if(!learner)throw new Error('整理需要模型后端');
 const runs=[];
 let before;
 do {
  before=eligible(state,now).length;
  runs.push(await batchOnce(library,{config,learner,judge,now,progress,scan,rulesOnly:!before}));
  state=await library.read();
 } while(mode==='all-existing'&&eligible(state,now).length&&eligible(state,now).length<before);
 const failed=runs.filter(r=>r.error);
 const summary={status:failed.length===runs.length?'failed':(failed.length?'partial':'consolidated'),...(failed.length?{errors:failed.map(r=>r.error)}:{}),runs:runs.map(r=>r.id),processed:runs.reduce((n,r)=>n+r.processed,0),proposals:runs.reduce((n,r)=>n+r.proposals,0),pending:Object.keys(state.inbox || {}).length,scan,report:runs.at(-1).report};
 await writeJson(join(library.root,'history','consolidations','last.json'),{id:runs.at(-1).id,at:new Date(now).toISOString(),mode,...summary,judge:runs.at(-1).judge});
 return summary;
}

// 三次修复仍不通过：首次失败推迟一天重试，再次失败就放弃这些会话（移出收件箱，有新消息时才重新排队），其他会话照常整理。
async function failBatch(library,{id,root,batch,unreadable,error,now,judgeStatus}) {
 let abandoned=0;
 await library.transact('consolidate-failed',draft=>{
  for(const s of batch){const e=draft.inbox[s.key];if(!e)continue;e.failures=(e.failures || 0)+1;e.lastError=error.message.slice(0,300);
   if(e.failures<2){e.retryAfter=new Date(now+864e5).toISOString();continue;}
   const t=draft.transcripts?.[s.key];if(t){t.processedUsers=e.users;t.abandoned={at:new Date(now).toISOString(),run:id,error:e.lastError};}
   delete draft.inbox[s.key];abandoned++;}
  for(const u of unreadable)delete draft.inbox[u.key];
 });
 const report=`# 经验整理 ${id}\n\n- 整理失败：${error.message.slice(0,300)}\n- 本批 ${batch.length} 个会话：${batch.length-abandoned} 个推迟一天重试，${abandoned} 个已第二次失败并放弃\n- 判断层：${judgeStatus}\n\n原始输入与每次被拒的模型结果保存在本目录。\n`;
 await atomicWrite(join(root,'report.md'),report);
 return {id,report:join(root,'report.md'),processed:0,proposals:0,judge:judgeStatus,error:error.message.slice(0,300)};
}
async function batchOnce(library,{config,learner,judge,now,progress,scan,rulesOnly}) {
 const id=`${new Date(now).toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,6)}`,root=join(library.root,'history','consolidations',id);
 const state=await library.read(),notes=[];
 const entries=eligible(state,now).sort((a,b)=>a[1].at.localeCompare(b[1].at)).slice(0,rulesOnly?0:config.consolidate.maxSessionsPerRun);
 const batch=[],unreadable=[];let chars=0;
 for(const [key,entry] of entries) {
  try{
   const s=await readTranscript(entry.path),item={...s,key,entry,fixedTask:state.transcripts?.[key]?.task};
   const size=JSON.stringify(sessionView(item,item.fixedTask)).length;
   // 至少放入一个会话；其余超出本批字数上限的留到下一批。
   if(batch.length&&chars+size>BATCH_CHARS)break;
   chars+=size;batch.push(item);
  }
  catch(error){unreadable.push({key,error:error.message.slice(0,200)});}
 }
 // Jev 初筛：只丢弃高置信的非文档会话；不确定的交给整理模型。
 let dropped=[],judgeStatus=judge?.available?judge.identity:`unavailable:${judge?.reason || 'not-configured'}`;
 if(batch.length&&judge?.available) {
  const result=await judge.classify(batch.map(s=>({id:s.key,title:s.title,context:s.context,messages:s.messages})));
  if(result.available) {
   dropped=batch.filter(s=>result.results[s.key]?.decision==='drop').map(s=>({key:s.key,probability:result.results[s.key].document}));
   for(const s of batch){const r=result.results[s.key];if(r?.kind&&r.decision!=='drop')s.kindHint=r.kind;}
  } else {judgeStatus=`fallback:${result.code}`;notes.push(`Jev 不可用（${result.code}），全部会话交给整理模型判断`);}
 } else if(batch.length)notes.push(`未启用 Jev（${judgeStatus}），全部会话交给整理模型判断`);
 const kept=batch.filter(s=>!dropped.some(d=>d.key===s.key));
 const request={mode:'consolidation',sandbox:root,instruction:consolidationInstructions.split('\n\n').at(-1),sessions:kept.map(s=>({...sessionView(s,s.fixedTask),...(s.kindHint?{kindHint:s.kindHint}:{})})),knowledge:knowledgeView(state),pendingProposals:(state.proposals || []).filter(p=>p.status==='pending').map(p=>({id:p.id,from:p.from,scope:p.scope,text:p.text}))};
 await writeJson(join(root,'input.json'),{...request,dropped,unreadable});
 progress({phase:'learning',sessions:kept.length,dropped:dropped.length});
 let decision,checked,failure;
 // 没有待学会话时只有迁移的复核轮（rulesOnly）才调用模型。
 if(kept.length||(rulesOnly&&request.knowledge.length)) {
  for(let attempt=0;attempt<3;attempt++) {
   try {
    decision=restoreSessionIds(await learner({...request,...(failure?{repair:failure}:{})}),kept);
    const sources=uniqueSources(state,kept.filter(s=>decision.sessions?.find(x=>x.id===s.key)?.document).flatMap(s=>sourcesFor(s,decision.sessions.find(x=>x.id===s.key))));
    decision=splitForeignAttach(state,await mergeByJudge(state,judge,decision,sources,notes),sources,notes);
    checked=validateDecision(state,kept,decision,config,{dropInvalidProposals:attempt===2});
    break;
   }catch(error){
    await writeJson(join(root,`rejected-${attempt}.json`),{decision,error:error.message});
    if(attempt===2)return failBatch(library,{id,root,batch,unreadable,error,now,judgeStatus});
    failure={validationError:error.message,previousOutput:decision,instruction:'只修复结构、范围或引文错误；证据逐字引用 sessions 中用户消息原文和 id，已有经验用 attach 合并，不杜撰来源。'};
   }
  }
 } else {decision={sessions:[],rules:[],attach:[],observations:[],promote:[]};checked={judged:new Map(),sources:[],changes:[],proposals:[],rejected:[]};}
 await writeJson(join(root,'result.json'),{decision,notes,dropped,created:new Date(now).toISOString()});
 const processed=[...batch.map(s=>s.key),...unreadable.map(u=>u.key)];
 const {result}=await library.transact('consolidate',draft=>{
  // 只保存被证据引用的用户消息，不把整段会话写进个人库。
  const cited=new Set([...(decision.rules || []),...(decision.attach || []),...(decision.observations || [])].flatMap(x=>(x.evidence || []).map(e=>e.source)));
  const changes=mergeLearning(draft,{sources:checked.sources.filter(s=>cited.has(s.id)),rules:decision.rules || [],attach:decision.attach || [],observations:decision.observations || []});
  draft.proposals ||= [];
  const added=[];
  for(const p of checked.proposals) {
   const pid=proposalId(p);
   if(draft.proposals.some(x=>x.id===pid))continue;
   // 同一组来源已有待确认提案时不重复提出。
   if(draft.proposals.some(x=>x.status==='pending'&&stable([...x.from].sort())===stable([...p.from].sort())))continue;
   draft.proposals.push({id:pid,status:'pending',from:p.from,scope:p.scope,text:p.text.trim(),strength:p.strength,reason:p.reason || '',tier:p.tier,support:p.support,run:id,at:new Date(now).toISOString()});added.push(pid);
  }
  for(const key of processed) {
   const entry=draft.inbox[key];if(!entry)continue;
   const t=draft.transcripts[key] ||= {agent:entry.agent,path:entry.path,cwd:entry.cwd};
   t.processedUsers=entry.users;t.lastRun=id;
   const judged=checked.judged.get(key);
   if(judged?.document){t.task=judged.task;t.kind=judged.kind;t.document=true;}
   else t.document=false;
   delete draft.inbox[key];
  }
  return {changes,proposals:added};
 });
 const catalog=await exportCatalog(library);
 const count=action=>result.changes.filter(c=>c.action===action).length;
 const documents=[...checked.judged.values()].filter(x=>x.document);
 const report=`# 经验整理 ${id}\n\n- 处理会话：${batch.length}（Jev 判定非文档并跳过 ${dropped.length}，整理模型判定文档 ${documents.length}）${unreadable.length?`；无法读取 ${unreadable.length}`:''}\n- 判断层：${judgeStatus}\n- 新建经验 ${count('create')} 条，合并证据 ${count('merge-evidence')} 条，新增晋升提案 ${result.proposals.length} 条\n${notes.map(n=>`- ${n}`).join('\n')}\n\n## 文档会话\n\n${documents.map(d=>`- ${d.task}（${d.kind}）：${d.id}`).join('\n') || '无'}\n\n## 晋升提案\n\n${checked.proposals.map(p=>`- ${p.text}（来源 ${p.from.join('、')}；目标范围 ${JSON.stringify(p.scope)}；${p.support} 份文档）`).join('\n') || '无'}\n${checked.rejected.length?`\n## 未通过校验的提案\n\n${checked.rejected.map(r=>`- ${r.proposal.text?.slice(0,80)}：${r.error}`).join('\n')}\n`:''}\n手册：${catalog.knowledge}\n原始输入与模型结果保存在本目录。\n`;
 await atomicWrite(join(root,'report.md'),report);
 return {id,report:join(root,'report.md'),processed:processed.length,proposals:result.proposals.length,judge:judgeStatus};
}

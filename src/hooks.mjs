import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { hash, stable } from './io.mjs';
import { mergeLearning, addSources, retrieve, scopeMatch } from './knowledge.mjs';
import { publishSkills, retireSkills } from './skills.mjs';
import {findTurn,claimRecovery,releaseRecovery,validRecovery,isTerminal as terminal} from './recovery.mjs';
import {exportCatalog} from './catalog.mjs';

const cli = fileURLToPath(new URL('../bin/document-learning.mjs',import.meta.url));
const entry = fileURLToPath(new URL('../skills/document-learning/SKILL.md',import.meta.url));
export const sessionKey = (agent,id) => `${agent}-${hash(String(id)).slice(0,24)}`;
function contextOutput(event,text) { return {hookSpecificOutput:{hookEventName:event,additionalContext:text}}; }

function signalFrom(value, depth = 0) {
  if (depth > 10 || value === null || value === undefined) return null;
  if (typeof value === 'object') {
    if (value.document_learning_signal) return value.document_learning_signal;
    for (const v of Object.values(value)) { const found = signalFrom(v,depth+1); if (found) return found; }
  } else if (typeof value === 'string' && value.length < 500000) {
    for (const line of value.split(/\r?\n/)) {
      if (!line.trim().startsWith('{')) continue;
      try { const found = signalFrom(JSON.parse(line),depth+1); if (found) return found; } catch {}
    }
  }
  return null;
}
function guidance(key,turn) {
  const recovery=(turn.recoveryTickets || []).some(t=>t.expires>Date.now())?`另有一轮未完成补学，先运行 node ${JSON.stringify(cli)} recover --session ${key} --turn ${JSON.stringify(turn.id)} --token ${turn.token} 只读取得原始证据及恢复票据；按其说明补做回执，不继续旧业务操作。`:'';
  return `文档学习：先判断本轮是否实际制作、修订或审阅文档（讨论插件/编程不算）。用只输出 JSON 的命令 node ${JSON.stringify(cli)} signal --session ${key} --turn ${JSON.stringify(turn.id)} --token ${turn.token} --document false 提交判断。文档任务改为 true，增加 --task 稳定文档标识 --kind 文档类型，随后按需读取 ${JSON.stringify(entry)}；复杂 context 可用 JSON stdin 或 --base64 提交。signal 不修改文件，由宿主 hook 保存；计划模式同样可用。不向用户询问是否记录。这些是内部治理步骤，完成后直接回答原任务，回复中不列信号或回执。${recovery}`;
}
function compactMatches(match,skills,candidates=[]) {
  const short=r=>({id:r.id,key:r.key,value:r.value,text:r.text.slice(0,260),scope:r.scope,strength:r.strength,...(r.text.length>260?{truncated:true}:{})});
  const describe=s=>({name:s.name,title:s.title,path:s.path,scope:s.scope,implicit:s.implicit});
  const result={apply:match.apply.map(short),conflicts:match.conflicts.slice(0,6).map(c=>({key:c.key,rules:c.rules.slice(0,3).map(short),total:c.rules.length})),transfer:match.transfer.map(r=>({...short(r),requiresAdaptation:true})),uncertain:match.uncertain.slice(0,6).map(short),skills:skills.slice(0,6).map(describe),skillCandidates:candidates.slice(0,4).map(describe),moreAvailable:match.omitted>0};
  while(JSON.stringify(result).length>5000 && result.uncertain.length){result.uncertain.pop();result.moreAvailable=true;}
  while(JSON.stringify(result).length>5000 && result.apply.length){result.apply.pop();result.moreAvailable=true;}
  while(JSON.stringify(result).length>5000 && result.transfer.length){result.transfer.pop();result.moreAvailable=true;}
  while(JSON.stringify(result).length>5000 && result.skillCandidates.length){result.skillCandidates.pop();result.moreAvailable=true;}
  return result;
}

export async function handleHook(library, agent, event, { repository } = {}) {
  const name = event.hook_event_name;
  if (!event.session_id || !name) throw new Error('hook 缺少会话标识或事件名');
  const key = sessionKey(agent,event.session_id);
  if (name === 'SessionStart') {
    await library.transact('session-start',state => {
      const session = state.sessions[key] ||= { agent, id:event.session_id, sequence:0 };
      session.cwd = event.cwd || session.cwd; session.lastStart = new Date().toISOString(); session.source = event.source || 'startup';
      session.permissionMode=event.permission_mode || session.permissionMode || 'default';
    });
    const s = (await library.read()).sessions[key];
    const pending = s.current && !terminal(s.current) ? `上轮 ${s.current.id} 尚未完成学习回执，恢复时继续处理。` : '';
    return contextOutput(name,`文档学习已连接本机个人库。每轮仅先判断相关性，实际文档任务再按需读取经验。已有技能的明确调用政策继续有效。${pending}`);
  }
  if (name === 'UserPromptSubmit') {
    await library.transact('prompt',state => {
      const session = state.sessions[key] ||= {agent,id:event.session_id,sequence:0};
      const prompt = String(event.prompt || '');
      if (session.current && !terminal(session.current) && session.current.prompt === prompt && (!event.turn_id || session.current.id === event.turn_id)) return;
      if(session.current)releaseRecovery(state,key,session.current.id);
      if (session.current && !terminal(session.current)) {session.current.receipt='pending-recovery';(session.pending ||= []).push(session.current);}
      session.sequence++;
      const id = event.turn_id || `${session.sequence}-${hash(prompt).slice(0,10)}`;
      session.current = {id,token:randomUUID(),prompt,cwd:event.cwd,permissionMode:event.permission_mode || session.permissionMode || 'default',receipt:'pending',repairCount:0,tools:[],at:new Date().toISOString()};
      claimRecovery(state,key,id);
    });
    const turn = (await library.read()).sessions[key].current;
    return contextOutput(name,guidance(key,turn));
  }
  const session = (await library.read()).sessions[key];
  if (!session?.current) return {};
  const turn = session.current;
  if (event.turn_id && event.turn_id !== turn.id) return {};
  if (name === 'PostToolUse') {
    const packet = signalFrom(event.tool_response ?? event.tool_result);
    if (packet && ((packet.session === key && packet.turn === turn.id && packet.token === turn.token)||validRecovery(await library.read(),key,packet))) {
      return processSignal(library,packet.session,packet,{repository,permissionMode:event.permission_mode,recoveryOwner:key});
    }
    if (turn.document && !terminal(turn)) await library.transact('tool-observation',state => {
      const current = state.sessions[key].current;
      if (current.tools.length >= 100) { current.toolsTruncated = true; return; }
      const raw = JSON.stringify({name:event.tool_name,input:event.tool_input,response:event.tool_response ?? event.tool_result});
      current.tools.push({digest:hash(raw),raw:raw.slice(0,20000),truncated:raw.length>20000});
    });
    return {};
  }
  if (name === 'Stop') {
    const state=await library.read(),unfinishedRecovery=(turn.recoveryTickets || []).some(ticket=>!terminal(findTurn(state,ticket.session,ticket.turn))&&ticket.expires>Date.now());
    if (terminal(turn)&&!unfinishedRecovery) return {};
    if (event.stop_hook_active || turn.repairCount >= 1) {
      await library.transact('receipt-missing',state => { if(!terminal(state.sessions[key].current))state.sessions[key].current.receipt = 'pending-recovery'; });
      return {systemMessage:'文档学习本轮回执未完成，已保留待恢复状态。'};
    }
    await library.transact('receipt-repair',state => { state.sessions[key].current.repairCount++; });
    return {decision:'block',reason:`补齐文档学习回执一次：${guidance(key,turn)} 已判定为文档时提交 phase=complete；确无新经验则 rules=[]、skills=[]，并提供 skillDecision 的 action 与具体维护理由。完成后直接结束，不增加用户审批。`};
  }
  if (['PreCompact','PostCompact','SessionEnd','StopFailure','Interrupt'].includes(name)) {
    await library.transact(name,state => {
      const s = state.sessions[key];
      s.lastLifecycle = {event:name,at:new Date().toISOString(),error:event.error || null};
      if(['SessionEnd','StopFailure','Interrupt'].includes(name))releaseRecovery(state,key,s.current.id);
      if (['StopFailure','Interrupt','SessionEnd'].includes(name)) s.current.receipt = terminal(s.current) ? s.current.receipt : 'pending-recovery';
    });
    if (name === 'PostCompact') return contextOutput(name,`文档学习状态已保存。${terminal(turn)?'本轮回执已完成。':guidance(key,turn)}`);
  }
  return {};
}

export async function processSignal(library,key,packet,{repository,permissionMode,recoveryOwner} = {}) {
  const initialState=await library.read(),current=findTurn(initialState,key,packet.turn);
  if (!current || current.id !== packet.turn || current.token !== packet.token) throw new Error('学习信号已过期或不属于当前会话');
  if(initialState.sessions[key]?.current!==current&&!validRecovery(initialState,recoveryOwner,packet))throw new Error('旧轮次需要有效恢复票据');
  if(packet.recoveryTicket&&!validRecovery(initialState,recoveryOwner,packet))throw new Error('恢复票据已过期');
  if (terminal(current)) return {};
  if (packet.sources) throw new Error('模型不能创建用户证据；来源由宿主提供');
  if (!['begin','complete'].includes(packet.phase)) throw new Error('无效学习阶段');
  if (packet.phase === 'begin') {
    if (typeof packet.document !== 'boolean') throw new Error('需要明确的文档相关性判断');
    const context = packet.context || {};
    if (packet.document && (!context.task || !context.kind)) throw new Error('文档任务需要 task 和 kind');
    await library.transact('classify',state => {
      const t = findTurn(state,key,packet.turn);
      t.document = packet.document; t.context = {...context,workspace:t.cwd || ''};
      if (!packet.document) { t.receipt = 'not-document'; return; }
      t.source = `${key}/${t.id}/user`;
      if(state.sources[t.source]) {
        if(state.sources[t.source].task!==context.task)throw new Error('同一轮的 task 标识应保持稳定；可补充其他条件');
      } else addSources(state,[{id:t.source,role:'user',text:t.prompt || '（空需求）',origin:'conversation',task:context.task,context:t.context}]);
      t.receipt = 'in-progress';
    });
    if (!packet.document) return {};
    const t = findTurn(await library.read(),key,packet.turn);
    const match = await retrieve(library,t.context);
    const available=Object.values({...((await library.read()).sourceSkills || {}),...(await library.read()).skills}).filter(s=>s.status!=='retired'&&(s.implicit!==false||t.prompt.includes(`$${s.name}`)));
    const skills=available.filter(s=>scopeMatch(s.scope,t.context)==='yes');
    const candidates=available.filter(s=>scopeMatch(s.scope,t.context)==='unknown');
    const deferred=((await library.read()).pendingPublications || []).filter(p=>p.task===t.context.task).map(p=>({id:p.id,names:p.skills.map(s=>s.name),reason:'计划期候选，请对照当前资料重新整理后再提交'}));
    return contextOutput('PostToolUse',`文档学习检索结果：${JSON.stringify({source:t.source,context:t.context,deferred,...compactMatches(match,skills,candidates)})}。当前需求优先。transfer 仅为其他任务的方法类比，判断是否依赖旧对象后才参考，不搬运参数、偏好或强制程度，不扩大原规则范围。skillCandidates 仅为已有能力目录，核对实际输入和范围后再决定是否读取，创建新技能前先检查覆盖。不要自动调用明确调用的技能。条目截断时可用 show-rule --name ID 按需查看完整来源。完成任务后使用相同 session/turn/token 提交 phase=complete，携带 rules、observations、retire、skills，并以 skillDecision={action:create/update/no-change,reason:具体覆盖及维护理由} 说明判断；无新经验可提交空数组。`);
  }
  if (!current.document || !current.context) throw new Error('先提交文档任务判断，再完成学习');
  if(!['create','update','retire','no-change'].includes(packet.skillDecision?.action)||typeof packet.skillDecision.reason!=='string'||!packet.skillDecision.reason.trim()||packet.skillDecision.reason.length>1200)throw new Error('完成学习前需提供 skillDecision：action=create/update/retire/no-change 及具体覆盖或维护理由；空数组不代表已经考虑技能迭代');
  const digest = hash(packet);
  await library.transact('turn-learning',state => {
    const t = findTurn(state,key,packet.turn);
    mergeLearning(state,{rules:packet.rules || [],revise:packet.revise || [],observations:packet.observations || [],retire:packet.retire || []});
    t.completionDigest = digest;
  });
  const planOnly=permissionMode==='plan' || current.permissionMode==='plan' || current.context.mode==='plan';
  if(planOnly && (packet.skills?.length || packet.retireSkills?.length)) {
    await library.transact('defer-publication',state=>{
      const proposal={task:current.context.task,skills:packet.skills || [],retireSkills:packet.retireSkills || []};
      const id=hash(proposal).slice(0,24);state.pendingPublications ||= [];
      if(!state.pendingPublications.some(p=>p.id===id))state.pendingPublications.push({id,...proposal});
      const t=findTurn(state,key,packet.turn);t.receipt='complete';t.publication='deferred-plan-mode';t.skillDecision=packet.skillDecision;
    });
    return contextOutput('PostToolUse','经验已记入个人库；计划期的技能候选尚未发布，下次同文档处于可实施模式时对照新资料重新整理。');
  }
  const skills = await publishSkills(library,packet.skills || [],{repository});
  const retired = await retireSkills(library,packet.retireSkills || []);
  await library.transact('turn-receipt',state => {
    const t = findTurn(state,key,packet.turn);
    t.receipt = skills.some(s=>s.status==='manual-change') ? 'pending-recovery' : ((packet.rules?.length || packet.revise?.length || packet.skills?.length || packet.retire?.length || packet.observations?.length || retired.length) ? 'complete' : 'no-new-learning');
    t.skillResults = skills;
    t.skillDecision=packet.skillDecision;
    if(terminal(t))delete t.recoveryLease;
    const completedNames=new Set([...skills.filter(s=>s.status==='published').map(s=>s.name),...retired.map(s=>s.name)]);
    state.pendingPublications=(state.pendingPublications || []).filter(p=>p.task!==t.context.task || [...p.skills,...p.retireSkills].some(s=>!completedNames.has(s.name)));
  });
  await exportCatalog(library);
  return contextOutput('PostToolUse',`文档学习回执：${findTurn(await library.read(),key,packet.turn).receipt}。${JSON.stringify(skills)}`);
}

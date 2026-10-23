import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { hash } from './io.mjs';
import { addSources } from './knowledge.mjs';
import { isUserQuestion, userAnswers } from './user-feedback.mjs';
import { consolidationStatus, STALE_DAYS } from './consolidate.mjs';

// 实时路径只做三件事：登记本轮请求（供 remember 引用）、登记问答回答（供晋升确认引用）、
// 在会话开始和结束时后台触发一次到期检查。经验整理由后台批量完成，不再要求当前模型逐轮提交。
export const cli = fileURLToPath(new URL('../bin/document-learning.mjs',import.meta.url)).replaceAll('\\','/');
export const sessionKey = (agent,id) => `${agent}-${hash(String(id)).slice(0,24)}`;
// 宿主的后台模型调用（ambient 建议、审批复核等）运行在非持久化线程上，载荷中 transcript_path 为 null。
// 只认显式 null：字段缺失按普通会话处理；Claude Code 的 transcript_path 恒定存在，不受影响。
const isBackgroundCall = event => event.transcript_path === null;
function contextOutput(event,text) { return {hookSpecificOutput:{hookEventName:event,additionalContext:text}}; }
export const guidance = key => `如需立即记住某条经验，运行 node "${cli}" remember --session ${key}；写文档前按技能读取 knowledge/<kind>.md。`;

// 后台到期检查：分离进程、标记为 worker，宿主 hook 不等待它。测试和受控环境可关闭。
export function triggerConsolidation({env = process.env} = {}) {
  if (env.DOCUMENT_LEARNING_NO_TRIGGER === '1') return false;
  const child = spawn(process.execPath,[cli,'consolidate','--if-due'],{detached:true,stdio:'ignore',windowsHide:true,env:{...env,DOCUMENT_LEARNING_WORKER:'1'}});
  child.on('error',()=>{});
  child.unref();
  return true;
}

export const SESSION_LIMIT = 50;
function pruneSessions(state, keepKey) {
  const keys = Object.keys(state.sessions);
  if (keys.length <= SESSION_LIMIT) return;
  const oldest = keys.filter(key => key !== keepKey).sort((a, b) => String(state.sessions[a].lastSeen || state.sessions[a].lastStart || '').localeCompare(String(state.sessions[b].lastSeen || state.sessions[b].lastStart || '')));
  for (const key of oldest.slice(0, keys.length - SESSION_LIMIT)) delete state.sessions[key];
}

async function captureFeedback(library,key,event) {
  const answers=userAnswers(event);
  if(!answers.length)return {};
  let added=[];
  await library.transact('user-feedback',state=>{
    const session=state.sessions[key];
    if(!session?.current)return;
    const call=hash(event.tool_use_id || {name:event.tool_name,input:event.tool_input,answers}).slice(0,24);
    const sources=answers.map((answer,i)=>({id:`${key}/${session.current.id}/answer/${call}/${i}`,role:'user',origin:'user-question',at:new Date().toISOString(),context:{workspace:session.cwd || ''},...answer}));
    for(const source of sources) {
      const old=state.sources[source.id];
      if(old&&(old.text!==source.text||old.question!==source.question))throw new Error(`来源 ID 内容冲突：${source.id}`);
    }
    added=sources.filter(source=>!state.sources[source.id]);
    addSources(state,added);
  });
  if(!added.length)return {};
  return contextOutput('PostToolUse',`文档学习已登记用户回答：${JSON.stringify(added.map(s=>({source:s.id,question:s.question,text:s.text})))}。确认晋升或 remember 引用时使用这些 source。`);
}

export async function handleHook(library, agent, event, { trigger = triggerConsolidation, now = Date.now() } = {}) {
  const name = event.hook_event_name;
  if (!event.session_id || !name) throw new Error('hook 缺少会话标识或事件名');
  const key = sessionKey(agent,event.session_id);
  if (isBackgroundCall(event)) {
    // 丢弃必须可审计：每次后台调用只记一条汇总，不保存载荷。
    if (name === 'SessionStart') await library.transact('background-call', state => {
      const background = state.background ||= { count: 0, lastAt: null, lastAgent: null };
      background.count++; background.lastAt = new Date(now).toISOString(); background.lastAgent = agent;
    });
    return {};
  }
  if (name === 'SessionStart') {
    await library.transact('session-start',state => {
      const session = state.sessions[key] ||= { agent, id:event.session_id, sequence:0 };
      session.cwd = event.cwd || session.cwd; session.lastStart = session.lastSeen = new Date(now).toISOString(); session.source = event.source || 'startup';
      pruneSessions(state,key);
    });
    trigger();
    const status = await consolidationStatus(library,{now});
    const lines = ['文档学习已连接本机个人库：经验由后台批量整理，普通聊天和编程无需执行任何文档学习命令。'];
    if (status.proposals) lines.push(`有 ${status.proposals} 条经验晋升提案待确认：仅在用户方便时运行 node "${cli}" proposals 查看，用提问工具征得用户同意后运行 promote --id 提案 --confirm-source 回答来源。`);
    if (status.stale) lines.push(`经验整理已超过 ${STALE_DAYS} 天未运行，可运行 node "${cli}" doctor 检查计划任务。`);
    return contextOutput(name,lines.join(''));
  }
  if (name === 'UserPromptSubmit') {
    const prompt = String(event.prompt || '');
    await library.transact('prompt',state => {
      const session = state.sessions[key] ||= {agent,id:event.session_id,sequence:0};
      if (session.current?.prompt === prompt && (!event.turn_id || session.current.id === event.turn_id)) return;
      session.sequence = (session.sequence || 0) + 1;
      session.cwd = event.cwd || session.cwd; session.lastSeen = new Date(now).toISOString();
      session.current = {id:event.turn_id || `${session.sequence}-${hash(prompt).slice(0,10)}`,prompt,at:new Date(now).toISOString()};
      pruneSessions(state,key);
    });
    return contextOutput(name,guidance(key));
  }
  if (name === 'PostToolUse' && isUserQuestion(event.tool_name)) {
    if (!(await library.read()).sessions[key]?.current) return {};
    return captureFeedback(library,key,event);
  }
  if (name === 'SessionEnd') {
    await library.transact('session-end',state => {
      const s = state.sessions[key];
      if (s) s.lastLifecycle = {event:name,at:new Date(now).toISOString()};
    });
    trigger();
  }
  return {};
}

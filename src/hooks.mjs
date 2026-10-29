import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hash } from './io.mjs';
import { addSources } from './knowledge.mjs';
import { isUserQuestion, userAnswers } from './user-feedback.mjs';
import { consolidationStatus, STALE_DAYS } from './consolidate.mjs';
import { manualRoot } from './catalog.mjs';
import { defaults } from './config.mjs';

// 实时路径只做三件事：登记本轮请求（供 remember 引用）、登记问答回答（供晋升确认引用）、
// 在会话开始和结束时后台触发一次到期检查。经验整理由后台批量完成，不再要求当前模型逐轮提交。
export const cli = fileURLToPath(new URL('../bin/document-learning.mjs',import.meta.url)).replaceAll('\\','/');
export const sessionKey = (agent,id) => `${agent}-${hash(String(id)).slice(0,24)}`;
// 宿主的后台模型调用（ambient 建议、审批复核等）运行在非持久化线程上，载荷中 transcript_path 为 null。
// 只认显式 null：字段缺失按普通会话处理；Claude Code 的 transcript_path 恒定存在，不受影响。
const isBackgroundCall = event => event.transcript_path === null;
function contextOutput(event,text) { return {hookSpecificOutput:{hookEventName:event,additionalContext:text}}; }
export const guidance = (library,key) => `如需立即记住某条经验，运行 node "${cli}" remember --session ${key}；写文档前先读 "${join(manualRoot(library),'core.md')}" 及对应类型手册。`;

// PostToolUse 每调用一次工具都会运行。先在内存里判断事件是否与文档技能或手册有关，
// 无关事件直接返回；只有命中后才读取个人库和手册目录。
const shellTools = new Set(['bash','shell','exec_command','local_shell','unified_exec','exec','powershell']);
const nonSkillDirs = new Set(['notes','docs','assets','scripts','tests','examples','history','cases','knowledge','versions','publish','skill-backups']);
// 读取类命令白名单：只有这些命令的路径参数才算读文件，ls、echo 等只列目录或回显文本。
const readCommands = new Set(['cat','type','get-content','gc','head','tail','less','more','sed','awk','rg','grep','select-string','sls','findstr','bat']);
// 这些命令的第一个非选项参数是匹配/替换表达式，不是文件。
const patternCommands = new Set(['sed','awk','rg','grep','select-string','sls','findstr']);
const normPath = value => String(value).replaceAll('\\','/').toLowerCase();
const toolNameOf = event => String(event.tool_name || '').toLowerCase();
function inputOf(event) {
  const value = event.tool_input;
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : {}; }
    catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}
// 把命令文本按 &&、||、;、|、换行分段，再按空白分词；引号内的分隔符和空白保留。
function segmentsOf(text) {
  const segments=[],tokens=[];let token='',quote='',started=false;
  const pushToken=()=>{if(started){tokens.push(token);token='';started=false;}};
  const pushSegment=()=>{pushToken();if(tokens.length)segments.push(tokens.splice(0));};
  const chars=String(text);
  for(let i=0;i<chars.length;i++) {
    const char=chars[i];
    if(quote){if(char===quote)quote='';else token+=char;continue;}
    if(char==='"'||char==="'"){quote=char;started=true;continue;}
    if((char==='&'&&chars[i+1]==='&')||(char==='|'&&chars[i+1]==='|')){pushSegment();i++;continue;}
    if(char===';'||char==='|'||char==='\n'||char==='\r'){pushSegment();continue;}
    if(/\s/.test(char)){pushToken();continue;}
    token+=char;started=true;
  }
  pushSegment();
  return segments;
}
// 命令载荷可能是字符串，也可能是 argv 数组（Codex 的 exec_command 常见）。
function commandSegments(input) {
  const out=[];
  const add=value=>{
    if(typeof value==='string')out.push(...segmentsOf(value));
    else if(Array.isArray(value)&&value.every(item=>typeof item==='string'))out.push(value.map(item=>item.replace(/^(['"])(.*)\1$/,'$2')));
    else if(Array.isArray(value))for(const item of value)add(item);
    else if(value&&typeof value==='object')for(const item of Object.values(value))add(item);
  };
  const raw=input.command ?? input.cmd ?? input.commands;
  if(raw===undefined)add(input);else add(raw);
  return out;
}
const commandWord = token => String(token).replace(/^.*[\\/]/,'').replace(/\.exe$/i,'').toLowerCase();
// PowerShell 的 -Path:x 形式；-Path x 由分词自然拆成两个参数。
const psPath = /^-(?:path|literalpath|filepath):(.+)$/i;
// 读取命令的路径参数（仍可能是相对路径）。命令词不在白名单时没有路径参数。
function pathArguments(input) {
  const paths=[];
  for(const tokens of commandSegments(input)) {
    const command=commandWord(tokens[0]);
    if(!readCommands.has(command))continue;
    let pattern=patternCommands.has(command);
    for(const token of tokens.slice(1)) {
      if(token.startsWith('-')){const match=token.match(psPath);if(match)paths.push(match[1]);continue;}
      if(pattern){pattern=false;continue;}
      paths.push(token);
    }
  }
  return paths;
}
const skillNameOf = value => String(value || '').split(':').pop().trim().toLowerCase();
async function personalSkills(library) {
  try {
    const entries=await readdir(library.skillDirectory,{withFileTypes:true});
    return new Set(entries.filter(entry=>entry.isDirectory()&&!entry.name.startsWith('.')&&!nonSkillDirs.has(entry.name)).map(entry=>entry.name.toLowerCase()));
  } catch (error) { if (error.code==='ENOENT') return new Set(); throw error; }
}
async function isDocumentSkill(name,library,config) {
  if (!name || name==='document-learning') return false;
  if ((config?.hooks?.documentSkills ?? defaults.hooks.documentSkills).some(skill=>String(skill).toLowerCase()===name)) return true;
  return (await personalSkills(library)).has(name);
}
const absolutePath = (path,event) => resolve(event.cwd || process.cwd(),path);
// 只有手册目录内的 .md 文件才算读手册；resolve 会消除 ..，前缀比较不会误收 knowledge2 这类相邻目录。
function isManualFile(library,path,event) {
  const target=normPath(absolutePath(path,event));
  return target.endsWith('.md') && target.startsWith(`${normPath(manualRoot(library))}/`);
}
// 以 SKILL.md 结尾的路径参数：技能名取它的父目录名。
function skillDirOf(path,event) {
  const parts=absolutePath(path,event).split(/[\\/]/).filter(Boolean);
  return parts.at(-1)?.toLowerCase()==='skill.md' ? parts.at(-2)?.toLowerCase() || null : null;
}
function readsManual(event,agent,input,library) {
  const tool=toolNameOf(event);
  if(agent==='claude'&&tool!=='read'&&!shellTools.has(tool))return false;
  const direct=input.file_path ?? input.path;
  if(shellTools.has(tool))return pathArguments(input).some(path=>isManualFile(library,path,event));
  return typeof direct==='string' && isManualFile(library,direct,event);
}
async function triggeredSkill(event,agent,input,library,config) {
  const tool=toolNameOf(event);
  if (agent==='claude') {
    if (tool!=='skill') return null;
    const name=skillNameOf(input.skill ?? input.name);
    return name && await isDocumentSkill(name,library,config) ? name : null;
  }
  const path=input.file_path ?? input.path;
  const paths=shellTools.has(tool) ? pathArguments(input) : (typeof path==='string' ? [path] : []);
  for (const name of new Set(paths.map(item=>skillDirOf(item,event)).filter(Boolean))) {
    if (await isDocumentSkill(name,library,config)) return name;
  }
  return null;
}
async function manualFiles(library) {
  const rank = name => name==='core.md' ? 0 : name==='conditional.md' ? 2 : 1;
  try {
    const entries=await readdir(manualRoot(library),{withFileTypes:true});
    return entries.filter(entry=>entry.isFile()&&entry.name.endsWith('.md')&&entry.name!=='index.md').map(entry=>entry.name)
      .sort((a,b)=>rank(a)-rank(b)||a.localeCompare(b));
  } catch (error) { if (error.code==='ENOENT') return []; throw error; }
}
async function manualReminder(library,name) {
  const root=manualRoot(library),others=(await manualFiles(library)).filter(file=>file!=='core.md');
  const list=[join(root,'core.md'),...others.map(file=>join(root,file))].map(file=>`"${file}"`).join('、');
  return `检测到文档技能「${name}」：写文档前先读 ${list}，按文档类型选读，并查看手册中的「技能 ${name}」小节。`;
}

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

export async function handleHook(library, agent, event, { trigger = triggerConsolidation, now = Date.now(), config = defaults } = {}) {
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
    return contextOutput(name,guidance(library,key));
  }
  if (name === 'PostToolUse' && isUserQuestion(event.tool_name)) {
    if (!(await library.read()).sessions[key]?.current) return {};
    return captureFeedback(library,key,event);
  }
  if (name === 'PostToolUse') {
    const input=inputOf(event);
    // 先做纯内存判断，非文档技能、非手册读取的事件不访问个人库和手册目录。
    if (!readsManual(event,agent,input,library)) {
      const skill=await triggeredSkill(event,agent,input,library,config);
      if (!skill) return {};
      const session=(await library.read()).sessions[key];
      if (!session || session.manualRead) return {};
      return contextOutput(name,await manualReminder(library,skill));
    }
    const session=(await library.read()).sessions[key];
    if (!session || session.manualRead) return {};
    await library.transact('manual-read',state=>{
      const current=state.sessions[key];
      if (current && !current.manualRead) current.manualRead=new Date(now).toISOString();
    });
    return {};
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

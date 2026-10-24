import {open,readdir,readFile,stat} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {homedir} from 'node:os';
import {hash} from './io.mjs';
import {normalizeJsonl} from './history.mjs';

// 宿主会话文件的增量扫描。水位记录在 state.scan[path]={size,mtime,offset,head}；
// 文件未变不读取；只追加时先读新增字节，没有用户行就只推进水位；被截断或重建时从头开始。
// 消息 ID 依赖行号（Codex）或 uuid（Claude），因此确有新用户行时仍整份解析，保证 ID 稳定。
const HEAD_BYTES=256;
// 首次扫描只排队最近的会话；更早的历史已由旧流程学习过，只记录水位，需要时用 history-import/backfill 补学。
export const BASELINE_DAYS=7;
export function globToRegExp(pattern) {
 return new RegExp(`^${pattern.split('*').map(part=>part.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('.*')}$`,'i');
}
export const excluded=(value,patterns)=>!!value&&patterns.some(p=>globToRegExp(p).test(value)||globToRegExp(p).test(value.replaceAll('/','\\')));

async function list(dir,depth) {
 let entries;
 try{entries=await readdir(dir,{withFileTypes:true});}catch(e){if(['ENOENT','ENOTDIR'].includes(e.code))return [];throw e;}
 const files=[];
 for(const e of entries) {
  const path=join(dir,e.name);
  if(e.isFile()&&e.name.endsWith('.jsonl'))files.push(path);
  else if(e.isDirectory()&&depth>0)files.push(...await list(path,depth-1));
 }
 return files;
}
export async function transcriptFiles({userHome=homedir(),sources}={}) {
 const files=[];
 // Claude 只取项目目录下的主会话；子代理记录在 <session>/subagents 下，不单独整理。
 if(sources.claude) {
  const projects=join(userHome,'.claude','projects');
  for(const project of await readdir(projects,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;}))if(project.isDirectory())for(const f of await list(join(projects,project.name),0))files.push({agent:'claude',path:f});
 }
 if(sources.codex)for(const f of await list(join(userHome,'.codex','sessions'),6))files.push({agent:'codex',path:f});
 return files;
}
async function readRange(path,start,end) {
 const length=Math.max(0,end-start);if(!length)return Buffer.alloc(0);
 const f=await open(path,'r');
 try{const buffer=Buffer.alloc(length);const {bytesRead}=await f.read(buffer,0,length,start);return buffer.subarray(0,bytesRead);}finally{await f.close();}
}
const userLine=/"role"\s*:\s*"user"|"type"\s*:\s*"user_message"/;
// 后台整理器、补学和回放的请求本身也是会话；即使宿主保存了它们也不再整理。
// Codex 子代理（自动审批 guardian、派生线程）的"用户消息"是宿主转述的上下文，同样跳过。
export const isWorkerSession=(session,{libraryRoot}={})=>{
 if(session.subagent)return true;
 const cwd=session.context?.workspace || '';
 if(libraryRoot&&cwd){const a=resolve(cwd).toLowerCase(),b=resolve(libraryRoot).toLowerCase();if(a===b||a.startsWith(b.endsWith(sep)?b:b+sep))return true;}
 const first=session.messages.find(m=>m.role==='user')?.text || '';
 return /^\s*\{\s*"mode"\s*:\s*"(?:consolidation|current-material-backfill|replay)/.test(first) || /DOCUMENT_LEARNING_WORKER/.test(first.slice(0,200));
};
export const userMessages=session=>session.messages.filter(m=>m.role==='user'&&m.text.trim());

export async function readTranscript(path) {
 return normalizeJsonl(await readFile(path,'utf8'),path);
}

// 只读文件、返回需要写回 state 的变化；调用方在事务内用 applyScan 合并。
export async function scanTranscripts(state,{config,userHome,libraryRoot,now=Date.now()}={}) {
 const patterns=config.sources.excludePaths,watermarks=state.scan || {},baseline=!state.scan,updates={},sessions=[],skipped={excluded:0,worker:0,unchanged:0,noUser:0,errors:[]};
 for(const {agent,path} of await transcriptFiles({userHome,sources:config.sources})) {
  if(excluded(path,patterns)){skipped.excluded++;continue;}
  let info;try{info=await stat(path);}catch(e){if(e.code==='ENOENT')continue;throw e;}
  const old=watermarks[path],mtime=info.mtimeMs;
  if(old&&old.size===info.size&&old.mtime===mtime){skipped.unchanged++;continue;}
  if(baseline&&now-mtime>BASELINE_DAYS*864e5){updates[path]={size:info.size,mtime,offset:info.size,head:hash((await readRange(path,0,Math.min(HEAD_BYTES,info.size))).toString('latin1')),baseline:true};skipped.baseline=(skipped.baseline || 0)+1;continue;}
  // 开头摘要只覆盖上次已见的字节：短文件追加内容后前 256 字节会变化，但不代表重建。
  const headOf=async size=>hash((await readRange(path,0,Math.min(HEAD_BYTES,size))).toString('latin1'));
  const restart=!old||info.size<old.offset||old.head!==await headOf(old.offset);
  const head=await headOf(info.size);
  if(!restart) {
   const added=(await readRange(path,old.offset,info.size)).toString('utf8');
   if(!userLine.test(added)){updates[path]={size:info.size,mtime,offset:info.size,head,session:old.session};skipped.noUser++;continue;}
  }
  let session;
  try{session=await readTranscript(path);}
  catch(error){
   // 只有元数据、还没有消息的会话文件记下水位，等追加用户消息后再读。
   if(/没有可导入的会话消息/.test(error.message)){updates[path]={size:info.size,mtime,offset:info.size,head};skipped.noUser++;continue;}
   skipped.errors.push({path,error:error.message.slice(0,200)});continue;
  }
  updates[path]={size:info.size,mtime,offset:info.size,head,session:session.id,...(restart&&old?{restarted:now}:{})};
  if(excluded(session.context.workspace,patterns)){skipped.excluded++;continue;}
  if(isWorkerSession(session,{libraryRoot})){skipped.worker++;continue;}
  const users=userMessages(session).length;
  if(!users){skipped.noUser++;continue;}
  sessions.push({id:`${agent}:${session.id}`,agent,path,cwd:session.context.workspace || '',title:session.title,users,restart:restart&&!!old});
 }
 return {updates,sessions,skipped};
}
export function applyScan(state,{updates,sessions},{now=new Date().toISOString()}={}) {
 state.scan ||= {};state.inbox ||= {};state.transcripts ||= {};
 Object.assign(state.scan,updates);
 const added=[];
 for(const s of sessions) {
  const record=state.transcripts[s.id] ||= {agent:s.agent,path:s.path,cwd:s.cwd,processedUsers:0};
  record.path=s.path;record.cwd=s.cwd || record.cwd;
  // 文件被截断或重建后，旧的已处理计数不再可信，重新整理全部用户消息（证据合并是幂等的）。
  if(s.restart)record.processedUsers=0;
  if(s.users>record.processedUsers) {
   if(!state.inbox[s.id])added.push(s.id);
   state.inbox[s.id]={agent:s.agent,path:s.path,cwd:s.cwd,title:s.title,users:s.users,at:state.inbox[s.id]?.at || now,updated:now};
  }
 }
 return added;
}

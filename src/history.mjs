import {readFile} from 'node:fs/promises';
import {basename} from 'node:path';
import {hash} from './io.mjs';

function textOf(content) {
  if(typeof content==='string') return content;
  if(!Array.isArray(content)) return '';
  return content.filter(c=>['text','input_text','output_text'].includes(c.type)).map(c=>c.text || '').join('\n');
}
export function isEnvironmentMessage(text) {
  return /^\s*(?:# AGENTS\.md instructions\s*[\r\n]|<environment_context>|<turn_aborted>|<permissions instructions>|<collaboration_mode>|<skill>)/.test(text);
}
export function normalizeSession(raw, label='import') {
  const v=raw.structuredContent || raw;
  const items=Array.isArray(v.messages)?v.messages:(v.messages?.items || []);
  if(!items.length) throw new Error(`没有可导入的会话消息：${label}`);
  const id=v.session_id!==undefined?`codeg:${v.session_id}`:(v.id || label);
  const offset=Math.max(0,(v.messages?.total || items.length)-items.length);
  const task=v.context?.task || id;
  const context={task,workspace:v.workspace_path || v.cwd || '',...(v.context || {})};
  const messages=items.map((m,index)=>{
    const rawText=m.text ?? textOf(m.content);
    const text=m.role==='user'?rawText.split('\u001e')[0].trimEnd():rawText;
    return {id:m.id || `${id}/${offset+index}/${hash({role:m.role,text}).slice(0,12)}`,role:m.role,text,task,context,origin:'conversation',...(m.timestamp?{timestamp:m.timestamp}:{}),...(m.tools?.length?{tools:m.tools,toolDetailsAvailable:!!m.tool_results}:{} )};
  }).filter(m=>['user','assistant','tool'].includes(m.role) && !(m.role==='user'&&isEnvironmentMessage(m.text)));
  const warnings=[];
  if(v.messages?.truncated) warnings.push(`消息缺失：仅包含 ${items.length}/${v.messages.total}`);
  if(!messages.every(m=>m.timestamp)) warnings.push('缺少逐条时间戳；跨会话顺序以导入清单为准，不与提交时间强行对齐');
  if(messages.some(m=>m.tools?.length&&!m.toolDetailsAvailable)) warnings.push('工具记录只有调用名称，检查结果未验证');
  return {id,title:v.title || label,context,messages,completeness:{total:v.messages?.total || items.length,available:items.length,included:messages.length,filteredNonConversation:items.length-messages.length,truncated:!!v.messages?.truncated,warnings}};
}
export function normalizeJsonl(text,label) {
  const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/).filter(Boolean),rows=[];
  let incompleteTail=false;
  for(const [i,line] of lines.entries()) {
    try{rows.push(JSON.parse(line));}catch{if(i===lines.length-1){incompleteTail=true;break;}throw new Error(`${label} 第 ${i+1} 行不是完整 JSON`);}
  }
  const meta=rows.find(r=>r.type==='session_meta')?.payload;
  const codex=!!meta || rows.some(r=>r.type==='response_item');
  const messages=[];
  if(codex) {
    const useResponses=rows.some(r=>r.type==='response_item'&&r.payload?.type==='message');
    for(const [i,r] of rows.entries()) {
      const p=r.payload || {};
      if(useResponses && r.type==='response_item'&&p.type==='message'&&['user','assistant'].includes(p.role)) messages.push({role:p.role,text:textOf(p.content),timestamp:r.timestamp,id:`${meta?.id || label}/${i}`});
      else if(!useResponses && r.type==='event_msg'&&['user_message','agent_message'].includes(p.type)) messages.push({role:p.type==='user_message'?'user':'assistant',text:p.message || '',timestamp:r.timestamp,id:`${meta?.id || label}/${i}`});
      else if(r.type==='response_item'&&['function_call','function_call_output','custom_tool_call','custom_tool_call_output'].includes(p.type))messages.push({role:'tool',text:JSON.stringify(p),timestamp:r.timestamp,id:`${meta?.id || label}/${i}/tool`});
    }
  } else {
    for(const [i,r] of rows.entries()) {
      if(r.isMeta || r.isCompactSummary) continue;
      const m=r.message;
      if(!m || !['user','assistant'].includes(m.role)) continue;
      const text=textOf(m.content);
      if(text) messages.push({role:m.role,text,timestamp:r.timestamp,id:r.uuid || `${label}/${i}`});
      if(Array.isArray(m.content))for(const c of m.content.filter(x=>x.type==='tool_use'))messages.push({role:'tool',text:JSON.stringify(c),timestamp:r.timestamp,id:`${r.uuid || label}/${i}/call/${c.id}`});
      if(Array.isArray(m.content)) for(const c of m.content.filter(x=>x.type==='tool_result')) messages.push({role:'tool',text:textOf(c.content),timestamp:r.timestamp,id:`${r.uuid || label}/${i}/tool/${c.tool_use_id}`});
    }
  }
  const session=normalizeSession({id:meta?.id || rows.find(r=>r.sessionId)?.sessionId || label,cwd:meta?.cwd || rows.find(r=>r.cwd)?.cwd,messages},label);
  if(incompleteTail){session.completeness.truncated=true;session.completeness.warnings.push('JSONL 最后一行未完成，保留此前完整消息');}
  return session;
}
export async function importHistory(paths) {
  const sessions=[];
  for(const path of paths) {
    const text=await readFile(path,'utf8');
    if(/\.jsonl$/i.test(path)) sessions.push(normalizeJsonl(text,basename(path)));
    else {
      const value=JSON.parse(text.replace(/^\uFEFF/,''));
      for(const item of Array.isArray(value)?value:(value.sessions || [value])) sessions.push(normalizeSession(item,basename(path)));
    }
  }
  const seen=new Map();
  for(const s of sessions) {
    if(seen.has(s.id) && hash(seen.get(s.id))!==hash(s)) throw new Error(`会话重复且内容不一致：${s.id}`);
    seen.set(s.id,s);
  }
  return {schema:1,orderBasis:'provided-session-order; original-message-order',sessions:[...seen.values()],inputDigest:hash([...seen.values()]),warnings:[...seen.values()].flatMap(s=>s.completeness.warnings.map(w=>`${s.id}: ${w}`))};
}
export function replaySteps(dataset) {
  const steps=[];
  for(const session of dataset.sessions) {
    for(let index=0;index<session.messages.length;index++) {
      const message=session.messages[index];
      if(message.role!=='user' || !message.text.trim()) continue;
      steps.push({id:message.id,session:session.id,context:session.context,index,source:message,prefix:session.messages.slice(0,index+1)});
    }
  }
  return steps;
}

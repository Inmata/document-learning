import {hash} from './io.mjs';
import {mergeLearning,addSources} from './knowledge.mjs';
import {exportCatalog} from './catalog.mjs';

// 用户在当前会话明确要求“记住”时立即入库一条经验。证据必须逐字引用本轮用户请求或已登记的用户回答。
export function currentSource(state,key,{task,kind}={}) {
 const session=state.sessions[key];
 if(!session?.current?.prompt)throw new Error('没有找到当前会话的用户请求；remember 只能在 hook 已登记的会话中使用');
 const t=session.current,context={workspace:session.cwd || '',...(task?{task}:{}),...(kind?{kind}:{})};
 return {id:`${key}/${t.id}/user`,role:'user',text:t.prompt,origin:'conversation',...(task?{task}:{}),context};
}
export async function remember(library,{session,text,category='method',strength='default',scope={},quote,source,key,value='on',scopeBasis,task,kind,catalog={}}) {
 if(typeof text!=='string'||!text.trim())throw new Error('remember 需要 --text 经验正文');
 if(typeof quote!=='string'||quote.trim().length<2)throw new Error('remember 需要 --quote：逐字摘录用户本轮的原话');
 const {result}=await library.transact('remember',state=>{
  let sources=[],ref;
  if(source) {
   // 已登记的用户回答（问答工具）或其他原始用户来源。
   if(!state.sources[source])throw new Error('引用的用户来源不存在');
   ref=source;
  } else {
   const current=currentSource(state,session,{task,kind});
   const old=state.sources[current.id];
   // 同一轮在不同 task 下重复 remember 时沿用首次登记的来源。
   sources=old?[]:[current];ref=current.id;
  }
  const rule={key:key || `remember.${hash(text.trim()).slice(0,16)}`,value,text,category,strength,scope,evidence:[{source:ref,quote}],...(scopeBasis?{scopeBasis}:{})};
  addSources(state,sources);
  const changes=mergeLearning(state,{rules:[rule]});
  return {changes,source:ref};
 });
 const exported=await exportCatalog(library,catalog);
 return {...result,manuals:exported.manuals};
}

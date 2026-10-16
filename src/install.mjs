import {readFile,mkdir,symlink,readlink,unlink,rmdir,access,constants} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readJson,writeJson,atomicWrite,fingerprint,withLock,hash} from './io.mjs';
import {dataRoot,resolveLibrary,bindLibrary,readBinding} from './library.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const quoteSh=s=>`'${s.replaceAll("'",`'"'"'`)}'`;
const quotePs=s=>`'${s.replaceAll("'","''")}'`;
export const events={codex:['SessionStart','UserPromptSubmit','PostToolUse','Stop','PreCompact','PostCompact','SessionEnd','Interrupt'],claude:['SessionStart','UserPromptSubmit','PostToolUse','Stop','PreCompact','PostCompact','SessionEnd','StopFailure']};
const configPath=(home,agent)=>join(home,agent==='codex'?'.codex':'.claude',agent==='codex'?'hooks.json':'settings.json');
export function commandFor(agent,pluginRoot=root,windows=process.platform==='win32') {
  const script=join(pluginRoot,'bin','document-learning.mjs').replaceAll('\\','/');
  const node=process.execPath.replaceAll('\\','/');
  const q=agent==='codex'&&windows?quotePs:quoteSh;
  return `${agent==='codex'&&windows?'& ':''}${q(node)} ${q(script)} hook --agent ${agent} --owner document-learning`;
}
function removeOwned(config,commands) {
  const next=structuredClone(config);
  for(const [event,groups] of Object.entries(next.hooks || {})) {
    if(!Array.isArray(groups))throw new Error(`现有 ${event} hook 格式无法识别，保留原文件`);
    next.hooks[event]=groups.map(g=>({...g,hooks:g.hooks?.filter(h=>!commands.includes(h.command))})).filter(g=>g.hooks?.length);
    if(!next.hooks[event].length)delete next.hooks[event];
  }
  return next;
}
export async function install({base=dataRoot(),userHome=homedir(),agents=['codex','claude'],pluginRoot=root,repository}={}) {
  const library=await resolveLibrary({base});
  if(repository)await bindLibrary({base,library:library.root,skillRepository:repository});
  return withLock(join(base,'install'),async()=>{
    const registryPath=join(base,'installation.json'),registry=await readJson(registryPath,{schema:1,agents:{}});
    const results=[];
    for(const agent of agents) {
      if(!events[agent])throw new Error(`不支持的宿主：${agent}`);
      const path=configPath(userHome,agent),beforeHash=await fingerprint(path);
      const config=await readJson(path,{}),command=commandFor(agent,pluginRoot);
      const old=registry.agents[agent];
      const entry=join(userHome,agent==='codex'?'.codex':'.claude','skills','document-learning');
      let replaceOwnedLink=false;
      try {
        const currentTarget=resolve(await readlink(entry));
        if(currentTarget!==resolve(pluginRoot,'skills','document-learning')) {
          if(old?.entry===entry && currentTarget===resolve(old.pluginRoot,'skills','document-learning'))replaceOwnedLink=true;
          else throw new Error(`已有同名技能，未覆盖：${entry}`);
        }
      }
      catch(e){if(e.code!=='ENOENT')throw e;}
      const next=removeOwned(config,[...(old?.commands || []),command]);next.hooks ||= {};
      for(const event of events[agent]) {
        const handler={type:'command',command,timeout:agent==='codex'&&['SessionEnd','Interrupt'].includes(event)?3:10};
        if(agent==='codex'&&['SessionStart','UserPromptSubmit','PostToolUse'].includes(event))handler.additionalContextLimit=event==='PostToolUse'?8000:2400;
        (next.hooks[event] ||= []).push({hooks:[handler]});
      }
      if(beforeHash)await atomicWrite(join(base,'install','backups',`${agent}-${beforeHash}.json`),await readFile(path,'utf8'));
      if(await fingerprint(path)!==beforeHash)throw new Error('安装期间宿主配置发生变化，已保留原文件');
      await writeJson(path,next);
      await mkdir(join(entry,'..'),{recursive:true});
      let linked=false;
      if(replaceOwnedLink)await (process.platform==='win32'?rmdir(entry):unlink(entry));
      try {
        const target=await readlink(entry);
        if(resolve(target)!==resolve(pluginRoot,'skills','document-learning'))throw new Error(`已有同名技能，未覆盖：${entry}`);
        linked=true;
      } catch(e) { if(e.code==='ENOENT'){await symlink(join(pluginRoot,'skills','document-learning'),entry,process.platform==='win32'?'junction':'dir');linked=true;}else throw e; }
      registry.agents[agent]={path,commands:[command],entry,linked,pluginRoot:resolve(pluginRoot),runtime:process.execPath,script:join(pluginRoot,'bin','document-learning.mjs')};
      await writeJson(registryPath,registry);
      results.push({agent,config:path,entry,status:'installed-awaiting-new-session'});
    }
    await writeJson(registryPath,registry);
    return {library:library.root,agents:results};
  });
}
export async function uninstall({base=dataRoot(),agents}={}) {
  return withLock(join(base,'install'),async()=>{
    const path=join(base,'installation.json'),registry=await readJson(path,{schema:1,agents:{}}),results=[];
    for(const agent of agents || Object.keys(registry.agents)) {
      const record=registry.agents[agent];if(!record)continue;
      const current=await readJson(record.path,{});
      await writeJson(record.path,removeOwned(current,record.commands));
      if(record.linked) {
        try {if(resolve(await readlink(record.entry))===resolve(record.pluginRoot,'skills','document-learning'))await (process.platform==='win32'?rmdir(record.entry):unlink(record.entry));}
        catch(e){if(!['ENOENT','EINVAL'].includes(e.code))throw e;}
      }
      delete registry.agents[agent];results.push({agent,status:'removed; personal-library-preserved'});
    }
    await writeJson(path,registry);return results;
  });
}
export async function doctor({base=dataRoot()}={}) {
  const binding=await readBinding(base),installation=await readJson(join(base,'installation.json'),{agents:{}});
  if(!binding)return {status:'not-initialized',base};
  let library;
  try {library=await resolveLibrary({base,create:false});}catch(error){return {status:'binding-unavailable',binding,error:error.message};}
  const state=await library.read();
  const agents=[];
  for(const [agent,record] of Object.entries(installation.agents)) {
    const config=await readJson(record.path,{});
    const active=Object.values(state.sessions).filter(s=>s.agent===agent);
    const configured=events[agent].every(event=>config.hooks?.[event]?.some(g=>g.hooks?.some(h=>record.commands.includes(h.command))));
    let hookTrust;
    if(agent==='codex') {
      let settings='';try{settings=await readFile(join(record.path,'..','config.toml'),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
      const missing=[];
      for(const [event,groups]of Object.entries(config.hooks || {}))for(const [groupIndex,group]of groups.entries())for(const [handlerIndex,handler]of (group.hooks || []).entries())if(record.commands.includes(handler.command)) {
        const eventKey=event.replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase(),id=`${record.path}:${eventKey}:${groupIndex}:${handlerIndex}`;
        if(!settings.includes(`[hooks.state.'${id}']`)&&!settings.includes(`[hooks.state.${JSON.stringify(id)}]`))missing.push(event);
      }
      hookTrust={status:missing.length?'needs-review':'record-present-unverified',missing,nextStep:'在原生 Codex 中输入 /hooks，审核并信任文档学习条目；程序不修改信任。'};
    }
    agents.push({agent,configured,callbackObserved:active.some(s=>!!s.lastStart),lastStart:active.map(s=>s.lastStart).filter(Boolean).sort().at(-1)||null,pending:active.reduce((n,s)=>n+[s.current,...(s.pending || [])].filter(t=>t&&!['complete','not-document','no-new-learning'].includes(t.receipt)).length,0),...(hookTrust?{hookTrust}:{})});
  }
  let writable=true;
  try {await access(library.root,constants.W_OK);}catch{writable=false;}
  return {status:!writable?'library-read-only':agents.some(a=>a.hookTrust?.status==='needs-review'&&!a.callbackObserved)?'awaiting-hook-trust':'ready',library:library.root,revision:state.revision,ruleCount:state.rules.filter(r=>r.status==='active').length,archivedRuleCount:state.rules.filter(r=>r.status==='archived').length,skillCount:Object.keys(state.skills).length,deferredPublications:state.pendingPublications?.length || 0,binding,agents,note:'配置存在、宿主信任、真实 SessionStart 与完成回执分别报告。信任记录存在不代表当前定义哈希已经通过核对；以宿主审核和真实回调为准。'};
}

export async function syncPersonalSkills({base=dataRoot(),library}={}) {
  library ||= await resolveLibrary({base,create:false});
  return withLock(join(base,'install'),async()=>{
    const registryPath=join(base,'installation.json'),registry=await readJson(registryPath,{agents:{}}),results=[];
    for(const [agent,record] of Object.entries(registry.agents)) {
      record.personalSkills ||= {};
      for(const skill of Object.values((await library.read()).skills)) {
        const target=resolve(skill.path,'..');
        if(target!==resolve(library.root,'skills',skill.name)) {results.push({agent,name:skill.name,status:'outside-personal-directory'});continue;}
        const entry=join(record.entry,'..',skill.name);
        let actual=null;
        try {actual=resolve(await readlink(entry));}catch(error){if(error.code!=='ENOENT'){results.push({agent,name:skill.name,status:'name-conflict',entry});continue;}}
        if(actual && actual!==target){results.push({agent,name:skill.name,status:'name-conflict',entry});continue;}
        if(skill.status==='retired') {
          if(actual===target&&record.personalSkills[skill.name]?.target===target)await (process.platform==='win32'?rmdir(entry):unlink(entry));
          delete record.personalSkills[skill.name];continue;
        }
        if(!actual){await mkdir(join(entry,'..'),{recursive:true});await symlink(target,entry,process.platform==='win32'?'junction':'dir');}
        record.personalSkills[skill.name]={entry,target};results.push({agent,name:skill.name,status:'linked',entry});
      }
    }
    await writeJson(registryPath,registry);return results;
  });
}

import {readFile,mkdir,symlink,readlink,unlink,rmdir,access,constants,readdir,cp} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readJson,writeJson,atomicWrite,fingerprint,withLock,hash,exists} from './io.mjs';
import {dataRoot,resolveLibrary,bindLibrary,readBinding} from './library.mjs';
import {migrateManagedSkills} from './skills.mjs';
import {exportCatalog,renderRepoSkillTable} from './catalog.mjs';
import {rememberAllowRule,addSignalPermission,removeSignalPermission} from './claude-permissions.mjs';
import {loadConfig,writeDefaultConfig,configPath as userConfigPath} from './config.mjs';
import {consolidationStatus} from './consolidate.mjs';

const exec=promisify(execFile);
const docSkillTerms=/报告|文档|说明书|作业指导|图注|版式|母版|模板|合同|信函|提案|汇报|清洗|实验|现场|docx|pptx|xlsx|report|presentation|document|spreadsheet|contract|letter|proposal|\bsop\b|\bword\b|\bpowerpoint\b/i;
const nonSkillDirs=new Set(['notes','docs','assets','scripts','tests','examples','history','cases','knowledge','versions','publish','skill-backups']);
const root=fileURLToPath(new URL('../',import.meta.url));
const quoteSh=s=>`'${s.replaceAll("'",`'"'"'`)}'`;
const quotePs=s=>`'${s.replaceAll("'","''")}'`;
export const events={codex:['SessionStart','UserPromptSubmit','PostToolUse','SessionEnd'],claude:['SessionStart','UserPromptSubmit','PostToolUse','SessionEnd']};
export const TASK_NAME='DocumentLearningConsolidate';
const script=fileURLToPath(new URL('../bin/document-learning.mjs',import.meta.url));
// 计划任务：每 intervalMinutes 分钟一次，可选登录时一次，都只做到期检查。
export function scheduleCommands(config,{platform=process.platform,node=process.execPath,cli=script,base}={}) {
  const run=`"${node}" "${cli}" consolidate --if-due${base?` --home "${base}"`:''}`;
  const minutes=config.schedule.intervalMinutes;
  if(platform==='win32') {
    // node.exe 是控制台程序，直接运行会弹出终端窗口并抢走前台焦点；conhost --headless 不创建窗口。
    const hidden=`conhost.exe --headless ${run}`;
    const create=[['/Create','/F','/TN',TASK_NAME,'/SC','MINUTE','/MO',String(minutes),'/TR',hidden]];
    if(config.schedule.runAtLogon)create.push(['/Create','/F','/TN',`${TASK_NAME}-Logon`,'/SC','ONLOGON','/TR',hidden]);
    return {platform,create,remove:[['/Delete','/F','/TN',TASK_NAME],['/Delete','/F','/TN',`${TASK_NAME}-Logon`]]};
  }
  const cron=`${minutes<60?`*/${minutes} * * * *`:`0 */${Math.max(1,Math.round(minutes/60))} * * *`} DOCUMENT_LEARNING_WORKER=1 ${run}`;
  return {platform,manual:platform==='darwin'?`把以下条目加入 launchd（~/Library/LaunchAgents/com.document-learning.consolidate.plist 的 ProgramArguments 为 ${run}，StartInterval=${minutes*60}${config.schedule.runAtLogon?'，RunAtLoad=true':''}），或使用 crontab：
${cron}`:`crontab -e 加入：
${cron}${config.schedule.runAtLogon?`
@reboot DOCUMENT_LEARNING_WORKER=1 ${run}`:''}`};
}
async function schtasks(args,runner){return runner('schtasks',args,{windowsHide:true});}
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
export async function install({base=dataRoot(),userHome=homedir(),agents=['codex','claude'],pluginRoot=root,repository,skillDirectory,allowClaudeSignal=false,schedule=false,runner=exec,platform=process.platform}={}) {
  const configFile=await writeDefaultConfig(base),config=await loadConfig(base);
  let library=await resolveLibrary({base,skillDirectory});
  if(repository || skillDirectory)library=await bindLibrary({base,library:library.root,skillRepository:repository,skillDirectory});
  if(skillDirectory) {
    await migrateManagedSkills(library,{targetDirectory:library.skillDirectory});
    await exportCatalog(library,{skillDirectory:library.skillDirectory});
  }
  return withLock(join(base,'install'),async()=>{
    const registryPath=join(base,'installation.json'),registry=await readJson(registryPath,{schema:1,agents:{}});
    const results=[];
    for(const agent of agents) {
      if(!events[agent])throw new Error(`不支持的宿主：${agent}`);
      const path=configPath(userHome,agent),beforeHash=await fingerprint(path);
      const hostConfig=await readJson(path,{}),command=commandFor(agent,pluginRoot);
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
      const next=removeOwned(hostConfig,[...(old?.commands || []),command]);next.hooks ||= {};
      let signalPermission;
      const keepSignalPermission=agent==='claude'&&old?.signalPermission?.enabled&&Array.isArray(hostConfig.permissions?.allow)&&hostConfig.permissions.allow.includes(rememberAllowRule(old.pluginRoot));
      if(agent==='claude'&&(allowClaudeSignal||keepSignalPermission)) {
        removeSignalPermission(next,old?.signalPermission);
        signalPermission=addSignalPermission(next,pluginRoot);
      }
      for(const event of events[agent]) {
        const handler={type:'command',command,timeout:agent==='codex'&&['SessionEnd','Interrupt'].includes(event)?3:10};
        if(agent==='codex'&&['SessionStart','UserPromptSubmit','PostToolUse'].includes(event))handler.additionalContextLimit=event==='PostToolUse'?8000:2400;
        (next.hooks[event] ||= []).push({...(event==='PermissionDenied'?{matcher:'Bash'}:{}),hooks:[handler]});
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
      registry.agents[agent]={path,commands:[command],entry,linked,pluginRoot:resolve(pluginRoot),runtime:process.execPath,script:join(pluginRoot,'bin','document-learning.mjs'),...(signalPermission?{signalPermission}:{})};
      await writeJson(registryPath,registry);
      results.push({agent,config:path,entry,status:'installed-awaiting-new-session'});
    }
    let scheduled;
    // 计划任务总是带上本次安装的数据目录，避免 --home 安装后任务整理默认目录。
    const plan=scheduleCommands(config,{platform,base});
    if(plan.create) {
      if(schedule){for(const args of plan.create)await schtasks(args,runner);registry.schedule={name:TASK_NAME,intervalMinutes:config.schedule.intervalMinutes,runAtLogon:config.schedule.runAtLogon,created:new Date().toISOString()};scheduled={status:'created',name:TASK_NAME};}
      else scheduled={status:'not-created',note:'计划任务需要用户确认：确认后用 install --schedule 重新运行，修改 schedule 配置后同样需要重新运行。',commands:plan.create.map(a=>`schtasks ${a.map(x=>/\s/.test(x)?`"${x.replaceAll('"','\\"')}"`:x).join(' ')}`)};
    } else scheduled={status:'manual',instructions:plan.manual};
    await writeJson(registryPath,registry);
    return {library:library.root,config:configFile,agents:results,schedule:scheduled};
  });
}
export async function uninstall({base=dataRoot(),agents,runner=exec,platform=process.platform}={}) {
  return withLock(join(base,'install'),async()=>{
    const path=join(base,'installation.json'),registry=await readJson(path,{schema:1,agents:{}}),results=[];
    for(const agent of agents || Object.keys(registry.agents)) {
      const record=registry.agents[agent];if(!record)continue;
      const current=await readJson(record.path,{});
      const next=removeOwned(current,record.commands);removeSignalPermission(next,record.signalPermission);
      await writeJson(record.path,next);
      if(record.linked) {
        try {if(resolve(await readlink(record.entry))===resolve(record.pluginRoot,'skills','document-learning'))await (process.platform==='win32'?rmdir(record.entry):unlink(record.entry));}
        catch(e){if(!['ENOENT','EINVAL'].includes(e.code))throw e;}
      }
      delete registry.agents[agent];results.push({agent,status:'removed; personal-library-preserved'});
    }
    if(registry.schedule&&!Object.keys(registry.agents).length) {
      // 删除只需要任务名，不读取配置：配置文件无效时也能卸载。
      if(platform==='win32')for(const name of [TASK_NAME,`${TASK_NAME}-Logon`])await schtasks(['/Delete','/F','/TN',name],runner).catch(()=>{});
      delete registry.schedule;results.push({schedule:TASK_NAME,status:'removed'});
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
      // 信任记录齐全且已观察到真实回调，才算已激活；只有记录时哈希是否通过由 Codex 决定。
      const observed=active.some(s=>!!s.lastStart);
      hookTrust={status:missing.length?'needs-review':observed?'active':'record-present-unverified',missing,...(missing.length || !observed?{nextStep:'在原生 Codex 中输入 /hooks，审核并信任文档学习条目；程序不修改信任。'}:{})};
    }
    let rememberPermission;
    if(agent==='claude') {
      const rule=rememberAllowRule(record.pluginRoot);
      rememberPermission={status:Array.isArray(config.permissions?.allow)&&config.permissions.allow.includes(rule)?'configured-unverified':'not-configured',rule,note:'可选：install --allow-claude-signal 只授权以绝对路径运行 remember；deny/ask 与托管策略仍由宿主决定。'};
    }
    agents.push({agent,configured,callbackObserved:active.some(s=>!!s.lastStart),lastStart:active.map(s=>s.lastStart).filter(Boolean).sort().at(-1)||null,...(hookTrust?{hookTrust}:{}),...(rememberPermission?{rememberPermission}:{})});
  }
  let config,configError=null;
  try{config=await loadConfig(base);}catch(error){configError=error.message;}
  const consolidation=await consolidationStatus(library);
  let writable=true;
  try {await access(library.root,constants.W_OK);}catch{writable=false;}
  return {status:!writable?'library-read-only':configError?'config-invalid':agents.some(a=>a.hookTrust?.status==='needs-review'&&!a.callbackObserved)?'awaiting-hook-trust':consolidation.stale?'consolidation-stale':'ready',config:configError?{path:userConfigPath(base),error:configError}:{path:userConfigPath(base),effective:config},consolidation:{lastRun:consolidation.last?.at || null,lastReport:consolidation.last?.report || null,lastJudge:consolidation.last?.judge || null,pendingSessions:consolidation.pending,pendingProposals:consolidation.proposals,stale:consolidation.stale,schedule:installation.schedule || null},library:library.root,revision:state.revision,ruleCount:state.rules.filter(r=>r.status==='active').length,archivedRuleCount:state.rules.filter(r=>r.status==='archived').length,skillCount:Object.keys(state.skills).length,deferredPublications:state.pendingPublications?.length || 0,backgroundIgnored:state.background?.count || 0,binding,agents,note:'配置存在、宿主信任、真实 SessionStart 与后台整理分别报告。信任记录存在不代表当前定义哈希已经通过核对；以宿主审核和真实回调为准。'};
}

export async function syncPersonalSkills({base=dataRoot(),library,replaceTargets=[]}={}) {
  library ||= await resolveLibrary({base,create:false});
  const binding=await readBinding(base);
  const skillDir=resolve(binding?.skillDirectory || library.skillDirectory || join(library.root,'skills'));
  const replaceableRoots=[resolve(library.root,'skills'),...replaceTargets.map(p=>resolve(p))];
  return withLock(join(base,'install'),async()=>{
    const registryPath=join(base,'installation.json'),registry=await readJson(registryPath,{agents:{}}),results=[];
    const state=await library.read();
    const managedSkills={...(skillDir!==resolve(library.root,'skills')?Object.fromEntries(Object.entries(state.sourceSkills || {}).filter(([,s])=>s.path&&resolve(s.path,'..','..')===skillDir)):{}),...(state.skills || {})};
    for(const [agent,record] of Object.entries(registry.agents)) {
      record.personalSkills ||= {};
      for(const skill of Object.values(managedSkills)) {
        const target=resolve(skill.path,'..');
        if(target!==resolve(skillDir,skill.name)) {results.push({agent,name:skill.name,status:'outside-personal-directory'});continue;}
        const entry=join(record.entry,'..',skill.name);
        let actual=null;
        try {actual=resolve(await readlink(entry));}catch(error){if(error.code!=='ENOENT'){results.push({agent,name:skill.name,status:'name-conflict',entry});continue;}}
        const canReplace=actual&&actual!==target&&(actual===resolve(record.personalSkills[skill.name]?.target || '')||replaceableRoots.some(r=>actual===resolve(r,skill.name)));
        if(canReplace){await (process.platform==='win32'?rmdir(entry):unlink(entry));actual=null;}
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

export async function initSkillRepository({output,base=dataRoot(),bind=false,importFrom=[]}={}) {
  if(!output)throw new Error('init-skill-repo 需要 --output 目录');
  const repoRoot=resolve(output);
  await mkdir(join(repoRoot,'scripts'),{recursive:true});
  await mkdir(join(repoRoot,'knowledge'),{recursive:true});
  await mkdir(join(repoRoot,'cases'),{recursive:true});
  const imported=[];
  for(const sourceRepo of importFrom) {
    const srcRoot=resolve(sourceRepo);
    if(!(await exists(srcRoot)))continue;
    for(const entry of await readdir(srcRoot,{withFileTypes:true})) {
      if(!entry.isDirectory()||entry.name.startsWith('.')||nonSkillDirs.has(entry.name))continue;
      const skillFile=join(srcRoot,entry.name,'SKILL.md');
      if(!(await exists(skillFile)))continue;
      const text=await readFile(skillFile,'utf8');
      const desc=text.match(/^description:\s*(.*)$/m)?.[1] || '';
      if(!docSkillTerms.test(desc))continue;
      const dest=join(repoRoot,entry.name);
      if(!(await exists(dest))) {
        await cp(join(srcRoot,entry.name),dest,{recursive:true});
        imported.push(entry.name);
      }
    }
  }
  if(!(await exists(join(repoRoot,'.gitignore')))) {
    await atomicWrite(join(repoRoot,'.gitignore'),`.skills-backups/\n.test-output/\n.qa/\n.write-lock\n*.tmp\n`);
  }
  if(!(await exists(join(repoRoot,'.gitattributes')))) {
    await atomicWrite(join(repoRoot,'.gitattributes'),`* text=auto eol=lf\n*.cmd text eol=crlf\n*.ps1 text eol=crlf\n*.docx binary\n*.pptx binary\n*.xlsx binary\n*.pdf binary\n*.png binary\n*.jpg binary\n*.jpeg binary\n*.ico binary\n`);
  }
  if(!(await exists(join(repoRoot,'CONTRIBUTING.md')))) {
    await atomicWrite(join(repoRoot,'CONTRIBUTING.md'),`# 文档技能与长期经验仓库约定\n\n本仓库仅维护文档类技能与跨设备同步的长期文档经验，不混放编程技能或临时会话运行态。\n\n## 目录职责\n\n| 位置 | 职责 |\n| --- | --- |\n| \`<技能名>/SKILL.md\` | 模型入口：用途、必要约束、实际工作流程、按需读取参考资料及 \`document-learning\` 管理区 |\n| \`<技能名>/README.md\` | 使用者指南：适用范围、准备输入、可复制调用示例、流程与验收要点 |\n| \`<技能名>/agents/openai.yaml\` | 界面显示名、简介、默认提示及调用策略（显式或自动匹配） |\n| \`<技能名>/references/\` | 详细规则与说明（可选） |\n| \`<技能名>/assets/\` | 生成用模板、图片与示例素材（可选） |\n| \`<技能名>/scripts/\` | 结构检查与辅助脚本（可选） |\n| \`knowledge/index.md\` | 可阅读的长期文档经验、适用条件与原始引文 |\n| \`knowledge/memory.json\` | 供多设备自动同步的结构化长期经验与技能元数据（不含本机临时会话状态） |\n| \`cases/index.md\` | 具体案例事实与历史归档记录 |\n`);
  }
  if(!(await exists(join(repoRoot,'install.cmd')))) {
    await atomicWrite(join(repoRoot,'install.cmd'),`@echo off\r\npwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\install-skills.ps1" %*\r\n`);
  }
  if(!(await exists(join(repoRoot,'scripts','install-skills.ps1')))) {
    await atomicWrite(join(repoRoot,'scripts','install-skills.ps1'),`[CmdletBinding(SupportsShouldProcess = $true)]\r\nparam([string]$UserProfilePath = $env:USERPROFILE)\r\n$ErrorActionPreference = 'Stop'\r\n$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\\')\r\n$profile = [IO.Path]::GetFullPath($UserProfilePath).TrimEnd('\\')\r\n$reserved = @('notes','docs','assets','scripts','tests','examples','history','cases','knowledge','versions','publish','skill-backups')\r\n$skills = Get-ChildItem -LiteralPath $repository -Directory | Where-Object { $reserved -notcontains $_.Name -and -not $_.Name.StartsWith('.') -and (Test-Path -LiteralPath (Join-Path $_.FullName 'SKILL.md') -PathType Leaf) }\r\n$hosts = @('.codex', '.claude', '.codeg', '.agents')\r\nforeach ($skill in $skills) {\r\n  foreach ($hostName in $hosts) {\r\n    $destParent = Join-Path (Join-Path $profile $hostName) 'skills'\r\n    $dest = Join-Path $destParent $skill.Name\r\n    if ($PSCmdlet.ShouldProcess($dest, "Link -> $($skill.FullName)")) {\r\n      New-Item -ItemType Directory -Path $destParent -Force | Out-Null\r\n      $existing = Get-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue\r\n      if ($null -ne $existing) {\r\n        if (($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {\r\n          $currentTarget = [string]@($existing.Target)[0]\r\n          if (-not [string]::IsNullOrWhiteSpace($currentTarget) -and [IO.Path]::GetFullPath($currentTarget).TrimEnd('\\').Equals($skill.FullName.TrimEnd('\\'), [StringComparison]::OrdinalIgnoreCase)) { continue }\r\n          [IO.Directory]::Delete($dest)\r\n        } else { continue }\r\n      }\r\n      New-Item -ItemType Junction -Path $dest -Target $skill.FullName | Out-Null\r\n    }\r\n  }\r\n}\r\n`);
  }
  const readmePath=join(repoRoot,'README.md');
  if(!(await exists(readmePath))) {
    const emptyTable=renderRepoSkillTable({skills:{},sourceSkills:{}},repoRoot);
    await atomicWrite(readmePath,`# 文档技能与长期经验库\n\n个人维护的文档类技能与跨端同步文档经验合集，由 \`document-learning\` 自动协同维护。\n\n## 文档技能一览\n\n${emptyTable}\n\n## 长期经验与案例索引\n\n- [个人文档经验目录](knowledge/index.md)：跨文档复用的制作方法、条件偏好与调用规则。\n- [案例与历史归档](cases/index.md)：单次任务的工艺参数、案例事实与历史归档记录。\n- [仓库结构与维护约定](CONTRIBUTING.md)：目录职责、文件标准与同步边界说明。\n\n## 多端同步与安装\n\n在另一台电脑克隆本仓库后，把 \`<本仓库克隆目录>\` 替换成实际路径，在 \`document-learning\` 目录运行：\n\n\`\`\`powershell\nnode bin/document-learning.mjs bind --skill-directory '<本仓库克隆目录>'\nnode bin/document-learning.mjs sync-skills\n\`\`\`\n\n或直接双击本仓库根目录的 \`install.cmd\` 建立宿主技能目录链接。\n`);
  }
  let gitInitialized=false;
  try {
    if(!(await exists(join(repoRoot,'.git')))) {
      await exec('git',['init',repoRoot],{windowsHide:true});
      gitInitialized=true;
    }
  }catch{}
  let migrated=[],catalog=null,links=[];
  if(bind) {
    const currentLib=await resolveLibrary({base});
    const library=await bindLibrary({base,library:currentLib.root,skillDirectory:repoRoot});
    migrated=await migrateManagedSkills(library,{targetDirectory:repoRoot});
    catalog=await exportCatalog(library,{skillDirectory:repoRoot});
    links=await syncPersonalSkills({base,library,replaceTargets:importFrom});
  }
  return {repository:repoRoot,gitInitialized,imported,migrated,catalog,links};
}

async function gitRun(repo,args,{allowFailure=false,env}={}) {
  try {
    const {stdout,stderr}=await exec('git',['-C',repo,...args],{encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024,...(env?{env}:{})});
    return {ok:true,stdout:String(stdout).trim(),stderr:String(stderr).trim()};
  } catch(error) {
    if(!allowFailure)throw new Error(`git ${args.join(' ')} 失败：${String(error.stderr || error.message).trim().slice(0,400)}`);
    return {ok:false,stdout:String(error.stdout || '').trim(),stderr:String(error.stderr || error.message).trim()};
  }
}

const ansiPattern=/\u001b\[[0-9;?]*[A-Za-z]/g;
// gh inherits FORCE_COLOR in some terminals and then emits ANSI codes even through a pipe,
// which would break JSON parsing; strip colour and force plain output for every call.
async function ghRun(args,{allowFailure=false}={}) {
  try {
    const {stdout,stderr}=await exec('gh',args,{encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024,env:{...process.env,NO_COLOR:'1',FORCE_COLOR:'0'}});
    return {ok:true,stdout:String(stdout).replace(ansiPattern,'').trim(),stderr:String(stderr).replace(ansiPattern,'').trim()};
  } catch(error) {
    if(!allowFailure)throw new Error(`gh ${args.join(' ')} 失败：${String(error.stderr || error.message).replace(ansiPattern,'').trim().slice(0,400)}`);
    return {ok:false,stdout:String(error.stdout || '').replace(ansiPattern,'').trim(),stderr:String(error.stderr || error.message).replace(ansiPattern,'').trim()};
  }
}

// One-step "publish to a private remote": commit local changes if needed, then either
// create the GitHub repository through gh or reuse an explicit remote URL, and push.
export async function publishRepository({directory,remote,name,owner,visibility='private',branch,message,commit=true,create=true}={}) {
  const target=resolve(directory || '.');
  const probe=await gitRun(target,['rev-parse','--show-toplevel'],{allowFailure:true});
  if(!probe.ok)throw new Error(`不是 Git 仓库：${target}`);
  const repoRoot=resolve(probe.stdout);
  const detected=(await gitRun(repoRoot,['rev-parse','--abbrev-ref','HEAD'],{allowFailure:true})).stdout;
  const targetBranch=branch || (detected && detected!=='HEAD' ? detected : 'main');
  let committed=null;
  const dirty=(await gitRun(repoRoot,['status','--porcelain=v1','--untracked-files=all'])).stdout;
  if(dirty && commit) {
    await gitRun(repoRoot,['add','-A']);
    await gitRun(repoRoot,['-c','commit.gpgsign=false','-c','user.name=Document Learning','-c','user.email=document-learning@localhost','commit','-m',message || 'chore: sync document skills and long-term memory']);
    committed=(await gitRun(repoRoot,['rev-parse','HEAD'])).stdout;
  } else if(dirty) {
    throw new Error('工作区存在未提交改动；使用默认提交行为或先手动提交后再推送');
  }
  let remoteUrl=remote || null,created=false;
  if(!remoteUrl && create) {
    const ghReady=await ghRun(['auth','status'],{allowFailure:true});
    if(!ghReady.ok)throw new Error('未检测到可用的 GitHub CLI 登录。先运行 gh auth login，或改用 --remote 指定已存在的远端地址。');
    const login=(await ghRun(['api','user','--jq','.login'])).stdout;
    const slug=`${owner || login}/${name || basename(repoRoot)}`;
    const existing=await ghRun(['repo','view',slug,'--json','url'],{allowFailure:true});
    if(existing.ok) {
      try { remoteUrl=JSON.parse(existing.stdout).url; } catch { remoteUrl=null; }
    }
    if(!remoteUrl) {
      const creation=await ghRun(['repo','create',slug,`--${visibility}`,'--source',repoRoot,'--remote','origin','--push'],{allowFailure:true});
      if(creation.ok) {
        created=true;
        remoteUrl=(await gitRun(repoRoot,['remote','get-url','origin'])).stdout;
        return {directory:repoRoot,remote:remoteUrl,branch:targetBranch,created,committed,pushed:true};
      }
      // The name may already be taken, including by this account; reuse it instead of failing.
      const again=await ghRun(['repo','view',slug,'--json','url'],{allowFailure:true});
      if(!again.ok)throw new Error(`创建远端仓库失败：${creation.stderr}`);
      remoteUrl=JSON.parse(again.stdout).url;
    }
  }
  if(!remoteUrl)throw new Error('未提供远端地址，且未创建远端仓库');
  const current=(await gitRun(repoRoot,['remote','get-url','origin'],{allowFailure:true}));
  if(current.ok)await gitRun(repoRoot,['remote','set-url','origin',remoteUrl]);
  else await gitRun(repoRoot,['remote','add','origin',remoteUrl]);
  await gitRun(repoRoot,['push','-u','origin',`HEAD:refs/heads/${targetBranch}`]);
  return {directory:repoRoot,remote:remoteUrl,branch:targetBranch,created,committed,pushed:true};
}

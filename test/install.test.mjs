import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {install,uninstall,doctor,publishRepository,events,scheduleCommands,TASK_NAME} from '../src/install.mjs';
import {validateConfig} from '../src/config.mjs';
import {readJson,writeJson} from '../src/io.mjs';
import {resolveLibrary} from '../src/library.mjs';
import {rememberAllowRule,pluginAllowRules} from '../src/claude-permissions.mjs';

const run=promisify(execFile);
const gitCommit=(cwd,args=[])=>run('git',['-c','commit.gpgsign=false','-c','user.name=Test','-c','user.email=test@localhost',...args],{cwd,windowsHide:true});

test('安装重复执行不叠加 hooks，卸载保留原有 hooks、设置与个人库',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'doc-install-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const userHome=join(dir,'用户目录'),base=join(dir,'private');
  const old={model:'custom',hooks:{SessionStart:[{hooks:[{type:'command',command:'pebrel --hooks=full',timeout:3}]}],PreToolUse:[{matcher:'Bash',hooks:[{type:'command',command:'other-hook'}]}]}};
  await writeJson(join(userHome,'.claude','settings.json'),old);await writeJson(join(userHome,'.codex','hooks.json'),old);
  await install({base,userHome});await install({base,userHome});
  for(const path of [join(userHome,'.claude','settings.json'),join(userHome,'.codex','hooks.json')]) {
    const value=await readJson(path);assert.equal(value.model,'custom');assert.equal(value.hooks.SessionStart.length,2);assert.equal(value.hooks.PreToolUse[0].hooks[0].command,'other-hook');
  }
  const health=await doctor({base});assert.equal(health.agents.every(a=>a.configured&&!a.callbackObserved),true);
  assert.equal(health.status,'awaiting-hook-trust');assert.equal(health.agents.find(a=>a.agent==='codex').hookTrust.status,'needs-review');
  // 用户在 /hooks 信任后有记录但未见回调仍是未核实；真实 SessionStart 之后报告已激活。
  const hooksPath=join(userHome,'.codex','hooks.json'),codexHooks=await readJson(hooksPath),records=[];
  for(const [event,groups] of Object.entries(codexHooks.hooks))for(const [g,group] of groups.entries())for(const [h,handler] of group.hooks.entries())if(!['pebrel --hooks=full','other-hook'].includes(handler.command))records.push(`[hooks.state.${JSON.stringify(`${hooksPath}:${event.replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase()}:${g}:${h}`)}]\ntrusted_hash = "x"\n`);
  await writeFile(join(userHome,'.codex','config.toml'),records.join('\n'));
  assert.equal((await doctor({base})).agents.find(a=>a.agent==='codex').hookTrust.status,'record-present-unverified');
  await (await resolveLibrary({base})).transact('seen',state=>{state.sessions['codex:s1']={agent:'codex',lastStart:new Date().toISOString()};});
  const trusted=(await doctor({base})).agents.find(a=>a.agent==='codex');assert.equal(trusted.hookTrust.status,'active');assert.equal(trusted.hookTrust.nextStep,undefined);
  await uninstall({base});assert.deepEqual(await readJson(join(userHome,'.claude','settings.json')),old);
  assert.equal((await resolveLibrary({base,create:false})).root,join(base,'library'));
});
test('已绑定库丢失时报告错误，不悄悄初始化另一个库',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'doc-missing-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeJson(join(dir,'binding.json'),{schema:1,library:join(dir,'gone')});
  await assert.rejects(resolveLibrary({base:dir}),e=>e.code==='ENOENT');
  assert.equal((await doctor({base:dir})).status,'binding-unavailable');
});

test('Claude remember 授权显式启用、重复安装不叠加、卸载只删除本插件新增规则',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'doc-permissions-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const userHome=join(dir,'user'),base=join(dir,'data'),path=join(userHome,'.claude','settings.json');
  const original={permissions:{allow:['Bash(git status)'],ask:['Bash(node *)'],deny:['Bash(git push *)']}};
  await writeJson(path,original);
  await install({base,userHome,agents:['claude']});
  assert.deepEqual((await readJson(path)).permissions,original.permissions);
  assert.equal((await doctor({base})).agents[0].rememberPermission.status,'not-configured');
  await install({base,userHome,agents:['claude'],allowClaudeSignal:true});
  await install({base,userHome,agents:['claude']});
  const rule=rememberAllowRule(),config=await readJson(path);
  assert.deepEqual(config.permissions,{...original.permissions,allow:[...original.permissions.allow,...pluginAllowRules()]});assert.ok(pluginAllowRules().includes('mcp__codeg-mcp__ask_user_question'));
  assert.match(rule,/ remember \*\)$/);
  assert.equal((await doctor({base})).agents[0].rememberPermission.status,'configured-unverified');
  config.permissions.allow.push('Bash(npm test)');await writeJson(path,config);
  await uninstall({base});
  assert.deepEqual((await readJson(path)).permissions,{...original.permissions,allow:[...original.permissions.allow,'Bash(npm test)']});
});

test('用户原有的相同允许规则不归插件所有；用户撤销后普通重装不重新授权',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'doc-permissions-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const userHome=join(dir,'user'),base=join(dir,'data'),path=join(userHome,'.claude','settings.json');
  const original={permissions:{allow:[rememberAllowRule()]}};await writeJson(path,original);
  await install({base,userHome,agents:['claude'],allowClaudeSignal:true});
  await uninstall({base});
  assert.deepEqual((await readJson(path)).permissions,original.permissions);
  await writeJson(path,{});
  await install({base,userHome,agents:['claude'],allowClaudeSignal:true});
  const config=await readJson(path);config.permissions.allow=[];await writeJson(path,config);
  await install({base,userHome,agents:['claude']});
  assert.deepEqual((await readJson(path)).permissions.allow,[]);
});

test('安装只注册四个事件，写入默认配置；计划任务需确认后才创建，卸载时删除',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'doc-schedule-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const userHome=join(dir,'user'),base=join(dir,'data'),calls=[];
  const runner=async(command,args)=>{calls.push([command,...args]);return {stdout:'',stderr:''};};
  const first=await install({base,userHome,agents:['claude'],runner,platform:'win32'});
  assert.equal(first.config.created,true);assert.equal(first.schedule.status,'not-created');assert.match(first.schedule.commands[0],/schtasks \/Create/);assert.equal(calls.length,0);
  const hooks=(await readJson(join(userHome,'.claude','settings.json'))).hooks;
  assert.deepEqual(Object.keys(hooks).sort(),[...events.claude].sort());
  const config=await readJson(join(base,'config.json'));assert.equal(config.consolidate.minSessions,3);assert.ok(config._说明);
  const second=await install({base,userHome,agents:['claude'],schedule:true,runner,platform:'win32'});
  assert.equal(second.config.created,false);assert.equal(second.schedule.status,'created');
  assert.equal(calls.length,2);assert.ok(calls[0].includes('MINUTE')&&calls[0].includes('120'));assert.ok(calls[1].includes('ONLOGON'));
  assert.ok(calls[0].at(-1).includes('consolidate --if-due'));
  assert.ok(calls[0].at(-1).includes(`--home "${base}"`),'计划任务带上安装时的数据目录');
  const health=await doctor({base});
  assert.equal(health.consolidation.schedule.name,TASK_NAME);assert.equal(health.consolidation.pendingSessions,0);assert.equal(health.config.effective.manual.maxChars,3000);
  await writeJson(join(base,'config.json'),{judge:{provider:'other'}});
  assert.equal((await doctor({base})).status,'config-invalid');
  // 配置无效时卸载仍删除计划任务。
  await uninstall({base,runner,platform:'win32'});
  assert.ok(calls.slice(2).every(c=>c.includes('/Delete')));assert.equal(calls.length,4);
  assert.throws(()=>validateConfig({schedule:{intervalMinutes:1440}}),/schedule\.intervalMinutes/);
  const manual=scheduleCommands(validateConfig({}),{platform:'linux'});assert.match(manual.manual,/crontab/);assert.match(manual.manual,/@reboot/);
});

test('已有同名人工技能时，安装不改宿主配置',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'doc-collision-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const userHome=join(dir,'user'),path=join(userHome,'.claude','settings.json');
  await writeJson(path,{custom:'keep'});await mkdir(join(userHome,'.claude','skills','document-learning'),{recursive:true});
  await writeFile(join(userHome,'.claude','skills','document-learning','SKILL.md'),'人工版本');
  await assert.rejects(install({base:join(dir,'data'),userHome,agents:['claude']}));
  assert.deepEqual(await readJson(path),{custom:'keep'});
});

test('publishRepository 自动提交未提交改动并推送到指定远端',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'doc-publish-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const work=join(dir,'work'),bare=join(dir,'remote.git');
  await mkdir(work,{recursive:true});
  await run('git',['init','-b','main'],{cwd:work,windowsHide:true});
  await writeFile(join(work,'README.md'),'# 文档技能\n');
  await gitCommit(work,['add','-A']);
  await gitCommit(work,['commit','-m','init']);
  await run('git',['init','--bare',bare],{windowsHide:true});
  // 故意留下未提交改动，验证一键推送会先提交
  await writeFile(join(work,'README.md'),'# 文档技能与长期经验\n');
  const result=await publishRepository({directory:work,remote:bare,create:false});
  assert.equal(result.pushed,true);
  assert.equal(result.branch,'main');
  assert.ok(result.committed,'应产生一次本地提交');
  assert.equal((await run('git',['-C',work,'status','--porcelain'],{windowsHide:true})).stdout.trim(),'');
  assert.match((await run('git',['--git-dir',bare,'branch','--list'],{windowsHide:true})).stdout,/main/);
});

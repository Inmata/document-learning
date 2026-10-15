import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {install,uninstall,doctor} from '../src/install.mjs';
import {readJson,writeJson} from '../src/io.mjs';
import {resolveLibrary} from '../src/library.mjs';

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
  await uninstall({base});assert.deepEqual(await readJson(join(userHome,'.claude','settings.json')),old);
  assert.equal((await resolveLibrary({base,create:false})).root,join(base,'library'));
});
test('已绑定库丢失时报告错误，不悄悄初始化另一个库',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'doc-missing-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeJson(join(dir,'binding.json'),{schema:1,library:join(dir,'gone')});
  await assert.rejects(resolveLibrary({base:dir}),e=>e.code==='ENOENT');
  assert.equal((await doctor({base:dir})).status,'binding-unavailable');
});
test('已有同名人工技能时，安装不改宿主配置',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'doc-collision-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const userHome=join(dir,'user'),path=join(userHome,'.claude','settings.json');
  await writeJson(path,{custom:'keep'});await mkdir(join(userHome,'.claude','skills','document-learning'),{recursive:true});
  await writeFile(join(userHome,'.claude','skills','document-learning','SKILL.md'),'人工版本');
  await assert.rejects(install({base:join(dir,'data'),userHome,agents:['claude']}));
  assert.deepEqual(await readJson(path),{custom:'keep'});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,readlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {bindLibrary,readBinding} from '../src/library.mjs';
import {readJson,writeJson} from '../src/io.mjs';
import {syncPersonalSkills} from '../src/install.mjs';
import {publishSkills} from '../src/skills.mjs';
import {applyLearning,retrieve} from '../src/knowledge.mjs';

async function setup(t){const dir=await mkdtemp(join(tmpdir(),'doc-personal-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('旧技能仓库绑定迁移为只读来源，新技能仍写个人目录',async t=>{
 const dir=await setup(t),base=join(dir,'data'),repo=join(dir,'source');await mkdir(repo);const library=await bindLibrary({base,library:join(base,'library'),skillRepository:repo});
 await writeJson(join(base,'binding.json'),{schema:1,library:library.root,skillRepository:repo});
 const binding=await readBinding(base);assert.deepEqual(binding.sourceRepositories,[repo]);assert.equal(binding.skillDirectory,join(library.root,'skills'));assert.equal(binding.skillRepository,undefined);
 const source={id:'u',role:'user',text:'按过程整理实验报告。',task:'old',context:{task:'old'}};await applyLearning(library,{sources:[source]});
 const [result]=await publishSkills(library,[{name:'exploratory-report',description:'制作探索实验报告时使用',body:'先核对原始过程，再整理轮次、变化与结果。',scope:{kind:'experiment-report'},evidence:[{source:'u',quote:source.text}],positive:[{kind:'experiment-report'}],negative:[{kind:'instruction'}]}],{repository:repo});
 assert.equal(result.path,join(library.root,'skills','exploratory-report','SKILL.md'));
});
test('生成技能自动建立双宿主入口，只有本插件管理的连接可替换',async t=>{
 const dir=await setup(t),base=join(dir,'data'),userHome=join(dir,'user'),folder=join(base,'library','skills','sample-report');await mkdir(folder,{recursive:true});
 await writeJson(join(base,'installation.json'),{agents:{codex:{entry:join(userHome,'.codex','skills','document-learning')},claude:{entry:join(userHome,'.claude','skills','document-learning')}}});
 const library={root:join(base,'library'),read:async()=>({skills:{'sample-report':{name:'sample-report',path:join(folder,'SKILL.md'),status:'active'}}})};
 await syncPersonalSkills({base,library});for(const agent of ['.codex','.claude'])assert.equal((await readlink(join(userHome,agent,'skills','sample-report'))).replace(/[\\/]$/,''),folder);
});
test('跨任务方法按文档用途匹配，不把实验分组推荐给操作说明',async t=>{
 const dir=await setup(t),library=await bindLibrary({base:dir,library:join(dir,'library')});
 await applyLearning(library,{sources:[{id:'u',role:'user',text:'从实际操作整理实验分组。',task:'old',context:{task:'old',kind:'experiment-report'}}],rules:[{key:'grouping',value:'from-process',text:'从过程整理实验分组',category:'method',strength:'default',scope:{task:'old',kind:'experiment-report'},evidence:[{source:'u',quote:'从实际操作整理实验分组。'}]}]});
 assert.equal((await retrieve(library,{task:'new',kind:'instruction'})).transfer.length,0);
 assert.equal((await retrieve(library,{task:'new',kind:'experiment-report'})).transfer.length,1);
});

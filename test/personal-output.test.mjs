import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,readlink,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {bindLibrary,readBinding,resolveLibrary} from '../src/library.mjs';
import {readJson,writeJson,exists} from '../src/io.mjs';
import {syncPersonalSkills,initSkillRepository} from '../src/install.mjs';
import {publishSkills} from '../src/skills.mjs';
import {applyLearning,retrieve} from '../src/knowledge.mjs';
import {exportCatalog} from '../src/catalog.mjs';

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

test('initSkillRepository 只导入文档技能并排除编程技能与 notes，支持跨端恢复长期经验且不泄露临时会话',async t=>{
 const dir=await setup(t),baseA=join(dir,'machine-a'),baseB=join(dir,'machine-b'),userA=join(dir,'user-a'),userB=join(dir,'user-b');
 const legacyRepo=join(dir,'legacy-skills'),docRepo=join(dir,'document-skills');
 await mkdir(join(legacyRepo,'customer-site-report','agents'),{recursive:true});
 await writeFile(join(legacyRepo,'customer-site-report','SKILL.md'),'---\nname: customer-site-report\ndescription: 将客户现场口述整理为正式 Word 现场报告\n---\n\n# 客户现场报告\n');
 await writeFile(join(legacyRepo,'customer-site-report','README.md'),'# 手写现场报告指南\n');
 await writeFile(join(legacyRepo,'customer-site-report','agents','openai.yaml'),'interface:\n  display_name: "客户现场报告"\npolicy:\n  allow_implicit_invocation: false\n');
 await mkdir(join(legacyRepo,'efficient-parallel-development'),{recursive:true});
 await writeFile(join(legacyRepo,'efficient-parallel-development','SKILL.md'),'---\nname: efficient-parallel-development\ndescription: 用于已有仓库中的协作开发：主模型规划，Worker 实施\n---\n\n# 协作开发\n');
 await mkdir(join(legacyRepo,'notes'),{recursive:true});
 await writeFile(join(legacyRepo,'notes','排障索引.md'),'# 排障\n');

 await writeJson(join(baseA,'installation.json'),{agents:{codex:{entry:join(userA,'.codex','skills','document-learning')},claude:{entry:join(userA,'.claude','skills','document-learning')}}});
 const libA=await resolveLibrary({base:baseA});
 const source={id:'u1',role:'user',text:'把清洗步骤和现场照片整理为客户清洗操作说明。',task:'clean-1',context:{task:'clean-1',kind:'instruction',process:'cleaning'}};
 await libA.transact('seed-session',s=>{s.sessions['codex-temp']={agent:'codex',id:'temp',current:{id:'t1',receipt:'pending'}};});
 await applyLearning(libA,{sources:[source],rules:[{key:'safety.first',value:'before-steps',text:'安全注意事项放在操作步骤之前',category:'method',strength:'default',scope:{kind:'instruction',process:'cleaning'},evidence:[{source:'u1',quote:source.text}]}]});
 await publishSkills(libA,[{name:'customer-cleaning-instructions',title:'客户清洗操作说明',description:'用于编制客户清洗操作说明或清洗 SOP',body:'按清洗动作组织图文。',scope:{kind:'instruction',process:'cleaning'},evidence:[{source:'u1',quote:source.text}],positive:[{kind:'instruction',process:'cleaning'}],negative:[{kind:'experiment-report',process:'cleaning'}]}]);
 await syncPersonalSkills({base:baseA,library:libA});

 const initResult=await initSkillRepository({output:docRepo,base:baseA,bind:true,importFrom:[legacyRepo]});
 assert.deepEqual(initResult.imported,['customer-site-report']);
 assert.match(await readFile(join(docRepo,'install.cmd'),'utf8'),/^@echo off\r\npwsh\.exe -NoProfile /,'install.cmd 用 PowerShell 7 而不是 5.1');
 assert.equal(await exists(join(docRepo,'efficient-parallel-development')),false);
 assert.equal(await exists(join(docRepo,'notes')),false);
 assert.equal(await exists(join(docRepo,'customer-cleaning-instructions','SKILL.md')),true);
 assert.equal(await exists(join(docRepo,'customer-cleaning-instructions','README.md')),true);
 assert.equal(await readFile(join(docRepo,'customer-site-report','README.md'),'utf8'),'# 手写现场报告指南\n');

 const memory=await readJson(join(docRepo,'knowledge','memory.json'));
 assert.equal(memory.sessions,undefined);
 assert.equal(memory.rules.length,1);
 assert.equal((await readlink(join(userA,'.codex','skills','customer-cleaning-instructions'))).replace(/[\\/]$/,''),join(docRepo,'customer-cleaning-instructions'));

 // 模拟另一台电脑克隆 docRepo 后绑定
 await writeJson(join(baseB,'installation.json'),{agents:{codex:{entry:join(userB,'.codex','skills','document-learning')}}});
 const libB=await bindLibrary({base:baseB,library:join(baseB,'library'),skillDirectory:docRepo});
 await exportCatalog(libB);
 await syncPersonalSkills({base:baseB,library:libB});
 const stateB=await libB.read();
 assert.equal(stateB.rules.length,1);
 assert.equal(stateB.skills['customer-cleaning-instructions'].path,join(docRepo,'customer-cleaning-instructions','SKILL.md'));
 assert.equal((await readlink(join(userB,'.codex','skills','customer-cleaning-instructions'))).replace(/[\\/]$/,''),join(docRepo,'customer-cleaning-instructions'));
});

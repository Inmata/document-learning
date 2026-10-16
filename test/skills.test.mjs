import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/library.mjs';
import { applyLearning } from '../src/knowledge.mjs';
import { publishSkills,retireSkills,rollbackSkill } from '../src/skills.mjs';
import {fingerprint} from '../src/io.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(),'doc-skills-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const library = await Library.open(join(root,'private'));
  await applyLearning(library,{sources:[{id:'user',role:'user',text:'本次按实拍组织袋装超声清洗的操作顺序',task:'a',context:{task:'a',kind:'instruction',process:'bag-ultrasonic'},origin:'conversation'}]});
  return {root,library};
}
const proposal = name => ({name,title:'袋装超声清洗说明',description:'用于制作袋装超声清洗操作说明',body:'读取当前任务的实际步骤及图片，按操作顺序组织，并核对图片位置关系。工艺参数取自本次资料。',scope:{kind:'instruction',process:'bag-ultrasonic'},evidence:[{source:'user',quote:'按实拍组织袋装超声清洗的操作顺序'}],positive:[{kind:'instruction',process:'bag-ultrasonic',object:'pcb'},{kind:'instruction',process:'bag-ultrasonic',object:'metal'}],negative:[{kind:'report',process:'bag-ultrasonic'},{kind:'instruction',process:'warehouse'}]});

test('自动生成的技能自包含，非 PCB 对象仍匹配同一工艺',async t=>{
  const {library}=await fixture(t);
  const result=await publishSkills(library,[proposal('bag-ultrasonic-instructions')]);
  assert.equal(result[0].status,'published');
  const body=await readFile(result[0].path,'utf8');
  assert.match(body,/本次资料/);
  assert.match(await readFile(join(library.root,'skills','bag-ultrasonic-instructions','agents','openai.yaml'),'utf8'),/allow_implicit_invocation: true/);
});
test('修改现有技能只管理自己的区域，保留明确调用政策和手动正文',async t=>{
  const {library}=await fixture(t),repo=join(library.root,'skills');
  const folder=join(repo,'legacy-report');
  await mkdir(join(folder,'agents'),{recursive:true});
  await writeFile(join(folder,'SKILL.md'),'---\nname: legacy-report\n---\n\n只有明确指定才调用。\n手动维护正文。\n');
  await writeFile(join(folder,'agents','openai.yaml'),'policy:\n  allow_implicit_invocation: false\n');
  await publishSkills(library,[proposal('legacy-report')],{repository:repo});
  assert.match(await readFile(join(folder,'SKILL.md'),'utf8'),/只有明确指定才调用。\n手动维护正文。/);
  assert.equal(await readFile(join(folder,'agents','openai.yaml'),'utf8'),'policy:\n  allow_implicit_invocation: false\n');
  assert.equal((await library.read()).skills['legacy-report'].implicit,false);
  await writeFile(join(folder,'SKILL.md'),'用户在后面手动改过了');
  const result=await publishSkills(library,[proposal('legacy-report')],{repository:repo});
  assert.equal(result[0].status,'manual-change');
  assert.equal(await readFile(join(folder,'SKILL.md'),'utf8'),'用户在后面手动改过了');
});
test('无相近反例或无条件的 SOP 入口不能发布',async t=>{
  const {library}=await fixture(t);
  await assert.rejects(publishSkills(library,[{...proposal('sop'),scope:{}}]),/范围/);
  await assert.rejects(publishSkills(library,[{...proposal('bag-guide'),negative:[{kind:'instruction',process:'bag-ultrasonic'}]}]),/正反例/);
});

test('明确停用后不再自动重建，回退恢复正文和调用元数据',async t=>{
  const {library}=await fixture(t),name='bag-guide';
  const [published]=await publishSkills(library,[proposal(name)]);
  const original=await fingerprint(published.path);
  await applyLearning(library,{sources:[{id:'retire',role:'user',text:'停用 bag-guide 这个技能',context:{skill:name},task:'a',origin:'conversation'}]});
  await retireSkills(library,[{name,evidence:[{source:'retire',quote:'停用 bag-guide 这个技能'}]}]);
  assert.equal((await library.read()).skills[name].status,'retired');
  assert.match(await readFile(join(published.path,'..','agents','openai.yaml'),'utf8'),/allow_implicit_invocation: false/);
  assert.equal((await publishSkills(library,[proposal(name)]))[0].status,'skip-retired');
  await rollbackSkill(library,name,original);
  assert.equal((await library.read()).skills[name].status,'active');
  assert.equal(await fingerprint(published.path),original);
  assert.match(await readFile(join(published.path,'..','agents','openai.yaml'),'utf8'),/allow_implicit_invocation: true/);
});

test('个人库父路径是系统链接时仍能反复更新普通技能目录',async t=>{
  const {library,root}=await fixture(t),alias=join(root,'library-alias');
  await symlink(library.root,alias,process.platform==='win32'?'junction':'dir');
  const linked=await Library.open(alias,{create:false});
  await publishSkills(linked,[proposal('bag-guide')]);
  const result=await publishSkills(linked,[{...proposal('bag-guide'),body:'读取本次步骤和实拍，按操作顺序组织；新增图片替换时检查全部引用。'}]);
  assert.equal(result[0].status,'published');
});

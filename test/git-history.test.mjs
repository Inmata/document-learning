import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {scanGit} from '../src/git-history.mjs';

test('从混合仓库过滤无关提交，保留混合提交的文档部分与初始版本',async t=>{
  const root=await mkdtemp(join(tmpdir(),'doc-git-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const exec=promisify(execFile);
  const git=(...args)=>exec('git',['-C',root,...args],{windowsHide:true});
  const commit=msg=>git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m',msg);
  await git('init');
  await mkdir(join(root,'site-report'),{recursive:true});await mkdir(join(root,'notes'),{recursive:true});
  await writeFile(join(root,'site-report','SKILL.md'),'---\nname: site-report\ndescription: 创建现场报告文档\n---\n初始内容\n');
  await git('add','.');await commit('initial');
  await writeFile(join(root,'notes','tool.ps1'),'Write-Output tool');await git('add','.');await commit('unrelated tool');
  await writeFile(join(root,'site-report','SKILL.md'),'---\nname: site-report\ndescription: 创建现场报告文档\n---\n增加图注核对\n');
  await writeFile(join(root,'notes','tool.ps1'),'Write-Output other');await git('add','.');await commit('mixed');
  const result=await scanGit(root);
  assert.equal(result.commits.length,3);assert.equal(result.commits[1].relevant,false);
  assert.equal(result.commits[2].selected.length,1);assert.equal(result.commits[2].excluded.length,1);
  assert.match(result.baseline.files[0].text,/初始内容/);assert.doesNotMatch(result.baseline.files[0].text,/增加图注/);
  assert.match(result.actual.files[0].text,/增加图注/);
});

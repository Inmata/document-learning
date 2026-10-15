import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {prepareCommit,commitPublished} from '../src/versioning.mjs';
import {fingerprint} from '../src/io.mjs';

test('自动 Git 提交只包含目标文件，不带入用户其他已暂存内容',async t=>{
  const root=await mkdtemp(join(tmpdir(),'doc-git-commit-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const exec=promisify(execFile),git=(...args)=>exec('git',['-C',root,...args],{windowsHide:true,encoding:'utf8'});
  await git('init');await writeFile(join(root,'owned.md'),'初始');await writeFile(join(root,'user.md'),'用户初始');
  await git('add','.');await git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','initial');
  await writeFile(join(root,'user.md'),'用户暂存修改');await git('add','user.md');
  const path=join(root,'owned.md'),prepared=await prepareCommit(root,[path]);
  await writeFile(path,'自动更新');
  const result=await commitPublished(prepared,{[path]:await fingerprint(path)},{libraryRoot:join(root,'private'),name:'fixture'});
  assert.equal(result.status,'committed');
  assert.equal((await git('show','--format=','--name-only','HEAD')).stdout.trim(),'owned.md');
  assert.equal((await git('diff','--cached','--name-only')).stdout.trim(),'user.md');
  assert.equal(await readFile(join(root,'user.md'),'utf8'),'用户暂存修改');
});

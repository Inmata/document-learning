import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fingerprint} from './io.mjs';

const exec=promisify(execFile);
async function git(repository,args){return (await exec('git',['-C',repository,...args],{encoding:'utf8',windowsHide:true})).stdout;}
export async function prepareCommit(repository,paths) {
  if(!repository)return {status:'private-snapshots'};
  try {
    await git(repository,['rev-parse','--show-toplevel']);
    const dirty=await git(repository,['status','--porcelain=v1','-z','--untracked-files=all','--',...paths]);
    return dirty?{status:'skip-existing-changes',repository}:{status:'ready',repository};
  }catch{return {status:'private-snapshots',reason:'Git 不可用或绑定目录不是 Git 仓库'};}
}
export async function commitPublished(prepared,files,{libraryRoot,name}) {
  if(prepared.status!=='ready')return prepared;
  const paths=Object.keys(files);
  for(const path of paths)if(await fingerprint(path)!==files[path])return {status:'skip-concurrent-edit',reason:'发布后文件已有新修改'};
  const hooks=join(libraryRoot,'versioning','empty-hooks');await mkdir(hooks,{recursive:true});
  try {
    // --only keeps unrelated staged work out of this commit. Repository hooks are
    // not executed by this background task; no push or global Git config is used.
    await git(prepared.repository,['add','--',...paths]);
    for(const path of paths)if(await fingerprint(path)!==files[path])return {status:'skip-concurrent-edit',reason:'暂存后检测到新修改，未提交'};
    await git(prepared.repository,['-c',`core.hooksPath=${hooks}`,'-c','commit.gpgsign=false','-c','user.name=Document Learning','-c','user.email=document-learning@localhost','commit','--only','-m',`document-learning: update ${name} [automated]`,'--',...paths]);
    return {status:'committed',commit:(await git(prepared.repository,['rev-parse','HEAD'])).trim()};
  }catch(error){return {status:'private-snapshots',reason:`Git 提交未完成：${String(error.stderr || error.message).slice(0,250)}`};}
}

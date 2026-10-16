import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {hash} from './io.mjs';
import {inspectDocx} from './docx-structure.mjs';
import {resolve} from 'node:path';

const exec=promisify(execFile);
async function git(repo,args,maxBuffer=16*1024*1024) { return (await exec('git',['-C',repo,...args],{encoding:'utf8',maxBuffer,windowsHide:true})).stdout; }
const documentTerms=/报告|文档|说明书|作业指导|图注|版式|母版|模板|合同|信函|提案|汇报|docx|pptx|xlsx|report|presentation|document|spreadsheet|contract|letter|proposal|\bsop\b|\bword\b|\bpowerpoint\b/i;
const binary=/\.(docx|pptx|xlsx|pdf|png|jpe?g|gif|ico|zip)$/i;
function substantiveLines(diff) {
 const lines=diff.split('\n').filter(l=>/^[+-][^+-]/.test(l));
 const normalize=l=>l.slice(1).replace(/(?:[一二三四五六七八九十百\d]+|各)(?=个|份)/g,'#');
 const added=new Set(lines.filter(l=>l[0]==='+').map(normalize)),removed=new Set(lines.filter(l=>l[0]==='-').map(normalize));
 return lines.filter(l=>!(l[0]==='+'?removed:added).has(normalize(l))).join('\n');
}
export async function documentRoots(repo,ref='HEAD') {
  const files=(await git(repo,['ls-tree','-r','--name-only',ref])).trim().split('\n');
  const roots=[];
  for(const file of files.filter(f=>/(^|\/)SKILL\.md$/.test(f))) {
    const text=await git(repo,['show',`${ref}:${file}`]);
    const description=text.match(/^description:\s*(.*)$/m)?.[1] || '';
    if(documentTerms.test(description)) roots.push(file.slice(0,-'SKILL.md'.length));
  }
  return roots;
}
async function changes(repo,sha) {
  const fields=(await git(repo,['diff-tree','--root','-r','-M','--no-commit-id','--name-status','-z',sha])).split('\0').filter(Boolean);
  const result=[];
  for(let i=0;i<fields.length;) {
    const status=fields[i++],first=fields[i++];
    if(/^[RC]/.test(status)) result.push({status,from:first,path:fields[i++]});
    else result.push({status,path:first});
  }
  return result;
}
export async function snapshot(repo,ref,roots) {
  const files=(await git(repo,['ls-tree','-r','--name-only',ref])).trim().split('\n');
  const selected=files.filter(p=>roots.some(root=>p.startsWith(root)) || p==='CONTRIBUTING.md');
  const contents=[];
  for(const path of selected) {
    if(binary.test(path)) { contents.push({path,binary:true,available:true});continue; }
    const text=await git(repo,['show',`${ref}:${path}`]);
    contents.push({path,text:text.slice(0,40000),truncated:text.length>40000});
  }
  return {ref,files:contents,digest:hash(contents)};
}
export async function scanGit(repo,{include,baseRef}={}) {
  const roots=include?.length?include:await documentRoots(repo);
  const log=(await git(repo,['log','--all','--reverse','--topo-order','--format=%H%x09%P%x09%aI%x09%s'])).trim().split('\n').filter(Boolean);
  const commits=[];
  for(const line of log) {
    const [sha,parents,date,...subject]=line.split('\t');
    const selected=[],excluded=[];
    for(const change of await changes(repo,sha)) {
      const inRoot=roots.some(root=>change.path.startsWith(root) || change.from?.startsWith(root));
      const shared=['README.md','CONTRIBUTING.md','docs/skill-comparison.md'].includes(change.path);
      if(!inRoot && !shared) {excluded.push(change.path);continue;}
      if(binary.test(change.path)) {
        const item={...change,binary:true,interpretation:'需读取实际文件，不从提交标题推断版式经验'};
        if(/\.docx$/i.test(change.path)&&!/^D/.test(change.status)) {
          try {
            const read=async(ref,path)=>inspectDocx((await exec('git',['-C',repo,'show',`${ref}:${path}`],{encoding:'buffer',maxBuffer:64*1024*1024,windowsHide:true})).stdout);
            const after=await read(sha,change.path);let before=null;
            if(parents)try{before=await read(parents.split(' ')[0],change.from || change.path);}catch{}
            item.structure={before,after,changedParts:after.parts.filter(p=>!before?.parts.some(old=>old.name===p.name&&old.digest===p.digest)).map(p=>p.name)};
          }catch(error){item.structureError=error.message;}
        }
        selected.push(item);continue;
      }
      const diff=await git(repo,['show','--format=','--find-renames','--unified=3',sha,'--',change.path,...(change.from?[change.from]:[])]);
      const changedLines=substantiveLines(diff);
      if(shared && !documentTerms.test(changedLines)) {excluded.push(change.path);continue;}
      selected.push({...change,diff:diff.slice(0,40000),truncated:diff.length>40000,interpretation:/^R100$/.test(change.status)?'rename-only':'repository-change; not independent user feedback'});
    }
    commits.push({sha,parents:parents?parents.split(' '):[],date,subject:subject.join('\t'),selected,excluded,relevant:selected.length>0});
  }
  if(!commits.length) throw new Error('Git 仓库没有可读历史');
  const initial=baseRef || commits.find(c=>c.parents.length===0)?.sha;
  if(!/^[a-f0-9]{7,40}$/.test(initial || '')) throw new Error('初始快照必须使用明确的提交 SHA');
  const baseline=await snapshot(repo,initial,roots);
  const head=(await git(repo,['rev-parse','HEAD'])).trim();
  const actual=await snapshot(repo,head,roots);
  return {repository:resolve(repo),roots,commits,head,baseline,actual,warnings:['提交是实际维护参考，不自动视为用户认可；提交与会话的因果关联需要明确证据。','初始快照以前的演变不在本次回放范围。']};
}

import {join,resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
import {atomicWrite,writeJson,exists,fingerprint} from './io.mjs';
import {prepareCommit,commitPublished} from './versioning.mjs';

const escape=s=>String(s ?? '').replaceAll('|','／').replaceAll('\n',' ');
const categories={method:'制作方法',preference:'条件偏好',constraint:'操作约束',policy:'调用与维护规则',fact:'案例事实'};
const repoSkillsStart='<!-- document-learning:repo-skills:start -->';
const repoSkillsEnd='<!-- document-learning:repo-skills:end -->';
function sourceLines(state,evidence=[]){return evidence.map(e=>{const s=state.sources[e.source];return `- 原文：${e.quote}\n  来源：${s?.path || s?.id || e.source}${s?.commit?`；提交 ${s.commit}`:''}`;}).join('\n');}

export function renderRepoSkillTable(state, skillDir) {
 const byName=new Map();
 for(const s of Object.values(state.sourceSkills || {})) {
  if(s.path && resolve(s.path,'..','..')===resolve(skillDir))byName.set(s.name,{name:s.name,title:s.title || s.name,description:s.description || '',implicit:s.implicit!==false});
 }
 for(const s of Object.values(state.skills || {})) {
  if(s.status==='active')byName.set(s.name,{name:s.name,title:s.title || s.name,description:s.description || `适用条件：${JSON.stringify(s.scope)}`,implicit:s.implicit!==false});
 }
 const rows=[...byName.values()].sort((a,b)=>a.name.localeCompare(b.name)).map(s=>`| [${escape(s.title)}](${s.name}/README.md) | ${escape(s.description || '见技能说明')} | \`$${s.name}\`（${s.implicit?'自动匹配／显式调用':'仅显式调用'}） |`);
 return `${repoSkillsStart}\n| 技能与使用指南 | 用途与适用范围 | 调用标识与方式 |\n| --- | --- | --- |\n${rows.join('\n') || '| 暂无技能 | - | - |'}\n${repoSkillsEnd}`;
}

const strengthRank={required:0,default:1,suggestion:2};
const tierNames={core:'核心经验（所有文档）',type:'文档类型经验',doc:'单份文档经验'};
export const safeName=name=>String(name).replace(/[\\/:*?"<>|\s]+/g,'-').replace(/^-+|-+$/g,'').slice(0,120) || 'unnamed';
const list=v=>[v ?? []].flat();
const supportOf=(state,r)=>r.support ?? new Set(r.evidence.map(e=>state.sources[e.source]?.task).filter(Boolean)).size;
const tierOfRule=r=>r.tier || (!Object.keys(r.scope).filter(k=>k!=='workspace').length?'core':(r.scope.task?'doc':'type'));
const conditionLabels=r=>[...list(r.scope.skill).map(s=>`技能 ${s}`),...list(r.scope.process).map(p=>`工序 ${p}`)];
// 手册排序：required 优先，再按覆盖文档数、证据条数降序。
export function sortRules(state,rules) {
 return [...rules].sort((a,b)=>strengthRank[a.strength]-strengthRank[b.strength]||supportOf(state,b)-supportOf(state,a)||b.evidence.length-a.evidence.length||a.id.localeCompare(b.id));
}
export const manualLine=(state,r)=>`- [${r.strength}·${supportOf(state,r)}份文档] ${r.text.replace(/\s*\n\s*/g,' ')}`;
// 按字数截断：保留排序靠前的条目，并说明省略了多少条。
export function renderManual(title,intro,sections,maxChars) {
 let text=`# ${title}\n\n${intro}\n`,omitted=0;
 for(const [heading,lines] of sections) {
  if(!lines.length)continue;
  const head=heading?`\n## ${heading}\n\n`:'\n';
  if(omitted||text.length+head.length+lines[0].length+1>maxChars){omitted+=lines.length;continue;}
  text+=head;
  for(const line of lines) {
   if(omitted||text.length+line.length+1>maxChars){omitted++;continue;}
   text+=`${line}\n`;
  }
 }
 if(omitted)text+=`\n> 另有 ${omitted} 条较低优先级经验未列出，完整内容见 index.md。\n`;
 return text;
}
function groupBy(rules,keysOf) {
 const groups=new Map();
 for(const r of rules)for(const k of keysOf(r)){if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);}
 return groups;
}
export function buildManuals(state,{maxChars=3000,skillLink=s=>s.path?.replaceAll('\\','/')}={}) {
 const active=state.rules.filter(r=>r.status==='active'&&r.category!=='fact');
 const tiers={core:[],type:[],doc:[]};
 for(const r of active)tiers[tierOfRule(r)].push(r);
 const files={};
 files['knowledge/core.md']=renderManual('核心文档经验','适用于所有文档任务。当前明确需求优先；方括号中的份数是这条经验覆盖的不同文档数。',[[null,sortRules(state,tiers.core).map(r=>manualLine(state,r))]],maxChars);
 const typed=groupBy(tiers.type,r=>list(r.scope.kind).length?list(r.scope.kind):['_conditional']);
 const kinds=[...typed.keys()].filter(k=>k!=='_conditional').sort();
 for(const kind of kinds) {
  // 按技能和工序分节；没有这两个条件的放在“通用”。
  const sections=new Map([['通用',[]]]);
  for(const r of sortRules(state,typed.get(kind))) {
   const labels=conditionLabels(r);
   for(const label of labels.length?labels:['通用']){if(!sections.has(label))sections.set(label,[]);sections.get(label).push(manualLine(state,r));}
  }
  files[`knowledge/${safeName(kind)}.md`]=renderManual(`${kind} 经验手册`,`制作 ${kind} 类文档时先读 core.md，再读本手册。当前明确需求优先。`,[...sections.entries()],maxChars);
 }
 const conditional=sortRules(state,typed.get('_conditional') || []);
 if(conditional.length) {
  const sections=groupBy(conditional,r=>conditionLabels(r).length?conditionLabels(r):['其他条件']);
  files['knowledge/conditional.md']=renderManual('按技能或工序限定的经验','这些经验不限文档类型，只在条件吻合时适用。',[...sections.entries()].map(([k,rs])=>[k,rs.map(r=>manualLine(state,r))]),maxChars);
 }
 // 单份文档的偏好与个案事实只进 cases，不进手册。
 const docs=groupBy([...tiers.doc,...state.rules.filter(r=>r.status==='active'&&r.category==='fact')],r=>list(r.scope.task));
 for(const [task,rules] of docs)files[`cases/${safeName(task)}.md`]=`# 文档案例：${task}\n\n只适用于这份文档的偏好、事实与参数，不作为其他文档的规范。\n\n${sortRules(state,rules).map(r=>`${manualLine(state,r)}（${categories[r.category]}）\n${sourceLines(state,r.evidence).replace(/^/gm,'  ')}`).join('\n')}\n`;
 // 经验全部晋升或替代后仍覆盖旧案例文件，避免手册残留已失效的条目。
 for(const task of new Set(state.rules.filter(r=>r.status!=='active').flatMap(r=>list(r.scope?.task))))if(!docs.has(task))files[`cases/${safeName(task)}.md`]=`# 文档案例：${task}\n\n这份文档的经验已全部晋升或被替代，当前没有单独适用的条目；历史记录见 [案例与历史归档](index.md)。\n`;
 const skills=Object.values(state.skills).filter(s=>s.status==='active');
 const detail=r=>`- ${r.text.replace(/\s*\n\s*/g,' ')}\n  - ${categories[r.category]}；${r.strength}；${supportOf(state,r)} 份文档；适用条件 ${JSON.stringify(r.scope)}；标识 ${r.id}`;
 const pending=(state.proposals || []).filter(p=>p.status==='pending');
 const manualLinks=['- [核心经验](core.md)',...kinds.map(k=>`- [${k}](${safeName(k)}.md)`),...(conditional.length?['- [按技能或工序限定](conditional.md)']:[]),'- [单份文档案例](../cases/index.md)'].join('\n');
 files['knowledge/index.md']=`# 个人文档经验\n\n当前有效经验 ${active.length} 条（核心 ${tiers.core.length}、文档类型 ${tiers.type.length}、单份文档 ${tiers.doc.length}），个人技能 ${skills.length} 个${pending.length?`，待确认晋升提案 ${pending.length} 条`:''}。\n\n## 手册\n\n${manualLinks}\n\n## 个人技能\n\n${skills.map(s=>`- [${s.title}](${skillLink(s)})：适用 ${JSON.stringify(s.scope)}`).join('\n') || '尚无已发布技能。'}\n\n${['core','type','doc'].map(t=>`## ${tierNames[t]}\n\n${sortRules(state,tiers[t]).map(detail).join('\n') || '暂无。'}\n`).join('\n')}`;
 const history=state.rules.filter(r=>['archived','superseded'].includes(r.status));
 files['cases/index.md']=`# 案例与历史归档\n\n单份文档的经验按文档分开保存，不作为跨文档通用规范。已晋升或替代的记录保留原始证据，仅用于理解历史。\n\n## 文档\n\n${[...docs.keys()].sort().map(t=>`- [${t}](${safeName(t)}.md)`).join('\n') || '暂无。'}\n\n## 历史归档\n\n${history.map(r=>`### ${r.text}\n\n范围：${JSON.stringify(r.scope)}；状态：${r.status}${r.supersededBy?`；晋升为 ${r.supersededBy}`:''}\n\n${sourceLines(state,r.evidence)}\n`).join('\n') || '暂无。'}`;
 return {files,counts:{core:tiers.core.length,type:tiers.type.length,doc:tiers.doc.length,kinds}};
}

export async function exportCatalog(library,{skillDirectory,maxChars=3000}={}) {
 const state=await library.read();
 const skills=Object.values(state.skills).filter(s=>s.status==='active');
 const rules=state.rules.filter(r=>r.status==='active'&&r.category!=='fact').length;
 const local=buildManuals(state,{maxChars});
 for(const [rel,text] of Object.entries(local.files))await atomicWrite(join(library.root,...rel.split('/')),text);
 const skillDir=resolve(skillDirectory || library.skillDirectory || join(library.root,'skills'));
 const defaultSkillDir=resolve(library.root,'skills');
 if(skillDir!==defaultSkillDir) {
  const repo=buildManuals(state,{maxChars,skillLink:s=>`../${s.name}/SKILL.md`});
  const repoMemory=join(skillDir,'knowledge','memory.json');
  const repoReadme=join(skillDir,'README.md');
  const repoFiles=Object.keys(repo.files).map(rel=>join(skillDir,...rel.split('/')));
  const prepared=await prepareCommit(skillDir,[...repoFiles,repoMemory,...((await exists(repoReadme))?[repoReadme]:[])]);
  const portable=skills=>Object.fromEntries(Object.entries(skills || {}).map(([name,s])=>{const {path:_p,...rest}=s;return [name,{...rest,relativePath:`${name}/SKILL.md`}];}));
  for(const [rel,text] of Object.entries(repo.files))await atomicWrite(join(skillDir,...rel.split('/')),text);
  await writeJson(repoMemory,{schema:1,rules:state.rules,observations:state.observations,proposals:state.proposals || [],skills:portable(state.skills),sourceSkills:portable(state.sourceSkills),sources:state.sources});
  const committedFiles={[repoMemory]:await fingerprint(repoMemory)};
  for(const path of repoFiles)committedFiles[path]=await fingerprint(path);
  if(await exists(repoReadme)) {
   const currentReadme=await readFile(repoReadme,'utf8');
   if(currentReadme.includes(repoSkillsStart)&&currentReadme.includes(repoSkillsEnd)) {
    const nextReadme=currentReadme.slice(0,currentReadme.indexOf(repoSkillsStart))+renderRepoSkillTable(state,skillDir)+currentReadme.slice(currentReadme.indexOf(repoSkillsEnd)+repoSkillsEnd.length);
    if(nextReadme!==currentReadme) {
     await atomicWrite(repoReadme,nextReadme);
     committedFiles[repoReadme]=await fingerprint(repoReadme);
    }
   }
  }
  await commitPublished(prepared,committedFiles,{libraryRoot:library.root,name:'knowledge-catalog'});
  return {knowledge:join(skillDir,'knowledge','index.md'),cases:join(skillDir,'cases','index.md'),memory:repoMemory,manuals:Object.keys(repo.files),rules,skills:skills.length};
 }
 return {knowledge:join(library.root,'knowledge','index.md'),cases:join(library.root,'cases','index.md'),manuals:Object.keys(local.files),rules,skills:skills.length};
}
// 手册所在目录：绑定了个人技能仓库时在仓库内，否则在个人库。
export const manualRoot=library=>resolve(library.skillDirectory)===resolve(library.root,'skills')?join(library.root,'knowledge'):join(library.skillDirectory,'knowledge');

export function comparisonMarkdown(rows) {
 return '| 测试任务 | 直接适用经验 | 类比方法 | 匹配技能 |\n|---|---|---|---|\n'+rows.map(r=>`| ${escape(r.label)} | ${escape(r.apply.join('；')||'无')} | ${escape(r.transfer.join('；')||'无')} | ${escape(r.skills.join('；')||'无')} |`).join('\n');
}
